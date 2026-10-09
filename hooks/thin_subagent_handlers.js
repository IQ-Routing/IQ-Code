
import * as State from './lib/state.js'
import { resolveBase, planSubagent, effortFor, aliasOf, gateSpawn, SUB_TEXT, readOnlyTools, readAliasHost } from './lib/subagents.js'
import { buildRouteBody, subagentType, estimateRequest, classifyResponse, destinationFrom, deadlineFrom, DEFAULT_DEADLINE_MS } from './lib/iq_client.js'
import { readKey, trafficOff, homeFrom, pathIn } from './lib/traffic.js'
import { statusOf, noteRoutingUsage, usageLine, settlePause, lineFor } from './lib/router.js'
import { VERSION } from './lib/pins.js'


function iqAccess($, ctx) {
  return {
    configured: () => ctx.pluginKey ? ctx.pluginKey() : undefined,
    home: async () => homeFrom(await $.env.get('USERPROFILE'), await $.env.get('HOME')),
    exists: (path) => $.fs.exists(path),
    read: (path) => $.fs.read(path),
    user: () => $.settings.read({ source: 'user' }),
    nonessential: () => $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'),
    disabled: () => $.env.get('IQ_ROUTER_DISABLED'),
  }
}

const safe = (p) => Promise.resolve(p).catch(() => undefined)
const truthy = (v) => typeof v === 'string' && v !== '' && !['0', 'false', 'off', 'no'].includes(v.toLowerCase())
export function registerThinSubagents(on, ctx, enabled) {
  let agents = new Map()
  let failures = 0
  let interactive = false
  let aliasNoticeShown = false
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    agents = new Map(); failures = 0; interactive = e.isInteractive === true; aliasNoticeShown = false
    return next(e)
  })
  on('command.run', { command: 'iq-route', args: /^\s*subagents\b/i }, async ($, e, next) => {
    if (!enabled()) return next(e)
    if (!e.origin || !['composer', 'bridge'].includes(e.origin.kind)) return {}
    if (!interactive && !(await safe($.session.surfaces()))?.length) return {}
    const args = String(e.args || '').trim().toLowerCase().split(/\s+/)
    return { text: 'Subagent tasks are rated while routing is on. Type /iq-route off to stop.' }
  })
  on('agent.spawn', { subagentType: /./ }, async ($, e, next) => {
    if (!enabled()) return next(e)
    const r = ctx.getR()
    const home = homeFrom(await safe($.env.get('USERPROFILE')), await safe($.env.get('HOME')))
    const killed = await trafficOff(iqAccess($, ctx))
    if (!r.armed || statusOf(r, await $.clock.now()) !== 'on' || killed) return next(e)
    const gate = gateSpawn({ on: r.armed, interactive: interactive || (await safe($.session.surfaces()))?.length > 0,
      mainOn: r.armed, hasKey: r.hasKey, killed, errorsOff: r.errorsOff, stopped: r.stopped,
    }, e)
    if (gate) return next(e)
    const host = await readAliasHost({ version: () => $.session.version(), bedrock: () => $.env.get('CLAUDE_CODE_USE_BEDROCK'),
      vertex: () => $.env.get('CLAUDE_CODE_USE_VERTEX'), foundry: () => $.env.get('CLAUDE_CODE_USE_FOUNDRY'), baseUrl: () => $.env.get('ANTHROPIC_BASE_URL') })
    const resolve = async (model) => {
      if (host.notice && !aliasNoticeShown && [model, e.parentModel].some((m) => typeof m === 'string' && m.trim().toLowerCase().replace(/\[.*$/, '') === 'haiku')) {
        aliasNoticeShown = true; await safe($.ui.log(host.notice))
      }
      return resolveBase(model, e.parentModel, host)
    }
    let base = await resolve(e.model)
    let readOnly = String(e.subagentType).toLowerCase() === 'explore'
    const cwd = await safe($.session.cwd())
    if (/^[A-Za-z0-9_.-]{1,64}$/.test(e.subagentType)) {
      for (const dir of [cwd && pathIn(cwd, '.claude/agents') + '/', home && pathIn(home, '.claude/agents') + '/'].filter(Boolean)) {
        const path = dir + e.subagentType + '.md'
        if (!(await safe($.fs.exists(path)))) continue
        const text = await safe($.fs.read(path))
        const fm = typeof text === 'string' && /^---\s*\n([\s\S]*?)\n---/.exec(text.slice(0, 2000))
        readOnly = false
        if (fm) {
          readOnly = readOnlyTools(fm[1])
          const model = /^model:\s*['"]?([A-Za-z0-9._\[\]-]+)/m.exec(fm[1])
          if (!e.model && model) base = await resolve(model[1])
        }
        break
      }
    }
    const effort = r.named && r.named.effort || r.last && r.last.effort || null
    let answer = null
    if (failures < 5 && !(r.backoffUntil > await $.clock.now())) {
      const key = await readKey(iqAccess($, ctx))
      const { base: destination, dev } = destinationFrom(await safe($.settings.read({ source: 'user' })))
      if (key && destination) {
        const built = buildRouteBody([], '', [key], { chosen: { model: base, effort }, last_served: null, seconds_since_last_call: null,
          context_tokens: null, cached_prefix_tokens: 0, turn_kind: 'subagent', subagent_type: subagentType(e.subagentType),
          subagent_read_only: readOnly, subagent_brief: e.prompt })
        const req = estimateRequest({ base: destination, key, body: built.body, version: VERSION, dev })
        if (req && r === ctx.getR() && r.armed && !(await trafficOff(iqAccess($, ctx)))) {
          const deadline = Math.min(DEFAULT_DEADLINE_MS, deadlineFrom(await safe($.env.get('IQ_ROUTER_DEADLINE_MS'))))
          const res = await new Promise((resolve) => {
            let finished = false
            const timer = $.clock.after(deadline, () => { if (!finished) { finished = true; resolve(null) } })
            safe($.http.fetch(req.url, req.init)).then((result) => { if (!finished) { finished = true; timer.cancel(); resolve(result) } })
          })
          const classified = classifyResponse(res)
          const nowMs = await $.clock.now()
          noteRoutingUsage(r, classified.usage, nowMs)
          if (classified.kind === 'ok') {
            answer = classified.parsed.block; failures = 0
            const line = usageLine(r, nowMs)
            if (line) await safe($.ui.log(line))
          } else if (['plan_required', 'allowance', 'free_quota', 'free_daily', 'auth_required'].includes(classified.kind)) {
            const rec = { named: { model: base, effort }, counted: false }
            settlePause(r, rec, classified.kind === 'plan_required' ? 'plan' : classified.kind === 'auth_required' ? 'auth' : classified.kind, nowMs)
            await safe($.ui.log(lineFor(rec, nowMs, r)))
          } else if (classified.kind === 'rate_limited') r.backoffUntil = nowMs + 600000
          else failures += 1
        }
      }
    }
    const plan = planSubagent({ base: { model: base, effort }, answer })
    
    if (r !== ctx.getR() || !r.armed || await trafficOff(iqAccess($, ctx))) return next(e)
    const changed = plan.action !== 'keep'
    const input = changed ? { ...e, model: aliasOf(plan.model) || plan.model } : e
    let result
    let accepted = plan
    try {
      result = await next(input)
      if (changed && result && typeof result.deny === 'string') {
        accepted = null
        result = await next(e)
      }
    } catch (err) {
      if (!changed) throw err
      accepted = null
      result = await next(e)
    }
    if (result && result.agentId && accepted && accepted.fromIq === true) { 
      agents.set(result.agentId, { plan: accepted, chosen: base })
      if (agents.size > 128) agents.delete(agents.keys().next().value)
    }
    return result
  })
  on('turn.step', { model: /./ }, async function* ($, e, next) {
    if (!enabled() || !e.agentId) return yield* next(e)
    const agent = agents.get(e.agentId)
    if (!agent || !ctx.getR().armed || await trafficOff(iqAccess($, ctx))) return yield* next(e)
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
