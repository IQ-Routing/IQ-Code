
import { dayOf, isoOf } from './util.js'
import { validateAnswer, capEffort, rankOf, sameModel, displayModel, effortLabel, sameChoice } from './models.js'
import { DEFAULT_DEADLINE_MS, FREE_ROUTING, ROUTING_PLAN_TEXT, ROUTING_REFUSED_TEXT, ROUTING_KEY_TEXT, isFreePlan } from './iq_client.js'
import { VERSION } from './pins.js'

export const RT_VERSION = VERSION 
export const RT_DIR = '.claude/iq/router' 
export const RECENT_MAX = 10 
export const MAX_IQ_FAILS = 5 
export const DEFAULT_PHASE_REQUESTS = 8 
const TTL_5M = 5 * 60 * 1000
const TTL_1H = 60 * 60 * 1000
const r6 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : null)




const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function dateLabel(ymd) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(ymd || '')
  return m ? MONTHS[Number(m[1]) - 1] + ' ' + Number(m[2]) : String(ymd)
}




export function cacheTtlMs({ force5m, envTtl, settingTtl, enable1h, onSubscription }) {
  if (force5m) return TTL_5M
  const pick = (v) => (v === '5m' ? TTL_5M : v === '1h' ? TTL_1H : null)
  const a = pick(envTtl)
  if (a !== null) return a
  const b = pick(settingTtl)
  if (b !== null) return b
  if (enable1h) return TTL_1H
  return onSubscription ? TTL_1H : TTL_5M
}



export function ttlIsKnown({ force5m, envTtl, settingTtl, enable1h }, rateLimits) {
  if (force5m || enable1h || envTtl === '5m' || envTtl === '1h' || settingTtl === '5m' || settingTtl === '1h') return true
  return Array.isArray(rateLimits) && rateLimits.length > 0
}


export function onSubscription(rateLimits) {
  if (!Array.isArray(rateLimits) || rateLimits.length === 0) return false
  return rateLimits.every((l) => !l || typeof l.percentUsed !== 'number' || l.percentUsed < 100)
}




export function newRouter() {
  return {
    armed: false, 
    plan: null, 
    usage: null, 
    pause: null, 
    deadlineMs: DEFAULT_DEADLINE_MS, 
    recent: [], 
    killed: false, 
    cardBad: false, 
    hasKey: false,
    errorsOff: false, 
    stopped: false, 
    errors: 0, 
    iqFails: 0, 
    backoffUntil: 0, 
    backoffNoted: false,
    pauseNoted: false,
    named: null, 
    current: null, 
    last: null, 
    seq: 0,
    counters: { prompts: 0, routed: 0, kept: 0, noDecision: 0, byModel: {}, savedUsd: null },
    stats: { turns: 0, steps: 0, out: 0, fresh: 0, maxGapS: 0 },
    lastError: null,
    ttlMs: TTL_5M,
    compactions: 0,
    ttlKnown: false, 
  }
}


export function newRecord(R, { nowMs, sessionModel }) {
  const model = R.named ? R.named.model : sessionModel || 'unknown'
  const rec = {
    idx: R.seq,
    submitMs: nowMs,
    deadlineMs: nowMs + (typeof R.deadlineMs === 'number' ? R.deadlineMs : DEFAULT_DEADLINE_MS),
    phase: 'deciding',
    source: 'none',
    reason: 'off',
    tier: null,
    choice: { model, effort: R.named && R.named.effort !== undefined ? R.named.effort : null }, 
    chosen: { model, effort: R.named ? effortLabel(R.named.effort) : null },
    named: null,
    iqRequestId: null,
    latencyMs: null,
    waitMs: null,
    lateMs: null,
    stay: null,
    block: null,
    sent: null,
    error: null,
    counted: false, 
    local: null, 
    decided: false,
    turnId: null,
    steps: 0,
    usage: {}, 
    usdActual: 0,
    usdNamed: 0,
    priced: true,
    routed: false,
    touched: false, 
    done: false,
  }
  if (Array.isArray(R.recent)) {
    R.recent.push(rec)
    if (R.recent.length > RECENT_MAX) R.recent.shift()
  }
  return rec
}


export function forgetRecord(R, rec) {
  if (Array.isArray(R.recent)) R.recent = R.recent.filter((r) => r !== rec)
}


export function nextUtcMonthMs(nowMs) {
  const d = new Date(nowMs)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
}
const ymdUtc = (ms) => new Date(ms).toISOString().slice(0, 10)






export function statusOf(R, nowMs) {
  if (R.killed || R.cardBad) return 'killed'
  if (!R.hasKey) return 'no_key'
  if (R.errorsOff || R.stopped) return 'paused_errors'
  if (R.pause && R.pause.kind === 'plan') return 'paused_plan'
  if (!R.armed) return 'off'
  if (R.pause && ['plan', 'auth'].includes(R.pause.kind)) return 'paused_plan'
  if (R.pause && ['allowance', 'free_quota', 'free_daily'].includes(R.pause.kind) && R.pause.untilMs > nowMs) return 'paused_allowance'
  return 'on'
}



export function planSubmit(R, nowMs, ttlMs) {
  const status = statusOf(R, nowMs)
  if (status === 'paused_plan' || status === 'paused_allowance') return { action: 'local', phase: 'paused', reason: 'paused', source: 'none', counted: false }
  if (status !== 'on') return { action: 'skip' }
  if (R.backoffUntil > nowMs) return { action: 'local', phase: 'error', reason: 'backoff', source: 'none', counted: true }
  return { action: 'call', counted: true }
}



export function decide(R, c) {
  const named = { model: c.named.model, effort: c.named.effort === undefined ? null : c.named.effort }
  const d = { phase: 'kept', source: 'none', reason: 'error', tier: null, choice: named, stay: null, block: null, error: null }
  const answer = validateAnswer(c.est && c.est.block, named)
  if (!answer.ok) return { ...d, phase: 'error', error: 'no_rating', block: 'rejected:' + answer.why }
  d.tier = c.est.tier || null
  d.source = 'iq_block'
  d.block = 'used'
  d.reason = answer.reason
  let choice = { model: answer.model, effort: answer.effort }
  
  if (answer.stay) {
    const current = R.last
    if (!current || rankOf(current.model) === null || rankOf(current.model) > rankOf(named.model)) return { ...d, phase: 'error', error: 'no_rating' }
    choice = { model: current.model, effort: capEffort(current.effort, named.effort) }
    d.stay = { decision: 'hold' }
  }
  d.choice = choice
  d.phase = sameChoice(choice, named) ? 'kept' : 'applied'
  return d
}

const bump = (map, key) => {
  map[key] = (map[key] || 0) + 1
}


export function settleDecision(R, rec, d) {
  rec.phase = d.phase
  rec.source = d.source
  rec.reason = d.reason
  rec.tier = d.tier
  rec.choice = d.choice
  rec.chosen = { model: d.choice.model, effort: effortLabel(d.choice.effort) }
  rec.stay = d.stay
  rec.block = d.block
  rec.error = d.error
  rec.routed = d.phase === 'applied'
  if (d.phase === 'applied' || d.phase === 'kept') R.lastError = null
  else if (d.error) R.lastError = d.error
  if (rec.counted) {
    if (d.phase === 'applied') R.counters.routed += 1
    else if (d.phase === 'kept') R.counters.kept += 1
    else R.counters.noDecision += 1
    bump(R.counters.byModel, rec.chosen.model)
  }
  rec.decided = true
}


export function settleNone(R, rec, phase, reason, error) {
  rec.phase = phase
  rec.source = 'none'
  rec.reason = reason
  rec.error = error || null
  const n = rec.named || R.named
  if (n) {
    rec.choice = { model: n.model, effort: n.effort === undefined ? null : n.effort }
    rec.chosen = { model: n.model, effort: effortLabel(n.effort) }
  }
  rec.routed = false
  if (error) R.lastError = error
  if (rec.counted && (phase === 'timeout' || phase === 'error')) {
    R.counters.noDecision += 1
    bump(R.counters.byModel, rec.chosen.model)
  }
  rec.decided = true
}




export function settlePause(R, rec, kind, nowMs) {
  
  if (kind === 'plan' || kind === 'auth') R.pause = { kind, posted: true }
  else R.pause = { kind, posted: true, untilMs: kind === 'free_daily' ? nextUtcDayMs(nowMs) : nextUtcMonthMs(nowMs) }
  R.pauseNoted = true 
  settleNone(R, rec, 'paused', 'paused', kind === 'plan' ? 'plan_required' : kind === 'auth' ? 'key_rejected' : kind === 'free_quota' ? FREE_ROUTING.monthlyCode : kind === 'free_daily' ? FREE_ROUTING.dailyCode : 'allowance_exceeded')
}


export function settleRefused(R, rec) {
  if (rec.refused || !rec.named) return
  rec.refused = true
  const n = rec.named
  if (rec.counted && rec.phase === 'applied') {
    R.counters.routed -= 1
    R.counters.noDecision += 1
    const by = R.counters.byModel
    by[rec.chosen.model] = (by[rec.chosen.model] || 1) - 1
    if (by[rec.chosen.model] <= 0) delete by[rec.chosen.model]
    bump(by, n.model)
  }
  rec.phase = 'error'
  rec.source = 'none'
  rec.reason = 'error'
  rec.error = 'rewrite_refused'
  rec.routed = false
  rec.choice = { model: n.model, effort: n.effort === undefined ? null : n.effort }
  rec.chosen = { model: n.model, effort: effortLabel(n.effort) }
  R.lastError = 'rewrite_refused'
}





export function noteMainStep(R, { model, effort, startMs, endMs, usage, routed }) {
  if (R.last && startMs > R.last.startMs) {
    const gap = (startMs - R.last.startMs) / 1000
    if (gap > R.stats.maxGapS) R.stats.maxGapS = gap
  }
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
  const ctx = num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens)
  R.last = { model, effort: effort === undefined ? null : effort, startMs, endMs, ctx, cachedPrefix: num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens), routed: routed === true }
  R.stats.steps += 1
  R.stats.out += num(usage.output_tokens)
  R.stats.fresh += num(usage.input_tokens)
}








export function namedUsage(usage, prev, startMs, ttlMs, diverged) {
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
  if (!diverged || !prev || !(prev.ctx > 0) || !(ttlMs > 0) || startMs - prev.endMs > ttlMs) return usage
  const rd = num(usage.cache_read_input_tokens)
  const cw = num(usage.cache_creation_input_tokens)
  const ctx = num(usage.input_tokens) + rd + cw
  if (ctx < prev.ctx) return usage 
  const move = Math.max(0, Math.min(cw, prev.ctx - rd))
  if (move === 0) return usage
  const out = { ...usage, cache_read_input_tokens: rd + move, cache_creation_input_tokens: cw - move }
  const sp = usage.cache_creation
  if (sp && typeof sp === 'object') {
    const w1 = num(sp.ephemeral_1h_input_tokens)
    const w5 = num(sp.ephemeral_5m_input_tokens)
    const from1 = Math.min(move, w1)
    out.cache_creation = { ...sp, ephemeral_1h_input_tokens: w1 - from1, ephemeral_5m_input_tokens: Math.max(0, w5 - (move - from1)) }
  }
  return out
}





export function noteRecStep(rec, { model, usage, pricer, prev, startMs, ttlMs, changed }) {
  rec.steps += 1
  const m = usage.model || model
  const actual = pricer.price(m, usage, { main: true })
  const row = rec.usage[m] || (rec.usage[m] = { calls: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, usd: 0 })
  row.calls += 1
  row.input += actual.tokens.input
  row.output += actual.tokens.output
  row.cache_read += actual.tokens.read
  row.cache_write += actual.tokens.write5 + actual.tokens.write1h
  row.usd += actual.usd
  const diverged = changed === true || (!!prev && prev.routed === true)
  if (diverged) rec.touched = true
  const named = rec.named ? pricer.price(rec.named.model, namedUsage(usage, prev, startMs, ttlMs, diverged), { main: true }) : null
  if (!actual.priced || named === null || !named.priced) rec.priced = false
  else {
    rec.usdActual += actual.usd
    rec.usdNamed += named.usd
  }
}



export function recSaving(rec) {
  return (rec.routed || rec.touched) && rec.priced && rec.steps > 0 ? rec.usdNamed - rec.usdActual : null
}


export function noteTurnDone(R, rec) {
  if (rec.done) return
  rec.done = true
  const s = recSaving(rec)
  if (rec.counted && s !== null) R.counters.savedUsd = (R.counters.savedUsd || 0) + s
}




export function routingState(R, nowMs) {
  const status = statusOf(R, nowMs)
  const cur = R.current
  const c = R.counters
  const byModel = {}
  for (const k of Object.keys(c.byModel)) byModel[k] = c.byModel[k]
  return {
    v: 1,
    status,
    pause_until: status === 'paused_allowance' ? ymdUtc(R.pause.untilMs) : null,
    pause_reply: status === 'paused_plan' && R.pause.posted === true, 
    named: R.named ? { model: R.named.model, effort: effortLabel(R.named.effort) } : null,
    current: cur
      ? {
          prompt_index: cur.idx,
          phase: cur.phase,
          chosen: { model: cur.chosen.model, effort: cur.chosen.effort },
          tier: cur.tier,
          source: cur.source,
          reason: cur.reason,
          iq_request_id: cur.iqRequestId,
          latency_ms: cur.latencyMs,
          stay: cur.stay ? { decision: cur.stay.decision } : null,
        }
      : null,
    session: {
      prompts: c.prompts,
      routed: c.routed,
      kept: c.kept,
      no_decision: c.noDecision,
      by_model: byModel,
      est_saved_usd: c.savedUsd === null ? null : r6(c.savedUsd),
      est_saved_basis: 'token_reprice',
    },
    usage: R.usage && R.usage.month === new Date(nowMs).toISOString().slice(0, 7) ? { ...R.usage } : null,
    last_error: R.lastError,
    
    recent: R.recent
      .filter((r) => r.phase !== 'deciding')
      .map((r) => ({
        at_ms: r.submitMs,
        prompt_index: r.idx,
        phase: r.phase,
        tier: r.tier,
        chosen: { model: r.chosen.model, effort: r.chosen.effort },
        reason: r.reason,
        latency_ms: r.latencyMs,
        est_saved_usd: r.done ? r6(recSaving(r)) : null,
      })),
  }
}




export function decisionRow(R, rec, { nowMs, sessionId }) {
  return {
    v: 1,
    t: 'dec',
    ts: isoOf(nowMs),
    sid: sessionId,
    prompt: rec.idx,
    outcome: rec.phase === 'deciding' ? 'off' : rec.phase,
    reason: rec.reason,
    source: rec.source,
    tier: rec.tier,
    iq_request_id: rec.iqRequestId,
    latency_ms: rec.latencyMs,
    wait_ms: rec.waitMs,
    late_ms: rec.lateMs,
    named: rec.named ? { model: rec.named.model, effort: effortLabel(rec.named.effort) } : null,
    chosen: { model: rec.chosen.model, effort: rec.chosen.effort },
    stay: rec.stay,
    block: rec.block,
    sent: rec.sent,
    error: rec.error,
    steps: rec.steps,
    usage: Object.fromEntries(Object.entries(rec.usage).map(([k, v]) => [k, { ...v, usd: r6(v.usd) }])),
    usd_actual: rec.priced ? r6(rec.usdActual) : null,
    usd_named: rec.priced ? r6(rec.usdNamed) : null,
    est_saved_usd: r6(recSaving(rec)),
  }
}




const eff = (e) => (e ? ' · ' + e : '')

export function lineFor(rec, nowMs, R) {
  const model = displayModel(rec.chosen.model)
  switch (rec.phase) {
    case 'applied':
      if (rec.reason === 'cache_warm_hold') return 'iq-route: ' + model + (rec.chosen.effort ? ' · ' + rec.chosen.effort + ' thinking' : '') + ' (IQ rated it ' + rec.tier + '; kept the model, the cache is warm)'
      return 'iq-route: ' + model + (rec.chosen.effort ? ' · ' + rec.chosen.effort + ' thinking' : '') + ' (IQ rated it ' + rec.tier + ')'
    case 'kept':
      if (rec.reason === 'cache_warm_hold') return 'iq-route: kept your model (cache is warm; switching would cost more)'
      if (rec.reason === 'not_above_named') return 'iq-route: kept ' + model + eff(rec.chosen.effort) + ' (already at or below IQ\'s rating)'
      return 'iq-route: kept ' + model + eff(rec.chosen.effort) + ' (IQ rated it ' + rec.tier + ')'
    case 'timeout':
      return "iq-route: no decision (IQ didn't answer in time); kept your model"
    case 'error':
      if (rec.reason === 'backoff' || rec.error === 'http_429') {
        const mins = R && R.backoffUntil > nowMs ? Math.max(1, Math.ceil((R.backoffUntil - nowMs) / 60000)) : 1
        return 'iq-route: no decision (IQ is rate-limiting; routing resumes in ' + mins + ' min); kept your model'
      }
      if (rec.error === 'malformed' || rec.error === 'no_rating') return "iq-route: no decision (IQ's answer wasn't usable); kept your model"
      return 'iq-route: no decision (IQ returned an error); kept your model'
    case 'paused':
      return pauseText(R)
    default:
      return null
  }
}

export const TEXT = {
  usage: 'iq-route: use on, off or status.',
  noKey: 'Add your IQ key with /plugin configure iq-code@iq-routing, then /reload-plugins.',
  killed: 'iq-route: disabled. IQ_ROUTER_DISABLED is set, or ~/.claude/iq/router/OFF exists.',
  noHome: 'iq-route: not turned on. There is no home folder to keep its decision log in.',
  cardChanged: 'iq-route: off. Its price data is not the version it was built with.',
  quiet: 'iq-route: turned itself off after repeated errors (see ~/.claude/iq/router/errors.log). /iq-route on tries again.',
  stopped: 'iq-route: stopped for this session. A routed request was rejected, so your model is used.',
  pausedPlan: ROUTING_PLAN_TEXT,
  pausedPlanRefused: ROUTING_REFUSED_TEXT,
  pausedAllowance: "iq-route: paused. This month's routing decisions are used up; routing resumes on the 1st (UTC), and your model is used until then.",
  off: 'iq-route: off.',
  reset: 'iq-route: reset. The next prompt is rated fresh.',
}

export function onLine(R, nowMs) {
  if (R.pause && (['plan', 'auth'].includes(R.pause.kind) || R.pause.untilMs > nowMs)) return pauseText(R)
  return 'iq-route: on for this session (/iq-route off to stop).'
}


export function statusLines(R, nowMs) {
  const st = statusOf(R, nowMs)
  const s = routingState(R, nowMs)
  const out = []
  if (st === 'killed') out.push(R.cardBad ? TEXT.cardChanged : TEXT.killed)
  else if (st === 'no_key') out.push(TEXT.noKey)
  else if (st === 'paused_errors') out.push(R.stopped ? TEXT.stopped : TEXT.quiet)
  else if (st === 'off') out.push('iq-route: off. /iq-route on turns it on for this session.')
  else if (st === 'paused_plan' || st === 'paused_allowance') out.push(pauseText(R))
  else {
    const c = s.session
    let l = 'iq-route: on · ' + c.routed + ' of ' + c.prompts + ' prompts routed'
    if (c.est_saved_usd !== null) l += c.est_saved_usd < 0 ? ' · est. extra $' + (-c.est_saved_usd).toFixed(2) + ' (API-equivalent)' : ' · est. saved $' + c.est_saved_usd.toFixed(2) + ' (API-equivalent)'
    out.push(l)
    if (R.backoffUntil > nowMs) out.push('iq-route: IQ is rate-limiting; no calls for ' + Math.max(1, Math.ceil((R.backoffUntil - nowMs) / 60000)) + ' more min.')
  }
  const usage = usageLine(R, nowMs)
  if (usage) out.push(usage)
  if (R.current && R.current.phase !== 'deciding') {
    const l = lineFor(R.current, nowMs, R)
    if (l) out.push('last prompt: ' + l.replace(/^iq-route: /, ''))
  }
  return out
}

export function nextUtcDayMs(nowMs) {
  const d = new Date(nowMs)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
}
export function noteRoutingUsage(R, usage, nowMs) {
  if (usage && usage.month === new Date(nowMs).toISOString().slice(0, 7)) R.usage = { ...usage }
}
export function usageLine(R, nowMs) {
  const u = R.usage
  if (!u || isFreePlan(R.plan || u) || u.month !== new Date(nowMs).toISOString().slice(0, 7)) return null
  return 'Routing decisions this month: ' + u.decisions + ' of ' + u.allowance + '.'
}

export function planPauseText(R) {
  return R && R.pause && R.pause.posted === true ? TEXT.pausedPlanRefused : TEXT.pausedPlan
}
function pauseText(R) {
  const kind = R && R.pause && R.pause.kind
  if (kind === 'free_quota') return FREE_ROUTING.monthlyText
  if (kind === 'free_daily') return FREE_ROUTING.dailyText
  if (kind === 'auth') return ROUTING_KEY_TEXT
  return kind === 'plan' ? planPauseText(R) : TEXT.pausedAllowance
}
