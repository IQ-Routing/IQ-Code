

import * as State from './lib/state.js'
import { applyDataFeaturesPreference } from './lib/iq_client.js'
import { resolveBase, planSubagent, effortFor, safeSpawnModel, gateSpawn, SUB_TEXT, readOnlyTools, readAliasHost } from './lib/subagents.js'
import { buildRouteBody, subagentType, estimateRequest, classifyResponse, destinationFrom, consumeRouteReset, effortSettings } from './lib/iq_client.js'
import { readKey, trafficOff, readUsageReporting, homeFrom, pathIn, persistPlanRestriction } from './lib/traffic.js'
import { statusOf, noteRoutingReply, noteRoutingUsage, settlePause, lineFor, continuationIds } from './lib/router.js'
import { trivialTurn } from './lib/trivial_turn.js'
import { explicitEffort, explicitModel, guessEffort, defaultEffort, sameModel, supportedEffort, validateAnswer } from './lib/models.js'
import { subagentDecisionRow, rememberSubagentDecision } from './lib/subagent_decisions.js'
import { VERSION } from './lib/pins.js'
import { SAVINGS_MODES_ENABLED, USAGE_REPORTS_ENABLED, LIMIT_AWARE_ENABLED } from './lib/usage_flags.js'


function limitAccess($) {
  return {
    authorize: () => $.session.authorize(),
    authStatus: async () => {
      const result = await $.process.run(['claude', 'auth', 'status'])
      return result?.exitCode === 0 ? result.stdout : null
    },
    apiKeyPresent: async () => {
      const value = await $.env.get('ANTHROPIC_API_KEY')
      return typeof value === 'string' && value.trim() !== ''
    },
    usage: () => $.session.usage(),
    now: () => $.clock.now(),
  }
}

function iqAccess($, ctx) {
  return {
    configured: () => ctx.pluginKey ? ctx.pluginKey() : undefined,
    home: async () => homeFrom(await $.env.get('USERPROFILE'), await $.env.get('HOME')),
    exists: (path) => $.fs.exists(path),
    read: (path) => $.fs.read(path),
    user: () => $.settings.read({ source: 'user' }),
    readSettings: (source) => $.settings.read({ source }),
    write: (path, text) => $.fs.write(path, text), run: (argv, init) => $.process.run(argv, init),
    nonessential: () => $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'),
    disabled: () => $.env.get('IQ_ROUTER_DISABLED'),
    blocked: () => State.getSetting('authBlocked') === true,
  }
}

const safe = (p) => Promise.resolve(p).catch(() => undefined)
const truthy = (v) => typeof v === 'string' && v !== '' && !['0', 'false', 'off', 'no'].includes(v.toLowerCase())

const subagentsOn = () => State.getSetting('subagentRouting') === true
const startAgain = () => State.setSetting('subagentRouting', true)
export function registerThinSubagents(registerHook, ctx, enabled) {
  let agents = new Map()
  let failures = 0
  let pendingPlans = new Set()
  let interactive = false
  let aliasNoticeShown = false
  const activate = (id, agent) => {
    agent.idle = false
    agents.delete(id)
    agents.set(id, agent)
  }
  const markIdle = (id) => {
    const agent = agents.get(id)
    if (agent) agent.idle = true
  }
  registerHook('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    agents = new Map(); pendingPlans = new Set(); failures = 0; interactive = e.isInteractive === true; aliasNoticeShown = false
    if (enabled()) startAgain()
    return next(e)
  })

  registerHook('session.end', { reason: /./ }, async ($, e, next) => {
    if (enabled() && (e.reason === 'clear' || e.reason === 'resume')) startAgain()
    return next(e)
  })


  registerHook('turn.complete', { agentId: /./ }, async ($, e, next) => {
    if (e.agentId) markIdle(e.agentId)
    return next(e)
  })
  registerHook('classic.SubagentStop', {}, async ($, e, next) => {
    if (e.agent_id) markIdle(e.agent_id)
    return next(e)
  })
  registerHook('command.run', { command: 'iq-route', args: /^\s*subagents\b/i }, async ($, e, next) => {
    if (!enabled()) return next(e)
    if (!e.origin || !['composer', 'bridge'].includes(e.origin.kind)) return {}
    if (!interactive && !(await safe($.session.surfaces()))?.length) return {}
    const word = String(e.args || '').trim().toLowerCase().split(/\s+/)[1]
    if (word !== 'on' && word !== 'off') return { text: SUB_TEXT.usageSub }
    State.setSetting('subagentRouting', word === 'on')
    try { $.ui.invalidate('ui.render') } catch (_) {}
    return { text: word === 'on' ? SUB_TEXT.pubOn : SUB_TEXT.pubOff }
  })
  registerHook('agent.spawn', { subagentType: /./ }, async ($, e, forward) => {
    const resuming = e.resume?.agentId && agents.get(e.resume.agentId)
    if (resuming) activate(e.resume.agentId, resuming)
    if (!enabled()) return forward(e)
    const started = await $.clock.now()
    const router = ctx.getR()
    const plannedAgents = agents
    const metadata = { sessionId: ctx.getM().sessionId, subagentType: e.subagentType,
      readOnly: String(e.subagentType).toLowerCase() === 'explore',
      parent: { model: resolveBase(null, e.parentModel), effort: router.named?.effort ?? router.last?.effort ?? null },
      named: { model: resolveBase(e.model, e.parentModel), effort: router.named?.effort ?? router.last?.effort ?? null },
      chosen: null, outcome: 'failed', reason: 'decision_unavailable', rated: false, latencyMs: null }
    let spawnResult
    let aliasHost = {}
    let reservation = null
    const pending = pendingPlans


    const liveReason = async () => {
      const killed = await trafficOff(iqAccess($, ctx))
      const nowMs = await $.clock.now()
      const current = ctx.getR()
      if (!enabled() || !subagentsOn()) return 'subagents off'
      if (current !== router || plannedAgents !== agents) return 'session_changed'
      if (killed) return 'killed'
      if (!current.armed) return 'main_off'
      if (failures >= 5 || current.errorsOff || current.stopped) return 'paused_errors'
      if (current.backoffUntil > nowMs) return 'paused_rate_limited'
      if (LIMIT_AWARE_ENABLED && ctx.noUsage && ctx.noUsage(nowMs)) return 'no_usage'
      const status = statusOf(current, nowMs)
      return status === 'on' ? null : status
    }
    const next = async (input) => {
      if (metadata.latencyMs === null) metadata.latencyMs = Math.max(0, await $.clock.now() - started)
      spawnResult = await forward(input)
      return spawnResult
    }
    const keep = (reason) => {
      metadata.reason = reason
      metadata.outcome = reason.startsWith('paused') || reason === 'no_usage' ? 'paused' : 'off'
      return next(e)
    }
    try {
    if (!subagentsOn()) return await keep('subagents off')
    const submitMs = await $.clock.now()
    if (LIMIT_AWARE_ENABLED && ctx.refreshLimits) await ctx.refreshLimits(limitAccess($))
    if (LIMIT_AWARE_ENABLED && ctx.noUsage && ctx.noUsage(await $.clock.now())) return await keep('no_usage')
    const r = ctx.getR()
    const home = homeFrom(await safe($.env.get('USERPROFILE')), await safe($.env.get('HOME')))
    const killed = await trafficOff(iqAccess($, ctx))
    const gate = gateSpawn({ on: true, interactive: interactive || (await safe($.session.surfaces()))?.length > 0,
      mainOn: r.armed, hasKey: r.hasKey, killed, errorsOff: r.errorsOff, stopped: r.stopped,
    }, resuming ? { ...e, workflow: undefined } : e)
    if (gate) return await keep(gate)
    const status = statusOf(r, await $.clock.now())
    if (status !== 'on') return await keep(status)
    const host = aliasHost = await readAliasHost({ version: () => $.session.version(), bedrock: () => $.env.get('CLAUDE_CODE_USE_BEDROCK'),
      vertex: () => $.env.get('CLAUDE_CODE_USE_VERTEX'), foundry: () => $.env.get('CLAUDE_CODE_USE_FOUNDRY'), baseUrl: () => $.env.get('ANTHROPIC_BASE_URL') })
    const resumed = e.resume?.agentId && agents.get(e.resume.agentId)
    if (resumed) {
      metadata.named = { model: resumed.plan.model, effort: resumed.plan.effort }
      metadata.chosen = { ...metadata.named }
      if (metadata.latencyMs === null) metadata.latencyMs = Math.max(0, await $.clock.now() - started)
      const stopped = await liveReason()
      if (stopped || r.routingRefused) return await keep(stopped || 'paused_auth')
      activate(e.resume.agentId, resumed)
      metadata.reason = 'resume_plan_reused'
      metadata.outcome = 'kept'
      return await next(e)
    }


    if ((e.resume?.agentId && continuationIds({ text: e.prompt, context: e.context }).length > 0) || trivialTurn(e.prompt)) {
      metadata.reason = e.resume?.agentId ? 'resume_continuation' : 'continuation'
      metadata.outcome = 'kept'
      return await next(e)
    }
    const resolve = async (model) => {
      if (host.notice && !aliasNoticeShown && [model, e.parentModel].some((m) => typeof m === 'string' && m.trim().toLowerCase().replace(/\[.*$/, '') === 'haiku')) {
        aliasNoticeShown = true
        try { void safe($.ui.log(host.notice)) } catch (_) {}
      }
      return resolveBase(model, e.parentModel, host)
    }
    const ownModel = typeof e.model === 'string' && e.model.trim() !== '' && e.model.trim().toLowerCase() !== 'inherit'


    let modelExplicit = true
    let base = e.resume?.agentId && agents.get(e.resume.agentId)?.plan.model || await resolve(e.model)
    let readOnly = String(e.subagentType).toLowerCase() === 'explore'
    const cwd = await safe($.session.cwd())
    if (e.provider?.plugin === 'engine' && e.provider?.tier === 'core' && /^[A-Za-z0-9_.-]{1,64}$/.test(e.subagentType)) {
      for (const dir of [cwd && pathIn(cwd, '.claude/agents') + '/', home && pathIn(home, '.claude/agents') + '/'].filter(Boolean)) {
        const path = dir + e.subagentType + '.md'
        if (!(await safe($.fs.exists(path)))) continue
        const text = await safe($.fs.read(path))
        const fm = typeof text === 'string' && /^---\s*\n([\s\S]*?)\n---/.exec(text.slice(0, 2000))
        readOnly = false
        if (fm) {
          if (e.workflow && /^isolation:\s*['\"]?remote\b/im.test(fm[1])) return await keep('workflow_remote')
          readOnly = readOnlyTools(fm[1])
          const modelLine = /^model:\s*([^\n]*)/m.exec(fm[1])
          const model = modelLine && /^['"]?([A-Za-z0-9._\[\]-]+)['"]?\s*(?:#.*)?$/.exec(modelLine[1])
          if (!e.resume && !ownModel) {
            if (!modelLine || model && model[1].toLowerCase() === 'inherit') modelExplicit = false
            else if (model) base = await resolve(model[1])
          }
        } else if (!e.resume && !ownModel && typeof text === 'string' && !/^---\s*\n/.test(text)) {
          modelExplicit = false
        }
        break
      }
    }
    metadata.readOnly = readOnly
    const sources = {}
    for (const source of ['policy', 'flag', 'local', 'project', 'user']) sources[source] = effortSettings(await safe($.settings.read({ source })))
    modelExplicit = modelExplicit || explicitModel({ env: await safe($.env.get('ANTHROPIC_MODEL')), sources, startupModel: e.parentModel, resolveModel: value => resolveBase(value, e.parentModel, host) }) !== null || r.named?.modelExplicit === true
    const effortEnv = await safe($.env.get('CLAUDE_CODE_EFFORT_LEVEL'))
    const configured = explicitEffort({ model: base, env: effortEnv, sources })
    const effort = guessEffort({ model: base, env: effortEnv, sources }) ?? defaultEffort(base)
    metadata.named = { model: base, effort }
    const effortExplicit = configured !== null


    if (agents.size + pending.size >= 128) {
      let roster = null
      try { roster = await $.agent.list() } catch (_) {}
      if (Array.isArray(roster)) for (const item of roster) {
        if (['completed', 'failed', 'killed'].includes(item.status)) markIdle(item.id)
      }
    }
    if (!e.resume?.agentId || !agents.has(e.resume.agentId)) {
      while (agents.size + pending.size >= 128) {
        const oldestIdle = [...agents].find(([, agent]) => agent.idle === true)
        if (!oldestIdle) return await keep('capacity_full')
        agents.delete(oldestIdle[0])
      }
      reservation = {}
      pending.add(reservation)
    }
    let answer = null
    metadata.reason = failures >= 5 ? 'paused_errors' : r.backoffUntil > await $.clock.now() ? 'paused_rate_limited' : 'decision_unavailable'
    if (metadata.reason.startsWith('paused')) metadata.outcome = 'paused'
    if (failures < 5 && !(r.backoffUntil > await $.clock.now())) {
      const key = await readKey(iqAccess($, ctx))
      const { base: destination, dev } = destinationFrom(await safe($.settings.read({ source: 'user' })))
      if (key && destination) {
        if (r === ctx.getR() && r.armed && !(await trafficOff(iqAccess($, ctx)))) {
          const deadline = State.routeDeadline(ctx.getM().sessionId, await safe($.env.get('IQ_ROUTER_DEADLINE_MS')), submitMs)
          if (LIMIT_AWARE_ENABLED && ctx.refreshLimits) await ctx.refreshLimits(limitAccess($))
          const sendAt = await $.clock.now()
          const limits = LIMIT_AWARE_ENABLED && ctx.limitState ? ctx.limitState(sendAt) : null
          const beforeBrief = await liveReason()
          if (beforeBrief) return await keep(beforeBrief)
          const built = buildRouteBody([], '', [key], { chosen: { model: base, effort }, last_served: null, seconds_since_last_call: null,
            context_tokens: null, cached_prefix_tokens: 0, turn_kind: 'subagent', subagent_type: subagentType(e.subagentType),
            subagent_read_only: readOnly, subagent_brief: e.prompt, limits, allow_fable: limits && limits.allow_fable })
          const req = estimateRequest({ base: destination, key, body: built.body, named: { model: base, effort, effortExplicit, modelExplicit }, version: VERSION, dev })
          const remaining = Math.max(0, submitMs + deadline - await $.clock.now())
          if (remaining <= 0) { metadata.reason = 'timeout'; return await next(e) }
          if (!req) { metadata.reason = 'request_unavailable'; return await next(e) }
          State.refreshUsageReporting(await readUsageReporting(iqAccess($, ctx)))
          const beforeSend = await liveReason()
          if (beforeSend) return await keep(beforeSend)
          let timedOut = false
          let transportFailed = false
          const res = await new Promise((resolve) => {
            let finished = false
            const timer = $.clock.after(remaining, () => { if (!finished) { finished = true; timedOut = true; resolve(null) } })
            if (finished) return

            if (LIMIT_AWARE_ENABLED && ctx.noUsage && ctx.noUsage(sendAt)) { finished = true; timer.cancel(); resolve(null); return }
            State.noteRouteCall(ctx.getM().sessionId, sendAt)
            consumeRouteReset(r, req)
            applyDataFeaturesPreference(req, State.getSetting('usageReporting'))
            let fetched
            try { fetched = $.http.fetch(req.url, req.init) }
            catch (err) {
              transportFailed = true
              timedOut = err?.name === 'TimeoutError' || err?.code === 'ETIMEDOUT'
              finished = true; timer.cancel(); resolve(null); return
            }
            Promise.resolve(fetched).catch((err) => {
              if (!finished) {
                transportFailed = true
                timedOut = err?.name === 'TimeoutError' || err?.code === 'ETIMEDOUT'
              }
              return null
            }).then((result) => { if (!finished) { finished = true; timer.cancel(); resolve(result) } })
          })
          const classified = timedOut ? { kind: 'timeout', code: 'timeout' }
            : transportFailed ? { kind: 'http', code: 'network_error' } : classifyResponse(res)
          const nowMs = await $.clock.now()
          if (r !== ctx.getR()) return await keep('session_changed')
          if (classified.kind !== 'no_usage' && LIMIT_AWARE_ENABLED && ctx.noUsage && ctx.noUsage(nowMs)) return await keep('no_usage')
          noteRoutingUsage(r, classified.usage, nowMs)
          if ((SAVINGS_MODES_ENABLED || USAGE_REPORTS_ENABLED) && classified.kind === 'ok' && classified.usage) {
            if (ctx.noteUsageEntitlement) ctx.noteUsageEntitlement(key.trim(), classified.usage.allowance !== 100)
            if (classified.usage.allowance === 100) { classified.kind = 'plan_required'; classified.code = 'plan_required' }
          }
          const replySequence = noteRoutingReply(r, classified.kind, classified.kind === 'ok' && validateAnswer(classified.parsed?.block, { model: base, effort, modelExplicit }).ok)
          metadata.reason = classified.kind
          if (classified.kind === 'timeout') { failures += 1; return await next(e) }
          if (classified.kind === 'ok') {
            answer = classified.parsed.block; failures = 0
          } else if ((['plan_required', 'allowance', 'free_quota', 'free_daily', 'auth_required'].includes(classified.kind) || LIMIT_AWARE_ENABLED && classified.kind === 'no_usage')) {
            const rec = { named: { model: base, effort }, counted: false, replySequence }
            if (LIMIT_AWARE_ENABLED && classified.kind === 'no_usage' && ctx.noteNoUsage) ctx.noteNoUsage(nowMs)
            metadata.outcome = 'paused'
            settlePause(r, rec, classified.kind === 'plan_required' ? 'plan' : classified.kind === 'auth_required' ? 'auth' : classified.kind, nowMs)
            await persistPlanRestriction(classified.kind, iqAccess($, ctx), State)
            const notice = ['plan_required', 'allowance', 'free_quota', 'free_daily'].includes(classified.kind) ? 'routing_restriction' : rec.error
            if (!r.failureNotices.has(notice)) {
              r.failureNotices.add(notice)
              r.failureNotices.add(rec.error)
              try { void safe($.ui.log(lineFor(rec, nowMs, r))) } catch (_) {}
            }
          } else if (classified.kind === 'rate_limited') { metadata.outcome = 'paused'; r.backoffUntil = nowMs + 600000 }
          else failures += 1
        } else { metadata.reason = 'main_off'; metadata.outcome = 'off' }
      } else { metadata.reason = key ? 'destination_unavailable' : 'no_key'; metadata.outcome = key ? 'failed' : 'off' }
    }
    const validAnswer = validateAnswer(answer, { model: base, effort, modelExplicit })
    const forbiddenPick = host.provider === 'anthropic' && validAnswer.ok && sameModel(answer.model, 'claude-haiku-4-5')


    const safeAnswer = validAnswer.ok && safeSpawnModel(answer.model, host) !== null
      ? { ...answer, model: forbiddenPick ? 'claude-haiku-5-5' : answer.model,
        stay: forbiddenPick ? false : answer.stay } : null
    const plan = planSubagent({ base: { model: base, effort, modelExplicit }, answer: safeAnswer, explicitEffort: effortExplicit ? effort : null })


    if (metadata.latencyMs === null) metadata.latencyMs = Math.max(0, await $.clock.now() - started)
    const stopped = await liveReason()
    if (stopped || r.routingRefused) {
      if (answer === null && metadata.outcome === 'paused') return await next(e)
      return await keep(stopped || 'paused_auth')
    }
    metadata.rated = answer !== null && plan.reason !== 'decision_unavailable'
    if (answer !== null && !metadata.rated) metadata.reason = 'invalid_answer'
    if (metadata.rated) {
      metadata.reason = forbiddenPick ? 'haiku_55_required' : plan.reason
      metadata.outcome = plan.action !== 'keep' || plan.fromIq && plan.effort !== effort ? 'applied' : 'kept'
    }

    const changed = !e.resume && plan.action !== 'keep'
    const input = changed ? { ...e, model: safeSpawnModel(plan.model, host) } : e
    let result
    let accepted = plan
    try {
      result = await next(input)
      if (changed && result && typeof result.deny === 'string') {
        accepted = null
        metadata.reason = 'spawn_rejected'; metadata.outcome = 'failed'
        result = await next(e)
      }
    } catch (err) {
      if (!changed) throw err
      accepted = null
      metadata.reason = 'spawn_rejected'; metadata.outcome = 'failed'
      result = await next(e)
    }
    if (result && typeof result.deny !== 'string' && accepted) {
      const actualModel = resolveBase(result.model || (e.resume ? base : changed ? plan.model : input.model), e.parentModel, host)
      let startingEffort = effort
      if (e.resume) {
        startingEffort = guessEffort({ model: actualModel, env: effortEnv, sources }) ?? defaultEffort(actualModel)
        const ownExplicit = explicitEffort({ model: actualModel, env: effortEnv, sources })
        metadata.named = { model: actualModel, effort: startingEffort }
        accepted = planSubagent({ base: { model: actualModel, effort: startingEffort, modelExplicit },
          answer: validAnswer.ok ? { ...safeAnswer, model: actualModel } : null, explicitEffort: ownExplicit })
      }
      accepted = { ...accepted, model: actualModel,
        effort: accepted.effort === null ? null : supportedEffort(actualModel, accepted.effort),
        action: sameModel(actualModel, base) ? 'keep' : plan.action }
      if (metadata.rated) {
        metadata.chosen = { model: actualModel, effort: accepted.effort ?? startingEffort }
        metadata.outcome = !e.resume && (!sameModel(actualModel, base) || accepted.fromIq && accepted.effort !== null && accepted.effort !== startingEffort) ? 'applied' : 'kept'
        if (e.resume) metadata.reason = 'resume_model_retained'
      }
      if (result.agentId && ctx.getR() === router && agents === plannedAgents) {
        if (accepted.fromIq === true) agents.set(result.agentId, { plan: accepted, chosen: actualModel, idle: false })
        if (ctx.noteHelperPlan) ctx.noteHelperPlan(result.agentId, { model: actualModel,
          routed: accepted.fromIq === true && !e.resume && !sameModel(actualModel, base),
          kept: metadata.rated && (e.resume || sameModel(actualModel, base)) })
      }
    }
    return result
    } catch (err) {
      metadata.outcome = 'failed'; metadata.reason = 'spawn_failed'
      throw err
    } finally {
      if (reservation) pending.delete(reservation)

      try {
        if (spawnResult && typeof spawnResult.model === 'string' && typeof spawnResult.deny !== 'string') {
          metadata.chosen = { model: resolveBase(spawnResult.model, e.parentModel, aliasHost), effort: metadata.chosen?.effort ?? metadata.named.effort }
        }
        if (spawnResult && typeof spawnResult.deny === 'string') { metadata.outcome = 'failed'; metadata.reason = 'spawn_denied'; metadata.chosen = null }
        const row = subagentDecisionRow({ ...metadata, agentId: spawnResult?.agentId, nowMs: await $.clock.now() })
        rememberSubagentDecision(router, row)
        if (ctx.writeSubagentDecision) void Promise.resolve(ctx.writeSubagentDecision(row, {
          exists: (path) => $.fs.exists(path), read: (path) => $.fs.read(path), write: (path, text) => $.fs.write(path, text),
        })).catch(() => {})
        try { $.ui.invalidate('ui.render') } catch (_) {}
      } catch (_) {}
    }
  })
  registerHook('turn.step', { model: /./ }, async function* ($, e, next) {
    if (!e.agentId) return yield* next(e)
    const agent = agents.get(e.agentId)
    if (!agent) return yield* next(e)
    activate(e.agentId, agent)
    if (!enabled() || !subagentsOn()) return yield* next(e)
    const expected = ctx.getR()
    const expectedAgents = agents
    const killed = await trafficOff(iqAccess($, ctx))
    const attached = interactive || (await safe($.session.surfaces()))?.length > 0
    const nowMs = await $.clock.now()
    const current = ctx.getR()
    if (!enabled() || !attached || !subagentsOn() || current !== expected || agents !== expectedAgents || killed || failures >= 5 ||
        !current.armed || current.routingRefused || current.backoffUntil > nowMs || statusOf(current, nowMs) !== 'on' ||
        LIMIT_AWARE_ENABLED && ctx.noUsage && ctx.noUsage(nowMs)) return yield* next(e)
    const effort = effortFor(agent.plan, e.effort)
    if (effort === undefined) return yield* next(e)
    let streamed = false
    try {
      const stream = next({ ...e, effort })
      let item = await stream.next()
      while (!item.done) {
        streamed = true
        yield item.value
        item = await stream.next()
      }
      return item.value
    } catch (err) {
      if (streamed) throw err
      return yield* next(e)
    }
  })
}
