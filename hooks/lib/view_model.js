import { FORCE_SERVER } from './runtime_mode.js'










import { effortLabel, canonicalModel } from './models.js'
import { cacheTtlMs, ttlIsKnown, onSubscription } from './router.js'
import { resetAtMs, windowFinished } from './format.js'

const isNum = (x) => typeof x === 'number' && Number.isFinite(x)
const isStr = (x) => typeof x === 'string' && x !== ''

export const FIVE_HOUR_MS = 5 * 3600 * 1000
export const WEEK_MS = 7 * 24 * 3600 * 1000

export const DEFAULT_SETTINGS = { advisorMode: 'keep', budgetUnit: 'usd', animation: true, subagentRouting: FORCE_SERVER, forecastSource: FORCE_SERVER ? 'server' : 'local' }
DEFAULT_SETTINGS.defaultTaskBudget = null
export const ADVISOR_MODES = ['keep', 'drop', 'ask']
export const BUDGET_UNITS = ['usd', 'plan_pct']


export function cleanSettings(s) {
  const o = s && typeof s === 'object' ? s : {}
  return {
    advisorMode: ADVISOR_MODES.includes(o.advisorMode) ? o.advisorMode : DEFAULT_SETTINGS.advisorMode,
    budgetUnit: BUDGET_UNITS.includes(o.budgetUnit) ? o.budgetUnit : DEFAULT_SETTINGS.budgetUnit,
    animation: o.animation === false ? false : true,
    defaultTaskBudget: isNum(o.defaultTaskBudget) && o.defaultTaskBudget > 0 && !(o.budgetUnit === 'plan_pct' && o.defaultTaskBudget > 100) ? o.defaultTaskBudget : null,
    subagentRouting: typeof o.subagentRouting === 'boolean' ? o.subagentRouting : DEFAULT_SETTINGS.subagentRouting,
    forecastSource: FORCE_SERVER || o.forecastSource === 'server' ? 'server' : 'local',
  }
}

let stateModule = null

export function setStateModule(mod) {
  stateModule = mod && typeof mod.getView === 'function' ? mod : null
}

function modelOf(m) {
  if (!m || typeof m !== 'object' || !isStr(m.model)) return null
  return { model: m.model, effort: isStr(effortLabel(m.effort)) ? effortLabel(m.effort) : null }
}

const parseIso = resetAtMs











export function cacheClock(cache, nowMs) {
  if (!cache || !isNum(nowMs) || !isNum(cache.ttlSeconds) || cache.ttlSeconds <= 0 || !isNum(cache.lastWriteAt)) return null
  if (cache.tokens === 0) return null
  const ttlMs = cache.ttlSeconds * 1000
  if (cache.stale === true) return { state: 'cold', leftMs: 0, ttlSeconds: cache.ttlSeconds, rebuildUsd: null, tokens: null, startTokens: null, addedTokens: null }
  const expires = isNum(cache.expiresAt) ? cache.expiresAt : cache.lastWriteAt + ttlMs
  const leftMs = Math.min(expires - nowMs, ttlMs)
  const tokens = isNum(cache.tokens) && cache.tokens > 0 ? cache.tokens : null
  const startTokens = isNum(cache.startTokens) && cache.startTokens > 0 ? cache.startTokens : null
  return {
    state: leftMs > 0 ? 'warm' : 'cold',
    leftMs: Math.max(leftMs, 0),
    ttlSeconds: cache.ttlSeconds,
    rebuildUsd: isNum(cache.coldRebuildUsd) ? cache.coldRebuildUsd : null,
    tokens,
    startTokens,
    addedTokens: tokens !== null && startTokens !== null ? Math.max(tokens - startTokens, 0) : null,
  }
}







export function planEta(readings, nowMs, pct, resetsAtMs, windowMs) {
  if (!isNum(nowMs) || !isNum(pct) || pct < 0) return null
  if (windowFinished(resetsAtMs, nowMs)) return null
  if (pct >= 100) return nowMs
  let rate = null
  let rs = Array.isArray(readings) ? readings.filter((r) => r && isNum(r.t) && isNum(r.pct)) : []
  if (isNum(resetsAtMs) && isNum(windowMs) && resetsAtMs - windowMs <= nowMs) rs = rs.filter((r) => r.t >= resetsAtMs - windowMs)
  const strictPace = FORCE_SERVER || stateModule && stateModule.getSetting && stateModule.getSetting('forecastSource') === 'server'
  if (strictPace) {
    rs = rs.filter((r) => r.t <= nowMs && nowMs - r.t <= FIVE_HOUR_MS && (!isNum(resetsAtMs) || r.t >= resetsAtMs - FIVE_HOUR_MS))
    for (let i = 1; i < rs.length; i++) if (rs[i].pct < rs[i - 1].pct) rs = rs.slice(i)
  }
  if (rs.length >= 2) {
    const a = rs[0]
    const b = rs[rs.length - 1]
    if (b.t - a.t >= 180000 && b.pct > a.pct) rate = (b.pct - a.pct) / (b.t - a.t)
  }
  if (!strictPace && rate === null && isNum(resetsAtMs) && isNum(windowMs)) {
    const elapsed = windowMs - (resetsAtMs - nowMs)
    if (elapsed >= windowMs * 0.03 && elapsed <= windowMs && pct > 0) rate = pct / elapsed
  }
  if (rate === null || !(rate > 0)) return null
  const hit = nowMs + (100 - pct) / rate
  if (isNum(resetsAtMs) && hit > resetsAtMs) return null
  return hit
}





export function planSection(rateLimits, history, nowMs) {
  const lim = Array.isArray(rateLimits) ? rateLimits : []
  const five = lim.find((l) => l && l.kind === 'five_hour')
  const week = lim.find((l) => l && l.kind === 'seven_day')
  const one = (l, key, windowMs) => {
    if (!l || !isNum(l.percentUsed)) return { pct: null, resetsAt: null, hitAt: null }
    const resetsMs = parseIso(l.resetsAt)
    return {
      pct: l.percentUsed,
      resetsAt: resetsMs,
      hitAt: planEta(history && history[key], nowMs, l.percentUsed, resetsMs, windowMs),
    }
  }
  const f = one(five, 'five_hour', FIVE_HOUR_MS)
  const w = one(week, 'seven_day', WEEK_MS)
  return { fiveHourPct: f.pct, weeklyPct: w.pct, fiveHourResetsAt: f.resetsAt, weeklyResetsAt: w.resetsAt, fiveHourHitAt: f.hitAt, weeklyHitAt: w.hitAt, stretchPct: null }
}


export const PLAN_CAP = 60




export function noteReadings(history, rateLimits, nowMs) {
  if (!history || !Array.isArray(rateLimits)) return
  for (const l of rateLimits) {
    if (!l || (l.kind !== 'five_hour' && l.kind !== 'seven_day') || typeof l.percentUsed !== 'number') continue
    if (windowFinished(parseIso(l.resetsAt), nowMs)) continue
    const arr = history[l.kind]
    if (!Array.isArray(arr)) continue
    const last = arr[arr.length - 1]
    if (!last || last.pct !== l.percentUsed || nowMs - last.t >= 60000) {
      arr.push({ t: nowMs, pct: l.percentUsed })
      while (arr.length > PLAN_CAP) arr.shift()
    }
  }
}







export function servedOf(R, routing, working, sent) {
  const s = modelOf(sent)
  if (s) return s
  if (working || !R) return null
  return modelOf(R.last)
}

function historyOf(R, routing) {
  const out = []
  const recs = R && Array.isArray(R.recent) ? R.recent : []
  const named = routing ? modelOf(routing.named) : null
  for (const r of recs) {
    if (!r || r.phase === 'deciding' || !r.chosen || !isStr(r.chosen.model)) continue
    const from = r.named && typeof r.named === 'object' ? modelOf(r.named) || modelOf({ model: r.named.model, effort: r.named.effort }) : named
    out.push({
      at: isNum(r.submitMs) ? r.submitMs : null,
      scope: 'main',
      agentType: null,
      from,
      to: modelOf(r.chosen),
      phase: r.phase,
      tier: isStr(r.tier) ? r.tier : null,
      reason: isStr(r.reason) ? r.reason : null,
      estSavedUsd: null,
    })
  }

  const proj = routing && Array.isArray(routing.recent) ? routing.recent : []
  if (proj.length === out.length) for (let i = 0; i < out.length; i++) out[i].estSavedUsd = isNum(proj[i].est_saved_usd) ? proj[i].est_saved_usd : null
  return out
}


const wholePrompt = (last) => (last.pass && isNum(last.pass.ctx) ? last.pass.ctx : last.ctx)

function coldRebuild(R, pricer, ttlSeconds) {
  if (!R || !R.last || !isNum(wholePrompt(R.last)) || wholePrompt(R.last) <= 0 || !isNum(ttlSeconds) || !pricer || typeof pricer.resolve !== 'function') return null
  const hit = pricer.resolve(R.last.model)
  if (!hit) return null
  const ctx = wholePrompt(R.last)
  const rate = pricer.ratesFor(hit.row, ctx)
  const per = ttlSeconds >= 3600 ? rate.w1 : rate.w5
  return isNum(per) ? (ctx * per) / 1e6 : null
}




export function buildView(a) {
  const R = a.router || null
  const routing = a.routing && typeof a.routing === 'object' ? a.routing : null
  const usage = a.usage || {}
  const nowMs = isNum(a.nowMs) ? a.nowMs : null
  const settings = cleanSettings(a.settings)




  const ttl = a.ttl && typeof a.ttl === 'object' ? a.ttl : { force5m: false, envTtl: '', settingTtl: '', enable1h: false }
  const nextTtlSeconds = ttlIsKnown(ttl, usage.rateLimits) ? cacheTtlMs({ ...ttl, onSubscription: onSubscription(usage.rateLimits) }) / 1000 : null
  const last = R && R.last ? R.last : null
  const ttlSeconds = last && last.ttlMs !== undefined ? (isNum(last.ttlMs) && last.ttlMs > 0 ? last.ttlMs / 1000 : null) : nextTtlSeconds
  const lastWriteAt = last && isNum(last.startMs) ? last.startMs : null


  const prefix = last && last.pass && isNum(last.pass.prefix) ? last.pass.prefix : last ? last.cachedPrefix : null
  const cached = isNum(prefix) && prefix >= 0 ? prefix : null






  const before = last && isStr(last.sessionModel) ? canonicalModel(last.sessionModel) : ''
  const after = isStr(a.sessionModel) ? canonicalModel(a.sessionModel) : ''
  const wrote = last && isStr(last.model) ? canonicalModel(last.model) : ''
  const named = R && R.named && isStr(R.named.model) ? canonicalModel(R.named.model) : before
  const ranRouted = !!last && last.routed === true && wrote !== '' && named !== '' && wrote !== named
  const holder = ranRouted ? wrote : before
  const next = after !== '' ? after : before !== '' ? before : ranRouted ? named : ''
  const switched = !(routing && routing.status === 'on') && holder !== '' && next !== '' && holder !== next
  const stale = !!(R && (R.cacheRestart === true || switched)) && last !== null
  const meterUsd = a.meter && a.meter.session && isNum(a.meter.session.usd) ? a.meter.session.usd : 0
  const s = routing && routing.session && typeof routing.session === 'object' ? routing.session : null
  const view = {
    forecast: null,
    served: servedOf(R, routing, a.working === true, a.sent),
    routing: {
      on: !!(routing && routing.status === 'on'),
      status: routing && isStr(routing.status) ? routing.status : 'off',
      subagentsOn: settings.subagentRouting,
      history: historyOf(R, routing),
      estSavedUsdTotal: s && isNum(s.est_saved_usd) ? s.est_saved_usd : null,
      counts: s ? { prompts: s.prompts, routed: s.routed, kept: s.kept, noDecision: s.no_decision } : null,
    },
    budget: { unit: null, limit: null, spentUsd: meterUsd, spentPct: null, forecast: null, status: 'none', suggestion: null },
    cache: {
      ttlSeconds,
      lastWriteAt,
      expiresAt: isNum(ttlSeconds) && isNum(lastWriteAt) ? lastWriteAt + ttlSeconds * 1000 : null,
      coldRebuildUsd: coldRebuild(R, a.pricer, isNum(nextTtlSeconds) ? nextTtlSeconds : ttlSeconds),
      tokens: cached,
      startTokens: R && R.cacheStart && isNum(R.cacheStart.tokens) && R.cacheStart.tokens > 0 ? R.cacheStart.tokens : null,
      stale,
    },
    plan: planSection(usage.rateLimits, a.history, nowMs),
    subagents: [],
    advisor: { mode: settings.advisorMode, reserveUsd: null, usedUsd: 0, calls: 0 },
    context: { tokens: isNum(usage.contextTokens) ? usage.contextTokens : null, window: null, compactSuggest: null },
    settings,
    dashboardSources: {},
    dashboardDefaultsAvailable: false,
  }
  if (stateModule) {
    try {
      return mergeState(view, stateModule.getView(a.sessionId || null))
    } catch (_) {
      return view
    }
  }
  return view
}


export function mergeState(view, st) {
  if (!st || typeof st !== 'object') return view
  const out = { ...view }
  for (const k of Object.keys(view)) {
    const v = st[k]
    if (v === undefined || v === null) continue
    if (v && typeof v === 'object' && !Array.isArray(v) && view[k] && typeof view[k] === 'object' && !Array.isArray(view[k])) {
      const merged = { ...view[k] }
      for (const f of Object.keys(v)) if (v[f] !== undefined && v[f] !== null) merged[f] = v[f]
      out[k] = merged
    } else out[k] = v
  }
  out.settings = cleanSettings(st.settings || out.settings)
  return out
}
