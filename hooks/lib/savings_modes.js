import { displayPercent } from './limit_savings.js'
import { resetText, creditSavingsLine, percent, windowReset, WINDOW_RESET } from './format.js'

export const LIMIT_EXPLANATION = "Limit savings describe the current reported window. Anthropic's limit weighting is not public, and activity in other sessions can affect this estimate."
export const REPORT_COVERAGE = 'Includes observed usage while routing and usage reporting are on. Earlier, offline or incomplete usage may be missing.'
export const FREE_SAVINGS = 'IQ Code routing requires Personal or higher · no routed calls'
const finite = (x) => typeof x === 'number' && Number.isFinite(x)
const dollars = (x) => '$' + (Object.is(x, -0) ? 0 : x).toFixed(2)

export function savingsModes(receipt, { planType = 'unknown', billingMode, creditBilledFamily = null, free = false, weeklyPct = null, fiveHourPct = null } = {}) {
  const r = receipt || {}
  const mode = billingMode === undefined ? planType : billingMode
  const credits = mode === 'extra_usage' || mode === 'cloud_credits'
  const saved = r.billingTotals ? mode === 'subscription' ? r.billingTotals.estSavedPlanUsd :
    mode === 'api' ? r.billingTotals.estSavedApiUsd : credits ? r.billingTotals.estSavedCreditUsd : null : r.savedUsd
  let activeLine
  let dollarLine = null
  let fiveHourLine = null
  const percentLine = (pct, window) => {
    const n = displayPercent(pct)
    return n === null ? (window === 'weekly' ? 'Weekly limit saved: calibrating' : '5-hour limit saved: calibrating') :
      n < 0 ? 'est. ~' + Math.abs(n) + '% extra ' + window + ' limit used' :
        'est. ~' + n + '% of your ' + window + ' limit saved'
  }
  if (free) activeLine = FREE_SAVINGS
  else if (!['api', 'subscription', 'extra_usage', 'cloud_credits'].includes(mode)) activeLine = 'Plan type: unknown · waiting for the first completed call'
  else if (!(r.eligibleCalls > 0) && !(r.routedCalls > 0)) activeLine = 'No routed calls this session · est. savings unavailable'
  else if (!finite(saved)) activeLine = 'Est. savings unavailable · usage incomplete'
  else if (mode === 'api' || mode === 'cloud_credits') activeLine = 'est. ' + dollars(saved) + ' saved (API prices) · API-equivalent'
  else if (mode === 'extra_usage') activeLine = creditSavingsLine(saved, creditBilledFamily !== 'fable')
  else {
    activeLine = percentLine(weeklyPct, 'weekly')
    dollarLine = 'est. ' + dollars(saved) + ' saved (API-equivalent)'
  }
  if (mode === 'subscription' && !free) fiveHourLine = r.eligibleCalls > 0 && finite(saved) ? percentLine(fiveHourPct, '5-hour') : activeLine
  else if (credits && planType === 'subscription' && !free && finite(weeklyPct)) {
    dollarLine = percentLine(weeklyPct, 'weekly')
    fiveHourLine = percentLine(fiveHourPct, '5-hour')
  }
  return { activeLine, dollarLine, fiveHourLine, explanation: planType === 'subscription' && !free ? LIMIT_EXPLANATION : null }
}



export function savingsPlanRows(rateLimits, planType, nowMs) {
  if (planType !== 'subscription') return []
  const labels = { five_hour: '5-hour', seven_day: 'Weekly', seven_day_opus: 'Opus weekly', seven_day_sonnet: 'Sonnet weekly' }
  const rows = []
  for (const kind of Object.keys(labels)) {
    const found = (Array.isArray(rateLimits) ? rateLimits : []).filter((r) => r && r.kind === kind)
    if (found.length !== 1 || !finite(found[0].percentUsed) || found[0].percentUsed < 0 || found[0].percentUsed > 100) continue
    if (windowReset(found[0].resetsAt, nowMs).passed) { rows.push(labels[kind] + ': ' + WINDOW_RESET); continue }
    const reset = resetText(found[0].resetsAt, true)
    rows.push(labels[kind] + ': ' + percent(found[0].percentUsed) + ' used · ' + (reset ? 'resets ' + reset : 'reset time unavailable'))
  }
  return rows
}
