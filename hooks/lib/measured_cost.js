import { priceId } from './models.js'
import { extraPasses } from './pricing.js'



const count = (v) => Number.isSafeInteger(v) && v >= 0
const money = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0
const keys = ['input', 'cache_read', 'cache_write_5m', 'cache_write_1h', 'output', 'thinking']

export function measuredTokens(usage, main = false, writeTtl = null) {
  const u = usage || {}, missing = []
  const read = (key) => { if (count(u[key])) return u[key]; missing.push(key); return null }
  const input = read('input_tokens'), outputTotal = read('output_tokens')
  const cacheRead = read('cache_read_input_tokens'), writes = read('cache_creation_input_tokens')
  let w5 = writes === 0 ? 0 : null, w1 = writes === 0 ? 0 : null
  if (writes !== null && writes > 0) {
    const split = u.cache_creation
    if (split && typeof split === 'object') {
      const a = split.ephemeral_5m_input_tokens, b = split.ephemeral_1h_input_tokens
      if (!count(a) || !count(b) || a + b > writes) missing.push('cache_creation_split')
      else {
        const rest = writes - a - b
        
        w5 = a + rest; w1 = b
      }
    } else if (writeTtl === 300 || writeTtl === 3600) { w5 = writeTtl === 300 ? writes : 0; w1 = writeTtl === 3600 ? writes : 0 }
    else missing.push('cache_creation_split')
  }
  
  
  const explicitThinking = u.thinking_tokens ?? u.reasoning_tokens ?? u.output_tokens_details?.reasoning_tokens
  let thinking = null, output = outputTotal
  if (explicitThinking !== undefined && explicitThinking !== null) {
    if (!count(explicitThinking) || outputTotal === null || explicitThinking > outputTotal) missing.push('thinking_tokens')
    else { thinking = explicitThinking; output = outputTotal - thinking }
  }
  return { usage: { input, cache_read: cacheRead, cache_write_5m: w5, cache_write_1h: w1, output, thinking }, missing }
}

function priceClasses(pricer, model, tokens, passes = 1) {
  const hit = pricer.resolve(priceId(model))
  if (!hit) return { usd: null, missing: ['model_rate'] }
  const context = (tokens.input + tokens.cache_read + tokens.cache_write_5m + tokens.cache_write_1h) / Math.max(1, passes)
  
  const r = hit.row.tier_break_tokens && context > hit.row.tier_break_tokens && hit.row.tier_above ? hit.row.tier_above : hit.row
  const rates = { input: r.input, cache_read: r.cache_read, cache_write_5m: r.cache_write_5m,
    cache_write_1h: r.cache_write_1h, output: r.output, thinking: r.output }
  const missing = [], parts = {}
  for (const key of keys) {
    const n = tokens[key]
    if (n === null && key === 'thinking') continue 
    if (!money(rates[key]) && (n > 0 || key === 'input' || key === 'output')) missing.push(key + '_rate')
    else parts[key] = n === 0 ? 0 : n * rates[key] / 1e6
  }
  return { usd: missing.length ? null : Object.values(parts).reduce((a, b) => a + b, 0), missing }
}




export function rebuildDebit(pricer, { named, usage, prev, startMs, ttlMs, switched = false, writeTtl = null, advisorCalls = 0 } = {}) {
  if (!switched && !prev?.routed) return 0
  const tokens = measuredTokens(usage, true, writeTtl)
  if (tokens.missing.length || !named?.model) return null
  const cacheStartMs = prev?.startMs ?? prev?.endMs
  if (!prev || !(prev.ctx > 0) || !(ttlMs > 0) || !Number.isFinite(cacheStartMs) || !Number.isFinite(startMs)) return 0
  if (startMs - cacheStartMs >= ttlMs || startMs < cacheStartMs) return 0
  const u = tokens.usage
  if (u.input + u.cache_read + u.cache_write_5m + u.cache_write_1h < prev.ctx) return 0
  const move = Math.max(0, Math.min(u.cache_write_5m + u.cache_write_1h, prev.ctx - u.cache_read))
  if (move === 0) return 0
  const from1 = Math.min(move, u.cache_write_1h)
  const warm = { ...u, cache_read: u.cache_read + move, cache_write_1h: u.cache_write_1h - from1,
    cache_write_5m: u.cache_write_5m - (move - from1) }
  const passes = responsePasses(usage, named.model, advisorCalls)
  const full = priceClasses(pricer, named.model, u, passes), held = priceClasses(pricer, named.model, warm, passes)
  return full.usd === null || held.usd === null ? null : Math.max(0, full.usd - held.usd)
}








export function measureCall(pricer, { model, effort = null, named = null, usage, main = false,
  switched = false, rebuildUsd, skipped = false, writeTtl = null, advisorCalls = 0 } = {}) {
  const tokens = measuredTokens(usage, main, writeTtl)
  const passes = responsePasses(usage, model, advisorCalls)
  const actual = tokens.missing.length ? { usd: null, missing: [] } : priceClasses(pricer, model, tokens.usage, passes)
  let paidComplete = tokens.missing.length === 0 && actual.usd !== null
  const namedEffortKnown = (typeof named?.effort === 'string' && named.effort.length > 0) || (typeof named?.effort === 'number' && Number.isFinite(named.effort))
  const baseline = !named?.model || !namedEffortKnown || tokens.missing.length ? { usd: null, missing: [] } : priceClasses(pricer, named.model, tokens.usage, passes)
  const penalty = rebuildUsd === undefined && !switched ? 0 : money(rebuildUsd) ? rebuildUsd : null
  const missing = [...tokens.missing, ...actual.missing, ...baseline.missing.map((k) => 'baseline_' + k)]
  if (!named?.model) missing.push('named_model')
  if (!namedEffortKnown) missing.push('named_effort')
  if (!skipped && penalty === null) missing.push('rebuild_debit_usd')
  
  const extras = extraPasses(usage, model)
  for (const pass of extras) {
    const t = measuredTokens(pass.usage, false, 300)
    const a = t.missing.length ? { usd: null, missing: t.missing } : priceClasses(pricer, pass.model, t.usage)
    const baselineModel = pass.type === 'advisor_message' ? pass.model : named?.model
    const b = !baselineModel || t.missing.length ? { usd: null, missing: t.missing } : priceClasses(pricer, baselineModel, t.usage)
    if (a.usd === null || b.usd === null) missing.push('extra_pass')
    if (a.usd === null) paidComplete = false
    actual.usd = actual.usd === null && a.usd === null ? null : (actual.usd ?? 0) + (a.usd ?? 0)
    baseline.usd = baseline.usd === null || b.usd === null ? null : baseline.usd + b.usd
    for (const key of keys) {
      if (key === 'thinking' && (tokens.usage[key] === null || t.usage[key] === null)) tokens.usage[key] = null
      else tokens.usage[key] = tokens.usage[key] === null || t.usage[key] === null ? null : tokens.usage[key] + t.usage[key]
    }
  }
  const advisorUnpriced = Math.max(0, advisorCalls - extras.filter((p) => p.type === 'advisor_message').length)
  if (advisorUnpriced) { missing.push('advisor_usage'); paidComplete = false }
  const complete = missing.length === 0 && actual.usd !== null && baseline.usd !== null
  
  const saved = skipped ? penalty > 0 ? -penalty : 0 : complete ? baseline.usd - actual.usd - penalty : null
  return { model, effort, named_model: named?.model || null, named_effort: named?.effort ?? null,
    usage: tokens.usage, paid_usd: actual.usd, baseline_usd: baseline.usd,
    rebuild_debit_usd: penalty, saved_usd: saved,
    percent: saved !== null && baseline.usd > 0 ? 100 * saved / baseline.usd : null,
    complete, paid_complete: paidComplete && actual.usd !== null, missing, skipped, advisor_unpriced: advisorUnpriced, tokenizer_factor: 1 }
}

export function newMeasuredLedger() {
  return { calls: 0, paid_usd: 0, baseline_usd: 0, saved_usd: 0, rebuild_debit_usd: 0,
    percent: null, complete: true, missing: [], usage: Object.fromEntries(keys.map((k) => [k, 0])),
    model: null, effort: null, named_model: null, named_effort: null, skipped: true, paid_complete: true, unpriced_calls: 0 }
}

export function addMeasured(ledger, row) {
  if (!row) return ledger
  ledger.calls += 1
  
  ledger.paid_usd = (ledger.paid_usd ?? 0) + (money(row.paid_usd) ? row.paid_usd : 0)
  const paidComplete = money(row.paid_usd) && (row.paid_complete ?? row.complete) !== false
  if (!paidComplete) ledger.unpriced_calls = (ledger.unpriced_calls || 0) + 1
  for (const key of ['baseline_usd', 'saved_usd', 'rebuild_debit_usd']) {
    if (ledger[key] !== null) ledger[key] = typeof row[key] === 'number' && Number.isFinite(row[key]) ? ledger[key] + row[key] : null
  }
  for (const key of keys) {
    if (ledger.usage[key] !== null) ledger.usage[key] = count(row.usage?.[key]) ? ledger.usage[key] + row.usage[key] : null
  }
  for (const key of ['model', 'effort', 'named_model', 'named_effort']) {
    ledger[key] = ledger.calls === 1 ? row[key] : ledger[key] === row[key] ? ledger[key] : 'mixed'
  }
  ledger.skipped = ledger.skipped && !!row.skipped
  ledger.paid_complete = ledger.paid_complete && paidComplete
  ledger.complete = ledger.complete && !!row.complete
  ledger.missing = [...new Set(ledger.missing.concat(row.missing || []))]
  ledger.percent = ledger.saved_usd !== null && ledger.baseline_usd > 0 ? 100 * ledger.saved_usd / ledger.baseline_usd : null
  return ledger
}

export function measuredSnapshot(ledger) {
  return { ...ledger, usage: { ...ledger.usage }, missing: [...ledger.missing] }
}


function responsePasses(usage, model, advisorCalls) {
  const other = extraPasses(usage, model)
  const own = Array.isArray(usage?.iterations) ? usage.iterations.length - other.length : 1
  return Math.max(1, own, Number.isInteger(advisorCalls) ? advisorCalls + 1 : 1)
}

export function measuredPace(measured) {
  return measured && (measured.paid_complete ?? measured.complete) !== false && Number.isFinite(measured.paid_usd) &&
    Number.isFinite(measured.elapsed_ms) && measured.elapsed_ms >= 3 * 60 * 1000
    ? measured.paid_usd * 3600000 / measured.elapsed_ms : null
}
