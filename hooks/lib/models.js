
import { modelClass } from './pricing.js'
import { typedPromptText } from './trivial_turn.js'
export const TIERS = ['simple', 'medium', 'complex']
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']


const FAMILY_RANK = { haiku: 1, sonnet: 2, opus: 3, fable: 4, mythos: 5 }
const EFFORT_RANK = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 }


export function canonicalModel(id) {
  if (typeof id !== 'string') return ''
  let m = id.trim().toLowerCase()
  const br = m.indexOf('[')
  if (br >= 0) m = m.slice(0, br)
  const slash = m.lastIndexOf('/')
  if (slash >= 0) m = m.slice(slash + 1)
  return m.replace(/-20\d{6}$/, '')
}

export function sameModel(a, b) {
  const x = canonicalModel(a)
  return x !== '' && x === canonicalModel(b)
}









const GUESS_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']
const SETTING_LEVELS = ['low', 'medium', 'high', 'xhigh']
const SOURCES_HIGH_FIRST = ['policy', 'flag', 'local', 'project', 'user']

export function guessEffort({ model, env, sources }) {
  const m = canonicalModel(model)
  const e = typeof env === 'string' ? env.trim().toLowerCase() : ''
  if (EFFORTS.includes(e)) return e
  for (const src of SOURCES_HIGH_FIRST) {
    const s = sources && sources[src]
    if (!s || typeof s !== 'object') continue
    const per = s.modelSettings && typeof s.modelSettings === 'object' ? s.modelSettings : null
    if (per !== null) {
      for (const key of Object.keys(per)) {
        const entry = per[key]
        if (canonicalModel(key) === m && entry && typeof entry === 'object' && SETTING_LEVELS.includes(entry.effortLevel)) return entry.effortLevel
      }
    }
    if (SETTING_LEVELS.includes(s.effortLevel)) return s.effortLevel
  }
  return GUESS_MODELS.includes(m) ? 'medium' : null
}


export function explicitEffort({ model, env, sources }) {
  const m = canonicalModel(model)
  const e = typeof env === 'string' ? env.trim().toLowerCase() : ''
  if (EFFORTS.includes(e)) return e
  for (const src of ['policy', 'flag']) {
    const s = sources && sources[src]
    if (!s || typeof s !== 'object') continue
    for (const [key, entry] of Object.entries(s.modelSettings || {})) {
      if (canonicalModel(key) === m && SETTING_LEVELS.includes(entry?.effortLevel)) return entry.effortLevel
    }
    if (SETTING_LEVELS.includes(s.effortLevel)) return s.effortLevel
  }
  return null
}




export function explicitModel({ env, sources, runtimeModel, startupModel, resolveModel = canonicalModel } = {}) {
  for (const value of [runtimeModel, env, sources?.policy?.model, sources?.flag?.model]) {
    const model = canonicalModel(value)
    if (model) return model
  }
  const startup = canonicalModel(startupModel)
  if (!startup) return null


  try {
    const resolved = canonicalModel(resolveModel(startup))
    if (resolved && ['user', 'project', 'local'].some(source => {
      const setting = sources?.[source]?.model
      return canonicalModel(setting) !== '' && sameModel(resolved, resolveModel(setting))
    })) return null
  } catch (_) {}
  return startup
}




export function effortFacts({ model, env, sources, runtimeEffort, runtimeExplicit = false, prompt } = {}) {
  const configured = explicitEffort({ model, env, sources })
  const runtime = EFFORTS.includes(runtimeEffort) || Number.isSafeInteger(runtimeEffort) && runtimeEffort >= 0 ? runtimeEffort : null
  const ultrathink = /\bultrathink\b/i.test(typedPromptText(prompt))
  const effortExplicit = configured !== null || runtimeExplicit === true && runtime !== null ||
    ultrathink
  const effort = (ultrathink ? 'max' : configured) ?? runtime ?? guessEffort({ model, env, sources })
  return { effort, effortExplicit }
}




const NAMED_EFFORT_MODELS = new Set([
  'claude-fable-5-1', 'claude-fable-5', 'claude-opus-5-5', 'claude-sonnet-5-5',
  'claude-haiku-5-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-7',
])
const LIMITED_EFFORT_MODELS = new Set(['claude-opus-4-6', 'claude-sonnet-4-6'])
export function supportsEffort(model, effort) {
  const m = canonicalModel(model)

  if (Number.isSafeInteger(effort) && effort >= 0 && effort <= MAX_THINKING_BUDGET) return NAMED_EFFORT_MODELS.has(m) || LIMITED_EFFORT_MODELS.has(m)
  if (!EFFORTS.includes(effort)) return false
  return NAMED_EFFORT_MODELS.has(m) || LIMITED_EFFORT_MODELS.has(m) && effort !== 'xhigh'
}

export function defaultEffort(model) {
  const m = canonicalModel(model)
  if (GUESS_MODELS.includes(m)) return 'medium'
  if (m === 'claude-opus-4-7') return 'xhigh'
  return NAMED_EFFORT_MODELS.has(m) || LIMITED_EFFORT_MODELS.has(m) ? 'high' : null
}


export function supportedEffort(model, effort) {
  if (Number.isSafeInteger(effort) && effort >= 0) {
    const budget = Math.min(effort, MAX_THINKING_BUDGET)
    return supportsEffort(model, budget) ? budget : null
  }
  const rank = effortRank(effort)
  return rank === null ? null : [...EFFORTS].reverse().find(level => effortRank(level) <= rank && supportsEffort(model, level)) ?? null
}

export function effortRaise(from, to) {
  const a = effortRank(from), b = effortRank(to)
  return a !== null && b !== null && b > a ? 'raised from ' + from : ''
}

export function modelRaise(from, to) {
  const a = rankOf(from), b = rankOf(to)
  return a !== null && b !== null && b > a ? 'raised from ' + displayModel(from) : ''
}


export function applicableChoice(choice, named, override = null) {
  const own = override == null ? null : capEffort(override, named.effort)
  if (own !== null && !supportsEffort(choice.model, own)) return { ...named }
  const effort = own ?? (named.effortExplicit === true ? capEffort(choice.effort, named.effort) : choice.effort)
  return { model: choice.model, effort: supportedEffort(choice.model, effort) }
}


export function applyChoice(input, choice) {
  if (choice.model === input.model && choice.effort === input.effort) return input
  const out = { ...input, model: choice.model }
  if (supportsEffort(choice.model, choice.effort)) out.effort = choice.effort
  else delete out.effort
  return out.model === input.model && out.effort === input.effort ? input : out
}


export function familyOf(id) {
  const c = modelClass(canonicalModel(id))
  return c.startsWith('claude-') && c !== 'claude-other' ? c.slice(7) : null
}

export function rankOf(id) {
  const f = familyOf(id)
  return f === null ? null : FAMILY_RANK[f]
}

export function effortRank(e) {
  return typeof e === 'string' && Object.prototype.hasOwnProperty.call(EFFORT_RANK, e) ? EFFORT_RANK[e] : null
}

export function tierOf(x) {
  const s = typeof x === 'string' ? x.trim().toLowerCase() : ''
  return TIERS.includes(s) ? s : null
}


export function displayModel(id) {
  if (typeof id !== 'string' || id === '') return 'your model'
  const m = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(canonicalModel(id))
  if (!m) return id.length > 32 ? id.slice(0, 32) : id
  return m[1][0].toUpperCase() + m[1].slice(1) + ' ' + m[2] + (m[3] ? '.' + m[3] : '')
}

export function effortLabel(e) {
  if (typeof e === 'string') return e
  if (typeof e === 'number' && Number.isFinite(e)) return String(e)
  return null
}


export function sameChoice(a, b) {
  if (!a || !b) return false
  return a.model === b.model && effortLabel(a.effort) === effortLabel(b.effort)
}

export const priceId = (id) => canonicalModel(id) === 'claude-haiku-4-5' ? 'claude-haiku-4-5-20251001' : canonicalModel(id)


export const MAX_THINKING_BUDGET = 32768
export const UNKNOWN_THINKING_BUDGET = 4096
export function capEffort(effort, named) {
  const level = effortRank(named) === null ? 'medium' : named
  const budget = Number.isSafeInteger(named) && named >= 0 ? Math.min(named, MAX_THINKING_BUDGET) : null
  if (Number.isSafeInteger(effort) && effort >= 0) {


    if (effortRank(named) !== null) return named
    return Math.min(effort, budget ?? UNKNOWN_THINKING_BUDGET, MAX_THINKING_BUDGET)
  }
  if (effortRank(effort) !== null) {
    if (budget !== null) return budget
    return effortRank(effort) <= effortRank(level) ? effort : level
  }
  return null
}


export function validateAnswer(block, named) {
  if (!block || block.v !== 2 || typeof block.model !== 'string' || typeof block.stay !== 'boolean' ||
      typeof block.reason_code !== 'string' || !/^[a-z_]{1,48}$/.test(block.reason_code) ||
      !(block.effort === undefined || block.effort === null || EFFORTS.includes(block.effort) || Number.isSafeInteger(block.effort) && block.effort >= 0)) return { ok: false, why: 'malformed' }
  if (!/^claude-(?:opus|sonnet|haiku|fable|mythos)-\d+(?:-\d{1,2})?$/.test(canonicalModel(block.model))) return { ok: false, why: 'malformed_model' }
  const nr = rankOf(named.model)
  const mr = rankOf(block.model)
  if (nr === null || mr === null ||
      familyOf(block.model) === 'fable' && !sameModel(block.model, named.model) ||
      mr > nr && !(named.modelExplicit === false && GUESS_MODELS.includes(canonicalModel(block.model)))) return { ok: false, why: 'model_above_named' }
  const model = sameModel(block.model, named.model) ? named.model : canonicalModel(block.model)
  const effort = named.effortExplicit === true ? capEffort(block.effort, named.effort) : block.effort
  return { ok: true, model, effort: supportedEffort(model, effort), stay: block.stay, reason: block.reason_code,
    ...(typeof block.cache_advantage_usd === 'number' && Number.isFinite(block.cache_advantage_usd) && block.cache_advantage_usd >= 0 ? { cacheAdvantageUsd: block.cache_advantage_usd } : {}) }
}
