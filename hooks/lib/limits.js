

import { windowReset } from './format.js'

export const LIMIT_KINDS = Object.freeze([
  'five_hour', 'seven_day', 'spend_limit', 'seven_day_opus', 'seven_day_sonnet',
  'seven_day_overage_included', 'overage',
])
export const BILLING_MODES = Object.freeze(['api', 'subscription', 'extra_usage', 'cloud_credits', 'unknown'])
export const PLAN_TIERS = Object.freeze(['pro', 'max', 'team_standard', 'team_premium', 'enterprise', 'unknown'])
export const MODEL_FAMILIES = Object.freeze(['haiku', 'sonnet', 'opus', 'fable', 'mythos'])
const SHARED_KINDS = ['five_hour', 'seven_day', 'spend_limit']
const PLAN_KINDS = ['five_hour', 'seven_day']
const MAX_SIGNAL_AGE = 604800
const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const own = (value, key) => value !== null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key)

export function modelFamily(model) {
  if (typeof model !== 'string') return null
  const id = model.trim().toLowerCase().split('/').pop().split('[')[0]
  const found = /^(?:claude-)?(haiku|sonnet|opus|fable|mythos)(?:-|$)/.exec(id)
  return found ? found[1] : null
}

function epochSeconds(value) {
  if (value === undefined || value === null || value === '') return null
  if (finite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) return Math.floor(value)
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return finite(parsed) && parsed >= 0 ? Math.floor(parsed / 1000) : undefined
}

function normalizeRow(row) {
  if (!row || typeof row !== 'object' || !LIMIT_KINDS.includes(row.kind)) return null
  const percent = own(row, 'percentUsed') ? row.percentUsed : row.percent_used
  if (!finite(percent) || percent < 0) return null
  const reset = epochSeconds(own(row, 'resetsAt') ? row.resetsAt : row.resets_at)
  if (reset === undefined) return null
  return { kind: row.kind, percent_used: Math.min(999.9, Math.round(percent * 10) / 10), resets_at: reset }
}


export const resetPassed = (resetsAtSeconds, nowMs) => windowReset(resetsAtSeconds * 1000, nowMs).passed

function combinedRows(rateLimits, persistedRows, nowMs) {
  const combined = new Map()
  let expired = false

  for (const raw of Array.isArray(persistedRows) ? persistedRows : []) {
    const row = normalizeRow(raw)
    if (!row || row.resets_at === null) continue
    if (resetPassed(row.resets_at, nowMs)) { expired = true; continue }
    combined.set(row.kind, row)
  }
  for (const raw of Array.isArray(rateLimits) ? rateLimits : []) {
    const row = normalizeRow(raw)
    if (!row) continue

    combined.delete(row.kind)
    if (row.resets_at !== null && resetPassed(row.resets_at, nowMs)) { expired = true; continue }
    combined.set(row.kind, row)
  }
  return {
    rows: LIMIT_KINDS.map((kind) => combined.get(kind)).filter(Boolean).slice(0, 8),
    expired,
  }
}

function explicitMode(planType, settings) {
  if (['api', 'subscription'].includes(settings.planType)) return settings.planType

  if (typeof planType === 'string' && BILLING_MODES.includes(planType)) return planType
  if (!planType || typeof planType !== 'object') return null
  if (['api', 'subscription'].includes(planType.setting)) return planType.setting
  if (planType.overridden === true && ['api', 'subscription'].includes(planType.planType)) return planType.planType
  return null
}

function detectedMode({ authKind, apiKeyPresent, planType, settings, rows, expired }) {
  const explicit = explicitMode(planType, settings)
  if (explicit !== null) return explicit
  if (apiKeyPresent === true || authKind === 'api-key') return 'api'

  if (authKind === null) return 'unknown'
  if (authKind === 'bearer') return rows.length === 0 && expired ? 'unknown' : 'subscription'
  const detected = planType && typeof planType === 'object' ? planType.planType : null
  if (['api', 'subscription'].includes(detected)) return detected
  return rows.length > 0 ? 'subscription' : 'unknown'
}

function familyStateActive(state, nowMs) {
  if (!state || typeof state !== 'object') return null
  const family = MODEL_FAMILIES.includes(state.family) ? state.family : modelFamily(state.model)
  if (family === null) return null
  let reset = epochSeconds(own(state, 'resets_at') ? state.resets_at : state.resetsAt)
  if (own(state, 'untilMs')) reset = finite(state.untilMs) && state.untilMs >= 0 ? Math.floor(state.untilMs / 1000) : undefined
  return reset !== undefined && (reset === null || !resetPassed(reset, nowMs)) ? { family, exhausted: state.exhausted !== false } : null
}

/** Rebuild every prompt from the latest host answer and persisted active windows.
 * `extraUsage` is true only after the lifecycle observes a successful main step
 * past an already reported shared 100% window. Neither a 5-minute cache nor an
 * arbitrary host field proves credits; a lower reading/reset ends that inference.
 * Missing reset at 100% is conservatively paused until restored limit/auth facts.
 */
export function limitsFacts({
  rateLimits, persistedRows = [], authKind, apiKeyPresent = false, planType,
  settings = {}, nowMs = 0, signalAtMs, extraUsage = false, familyStates = [],
} = {}) {
  const now = finite(nowMs) && nowMs >= 0 ? nowMs : 0
  const options = settings && typeof settings === 'object' ? settings : {}
  const { rows: normalized, expired } = combinedRows(rateLimits, persistedRows, now)
  let billing_mode = detectedMode({ authKind, apiKeyPresent, planType, settings: options, rows: normalized, expired })


  const boundedOverPlan = normalized.some((row) => PLAN_KINDS.includes(row.kind) && row.percent_used >= 100 && row.resets_at !== null)
  if (billing_mode === 'subscription' && extraUsage === true && boundedOverPlan) billing_mode = 'extra_usage'
  const rows = billing_mode === 'api' ? [] : normalized
  const blocked = rows.filter((row) => row.percent_used >= 100 &&
    (billing_mode === 'subscription' ? SHARED_KINDS.includes(row.kind) : ['unknown', 'extra_usage'].includes(billing_mode) && row.kind === 'spend_limit'))
  const exhausted = new Set()
  if (billing_mode !== 'api') {
    for (const row of rows) {
      if (row.percent_used >= 100 && ['seven_day_opus', 'seven_day_sonnet'].includes(row.kind)) exhausted.add(row.kind.slice('seven_day_'.length))
    }
    for (const state of Array.isArray(familyStates) ? familyStates : []) {
      const active = familyStateActive(state, now)
      if (active !== null) {
        if (active.exhausted) exhausted.add(active.family)
        else exhausted.delete(active.family)
      }
    }
  }
  const plan_tier = PLAN_TIERS.includes(options.planTier) ? options.planTier : 'unknown'
  const fableBilling = options.fableBilling
  const fableCredits = ['usage_credits', 'credits'].includes(fableBilling) ||
    !['plan_share', 'plan'].includes(fableBilling) && ['pro', 'team_standard'].includes(plan_tier)
  return {
    rows,
    billing_mode,
    exhausted_families: MODEL_FAMILIES.filter((family) => exhausted.has(family)),
    credit_billed_families: billing_mode === 'subscription' && fableCredits ? ['fable'] : [],
    all_exhausted: blocked.length > 0,
    next_reset: blocked.length === 0 || blocked.some((row) => row.resets_at === null) ? null : Math.max(...blocked.map((row) => row.resets_at)),
    signal_age_s: finite(signalAtMs) ? Math.min(MAX_SIGNAL_AGE, Math.max(0, Math.floor((now - signalAtMs) / 1000))) : MAX_SIGNAL_AGE,
    plan_tier,
    allow_fable: options.allowFable === true,
  }
}


export function limitsBlock(facts) {
  if (!facts || !BILLING_MODES.includes(facts.billing_mode)) return null
  const windows = []
  const kinds = new Set()
  for (const raw of Array.isArray(facts.rows) ? facts.rows : []) {
    const row = normalizeRow(raw)
    if (!row || kinds.has(row.kind)) continue
    kinds.add(row.kind)
    windows.push(row)
    if (windows.length === 8) break
  }
  const families = (value) => MODEL_FAMILIES.filter((family) => Array.isArray(value) && value.includes(family))
  return {
    billing_mode: facts.billing_mode,
    plan_tier: PLAN_TIERS.includes(facts.plan_tier) ? facts.plan_tier : 'unknown',
    windows: facts.billing_mode === 'api' ? [] : windows,
    exhausted_families: families(facts.exhausted_families),
    credit_billed_families: families(facts.credit_billed_families),
    signal_age_s: finite(facts.signal_age_s) ? Math.min(MAX_SIGNAL_AGE, Math.max(0, Math.floor(facts.signal_age_s))) : MAX_SIGNAL_AGE,
    allow_fable: facts.allow_fable === true,
  }
}

export function turnBillingMode(facts, model) {
  const mode = facts && BILLING_MODES.includes(facts.billing_mode) ? facts.billing_mode : 'unknown'
  return mode === 'subscription' && Array.isArray(facts.credit_billed_families) && facts.credit_billed_families.includes(modelFamily(model)) ? 'extra_usage' : mode
}
