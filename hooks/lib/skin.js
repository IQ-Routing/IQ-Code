import { FORCE_SERVER } from './runtime_mode.js'






import { shortModel, fit, fitChunks, fitText, joinGroups, rowWidth, bandModel, paneTabs, sessionCostLines, planPauseLine, cacheStayText, measuredCostLines } from './ui.js'
import { sessionParts, promptParts, estimatedSavingsText, SAVINGS_NOTE, measuredDollars, measuredSpendLine, totalIsFloor, floorNotes, usd, percent, plural, count, resetText, stamp, hours, tokenSize, LABEL, noUsageLine, limitPlanLines, familyLimitLine, LIMIT_SETTINGS_TEXT, PLAN_TYPE_CHOICES, PLAN_TIER_CHOICES, FABLE_BILLING_CHOICES, authKindLine, receiptBillingTurn, receiptBillingTotals, windowReset, WINDOW_RESET } from './format.js'
import { modelFamily } from './limits.js'
import { FORECAST_TEXT } from './server_forecast.js'
import { cacheClock } from './view_model.js'
import { displayText } from './iq_client.js'
import { SAVINGS_MODES_ENABLED, USAGE_REPORTS_ENABLED, LIMIT_AWARE_ENABLED } from './usage_flags.js'
import { savingsModes, savingsPlanRows } from './savings_modes.js'
import { receiptText } from './receipt.js'
import { effortRaise, modelRaise } from './models.js'

const SEP = ' · '
const SHORT = 'API-eq.'

const BRIEF_NOTE = 'With routing on, the scrubbed subagent brief (at most 16,000 characters) is sent to IQ; with routing off, no subagent brief is sent.'
const BRIEF_NOTE_SWITCH = 'With routing on, the scrubbed subagent brief (at most 16,000 characters) is sent to IQ unless you turn subagent routing off (/iq-route subagents off); with routing off, no subagent brief is sent.'
const isNum = (x) => typeof x === 'number' && Number.isFinite(x)
const isStr = (x) => typeof x === 'string' && x !== ''

function modeOf(view) {
  const s = SAVINGS_MODES_ENABLED && view && view.savings
  return s ? savingsModes(s.receipt, { planType: s.planType, free: s.free,
    billingMode: LIMIT_AWARE_ENABLED ? s.billingMode ?? view.limitFacts?.billing_mode : undefined,
    creditBilledFamily: LIMIT_AWARE_ENABLED ? s.creditBilledFamily || (view.limitFacts && (view.limitFacts.credit_billed_families || []).includes(modelFamily(view.served && view.served.model)) ? modelFamily(view.served && view.served.model) : null) : null,
    weeklyPct: s.limits.seven_day.percent, fiveHourPct: s.limits.five_hour.percent }) : null
}


export const PRODUCT_VERSION = '1.1.0'


export const WORDS = {
  product: 'IQ Code',
  glyph: '◆',
  routed: 'routed',
  notRouted: 'not routed',
  cacheLeft: 'cache',
  cacheCold: 'cache cold',
  rebuildWarm: 'If it expires, the next prompt rebuilds it for about',
  rebuildCold: 'The next prompt rebuilds it for about',
  cacheStarted: 'Started at',
  cacheAdded: 'added since',
  overBudget: 'over budget',
  atRisk: 'budget at risk',
  qualityNote: 'a cheaper plan may lower quality',
  fullIn: 'full in',
  staysUnder: 'stays under until it resets',
  stretch: 'routing stretches',
  hintTail: 'IQ Code · /iq',
  hintFirst: 'IQ Code · type /iq to get started',
  mark: 'IQ',
}



export const IQ_BLUE = { light: '#2a6aa8', dark: '#6aa6da' }





export function tagOf(m) {
  if (!m || !isStr(m.model)) return null
  return displayText(shortModel(m.model) + (isStr(m.effort) ? SEP + m.effort : ''))
}


export function isRouted(view) {
  if (!view || !view.routing || view.routing.on !== true) return null
  const hist = Array.isArray(view.routing.history) ? view.routing.history : []
  const last = hist.filter((h) => h && h.scope === 'main').pop()
  if (!last || last.phase !== 'applied' || !last.to || !view.served) return false
  return last.to.model === view.served.model && (last.to.effort || null) === (view.served.effort || null)
}


export function spinnerStatus(view) {
  const tag = tagOf(view && view.served)
  if (tag === null) return null
  const r = isRouted(view)
  return r === null ? tag : tag + SEP + (r ? WORDS.routed : WORDS.notRouted)
}


export function cardLine(tag) {
  return isStr(tag) ? '↳ ' + tag : null
}


export function durationText(ms) {
  if (!isNum(ms) || ms < 0) return null
  const s = Math.round(ms / 1000)
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm ' + (s % 60) + 's'
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'
}


export function turnLine(props, tag) {
  if (!props || !isStr(props.word) || !isStr(tag)) return null
  const d = durationText(props.durationMs)
  return d === null ? null : props.word + ' for ' + d + SEP + tag
}


export function noticeModel(props) {
  if (!props || !isStr(props.text)) return null
  return { prefix: WORDS.glyph, text: props.text, command: isStr(props.command) ? props.command : null }
}


export function hintTail(props, firstRun) {
  if (!props || props.isDraft === true) return null
  return ' ' + (firstRun ? WORDS.hintFirst : WORDS.hintTail)
}




function clockText(ms) {
  const s = Math.max(Math.round(ms / 1000), 0)
  if (s >= 3600) return Math.floor(s / 3600) + 'h ' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + 'm'
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
}



export const HEAT_WORDS = ['heat low', 'heat med', 'heat high', 'heat very high', 'heat max']
export const HEAT_FROM_ADDED = [0, 60000, 100000, 150000, 250000]
export const COOLER_UNDER = 5
export function cacheHeat(c) {
  if (!c) return null
  if (c.state === 'unknown') return null
  if (c.state === 'cold') return HEAT_WORDS[0]
  const dollars = c.heatUsd !== undefined
  if (dollars && (!isNum(c.heatUsd) || !Array.isArray(c.heatThresholdsUsd))) return null
  if (!dollars && !isNum(c.addedTokens)) return null
  let step = (dollars ? c.heatThresholdsUsd : HEAT_FROM_ADDED).filter((from) => (dollars ? c.heatUsd : c.addedTokens) >= from).length - 1
  if (c.leftMs * COOLER_UNDER < c.ttlSeconds * 1000) step = Math.max(step - 1, 0)
  return HEAT_WORDS[step]
}




export function cacheChunk(view, nowMs) {
  const c = cacheClock(view && view.cache, nowMs)
  if (!c) return null
  if (c.state === 'unknown') return { text: 'cache unknown', noHeat: 'cache unknown', short: 'cache unknown', heat: null, rebuild: null, style: 'dim' }
  const heat = cacheHeat(c)
  const size = c.tokens !== null ? tokenSize(c.tokens) : null
  const cost = c.rebuildUsd !== null ? usd(c.rebuildUsd) + ' (' + SHORT + ')' : null
  if (c.compacted && c.state === 'warm') {
    const short = WORDS.cacheLeft + ' ' + clockText(c.leftMs) + ' left'
    const text = WORDS.cacheLeft + ' prefix unknown' + SEP + clockText(c.leftMs) + ' left'
    return { text, noHeat: text, short, heat: null, rebuild: null, style: 'dim' }
  }
  if (c.state === 'cold') {
    const text = size ? WORDS.cacheLeft + ' ' + size + SEP + 'cold' : WORDS.cacheCold
    return { text, noHeat: text, short: WORDS.cacheCold, heat, rebuild: cost ? WORDS.rebuildCold + ' ' + cost : null, style: 'warn' }
  }
  const clock = clockText(c.leftMs) + ' left'
  const head = WORDS.cacheLeft + (size ? ' ' + size + SEP : ' ')
  return { text: heat ? head + heat + SEP + clock : head + clock, noHeat: head + clock, short: WORDS.cacheLeft + ' ' + clock, heat, rebuild: cost ? WORDS.rebuildWarm + ' ' + cost : null, style: c.leftMs < 60000 ? 'warn' : 'dim' }
}




export function cacheShown(view, nowMs) {
  const c = cacheChunk(view, nowMs)
  return c ? c.text : ''
}


export function sessionCostChunk(meter) {
  const measured = meter && meter.session && meter.session.measured
  if (!measured) return null
  const money = measuredDollars
  const fraction = isNum(measured.percent) ? ' (' + Math.round(measured.percent) + '%)' : ''
  return { text: 'this session: ' + money(measured.paid_usd) + (isNum(measured.paid_usd) && measured.paid_complete === false ? '+' : '') + ' spent' + SEP + estimatedSavingsText(measured.saved_usd) + fraction, style: isNum(measured.saved_usd) && measured.saved_usd < 0 ? 'warn' : 'plain' }
}

function etaText(hitAt, nowMs) {
  if (!isNum(hitAt) || !isNum(nowMs)) return null
  return 'may reach its limit before reset'
}




function planEnded(view, nowMs) {
  const p = view && view.plan
  return {
    five: !!p && (p.fiveHourReset === true || windowReset(p.fiveHourResetsAt, nowMs).passed),
    week: !!p && (p.weeklyReset === true || windowReset(p.weeklyResetsAt, nowMs).passed),
  }
}



export function planChunk(view, nowMs) {
  const facts = LIMIT_AWARE_ENABLED && view && view.limitFacts
  if (facts ? facts.billing_mode === 'api' : SAVINGS_MODES_ENABLED && view && view.savings && view.savings.planType === 'api') return null
  const p = view && view.plan
  const ended = planEnded(view, nowMs)

  const shown = (kind, reading, finished) => {
    if (facts) {
      const live = (facts.rows || []).find((row) => row.kind === kind)?.percent_used
      return isNum(live) ? live : null
    }
    return finished ? null : reading
  }
  const parts = []
  let hot = false
  for (const [label, kind, reading, finished] of [['5-hour', 'five_hour', p && p.fiveHourPct, ended.five], ['weekly', 'seven_day', p && p.weeklyPct, ended.week]]) {
    const pct = shown(kind, reading, finished)
    if (isNum(pct)) {
      parts.push(label + ' ' + percent(pct))
      if (Math.round(pct) >= 80) hot = true
    } else if (finished) parts.push(label + ' ' + WINDOW_RESET)
  }
  if (parts.length === 0) return null
  if (p && isNum(p.stretchPct)) parts.push(WORDS.stretch + ' ~' + Math.round(p.stretchPct) + '% est.')
  return { text: parts.join(SEP), style: hot ? 'warn' : 'dim' }
}




export function idleShown(view, nowMs) {
  const ended = planEnded(view, nowMs)
  return cacheShown(view, nowMs) + '\u0001' + (ended.five ? 'f' : '') + (ended.week ? 'w' : '')
}



export function nextPlanReset(view, nowMs) {
  const p = view && view.plan
  if (!p || !isNum(nowMs)) return null
  let next = null
  for (const key of ['fiveHourResetsAt', 'weeklyResetsAt']) {
    const w = windowReset(p[key], nowMs)
    if (w.atMs !== null && !w.passed) next = next === null ? w.atMs - nowMs : Math.min(next, w.atMs - nowMs)
  }
  return next
}


export function budgetChunk(view) {
  const b = view && view.budget
  if (!b || b.status === 'none' || !b.status || !isNum(b.limit)) return null
  const spent = b.unit === 'plan_pct' ? (isNum(b.spentPct) ? percent(Math.round(b.spentPct)) : null) : usd(b.spentUsd) + (b.spentFloor === true ? '+' : '')
  if (spent === null) return null
  const of = b.unit === 'plan_pct' ? percent(b.limit) : usd(b.limit) + ' (' + SHORT + ')'
  let text = 'budget ' + spent + ' of ' + of
  if (b.status === 'over') text += SEP + WORDS.overBudget + SEP + WORDS.qualityNote
  else if (b.status === 'at_risk') text += SEP + WORDS.atRisk + SEP + WORDS.qualityNote
  return { text, style: b.status === 'ok' ? 'dim' : 'warn' }
}



export function budgetWarning(view) {
  const b = view && view.budget
  if (!b || (b.status !== 'over' && b.status !== 'at_risk') || !isNum(b.limit)) return null
  const pct = b.unit === 'plan_pct'
  const spent = pct ? (isNum(b.spentPct) ? percent(Math.round(b.spentPct)) : null) : usd(b.spentUsd) + (b.spentFloor === true ? '+' : '')
  if (spent === null) return null
  const words = b.status === 'over' ? WORDS.overBudget : WORDS.atRisk
  const figures = words + ': ' + spent + ' of ' + (pct ? percent(b.limit) : usd(b.limit))
  return { forms: pct ? [figures, words] : [figures + ' (' + SHORT + ')', figures, words], style: 'warn' }
}


export function forecastChunk(view, meter) {
  const text = measuredSpendLine(meter?.session?.measured)
  if (text) return { text, style: 'dim' }
  return legacySessionForecast(view, { spentUsd: meter?.session?.usd ?? meter?.spentUsd,
    advisorUnpriced: meter?.session?.advisorUnpriced ?? meter?.advisorUnpriced,
    band: meter?.band === true })
}

const NO_ESTIMATE = {
  helpers_seen: 'No estimate for sessions with subagents',
  compacted: 'No estimate after compaction',
  model_unsupported: 'No estimate for this model yet',
  long_session: 'No estimate past 64 calls',
}
function legacySessionForecast(view, opts) {
  const fc = view && view.forecast
  if (!fc || fc.source !== 'server') return null
  if (fc.state === 'available' && isNum(fc.totalQ50Usd)) {

    if (opts && isNum(opts.spentUsd) && Math.round(fc.totalQ50Usd * 100) < Math.round(opts.spentUsd * 100)) return null

    if (opts && isNum(opts.advisorUnpriced) && opts.advisorUnpriced > 0) return null
    return { text: 'This session: rough est. total ' + usd(fc.totalQ50Usd) + ' (API-equivalent)', style: fc.pending ? 'dim' : 'plain' }
  }
  if (opts && opts.band === true) return null
  const text = FORECAST_TEXT[fc.state] || (fc.state === 'unavailable' ? NO_ESTIMATE[fc.reasonCode] : undefined)
  return isStr(text) ? { text, style: 'dim' } : null
}


export const HEAT_MIN_COLUMNS = 80
export function bandRows(a) {
  return bandModel(a)
}




const REASON = {
  cache_warm_hold: 'kept to protect the warm cache',
  not_above_named: 'never above your model',
  error: 'no answer, kept your model',
  backoff: 'backing off, kept your model',
  paused: 'routing paused',
}

const SUBAGENT_REASON = {
  main_off: 'routing off', off: 'routing off', 'subagents off': 'subagent routing off',
  headless: 'no interactive session', killed: 'routing disabled', no_key: 'IQ key unavailable',
  fork: 'fork keeps the parent model', teammate: 'teammate keeps its model',
  workflow_remote: 'remote Workflow agent', workflow_brief_hidden: 'Workflow brief hidden', workflow_brief_unavailable: 'Workflow brief unavailable',
  paused_errors: 'routing paused after errors', paused_rate_limited: 'waiting before retrying IQ', rate_limited: 'waiting before retrying IQ',
  paused_plan: 'IQ plan required', plan_required: 'IQ plan required', paused_allowance: 'IQ allowance reached', allowance: 'IQ allowance reached',
  free_quota: 'IQ allowance reached', free_daily: 'daily IQ allowance reached', auth_required: 'IQ sign-in required',
  no_usage: 'usage limit reached', paused_no_usage: 'usage limit reached', capacity_full: 'agent routing capacity reached',
  session_changed: 'session changed', destination_unavailable: 'IQ unavailable', request_unavailable: 'request unavailable',
  invalid_answer: 'IQ answer unusable', malformed: 'IQ answer unusable', malformed_response: 'IQ answer unusable',
  spawn_rejected: 'host rejected the model change', spawn_failed: 'agent failed to start', spawn_denied: 'host refused the agent',
}

function subagentReason(h) {
  if (h.reason === 'resume_model_retained') return 'kept your model on resume'
  if (h.reason === 'timeout') return 'no answer in time, kept your model'
  if (SUBAGENT_REASON[h.reason]) return 'kept your model: ' + SUBAGENT_REASON[h.reason]
  if (h.phase === 'kept') return 'kept your model'
  if (h.phase === 'applied') {
    if (tagOf(h.from) === tagOf(h.to)) return 'kept your model'
    if (h.from?.model === h.to?.model) return 'changed thinking level'
    if (h.reason === 'haiku_55_required') return 'Haiku 5.5 required'
    const rating = /^iq_(simple|medium|complex)$/.exec(h.reason || '')
    return rating ? rating[1] + ' task' : 'changed model'
  }
  return 'no decision, kept your model'
}


export function reasonText(h) {
  if (!h) return ''
  if (h.scope === 'subagent') return subagentReason(h)
  if (cacheStayText(h)) return cacheStayText(h)
  if (isStr(h.reason) && REASON[h.reason]) return REASON[h.reason]
  if (h.phase === 'applied' && isStr(h.tier)) return h.tier + ' prompt'
  if (h.phase === 'kept') return 'kept your model'
  return isStr(h.reason) && h.reason !== 'off' ? h.reason.replace(/_/g, ' ') : ''
}

const SCOPE = { main: 'main', subagent: 'subagent', advisor: 'advisor' }

function pad(s, n) {
  s = String(s)
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}


export function historyLine(h) {
  const from = tagOf(h.from) || '?'
  const to = tagOf(h.to) || '?'
  const scope = (SCOPE[h.scope] || 'main') + (isStr(h.agentType) ? ' ' + h.agentType : '')
  const scopeLabel = scope.length > 17 ? scope.slice(0, 16) + '…' : scope
  const saved = h.measured ? '' : isNum(h.estSavedUsd) ? (h.estSavedUsd < 0 ? 'est. -' + usd(-h.estSavedUsd) : 'est. ' + usd(h.estSavedUsd)) : ''
  const raised = [modelRaise(h.from?.model, h.to?.model), effortRaise(h.from?.effort, h.to?.effort)].filter(Boolean).join(SEP)
  return pad(isNum(h.at) ? stamp(h.at) : '-', 14) + pad(scopeLabel, 18) + from + ' → ' + to + (reasonText(h) ? SEP + reasonText(h) : '') + (raised ? SEP + raised : '') + (saved ? SEP + saved : '')
}

function homeTab(a) {
  const v = a.view
  const L = []
  const add = (style, text) => L.push({ style, text })
  const blank = () => L.push({ style: 'plain', text: ' ' })
  L.push({ mark: true })
  add('title', WORDS.product + SEP + 'v' + PRODUCT_VERSION)
  add('dim', 'Routing, cost and plan for Claude Code. Prices are ' + LABEL + '; local savings use measured token classes.')
  blank()
  const m = a.meter
  const r = a.routingState
  const decision = r?.current && !['deciding', 'off'].includes(r.current.phase) ? r.current : r?.recent?.at(-1)
  if (decision) {
    const raised = [modelRaise(decision.named?.model ?? r.named?.model, decision.chosen?.model), effortRaise(decision.named?.effort ?? r.named?.effort, decision.chosen?.effort)].filter(Boolean).join(SEP)
    const detail = [tagOf(decision.chosen), isStr(decision.tier) && decision.tier !== 'kept' ? 'IQ rated it ' + decision.tier : null,
      reasonText(decision), raised].filter(Boolean)
    add('plain', 'Last decision: ' + detail.join(SEP))
  }
  const prompt = m?.prompt || m?.session?.last_prompt || m?.session?.prompts?.[0]
  if (prompt) {
    const spent = prompt.measured ? measuredDollars(prompt.measured.paid_usd) : usd(prompt.spend_usd ?? prompt.usd)
    const floor = prompt.measured ? prompt.measured.paid_complete === false : prompt.unpriced > 0 || prompt.advisorUnpriced > 0
    add('plain', 'This prompt: ' + spent + (floor ? '+' : '') + ' (' + SHORT + ')' + SEP + plural(prompt.calls, 'call', 'calls'))
  } else add('dim', 'This prompt: no calls yet.')
  add('head', 'This session')
  const counts = v?.routing?.counts
  if (counts) add('plain', plural(counts.promptsRated ?? ((counts.routed || 0) + (counts.kept || 0)), 'prompt', 'prompts') + ' rated' + SEP + plural(counts.subagentsRated || 0, 'subagent', 'subagents') + ' rated')
  if (m?.session?.measured) {
    add('plain', measuredSpendLine(m.session.measured) + ' (' + SHORT + ')')
    add(m.session.measured.saved_usd < 0 ? 'warn' : 'plain', estimatedSavingsText(m.session.measured.saved_usd))
  } else if (m && m.session && isNum(m.session.calls) && m.session.calls > 0) {
    add('plain', usd(m.session.usd) + (totalIsFloor(m.session) ? '+' : '') + ' (' + SHORT + ')' + SEP + plural(m.session.calls, 'call', 'calls') + (isNum(m.session.active_hours) && m.session.active_hours >= 0.02 ? SEP + hours(m.session.active_hours) + ' active' : ''))
    for (const note of floorNotes(m.session)) add('dim', note)
  } else add('dim', 'Nothing priced yet.')
  if (!m?.session?.measured) {
    const parts = m?.session ? sessionParts({ ...m.session, activeHours: m.session.active_hours, columns: 400 }) : null
    if (parts?.rate) add('plain', 'Pace: ' + parts.rate + ' (' + SHORT + ')')
    const saved = r?.session?.est_saved_usd
    add('plain', estimatedSavingsText(saved, usd))
  }
  add('dim', SAVINGS_NOTE)
  if (r?.usage) add('plain', 'Routing decisions this month: ' + count(r.usage.decisions) + ' of ' + count(r.usage.allowance) + '.')
  const tag = tagOf(v && v.served)
  if (tag) add('plain', 'Serving: ' + tag + (isRouted(v) === null ? '' : SEP + (isRouted(v) ? WORDS.routed : WORDS.notRouted)))
  if (v && v.routing) {
    if (a.routingState && a.routingState.status === 'paused_plan') add('warn', planPauseLine(a.routingState))
    else if (a.routingState && a.routingState.status !== 'off') {
      const c = v.routing.counts
      add(a.routingState.status === 'on' ? 'route_down' : 'warn', a.routingState.status === 'on' ? 'Routing is on' + (c && isNum(c.prompts) ? SEP + count(c.routed) + ' of ' + plural(c.prompts, 'prompt', 'prompts') + ' routed' : '') : 'Routing is paused. See Routing for details.')
    } else if (v.routing.status === 'paused_plan') add('warn', planPauseLine(a.routingState))
    else add('dim', 'Routing is off. No prompts or subagent briefs are sent to IQ.')
    add('dim', FORCE_SERVER ? BRIEF_NOTE_SWITCH : BRIEF_NOTE)
  }
  const forecast = m?.session?.measured ? null : forecastChunk(v, m)
  if (forecast) add(forecast.style, forecast.text)
  const cc = cacheChunk(v, a.nowMs)
  if (cc) add(cc.style === 'warn' ? 'warn' : 'plain', cc.text)
  const pc = planChunk(v, a.nowMs)
  if (pc) add(pc.style === 'warn' ? 'warn' : 'plain', pc.text)
  const budget = budgetChunk(v)
  if (budget) add(budget.style, budget.text)
  if (a.firstRun) {
    blank()
    add('head', 'Welcome. Three steps')
    add('plain', '1. Turn routing on with /iq-route on. It needs your IQ key and Personal ($6/month) or higher, and stays on until /iq-route off.')

    add('plain', v.settings && v.settings.forecastSource === 'server' ? '2. Check measured spend, hourly pace and plan limits in /iq Home and Cost.' : '2. Pick how you want spend measured in Settings: dollars (' + SHORT + ') or percent of your plan.')
    add('plain', '3. Come back to /iq any time: Routing shows what IQ chose, Plan shows when you would hit your limits.')
    L.push({ control: { key: 'onboarded', label: 'Got it', hotkey: 'g', do: { kind: 'onboarded' } } })
  }
  return L
}

function routingLines(a, tabs) {
  const old = tabs[0].lines
  const cut = old.findIndex((l) => l && l.text === 'Last 10 decisions')
  const L = (cut > 0 ? old.slice(0, cut - 1) : old.slice()).slice()
  const blank = () => L.push({ style: 'plain', text: ' ' })
  const r = a.view && a.view.routing
  if (FORCE_SERVER && r) {
    blank()
    L.push({ style: 'dim', text: r.subagentsOn === true ? 'Subagent routing is on (subagent tasks are rated while routing is on). /iq-route subagents off stops it for this session.' : 'Subagent routing is off for this session (subagent tasks are not rated while routing is on). /iq-route subagents on turns it back on.' })
  }
  blank()
  L.push({ style: 'head', text: 'History' + SEP + 'main thread and subagents' })
  if (!a.meter?.session?.measured && r && isNum(r.estSavedUsdTotal)) L.push({ style: r.estSavedUsdTotal > 0 ? 'route_down' : 'plain', text: 'Running total: ' + estimatedSavingsText(r.estSavedUsdTotal, usd) })
  const hist = r && Array.isArray(r.history) ? r.history.slice(-14).reverse() : []
  if (hist.length === 0) L.push({ style: 'dim', text: 'No routing decisions yet this session.' })
  else {
    L.push({ style: 'dim', text: pad('when', 14) + pad('scope', 18) + 'from → to, why' + (a.meter && a.meter.session && a.meter.session.measured ? '' : ', est. saved (' + SHORT + ')') })
    for (const h of hist) {
      const raised = modelRaise(h.from?.model, h.to?.model) || effortRaise(h.from?.effort, h.to?.effort)
      const changed = tagOf(h.from) !== tagOf(h.to)
      L.push({ style: h.phase === 'applied' && changed ? raised ? 'warn' : 'route_down' : 'plain', text: historyLine(a.meter && a.meter.session && a.meter.session.measured ? { ...h, measured: true } : h) })
    }
  }
  return L
}

function planLines(a, tabs) {
  const mode = modeOf(a.view)
  const facts = LIMIT_AWARE_ENABLED && a.view && a.view.limitFacts
  const ended = planEnded(a.view, a.nowMs)
  if (facts) {

    const finished = [ended.five && 'five_hour', ended.week && 'seven_day'].filter(Boolean)
    const lines = [{ style: 'title', text: 'Plan' }, ...limitPlanLines(facts, finished).map((text) => ({
      style: text.startsWith('No Claude usage left') ? 'warn' : 'plain', text,
    }))]
    if (facts.billing_mode !== 'api' && !(facts.rows || []).length && finished.length === 0) lines.push({ style: 'dim', text: LIMIT_SETTINGS_TEXT.missing })
    if (mode) {
      lines.push({ style: 'plain', text: mode.activeLine })
      if (mode.fiveHourLine) lines.push({ style: (a.view.savings.billingMode || facts.billing_mode) === 'subscription' ? 'plain' : 'dim', text: mode.fiveHourLine })
      if (mode.dollarLine) lines.push({ style: 'dim', text: mode.dollarLine })
      if (mode.explanation) lines.push({ style: 'dim', text: mode.explanation })
    }

    const graph = tabs[2].lines.findIndex((line) => line.text && line.text.startsWith('Dollars per prompt this session'))
    if (graph >= 0) lines.push({ style: 'plain', text: ' ' }, ...tabs[2].lines.slice(graph))
    return lines
  }
  if (mode) {
    const s = a.view.savings
    const rows = savingsPlanRows(a.rateLimits, s.planType, a.nowMs)
    return [{ style: 'title', text: 'Plan' }, ...rows.map((text) => ({ style: 'plain', text })),
      ...(mode.fiveHourLine ? [{ style: 'plain', text: mode.fiveHourLine }] : []),
      ...(mode.explanation ? [{ style: 'dim', text: mode.explanation }] : [])]
  }
  const L = tabs[2].lines.slice()
  const p = a.view && a.view.plan
  const add = (style, text) => L.push({ style, text })
  if (p && (isNum(p.fiveHourPct) || isNum(p.weeklyPct))) {
    const pace = (!ended.five && etaText(p.fiveHourHitAt, a.nowMs)) || (!ended.week && etaText(p.weeklyHitAt, a.nowMs))
    if (pace) add('dim', 'At the current pace, a plan window ' + pace + '.')
    if (isNum(p.stretchPct)) add('route_down', WORDS.stretch + ' ~' + Math.round(p.stretchPct) + '% est.')
  }
  return L
}

function settingsTab(a) {
  const s = (a.view && a.view.settings) || {}
  const synced = a.view && a.view.dashboardSources || {}
  const dashboardAvailable = a.view && a.view.dashboardDefaultsAvailable === true
  const source = (key) => synced[key] === true ? ' · from your dashboard' : ''
  const L = []
  const add = (style, text) => L.push({ style, text })
  add('title', 'Settings')
  add('dim', 'Routing stays on in new sessions on this device until you turn it off.')
  add('plain', 'IQ destination: ' + displayText(a.destinationHost || 'gateway.iq-routing.com'))
  add('plain', ' ')
  const facts = LIMIT_AWARE_ENABLED && a.view && a.view.limitFacts
  if (SAVINGS_MODES_ENABLED || facts) {
    add('plain', LIMIT_SETTINGS_TEXT.type)
    add('dim', facts ? authKindLine(facts.authKind) : 'Detected: ' + (a.view && a.view.savings ? a.view.savings.detected : 'unknown'))
    L.push({ controls: PLAN_TYPE_CHOICES.map(([value, label]) => ({
      key: 'plan-type-' + value, label: ((s.planType || 'auto') === value ? '● ' : '') + label, do: { kind: 'set', key: 'planType', value },
    })) })
  }
  if (facts) {
    add('plain', LIMIT_SETTINGS_TEXT.tier)
    L.push({ controls: PLAN_TIER_CHOICES.map(([value, label]) => ({
      key: 'plan-tier-' + value, label: ((s.planTier || 'unknown') === value ? '● ' : '') + label, do: { kind: 'set', key: 'planTier', value },
    })) })
    add('plain', LIMIT_SETTINGS_TEXT.fable)
    L.push({ controls: [[false, 'Off'], [true, 'On']].map(([value, label]) => ({
      key: 'allow-fable-' + value, label: ((s.allowFable === true) === value ? '● ' : '') + label, do: { kind: 'set', key: 'allowFable', value },
    })) })
    if (s.allowFable !== true) add('dim', LIMIT_SETTINGS_TEXT.noFable)
    add('plain', LIMIT_SETTINGS_TEXT.billing)
    L.push({ controls: FABLE_BILLING_CHOICES.map(([value, label]) => ({
      key: 'fable-billing-' + value, label: ((s.fableBilling || 'auto') === value ? '● ' : '') + label, do: { kind: 'set', key: 'fableBilling', value },
    })) })
  }
  add('plain', 'Share usage facts: ' + (s.usageReporting === 'off' ? 'off' : 'on'))
  L.push({ controls: [['on', 'On', 's'], ['off', 'Off', 'n']].map(([value, label, hotkey]) => ({ key: 'usage-reporting-' + value,
    label: ((s.usageReporting === 'off' ? 'off' : 'on') === value ? '● ' : '') + label, hotkey, do: { kind: 'set', key: 'usageReporting', value } })) })
  add('dim', 'Lets IQ keep derived numbers about routed requests (no prompt text). Turn off any time.')
  if (USAGE_REPORTS_ENABLED) {
    add('dim', a.view && a.view.savings && a.view.savings.reportingActive ? 'Usage reporting is on while routing is on.' : 'Usage reporting is off on this device.')
  }
  const on = (b) => (b ? 'on' : 'off')
  const routingOn = !!(a.view && a.view.routing && a.view.routing.on)
  L.push({ style: 'plain', text: pad('Routing', 22) + on(routingOn) })
  if (a.canRoute === true) L.push({ control: { key: 'routing', label: routingOn ? 'Turn routing off' : 'Turn routing on', hotkey: 'r', do: { kind: 'routing', value: !routingOn } } })
  else add('dim', 'Type /iq-route on to turn routing on. It stays on in new sessions on this device until /iq-route off.')
  L.push({ style: 'plain', text: pad('Animation', 22) + on(s.animation !== false) + source('animation') })

  L.push({ control: { key: 'animation', label: s.animation !== false ? 'Turn animation off' : 'Turn animation on', hotkey: 'a', do: { kind: 'set', key: 'animation', value: s.animation === false } } })
  add('plain', ' ')
  L.push({ style: 'plain', text: pad('Budget unit', 26) + (s.budgetUnit === 'plan_pct' ? 'percent of your plan' : 'dollars (' + SHORT + ')') + source('budgetUnit') })
  if (dashboardAvailable || !FORCE_SERVER && s.forecastSource !== 'server') {
  L.push({ controls: [
    { key: 'unit-usd', label: (s.budgetUnit !== 'plan_pct' ? '● ' : '') + 'Dollars', hotkey: 'u', do: { kind: 'set', key: 'budgetUnit', value: 'usd' } },
    { key: 'unit-pct', label: (s.budgetUnit === 'plan_pct' ? '● ' : '') + 'Plan percent', hotkey: 'p', do: { kind: 'set', key: 'budgetUnit', value: 'plan_pct' } },
  ] })
  }
  if (dashboardAvailable) {
    const amount = s.defaultTaskBudget === null ? 'none' : s.budgetUnit === 'plan_pct' ? s.defaultTaskBudget + '% of plan' : usd(s.defaultTaskBudget) + ' (' + SHORT + ')'
    add('plain', pad('Default task budget', 26) + amount + source('defaultTaskBudget'))
    if (s.defaultTaskBudget !== null) L.push({ control: { key: 'default-budget-off', label: 'Use no default budget', hotkey: 'b', do: { kind: 'set', key: 'defaultTaskBudget', value: null } } })
    add('dim', 'A task\'s explicit budget takes precedence. Use /iq-budget <amount> [usd|%] or /iq-budget off.')
  }
  add('plain', ' ')
  if (FORCE_SERVER || s.forecastSource === 'server') add('dim', 'Measured spend and hourly pace appear in /iq Home and Cost. The band shows only IQ, model and thinking.')
  else add('dim', 'Either way an estimate is early and can be far off, most on long sessions. Prices are API-equivalent.')
  add('plain', ' ')
  if (FORCE_SERVER || s.forecastSource === 'server') {
    add('dim', 'Session cost and pace are measured locally from reported usage. No server forecasts are requested for measured sessions.')
    add('dim', 'With routing on, IQ receives the prompt as submitted, including pasted text, and recent submitted prompts after a best-effort scrub and removal of known host context (about 8,000 tokens at most), plus model, effort, elapsed-time and token-count facts.')
    add('dim', FORCE_SERVER ? BRIEF_NOTE_SWITCH : BRIEF_NOTE)
  } else {
    add('dim', 'With routing on, IQ receives the prompt as submitted, including pasted text, and recent submitted prompts after a best-effort scrub and removal of known host context (about 8,000 tokens at most), plus model, effort, elapsed-time and token-count facts.')
    add('dim', BRIEF_NOTE)
  }
  add('dim', 'IQ may send a short prompt or task excerpt to OpenAI to rate it. Some requests skip this step. See iq-routing.com/privacy for retention and provider terms.')
  if (dashboardAvailable) add('dim', 'Your IQ key reads session defaults even with routing off. Settings requests send no prompt content.')
  add('dim', 'Routing needs your IQ key and Personal ($6/month) or higher, and stays on until /iq-route off.')

  return L
}




export function skinTabs(a) {
  const base = paneTabs({ meter: a.meter, routing: a.routingState, read: a.read, surface: a.surface, columns: a.columns, nowMs: a.nowMs }).tabs
  const forecast = forecastChunk(a.view, a.meter)
  const session = a.meter && a.meter.session

  const cc = cacheChunk(a.view, a.nowMs)
  const clock = cacheClock(a.view && a.view.cache, a.nowMs)
  const began = clock && clock.startTokens !== null && clock.addedTokens !== null ? WORDS.cacheStarted + ' ' + tokenSize(clock.startTokens) + SEP + tokenSize(clock.addedTokens) + ' ' + WORDS.cacheAdded : null
  const cacheLines = cc ? [
    { style: 'plain', text: ' ' },
    { style: 'head', text: 'Prompt cache' },
    { style: cc.style === 'warn' ? 'warn' : 'plain', text: cc.text },
    ...(began ? [{ style: 'dim', text: began }] : []),
    ...(cc.rebuild ? [{ style: 'dim', text: cc.rebuild }] : []),
  ] : []
  const costLines = session?.measured ? [...base[1].lines, ...cacheLines] : FORCE_SERVER && session ? [
    { style: 'title', text: 'Measured cost · API-equivalent dollars' },
    { style: 'plain', text: usd(session.usd) + (totalIsFloor(session) ? '+' : '') + SEP + plural(session.calls, 'call', 'calls') },
    { style: 'dim', text: 'Measured calls since IQ Code started in this session.' },
    ...floorNotes(session).map((text) => ({ style: 'warn', text })),
    ...cacheLines,
    ...sessionCostLines(a.meter),
  ] : [...base[1].lines, ...(session ? floorNotes(session).map((text) => ({ style: 'warn', text })) : []), ...cacheLines]
  if (forecast) costLines.push(forecast)
  const mode = modeOf(a.view)
  if (mode && !(session && session.measured)) {
    if (a.view.savings.planType === 'subscription') for (const l of costLines) if (l.text && l.text.includes('$')) l.style = 'dim'
    const s = a.view.savings
    for (const text of receiptText(s.receipt, { planType: s.planType, free: s.free, billingMode: s.billingMode, creditBilledFamily: s.creditBilledFamily, ...mode }).split('\n')) costLines.push({ style: text === mode.dollarLine || text === mode.explanation ? 'dim' : 'plain', text })
    if (s.fableUnknown) costLines.push({ style: 'dim', text: 'Fable billing: unknown · est. savings unavailable' })
    const billing = LIMIT_AWARE_ENABLED && (a.view.billingReceipt || s.billingReceipt)
    if (billing) {
      for (const turn of billing.turns || []) costLines.push({ style: turn.basis === 'unknown' ? 'dim' : 'plain', text: receiptBillingTurn(turn) })
      for (const text of receiptBillingTotals(billing.totals || {})) costLines.push({ style: 'plain', text })
    }
    costLines.push({ control: { key: 'receipt', label: 'Copy receipt', do: { kind: 'receipt' } } })
  }
  return {
    tabs: [
      { id: 'home', title: 'Home', lines: homeTab(a) },
      { id: 'routing', title: 'Routing', lines: routingLines(a, base) },
      { id: 'cost', title: 'Cost', lines: costLines },
      { id: 'plan', title: 'Plan', lines: planLines(a, base) },
      { id: 'settings', title: 'Settings', lines: settingsTab(a) },
    ],
  }
}
