
import { baseUrl, isFreePlan } from './iq_client.js'
export const FORECAST_TIMEOUT_MS = 1500
export const FORECAST_INTERVAL_MS = 30000
export const FORECAST_CALL_INTERVAL = 4
export const FORECAST_TEXT = {
  not_paid: 'Cost estimates need the Personal plan. Measured usage is shown.',
  capped: 'Daily cost estimate allowance reached. Measured usage is still shown.',
}

const TERMINAL_REASONS = new Set(['long_session', 'compacted', 'helpers_seen'])
const MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5', 'claude-haiku-5-5', 'claude-fable-5-1'])
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'unspecified'])
const TYPES = new Set(['explore', 'plan', 'general-purpose', 'unknown'])
const ALIASES = new Set(['haiku', 'sonnet', 'opus'])
const finite = (v) => typeof v === 'number' && Number.isFinite(v)
const cents = (v) => finite(v) && v >= 0 && v <= 999999.99 && Math.abs(v * 100 - Math.round(v * 100)) < 1e-7
const exact = (obj, keys) => obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k))
const RESPONSE_KEYS = ['version', 'session_nonce', 'sequence', 'status', 'reason_code', 'scope', 'cost_unit', 'remaining_q50_usd', 'total_q50_usd', 'price_sheet']
export function featureBody(observed, nonce, sequence) {
  const x = observed || {}
  const integer = (v, max) => Number.isInteger(v) && v >= 0 && v <= max
  if (!MODELS.has(x.model) || !EFFORTS.has(x.effort)) return null
  if (![x.calls_observed, x.context_epoch].every((v) => integer(v, 2147483647)) || !integer(x.active_s, 86400000) || !integer(x.helpers_active, 1000)) return null
  if (!cents(Math.round(x.spent_usd * 100) / 100) || !finite(x.spent_usd) || x.spent_usd < 0 || x.spent_usd > 999999.99) return null
  if (!['initial', 'steady', 'compacted', 'resumed'].includes(x.lifecycle) || !['complete', 'incomplete'].includes(x.usage_status)) return null
  for (const k of ['context_tokens', 'cache_read_tokens']) if (x[k] !== null && !integer(x[k], 2000000)) return null
  const body = { version: 1, session_nonce: nonce, sequence, model: x.model, effort: x.effort, context_tokens: x.context_tokens, cache_read_tokens: x.cache_read_tokens, calls_observed: x.calls_observed, spent_usd: x.spent_usd, active_s: x.active_s, helpers_active: x.helpers_active, context_epoch: x.context_epoch, lifecycle: x.lifecycle, usage_status: x.usage_status }
  return JSON.stringify(body).length <= 768 ? body : null
}
export function parseForecast(text, nonce, sequence) {
  if (typeof text !== 'string' || text.length > 8192) return null
  let j
  try { j = JSON.parse(text) } catch (_) { return null }
  if (!exact(j, RESPONSE_KEYS) || j.version !== 1 || j.session_nonce !== nonce || j.sequence !== sequence || j.scope !== 'session' || j.cost_unit !== 'api_equivalent_usd') return null
  if (!['available', 'unavailable'].includes(j.status) || typeof j.reason_code !== 'string' || !/^[a-z_]{1,64}$/.test(j.reason_code)) return null
  if (j.status === 'available' ? !cents(j.remaining_q50_usd) || !cents(j.total_q50_usd) || j.total_q50_usd < j.remaining_q50_usd : j.remaining_q50_usd !== null || j.total_q50_usd !== null) return null
  if (j.price_sheet !== null) {
    const s = j.price_sheet
    if (!exact(s, ['version', 'as_of_sequence', 'ttl_s', 'entries']) || s.version !== 1 || s.as_of_sequence !== sequence || !Number.isInteger(s.ttl_s) || s.ttl_s < 1 || s.ttl_s > 120 || !Array.isArray(s.entries) || s.entries.length > 12) return null
    const seen = new Set()
    for (const e of s.entries) {
      if (!exact(e, ['agent_type', 'model_alias', 'expected_usd']) || !TYPES.has(e.agent_type) || !ALIASES.has(e.model_alias) || !cents(e.expected_usd)) return null
      const id = e.agent_type + ':' + e.model_alias
      if (seen.has(id)) return null
      seen.add(id)
    }
  }
  return j
}
export function newForecastClient({ nonce, now, later, fetch, onChange }) {
  const randomNonce = nonce || Math.floor(Math.random() * (Number.MAX_SAFE_INTEGER - 1)) + 1
  let sequence = 0
  let alive = true
  let busy = false
  let generation = 0
  let forecast = null
  let sheet = null
  let sheetExpires = 0
  let sessionBlocked = null
  let cappedUntil = 0
  let lastRequestAt = null
  let lastRequestCalls = 0
  let reasonCode = 'estimate_pending_first_call'
  let terminal = null
  const clear = (code, reason = 'forecast_unavailable') => {
    forecast = null; sheet = null; sheetExpires = 0
    
    reasonCode = code === 'unavailable' && terminal ? terminal : reason
    onChange({ state: code, reasonCode, pending: false, forecast: null })
  }
  const invalidate = (reason = 'forecast_unavailable') => { generation += 1; clear(sessionBlocked || (now() < cappedUntil ? 'capped' : 'unavailable'), reason) }
  return {
    request(observed, key, base, dev = false, usage = null) {
      if (!alive) return false
      if (sessionBlocked) { clear(sessionBlocked); return false }
      if (now() < cappedUntil) { clear('capped'); return false }
      if (terminal) { clear('unavailable'); return false }
      if (isFreePlan(usage)) { clear('not_paid'); return false }
      if (busy) return false
      if (!observed || observed.calls_observed === 0) return false
      if (lastRequestAt !== null && (now() - lastRequestAt < FORECAST_INTERVAL_MS || observed.calls_observed - lastRequestCalls < FORECAST_CALL_INTERVAL)) return false
      const url = baseUrl(base, dev)
      const seq = sequence + 1
      const body = featureBody(observed, randomNonce, seq)
      if (!url || !body || typeof key !== 'string' || !key.trim()) { clear('unavailable'); return false }
      sequence = seq
      busy = true
      lastRequestAt = now()
      lastRequestCalls = observed.calls_observed
      const gen = ++generation
      onChange({ state: forecast ? 'available' : 'unavailable', reasonCode, pending: true, forecast })
      const deadline = now() + FORECAST_TIMEOUT_MS
      
      
      const timer = later(FORECAST_TIMEOUT_MS, () => { if (alive && generation === gen && busy) { generation += 1; clear('unavailable') } })
      
      Promise.resolve().then(() => fetch(url + '/iq-code/forecast', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: 'Bearer ' + key.trim() }, body: JSON.stringify(body) })).then((res) => {
        if (!alive) return
        if (res && res.status === 402) sessionBlocked = 'not_paid'
        if (res && res.status === 404) sessionBlocked = 'unavailable'
        if (res && res.status === 429) cappedUntil = (Math.floor(now() / 86400000) + 1) * 86400000
        if (sessionBlocked || now() < cappedUntil) { clear(sessionBlocked || 'capped'); return }
        if (generation !== gen) return
        if (now() >= deadline) { clear('unavailable'); return }
        
        if (res && res.status === 503 && forecast) { onChange({ state: 'available', reasonCode, pending: true, forecast }); return }
        if (!res || res.status !== 200) { clear(res && res.status === 402 ? 'not_paid' : res && res.status === 429 ? 'capped' : 'unavailable'); return }
        const parsed = parseForecast(res.text, randomNonce, seq)
        if (!parsed) { clear('unavailable'); return }
        if (parsed.status !== 'available') {
          
          
          if (TERMINAL_REASONS.has(parsed.reason_code) || (parsed.reason_code === 'usage_incomplete' && observed.usage_status === 'incomplete')) terminal = parsed.reason_code
          clear('unavailable', parsed.reason_code); return
        }
        forecast = parsed
        reasonCode = parsed.reason_code
        sheet = parsed.price_sheet
        sheetExpires = sheet ? now() + sheet.ttl_s * 1000 : 0
        if (sheet) { const expectedSheet = sheet; later(sheet.ttl_s * 1000, () => { if (sheet === expectedSheet) { sheet = null; sheetExpires = 0 } }) }
        onChange({ state: 'available', reasonCode, pending: false, forecast: parsed })
      }, () => { if (alive && generation === gen) clear('unavailable') }).finally(() => { if (timer && timer.cancel) timer.cancel(); busy = false })
      return true
    },
    price(agentType, alias) {
      if (!alive || !sheet || now() >= sheetExpires) return null
      const type = TYPES.has(String(agentType).toLowerCase()) ? String(agentType).toLowerCase() : 'unknown'
      const entry = sheet.entries.find((e) => e.agent_type === type && e.model_alias === alias)
      return entry ? entry.expected_usd : null
    },
    current: () => forecast,
    invalidate,
    
    
    newEpoch() { if (terminal === 'helpers_seen' || terminal === 'long_session') terminal = 'compacted'; invalidate('compacted') },
    end() { alive = false; generation += 1; busy = false; forecast = null; sheet = null; sheetExpires = 0 },
  }
}
