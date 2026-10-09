import { FORCE_SERVER } from './runtime_mode.js'












export const HISTORY_MAX = 50
export const SETTING_KEYS = ['advisorMode', 'budgetUnit', 'animation', 'subagentRouting', 'forecastSource']
export const DEFAULT_SETTINGS = { advisorMode: 'keep', budgetUnit: 'usd', animation: true, subagentRouting: false, forecastSource: FORCE_SERVER ? 'server' : 'local' }
export const DASHBOARD_SETTING_KEYS = ['advisorMode', 'budgetUnit', 'animation', 'defaultTaskBudget']
SETTING_KEYS.push('defaultTaskBudget')
DEFAULT_SETTINGS.defaultTaskBudget = null


export const SESSION_ONLY_KEYS = ['subagentRouting']

const ADVISOR_MODES = ['keep', 'drop', 'ask']
const BUDGET_UNITS = ['usd', 'plan_pct']
const isNum = (x) => typeof x === 'number' && Number.isFinite(x)
const r6 = (x) => (isNum(x) ? Math.round(x * 1e6) / 1e6 : null)


const store = { settings: { ...DEFAULT_SETTINGS }, sessions: new Map(), listeners: new Set(), persist: null, pending: false, current: '' }
let dashboard = null
let pendingDashboard = undefined
let sessionChoices = {}
let settingsSessionActive = false

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

function blank() {
  return {
    forecast: null,
    served: null,
    routingOn: false,
    history: [],
    estSavedUsdTotal: null,
    budget: { unit: null, limit: null, spentUsd: 0, spentPct: null, forecast: null, status: 'none', suggestion: null },
    cache: { ttlSeconds: null, lastWriteAt: null, expiresAt: null, coldRebuildUsd: null },
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
  return k === 'animation' || k === 'subagentRouting' ? typeof v === 'boolean' : false
}


export function setSetting(k, v) {
  if (!SETTING_KEYS.includes(k) || !valid(k, v)) return false
  if (k === 'defaultTaskBudget' && getSetting('budgetUnit') === 'plan_pct' && v > 100) return false
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
    if (pairedChanged) persistNow()
    if (wasDashboard || pairedChanged) notify()
    return false 
  }
  store.settings[k] = v
  if (!SESSION_ONLY_KEYS.includes(k)) persistNow()
  notify()
  return true
}


export function loadSettings(obj) {
  const o = obj && typeof obj === 'object' ? obj : {}
  const next = { ...DEFAULT_SETTINGS }
  for (const k of SETTING_KEYS) if (!SESSION_ONLY_KEYS.includes(k) && valid(k, o[k])) next[k] = o[k]
  
  
  next.defaultTaskBudget = null
  next.subagentRouting = false 
  store.settings = next
  notify()
}

export function settingsText() {
  const saved = { ...store.settings }
  for (const k of SESSION_ONLY_KEYS) delete saved[k]
  return JSON.stringify({ v: 1, ...saved }, null, 1) + '\n'
}


export function setPersistence(fn) {
  store.persist = typeof fn === 'function' ? fn : null
}


export function takePendingSettings() {
  if (!store.pending) return null
  store.pending = false
  return settingsText()
}

function persistNow() {
  if (store.persist === null) {
    store.pending = true
    return
  }
  try {
    const r = store.persist(settingsText())
    if (r && typeof r.catch === 'function') r.catch(() => {})
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


export function resetSession(sessionId) {
  const sid = key(sessionId)
  store.current = sid
  for (const k of SESSION_ONLY_KEYS) store.settings[k] = DEFAULT_SETTINGS[k] 
  store.sessions.set(sid, blank())
  notify()
}


export function resetAll() {
  settingsSessionActive = false
  dashboard = null
  pendingDashboard = undefined
  sessionChoices = {}
  store.settings = { ...DEFAULT_SETTINGS }
  store.sessions = new Map()
  store.listeners = new Set()
  store.persist = null
  store.pending = false
  store.current = ''
}
