import { VERSION } from './pins.js'
import { LIMIT_AWARE_ENABLED } from './usage_flags.js'
import { withoutInjectedBlocks, subagentBriefText } from './trivial_turn.js'




import { canonicalModel, tierOf, EFFORTS } from './models.js'
import { limitsBlock } from './limits.js'

export const DEFAULT_BASE = 'https://gateway.iq-routing.com/v1'
export const CLIENT_NAME = 'claude-code-mod'
export const SYSTEM_LINE = 'This is a Claude Code coding session.'



export const DEFAULT_DEADLINE_MS = 4000
export const COLD_DEADLINE_MS = 7000
export const ROUTE_IDLE_MS = 10 * 60 * 1000
export const MIN_DEADLINE_MS = 1000
export const MAX_DEADLINE_MS = 8000
export const ALLOWANCE_CODE = 'subscription_routing_allowance_exceeded'

export const ROUTING_PLAN_TEXT = 'Routing needs the Personal plan ($6/month). Nothing was sent to IQ for routing. iq-routing.com/billing See /iq.'

export const ROUTING_REFUSED_TEXT = 'Routing needs the Personal plan ($6/month). IQ did not route this prompt; kept your model. iq-routing.com/billing See /iq.'

export const ROUTING_KEY_TEXT = 'Routing is paused: IQ did not accept your key. Check it, then type /iq-route on.'

export const FREE_ROUTING = Object.freeze({ monthlyCode: 'free_quota_exhausted', dailyCode: 'free_global_daily_quota_exhausted', allowance: 100,
  monthlyText: ROUTING_REFUSED_TEXT, dailyText: ROUTING_REFUSED_TEXT })
export const BACKOFF_MS = 10 * 60 * 1000
export const HISTORY_TOKENS = 8000
export const CHARS_PER_TOKEN = 4
export const MAX_HISTORY_MESSAGES = 24



export function cleanText(t) {
  if (typeof t !== 'string') return ''
  const raw = withoutInjectedBlocks(t).trim()
  const clean = raw.replace(/<\/?pasted_content(?=[\s/>])[^>]{0,256}>/gi, '').trim()
  const chars = (text) => text.replace(/\s/g, '').length
  const rawChars = chars(raw)

  return rawChars > 0 && (clean === '' || chars(clean) < rawChars * 0.1) ? raw : clean
}


function nonemptyPrompt(t) {
  return cleanText(t) || (typeof t === 'string' && /\S/.test(t) ? '[Claude Code context removed]' : '')
}

export function userOrigin(e) {
  return !!(e && e.origin && (e.origin.kind === 'composer' || e.origin.kind === 'bridge'))
}


export function historyFrom(rows, promptText, capChars, secrets) {
  if (!Array.isArray(rows)) return []
  const out = []
  let used = 0
  for (let i = rows.length - 1; i >= 0 && out.length < MAX_HISTORY_MESSAGES; i--) {
    const r = rows[i]
    if (!r || r.role !== 'user' || r.source !== 'typed') continue
    const t = scrub(cleanText(r.text), secrets)
    if (t === '') continue
    const room = capChars - used
    if (room < 200) break
    const piece = t.length <= room ? t : t.slice(t.length - room)
    out.push({ role: 'user', content: piece })
    used += piece.length
    if (t.length > room) break
  }
  return out.reverse()
}


function cutPrompt(text, maxChars) {
  if (text.length <= maxChars) return text
  const half = Math.floor(maxChars / 2)
  return text.slice(0, half) + '\n...\n' + text.slice(text.length - half)
}



export function buildEstimateBody(rows, promptText, secrets) {
  const capChars = HISTORY_TOKENS * CHARS_PER_TOKEN
  const prompt = cutPrompt(scrub(nonemptyPrompt(promptText), secrets), Math.floor(capChars / 2))
  const history = historyFrom(rows, promptText, Math.max(capChars - prompt.length, 0), secrets)
  const messages = [{ role: 'system', content: SYSTEM_LINE }, ...history, { role: 'user', content: prompt }].map((m) => ({ role: m.role, content: scrub(m.content, secrets) }))
  let chars = 0
  for (const m of messages) chars += m.content.length
  return { body: { model: 'auto', messages, stream: false }, sent: { messages: messages.length, chars } }
}


export function subagentType(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : 'unknown'
}



function withoutCompleteToolBlocks(text) {
  const opens = [], ranges = []
  for (const tag of text.matchAll(/<(\/?)tool(?=[\s/>])[^>]{0,256}>/gi)) {
    if (!tag[1]) {
      if (!/\/\s*>$/.test(tag[0])) opens.push(tag.index)
      continue
    }
    const start = opens.pop()
    if (start === undefined) continue
    while (ranges.length && ranges[ranges.length - 1][0] >= start) ranges.pop()
    ranges.push([start, tag.index + tag[0].length])
  }
  let out = '', cursor = 0
  for (const [start, end] of ranges) { out += text.slice(cursor, start); cursor = end }
  return out + text.slice(cursor)
}

export function buildRouteBody(rows, promptText, secrets, facts) {
  const built = buildEstimateBody(rows, promptText, secrets)
  const routing = { chosen: { ...facts.chosen }, last_served: facts.last_served ? { ...facts.last_served } : null,
    seconds_since_last_call: facts.seconds_since_last_call ?? null, context_tokens: facts.context_tokens ?? null,
    cached_prefix_tokens: facts.cached_prefix_tokens || 0, cache_ttl_seconds: [300, 3600].includes(facts.cache_ttl_seconds) ? facts.cache_ttl_seconds : null,
    turn_kind: facts.turn_kind || 'main' }
  if (LIMIT_AWARE_ENABLED && facts.limits) routing.limits = limitsBlock({ ...facts.limits,
    ...(typeof facts.allow_fable === 'boolean' ? { allow_fable: facts.allow_fable } : {}) })
  if (routing.turn_kind === 'subagent') {
    routing.subagent_type = subagentType(facts.subagent_type)
    routing.subagent_read_only = facts.subagent_read_only === true
    routing.subagent_rating_opt_in = true

    routing.subagent_brief = scrub(withoutCompleteToolBlocks(nonemptyPrompt(subagentBriefText(facts.subagent_brief || ''))), secrets).slice(0, 16000)
  }
  return { body: { ...built.body, contract_version: 2, routing }, sent: built.sent }
}


export function deadlineFrom(raw, fallback = DEFAULT_DEADLINE_MS) {
  const t = typeof raw === 'string' ? raw.trim() : ''
  if (!/^-?\d+(\.\d+)?$/.test(t)) return fallback
  return Math.min(MAX_DEADLINE_MS, Math.max(MIN_DEADLINE_MS, Math.round(Number(t))))
}


export function baseUrl(raw, dev = false) {
  const s = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : DEFAULT_BASE
  if (/\s|\\/.test(s)) return null
  try {
    const u = new URL(s)
    if (u.username || u.password || u.search || u.hash || u.pathname.replace(/\/+$/, '') !== '/v1') return null
    const prod = u.protocol === 'https:' && u.hostname === 'gateway.iq-routing.com' && u.port === ''
    if (!prod) return localBaseUrl(u, dev)
    return u.origin + '/v1'
  } catch (_) {
    return null
  }
}


let localBaseUrl = () => null
let localDestination = () => null

export function destinationFrom(user) {
  return localDestination(user) || { base: DEFAULT_BASE, dev: false, host: new URL(DEFAULT_BASE).host }
}


export function effortSettings(s) {
  const out = {}
  if (!s || typeof s !== 'object') return out
  if (typeof s.model === 'string') out.model = s.model
  if (typeof s.effortLevel === 'string') out.effortLevel = s.effortLevel
  if (s.modelSettings && typeof s.modelSettings === 'object') {
    out.modelSettings = Object.create(null)
    for (const [name, v] of Object.entries(s.modelSettings)) {
      if (v && typeof v.effortLevel === 'string') out.modelSettings[name] = { effortLevel: v.effortLevel }
    }
  }
  return out
}

export const MAX_RESPONSE_BYTES = 64 * 1024


export function usageRequest({ base, key, version, dev = false }) {
  const b = baseUrl(base, dev)
  if (b === null) return null
  return { url: b + '/claude-code/usage', init: { method: 'GET', headers: {
    accept: 'application/json', authorization: 'Bearer ' + key, 'x-iq-client': CLIENT_NAME + '/' + version,
  } } }
}

const PAID_PLAN_TIERS = ['personal', 'paying', 'team', 'enterprise']
export function isFreePlan(plan) {
  return !!plan && (plan.tier === 'free' || (plan.allowance === FREE_ROUTING.allowance && !PAID_PLAN_TIERS.includes(plan.tier)))
}
export function parseRoutingPlan(text) {
  if (typeof text !== 'string' || text.length > MAX_RESPONSE_BYTES || new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) return null
  try {
    const j = JSON.parse(text)
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null
    const rawTier = j.plan_tier ?? j.plan?.tier ?? j.tier ?? j.usage?.plan_tier ?? j.usage?.tier
    const tier = typeof rawTier === 'string' ? rawTier.trim().toLowerCase() : null
    const allowance = j.usage?.allowance ?? j.allowance
    const plan = { tier: ['free', ...PAID_PLAN_TIERS].includes(tier) ? tier : null,
      allowance: Number.isSafeInteger(allowance) && allowance >= 0 ? allowance : null }
    return plan.tier !== null || plan.allowance !== null ? plan : null
  } catch (_) { return null }
}


export function settingsRequest({ base, key, dev = false }) {
  const b = baseUrl(base, dev)
  if (b === null || typeof key !== 'string' || key === '') return null
  return { url: b + '/claude-code/settings', init: { method: 'GET', headers: { accept: 'application/json', authorization: 'Bearer ' + key } } }
}

export function parseSettingsResponse(res) {
  if (!res || res.status !== 200 || typeof res.text !== 'string' || res.text.length > 4096 || new TextEncoder().encode(res.text).length > 4096) return null
  try {
    const o = JSON.parse(res.text)
    if (!o || typeof o !== 'object' || Array.isArray(o) || !['keep', 'drop', 'ask'].includes(o.advisorMode) ||
        !['usd', 'plan_pct'].includes(o.budgetUnit) || typeof o.animation !== 'boolean') return null
    const n = o.defaultTaskBudget
    if (n !== null && (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || o.budgetUnit === 'plan_pct' && n > 100)) return null
    return { advisorMode: o.advisorMode, budgetUnit: o.budgetUnit, animation: o.animation, defaultTaskBudget: n }
  } catch (_) { return null }
}


export const AUTH_VERIFICATION_URL = 'https://iq-routing.com/iq-code/activate'
export const AUTH_RESPONSE_BYTES = 8192
const AUTH_ACTIONS = new Set(['start', 'token', 'complete', 'logout'])
export function authRequest({ base, dev = false, action, secret, platform, version }) {
  const b = baseUrl(base, dev)
  if (!b || !AUTH_ACTIONS.has(action)) return null
  const headers = { 'content-type': 'application/json', accept: 'application/json' }
  if (action !== 'start') {
    if (typeof secret !== 'string' || secret.length < 1 || secret.length > 4096 || !/^[A-Za-z0-9._~+\/-]+=*$/.test(secret)) return null
    headers.authorization = 'Bearer ' + secret
  }
  const os = ({ darwin: 'macos', linux: 'linux', win32: 'windows', macos: 'macos', windows: 'windows' })[platform] || 'unknown'
  const label = typeof version === 'string' && /^[0-9]{1,3}(?:\.[0-9]{1,3}){1,3}(?:-[a-z0-9.]{1,12})?$/.test(version) && version.length <= 32 ? version : VERSION
  const body = action === 'start' ? { client_id: 'iq-code', version: 1, os, client_version: label } :
    action === 'token' ? { client_id: 'iq-code', grant_type: 'urn:ietf:params:oauth:grant-type:device_code' } : {}
  const path = action === 'logout' ? '/iq-code/logout' : '/iq-code/device/' + action



  return { url: b + path, init: { method: 'POST', redirect: 'error', headers, body: JSON.stringify(body) } }
}

function authExpiry(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined
  const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/[-T:]/).map(Number)
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour > 23 || minute > 59 || second > 59 || /[+-]/.test(value.slice(19)) &&
    (Number(value.slice(-5, -3)) > 23 || Number(value.slice(-2)) > 59)) return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}


export function parseAuthResponse(res, req, action) {
  if (!res || !Number.isInteger(res.status) || !req || !AUTH_ACTIONS.has(action)) return { ok: false, code: 'malformed' }
  if (res.status >= 300 && res.status < 400 || res.redirected === true) return { ok: false, code: 'redirect_rejected' }
  if (res.url !== undefined && res.url !== '') {
    try { if (new URL(res.url).origin !== new URL(req.url).origin) return { ok: false, code: 'redirect_rejected' } }
    catch (_) { return { ok: false, code: 'redirect_rejected' } }
  }
  const text = res.text === undefined && [204, 205].includes(res.status) ? '' : res.text
  if (typeof text !== 'string' || text.length > AUTH_RESPONSE_BYTES || new TextEncoder().encode(text).length > AUTH_RESPONSE_BYTES) return { ok: false, code: 'malformed' }
  let j = {}
  try { if (text !== '') j = JSON.parse(text) } catch (_) { return { ok: false, code: 'malformed' } }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, code: 'malformed' }
  const rawError = typeof j.error === 'string' ? j.error : j.error && j.error.code || j.code
  const known = new Set(['authorization_pending', 'slow_down', 'access_denied', 'expired_token', 'invalid_grant'])
  if (res.status < 200 || res.status >= 300 || rawError) {
    const code = known.has(rawError) ? rawError : res.status === 429 ? 'rate_limited' : res.status >= 500 ? 'unavailable' :
      res.status === 404 ? 'feature_unavailable' : [401, 403].includes(res.status) ? 'credential_rejected' : 'auth_failed'
    return { ok: false, code }
  }
  if (action === 'start') {
    if (typeof j.device_code !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(j.device_code) ||
      typeof j.user_code !== 'string' || !/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/.test(j.user_code) ||
      !Number.isInteger(j.expires_in) || j.expires_in < 1 || j.expires_in > 600 ||
      !Number.isInteger(j.interval) || j.interval < 1 || j.interval > 60 ||
      j.verification_uri !== undefined && j.verification_uri !== AUTH_VERIFICATION_URL) return { ok: false, code: 'malformed' }
    return { ok: true, deviceCode: j.device_code, userCode: j.user_code, expiresIn: j.expires_in, interval: Math.max(5, j.interval) }
  }
  if (action === 'token') {
    const key = typeof j.iq_api_key === 'string' ? j.iq_api_key : j.access_token
    const expiry = authExpiry(j.expires_at)
    if (typeof key !== 'string' || key.length < 1 || key.length > 4096 || !/^[A-Za-z0-9._~+\/-]+=*$/.test(key) || expiry === undefined || typeof j.routing_eligible !== 'boolean') return { ok: false, code: 'malformed' }
    return { ok: true, key, keyExpiresAt: expiry, routingEligible: j.routing_eligible }
  }
  return { ok: true }

}




export function estimateRequest({ base, key, body, named, version, dev = false }) {
  const b = baseUrl(base, dev)
  if (b === null) return null
  const path = '/claude-code/route'
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: 'Bearer ' + key,
    'x-iq-client': CLIENT_NAME + '/' + version,
    'x-iq-cc-model-explicit': named?.modelExplicit === false ? 'false' : 'true',
    'x-iq-cc-effort-explicit': named?.effortExplicit === true ? 'true' : 'false',
  }
  if (named && typeof named.model === 'string' && named.model !== '') headers['x-iq-cc-named-model'] = canonicalModel(named.model)
  if (named && EFFORTS.includes(named.effort)) {
    headers['x-iq-cc-named-effort'] = named.effort
  }
  return { url: b + path, init: { method: 'POST', headers, body: JSON.stringify(body) } }
}



export function applyDataFeaturesPreference(request, usageReporting) {
  request.init.headers['x-iq-data-features'] = usageReporting === 'on' ? 'on' : 'off'
}




export function consumeRouteReset(router, request) {
  if (!router || !router.resetNextRoute) return
  router.resetNextRoute = false
  try {
    const body = JSON.parse(request.init.body)
    if (body && body.routing && typeof body.routing === 'object') {
      body.routing.last_served = null
      body.routing.seconds_since_last_call = null
      request.init.body = JSON.stringify(body)
    }
  } catch {}
}

const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,80}$/
export const MAX_ROUTE_HOLD = 32
export const MAX_ROUTE_HOLD_SECONDS = 60



export function parseRoute(text) {
  let j
  try {
    j = JSON.parse(text)
  } catch (_) {
    return { ok: false, code: 'malformed' }
  }
  if (!j || typeof j !== 'object' || Array.isArray(j) || j.object !== 'iq.claude_code_route') return { ok: false, code: 'malformed' }
  const block = j.claude_code && typeof j.claude_code === 'object' && !Array.isArray(j.claude_code) ? j.claude_code : null
  const hold = block && block.v === 2 ? block.hold : null
  const expiry = block && block.v === 2 ? block.hold_expires_in_seconds : null
  return {
    ok: true,
    request_id: typeof j.request_id === 'string' && REQUEST_ID.test(j.request_id) ? j.request_id : null,
    tier: tierOf(block && block.tier) || tierOf(block && typeof block.reason_code === 'string' && block.reason_code.replace(/^iq_/, '')),
    block,
    ...(Object.hasOwn(block || {}, 'hold') ? { hold: Number.isSafeInteger(hold) && hold >= 0 && hold <= MAX_ROUTE_HOLD ? hold : null } : {}),
    ...(Object.hasOwn(block || {}, 'hold_expires_in_seconds') ? { hold_expires_in_seconds: Number.isSafeInteger(expiry) && expiry >= 1 && expiry <= MAX_ROUTE_HOLD_SECONDS ? expiry : null } : {}),
  }
}


function errorCode(text) {
  try {
    const j = JSON.parse(text)
    const c = j && j.error && typeof j.error === 'object' ? j.error.code : j && j.code
    return typeof c === 'string' ? c : ''
  } catch (_) {
    return ''
  }
}


export function routingUsage(text) {
  try {
    const u = JSON.parse(text).usage
    if (!u || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(u.month) || !Number.isSafeInteger(u.decisions) || u.decisions < 0 ||
        !Number.isSafeInteger(u.allowance) || u.allowance < 1 || u.decisions > u.allowance) return null
    return { month: u.month, decisions: u.decisions, allowance: u.allowance }
  } catch (_) { return null }
}




export function classifyResponse(res) {
  if (!res || typeof res.status !== 'number') return { kind: 'malformed', code: 'malformed' }
  if (typeof res.text !== 'string' || res.text.length > MAX_RESPONSE_BYTES || new TextEncoder().encode(res.text).length > MAX_RESPONSE_BYTES) return { kind: 'malformed', code: 'response_too_large' }
  const code = errorCode(res.text)
  const usage = routingUsage(res.text)
  if (res.status >= 400 && code === FREE_ROUTING.monthlyCode) return { kind: 'free_quota', code, usage }
  if (res.status >= 400 && code === FREE_ROUTING.dailyCode) return { kind: 'free_daily', code, usage }
  if ([401, 403].includes(res.status)) return { kind: 'auth_required', code: 'key_rejected' }
  if (res.status === 402) return { kind: 'plan_required', code: 'plan_required' }
  if (LIMIT_AWARE_ENABLED && res.status === 409 && code === 'no_usage_left') return { kind: 'no_usage', code: 'no_usage_left' }
  if (res.status === 429) {
    if (code === ALLOWANCE_CODE) return { kind: 'allowance', code: 'allowance_exceeded' }
    return { kind: 'rate_limited', code: 'http_429' }
  }
  if (res.status >= 200 && res.status < 300) {
    const p = parseRoute(res.text)
    return p.ok ? { kind: 'ok', parsed: p, code: null, usage } : { kind: 'malformed', code: 'malformed' }
  }
  return { kind: 'http', code: res.status >= 500 ? 'http_5xx' : 'http_' + res.status }
}


export function scrub(text, secrets) {
  let s = typeof text === 'string' ? text : String(text)
  for (const k of secrets || []) {
    if (typeof k === 'string' && k.length > 0) s = s.split(k).join('[key]')
  }
  return s
    .replace(/-----BEGIN [^\r\n]*(?:\r?\n|$)[\s\S]*?(?:-----END [^\r\n]*(?:\r?\n|$)|$)/g, '[key]')
    .replace(/^.*(?:\b(?:password|passwd|secret)[\w.-]*[\"']?\s*[:=]|\b(?:set-cookie|cookie)\s*:).*$/gim, '[secret line]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[key]')
    .replace(/\bAIza[A-Za-z0-9_-]{35}\b/g, '[key]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]*@/gi, '$1[key]@')
    .replace(/[0-9a-f]{32,}/gi, '[key]')
    .replace(/bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [key]')
    .replace(/(\b[\w.-]*(?:authorization|x-api-key|api[-_]?key|token|pwd|pass|auth)[\w.-]*)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1$2[key]')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[private]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){0,2}\b/g, '[key]')
    .replace(/\b(?:sk|iq|ik|rk|pk|key|tok|token)[-_][A-Za-z0-9_-]{12,}\b/gi, '[key]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[key]')
}


export function safeErr(err, secrets) {
  let m = ''
  try {
    m = err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err)
  } catch (_) {
    m = 'unprintable error'
  }
  return displayText(scrub(m, secrets).replace(/\s+/g, ' ')).slice(0, 200)
}


export function displayText(text) {
  return typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '') : ''
}
