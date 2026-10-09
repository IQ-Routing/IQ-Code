
import { modelClass } from './pricing.js'
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










const GUESS_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5']
const SETTING_LEVELS = ['low', 'medium', 'high', 'xhigh'] 
const SOURCES_HIGH_FIRST = ['policy', 'flag', 'local', 'project', 'user']

export function guessEffort({ model, env, sources }) {
  const m = canonicalModel(model)
  if (!GUESS_MODELS.includes(m)) return null
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
    if (src !== 'user' && SETTING_LEVELS.includes(s.effortLevel)) return s.effortLevel
  }
  return 'medium'
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
      !(block.effort === null || EFFORTS.includes(block.effort) || Number.isSafeInteger(block.effort) && block.effort >= 0)) return { ok: false, why: 'malformed' }
  if (!/^claude-(?:opus|sonnet|haiku|fable|mythos)-\d+(?:-\d{1,2})?$/.test(canonicalModel(block.model))) return { ok: false, why: 'malformed_model' }
  const nr = rankOf(named.model)
  const mr = rankOf(block.model)
  if (nr === null || mr === null || mr > nr) return { ok: false, why: 'model_above_named' }
  return { ok: true, model: sameModel(block.model, named.model) ? named.model : canonicalModel(block.model), effort: capEffort(block.effort, named.effort), stay: block.stay, reason: block.reason_code }
}
