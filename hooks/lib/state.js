import { LIMIT_AWARE_ENABLED } from './usage_flags.js'
import { FORCE_SERVER } from './runtime_mode.js'
import { storedUsageReporting } from './traffic.js'
import { deadlineFrom, DEFAULT_DEADLINE_MS, COLD_DEADLINE_MS, ROUTE_IDLE_MS } from './iq_client.js'












export const HISTORY_MAX = 50
export const SETTING_KEYS = ['advisorMode', 'budgetUnit', 'animation', 'subagentRouting', 'forecastSource', 'planType', 'usageReporting', 'planTier', 'allowFable', 'fableBilling', 'keepRoutingOn', 'authBlocked', 'routingEligible']
export const DEFAULT_SETTINGS = { advisorMode: 'keep', budgetUnit: 'usd', animation: true, subagentRouting: FORCE_SERVER, forecastSource: FORCE_SERVER ? 'server' : 'local', planType: 'auto', usageReporting: 'on', planTier: 'unknown', allowFable: false, fableBilling: 'auto', keepRoutingOn: false, authBlocked: false, routingEligible: true }
export const DASHBOARD_SETTING_KEYS = ['advisorMode', 'budgetUnit', 'animation', 'defaultTaskBudget']
SETTING_KEYS.push('defaultTaskBudget')
DEFAULT_SETTINGS.defaultTaskBudget = null





export const SESSION_ONLY_KEYS = ['subagentRouting']

const ADVISOR_MODES = ['keep', 'drop', 'ask']
const BUDGET_UNITS = ['usd', 'plan_pct']
const isNum = (x) => typeof x === 'number' && Number.isFinite(x)
const r6 = (x) => (isNum(x) ? Math.round(x * 1e6) / 1e6 : null)


const store = { settings: { ...DEFAULT_SETTINGS }, sessions: new Map(), listeners: new Set(), persist: null, pending: false, pendingPatch: {}, current: '' }
let dashboard = null
let pendingDashboard = undefined
let sessionChoices = {}
let settingsSessionActive = false
let usageReportingSessionOnly = false

function resolvedSettings() {
  const out = { ...store.settings }
  if (!settingsSessionActive) return out
  for (const k of DASHBOARD_SETTING_KEYS) out[k] = dashboard ? dashboard[k] : DEFAULT_SETTINGS[k]
  Object.assign(out, sessionChoices)


  if (dashboard && Object.hasOwn(sessionChoices, 'budgetUnit') && sessionChoices.budgetUnit !== dashboard.budgetUnit && !Object.hasOwn(sessionChoices, 'defaultTaskBudget')) out.defaultTaskBudget = null
  if (out.budgetUnit === 'plan_pct' && out.defaultTaskBudget > 100) out.defaultTaskBudget = null
  return out
}

export function startSettingsSession() {
  settingsSessionActive = false
  dashboard = null
  pendingDashboard = undefined
  sessionChoices = {}
  notify()
}

export function stageDashboardDefaults(value) {
  const ok = value && typeof value === 'object' && !Array.isArray(value) && DASHBOARD_SETTING_KEYS.every((k) => valid(k, value[k])) &&
    !(value.budgetUnit === 'plan_pct' && value.defaultTaskBudget > 100)
  pendingDashboard = ok ? Object.fromEntries(DASHBOARD_SETTING_KEYS.map((k) => [k, value[k]])) : null
}


export function applyDashboardDefaults() {
  if (pendingDashboard === undefined) return false
  if (pendingDashboard !== null) settingsSessionActive = true
  dashboard = pendingDashboard
  pendingDashboard = undefined
  notify()
  return true
}

export function dashboardSources() {
  const out = {}
  const settings = resolvedSettings()
  if (dashboard) for (const k of DASHBOARD_SETTING_KEYS) if (!Object.hasOwn(sessionChoices, k) && settings[k] === dashboard[k]) out[k] = true
  return out
}
let limitReading = {}

export function getLimitReading() { return JSON.parse(JSON.stringify(limitReading)) }
export function setLimitReading(value) {
  const next = cleanLimitReading(value)
  if (JSON.stringify(next) === JSON.stringify(limitReading)) return false
  limitReading = next
  persistNow({ limitReading })
  return true
}
function cleanLimitReading(value) {
  const v = value && typeof value === 'object' ? value : {}
  const kinds = ['five_hour', 'seven_day', 'spend_limit', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_overage_included', 'overage']
  const rows = (Array.isArray(v.rows) ? v.rows : []).filter((r) => r && kinds.includes(r.kind) &&
    isNum(r.percent_used) && r.percent_used >= 0 && r.percent_used <= 999.9 &&
    (r.resets_at === null || Number.isSafeInteger(r.resets_at) && r.resets_at >= 0)).slice(0, 8)
    .map((r) => ({ kind: r.kind, percent_used: Math.round(r.percent_used * 10) / 10, resets_at: r.resets_at }))
  const familyStates = (Array.isArray(v.familyStates) ? v.familyStates : []).filter((f) => f &&
    ['haiku', 'sonnet', 'opus', 'fable', 'mythos'].includes(f.family) && typeof f.exhausted === 'boolean' &&
    (f.resets_at === null || Number.isSafeInteger(f.resets_at) && f.resets_at >= 0)).slice(0, 5)
    .map((f) => ({ family: f.family, exhausted: f.exhausted, resets_at: f.resets_at }))
  return { rows, signalAtMs: isNum(v.signalAtMs) && v.signalAtMs >= 0 ? v.signalAtMs : null, extraUsage: v.extraUsage === true, familyStates,
    ...(isNum(v.exhaustionAtMs) && v.exhaustionAtMs >= 0 ? { exhaustionAtMs: v.exhaustionAtMs } : {}) }

}

function blank() {
  return {
    lastRouteCallMs: null,
    forecast: null,
    served: null,
    routingOn: false,
    history: [],
    estSavedUsdTotal: null,
    budget: { unit: null, limit: null, spentUsd: 0, spentFloor: false, spentPct: null, forecast: null, status: 'none', suggestion: null },
    cache: { ttlSeconds: null, lastWriteAt: null, expiresAt: null, coldRebuildUsd: null, tokens: null, startTokens: null },
    plan: { fiveHourPct: null, weeklyPct: null, fiveHourResetsAt: null, weeklyResetsAt: null, fiveHourHitAt: null, weeklyHitAt: null, stretchPct: null },
    subagents: [],
    advisor: { reserveUsd: null, usedUsd: 0, calls: 0 },
    context: { tokens: null, window: null, compactSuggest: null },
  }
}

const key = (sid) => (typeof sid === 'string' ? sid : '')

function slot(sid) {
  const k = key(sid)
  let s = store.sessions.get(k)
  if (!s) {
    s = blank()
    store.sessions.set(k, s)
    if (store.sessions.size > 16) store.sessions.delete(store.sessions.keys().next().value)
  }
  return s
}


export function routeDeadline(sessionId, raw, nowMs) {
  const last = slot(sessionId).lastRouteCallMs
  const cold = last === null || nowMs < last || nowMs - last >= ROUTE_IDLE_MS
  return deadlineFrom(raw, cold ? COLD_DEADLINE_MS : DEFAULT_DEADLINE_MS)
}

export function noteRouteCall(sessionId, nowMs) {
  slot(sessionId).lastRouteCallMs = nowMs
}

function notify() {
  for (const fn of [...store.listeners]) {
    try {
      fn()
    } catch (_) {

    }
  }
}




export function getView(sessionId) {
  const sid = sessionId === undefined ? store.current : sessionId
  const s = slot(sid)
  const settings = resolvedSettings()
  return {
    forecast: s.forecast ? { ...s.forecast } : null,
    served: s.served ? { model: s.served.model, effort: s.served.effort } : null,
    routing: {
      on: s.routingOn,
      subagentsOn: settings.subagentRouting === true,
      history: s.history.map((h) => ({ ...h, from: { ...h.from }, to: { ...h.to } })),
      estSavedUsdTotal: s.estSavedUsdTotal,
    },
    budget: { ...s.budget, forecast: s.budget.forecast ? { ...s.budget.forecast } : null, suggestion: s.budget.suggestion ? { ...s.budget.suggestion, plan: [...s.budget.suggestion.plan] } : null },
    cache: { ...s.cache },
    plan: { ...s.plan },
    subagents: s.subagents.map((a) => ({ ...a })),
    advisor: { mode: settings.advisorMode, ...s.advisor },
    context: { ...s.context, compactSuggest: s.context.compactSuggest ? { ...s.context.compactSuggest } : null },
    settings,
    dashboardSources: dashboardSources(),
    dashboardDefaultsAvailable: dashboard !== null,
  }
}




export function getSetting(k) {
  const settings = resolvedSettings()
  return Object.prototype.hasOwnProperty.call(settings, k) ? settings[k] : DEFAULT_SETTINGS[k]
}

function valid(k, v) {
  if (k === 'defaultTaskBudget') return v === null || isNum(v) && v > 0
  if (k === 'advisorMode') return ADVISOR_MODES.includes(v)
  if (k === 'budgetUnit') return BUDGET_UNITS.includes(v)
  if (k === 'forecastSource') return v === (FORCE_SERVER ? 'server' : 'local')
  if (k === 'planType') return ['auto', 'api', 'subscription'].includes(v)
  if (k === 'usageReporting') return ['on', 'off'].includes(v)
  if (k === 'planTier') return ['pro', 'max', 'team_standard', 'team_premium', 'enterprise', 'unknown'].includes(v)
  if (k === 'allowFable') return typeof v === 'boolean'
  if (k === 'fableBilling') return ['auto', 'plan_share', 'usage_credits'].includes(v)
  return ['animation', 'subagentRouting', 'keepRoutingOn', 'authBlocked', 'routingEligible'].includes(k) ? typeof v === 'boolean' : false

}


export function setSetting(k, v) {
  if (!SETTING_KEYS.includes(k) || !valid(k, v)) return false
  if (k === 'defaultTaskBudget' && getSetting('budgetUnit') === 'plan_pct' && v > 100) return false
  const before = { ...store.settings }
  const wasDashboard = dashboardSources()[k] === true
  let pairedChanged = false
  if (DASHBOARD_SETTING_KEYS.includes(k)) {
    if (k === 'defaultTaskBudget' && v !== null) {
      const unit = getSetting('budgetUnit')
      pairedChanged = store.settings.budgetUnit !== unit
      sessionChoices.budgetUnit = unit
      store.settings.budgetUnit = sessionChoices.budgetUnit
    }
    if (k === 'budgetUnit' && v !== getSetting(k) && Object.hasOwn(sessionChoices, 'defaultTaskBudget')) {
      pairedChanged = store.settings.defaultTaskBudget !== null
      sessionChoices.defaultTaskBudget = null
      store.settings.defaultTaskBudget = null
    }
    sessionChoices[k] = v
  }
  if (store.settings[k] === v) {
    if (pairedChanged) persistNow(changedSettings(before))
    if (wasDashboard || pairedChanged) notify()
    return false
  }
  store.settings[k] = v
  if (!SESSION_ONLY_KEYS.includes(k)) persistNow(changedSettings(before))
  notify()
  return true
}


export function loadSettings(obj) {
  const o = obj && typeof obj === 'object' ? obj : {}
  const next = { ...DEFAULT_SETTINGS }
  usageReportingSessionOnly = false
  for (const k of SETTING_KEYS) if (!SESSION_ONLY_KEYS.includes(k) && valid(k, o[k])) next[k] = o[k]
  next.usageReporting = storedUsageReporting(obj)


  next.defaultTaskBudget = null
  next.subagentRouting = DEFAULT_SETTINGS.subagentRouting
  store.settings = next
  if (LIMIT_AWARE_ENABLED && Object.hasOwn(o, 'limitReading')) limitReading = cleanLimitReading(o.limitReading)
  store.pending = false
  store.pendingPatch = {}

  notify()
}


export function keepUsageReportingOffForSession() {
  usageReportingSessionOnly = true
  refreshUsageReporting('off')
}

export function refreshUsageReporting(value) {
  const next = !usageReportingSessionOnly && value === 'on' ? 'on' : 'off'
  if (store.settings.usageReporting !== next) {
    store.settings.usageReporting = next
    notify()
  }
}


export function refreshRoutingConsent(obj) {
  refreshUsageReporting(storedUsageReporting(obj))
  const value = obj && typeof obj === 'object' ? obj : {}
  for (const key of ['keepRoutingOn', 'authBlocked', 'routingEligible']) {
    store.settings[key] = valid(key, value[key]) ? value[key] : DEFAULT_SETTINGS[key]
    delete store.pendingPatch[key]
  }
  store.pending = Object.keys(store.pendingPatch).length > 0
  notify()
}

let settingsWrites = Promise.resolve()
export const settingsSettled = () => settingsWrites


export function saveSettings(patch, write, guard = () => true) {
  const operation = settingsWrites.then(async () => {
    if (guard() !== true || typeof write !== 'function') return false
    const values = patch && typeof patch === 'object' ? patch : {}
    for (const [k, v] of Object.entries(values)) if (!SETTING_KEYS.includes(k) || !valid(k, v)) return false
    if ((values.budgetUnit || getSetting('budgetUnit')) === 'plan_pct' && values.defaultTaskBudget > 100) return false
    const before = { ...store.settings }
    const beforeChoices = { ...sessionChoices }


    const persistence = store.persist
    store.persist = null
    try { for (const [key, value] of Object.entries(values)) setSetting(key, value) }
    finally { store.persist = persistence }
    notify()
    const actualPatch = { ...store.pendingPatch }
    for (const [key, value] of Object.entries(values)) if (!SESSION_ONLY_KEYS.includes(key)) actualPatch[key] = value

    if (values.usageReporting === 'off') usageReportingSessionOnly = true
    try {
      const merged = await write(settingsText(), actualPatch)
      if (guard() !== true) {
        store.settings = before
        sessionChoices = beforeChoices

        const restrictive = { keepRoutingOn: false, authBlocked: true, routingEligible: false }
        const rollback = Object.fromEntries(Object.keys(actualPatch).map(key => [key, Object.hasOwn(restrictive, key) ? restrictive[key] : key === 'limitReading' ? limitReading : before[key]]))
        for (const key of Object.keys(restrictive)) if (Object.hasOwn(rollback, key)) store.settings[key] = restrictive[key]
        try { await write(settingsText(), rollback) } catch (_) {
          store.settings.authBlocked = true
          store.settings.keepRoutingOn = false
          try { await write(settingsText(), { authBlocked: true, keepRoutingOn: false }) } catch (_) {}
        }
        notify()
        clearPending(actualPatch)
        return false
      }
      if (Object.hasOwn(values, 'usageReporting')) usageReportingSessionOnly = false
      if (merged && Object.hasOwn(merged, 'usageReporting')) refreshUsageReporting(storedUsageReporting(merged))

      let consentChanged = false
      if (merged && typeof merged === 'object') for (const key of ['keepRoutingOn', 'authBlocked', 'routingEligible']) {
        if (!Object.hasOwn(values, key) && valid(key, merged[key]) && store.settings[key] !== merged[key]) {
          store.settings[key] = merged[key]
          consentChanged = true
        }
      }
      if (consentChanged) notify()
      clearPending(actualPatch)
      return true
    } catch (_) {


      if (values.authBlocked !== true && (Object.prototype.hasOwnProperty.call(values, 'keepRoutingOn') || Object.prototype.hasOwnProperty.call(values, 'authBlocked'))) { store.settings = before; sessionChoices = beforeChoices }
      clearPending(actualPatch)
      notify()
      return false
    }
  })
  settingsWrites = operation.catch(() => false)
  return operation
}

export function flushSettings(write) {
  return saveSettings({}, async (text, patch) => {
    if (Object.keys(patch).length > 0) return write(text, patch)
  })
}

export function settingsText() {
  const saved = { ...store.settings }
  for (const k of SESSION_ONLY_KEYS) delete saved[k]
  return JSON.stringify({ v: 1, ...saved, ...(LIMIT_AWARE_ENABLED ? { limitReading } : {}) }, null, 1) + '\n'
}


export function setPersistence(fn) {
  store.persist = typeof fn === 'function' ? fn : null
}


export function takePendingSettings() {
  if (!store.pending) return null
  const patch = store.pendingPatch
  store.pending = false
  store.pendingPatch = {}
  return JSON.stringify({ v: 1, ...patch }, null, 1) + '\n'
}

function changedSettings(before) {
  return Object.fromEntries(SETTING_KEYS.filter(key => !SESSION_ONLY_KEYS.includes(key) && before[key] !== store.settings[key]).map(key => [key, store.settings[key]]))
}

function clearPending(patch) {
  for (const [key, value] of Object.entries(patch)) if (store.pendingPatch[key] === value) delete store.pendingPatch[key]
  store.pending = Object.keys(store.pendingPatch).length > 0
}

function persistNow(patch) {
  Object.assign(store.pendingPatch, patch)
  store.pending = Object.keys(store.pendingPatch).length > 0
  if (store.persist === null) return
  try {
    const pending = { ...store.pendingPatch }
    const r = store.persist(settingsText(), pending)
    if (r && typeof r.then === 'function') r.then(() => clearPending(pending), () => {})
    else clearPending(pending)
  } catch (_) {

  }
}

export function subscribe(fn) {
  if (typeof fn !== 'function') return () => {}
  store.listeners.add(fn)
  return () => store.listeners.delete(fn)
}





export function update(sessionId, patch) {
  const sid = key(sessionId)
  store.current = sid
  const s = slot(sid)
  const p = patch && typeof patch === 'object' ? patch : {}
  if ('forecast' in p) s.forecast = p.forecast ? { ...p.forecast } : null
  if ('served' in p) s.served = p.served ? { model: p.served.model, effort: p.served.effort === undefined ? null : p.served.effort } : null
  if ('routingOn' in p) s.routingOn = p.routingOn === true
  if ('estSavedUsdTotal' in p) s.estSavedUsdTotal = isNum(p.estSavedUsdTotal) ? r6(p.estSavedUsdTotal) : null
  for (const part of ['budget', 'cache', 'plan', 'advisor', 'context']) if (p[part] && typeof p[part] === 'object') s[part] = { ...s[part], ...p[part] }
  if (Array.isArray(p.subagents)) s.subagents = p.subagents.map((a) => ({ ...a }))
  notify()
}


export function pushHistory(sessionId, h) {
  const sid = key(sessionId)
  store.current = sid
  const s = slot(sid)
  const scope = h && ['main', 'subagent', 'advisor'].includes(h.scope) ? h.scope : null
  if (scope === null) return false
  const side = (x) => ({ model: x && typeof x.model === 'string' ? x.model : null, effort: x && x.effort !== undefined && x.effort !== null ? x.effort : null })
  s.history.push({
    at: isNum(h.at) ? h.at : null,
    scope,
    agentType: scope === 'subagent' && typeof h.agentType === 'string' ? h.agentType : null,
    from: side(h.from),
    to: side(h.to),
    reason: typeof h.reason === 'string' ? h.reason : '',
    estSavedUsd: isNum(h.estSavedUsd) ? r6(h.estSavedUsd) : null,
  })
  while (s.history.length > HISTORY_MAX) s.history.shift()
  notify()
  return true
}




export function resetSession(sessionId, keepSessionOnly = false) {
  const sid = key(sessionId)
  store.current = sid
  if (keepSessionOnly !== true) for (const k of SESSION_ONLY_KEYS) store.settings[k] = DEFAULT_SETTINGS[k]
  const lastRouteCallMs = keepSessionOnly === true ? slot(sid).lastRouteCallMs : null
  store.sessions.set(sid, { ...blank(), lastRouteCallMs })
  notify()
}


export function resetAll() {
  usageReportingSessionOnly = false
  settingsSessionActive = false
  dashboard = null
  pendingDashboard = undefined
  sessionChoices = {}
  limitReading = {}

  store.settings = { ...DEFAULT_SETTINGS }
  store.sessions = new Map()
  store.listeners = new Set()
  store.persist = null
  store.pending = false
  store.pendingPatch = {}
  store.current = ''
}
