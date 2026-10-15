import { LIMIT_AWARE_ENABLED } from './usage_flags.js'

import { dayOf, isoOf } from './util.js'
import { validateAnswer, rankOf, sameModel, displayModel, effortLabel, sameChoice, canonicalModel, applicableChoice, supportsEffort, effortRaise } from './models.js'
import { DEFAULT_DEADLINE_MS, COLD_DEADLINE_MS, cleanText, FREE_ROUTING, ROUTING_PLAN_TEXT, ROUTING_REFUSED_TEXT, ROUTING_KEY_TEXT, isFreePlan } from './iq_client.js'
import { VERSION } from './pins.js'
import { noUsageLine, NO_USAGE_FALLBACK, windowReset } from './format.js'
import { mainPass, latestCacheWriteTtlMs } from './pricing.js'
import { measureCall, rebuildDebit } from './measured_cost.js'
import { trivialTurn, turnText } from './trivial_turn.js'
export { trivialTurn, turnText } from './trivial_turn.js'
import { FORCE_SERVER } from './runtime_mode.js'

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


export function routeCacheAgeSeconds(last, nowMs) {
  return last && typeof last.startMs === 'number' && Number.isFinite(last.startMs) && Number.isFinite(nowMs)
    ? Math.max(0, (nowMs - last.startMs) / 1000) : null
}



export function routeContextFacts(R, seen) {
  const live = typeof seen === 'number' && Number.isFinite(seen) && seen >= 0 ? seen : 0
  const last = R.cacheRestart ? null : R.last
  const context = Math.max(live, last && last.ctx || 0) || null
  return { context_tokens: context, cached_prefix_tokens: last ? Math.min(context ?? 0, last.cachedPrefix || 0) : 0 }
}



export function routeCacheTtlSeconds(last, { ttlMs, ttlKnown }) {
  const lifetime = last && Object.prototype.hasOwnProperty.call(last, 'ttlMs') ? last.ttlMs : ttlKnown ? ttlMs : null
  return lifetime === TTL_1H ? 3600 : lifetime === TTL_5M ? 300 : null
}



export function onSubscription(rateLimits, nowMs) {
  if (!Array.isArray(rateLimits) || rateLimits.length === 0) return false
  return rateLimits.every((l) => !l || typeof l.percentUsed !== 'number' || l.percentUsed < 100 || windowReset(l.resetsAt, nowMs).passed)
}




export function newRouter() {
  return {
    armed: false, 
    plan: null, 
    usage: null, 
    pause: null, 
    deadlineMs: COLD_DEADLINE_MS,
    resetNextRoute: false, 
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
    routeHold: null,
    failureNotices: new Set(), 
    named: null, 
    current: null, 
    last: null, 
    cacheStart: null, 
    cacheRestart: false, 
    cacheModels: {}, 
    cacheStartRead: false, 
    seq: 0,
    counters: { prompts: 0, routed: 0, kept: 0, noDecision: 0, byModel: {}, savedUsd: null },
    stats: { turns: 0, steps: 0, out: 0, fresh: 0, maxGapS: 0 },
    lastError: null,
    ttlMs: TTL_5M,
    observedCacheTtlMs: null, 
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
  if (R.pause && R.pause.kind === 'plan' && R.pause.posted !== true) return 'paused_plan' 
  if (!R.armed) return 'off'
  if (LIMIT_AWARE_ENABLED && (R.noUsage || R.pause && R.pause.kind === 'no_usage')) return 'paused_no_usage'
  if (R.pause && ['plan', 'auth'].includes(R.pause.kind)) return 'paused_plan'
  if (R.pause && ['allowance', 'free_quota', 'free_daily'].includes(R.pause.kind) && R.pause.untilMs > nowMs) return 'paused_allowance'
  return 'on'
}





export function taskContinuation(text) {
  return /^(?:continue (?:with )?the current task|keep working on the current task|carry on with the same task)[.!]?$/i.test(turnText(text))
}
export function clearRouteHold(R) { R.routeHold = null }
export function installRouteHold(R, parsed, nowMs, choice) {
  clearRouteHold(R)
  const n = parsed && parsed.hold
  if (!Number.isSafeInteger(n) || n <= 0 || n > 32 || !choice || !R.last ||
      !sameChoice(choice, R.last) || !(R.last.cachedPrefix > 0) || !Number.isFinite(R.last.startMs) || !(R.last.ttlMs > 0) || !(R.ttlMs > 0)) return
  if (Object.hasOwn(parsed.block || {}, 'hold_expires_in_seconds') && parsed.hold_expires_in_seconds === null) return
  const seconds = parsed.hold_expires_in_seconds ?? 60
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 60) return
  const untilMs = Math.min(nowMs + seconds * 1000, R.last.startMs + (R.last.ttlMs ?? R.ttlMs))
  if (untilMs <= nowMs) return
  R.routeHold = { remaining: n, untilMs, choice: { ...choice }, context: R.last.ctx }
}
export function fastSubmit(R, nowMs, text, named) {
  const h = R.routeHold
  if (h && (nowMs >= h.untilMs || h.remaining <= 0 || !R.last ||
      !sameChoice(h.choice, R.last) || named && !sameChoice(h.choice, named) ||
      R.last.ctx < h.context || nowMs >= R.last.startMs + (R.last.ttlMs ?? R.ttlMs))) clearRouteHold(R)
  if (trivialTurn(text)) return { action: 'local', phase: 'kept', reason: 'trivial_turn', source: 'none', counted: false }
  if (R.routeHold && taskContinuation(text)) {
    R.routeHold.remaining -= 1
    return { action: 'local', phase: 'kept', reason: 'server_hold', source: 'none', counted: false }
  }
  clearRouteHold(R) 
  return null
}
export function settleKept(R, rec, reason) {
  settleNone(R, rec, 'kept', reason)
  rec.localSkipped = true
  rec.tier = 'kept'
  rec.iqBand = 'kept'
  rec.waitMs = 0
}



export function planSubmit(R, nowMs, ttlMs, limits = R.limitFacts) {
  if (LIMIT_AWARE_ENABLED && R.armed && (limits && limits.all_exhausted || R.noUsage || R.pause && R.pause.kind === 'no_usage')) return { action: 'local', phase: 'paused', reason: 'no_usage' }
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
    choice = { model: current.model, effort: current.effort }
    d.stay = { decision: 'hold' }
  }
  choice = applicableChoice(choice, named, c.explicitEffort ?? null)
  d.cacheAdvantageUsd = answer.stay && typeof c.est.block.cache_advantage_usd === 'number' && Number.isFinite(c.est.block.cache_advantage_usd) && c.est.block.cache_advantage_usd >= 0 ? c.est.block.cache_advantage_usd : null
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
  rec.cacheAdvantageUsd = d.cacheAdvantageUsd ?? null
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
  if (LIMIT_AWARE_ENABLED && kind === 'no_usage') {
    R.pause = { kind }
    R.noUsage = true
    R.noUsageDefects = (R.noUsageDefects || 0) + 1
    settleNone(R, rec, 'paused', 'no_usage', 'no_usage_left')
    return
  }
  
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










export function noteCacheStart(R, { model, tokens, endMs }) {
  if (!(typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0)) return false
  const s = R.cacheStart
  const was = typeof model === 'string' ? canonicalModel(model) : ''
  const had = s && typeof s.model === 'string' ? canonicalModel(s.model) : ''
  const another = was !== '' && had !== '' && was !== had
  const restart = R.cacheRestart === true
  R.cacheRestart = false
  if (s && !restart && !another && tokens >= s.tokens) return false
  R.cacheStart = { model: typeof model === 'string' ? model : '', tokens, atMs: typeof endMs === 'number' && Number.isFinite(endMs) ? endMs : 0 }
  return true
}


export function noteCompaction(R) {
  if (R && typeof R === 'object') {
    R.cacheRestart = true
    for (const entry of Object.values(R.cacheModels || {})) entry.compacted = true
  }
}



export const CACHE_START_FILE = 'cache_start.json'
const CACHE_START_KEEP = 16
const savedSessions = (text) => {
  let o = null
  try {
    o = JSON.parse(text)
  } catch (_) {
    return []
  }
  const list = o && typeof o === 'object' && Array.isArray(o.sessions) ? o.sessions : []
  return list.filter((x) => x && typeof x === 'object' && typeof x.sid === 'string' && x.sid !== '' && typeof x.model === 'string' && typeof x.tokens === 'number' && Number.isFinite(x.tokens) && x.tokens > 0 && typeof x.atMs === 'number' && Number.isFinite(x.atMs))
}


export function savedCacheStart(text, sessionId) {
  if (typeof text !== 'string' || typeof sessionId !== 'string' || sessionId === '') return null
  const hit = savedSessions(text).find((x) => x.sid === sessionId)
  return hit ? { model: hit.model, tokens: hit.tokens, atMs: hit.atMs } : null
}


export function cacheStartText(oldText, sessionId, start) {
  const keep = (typeof oldText === 'string' ? savedSessions(oldText) : []).filter((x) => x.sid !== sessionId)
  keep.push({ sid: sessionId, model: typeof start.model === 'string' ? start.model.slice(0, 80) : '', tokens: start.tokens, atMs: start.atMs })
  keep.sort((a, b) => a.atMs - b.atMs)
  return JSON.stringify({ v: 1, sessions: keep.slice(-CACHE_START_KEEP) }, null, 1) + '\n'
}









export function writeTtlMs({ derivedMs, usage, prev, model }) {
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
  const wrote = !!usage && num(usage.cache_creation_input_tokens) > 0
  const same = !!prev && typeof prev.model === 'string' && typeof model === 'string' && canonicalModel(prev.model) === canonicalModel(model)
  if (!wrote && same && prev.ttlMs !== undefined) return typeof prev.ttlMs === 'number' && prev.ttlMs > 0 ? prev.ttlMs : null
  if (wrote) {
    const split = usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation : null
    const w1 = split ? num(split.ephemeral_1h_input_tokens) : 0
    const w5 = split ? num(split.ephemeral_5m_input_tokens) : 0
    if (w1 > 0 && w5 === 0) return 3_600_000
    if (w5 > 0 && w1 === 0) return 300_000
    if (w1 > 0 && w5 > 0) return null 
  }
  return typeof derivedMs === 'number' && derivedMs > 0 ? derivedMs : null
}





export function noteMainStep(R, { model, effort, startMs, endMs, usage, routed, sessionModel, ttlMs, advisorCalls }) {
  const observedTtl = latestCacheWriteTtlMs(usage, model)
  if (observedTtl !== null) R.observedCacheTtlMs = observedTtl
  if (R.last && startMs > R.last.startMs) {
    const gap = (startMs - R.last.startMs) / 1000
    if (gap > R.stats.maxGapS) R.stats.maxGapS = gap
  }
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
  
  
  
  
  const pass = mainPass(usage, model, advisorCalls)
  const key = canonicalModel(model)
  const entries = R.cacheModels || (R.cacheModels = {})
  const previous = entries[key]
  
  const display = { cacheStart: previous && previous.start || (R.cacheStart && canonicalModel(R.cacheStart.model) === key ? R.cacheStart : null), cacheRestart: previous ? previous.compacted : R.cacheRestart }
  noteCacheStart(display, { model, tokens: pass.prefix, endMs })
  noteCacheStart(R, { model, tokens: pass.prefix, endMs })
  R.last = { model, effort: effort === undefined ? null : effort, startMs, endMs, ctx: pass.ctx, cachedPrefix: pass.prefix, pass, routed: routed === true, sessionModel: typeof sessionModel === 'string' && sessionModel !== '' ? sessionModel : null }
  if (ttlMs !== undefined) R.last.ttlMs = typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : null
  if (key) entries[key] = { last: R.last, start: display.cacheStart, compacted: false }
  R.stats.steps += 1
  R.stats.out += num(usage.output_tokens)
  R.stats.fresh += num(usage.input_tokens)
}















export function noteRecStep(rec, { model, usage, pricer, prev, startMs, ttlMs, changed, effort, writeTtl, advisorCalls, measured: recorded }) {
  rec.steps += 1
  const m = usage.model || model
  const diverged = !rec.localSkipped && rec.reason !== 'trivial_turn' && (changed === true || prev?.routed === true)
  if (diverged) rec.touched = true
  const measured = recorded || measureCall(pricer, { model: m, effort: effort ?? rec.chosen?.effort, named: rec.named, usage, main: true,
    switched: diverged, writeTtl: writeTtl === undefined ? ttlMs / 1000 : writeTtl, advisorCalls,
    rebuildUsd: rebuildDebit(pricer, { named: rec.named, usage, prev, startMs, ttlMs, switched: diverged, writeTtl: writeTtl === undefined ? ttlMs / 1000 : writeTtl, advisorCalls }),
    skipped: rec.localSkipped || rec.reason === 'trivial_turn' })
  const row = rec.usage[m] || (rec.usage[m] = { calls: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, usd: 0 })
  row.calls += 1
  row.input += measured.usage.input || 0
  row.output += (measured.usage.output || 0) + (measured.usage.thinking || 0)
  row.cache_read += measured.usage.cache_read || 0
  row.cache_write += (measured.usage.cache_write_5m || 0) + (measured.usage.cache_write_1h || 0)
  row.usd += measured.paid_usd || 0
  rec.measured = measured
  if (measured.paid_usd !== null) rec.usdActual += measured.paid_usd
  if (measured.baseline_usd !== null) rec.usdNamed += measured.baseline_usd
  if (typeof measured.rebuild_debit_usd === 'number' && Number.isFinite(measured.rebuild_debit_usd)) {
    rec.rebuildUsd = (rec.rebuildUsd || 0) + measured.rebuild_debit_usd
    if (measured.rebuild_debit_usd > 0) rec.touched = true
  }
  if (!measured.complete) rec.priced = false
  if (typeof measured.saved_usd === 'number' && Number.isFinite(measured.saved_usd)) {
    rec.savedUsd = (rec.savedUsd || 0) + measured.saved_usd
  }
  return { actualUsd: measured.paid_usd, namedUsd: measured.baseline_usd }
}



export function recSaving(rec) {
  if (rec.localSkipped || rec.reason === 'trivial_turn') return rec.steps > 0 && rec.rebuildUsd > 0 ? -rec.rebuildUsd : null
  return (rec.routed || rec.touched) && rec.priced && rec.steps > 0 ? rec.savedUsd : null
}


export function noteTurnDone(R, rec) {
  if (rec.done) return
  rec.done = true
  const s = recSaving(rec)
  if (s !== null && (rec.counted || s < 0)) R.counters.savedUsd = (R.counters.savedUsd || 0) + s
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
    ...(status === 'paused_no_usage' ? { no_usage_reset: R.limitFacts && R.limitFacts.next_reset } : {}),
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
          ...(cur.cacheAdvantageUsd != null ? { cacheAdvantageUsd: cur.cacheAdvantageUsd } : {}),
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
        named: r.named ? { model: r.named.model, effort: r.named.effort } : null,
        reason: r.reason,
        ...(r.cacheAdvantageUsd != null ? { cacheAdvantageUsd: r.cacheAdvantageUsd } : {}),
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
    rebuild_debit_usd: rec.priced ? r6(rec.rebuildUsd || 0) : null,
    est_saved_usd: r6(recSaving(rec)),
  }
}




const eff = (e) => (e ? ' · ' + e : '')

export function lineFor(rec, nowMs, R) {
  const model = displayModel(rec.chosen.model)
  if (rec.reason === 'trivial_turn') return 'iq-route: kept'
  if ((rec.phase === 'kept' || rec.phase === 'applied') && rec.reason === 'cache_warm_hold') {
    const amount = rec.cacheAdvantageUsd
    return 'iq-route: stayed: warm cache cheaper' + (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 ? ' by $' + amount.toFixed(2) : '')
  }
  switch (rec.phase) {
    case 'applied':
      return 'iq-route: ' + model + (rec.chosen.effort ? ' · ' + rec.chosen.effort + ' thinking' : '') + ' (IQ rated it ' + rec.tier + ')' + (effortRaise(rec.named?.effort, rec.chosen.effort) ? ' · ' + effortRaise(rec.named.effort, rec.chosen.effort) : '')
    case 'kept':
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
      if (LIMIT_AWARE_ENABLED && rec.reason === 'no_usage') return rec.error === 'no_usage_left' ? NO_USAGE_FALLBACK : noUsageLine(R && R.limitFacts && R.limitFacts.next_reset)
      return pauseText(R)
    default:
      return null
  }
}

export const TEXT = {
  usage: FORCE_SERVER ? 'iq-route: use on, off, status, reset, or subagents on|off.' : 'iq-route: use on, off, status or reset.',
  noKey: 'Add your IQ key with /plugin configure iq-code@iq-routing, then /reload-plugins.',
  killed: 'iq-route: disabled. IQ_ROUTER_DISABLED is set, or ~/.claude/iq/router/OFF exists.',
  noHome: 'iq-route: not turned on. There is no home folder to keep its decision log in.',
  cardChanged: 'iq-route: off. Its price data is not the version it was built with.',
  quiet: 'iq-route: turned itself off after repeated errors (see ~/.claude/iq/router/errors.log). /iq-route on tries again.',
  stopped: 'iq-route: stopped for this session. A routed request was rejected, so your model is used.',
  pausedPlan: ROUTING_PLAN_TEXT,
  pausedPlanRefused: ROUTING_REFUSED_TEXT,
  pausedAllowance: "iq-route: paused. This month's routing decisions are used up; routing resumes on the 1st (UTC), and your model is used until then. See /iq.",
  off: 'iq-route: off.',
  reset: 'iq-route: reset. The next prompt is rated fresh.',
}

export function onLine(R, nowMs) {
  if (R.pause && (['plan', 'auth'].includes(R.pause.kind) || R.pause.untilMs > nowMs)) return pauseText(R)
  return 'iq-route: on. It stays on in new sessions on this device until /iq-route off.'
}


export function statusLines(R, nowMs) {
  const st = statusOf(R, nowMs)
  const s = routingState(R, nowMs)
  const out = []
  if (st === 'killed') out.push(R.cardBad ? TEXT.cardChanged : TEXT.killed)
  else if (st === 'no_key') out.push(TEXT.noKey)
  else if (st === 'paused_errors') out.push(R.stopped ? TEXT.stopped : TEXT.quiet)
  else if (st === 'off') out.push('iq-route: off. /iq-route on turns it on until /iq-route off.')
  else if (st === 'paused_no_usage') out.push(noUsageLine(R.limitFacts && R.limitFacts.next_reset))
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
