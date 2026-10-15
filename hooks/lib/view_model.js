import { FORCE_SERVER } from './runtime_mode.js'










import { effortLabel, canonicalModel } from './models.js'
import { cacheTtlMs, ttlIsKnown, onSubscription } from './router.js'
import { windowReset } from './format.js'

const isNum = (x) => typeof x === 'number' && Number.isFinite(x)
const isStr = (x) => typeof x === 'string' && x !== ''

export const FIVE_HOUR_MS = 5 * 3600 * 1000
export const WEEK_MS = 7 * 24 * 3600 * 1000

export const DEFAULT_SETTINGS = { advisorMode: 'keep', budgetUnit: 'usd', animation: true, subagentRouting: FORCE_SERVER, forecastSource: FORCE_SERVER ? 'server' : 'local', planType: 'auto', usageReporting: 'on', planTier: 'unknown', allowFable: false, fableBilling: 'auto', keepRoutingOn: false, authBlocked: false, routingEligible: true }
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
    keepRoutingOn: o.keepRoutingOn === true,
    authBlocked: o.authBlocked === true,
    routingEligible: typeof o.routingEligible === 'boolean' ? o.routingEligible : true,
    forecastSource: FORCE_SERVER || o.forecastSource === 'server' ? 'server' : 'local',
    planType: ['api', 'subscription'].includes(o.planType) ? o.planType : 'auto',
    usageReporting: o.usageReporting === 'off' ? 'off' : 'on',
    planTier: ['pro', 'max', 'team_standard', 'team_premium', 'enterprise'].includes(o.planTier) ? o.planTier : 'unknown',
    allowFable: o.allowFable === true,
    fableBilling: ['plan_share', 'usage_credits'].includes(o.fableBilling) ? o.fableBilling : 'auto',
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

function parseIso(s) {
  if (!isStr(s)) return null
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}











export function cacheClock(cache, nowMs) {
  if (!cache || !isNum(nowMs)) return null
  if (cache.stale === true) return { state: 'unknown', leftMs: null, ttlSeconds: null, rebuildUsd: null, tokens: null, startTokens: null, addedTokens: null }
  if (!isNum(cache.ttlSeconds) || cache.ttlSeconds <= 0 || !isNum(cache.lastWriteAt)) return null
  if (cache.tokens === 0) return null
  const ttlMs = cache.ttlSeconds * 1000
  const expires = isNum(cache.expiresAt) ? cache.expiresAt : cache.lastWriteAt + ttlMs
  const leftMs = Math.min(expires - nowMs, ttlMs)
  const tokens = !cache.compacted && isNum(cache.tokens) && cache.tokens > 0 ? cache.tokens : null
  const startTokens = !cache.compacted && isNum(cache.startTokens) && cache.startTokens > 0 ? cache.startTokens : null
  return {
    state: leftMs > 0 ? 'warm' : 'cold',
    leftMs: Math.max(leftMs, 0),
    ttlSeconds: cache.ttlSeconds,
    rebuildUsd: !cache.compacted && isNum(cache.coldRebuildUsd) ? cache.coldRebuildUsd : null,
    ...(cache.compacted === true ? { compacted: true } : {}),
    ...(cache.heatUsd !== undefined ? { heatUsd: cache.compacted ? null : cache.heatUsd, heatThresholdsUsd: cache.heatThresholdsUsd } : {}),
    tokens,
    startTokens,
    addedTokens: tokens !== null && startTokens !== null ? Math.max(tokens - startTokens, 0) : null,
  }
}






export function planEta(readings, nowMs, pct, resetsAtMs, windowMs) {
  if (!isNum(nowMs) || !isNum(pct) || pct < 0) return null
  if (windowReset(resetsAtMs, nowMs).passed) return null
  if (pct >= 100) return nowMs
  let rate = null 
  let rs = Array.isArray(readings) ? readings.filter((r) => r && isNum(r.t) && isNum(r.pct)) : []
  if (isNum(resetsAtMs) && isNum(windowMs)) rs = rs.filter((r) => r.t >= resetsAtMs - windowMs)
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
    if (!l || !isNum(l.percentUsed)) return { pct: null, resetsAt: null, hitAt: null, reset: false }
    const resetsMs = parseIso(l.resetsAt)
    if (windowReset(resetsMs, nowMs).passed) return { pct: null, resetsAt: resetsMs, hitAt: null, reset: true }
    return {
      pct: l.percentUsed,
      resetsAt: resetsMs,
      hitAt: planEta(history && history[key], nowMs, l.percentUsed, resetsMs, windowMs),
      reset: false,
    }
  }
  const f = one(five, 'five_hour', FIVE_HOUR_MS)
  const w = one(week, 'seven_day', WEEK_MS)
  return { fiveHourPct: f.pct, weeklyPct: w.pct, fiveHourResetsAt: f.resetsAt, weeklyResetsAt: w.resetsAt, fiveHourHitAt: f.hitAt, weeklyHitAt: w.hitAt, fiveHourReset: f.reset, weeklyReset: w.reset, stretchPct: null }
}



function settlePlan(plan, nowMs) {
  if (!plan || typeof plan !== 'object') return plan
  const out = { ...plan }
  for (const [pct, resetsAt, hitAt, reset] of [['fiveHourPct', 'fiveHourResetsAt', 'fiveHourHitAt', 'fiveHourReset'], ['weeklyPct', 'weeklyResetsAt', 'weeklyHitAt', 'weeklyReset']]) {
    if (windowReset(out[resetsAt], nowMs).passed) { out[pct] = null; out[hitAt] = null; out[reset] = true }
  }
  return out
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
  for (const row of R?.subagentRecent || []) out.push({
    at: parseIso(row.ts), scope: 'subagent', agentType: row.subagent_type, agentId: row.agent_id,
    from: row.named, to: row.chosen, phase: row.outcome, reason: row.reason, rated: row.rated, estSavedUsd: null,
  })
  return out.sort((a, b) => (a.at || 0) - (b.at || 0))
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



function dollarHeat(last, pricer) {
  const absent = { heatUsd: null, heatThresholdsUsd: null }
  if (!last || !pricer || typeof pricer.resolve !== 'function') return absent
  const hit = pricer.resolve(last.model), reference = pricer.resolve('claude-sonnet-5-5')
  if (!hit || !reference) return absent
  const rate = pricer.ratesFor(hit.row, wholePrompt(last)), base = pricer.ratesFor(reference.row, 0)
  const gap = rate.input - rate.read, anchor = base.input - base.read
  if (!isNum(gap) || gap < 0 || !isNum(anchor) || anchor <= 0) return absent
  const prefix = last.pass && isNum(last.pass.prefix) ? last.pass.prefix : last.cachedPrefix
  if (!isNum(prefix) || prefix < 0) return absent
  return { heatUsd: prefix * gap / 1e6, heatThresholdsUsd: [0, 60000, 100000, 150000, 250000].map(n => n * anchor / 1e6) }
}




export function buildView(a) {
  const R = a.router || null
  const routing = a.routing && typeof a.routing === 'object' ? a.routing : null
  const usage = a.usage || {}
  const nowMs = isNum(a.nowMs) ? a.nowMs : null
  const settings = cleanSettings(a.settings)
  
  
  
  
  const ttl = a.ttl && typeof a.ttl === 'object' ? a.ttl : { force5m: false, envTtl: '', settingTtl: '', enable1h: false }
  const nextTtlSeconds = R && R.observedCacheTtlMs != null ? R.observedCacheTtlMs / 1000 : ttlIsKnown(ttl, usage.rateLimits) ? cacheTtlMs({ ...ttl, onSubscription: onSubscription(usage.rateLimits, nowMs) }) / 1000 : null
  const latest = R && R.last ? R.last : null
  const before = latest && isStr(latest.sessionModel) ? canonicalModel(latest.sessionModel) : ''
  const after = isStr(a.sessionModel) ? canonicalModel(a.sessionModel) : ''
  const wrote = latest && isStr(latest.model) ? canonicalModel(latest.model) : ''
  const named = R && R.named && isStr(R.named.model) ? canonicalModel(R.named.model) : ''
  const target = after || before || (latest && latest.routed !== true ? wrote : named) || wrote
  const entries = R && R.cacheModels || {}
  
  const entry = entries[target] || Object.values(entries).find((x) => x.last && canonicalModel(x.last.sessionModel) === target &&
    (x.last.routed !== true || canonicalModel(x.last.model) === named))
  const holder = latest && latest.routed !== true && before ? before : wrote
  const switched = !!latest && !entry && target !== '' && holder !== '' && target !== holder
  const last = entry ? entry.last : latest
  const start = entry ? entry.start : R && R.cacheStart
  const compacted = entry ? entry.compacted === true : !!(R && R.cacheRestart)
  const ttlSeconds = last && last.ttlMs !== undefined ? (isNum(last.ttlMs) && last.ttlMs > 0 ? last.ttlMs / 1000 : null) : nextTtlSeconds
  const lastWriteAt = last && isNum(last.startMs) ? last.startMs : null
  
  
  const prefix = last && last.pass && isNum(last.pass.prefix) ? last.pass.prefix : last ? last.cachedPrefix : null 
  const cached = isNum(prefix) && prefix >= 0 ? prefix : null
  const stale = switched
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
      counts: s ? { prompts: s.prompts, routed: s.routed, kept: s.kept, noDecision: s.no_decision, promptsRated: s.routed + s.kept, subagentsRated: R?.subagentsRated || 0 } : null,
    },
    budget: { unit: null, limit: null, spentUsd: meterUsd, spentPct: null, forecast: null, status: 'none', suggestion: null },
    cache: {
      ttlSeconds,
      lastWriteAt,
      expiresAt: isNum(ttlSeconds) && isNum(lastWriteAt) ? lastWriteAt + ttlSeconds * 1000 : null,
      coldRebuildUsd: compacted || stale ? null : coldRebuild(last ? { last } : null, a.pricer, isNum(nextTtlSeconds) ? nextTtlSeconds : ttlSeconds),
      tokens: cached === 0 ? 0 : compacted || stale ? null : cached,
      startTokens: !compacted && !stale && start && isNum(start.tokens) && start.tokens > 0 ? start.tokens : null,
      stale,
      compacted,
      model: last && last.model || null,
      ...dollarHeat(last, a.pricer),
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
      const merged = mergeState(view, stateModule.getView(a.sessionId || null))
      
      if (settings.forecastSource === 'server') merged.routing = { ...merged.routing, history: view.routing.history, counts: view.routing.counts }
      
      const done = entry ? { ...merged, cache: view.cache } : merged
      return { ...done, plan: settlePlan(done.plan, nowMs) }
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
