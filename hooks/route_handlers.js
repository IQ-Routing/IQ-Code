

import { registerThinSubagents } from './thin_subagent_handlers.js'
import * as State from './lib/state.js'
import { FORCE_SERVER } from './lib/runtime_mode.js'
import { newForecastClient, FORECAST_TEXT } from './lib/server_forecast.js'
import { effortLabel, familyOf, canonicalModel } from './lib/models.js'
import { readKey, trafficOff, homeFrom } from './lib/traffic.js'
import { destinationFrom, isFreePlan } from './lib/iq_client.js'
import { statusOf } from './lib/router.js'
import { resolveBase, readAliasHost } from './lib/subagents.js'


function iqAccess($) {
  return {
    configured: () => C && C.pluginKey ? C.pluginKey() : undefined,
    home: async () => homeFrom(await $.env.get('USERPROFILE'), await $.env.get('HOME')),
    exists: (path) => $.fs.exists(path),
    read: (path) => $.fs.read(path),
    user: () => $.settings.read({ source: 'user' }),
    nonessential: () => $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'),
    disabled: () => $.env.get('IQ_ROUTER_DISABLED'),
  }
}

const enabled = () => FORCE_SERVER
const safe = (p) => Promise.resolve(p).catch(() => undefined)
let C = null
let F = null
let epoch = 0
let sid = null
let ended = false
let lifecycle = 'initial'
let limit = null
let taskStartUsd = 0
let budgetUnit = 'usd'
let budgetExplicit = false
let taskPct = { last: null, spent: 0 }
let answerState = { state: 'unavailable', reasonCode: 'estimate_pending_first_call', pending: false }
let helpersSeen = new Set()
let spawnExpectedUsd = null
let aliasNoticeShown = false

async function allowed($) {
  return enabled() && !ended && C.getR().armed &&
    !isFreePlan(C.getR().plan || C.getR().usage) &&
    statusOf(C.getR(), await $.clock.now()) === 'on' && !(await trafficOff(iqAccess($)))
}

function publishState(answer) {
  const t = C.getT()
  if (answer) answerState = answer
  const fc = F ? F.current() : null
  const spent = Math.max(0, t.usd - taskStartUsd)
  const window = C.getM().usage?.rateLimits?.find((w) => w.kind === 'five_hour' && typeof w.percentUsed === 'number' && Number.isFinite(w.percentUsed))
  if (window && limit !== null && budgetUnit === 'plan_pct') {
    if (taskPct.last !== null) taskPct.spent += Math.max(0, window.percentUsed - taskPct.last)
    taskPct.last = window.percentUsed
  }
  const budgetSpent = budgetUnit === 'plan_pct' ? taskPct.spent : spent
  
  const status = limit === null ? 'none' : budgetSpent >= limit ? 'over' : 'ok'
  State.update(sid, { forecast: { source: 'server', state: answerState.state, reasonCode: answerState.reasonCode, pending: answerState.pending, text: FORECAST_TEXT[answerState.state] || null, totalQ50Usd: fc ? fc.total_q50_usd : null, remainingQ50Usd: fc ? fc.remaining_q50_usd : null }, budget: { unit: limit === null ? null : budgetUnit, limit, spentUsd: limit === null ? t.usd : spent, spentPct: budgetUnit === 'plan_pct' && taskPct.last !== null ? taskPct.spent : null, forecast: null, status, suggestion: null }, advisor: { reserveUsd: null }, context: { compactSuggest: null } })
}
function publish($, answer) {
  publishState(answer)
  try { $.ui.invalidate('ui.render') } catch (_) {}
}
function noteHelper(id) {
  if (helpersSeen.has(id) || helpersSeen.size >= 1000) return
  const first = helpersSeen.size === 0
  helpersSeen.add(id)
  if (first && F) F.invalidate(epoch > 0 ? 'compacted' : 'helpers_seen')
}
function reset($) {
  if (F) F.end()
  sid = C.getM().sessionId
  epoch = 0
  ended = false
  lifecycle = C.getT().historyKnown ? 'resumed' : 'initial'
  answerState = { state: 'unavailable', reasonCode: 'estimate_pending_first_call', pending: false }
  helpersSeen = new Set()
  limit = null
  budgetUnit = 'usd'
  budgetExplicit = false
  taskPct = { last: null, spent: 0 }
  taskStartUsd = 0
  spawnExpectedUsd = null
  aliasNoticeShown = false
  const session = sid
  F = newForecastClient({ now: () => Math.max(C.getM().nowMs, Date.now()), later: (ms, fn) => $.clock.after(ms, fn), fetch: async (url, init) => {
    
    if (sid !== session || !(await allowed($))) return null
    return $.http.fetch(url, init)
  }, onChange: (answer) => { if (!ended && enabled()) publish($, answer) } })
  State.resetSession(sid)
  publish($)
}
export function applyTaskDefaults($) {
  if (!enabled() || !C) return
  if (sid !== C.getM().sessionId || !F) reset($)
  if (ended) return
  if (budgetExplicit) return measureTaskBudget()
  const settings = State.getView(sid).settings
  if (limit === settings.defaultTaskBudget && budgetUnit === settings.budgetUnit) return measureTaskBudget()
  if (budgetUnit !== settings.budgetUnit) {
    taskStartUsd = C.getT().usd
    taskPct = { last: null, spent: 0 }
  }
  limit = settings.defaultTaskBudget
  budgetUnit = settings.budgetUnit
  publish($)
}

export function measureTaskBudget() {
  if (!enabled() || ended || !C || sid !== C.getM().sessionId || limit === null) return false
  publishState()
  return true
}

async function request($) {
  if (!enabled() || ended || !C.getM().ready) return
  
  if (isFreePlan(C.getR().plan || C.getR().usage)) {
    if (sid !== C.getM().sessionId || !F) reset($)
    F.invalidate('forecast_not_paid')
    publish($, { state: 'not_paid', reasonCode: 'forecast_not_paid', pending: false })
    return
  }
  if (!(await allowed($))) { if (F) F.invalidate(); return }
  const m = C.getM()
  if (sid !== m.sessionId || !F) reset($)
  const t = C.getT()
  if (t.mainCalls === 0) return
  const client = F
  const session = m.sessionId
  const tracker = t
  const rawModel = m.sent && m.sent.model || t.lastMainModel || await safe($.session.model())
  const normalized = canonicalModel(rawModel)
  const host = normalized === 'haiku' ? await readAliasHost({ version: () => $.session.version(), bedrock: () => $.env.get('CLAUDE_CODE_USE_BEDROCK'),
    vertex: () => $.env.get('CLAUDE_CODE_USE_VERTEX'), foundry: () => $.env.get('CLAUDE_CODE_USE_FOUNDRY'), baseUrl: () => $.env.get('ANTHROPIC_BASE_URL') }) : {}
  if (host.notice && !aliasNoticeShown) { aliasNoticeShown = true; await safe($.ui.log(host.notice)) }
  const model = resolveBase(normalized, '', host)
  const rawEffort = effortLabel(m.sent && m.sent.effort || t.lastMainEffortClass)
  const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(rawEffort) ? rawEffort : 'unspecified'
  const context = Number.isInteger(m.usage.contextTokens) ? m.usage.contextTokens : Number.isInteger(t.lastMainCtx) ? t.lastMainCtx : null
  const observed = { model, effort, context_tokens: context, cache_read_tokens: null, calls_observed: t.calls, spent_usd: t.usd, active_s: Math.floor(t.activeMs / 1000), helpers_active: helpersSeen.size, context_epoch: epoch, lifecycle: epoch > 0 ? 'compacted' : lifecycle === 'resumed' ? 'resumed' : 'steady', usage_status: t.unpriced > 0 || lifecycle === 'resumed' ? 'incomplete' : 'complete' }
  const key = await readKey(iqAccess($))
  const { base, dev } = destinationFrom(await safe($.settings.read({ source: 'user' })))
  if (client === F && session === C.getM().sessionId && tracker === C.getT() && await allowed($)) client.request(observed, key, base, dev, C.getR().plan || C.getR().usage)
}

function schedule($) {
  if (enabled() && ended && sid !== C.getM().sessionId) reset($)
  if (!enabled() || ended) return
  const client = F, session = C.getM().sessionId
  $.clock.after(0, () => {
    if (client !== F || session !== C.getM().sessionId) return
    void request($).catch(() => { if (client === F && session === C.getM().sessionId) client.invalidate() })
  })
}
export function latestSpawnPrice(agentType, modelAlias) { return enabled() && F ? F.price(agentType, modelAlias) : null }
export function lastSpawnPrice() { return spawnExpectedUsd }
export function registerRoute(on, ctx) {
  C = ctx
  registerThinSubagents(on, ctx, enabled)
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    const out = await next(e)
    if (enabled()) {
      reset($)
      await safe($.command.register({ name: 'iq-budget', description: 'Set a measured task budget in API-equivalent dollars or percent of your five-hour plan window', argumentHint: '<amount> [usd|%] | off | status', immediate: true }))
    }
    return out
  })
  on('prompt.submit', { text: /[\s\S]*/ }, async ($, e, next) => {
    if (!enabled()) return next(e)
    const out = await next(e)
    if (!(out && out.drop)) { applyTaskDefaults($); schedule($) }
    return out
  })
  on('turn.step', { model: /./ }, async function* ($, e, next) {
    if (!enabled()) return yield* next(e)
    const session = sid, tracker = C.getT()
    if (e.agentId) noteHelper(e.agentId)
    const out = yield* next(e)
    if (ended || session !== sid || tracker !== C.getT()) return out
    if (e.agentId) noteHelper(e.agentId)
    publish($); schedule($); return out
  })
  on('agent.spawn', { subagentType: /./ }, async ($, e, next) => {
    if (!enabled()) return next(e)
    
    spawnExpectedUsd = latestSpawnPrice(e.subagentType, familyOf(e.model || e.parentModel))
    const session = sid, tracker = C.getT()
    const out = await next(e)
    if (enabled() && !ended && session === sid && tracker === C.getT()) {
      if (out && out.agentId) noteHelper(out.agentId)
      publish($)
    }
    return out
  })
  on('session.compact', { trigger: ['manual', 'auto', 'plugin'] }, async ($, e, next) => {
    if (!enabled()) return next(e)
    const session = sid, tracker = C.getT()
    const out = await next(e)
    if (enabled() && !ended && session === sid && tracker === C.getT() && !e.agentId && out && !out.skip) { epoch += 1; helpersSeen = new Set(); if (F) F.newEpoch(); publish($); schedule($) }
    return out
  })
  on('session.end', { reason: /./ }, async ($, e, next) => { if (enabled()) { ended = true; if (F) F.end() }; return next(e) })
  on('command.run', { command: 'iq-budget' }, async ($, e, next) => {
    if (!enabled()) return next(e)
    const parts = String(e.args || '').trim().split(/\s+/)
    const t = C.getT()
    if (parts[0] === 'off') { limit = null; budgetExplicit = true }
    else if (/^\d+(\.\d+)?$/.test(parts[0]) && parts.length <= 2 && (parts[1] === undefined || ['usd', '%', 'plan_pct'].includes(parts[1]))) {
      const unit = parts[1] === 'usd' ? 'usd' : parts[1] ? 'plan_pct' : State.getSetting('budgetUnit')
      const amount = Number(parts[0])
      if (!(amount > 0) || !Number.isFinite(amount) || amount > (unit === 'plan_pct' ? 100 : 100000)) return { text: 'iq-budget: that amount is not usable.' }
      limit = amount; budgetUnit = unit; budgetExplicit = true; taskStartUsd = t.usd; taskPct = { last: null, spent: 0 }
    }
    else if (parts[0] !== '' && parts[0] !== 'status') return { text: 'iq-budget: use <amount> [usd|%], off or status.' }
    publish($)
    if (limit !== null && budgetUnit === 'plan_pct') return { text: taskPct.last === null ? 'iq-budget: waiting for the five-hour plan reading.' : 'iq-budget: ' + taskPct.spent.toFixed(1) + '% of ' + limit + '% used.' }
    return { text: limit === null ? 'iq-budget: no task budget is set.' : 'iq-budget: $' + Math.max(0, t.usd - taskStartUsd).toFixed(2) + ' of $' + limit.toFixed(2) + ' used (API-equivalent).' }
  })
}
