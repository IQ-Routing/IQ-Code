import { newPlanType } from './plan_type.js'
import { newLimitSavings } from './limit_savings.js'
import { newReceipt } from './receipt.js'
import { normalizeReportModel, REPORT_BILLING_MODES } from './usage_report.js'



const integer = (x) => Number.isSafeInteger(x) && x >= 0
const finite = (x) => typeof x === 'number' && Number.isFinite(x)
const creditMode = (mode) => mode === 'extra_usage' || mode === 'cloud_credits'
const validMode = (mode) => REPORT_BILLING_MODES.includes(mode)
const familyCount = (n) => integer(n) && n <= 5 ? n : 0

export function newUsageSession(report = null) {
  const detector = newPlanType()
  const limits = newLimitSavings()
  const receipt = newReceipt()
  const pending = new Map()
  let reportingEpoch = 0
  let fableUnknown = false
  let activeBillingMode = 'unknown'
  let lastTurnBillingMode = null
  let activeCreditBilledFamily = null
  let explicitBillingMode = false
  let nextPromptIndex = 0
  let latestAt = null
  const deferredSkips = new Map()
  const weeklyCapacities = new Map()
  const lastPlanWindows = new Map()
  let lastRows = []

  function rememberPlan(nowMs) {
    if (activeBillingMode !== 'subscription') return
    const snapshot = limits.snapshot(nowMs)
    for (const kind of ['five_hour', 'seven_day']) {
      const matches = lastRows.filter((row) => row && row.kind === kind)
      const expiresAt = matches.length === 1 && typeof matches[0].resetsAt === 'string' ? Date.parse(matches[0].resetsAt) : null
      lastPlanWindows.set(kind, { ...snapshot[kind], expiresAt: finite(expiresAt) ? expiresAt : null })
      if (kind === 'seven_day' && finite(snapshot[kind].capacityUsd) && snapshot[kind].capacityUsd > 0) weeklyCapacities.set(snapshot[kind].epoch, snapshot[kind].capacityUsd)
    }
  }

  function reading(rateLimits, nowMs, setting = 'auto', { billingMode, creditBilledFamily = null } = {}) {
    if (finite(nowMs)) latestAt = nowMs
    rememberPlan(nowMs)
    detector.override(setting)
    const d = detector.reading(rateLimits)
    explicitBillingMode = billingMode !== undefined
    activeBillingMode = explicitBillingMode ? validMode(billingMode) ? billingMode : 'unknown' : d.planType
    activeCreditBilledFamily = creditMode(activeBillingMode) && creditBilledFamily === 'fable' ? 'fable' : null
    limits.reading(rateLimits, nowMs, activeBillingMode)
    lastRows = (Array.isArray(rateLimits) ? rateLimits : []).map((row) => ({ kind: row?.kind, resetsAt: row?.resetsAt }))
    rememberPlan(nowMs)
    const w = limits.snapshot().seven_day
    if (report) report.setWeekly({ window: w.epoch, capacityUsd: w.capacityUsd })
    return d
  }
  function stage({ rec = null, changed = false, model, usage, price, pricing = null, at, reportEligible = false, rateLimits, setting = 'auto', helperDecision = 'none', helperEligible = false, billingMode: suppliedMode, familiesExhaustedCount = 0, creditBilledFamily = null }) {
    if (finite(at)) latestAt = at
    expire(at)
    rememberPlan(at)
    detector.override(setting)
    detector.completed(rateLimits)
    const d = detector.view()
    const normalized = normalizeReportModel(model)
    const u = usage || {}
    const complete = normalized !== 'unknown' && !!price && price.priced === true &&
      ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].every((k) => integer(u[k]))
    const tokens = {
      inputTokens: integer(u.input_tokens) ? u.input_tokens : 0,
      outputTokens: integer(u.output_tokens) ? u.output_tokens : 0,
      cacheReadTokens: integer(u.cache_read_input_tokens) ? u.cache_read_input_tokens : 0,
      cacheWriteTokens: integer(u.cache_creation_input_tokens) ? u.cache_creation_input_tokens : 0,
    }
    const actualUsd = normalized !== 'unknown' && price && price.priced && finite(price.usd) ? price.usd : null
    
    const modeKnown = suppliedMode !== undefined || explicitBillingMode
    const unknownFable = !modeKnown && d.planType === 'subscription' && normalized.startsWith('claude-fable-')
    const billingMode = suppliedMode !== undefined ? validMode(suppliedMode) ? suppliedMode : 'unknown' :
      explicitBillingMode ? activeBillingMode : unknownFable ? 'unknown' : d.planType
    if (normalized.startsWith('claude-fable-')) fableUnknown = billingMode === 'unknown'
    activeBillingMode = billingMode
    lastTurnBillingMode = billingMode
    activeCreditBilledFamily = creditMode(billingMode) && (creditBilledFamily === 'fable' || normalized.startsWith('claude-fable-')) ? 'fable' : null
    
    if (billingMode === 'subscription' || billingMode === 'api') d.planType = billingMode
    const tags = limits.observe({ actualUsd, complete, billingMode })
    const fact = { model: normalized, actualUsd, complete, tokens, pricing, changed, detector: d,
      at, reportEligible, reportEpoch: reportingEpoch, tags, billingMode, helperDecision,
      familiesExhaustedCount: familyCount(familiesExhaustedCount) }
    if (rec) {
      const list = pending.get(rec) || []
      list.push(fact); pending.set(rec, list)
    } else commit(fact, helperEligible, true, null, ++nextPromptIndex)
    return complete
  }
  function commit(f, eligible, promptPriced, phase = null, index = ++nextPromptIndex) {
    const namedUsd = eligible && promptPriced && f.complete && f.billingMode !== 'unknown' && f.pricing && finite(f.pricing.namedUsd) ? f.pricing.namedUsd : null
    const decision = f.changed ? 'routed' : phase === 'kept' ? 'kept' : f.helperDecision
    receipt.observe({ model: f.model, actualUsd: f.actualUsd, complete: f.complete,
      decision, eligible, namedUsd, billingMode: f.billingMode, index,
      weeklyWindow: f.billingMode === 'subscription' ? f.tags.seven_day : null,
      fiveHourWindow: f.billingMode === 'subscription' ? f.tags.five_hour : null })
    const savedUsd = eligible ? (namedUsd !== null && finite(f.actualUsd) ? namedUsd - f.actualUsd : null) : 0
    if (eligible) limits.saving({ savedUsd, tags: f.tags, billingMode: f.billingMode })
    rememberPlan(f.at)
    if (report && f.reportEligible && f.reportEpoch === reportingEpoch) {
      flushSkips()
      const w = limits.snapshot().seven_day
      void report.observe({ planType: f.detector.planType, overridden: f.detector.overridden,
        model: f.model, actualUsd: f.actualUsd, savedUsd: f.complete ? savedUsd : null,
        ...f.tokens, complete: f.complete, routed: decision === 'routed', completedAt: f.at,
        weeklyWindow: f.billingMode === 'subscription' ? f.tags.seven_day : null,
        weeklyCapacityUsd: f.billingMode === 'subscription' && f.tags.seven_day === w.epoch ? w.capacityUsd : null,
        billingMode: f.billingMode, planCalls: f.billingMode === 'subscription' ? 1 : 0,
        creditCalls: creditMode(f.billingMode) ? 1 : 0, promptsSkippedNoUsage: 0,
        familiesExhaustedCount: f.familiesExhaustedCount,
        estSavedCreditUsd: creditMode(f.billingMode) && f.complete ? savedUsd : null })
    }
  }
  function finalize(rec) {
    const facts = pending.get(rec) || []
    pending.delete(rec)
    const eligible = rec.userOverride !== true && !!(rec.routed || rec.touched)
    const promptPriced = rec.priced === true && facts.every((f) => f.complete && f.pricing && finite(f.pricing.actualUsd) && finite(f.pricing.namedUsd) && f.billingMode !== 'unknown')
    const index = facts.length ? ++nextPromptIndex : nextPromptIndex
    for (const f of facts) commit(rec.userOverride ? { ...f, changed: false } : f, eligible, promptPriced, rec.userOverride ? 'kept' : rec.phase, index)
  }
  function skipNoUsage({ at, billingMode = activeBillingMode, familiesExhaustedCount = 0, reportEligible = false, setting = 'auto' } = {}) {
    receipt.skipNoUsage()
    
    
    if (!report || !reportEligible || !finite(at)) return
    const mode = billingMode === 'subscription' ? 'subscription' : 'unknown'
    detector.override(setting)
    const d = detector.view()
    const day = new Date(at).toISOString().slice(0, 10)
    const identity = day + ':' + d.planType + ':' + (d.overridden ? 1 : 0) + ':' + mode
    const prior = deferredSkips.get(identity)
    if (prior) {
      prior.promptsSkippedNoUsage += 1
      prior.familiesExhaustedCount = Math.max(prior.familiesExhaustedCount, familyCount(familiesExhaustedCount))
      prior.completedAt = at
      return
    }
    if (deferredSkips.size >= 8) return
    deferredSkips.set(identity, { planType: mode === 'subscription' ? 'subscription' : d.planType, overridden: d.overridden,
      model: 'unknown', actualUsd: null, savedUsd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      complete: false, routed: false, completedAt: at, calls: 0, billingMode: mode, planCalls: 0, creditCalls: 0,
      promptsSkippedNoUsage: 1, familiesExhaustedCount: familyCount(familiesExhaustedCount), estSavedCreditUsd: null })
  }
  function flushSkips() {
    const facts = [...deferredSkips.values()]
    deferredSkips.clear()
    for (const fact of facts) void report.observe(fact)
  }
  function invalidateReporting() {
    reportingEpoch += 1
    deferredSkips.clear()
    if (report) report.invalidate()
  }
  function expire(nowMs) {
    const snapshot = limits.snapshot(nowMs)
    if (report) report.setWeekly({ window: snapshot.seven_day.epoch, capacityUsd: snapshot.seven_day.capacityUsd })
    return snapshot
  }
  return { reading, stage, finalize, skipNoUsage, invalidateReporting, expire,
    view(setting = 'auto', nowMs = null) {
      detector.override(setting)
      const viewAt = finite(nowMs) ? nowMs : latestAt
      const snapshot = limits.snapshot(viewAt)
      rememberPlan(viewAt)
      
      
      if (creditMode(activeBillingMode) && finite(viewAt)) for (const kind of ['five_hour', 'seven_day']) {
        const prior = lastPlanWindows.get(kind)
        if (!prior || !finite(prior.expiresAt) || prior.expiresAt <= viewAt) continue
        const saved = receipt.planWindowSaving(kind, prior.epoch)
        const capacity = prior.capacityUsd
        snapshot[kind] = { epoch: prior.epoch, capacityUsd: capacity, savedUsd: saved.savedUsd,
          percent: saved.complete && finite(capacity) && capacity > 0 ? Math.sign(saved.savedUsd) * Math.min(100, Math.abs(100 * saved.savedUsd / capacity)) || 0 : null }
      }
      const d = detector.view()
      if (activeBillingMode === 'subscription' || activeBillingMode === 'api') d.planType = activeBillingMode
      const billingReceipt = receipt.billingSnapshot({ weeklyWindow: snapshot.seven_day.epoch,
        weeklyCapacityUsd: snapshot.seven_day.capacityUsd, estSavedPlanWeeklyPct: snapshot.seven_day.percent, weeklyCapacities })
      return { ...d, billingMode: activeBillingMode, lastTurnBillingMode, creditBilledFamily: activeCreditBilledFamily,
        receipt: { ...receipt.snapshot(), billingTotals: billingReceipt.totals }, limits: snapshot, fableUnknown, billingReceipt }
    },
    end() { for (const rec of [...pending.keys()]) finalize(rec) },
  }
}
