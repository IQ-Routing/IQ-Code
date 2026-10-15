import { creditSavingsLine } from './format.js'



const MODEL_LABELS = Object.freeze({
  'claude-fable-5': 'Fable 5',
  'claude-fable-5-1': 'Fable 5.1',
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-haiku-5-5': 'Haiku 5.5',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-opus-5': 'Opus 5',
  'claude-opus-5-5': 'Opus 5.5',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  unknown: 'Unknown',
})
const UNKNOWN_LINE = 'Plan type: unknown · waiting for the first completed call'
const NO_CALLS_LINE = 'No routed calls this session · est. savings unavailable'
const INCOMPLETE_LINE = 'Est. savings unavailable · usage incomplete'
const FREE_LINE = 'IQ Code routing requires Personal or higher · no routed calls'
const PENDING_WEEKLY_LINE = 'Weekly limit saved: calibrating'
export const RECEIPT_EXPLANATION = "Limit savings describe the current reported window. Anthropic's limit weighting is not public, and activity in other sessions can affect this estimate."

function closedModel(value) {
  if (typeof value !== 'string') return 'unknown'

  const alias = value.startsWith('anthropic/') ? value.slice(10) : value
  const id = alias === 'claude-haiku-4-5-20251001' ? 'claude-haiku-4-5' : alias
  return Object.hasOwn(MODEL_LABELS, id) ? id : 'unknown'
}

const money = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0
const BILLING_MODES = Object.freeze(['api', 'subscription', 'extra_usage', 'cloud_credits', 'unknown'])
const creditMode = (mode) => mode === 'extra_usage' || mode === 'cloud_credits'



function roundedMoney(value) {
  if (!Number.isFinite(value)) return null
  const negative = value < 0
  const [mantissa, exponent = '0'] = Math.abs(value).toString().split('e')
  const [whole, fraction = ''] = mantissa.split('.')
  const digits = BigInt(whole + fraction)
  const power = Number(exponent) - fraction.length + 6
  let micros
  if (power >= 0) micros = digits * 10n ** BigInt(power)
  else {
    const divisor = 10n ** BigInt(-power)
    micros = digits / divisor
    const twiceRemainder = (digits % divisor) * 2n
    if (twiceRemainder > divisor || (twiceRemainder === divisor && micros % 2n !== 0n)) micros += 1n
  }
  const result = Number(micros) / 1e6 * (negative ? -1 : 1)
  return Number.isFinite(result) ? (Object.is(result, -0) ? 0 : result) : null
}

export function newReceipt() {
  let routedCalls = 0
  let keptCalls = 0
  let eligibleCalls = 0
  let actual = 0
  let named = 0
  let observed = 0
  let observedPricedCalls = 0
  let actualComplete = true
  let namedComplete = true
  let complete = true
  const models = new Map()
  const billingTurns = []
  const billing = new Map()
  let skippedNoUsage = 0

  function billingSnapshot({ weeklyWindow = null, weeklyCapacityUsd = null, estSavedPlanWeeklyPct = null, weeklyCapacities = null } = {}) {
    const total = (mode) => billing.get(mode)?.calls || 0
    const savedFor = (mode) => {
      const row = billing.get(mode)
      return row && row.eligibleCalls > 0 && row.known ? roundedMoney(row.saved) : null
    }
    const credits = [...billing.entries()].filter(([mode]) => creditMode(mode)).map(([, row]) => row)
    const creditCalls = credits.reduce((n, row) => n + row.calls, 0)
    const eligibleCredits = credits.reduce((n, row) => n + row.eligibleCalls, 0)
    return {
      turns: billingTurns.map((row) => {
        const capacity = weeklyCapacities?.get(row.weeklyWindow) ?? (row.weeklyWindow === weeklyWindow ? weeklyCapacityUsd : null)
        return { index: row.index, model: row.model, billingMode: row.billingMode,
        basis: row.billingMode === 'subscription' ? 'plan' : row.billingMode === 'api' || creditMode(row.billingMode) ? 'dollars' : 'unknown',
        estSavedUsd: row.known ? roundedMoney(row.saved) : null,
        estSavedWeeklyPct: row.billingMode === 'subscription' && row.known && money(capacity) > 0 ?
          Math.sign(row.saved) * Math.min(100, Math.round(Math.abs(100 * row.saved / capacity))) || 0 : null }
      }),
      totals: { planCalls: total('subscription'), creditCalls, apiCalls: total('api'), unknownCalls: total('unknown'),
        estSavedPlanWeeklyPct: typeof estSavedPlanWeeklyPct === 'number' && Number.isFinite(estSavedPlanWeeklyPct) ? estSavedPlanWeeklyPct : null,
        estSavedPlanUsd: savedFor('subscription'), estSavedApiUsd: savedFor('api'),
        estSavedCreditUsd: eligibleCredits > 0 && credits.every((row) => row.known) ? roundedMoney(credits.reduce((n, row) => n + row.saved, 0)) : null,
        promptsSkippedNoUsage: skippedNoUsage },
    }
  }

  function snapshot() {
    return {
      routedCalls,
      keptCalls,
      eligibleCalls,
      actualUsd: eligibleCalls > 0 && actualComplete ? roundedMoney(actual) : null,
      namedUsd: eligibleCalls > 0 && namedComplete ? roundedMoney(named) : null,
      savedUsd: eligibleCalls > 0 && actualComplete && namedComplete ? roundedMoney(named - actual) : null,
      totalObservedUsd: models.size === 0 || observedPricedCalls > 0 ? roundedMoney(observed) : null,
      complete,
      modelMix: [...models.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([model, calls]) => ({ model, calls })),
    }
  }

  function observe(observation = {}) {
    if (!observation || typeof observation !== 'object' || observation.completed === false) return snapshot()
    const model = closedModel(observation.model)
    const known = model !== 'unknown'
    const actualUsd = known ? money(observation.actualUsd) : null
    const namedUsd = money(observation.namedUsd)
    const covered = known && observation.complete === true && actualUsd !== null
    models.set(model, (models.get(model) || 0) + 1)
    if (observation.decision === 'routed') routedCalls += 1
    if (observation.decision === 'kept') keptCalls += 1
    if (actualUsd !== null) {
      observed += actualUsd
      observedPricedCalls += 1
    }
    if (!covered) complete = false
    if (observation.eligible === true) {
      eligibleCalls += 1
      if (covered) actual += actualUsd
      else actualComplete = false
      if (observation.complete === true && known && namedUsd !== null) named += namedUsd
      else namedComplete = false
      if (namedUsd === null) complete = false
    }
    if (Object.hasOwn(observation, 'billingMode')) {
      const mode = BILLING_MODES.includes(observation.billingMode) ? observation.billingMode : 'unknown'
      let row = billing.get(mode)
      if (!row) { row = { calls: 0, eligibleCalls: 0, saved: 0, known: true }; billing.set(mode, row) }
      row.calls += 1
      const eligible = observation.eligible === true
      const savedKnown = mode !== 'unknown' && (!eligible || covered && namedUsd !== null)
      const saved = eligible && savedKnown ? namedUsd - actualUsd : 0
      if (eligible) row.eligibleCalls += 1
      row.saved += saved; row.known = row.known && savedKnown && Number.isFinite(row.saved)

      billingTurns.push({ index: count(observation.index) || billingTurns.length + 1, model, billingMode: mode,
        saved, known: savedKnown, weeklyWindow: typeof observation.weeklyWindow === 'number' && Number.isFinite(observation.weeklyWindow) ? observation.weeklyWindow : null,
        fiveHourWindow: typeof observation.fiveHourWindow === 'number' && Number.isFinite(observation.fiveHourWindow) ? observation.fiveHourWindow : null })
    }
    if (!Number.isFinite(observed) || !Number.isFinite(actual) || !Number.isFinite(named)) complete = false
    return snapshot()
  }

  return { observe, snapshot, billingSnapshot,
    planWindowSaving(kind, epoch) {
      const key = kind === 'five_hour' ? 'fiveHourWindow' : 'weeklyWindow'
      const rows = billingTurns.filter((row) => row.billingMode === 'subscription' && row[key] === epoch)
      return { savedUsd: roundedMoney(rows.reduce((n, row) => n + row.saved, 0)), complete: rows.every((row) => row.known) }
    },
    skipNoUsage() { skippedNoUsage += 1; return skippedNoUsage } }
}

const apiLine = /^est\. \$-?(?:0|[1-9]\d*)\.\d{2} saved \(API prices\) · API-equivalent$/
const dollarLine = /^est\. \$-?(?:0|[1-9]\d*)\.\d{2} saved \(API-equivalent\)$/
const weeklyLine = /^est\. ~(?:0|[1-9]\d*)% (?:of your weekly limit saved|extra weekly limit used)$/

function activeLine(receipt, options) {
  if (options.free === true) return FREE_LINE
  const mode = options.billingMode === undefined ? options.planType : options.billingMode
  const credits = creditMode(mode)
  if (!['api', 'subscription', 'extra_usage', 'cloud_credits'].includes(mode)) return UNKNOWN_LINE
  if (count(receipt.routedCalls) === 0 && count(receipt.eligibleCalls) === 0) return NO_CALLS_LINE
  const saved = receipt.billingTotals ? mode === 'subscription' ? receipt.billingTotals.estSavedPlanUsd :
    mode === 'api' ? receipt.billingTotals.estSavedApiUsd : credits ? receipt.billingTotals.estSavedCreditUsd : null : receipt.savedUsd
  if (typeof saved !== 'number' || !Number.isFinite(saved)) return INCOMPLETE_LINE
  const candidate = options.activeLine
  if (mode === 'subscription') return typeof candidate === 'string' && weeklyLine.test(candidate) ? candidate : PENDING_WEEKLY_LINE
  if (mode === 'extra_usage') return creditSavingsLine(saved, options.creditBilledFamily !== 'fable')
  return typeof candidate === 'string' && apiLine.test(candidate) ? candidate : `est. $${saved.toFixed(2)} saved (API prices) · API-equivalent`
}

function observedLine(value) {
  return money(value) === null ? 'Observed: unavailable · usage incomplete' : `Observed: est. $${value.toFixed(2)} (API-equivalent)`
}

export function receiptText(receipt = {}, options = {}) {
  const free = options.free === true
  const mix = new Map()
  if (Array.isArray(receipt.modelMix)) {
    for (const row of receipt.modelMix) {
      if (!row || typeof row !== 'object' || count(row.calls) === 0) continue
      const model = closedModel(row.model)
      mix.set(model, (mix.get(model) || 0) + count(row.calls))
    }
  }
  const lines = [
    'IQ Code savings receipt',
    `Routed calls: ${free ? 0 : count(receipt.routedCalls)}`,
    `Calls kept: ${free ? 0 : count(receipt.keptCalls)}`,
    `Model mix: ${[...mix.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([model, calls]) => `${MODEL_LABELS[model]} ${calls} calls`).join('; ') || 'none'}`,
    activeLine(receipt, options),
  ]
  if (!free && options.planType === 'subscription') {
    const credits = creditMode(options.billingMode)
    if (credits && typeof options.dollarLine === 'string' && weeklyLine.test(options.dollarLine)) lines.push(options.dollarLine)
    if (typeof receipt.savedUsd === 'number' && Number.isFinite(receipt.savedUsd)) {
      const candidate = options.dollarLine
      lines.push(typeof candidate === 'string' && dollarLine.test(candidate) ? candidate : `est. $${receipt.savedUsd.toFixed(2)} saved (API-equivalent)`)
    }
    lines.push(RECEIPT_EXPLANATION)
  }
  const eligible = !free && count(receipt.eligibleCalls) > 0
  lines.push(observedLine(eligible ? receipt.actualUsd : receipt.totalObservedUsd))
  if (!free) {
    lines.push(!eligible ? 'Without routing: unavailable · no routed calls' : money(receipt.namedUsd) === null ? 'Without routing: unavailable · usage incomplete' : `Without routing: est. $${receipt.namedUsd.toFixed(2)} (API-equivalent)`)
  }
  lines.push(`Coverage: ${receipt.complete === true ? 'complete' : 'incomplete'}`)
  return lines.join('\n')
}
