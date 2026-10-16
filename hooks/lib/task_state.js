import { classify } from './consequence.js'
import { canonicalModel } from './models.js'

const frozen = value => {
  for (const v of Object.values(value)) if (v && typeof v === 'object') frozen(v)
  return Object.freeze(value)
}
export const POLICY = frozen({
  version: 1, countCap: 999, turnCap: 64, streakCap: 16,
  work: [{ level: 80, f3: 1, agents: 2, steps: 16, edits: 5 }, { level: 65, f2: 1, agents: 1, steps: 8, edits: 3 }, { level: 50, steps: 3, edits: 1, out: 4 }],
  lightLevel: 25, undoLevel: 70, lightGap: 15, lightDelay: 2, lightRate: 0.3,
  idleFloor: 50, idleHalfLifeS: 21600, contextBase: 40, contextRange: 25, contextTokens: 32000, contextDoublings: 4,
  riskMargins: [0, 0.5, 1, 1.5], riskThresholds: [3, 8, 15],
  harm: { l1: 3, l2: 6, l3: 25, attendedL3: 10, halfLife1: 2, halfLife2: 3, halfLife3: 6 },
  sigma: { subtract: 4, divisor: 20, anchorWeight: 5, cjkWeight: 0.5, referenceWords: 12, referenceCap: 0.2, asideFloor: 0.9,
    stopwords: ['a','an','the','to','of','in','on','at','for','from','and','or','but','is','are','was','were','be','been','being','i','you','we','he','she','they','it','that','this','these','those','them','there','what','which','who','how','when','where','with','as','by','do','does','did','can','could','would','should','will','please','now','ok','go','look','left','anything'],
    references: ['it','that','this','those','these','them','there','again','continue','go on','keep going','do it','try again','anything left','anything else','the rest','look for it','check it','fix that','finish','proceed','next'],
    asides: ['btw','by the way','unrelated','quick question','side question','off topic'] },
  seedPrompts: 8, maxSessions: 32, sessionAgeMs: 604800000, maxPromptDistance: 100000, maxSessionsBytes: 1048576,
})
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo))
const count = (n, cap = POLICY.countCap) => Math.floor(clamp(n, 0, cap))
const distance = n => Number.isInteger(n) && n >= 0 ? Math.min(n, POLICY.maxPromptDistance) : null
const known = v => v && typeof v === 'object' && !Array.isArray(v)
export const tierOf = score => score >= 7 ? 'complex' : score >= 4 ? 'medium' : 'simple'
export function newWork() { return { turns: 0, steps: 0, edits: 0, agents: 0, out: 0, f2: 0, f3: 0, k1: null, k2: null, k3: null, attended: 0, outputTokens: 0 } }
export function requestFacts(belief = {}, work = {}, { idleS = 0, undo = 0, prompts = 0 } = {}) {

  return { L: Object.hasOwn(belief, 'issuedLevel10') ? belief.issuedLevel10 : belief.origin === 'none' ? null : belief.level10,
    s: belief.issuedStreak ?? belief.streak ?? 0,
    i: Math.min(31536000, Math.max(0, Math.floor(idleS))), t: work.turns ?? 0, st: work.steps ?? 0,
    e: work.edits ?? 0, a: work.agents ?? 0, o: work.out ?? 0, f2: work.f2 ?? 0, f3: work.f3 ?? 0,
    k1: belief.k1 ?? null, k2: belief.k2 ?? null, k3: belief.k3 ?? null, at: belief.attended ?? 0,
    u: undo, og: { live: 'l', restored: 'r', seeded: 's', context: 'c', none: 'n' }[belief.origin], pt: prompts }
}
export function harmMultiplier(state = {}) {
  const h = POLICY.harm
  return Math.max(1, state.k1 == null ? 1 : h.l1 * 0.5 ** (distance(state.k1) / h.halfLife1), state.k2 == null ? 1 : h.l2 * 0.5 ** (distance(state.k2) / h.halfLife2), state.k3 == null ? 1 : (state.attended === 1 ? h.attendedL3 : h.l3) * 0.5 ** (distance(state.k3) / h.halfLife3))
}
export function riskOf(state = {}) {
  const m = harmMultiplier(state)
  return m >= 15 ? 3 : m >= 8 ? 2 : m >= 3 ? 1 : 0
}
function toolName(use) { return use?.name ?? use?.tool ?? use?.toolName ?? '' }
function toolInput(use) { return use?.input ?? use?.arguments ?? {} }
export function noteStep(work, editSet, { main = true, toolUses = [], outputTokens = 0, permissionMode } = {}) {
  if (!known(work)) return work
  if (main) work.steps = count((work.steps || 0) + 1)
  work.outputTokens = count((work.outputTokens ?? (work.out || 0) * 1000) + Math.max(0, Number(outputTokens) || 0), POLICY.countCap * 1000)
  work.out = count(Math.floor(work.outputTokens / 1000))
  const edits = editSet instanceof Set ? editSet : new Set()
  for (const use of Array.isArray(toolUses) ? toolUses : []) {
    const tool = toolName(use), input = toolInput(use), c = classify({ tool, input })
    if (/^(edit|write|multiedit|notebookedit)$/i.test(tool)) {
      const path = input.file_path ?? input.path ?? input.notebook_path
      if (typeof path === 'string' && path) edits.add(path)
      if (Array.isArray(input.edits)) for (const e of input.edits) if (typeof e?.file_path === 'string') edits.add(e.file_path)
    }
    if (c.level >= 1) work.k1 = 0
    if (c.level >= 2) { work.k2 = 0; work.f2 = count((work.f2 || 0) + (c.level === 2 ? 1 : 0)) }
    if (c.level === 3) { work.k3 = 0; work.f3 = count((work.f3 || 0) + 1); work.attended = ['default', 'acceptEdits', 'plan'].includes(permissionMode) ? 1 : 0 }
  }
  work.edits = count(Math.max(work.edits || 0, edits.size))
  return work
}
export function workLevel(work = {}) {
  const counts = { ...work, agents: work.agents ?? work.helpers ?? 0, out: work.out ?? work.outputKTokens ?? 0 }
  for (const row of POLICY.work) if (Object.entries(row).some(([k, v]) => k !== 'level' && Number(counts[k] || 0) >= v)) return row.level
  return POLICY.lightLevel
}
export function contextPrior(ctx) {
  return POLICY.contextBase + POLICY.contextRange * clamp(Math.log2(Math.max(1, Number(ctx) || 0) / POLICY.contextTokens) / POLICY.contextDoublings, 0, 1)
}
export function fold(belief = {}, work = {}, { idleS = 0, undo = 0, completed = true, turnWork = work, score } = {}) {
  const stamps = {}
  for (const k of ['k1', 'k2', 'k3']) stamps[k] = work[k] == null ? distance(belief[k]) : distance(work[k])
  stamps.attended = work.k3 == null ? (belief.attended === 1 ? 1 : 0) : work.attended === 1 ? 1 : 0
  const risk = riskOf(stamps)
  let level = clamp(Number(belief.level10 ?? 25), 10, 100), streak = count(belief.streak || 0, POLICY.streakCap)
  if (level > POLICY.idleFloor) level = POLICY.idleFloor + (level - POLICY.idleFloor) * 2 ** (-Math.max(0, idleS) / (POLICY.idleHalfLifeS * (1 + risk)))
  const stretch = workLevel(work), own = workLevel(turnWork)
  level = Math.max(level, stretch)
  if (undo) { level = Math.max(level, POLICY.undoLevel); streak = 0 }
  else if (completed) {
    if (own <= level - POLICY.lightGap) {
      streak = Math.min(POLICY.streakCap, streak + 1)
      if (streak > POLICY.lightDelay + risk) level += POLICY.lightRate * (own - level)
    } else streak = 0
  }
  if (Number.isFinite(score)) level = Math.max(level, clamp(score, 1, 10) * 10)
  return { ...belief, level10: Math.round(clamp(level, 10, 100)), streak, origin: ['live','restored','seeded','context','none'].includes(belief.origin) ? belief.origin : 'live', risk, ...stamps }
}
function cue(text, phrases) { return phrases.some(p => new RegExp('(?:^|[^\\p{L}\\p{N}_])' + p.replace(/ /g, '\\s+') + '(?=$|[^\\p{L}\\p{N}_])', 'iu').test(text)) }
export function lexicalSigma(value) {
  const text = typeof value === 'string' ? value : '', s = POLICY.sigma
  const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []
  const words = text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, ' ').match(/[\p{L}\p{N}]+/gu) || []
  const stop = new Set(s.stopwords)
  const contentWords = text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, ' ').match(/[\p{L}\p{N}]+(?:\.[A-Za-z][A-Za-z0-9]*)?/gu) || []
  const content = contentWords.filter(x => !stop.has(x.toLowerCase())).length + cjk.length * s.cjkWeight

  const anchors = text.match(/https?:\/\/[^\s]+|`[^`]+`|(?:[\w.-]+\/)+[\w./-]+|\b[\w-]+\.[A-Za-z][A-Za-z0-9]*\b|\b[a-zA-Z][a-zA-Z0-9]*_[a-zA-Z0-9_]+\b|\b[a-z]+[A-Z][a-zA-Z0-9]*\b|\b\d{2,}\b/g) || []
  let sigma = clamp((content + s.anchorWeight * anchors.length - s.subtract) / s.divisor, 0, 1)
  if (words.length + cjk.length * s.cjkWeight <= s.referenceWords && cue(text, s.references)) sigma = Math.min(sigma, s.referenceCap)
  if (cue(text, s.asides)) sigma = Math.max(sigma, s.asideFloor)
  return sigma
}
export function effScore(score, level10, sigma) {
  const s = clamp(score, 1, 10), level = clamp(level10, 10, 100) / 10, visible = clamp(sigma, 0, 1)
  return s >= level ? s : visible * s + (1 - visible) * level
}
export function margin(risk, sigma = 0, riskWords = false) { return sigma < 0.5 || riskWords ? POLICY.riskMargins[count(risk, 3)] : 0 }
function typed(message) {
  if (message?.role !== 'user' || message.toolResults?.length) return false
  if (typeof message.text === 'string') return message.text.trim().length > 0
  if (typeof message.content === 'string') return message.content.trim().length > 0
  return Array.isArray(message.content) && message.content.some(p => p?.type === 'text' && typeof p.text === 'string' && p.text.trim()) && !message.content.some(p => p?.type === 'tool_result')
}
export function scanSeed(messages) {
  const list = Array.isArray(messages) ? messages : [], indexes = list.flatMap((m, i) => typed(m) ? [i] : [])
  const selected = indexes.slice(-POLICY.seedPrompts), work = newWork(), edits = new Set()
  if (!selected.length) return work
  work.turns = selected.length
  for (const m of list.slice(selected[0])) {
    let uses = m?.toolUses
    if (!Array.isArray(uses) && Array.isArray(m?.content)) uses = m.content.filter(x => x?.type === 'tool_use').map(x => ({ name: x.name, input: x.input }))
    if (Array.isArray(uses) && uses.length) noteStep(work, edits, { main: true, toolUses: uses, outputTokens: m.usage?.outputTokens ?? m.usage?.output_tokens ?? 0 })
    for (const use of Array.isArray(uses) ? uses : []) if (/^(agent|task)$/i.test(toolName(use))) work.agents = count(work.agents + 1)
  }
  return work
}


const safeInt = (v, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= 0 && v <= max ? v : undefined
const model = value => {
  const label = canonicalModel(value)
  return /^(?:claude-)?(?:haiku|sonnet|opus|fable|mythos)(?:-[0-9]+){0,3}$/.test(label) ? label : undefined
}
const effort = v => ['low','medium','high','xhigh','max'].includes(v) || Number.isSafeInteger(v) && v >= 0 && v <= 32768 ? v : v === null ? null : undefined
function choice(value) {
  if (!known(value) || !model(value.model) || effort(value.effort) === undefined) return null
  const out = { model: model(value.model), effort: effort(value.effort) }
  for (const k of ['modelExplicit', 'effortExplicit']) if (typeof value[k] === 'boolean') out[k] = value[k]
  return out
}
function workRecord(value) {
  if (!known(value)) return newWork()
  const out = newWork()
  for (const k of ['turns','steps','edits','agents','out','f2','f3','outputTokens']) {
    const cap = k === 'turns' ? POLICY.turnCap : k === 'outputTokens' ? 999000 : 999
    if (value[k] !== undefined && safeInt(value[k], cap) === undefined) return null
    if (value[k] !== undefined) out[k] = value[k]
  }
  for (const k of ['k1','k2','k3']) {
    if (value[k] != null && safeInt(value[k], POLICY.maxPromptDistance) === undefined) return null
    out[k] = value[k] ?? null
  }
  if (value.attended !== undefined && ![0, 1].includes(value.attended)) return null
  out.attended = value.attended === 1 ? 1 : 0
  return out
}
function cleanRecord(value) {
  if (!known(value)) return null
  const out = {}, b = value.belief
  if (!known(b)) return null
  if (b != null) {
    if (!known(b) || !Number.isInteger(b.level10) || b.level10 < 10 || b.level10 > 100 || safeInt(b.streak ?? 0, 16) === undefined) return null
    if (!['live','restored','seeded','context','none'].includes(b.origin)) return null
    if (b.risk !== undefined && safeInt(b.risk, 3) === undefined || b.attended !== undefined && ![0, 1].includes(b.attended)) return null
    out.belief = { level10: b.level10, streak: b.streak ?? 0, origin: b.origin, risk: count(b.risk || 0, 3) }
    for (const k of ['k1','k2','k3']) { if (b[k] != null && safeInt(b[k], 100000) === undefined) return null; out.belief[k] = b[k] ?? null }
    out.belief.attended = b.attended === 1 ? 1 : 0
    if (safeInt(b.issued) !== undefined) out.belief.issued = b.issued
    if (Object.hasOwn(b, 'issuedLevel10') || Object.hasOwn(b, 'issuedStreak')) {
      if (b.issuedLevel10 !== null && (safeInt(b.issuedLevel10, 100) === undefined || b.issuedLevel10 < 10) ||
          !Object.hasOwn(b, 'issuedLevel10') || safeInt(b.issuedStreak, 16) === undefined) return null
      out.belief.issuedLevel10 = b.issuedLevel10
      out.belief.issuedStreak = b.issuedStreak
    }
  }
  if (value.work != null) { out.work = workRecord(value.work); if (!out.work) return null }
  if (value.named != null) { out.named = choice(value.named); if (!out.named) return null }
  if (value.lighterPick != null) { out.lighterPick = choice(value.lighterPick); if (!out.lighterPick) return null }
  if (value.last != null) {
    out.last = choice(value.last); if (!out.last) return null
    for (const k of ['startMs','endMs','ctx','cachedPrefix']) { const n = safeInt(value.last[k]); if (n === undefined) return null; out.last[k] = n }
    if (![null, 300000, 3600000, undefined].includes(value.last.ttlMs)) return null
    out.last.ttlMs = value.last.ttlMs ?? null
    if (typeof value.last.routed === 'boolean') out.last.routed = value.last.routed
    if (model(value.last.sessionModel)) out.last.sessionModel = model(value.last.sessionModel)
    if (known(value.last.pass) && safeInt(value.last.pass.ctx) !== undefined && safeInt(value.last.pass.prefix) !== undefined) out.last.pass = { ctx: value.last.pass.ctx, prefix: value.last.pass.prefix }
  }
  for (const k of ['bound','provenance']) if (known(value[k])) {
    out[k] = {}
    for (const field of k === 'bound' ? ['model','effort'] : ['explicitModel','explicitEffort']) {
      const raw = value[k][field], clean = /model/i.test(field) ? model(raw) : effort(raw)
      if (raw == null) out[k][field] = null
      else if (clean === undefined) return null
      else out[k][field] = clean
    }
    if (k === 'provenance') for (const flag of ['modelExplicit','effortExplicit']) if (typeof value[k][flag] === 'boolean') out[k][flag] = value[k][flag]
  }
  if ([null, 300000, 3600000].includes(value.observedCacheTtlMs)) out.observedCacheTtlMs = value.observedCacheTtlMs
  for (const k of ['compactions','prompts']) if (safeInt(value[k], 100000) !== undefined) out[k] = value[k]
  return out
}
const validSid = sid => typeof sid === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sid)


export function sessionsSnapshot(text) {
  const unsafe = () => ({ ok: false, rows: [] })
  if (text === '') return { ok: true, rows: [] }
  try {
    if (typeof text !== 'string' || text.length > POLICY.maxSessionsBytes || new TextEncoder().encode(text).length > POLICY.maxSessionsBytes) return unsafe()
    const data = JSON.parse(text)
    if (!known(data) || data.v !== 1 || !Array.isArray(data.sessions) || Object.keys(data).some(k => !['v', 'sessions'].includes(k)) || data.sessions.length > POLICY.maxSessions) return unsafe()
    const rows = [], seen = new Set()
    for (const row of data.sessions) {
      if (!known(row) || !validSid(row.sid) || safeInt(row.updatedMs) === undefined || seen.has(row.sid)) return unsafe()
      const record = cleanRecord(row)
      if (!record) return unsafe()
      const clean = { ...record, sid: row.sid, updatedMs: row.updatedMs }
      rows.push(clean)
      seen.add(row.sid)
    }
    return { ok: true, rows }
  } catch (_) { return unsafe() }
}
export function sessionsText(oldText, sid, record, nowMs) {
  const snapshot = sessionsSnapshot(oldText)
  if (!snapshot.ok || !validSid(sid) || safeInt(nowMs) === undefined) return null
  const now = nowMs, merged = new Map()
  for (const row of snapshot.rows) if (row.updatedMs >= now - POLICY.sessionAgeMs && row.updatedMs <= now) {
    if (!merged.has(row.sid) || merged.get(row.sid).updatedMs < row.updatedMs) merged.set(row.sid, row)
  }
  if (validSid(sid)) {
    if (record === null) merged.delete(sid)
    else { const clean = cleanRecord(record); if (!clean) return null; merged.set(sid, { ...clean, sid, updatedMs: now }) }
  }
  return JSON.stringify({ v: 1, sessions: [...merged.values()].sort((a,b) => b.updatedMs - a.updatedMs || a.sid.localeCompare(b.sid)).slice(0, POLICY.maxSessions) })
}
export function sessionRecord(text, sid, nowMs) {
  if (!validSid(sid)) return null
  return sessionsSnapshot(text).rows.filter(row => row.sid === sid && (nowMs === undefined || safeInt(nowMs) !== undefined && row.updatedMs <= nowMs && row.updatedMs >= nowMs - POLICY.sessionAgeMs)).sort((a,b) => b.updatedMs - a.updatedMs)[0] ?? null
}
