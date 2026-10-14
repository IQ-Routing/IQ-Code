import { FORCE_SERVER } from './runtime_mode.js'






import { shortModel, fit, fitChunks, fitText, joinGroups, rowWidth, bandModel, paneTabs, sessionCostLines, planPauseLine } from './ui.js'
import { sessionParts, promptParts, totalIsFloor, floorNotes, usd, percent, plural, count, resetText, viewResetMs, windowFinished, resetLabel, stamp, hours, tokenSize, LABEL } from './format.js'
import { cacheClock } from './view_model.js'
import { displayText } from './iq_client.js'
import { FORECAST_TEXT } from './server_forecast.js'

const SEP = ' · '
const SHORT = 'API-eq.'

const BRIEF_NOTE = 'With routing on, the scrubbed subagent brief (at most 16,000 characters) is sent to IQ; with routing off, no subagent brief is sent.'
const BRIEF_NOTE_SWITCH = 'With routing on, the scrubbed subagent brief (at most 16,000 characters) is sent to IQ unless you turn subagent routing off (/iq-route subagents off); with routing off, no subagent brief is sent.'
const isNum = (x) => typeof x === 'number' && Number.isFinite(x)
const isStr = (x) => typeof x === 'string' && x !== ''


export const PRODUCT_VERSION = '1.0.1'


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
  if (c.state === 'cold') return HEAT_WORDS[0]
  if (!isNum(c.addedTokens)) return null
  let step = HEAT_FROM_ADDED.filter((from) => c.addedTokens >= from).length - 1
  if (c.leftMs * COOLER_UNDER < c.ttlSeconds * 1000) step = Math.max(step - 1, 0)
  return HEAT_WORDS[step]
}




export function cacheChunk(view, nowMs) {
  const c = cacheClock(view && view.cache, nowMs)
  if (!c) return null
  const heat = cacheHeat(c)
  const size = c.tokens !== null ? tokenSize(c.tokens) : null
  const cost = c.rebuildUsd !== null ? usd(c.rebuildUsd) + ' (' + SHORT + ')' : null
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




export function bandShown(view, nowMs) {
  const plan = planChunk(view, nowMs)
  return cacheShown(view, nowMs) + '\n' + (plan ? plan.text : '')
}

function etaText(hitAt, nowMs) {
  if (!isNum(hitAt) || !isNum(nowMs)) return null
  return 'may reach its limit before reset'
}





export function planChunk(view, nowMs) {
  const p = view && view.plan
  if (!p || (!isNum(p.fiveHourPct) && !isNum(p.weeklyPct))) return null
  const parts = []
  let hot = false
  const part = (label, pct, resetsAt) => {
    if (!isNum(pct)) return
    if (windowFinished(viewResetMs(resetsAt), nowMs)) {
      parts.push(resetLabel(label))
      return
    }
    parts.push(label + ' ' + percent(pct))
    if (Math.round(pct) >= 80) hot = true
  }
  part('5-hour', p.fiveHourPct, p.fiveHourResetsAt)
  part('weekly', p.weeklyPct, p.weeklyResetsAt)
  if (isNum(p.stretchPct)) parts.push(WORDS.stretch + ' ~' + Math.round(p.stretchPct) + '% est.')
  return { text: parts.join(SEP), style: hot ? 'warn' : 'dim' }
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





const NO_ESTIMATE = {
  helpers_seen: 'No estimate for sessions with subagents',
  compacted: 'No estimate after compaction',
  model_unsupported: 'No estimate for this model yet',
  long_session: 'No estimate past 64 calls',
}
export function forecastChunk(view, opts) {
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
  const rows = bandModel({ meter: a.meter, routing: a.routing, columns: a.columns, nowMs: a.nowMs })
  if (rows === null) return null
  const m = a.meter
  const working = !!(m && m.working === true && m.prompt)
  const cache = working ? null : cacheChunk(a.view, a.nowMs)
  const plan = planChunk(a.view, a.nowMs)
  const budget = budgetChunk(a.view)

  const warning = budgetWarning(a.view) || (budget && a.view.budget.spentFloor === true ? { forms: [budget.text], style: budget.style } : null)
  const forecast = forecastChunk(a.view, { band: true, spentUsd: m && m.session ? m.session.usd : null, advisorUnpriced: m && m.session ? m.session.advisorUnpriced : 0 })
  if (!cache && !plan && !budget && !forecast) return rows
  const width = isNum(a.columns) && a.columns > 20 ? a.columns - 3 : 100

  const chunkSpan = (c, form) => [{ text: c[form] || c.text, style: c.style }]
  const quiet = warning === null ? budget : null

  const widest = (forms, style) => {
    const text = forms.find((t) => t.length <= width)
    return text === undefined ? null : [{ text, style }]
  }
  const estimate = forecast ? widest([forecast.text, forecast.text.replace(/^This session: /, '').replace('(API-equivalent)', '(' + SHORT + ')')], forecast.style) : null
  const warningRow = warning ? widest(warning.forms, warning.style) || fit([{ text: warning.forms[warning.forms.length - 1], style: warning.style }], width) : null
  const tail = [plan && chunkSpan(plan, 'text'), quiet && chunkSpan(quiet, 'text')].filter(Boolean)
  if (working) {

    const cut = (row) => (rowWidth(row) <= width ? row : row.length === 1 ? fitText(row[0].text, row[0].style, width) : fit(row, width))
    rows.forEach((row, i) => { rows[i] = cut(row) })


    const body = rows.slice(1)
    const last = body.length > 0 ? body[body.length - 1] : null
    const joined = last && tail.length > 0 ? joinGroups([last, ...tail]) : null
    const under = joined !== null && rowWidth(joined) <= width ? [...body.slice(0, -1), joined] : [...body, tail.length > 0 ? fitChunks(tail, width) : []]
    return [rows[0] || [], estimate, ...under, warningRow].filter((r) => r && r.length > 0)
  }

  const routingOn = a.routing && a.routing.status !== 'off'
  const head = routingOn && rows.length > 0 ? rows[0] : null
  const lim = plan ? [] : Array.isArray(m && m.rate_limits) ? m.rate_limits.map((l) => (l ? { kind: l.kind, percentUsed: l.percent_used, resetsAt: l.resets_at } : l)) : []
  const facts = m && m.session ? sessionParts({ usd: m.session.usd, calls: m.session.calls, unpriced: m.session.unpriced, advisorUnpriced: m.session.advisorUnpriced, resumed: m.session.resumed, activeHours: m.session.active_hours, rateLimits: lim, columns: 400, nowMs: a.nowMs }) : null

  const session = (kept) => {
    const text = facts && kept > 0 ? [facts.total, facts.active, facts.rate].filter((t) => t !== null).slice(0, kept).join(SEP) : ''
    return text ? [{ text, style: 'dim' }] : null
  }
  const limits = facts && facts.limits.length > 0 ? [{ text: facts.limits.join(SEP), style: 'dim' }] : null
  const forms = isNum(a.columns) && a.columns < HEAT_MIN_COLUMNS ? ['noHeat', 'short'] : ['text', 'noHeat', 'short']
  const withTotal = [[3, forms[0]], [2, forms[0]], [1, forms[0]], ...forms.slice(1).map((form) => [1, form])]
  const noTotal = forms.map((form) => [0, form])



  const stages = [[true, true, withTotal.slice(0, 3)], [false, true, withTotal], [false, true, noTotal], [false, false, noTotal]]
  const rowOf = (kept, form, withBudget, withPlan) => joinGroups([session(kept), withPlan && !plan && limits, cache && chunkSpan(cache, form), withPlan && plan && chunkSpan(plan, 'text'), withBudget && quiet && chunkSpan(quiet, 'text')].filter(Boolean))
  let second = null
  let totalKept = true
  let planKept = true
  for (const [withBudget, withPlan, steps] of stages) {
    for (const [kept, form] of steps) {
      const row = rowOf(kept, form, withBudget, withPlan)
      if (rowWidth(row) <= width) {
        second = row
        totalKept = kept > 0
        planKept = withPlan
        break
      }
    }
    if (second !== null) break
  }
  if (second === null) {
    second = fit(rowOf(0, forms[forms.length - 1], false, false), width)
    totalKept = false
    planKept = false
  }

  const planRow = !planKept && plan && plan.style === 'warn' ? fit(chunkSpan(plan, 'text'), width) : null



  const lastParts = m && m.session ? promptParts(m.session.last_prompt) : null
  const lastForms = (labelled) => {
    if (!lastParts) return []
    const first = lastParts.head + (labelled ? ' (' + SHORT + ')' : '')
    return [first + SEP + lastParts.calls + lastParts.share + lastParts.est, first + SEP + lastParts.calls + lastParts.share, first + SEP + lastParts.calls, first].filter((t, i, all) => i === 0 || t !== all[i - 1])
  }
  const lastSpan = (text) => [{ text, style: 'plain' }]

  let lastRow = lastParts ? widest([...lastForms(true), lastParts.head], 'plain') || fit(lastSpan(lastParts.head), width) : null
  let totalRow = null
  if (!totalKept && facts && facts.total) {

    const total = [{ text: facts.total, style: 'dim' }]
    const beside = lastForms(false).map((t) => joinGroups([lastSpan(t), total])).find((r) => rowWidth(r) <= width)
    if (beside) lastRow = beside
    else totalRow = fit(total, width)
  }
  return [head, lastRow, estimate, totalRow, second, planRow, warningRow].filter((r) => r && r.length > 0)
}




const REASON = {
  cache_warm_hold: 'kept to protect the warm cache',
  not_above_named: 'never above your model',
  error: 'no answer, kept your model',
  backoff: 'backing off, kept your model',
  paused: 'routing paused',
}


export function reasonText(h) {
  if (!h) return ''
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
  const saved = isNum(h.estSavedUsd) ? (h.estSavedUsd < 0 ? 'est. -' + usd(-h.estSavedUsd) : 'est. ' + usd(h.estSavedUsd)) : ''
  return pad(isNum(h.at) ? stamp(h.at) : '-', 14) + pad(scope, 18) + from + ' → ' + to + (reasonText(h) ? SEP + reasonText(h) : '') + (saved ? SEP + saved : '')
}

function homeTab(a) {
  const v = a.view
  const L = []
  const add = (style, text) => L.push({ style, text })
  const blank = () => L.push({ style: 'plain', text: ' ' })
  L.push({ mark: true })
  add('title', WORDS.product + SEP + 'v' + PRODUCT_VERSION)
  add('dim', 'Routing, cost and plan for Claude Code. Prices are ' + LABEL + '; savings are always estimates.')
  blank()
  const m = a.meter
  add('head', 'This session')
  if (m && m.session && isNum(m.session.calls) && m.session.calls > 0) {
    add('plain', usd(m.session.usd) + (totalIsFloor(m.session) ? '+' : '') + ' (' + SHORT + ')' + SEP + plural(m.session.calls, 'call', 'calls') + (isNum(m.session.active_hours) && m.session.active_hours >= 0.02 ? SEP + hours(m.session.active_hours) + ' active' : ''))
    for (const note of floorNotes(m.session)) add('dim', note)
  } else add('dim', 'Nothing priced yet.')
  const tag = tagOf(v && v.served)
  if (tag) add('plain', 'Serving: ' + tag + (isRouted(v) === null ? '' : SEP + (isRouted(v) ? WORDS.routed : WORDS.notRouted)))
  if (v && v.routing) {

    if (a.routingState && a.routingState.status === 'paused_plan') add('warn', planPauseLine(a.routingState))
    else if (a.routingState && a.routingState.status !== 'off') {
      const c = v.routing.counts
      add('route_down', 'Routing is on' + (c && isNum(c.prompts) ? SEP + count(c.routed) + ' of ' + plural(c.prompts, 'prompt', 'prompts') + ' routed' : ''))
      if (isNum(v.routing.estSavedUsdTotal)) add(v.routing.estSavedUsdTotal > 0 ? 'route_down' : 'plain', (v.routing.estSavedUsdTotal < 0 ? 'est. extra ' : 'est. saved ') + usd(Math.abs(v.routing.estSavedUsdTotal)) + ' (' + SHORT + ')')
    } else add('dim', 'Routing is off. No prompts or subagent briefs are sent to IQ.')
    add('dim', FORCE_SERVER ? BRIEF_NOTE_SWITCH : BRIEF_NOTE)
  }
  const forecast = forecastChunk(v, { spentUsd: m && m.session ? m.session.usd : null, advisorUnpriced: m && m.session ? m.session.advisorUnpriced : 0 })
  if (forecast) add(forecast.style, forecast.text)
  const cc = cacheChunk(v, a.nowMs)
  if (cc) add(cc.style === 'warn' ? 'warn' : 'plain', cc.text)
  const pc = planChunk(v, a.nowMs)
  if (pc) add(pc.style === 'warn' ? 'warn' : 'plain', pc.text)
  if (a.firstRun) {
    blank()
    add('head', 'Welcome. Three steps')
    add('plain', '1. Turn routing on (Settings, or /iq-route on). It needs your IQ key and Personal ($6/month) or higher, and starts off in every session.')
    add('plain', v.settings && v.settings.forecastSource === 'server' ? '2. Check measured usage, plan limits and the cache clock. Personal adds rough session cost estimates in the band and Cost.' : '2. Pick how you want spend measured in Settings: dollars (' + SHORT + ') or percent of your plan.')
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
  L.push({ style: 'head', text: 'History' + SEP + 'main thread, subagents, advisors' })
  if (r && isNum(r.estSavedUsdTotal)) L.push({ style: r.estSavedUsdTotal > 0 ? 'route_down' : 'plain', text: 'Running total: ' + (r.estSavedUsdTotal < 0 ? 'est. extra ' : 'est. saved ') + usd(Math.abs(r.estSavedUsdTotal)) + ' (' + SHORT + ')' })
  const hist = r && Array.isArray(r.history) ? r.history.slice(-14).reverse() : []
  if (hist.length === 0) L.push({ style: 'dim', text: 'No routing decisions yet this session.' })
  else {
    L.push({ style: 'dim', text: pad('when', 14) + pad('scope', 18) + 'from → to, why, est. saved (' + SHORT + ')' })
    for (const h of hist) L.push({ style: h.phase === 'applied' ? 'route_down' : 'plain', text: historyLine(h) })
  }
  return L
}

function planLines(a, tabs) {
  const L = tabs[2].lines.slice()
  const p = a.view && a.view.plan
  const add = (style, text) => L.push({ style, text })
  if (p && (isNum(p.fiveHourPct) || isNum(p.weeklyPct))) {

    const live = (hitAt, resetsAt) => (windowFinished(viewResetMs(resetsAt), a.nowMs) ? null : hitAt)
    const pace = etaText(live(p.fiveHourHitAt, p.fiveHourResetsAt), a.nowMs) || etaText(live(p.weeklyHitAt, p.weeklyResetsAt), a.nowMs)
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
  add('dim', 'Routing lasts for this session. Other preferences are saved for you.')
  add('plain', 'IQ destination: ' + displayText(a.destinationHost || 'gateway.iq-routing.com'))
  add('plain', ' ')
  const on = (b) => (b ? 'on' : 'off')
  const routingOn = !!(a.view && a.view.routing && a.view.routing.on)
  L.push({ style: 'plain', text: pad('Routing', 22) + on(routingOn) })
  if (a.canRoute === true) L.push({ control: { key: 'routing', label: routingOn ? 'Turn routing off' : 'Turn routing on', hotkey: 'r', do: { kind: 'routing', value: !routingOn } } })
  else add('dim', 'Turn it on for this session by typing /iq-route on (and /iq-route off to stop). It starts off every time.')
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
  if (FORCE_SERVER || s.forecastSource === 'server') add('dim', 'Personal adds rough session cost estimates from IQ in the band and /iq Cost. Measured cost is always shown.')
  else add('dim', 'Either way an estimate is early and can be far off, most on long sessions. Prices are API-equivalent.')
  add('plain', ' ')
  if (FORCE_SERVER || s.forecastSource === 'server') {
    add('dim', 'Cost estimate requests send usage numbers, supported model and thinking-level labels, and a random session number. Prompts, answers, files and tool contents are not sent for cost estimates.')
    add('dim', 'With routing on, your typed prompts from this session and model, effort, elapsed-time and token-count facts also go to IQ (best-effort secret scrubbing; about 8,000 tokens at most).')
    add('dim', FORCE_SERVER ? BRIEF_NOTE_SWITCH : BRIEF_NOTE)
  } else {
    add('dim', 'With routing on, your typed prompts from this session and model, effort, elapsed-time and token-count facts go to IQ (best-effort secret scrubbing; about 8,000 tokens at most).')
    add('dim', BRIEF_NOTE)
  }
  if (dashboardAvailable) add('dim', 'Your IQ key reads session defaults even with routing off. Settings requests send no prompt content.')
  add('dim', 'Routing needs your IQ key and Personal ($6/month) or higher, and starts off in every session.')
  return L
}




export function skinTabs(a) {
  const base = paneTabs({ meter: a.meter, routing: a.routingState, read: a.read, surface: a.surface, columns: a.columns, nowMs: a.nowMs }).tabs
  const forecast = forecastChunk(a.view, { spentUsd: a.meter && a.meter.session ? a.meter.session.usd : null, advisorUnpriced: a.meter && a.meter.session ? a.meter.session.advisorUnpriced : 0 })
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
  const costLines = FORCE_SERVER && session ? [
    { style: 'title', text: 'Measured cost · API-equivalent dollars' },
    { style: 'plain', text: usd(session.usd) + (totalIsFloor(session) ? '+' : '') + SEP + plural(session.calls, 'call', 'calls') },
    { style: 'dim', text: 'Measured calls since IQ Code started in this session.' },
    ...floorNotes(session).map((text) => ({ style: 'warn', text })),
    ...cacheLines,
    ...sessionCostLines(a.meter),
  ] : [...base[1].lines, ...(session ? floorNotes(session).map((text) => ({ style: 'warn', text })) : []), ...cacheLines]
  if (forecast) costLines.push(forecast)
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
