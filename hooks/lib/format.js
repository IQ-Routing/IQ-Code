import { measuredPace } from './measured_cost.js'






export const LABEL = 'API-equivalent'
export function routingPreferenceLine(keep, armed, off, enabled) {
  if (keep !== true || enabled !== true) return null
  if (off === true) return 'Off this session; future interactive sessions will start on when controls permit.'
  return armed === true ? 'Routing on · kept on' : 'Kept routing is saved; routing remains off under current controls.'
}
const SHORT_LABEL = 'API-eq.'
const SEP = ' · '
const BARS = '▁▂▃▄▅▆▇█'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']




const isNum = (x) => typeof x === 'number' && Number.isFinite(x)






export function windowReset(resetsAt, nowMs) {
  const atMs = typeof resetsAt === 'string' ? Date.parse(resetsAt) : resetsAt
  if (!isNum(atMs)) return { passed: false, atMs: null }
  return { passed: isNum(nowMs) && atMs <= nowMs, atMs }
}

export const WINDOW_RESET = 'reset'


export function usd(x) {
  if (!isNum(x)) return '$?'
  const a = Math.abs(x)
  if (a === 0) return '$0.00'
  if (a < 0.005) return '<$0.01'
  if (a < 100) return '$' + a.toFixed(2)
  if (a < 1000) return '$' + String(Math.round(a))
  if (a < 10000) return '$' + (a / 1000).toFixed(1) + 'k'
  return '$' + String(Math.round(a / 1000)) + 'k'
}

export function count(n) {
  if (!isNum(n)) return '?'
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function plural(n, one, many) {
  return n === 1 ? '1 ' + one : count(n) + ' ' + many
}


export function tokens(n) {
  if (!isNum(n)) return '?'
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return String(Math.round(n / 1e3)) + 'k'
  return String(Math.round(n))
}


export function tokenSize(n) {
  if (!isNum(n) || n < 0) return '?'
  const one = (x) => String(Number(x.toFixed(1)))
  if (n < 1e3) return String(Math.round(n)) + ' tok'
  if (n < 1e6 && Math.round(n / 1e3) < 1e3) return (n < 1e4 ? one(n / 1e3) : String(Math.round(n / 1e3))) + 'K tok'
  return one(n / 1e6) + 'M tok'
}

export function percent(p) {
  if (!isNum(p)) return '?%'
  return String(Math.round(p)) + '%'
}

export function hours(h) {
  if (!isNum(h)) return '?'
  if (h < 1) return String(Math.max(Math.round(h * 60), 0)) + ' min'
  if (h < 100) return h.toFixed(1) + ' h'
  return String(Math.round(h)) + ' h'
}

export function minutes(m) {
  if (!isNum(m)) return '?'
  if (m >= 90) return (m / 60).toFixed(1) + ' h'
  return String(Math.max(Math.round(m), 1)) + ' min'
}

function two(n) {
  return n < 10 ? '0' + n : String(n)
}


function clock12(d) {
  const h = d.getHours()
  const m = d.getMinutes()
  const ap = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return String(h12) + ':' + two(m) + ap
}


export function resetText(iso, withDay) {
  if (typeof iso !== 'string') return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return (withDay ? DAYS[d.getDay()] + ' ' : '') + clock12(d)
}

const LIMIT_LABELS = { five_hour: '5-hour', seven_day: 'Weekly', spend_limit: 'Spend limit', seven_day_opus: 'Opus weekly', seven_day_sonnet: 'Sonnet weekly', seven_day_overage_included: 'Included overage', overage: 'Overage' }
const FAMILY_LABELS = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable', mythos: 'Mythos' }
const limitReset = (seconds, day = false) => {
  if (!isNum(seconds)) return ''
  const time = new Date(seconds * 1000)
  return Number.isNaN(time.getTime()) ? '' : resetText(time.toISOString(), day)
}
export function noUsageLine(nextReset = null) {
  const time = limitReset(nextReset)
  return 'No Claude usage left' + (time ? ' until ' + time : '') + ' · IQ sent nothing'
}
export const NO_USAGE_FALLBACK = 'No Claude usage left. Nothing was counted.'
export function billingLine(mode) {
  return { api: 'Billing: API key (pay per token)', subscription: 'Billing: subscription (plan limits)',
    extra_usage: 'Billing: usage credits or grace window (pay per token past the limit) · cache 5 min',
    cloud_credits: 'Billing: cloud credits (pay per token) · cache 5 min', unknown: 'Billing: unknown' }[mode] || 'Billing: unknown'
}


export function limitPlanLines(facts, ended = []) {
  if (!facts) return []
  const lines = [billingLine(facts.billing_mode)]
  if (facts.all_exhausted || facts.blocked) lines.push(noUsageLine(facts.next_reset))
  if (facts.billing_mode !== 'api') {
    const entries = []
    for (const row of facts.rows || []) {
      if (!LIMIT_LABELS[row.kind] || !isNum(row.percent_used)) continue
      const reset = limitReset(row.resets_at, true)
      entries.push({ kind: row.kind, text: LIMIT_LABELS[row.kind] + ': ' + percent(row.percent_used) + ' used · ' + (reset ? 'resets ' + reset : 'reset time unavailable') })
    }
    const finished = ended.filter((kind) => LIMIT_LABELS[kind] && !entries.some((e) => e.kind === kind))
    for (const kind of finished) entries.push({ kind, text: LIMIT_LABELS[kind] + ': ' + WINDOW_RESET })
    if (finished.length > 0) entries.sort((a, b) => Object.keys(LIMIT_LABELS).indexOf(a.kind) - Object.keys(LIMIT_LABELS).indexOf(b.kind))
    for (const entry of entries) lines.push(entry.text)
  }
  for (const family of facts.exhausted_families || []) {
    if (!FAMILY_LABELS[family]) continue
    const row = (facts.rows || []).find((r) => r.kind === 'seven_day_' + family)
    const reset = limitReset(row && row.resets_at, true)
    lines.push(FAMILY_LABELS[family] + ': limit used up' + (reset ? ', resets ' + reset : ' · reset time unavailable'))
  }
  if ((facts.credit_billed_families || []).includes('fable')) lines.push('Fable bills to usage credits on your plan · est. savings on Fable turns use API prices')
  return lines
}
export function familyLimitLine(facts, chosenFamily, servingFamily) {
  if (!facts || ['api', 'extra_usage', 'cloud_credits'].includes(facts.billing_mode)) return null
  const family = (facts.exhausted_families || []).find((f) => f === chosenFamily) || (facts.exhausted_families || [])[0]
  if (!FAMILY_LABELS[family]) return null
  const row = (facts.rows || []).find((r) => r.kind === 'seven_day_' + family)
  const time = limitReset(row && row.resets_at, true)
  const available = FAMILY_LABELS[servingFamily] && !(facts.exhausted_families || []).includes(servingFamily) ?
    servingFamily === chosenFamily ? ', IQ kept ' + FAMILY_LABELS[servingFamily] : ' · routing within ' + FAMILY_LABELS[servingFamily] :
    ' · routing within available models'
  return FAMILY_LABELS[family] + ' limit used up' + (time ? ' until ' + time : '') + available
}
export function creditSavingsLine(saved, pastLimit = true) {
  const amount = isNum(saved) ? '$' + (Object.is(saved, -0) ? 0 : saved).toFixed(2) : null
  return (pastLimit ? 'past your plan limit · ' : 'Fable bills to usage credits on your plan · ') +
    (amount ? 'est. ' + amount + ' saved (API prices)' : 'est. savings unavailable')
}
export const LIMIT_SETTINGS_TEXT = Object.freeze({ auth: 'Host login: ', type: 'Plan type', tier: 'Plan tier', fable: 'Allow Fable', billing: 'Fable billing', missing: 'Claude Code has not reported plan limits yet', noFable: 'Fable is excluded from routing.' })
export const PLAN_TYPE_CHOICES = Object.freeze([['auto', 'Auto'], ['api', 'API key (pay per token)'], ['subscription', 'Subscription (plan limits)']])
export const PLAN_TIER_CHOICES = Object.freeze([['unknown', 'Unknown'], ['pro', 'Pro'], ['max', 'Max'], ['team_standard', 'Team standard'], ['team_premium', 'Team premium'], ['enterprise', 'Enterprise']])
export const FABLE_BILLING_CHOICES = Object.freeze([['auto', 'Auto (from plan)'], ['plan_share', 'Plan share'], ['usage_credits', 'Usage credits']])
export function authKindLine(kind) {
  return LIMIT_SETTINGS_TEXT.auth + (kind === 'bearer' ? 'subscription' : kind === 'api-key' ? 'API key' : 'unknown')
}
export function receiptBillingTurn({ index, model, basis, estSavedUsd, estSavedWeeklyPct }) {
  const family = typeof model === 'string' ? /^claude-(haiku|sonnet|opus|fable|mythos)-/.exec(model)?.[1] : null
  const label = FAMILY_LABELS[family] || 'Unknown'
  const saved = basis === 'plan' ? (isNum(estSavedWeeklyPct) ? 'est. ~' + estSavedWeeklyPct + '% plan limit saved' : 'plan % · calibrating') :
    basis === 'dollars' ? (isNum(estSavedUsd) ? 'est. $' + estSavedUsd.toFixed(2) + ' saved (API prices)' : 'est. savings unavailable (API prices)') : 'billing basis unknown'
  return '#' + count(index) + ' · ' + label + ' · ' + saved
}
export function receiptBillingTotals({ planCalls, creditCalls, estSavedPlanWeeklyPct, estSavedCreditUsd, promptsSkippedNoUsage }) {
  return ['Plan calls: ' + count(planCalls), 'Credit calls: ' + count(creditCalls),
    isNum(estSavedPlanWeeklyPct) ? 'est. ~' + estSavedPlanWeeklyPct + '% of your weekly limit saved' : 'Weekly limit saved: calibrating',
    isNum(estSavedCreditUsd) ? 'est. $' + estSavedCreditUsd.toFixed(2) + ' saved on credit turns (API prices)' : 'Credit savings: est. unavailable',
    'Prompts skipped with no usage: ' + count(promptsSkippedNoUsage)]
}


export function stamp(ms) {
  if (!isNum(ms)) return '?'
  const d = new Date(ms)
  return MONTHS[d.getMonth()] + ' ' + d.getDate() + ' ' + two(d.getHours()) + ':' + two(d.getMinutes())
}




export const SAVINGS_NOTE = 'Est. savings compare the same token usage at your starting model with measured API-equivalent spend. Your actual subscription bill may differ.'

export function estimatedSavingsText(value, money = measuredDollars) {
  const amount = isNum(value) ? money(value).replace(/^-/, '') : 'n/a'
  return (isNum(value) && value < 0 && amount !== '$0.00' ? 'Est. extra cost ' : 'Est. saved ') + amount + ' (API-eq.)'
}


export function measuredDollars(value) {
  if (!isNum(value)) return 'n/a'
  const rounded = Math.round(value * 100) / 100
  return (rounded < 0 ? '-' : '') + '$' + Math.abs(rounded).toFixed(2)
}


export function measuredSpendLine(measured) {
  if (!measured || typeof measured !== 'object' || !Object.prototype.hasOwnProperty.call(measured, 'paid_usd')) return null
  const paid = measuredDollars(measured.paid_usd) + (isNum(measured.paid_usd) && measured.paid_complete === false ? '+' : '')
  const hourly = measuredPace(measured)
  const pace = hourly !== null ? SEP + '~' + measuredDollars(hourly) + '/hour' : ''
  return 'this session: ' + paid + ' spent so far' + pace
}


export function sendLine(measured) {
  return measuredSpendLine(measured)
}


export function answerLine(a) { return usd(a.usd) + SEP + plural(a.calls, 'call', 'calls') + ' (' + LABEL + ')' }



export function workingBand(b) {
  const prompt = b.promptMeasured
  const paid = prompt ? measuredDollars(prompt.paid_usd) : usd(b.spend)
  const floor = prompt ? isNum(prompt.paid_usd) && prompt.paid_complete === false ? '+' : '' : floorMark(b)
  let first = 'this prompt ' + paid + floor + ' so far (' + SHORT_LABEL + ')'
  const calls = plural(b.k, 'call', 'calls')
  const width = isNum(b.columns) && b.columns > 20 ? b.columns - 3 : 100

  if (first.length > width) first = first.split(SEP)[0]
  if (first.length > width) first = first.replace(' so far', '')
  const all = [first, calls].join(SEP)
  const session = measuredSpendLine(b.measured)
  return [all.length <= width ? all : first, ...(session ? [session] : [])]
}

export function subagentShare(dollars, calls) {
  return isNum(calls) && calls > 0 ? ' (subagents ' + usd(dollars) + ', ' + plural(calls, 'call', 'calls') + ')' : ''
}



export function promptParts(p) { return p ? { head: 'last prompt ' + usd(p.usd) + floorMark(p), calls: plural(p.calls, 'call', 'calls'), share: subagentShare(p.helper_usd, p.helper_calls), est: '' } : null }

export function promptResult(p) { return p ? 'last prompt ' + usd(p.usd) + floorMark(p) + SEP + plural(p.calls, 'call', 'calls') + subagentShare(p.helper_usd, p.helper_calls) : null }



export function floorMark(p) {
  return p && ((isNum(p.unpriced) && p.unpriced > 0) || (isNum(p.advisorUnpriced) && p.advisorUnpriced > 0)) ? '+' : ''
}




export function totalIsFloor(s) {
  return !!s && ((isNum(s.unpriced) && s.unpriced > 0) || (isNum(s.advisorUnpriced) && s.advisorUnpriced > 0) || s.resumed === true)
}


export function floorNotes(s) {
  const out = []
  if (s && isNum(s.advisorUnpriced) && s.advisorUnpriced > 0) out.push(plural(s.advisorUnpriced, 'advisor call', 'advisor calls') + (s.advisorUnpriced === 1 ? ' is' : ' are') + ' not in the total: Claude Code does not report what the advisor cost, so the total is at least what is shown.')
  if (s && isNum(s.unpriced) && s.unpriced > 0) out.push(plural(s.unpriced, 'call', 'calls') + ' could not be priced (a model with no price on the card), so the total is at least what is shown.')
  if (s && s.resumed === true) out.push('The total counts calls since IQ Code started in this session; what the session held before is not in it.')
  return out
}




export function sessionParts(s) {
  const out = { total: null, active: null, rate: null, limits: [] }
  const measured = s.measured
  const spent = measured ? measured.paid_usd : s.usd
  const floor = measured ? measured.paid_complete === false : totalIsFloor(s)
  const activeHours = measured ? measured.elapsed_ms / 3600000 : s.activeHours
  const pace = measured ? measuredPace(measured) : isNum(activeHours) && activeHours >= 0.05 && isNum(spent) ? spent / activeHours : null
  if (s.calls > 0) {
    out.total = 'session ' + (measured ? measuredDollars(spent) : usd(spent)) + (floor ? '+' : '') + ' (' + SHORT_LABEL + ')'
    if (isNum(activeHours) && activeHours >= 0.02) out.active = hours(activeHours) + ' active'
    if (isNum(activeHours) && activeHours >= 0.05 && isNum(pace)) out.rate = usd(pace) + (floor ? '+' : '') + '/h'
  }
  const limits = Array.isArray(s.rateLimits) ? s.rateLimits : []
  const five = limits.find((l) => l && l.kind === 'five_hour')
  const week = limits.find((l) => l && l.kind === 'seven_day')
  const wide = isNum(s.columns) && s.columns >= 130


  if (five && isNum(five.percentUsed)) {
    if (windowReset(five.resetsAt, s.nowMs).passed) out.limits.push('5-hour ' + WINDOW_RESET)
    else {
      const r = wide ? resetText(five.resetsAt, false) : ''
      out.limits.push('5-hour ' + percent(five.percentUsed) + (r ? ' (resets ' + r + ')' : ''))
    }
  }
  if (week && isNum(week.percentUsed)) {
    if (windowReset(week.resetsAt, s.nowMs).passed) out.limits.push('weekly ' + WINDOW_RESET)
    else {
      const r = resetText(week.resetsAt, true)
      out.limits.push('weekly ' + percent(week.percentUsed) + (r ? ' (resets ' + r + ')' : ''))
    }
  }
  return out
}



export function idleBand(s) {
  const p = sessionParts(s)
  const parts = [p.total, p.active, p.rate, ...p.limits].filter((t) => t !== null)
  const last = promptResult(s.lastPrompt)
  if (last) return [last, parts.join(SEP)].filter(Boolean)
  if (parts.length === 0) return []
  const all = parts.join(SEP)
  const width = isNum(s.columns) && s.columns > 20 ? s.columns - 3 : 100
  if (all.length <= width || parts.length < 3) return [all]
  const cut = Math.ceil(parts.length / 2)
  return [parts.slice(0, cut).join(SEP), parts.slice(cut).join(SEP)]
}




export const NOTICE = {
  tablesChanged: 'iq meter is off: its cost data is not the version it was built with. Reinstall the iq-code plugin to turn it back on.',
  dataMissing: 'iq meter is off: its cost data files could not be read. Reinstall the iq-code plugin to turn it back on.',
  quiet: 'iq meter paused for this session after repeated internal errors (see ~/.claude/iq/meter/errors.log).',
  notReady: 'iq meter is off: ',
}




function sparkline(values) {
  if (!Array.isArray(values) || values.length === 0) return ''
  const top = Math.max.apply(null, values.concat([1]))
  let out = ''
  for (const v of values) {
    const i = Math.min(BARS.length - 1, Math.max(0, Math.floor(((isNum(v) ? v : 0) / top) * (BARS.length - 1))))
    out += BARS[i]
  }
  return out
}

function pad(s, n) {
  s = String(s)
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

function padL(s, n) {
  s = String(s)
  return s.length >= n ? s : ' '.repeat(n - s.length) + s
}


export function paneModel(data, opts) { const t = data && data.totals || {}; return [{ style: 'title', text: 'Measured cost · API-equivalent dollars' }, { style: 'plain', text: usd(t.usd) + (t.unpriced_calls > 0 ? '+' : '') + SEP + plural(t.calls, 'call', 'calls') }, { style: 'dim', text: 'Measured calls since IQ Code started in this session.' }] }


export function paneNote(text) {
  return [
    { style: 'title', text: 'Cost read ' + SEP.trim() + ' ' + LABEL + ' dollars' },
    { style: 'plain', text },
  ]
}
