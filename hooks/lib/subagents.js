
import { canonicalModel, sameModel, displayModel, familyOf, validateAnswer, capEffort } from './models.js'
const ALIASES = { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' }
const HAIKU55 = 'claude-haiku-5-5'
const HAIKU45 = 'claude-haiku-4-5'

export function haikuAlias(host = {}) {
  const raw = typeof host.version === 'string' ? host.version : host.version && host.version.version
  const match = typeof raw === 'string' && /^(\d+)\.(\d+)\.(\d+)$/.exec(raw)
  const newer = match && (Number(match[1]) > 2 || Number(match[1]) === 2 &&
    (Number(match[2]) > 1 || Number(match[2]) === 1 && Number(match[3]) >= 293))
  return host.provider === 'anthropic' && newer ? HAIKU55 : HAIKU45
}


export async function readAliasHost(access) {
  const read = async (fn) => { try { return await fn() } catch (_) { return null } }
  const [version, ...values] = await Promise.all([access.version, access.bedrock, access.vertex, access.foundry, access.baseUrl].map(read))
  const flag = (value) => typeof value === 'string' && value.trim() !== '' && !['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase())
  let provider = values.some((value) => value === null) ? 'unknown' : values.slice(0, 3).some(flag) ? 'other' : 'anthropic'
  if (values[3]) {
    try { const url = new URL(values[3]); if (url.protocol !== 'https:' || url.hostname !== 'api.anthropic.com' || url.port || url.username || url.password) provider = 'other' }
    catch (_) { provider = 'unknown' }
  }
  const raw = typeof version === 'string' ? version : version && version.version
  const notice = !raw || !/^\d+\.\d+\.\d+$/.test(raw)
    ? 'IQ Code: host version unavailable; Haiku alias estimates use Haiku 4.5 prices.'
    : provider === 'unknown' ? 'IQ Code: provider unavailable; Haiku alias estimates use Haiku 4.5 prices.' : null
  return { version, provider, notice }
}
export const SUB_TEXT = {
  routed: (type, to) => 'iq-route: subagent' + (type ? ' ' + type : '') + ' on ' + to + ' (IQ decision)',
  usageSub: 'iq-route: use subagents on or subagents off.',
  subOn: 'iq-route: subagent routing is on for this session only. IQ rates each subagent task: its task brief (best-effort secret scrubbing, up to 16,000 characters) is sent to IQ and counts as one IQ decision. A task IQ cannot rate keeps its model. It starts off in every session; /iq-route subagents off stops it.',
  subOff: 'iq-route: subagent routing is off.',
  subMainOff: 'iq-route: subagent routing needs routing on. Type /iq-route on first.',
  subNoKey: 'Add your IQ key with /plugin configure iq-code@iq-routing, then /reload-plugins.',
  subKilled: 'iq-route: subagent routing is disabled. IQ_ROUTER_DISABLED is set, or ~/.claude/iq/router/OFF exists.',
}


export function resolveBase(requested, parentModel, host = {}) {
  const r = typeof requested === 'string' ? requested.trim().toLowerCase() : ''
  const model = r === '' || r === 'inherit' ? canonicalModel(parentModel) : canonicalModel(r)
  if (model === 'haiku') return haikuAlias(host)
  if (Object.prototype.hasOwnProperty.call(ALIASES, model)) return ALIASES[model]
  return model
}


export function aliasOf(model) {
  const family = familyOf(model)
  return ['haiku', 'sonnet', 'opus'].includes(family) ? family : null
}




export function planSubagent(a) {
  const base = { model: canonicalModel(a.base.model), effort: a.base.effort ?? null }
  let choice = { model: base.model, effort: null }
  let reason = 'decision_unavailable'
  let fromIq = false
  const answer = validateAnswer(a.answer, base)
  if (answer.ok) {
    if (!answer.stay) {
      choice = { model: answer.model, effort: answer.effort }
      fromIq = true
    }
    reason = answer.reason
  }
  return { model: choice.model, effort: choice.effort, action: sameModel(choice.model, base.model) ? 'keep' : 'down', reason, fromIq }
}


export function effortFor(plan, engineEffort) {
  if (!plan || plan.fromIq !== true) return undefined
  const effort = capEffort(plan.effort, engineEffort)
  return effort !== null && effort !== undefined && effort !== engineEffort ? effort : undefined
}

export function gateSpawn(g, spawn) {
  if (g.on !== true) return 'off'
  if (g.interactive !== true) return 'headless' 
  
  
  let mainOn = g.mainOn === true
  if (!mainOn) return 'main_off'
  if (g.killed) return 'killed'
  if (!g.hasKey) return 'no_key'
  if (g.errorsOff || g.stopped) return 'paused_errors'
  if (spawn.fork === true) return 'fork' 
  if (spawn.workflow) return 'workflow' 
  if (spawn.isTeammate === true) return 'teammate'
  return null
}

export const describe = (plan) => plan.model ? displayModel(plan.model) : 'your model'


export function readOnlyTools(frontMatter) {
  if (typeof frontMatter !== 'string') return false
  const match = /^tools:\s*([^\n]*)(?:\n((?:[ \t]+-[^\n]*\n?)*))?/m.exec(frontMatter)
  if (!match) return false
  const names = (match[1] + ' ' + (match[2] || '')).replace(/[\[\]"']/g, '').split(/[,\s]+/).filter((name) => name && name !== '-')
  const safeTools = ['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch']
  return names.length > 0 && names.every((name) => safeTools.includes(name))
}
