import { limitsFacts, modelFamily, resetPassed } from './limits.js'

const PLAN_KINDS = ['five_hour', 'seven_day']
const SHARED_KINDS = [...PLAN_KINDS, 'spend_limit']
const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const familyKind = (kind) => ['seven_day_opus', 'seven_day_sonnet'].includes(kind) ? kind.slice('seven_day_'.length) : null
const planBlocked = (rows) => rows.some((r) => PLAN_KINDS.includes(r.kind) && r.percent_used >= 100 && r.resets_at !== null)
const activeFamily = (state, nowMs) => state && (state.resets_at === null || finite(state.resets_at) && !resetPassed(state.resets_at, nowMs))




export function newLimitState(saved = {}) {
  let rows = limitsFacts({ persistedRows: saved.rows, authKind: 'bearer' }).rows
  let signalAtMs = finite(saved.signalAtMs) ? saved.signalAtMs : null
  let exhaustionAtMs = finite(saved.exhaustionAtMs) ? saved.exhaustionAtMs : signalAtMs
  let extraUsage = saved.extraUsage === true
  let families = Array.isArray(saved.familyStates) ? saved.familyStates.slice() : []
  
  
  const familyFailures = new Set(families.filter((state) => state?.exhausted === true).map((state) => state.family))
  let authKind
  let apiKeyPresent = false
  let settings = {}
  let completed = false
  let gatewayPause = false
  let gatewayResetAt = null
  let lastHostRows = rows.slice()
  let noted = null
  let current = null
  const fallback = () => ({ planType: completed && rows.length === 0 ? 'api' : 'unknown', overridden: false, setting: 'auto' })
  function clearGatewayPause() { gatewayPause = false; gatewayResetAt = null }
  
  
  
  function pauseGateway(nowMs) {
    gatewayPause = true
    const open = rows.filter((r) => SHARED_KINDS.includes(r.kind) && r.resets_at !== null && !resetPassed(r.resets_at, nowMs))
    const full = open.filter((r) => r.percent_used >= 100)
    const resets = (full.length > 0 ? full : open).map((r) => r.resets_at)
    gatewayResetAt = resets.length > 0 ? Math.max(...resets) : null
  }
  function facts(nowMs) {
    for (const row of rows) if (familyKind(row.kind) && row.resets_at !== null && resetPassed(row.resets_at, nowMs)) familyFailures.delete(familyKind(row.kind))
    current = limitsFacts({ rateLimits: rows, authKind, apiKeyPresent,
      planType: fallback(), settings, nowMs, signalAtMs, extraUsage, familyStates: families })
    rows = current.rows
    families = families.filter((state) => activeFamily(state, nowMs))
    if (current.billing_mode !== 'extra_usage') extraUsage = false
    if (!planBlocked(rows)) exhaustionAtMs = null
    if (current.billing_mode === 'api') {
      families = []
      familyFailures.clear()
      lastHostRows = null
      clearGatewayPause()
    }
    if (gatewayResetAt !== null && resetPassed(gatewayResetAt, nowMs)) clearGatewayPause()
    if (!current.all_exhausted && gatewayPause && current.billing_mode === 'extra_usage') clearGatewayPause()
    return current
  }
  return {
    facts,
    configure(value = {}, nowMs = 0) { settings = { ...value }; return facts(nowMs) },
    auth(kind, keyPresent, nowMs) { authKind = kind; apiKeyPresent = keyPresent === true; return facts(nowMs) },
    reading(rateLimits, nowMs, { fresh = false } = {}) {
      facts(nowMs)
      
      
      const incoming = limitsFacts({ rateLimits, authKind: 'bearer', nowMs }).rows
      const reported = limitsFacts({ rateLimits, authKind: 'bearer' }).rows
      const changed = lastHostRows === null ? incoming.length > 0 : !same(incoming, lastHostRows)
      const newEvidence = fresh === true || changed
      const previousRows = rows
      if (newEvidence) {
        if (incoming.length > 0) signalAtMs = nowMs
        for (const row of incoming) {
          const family = familyKind(row.kind)
          const oldHostRow = lastHostRows?.find((old) => old.kind === row.kind)
          if (family && (fresh === true || !same(row, oldHostRow))) {
            families = families.filter((state) => state.family !== family)
            if (row.percent_used < 100 || oldHostRow?.resets_at !== row.resets_at) familyFailures.delete(family)
          }
          const previous = previousRows.find((old) => old.kind === row.kind)
          if (PLAN_KINDS.includes(row.kind) && (previous?.percent_used >= 100 && row.percent_used < 100 ||
              row.percent_used >= 100 && (!previous || previous.percent_used < 100 || previous.resets_at !== row.resets_at))) extraUsage = false
        }
      }
      current = limitsFacts({ rateLimits, persistedRows: previousRows, authKind, apiKeyPresent,
        planType: fallback(), settings, nowMs, signalAtMs, extraUsage, familyStates: families })
      
      
      if (current.billing_mode !== 'api') for (const row of previousRows) {
        if (row.resets_at === null && !reported.some((r) => r.kind === row.kind)) current.rows.push(row)
      }
      rows = current.rows
      lastHostRows = incoming
      if (planBlocked(rows) && exhaustionAtMs === null) exhaustionAtMs = nowMs
      if (newEvidence && !current.all_exhausted && incoming.some((r) => SHARED_KINDS.includes(r.kind) && r.percent_used < 100)) clearGatewayPause()
      return facts(nowMs)
    },
    step({ model, result, nowMs, agentId, startedAtMs, exhaustedAtStart }) {
      if (agentId) return facts(nowMs)
      const before = facts(nowMs)
      const family = modelFamily(model)
      if (result && result.usage && typeof result.usage === 'object' && !Array.isArray(result.usage)) {
        completed = true
        if (family) {
          familyFailures.delete(family)
          families = families.filter((state) => state.family !== family)
          const row = rows.find((r) => familyKind(r.kind) === family && r.percent_used >= 100)
          if (row) families.push({ family, exhausted: false, resets_at: row.resets_at })
        }
        clearGatewayPause()
        
        
        if (before.billing_mode === 'subscription' && planBlocked(rows) &&
            exhaustedAtStart !== false && finite(startedAtMs) && finite(exhaustionAtMs) &&
            (startedAtMs > exhaustionAtMs || exhaustedAtStart === true && startedAtMs === exhaustionAtMs) &&
            !rows.some((r) => r.kind === 'spend_limit' && r.percent_used >= 100)) extraUsage = true
      } else if (result && result.status === 429 && result.error === 'rate_limit') {
        extraUsage = false
        if (!before.all_exhausted && family) {
          const repeated = familyFailures.has(family)
          familyFailures.add(family)
          const known = rows.find((r) => familyKind(r.kind) === family && r.percent_used >= 100)
          families = families.filter((state) => state.family !== family)
          families.push({ family, exhausted: true, resets_at: known?.resets_at ?? (repeated ? null : Math.floor(nowMs / 1000) + 60) })
        } else pauseGateway(nowMs)
      }
      return facts(nowMs)
    },
    refused(nowMs) { facts(nowMs); pauseGateway(nowMs); return facts(nowMs) },
    blocked(nowMs) { return facts(nowMs).all_exhausted || gatewayPause },
    notice(nowMs) {
      const f = facts(nowMs)
      const state = JSON.stringify([f.billing_mode, f.all_exhausted || gatewayPause, f.next_reset, f.exhausted_families])
      if (state === noted) return false
      noted = state
      return f.all_exhausted || gatewayPause
    },
    saved(nowMs) {
      facts(nowMs)
      return { rows: rows.filter((r) => r.resets_at !== null), signalAtMs, exhaustionAtMs, extraUsage,
        familyStates: families.map((state) => ({ ...state })) }
    },
    logout() {
      rows = []; families = []; signalAtMs = null; exhaustionAtMs = null; extraUsage = false; completed = false
      familyFailures.clear()
      clearGatewayPause(); authKind = null; apiKeyPresent = false; lastHostRows = null; noted = null
    },
  }
}

export async function readLimitAuth({ authorize, authStatus, apiKeyPresent }) {
  let kind
  try {
    if (typeof authorize === 'function') {
      const answer = await authorize()
      
      kind = answer === null ? null : ['bearer', 'api-key'].includes(answer?.kind) ? answer.kind : undefined
    }
  } catch (_) {}
  if (kind === undefined && typeof authStatus === 'function') {
    try {
      const answer = await authStatus()
      const parsed = typeof answer === 'string' ? JSON.parse(answer) : answer
      kind = parsed?.authMethod === 'api_key' || parsed?.authMethod === 'api-key' ? 'api-key' :
        parsed?.authMethod === 'oauth_token' || parsed?.authMethod === 'claude.ai' ? 'bearer' : undefined
    } catch (_) {}
  }
  let present = false
  try { present = typeof apiKeyPresent === 'function' && await apiKeyPresent() === true } catch (_) {}
  return { kind, apiKeyPresent: present }
}
