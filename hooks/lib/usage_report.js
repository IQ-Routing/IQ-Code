
import { baseUrl } from './iq_client.js'

export const USAGE_REPORT_INTERVAL_MS = 60000
export const USAGE_REPORT_TIMEOUT_MS = 1500
export const REPORT_CLIENT_VERSIONS = Object.freeze(['1.1.0'])
export const REPORT_RATE_CARDS = Object.freeze(['2026-10-07'])
export const REPORT_BILLING_MODES = Object.freeze(['api', 'subscription', 'extra_usage', 'cloud_credits', 'unknown'])
export const REPORT_MODELS = Object.freeze(['claude-fable-5', 'claude-fable-5-1', 'claude-haiku-4-5', 'claude-haiku-5-5', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-sonnet-5-5', 'unknown'])
const MODEL_SET = new Set(REPORT_MODELS)

export const REPORT_MODEL_ALIASES = Object.freeze(Object.fromEntries(REPORT_MODELS.filter((m) => m !== 'unknown').flatMap((m) => [[m, m], ['anthropic/' + m, m]]).concat([['claude-haiku-4-5-20251001', 'claude-haiku-4-5'], ['unknown', 'unknown']])))
export const normalizeReportModel = (model) => typeof model === 'string' && Object.hasOwn(REPORT_MODEL_ALIASES, model) ? REPORT_MODEL_ALIASES[model] : 'unknown'
const MAX_COUNT = 2147483647
const MAX_TOKENS = Number.MAX_SAFE_INTEGER
const MAX_MICROS = 999999999999n
const DAY_MS = 86400000
const ENVELOPE_KEYS = ['schema_version', 'client_version', 'rate_card_version', 'reporting_run_id', 'sequence', 'usage_day', 'final', 'rows']
const ROW_KEYS = ['plan_type', 'plan_type_overridden', 'model', 'calls', 'routed_calls', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'api_equivalent_usd', 'est_saved_usd', 'est_saved_weekly_pct', 'usage_status']
const BILLING_ROW_KEYS = ['billing_mode', 'plan_calls', 'credit_calls', 'prompts_skipped_no_usage', 'families_exhausted_count', 'est_saved_credit_usd']
const EXTENDED_ROW_KEYS = [...ROW_KEYS, ...BILLING_ROW_KEYS]
const TOKEN_KEYS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens']
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const exact = (o, keys) => o !== null && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k))
const integer = (v, max) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max
const finite = (v) => typeof v === 'number' && Number.isFinite(v)
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10)
const validDay = (day, time) => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && (day === utcDay(time) || day === utcDay(time - DAY_MS))
const rowIdentity = (r) => r.model + '\u0000' + r.plan_type + '\u0000' + (r.plan_type_overridden ? '1' : '0') + (Object.hasOwn(r, 'billing_mode') ? '\u0000' + r.billing_mode : '')
const versionLabel = (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(v)


function decimal(value) {
  const parts = String(value).toLowerCase().split('e')
  const exp = parts.length === 2 ? Number(parts[1]) : 0
  const point = parts[0].indexOf('.')
  let places = (point < 0 ? 0 : parts[0].length - point - 1) - exp
  let n = BigInt(parts[0].replace('.', ''))
  if (places < 0) { n *= 10n ** BigInt(-places); places = 0 }
  return { n, places }
}
function addDecimal(a, b) {
  const places = Math.max(a.places, b.places)
  return { n: a.n * 10n ** BigInt(places - a.places) + b.n * 10n ** BigInt(places - b.places), places }
}
function micros(a) {
  if (a.places <= 6) return a.n * 10n ** BigInt(6 - a.places)
  const divisor = 10n ** BigInt(a.places - 6)
  const sign = a.n < 0n ? -1n : 1n
  const abs = a.n * sign
  let q = abs / divisor
  const remainder = abs % divisor
  if (remainder * 2n > divisor || (remainder * 2n === divisor && q % 2n === 1n)) q += 1n
  return q * sign
}
const zero = () => ({ n: 0n, places: 0 })
const dollars = (raw) => Number(micros(raw)) / 1000000
function decimalPlaces(v, places) {
  if (!finite(v)) return false
  const d = decimal(v)
  return d.places <= places || d.n % (10n ** BigInt(d.places - places)) === 0n
}
const money = (v, signed = false) => decimalPlaces(v, 6) && v >= (signed ? -999999.999999 : 0) && v <= 999999.999999
const pct = (v) => decimalPlaces(v, 1) && v >= -100 && v <= 100
const percentRounded = (v) => { const n = Math.sign(v) * Math.round(Math.abs(Math.max(-100, Math.min(100, v))) * 10) / 10; return Object.is(n, -0) ? 0 : n }
const creditMode = (mode) => mode === 'extra_usage' || mode === 'cloud_credits'
const billingCounts = (mode, calls, planCalls, creditCalls) =>
  planCalls === (mode === 'subscription' ? calls : 0) && creditCalls === (creditMode(mode) ? calls : 0)


export function validateUsageReport(body, { now = Date.now(), clientVersion = '1.1.0', rateCardVersion = '2026-10-07' } = {}) {
  const time = typeof now === 'function' ? now() : now
  if (!finite(time) || !exact(body, ENVELOPE_KEYS) || body.schema_version !== 1 || !versionLabel(body.client_version) || !REPORT_CLIENT_VERSIONS.includes(body.client_version) || body.client_version !== clientVersion || !versionLabel(body.rate_card_version) || !REPORT_RATE_CARDS.includes(body.rate_card_version) || body.rate_card_version !== rateCardVersion) return false
  if (typeof body.reporting_run_id !== 'string' || !UUID4.test(body.reporting_run_id) || !integer(body.sequence, MAX_COUNT) || body.sequence === 0 || !validDay(body.usage_day, time) || typeof body.final !== 'boolean' || !Array.isArray(body.rows) || body.rows.length < 1 || body.rows.length > 64) return false
  let previous = null
  let calls = 0n; let routed = 0n; let actual = 0n; let saved = 0n
  let planCalls = 0n; let creditCalls = 0n; let skipped = 0n; let creditSaved = 0n
  const tokens = TOKEN_KEYS.map(() => 0n)
  for (const r of body.rows) {
    const extended = exact(r, EXTENDED_ROW_KEYS)
    if ((!extended && !exact(r, ROW_KEYS)) || !['api', 'subscription', 'unknown'].includes(r.plan_type) || typeof r.plan_type_overridden !== 'boolean' || !MODEL_SET.has(r.model) || !['complete', 'incomplete'].includes(r.usage_status)) return false
    const identity = rowIdentity(r)
    if (previous !== null && identity <= previous) return false
    previous = identity
    if (!integer(r.calls, MAX_COUNT) || !integer(r.routed_calls, MAX_COUNT) || r.routed_calls > r.calls || !TOKEN_KEYS.every((k) => integer(r[k], MAX_TOKENS)) || !money(r.api_equivalent_usd) || (r.est_saved_usd !== null && !money(r.est_saved_usd, true)) || (r.est_saved_weekly_pct !== null && !pct(r.est_saved_weekly_pct))) return false
    if ((r.plan_type !== 'subscription' || r.usage_status === 'incomplete' || r.est_saved_usd === null) && r.est_saved_weekly_pct !== null) return false
    if (r.usage_status === 'incomplete' && r.est_saved_usd !== null) return false
    if (r.model === 'unknown' && (r.usage_status !== 'incomplete' || r.est_saved_usd !== null || r.est_saved_weekly_pct !== null)) return false
    if (extended) {
      if (!REPORT_BILLING_MODES.includes(r.billing_mode) || !integer(r.plan_calls, MAX_COUNT) || !integer(r.credit_calls, MAX_COUNT) || !integer(r.prompts_skipped_no_usage, MAX_COUNT) || !integer(r.families_exhausted_count, 5) || !billingCounts(r.billing_mode, r.calls, r.plan_calls, r.credit_calls) || (r.est_saved_credit_usd !== null && !money(r.est_saved_credit_usd, true))) return false
      if (r.billing_mode !== 'subscription' && r.est_saved_weekly_pct !== null) return false
      if ((!creditMode(r.billing_mode) || r.credit_calls === 0 || r.usage_status === 'incomplete' || r.est_saved_usd === null) && r.est_saved_credit_usd !== null) return false
      if (r.est_saved_credit_usd !== null && r.est_saved_credit_usd !== r.est_saved_usd) return false
      if (r.calls === 0 && (r.prompts_skipped_no_usage === 0 || r.model !== 'unknown' || r.usage_status !== 'incomplete' || r.api_equivalent_usd !== 0 || TOKEN_KEYS.some((k) => r[k] !== 0))) return false
      planCalls += BigInt(r.plan_calls); creditCalls += BigInt(r.credit_calls); skipped += BigInt(r.prompts_skipped_no_usage)
      if (r.est_saved_credit_usd !== null) creditSaved += micros(decimal(r.est_saved_credit_usd))
    }
    calls += BigInt(r.calls); routed += BigInt(r.routed_calls); actual += micros(decimal(r.api_equivalent_usd))
    if (r.est_saved_usd !== null) saved += micros(decimal(r.est_saved_usd))
    TOKEN_KEYS.forEach((k, i) => { tokens[i] += BigInt(r[k]) })
  }
  if (calls > BigInt(MAX_COUNT) || routed > BigInt(MAX_COUNT) || planCalls > BigInt(MAX_COUNT) || creditCalls > BigInt(MAX_COUNT) || skipped > BigInt(MAX_COUNT) || actual > MAX_MICROS || saved > MAX_MICROS || saved < -MAX_MICROS || creditSaved > MAX_MICROS || creditSaved < -MAX_MICROS || tokens.some((v) => v > BigInt(MAX_TOKENS))) return false
  
  return JSON.stringify(body).length <= 32768
}

function randomUuid() {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') { const id = globalThis.crypto.randomUUID(); return UUID4.test(id) ? id : null }
    if (typeof globalThis.crypto?.getRandomValues !== 'function') return null
    const b = globalThis.crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128
    const h = Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('')
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20)
  } catch (_) { return null }
}

const BILLING_FACT_KEYS = ['billingMode', 'planCalls', 'creditCalls', 'promptsSkippedNoUsage', 'familiesExhaustedCount', 'estSavedCreditUsd']
const FACT_KEYS = new Set(['planType', 'overridden', 'model', 'actualUsd', 'savedUsd', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'complete', 'routed', 'completedAt', 'weeklyWindow', 'weeklyCapacityUsd', 'calls', ...BILLING_FACT_KEYS])
function numericFact(f, time) {
  if (!f || typeof f !== 'object' || Array.isArray(f) || Object.keys(f).some((k) => !FACT_KEYS.has(k)) || !['api', 'subscription', 'unknown'].includes(f.planType) || typeof f.overridden !== 'boolean' || typeof f.complete !== 'boolean' || typeof f.routed !== 'boolean') return null
  const completedAt = f.completedAt === undefined ? time : f.completedAt
  if (!finite(completedAt) || !validDay(utcDay(completedAt), time) || completedAt > time) return null
  const buckets = [f.inputTokens, f.outputTokens, f.cacheReadTokens, f.cacheWriteTokens]
  if (!buckets.every((v) => integer(v, MAX_TOKENS))) return null
  if (f.actualUsd !== null && (!finite(f.actualUsd) || f.actualUsd < 0 || f.actualUsd > 999999.999999)) return null
  if (f.savedUsd !== null && (!finite(f.savedUsd) || Math.abs(f.savedUsd) > 999999.999999)) return null
  if (f.weeklyWindow !== undefined && f.weeklyWindow !== null && !finite(f.weeklyWindow)) return null
  if (f.weeklyCapacityUsd !== undefined && f.weeklyCapacityUsd !== null && (!finite(f.weeklyCapacityUsd) || f.weeklyCapacityUsd <= 0)) return null
  const extended = BILLING_FACT_KEYS.some((k) => Object.hasOwn(f, k))
  const calls = f.calls === undefined ? 1 : f.calls
  if (calls !== 1 && calls !== 0) return null
  let billing = null
  if (extended) {
    if (!BILLING_FACT_KEYS.every((k) => Object.hasOwn(f, k)) || !REPORT_BILLING_MODES.includes(f.billingMode) || !integer(f.planCalls, MAX_COUNT) || !integer(f.creditCalls, MAX_COUNT) || !integer(f.promptsSkippedNoUsage, MAX_COUNT) || !integer(f.familiesExhaustedCount, 5) || !billingCounts(f.billingMode, calls, f.planCalls, f.creditCalls) || (f.estSavedCreditUsd !== null && (!finite(f.estSavedCreditUsd) || Math.abs(f.estSavedCreditUsd) > 999999.999999))) return null
    if ((!creditMode(f.billingMode) || !f.complete || f.savedUsd === null || calls === 0) && f.estSavedCreditUsd !== null) return null
    if (f.estSavedCreditUsd !== null && f.estSavedCreditUsd !== f.savedUsd) return null
    if (calls === 0 && (f.billingMode !== 'subscription' && f.billingMode !== 'unknown' || f.promptsSkippedNoUsage === 0 || f.complete || f.routed || f.model !== 'unknown' || f.actualUsd !== null || f.savedUsd !== null || buckets.some((v) => v !== 0))) return null
    billing = { billingMode: f.billingMode, planCalls: f.planCalls, creditCalls: f.creditCalls, skipped: f.promptsSkippedNoUsage, exhausted: f.familiesExhaustedCount, creditSaved: f.estSavedCreditUsd }
  } else if (calls !== 1) return null
  const model = normalizeReportModel(f.model)
  const complete = f.complete && model !== 'unknown' && f.actualUsd !== null
  return { model, planType: f.planType, overridden: f.overridden, complete, routed: f.routed, actual: model === 'unknown' ? null : f.actualUsd, saved: complete ? f.savedUsd : null, buckets, calls, billing, day: utcDay(completedAt), window: f.weeklyWindow ?? null, capacity: f.weeklyCapacityUsd ?? null }
}




export function newUsageReportClient({ now = Date.now, later = (ms, fn) => { const timer = setTimeout(fn, ms); return { cancel: () => clearTimeout(timer) } }, fetch, eligibility, nonce, clientVersion = '1.1.0', rateCardVersion = '2026-10-07' }) {
  const makeNonce = () => { const id = typeof nonce === 'function' ? nonce() : nonce; return id === undefined ? randomUuid() : typeof id === 'string' && UUID4.test(id) ? id : null }
  let runId = makeNonce()
  let alive = true; let active = false; let generation = 0; let sequence = 0; let busy = false; let lastSend = null
  let sessionBlocked = null; let cappedUntil = 0; let stopped = !runId || !REPORT_CLIENT_VERSIONS.includes(clientVersion) || !REPORT_RATE_CARDS.includes(rateCardVersion)
  let context = null; let timer = null; let retry = null; let finalPending = false; let ended = false; let freshObservation = false
  let days = new Map(); let observationChain = Promise.resolve()
  let currentWeekly = { window: null, capacity: null }
  const dropOldWindows = (window) => { for (const day of days.values()) for (const row of day.rows.values()) for (const tag of row.windows.keys()) if (tag !== window) row.windows.delete(tag) }
  const cancelTimer = () => { if (timer && typeof timer.cancel === 'function') timer.cancel(); timer = null }
  const invalidate = () => { generation += 1; active = false; freshObservation = false; cancelTimer(); retry = null; finalPending = false }
  const contextOf = (gate) => gate && typeof gate === 'object' ? { token: gate.context, key: gate.key, base: gate.base, dev: gate.dev === true } : null
  const sameContext = (a, b) => a === b || (!!a && !!b && a.token === b.token && a.key === b.key && a.base === b.base && a.dev === b.dev)
  function acceptContext(gate) {
    const next = contextOf(gate)
    if (!next) return
    if (context && !sameContext(context, next)) {
      invalidate(); days = new Map(); currentWeekly = { window: null, capacity: null }
      
      runId = typeof nonce === 'function' || nonce === undefined ? makeNonce() : randomUuid()
      if (!runId) stopped = true
    }
    context = next
  }
  async function gate() {
    const gen = generation
    let result
    try { result = await eligibility() } catch (_) { result = false }
    if (!alive || generation !== gen) return null
    const eligible = result === true || !!(result && typeof result === 'object' && result.eligible === true)
    if (!eligible) { invalidate(); return null }
    acceptContext(result)
    active = true
    return { value: result, generation }
  }
  function prune() {
    const time = now()
    for (const day of days.keys()) if (!validDay(day, time)) days.delete(day)
    if (retry && !validDay(retry.body.usage_day, time)) retry = null
  }
  function rowsOf(day) {
    return Array.from(day.rows.values()).map((r) => {
      let weekly = null
      if (r.plan_type === 'subscription' && (!Object.hasOwn(r, 'billing_mode') || r.billing_mode === 'subscription') && r.complete && r.savedKnown && currentWeekly.window !== null && currentWeekly.capacity !== null) {
        const w = r.windows.get(currentWeekly.window)
        if (w && w.known) weekly = percentRounded(100 * dollars(w.saved) / currentWeekly.capacity)
      }
      return { plan_type: r.plan_type, plan_type_overridden: r.plan_type_overridden, model: r.model, calls: r.calls, routed_calls: r.routed_calls, input_tokens: r.tokens[0], output_tokens: r.tokens[1], cache_read_tokens: r.tokens[2], cache_write_tokens: r.tokens[3], api_equivalent_usd: dollars(r.actual), est_saved_usd: r.complete && r.savedKnown ? dollars(r.saved) : null, est_saved_weekly_pct: weekly, usage_status: r.complete ? 'complete' : 'incomplete',
        ...(Object.hasOwn(r, 'billing_mode') ? { billing_mode: r.billing_mode, plan_calls: r.planCalls, credit_calls: r.creditCalls, prompts_skipped_no_usage: r.skipped, families_exhausted_count: r.exhausted, est_saved_credit_usd: creditMode(r.billing_mode) && r.creditCalls > 0 && r.complete && r.creditSavedKnown ? dollars(r.creditSaved) : null } : {}) }
    }).sort((a, b) => rowIdentity(a) < rowIdentity(b) ? -1 : rowIdentity(a) > rowIdentity(b) ? 1 : 0)
  }
  function bodyOf(dayName, final) {
    const day = days.get(dayName)
    if (!day || sequence >= MAX_COUNT) { stopped = true; invalidate(); return null }
    const body = { schema_version: 1, client_version: clientVersion, rate_card_version: rateCardVersion, reporting_run_id: runId, sequence: sequence + 1, usage_day: dayName, final, rows: rowsOf(day) }
    if (!validateUsageReport(body, { now: now(), clientVersion, rateCardVersion })) { stopped = true; invalidate(); return null }
    return { body, text: JSON.stringify(body), revision: day.revision, retried: false, window: currentWeekly.window, capacity: currentWeekly.capacity }
  }
  const blocked = () => !alive || !active || !freshObservation || stopped || sessionBlocked !== null || now() < cappedUntil
  function dirtyDay() {
    
    return Array.from(days.keys()).sort().find((d) => days.get(d).revision > days.get(d).attempted)
  }
  function schedule() {
    cancelTimer(); prune()
    if (blocked() || busy || (!retry && !finalPending && !dirtyDay())) return
    const delay = finalPending && !retry ? 0 : lastSend === null ? 0 : Math.max(0, lastSend + USAGE_REPORT_INTERVAL_MS - now())
    const gen = generation
    timer = later(delay, () => { timer = null; if (alive && generation === gen) void send() })
  }
  async function send() {
    if (blocked() || busy) return false
    prune()
    if (!retry && !finalPending && !dirtyDay()) return false
    if ((!finalPending || retry) && lastSend !== null && now() - lastSend < USAGE_REPORT_INTERVAL_MS) { schedule(); return false }
    const checked = await gate()
    if (!checked || blocked() || busy || generation !== checked.generation) { schedule(); return false }
    const authorized = checked.value
    const url = baseUrl(authorized.base, authorized.dev === true)
    if (!url || typeof authorized.key !== 'string' || authorized.key.trim() === '') { invalidate(); return false }
    const dayName = retry ? retry.body.usage_day : finalPending ? Array.from(days.keys()).sort().reverse()[0] : dirtyDay()
    if (!dayName) { finalPending = false; return false }
    const attempt = retry || bodyOf(dayName, finalPending)
    if (!attempt) return false
    const isRetry = retry === attempt
    retry = null; finalPending = false
    if (!isRetry) sequence = attempt.body.sequence
    const day = days.get(dayName)
    if (day) day.attempted = Math.max(day.attempted, attempt.revision)
    busy = true; lastSend = now()
    const gen = generation
    let expired = false
    const deadlineTimer = later(USAGE_REPORT_TIMEOUT_MS, () => { expired = true })
    const headers = { 'content-type': 'application/json', accept: 'application/json', authorization: 'Bearer ' + authorized.key.trim() }
    
    Promise.resolve().then(async () => {
      if (!alive || generation !== gen) return null
      const actualGate = await gate()
      if (!actualGate || !alive || generation !== gen || actualGate.generation !== gen || blocked()) return null
      const actual = actualGate.value
      if (attempt.window !== currentWeekly.window || attempt.capacity !== currentWeekly.capacity) return null
      if (typeof actual.key !== 'string' || actual.key.trim() === '' || baseUrl(actual.base, actual.dev === true) !== url) return null
      return fetch(url + '/iq-code/usage-reports', { method: 'POST', headers: { ...headers, authorization: 'Bearer ' + actual.key.trim() }, body: attempt.text })
    }).then((res) => {
      if (!alive || generation !== gen || !res) return
      if (res.status === 402 || res.status === 404) { sessionBlocked = res.status; invalidate(); return }
      if (res.status === 429) { cappedUntil = (Math.floor(now() / DAY_MS) + 1) * DAY_MS; invalidate(); return }
      
      if (res.status === 204) return
      if ((res.status >= 500 || res.status === 408) && !attempt.retried && validDay(attempt.body.usage_day, now())) retry = { ...attempt, retried: true }
      
      void expired
    }, () => {
      if (alive && generation === gen && !attempt.retried && validDay(attempt.body.usage_day, now())) retry = { ...attempt, retried: true }
    }).finally(() => {
      if (deadlineTimer && typeof deadlineTimer.cancel === 'function') deadlineTimer.cancel()
      busy = false
      if (alive) schedule()
    })
    return true
  }
  function commit(f) {
    let day = days.get(f.day)
    if (!day) { day = { rows: new Map(), revision: 0, attempted: 0 }; days.set(f.day, day) }
    const identity = rowIdentity({ model: f.model, plan_type: f.planType, plan_type_overridden: f.overridden, ...(f.billing ? { billing_mode: f.billing.billingMode } : {}) })
    let r = day.rows.get(identity)
    if (!r) {
      if (day.rows.size >= 64) { stopped = true; invalidate(); return false }
      r = { model: f.model, plan_type: f.planType, plan_type_overridden: f.overridden, calls: 0, routed_calls: 0, tokens: [0, 0, 0, 0], actual: zero(), saved: zero(), savedKnown: true, complete: true, windows: new Map() }
      if (f.billing) Object.assign(r, { billing_mode: f.billing.billingMode, planCalls: 0, creditCalls: 0, skipped: 0, exhausted: 0, creditSaved: zero(), creditSavedKnown: true })
      day.rows.set(identity, r)
    }
    r.calls += f.calls; if (f.routed) r.routed_calls += 1
    if (f.billing) {
      r.planCalls += f.billing.planCalls; r.creditCalls += f.billing.creditCalls; r.skipped += f.billing.skipped
      r.exhausted = Math.max(r.exhausted, f.billing.exhausted)
      r.creditSavedKnown = r.creditSavedKnown && f.billing.creditSaved !== null
      if (f.billing.creditSaved !== null) r.creditSaved = addDecimal(r.creditSaved, decimal(f.billing.creditSaved))
    }
    f.buckets.forEach((v, i) => { r.tokens[i] += v })
    if (f.actual !== null) r.actual = addDecimal(r.actual, decimal(f.actual))
    r.complete = r.complete && f.complete; r.savedKnown = r.savedKnown && f.saved !== null
    if (f.saved !== null) r.saved = addDecimal(r.saved, decimal(f.saved))
    if (f.planType === 'subscription') {
      if (f.window !== null) {
        if (currentWeekly.window === null || f.window > currentWeekly.window) { currentWeekly = { window: f.window, capacity: f.capacity }; dropOldWindows(f.window) }
        
        if (currentWeekly.window === f.window) {
          let w = r.windows.get(f.window)
          if (!w) { w = { saved: zero(), known: true }; r.windows.set(f.window, w) }
          w.known = w.known && f.saved !== null && f.complete
          if (f.saved !== null) w.saved = addDecimal(w.saved, decimal(f.saved))
        }
      }
    }
    day.revision += 1
    
    const probe = { schema_version: 1, client_version: clientVersion, rate_card_version: rateCardVersion, reporting_run_id: runId, sequence: Math.max(1, sequence), usage_day: f.day, final: false, rows: rowsOf(day) }
    if (!validateUsageReport(probe, { now: now(), clientVersion, rateCardVersion })) { stopped = true; invalidate(); return false }
    return true
  }
  return {
    observe(fact) {
      
      let f
      try { f = numericFact(fact, now()) } catch (_) { return Promise.resolve(false) }
      if (!f || !alive || stopped) return Promise.resolve(false)
      const gen = generation
      const work = observationChain.then(async () => {
        if (!alive || stopped || gen !== generation) return false
        const authorized = await gate()
        if (!authorized || !alive || stopped || gen !== generation || authorized.generation !== generation) return false
        prune()
        if (!commit(f)) return false
        freshObservation = true
        
        if (!blocked() && !busy && lastSend === null) void send()
        else schedule()
        return true
      })
      observationChain = work.catch(() => false)
      return work
    },
    setWeekly({ window = null, capacityUsd = null } = {}) {
      if (!alive || stopped || (window !== null && !finite(window)) || (capacityUsd !== null && (!finite(capacityUsd) || capacityUsd <= 0))) return false
      if (window !== null && currentWeekly.window !== null && window < currentWeekly.window) return false
      if (currentWeekly.window === window && currentWeekly.capacity === capacityUsd) return true
      currentWeekly = { window, capacity: capacityUsd }
      if (retry && (retry.window !== window || retry.capacity !== capacityUsd)) retry = null
      dropOldWindows(window)
      for (const day of days.values()) day.revision += 1
      if (active && freshObservation) schedule(); return true
    },
    invalidate,
    async refresh() { if (!alive) return false; const authorized = await gate(); return !!authorized },
    async end() {
      if (!alive || stopped || ended) return false
      ended = true
      await observationChain
      const authorized = await gate()
      if (!authorized || blocked() || days.size === 0) return false
      cancelTimer(); finalPending = true
      if (busy || retry) { schedule(); return false }
      return send()
    },
    dispose() { alive = false; invalidate(); days.clear(); context = null },
    current: () => ({ sequence, inFlight: busy, sessionBlocked, cappedUntil, stopped, reportingRunId: runId, rows: Array.from(days.entries()).map(([usageDay, day]) => ({ usageDay, rows: rowsOf(day) })) }),
  }
}
