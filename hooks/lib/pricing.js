


















const hasOwn = (obj, key) => obj !== null && obj !== undefined && Object.prototype.hasOwnProperty.call(obj, key)
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)


export function modelClass(model) {
  let m = typeof model === 'string' ? model.toLowerCase() : ''
  const br = m.indexOf('[')
  if (br >= 0) m = m.slice(0, br)
  if (m === '' || m === 'unrecorded' || m === 'none') return 'unrecorded'
  const families = ['opus', 'sonnet', 'fable', 'haiku', 'mythos']
  if (m.startsWith('claude-')) {
    for (const k of families) if (m.includes(k)) return 'claude-' + k
    return 'claude-other'
  }
  if (m.startsWith('auto')) return 'codex-auto'
  if (m.startsWith('gpt-')) {
    for (const k of ['sol', 'terra', 'luna', 'astra']) {
      if (m.endsWith(k) || m.includes('-' + k)) return 'gpt-' + k
    }
    return 'gpt-other'
  }
  
  for (const k of families) if (m === k || m.startsWith(k + '-')) return 'claude-' + k
  return 'other'
}


export function effortClass(e) {
  const s = typeof e === 'string' ? e.toLowerCase() : ''
  if (s === 'max' || s === 'ultra') return 'max'
  if (s === 'xhigh') return 'xhigh'
  if (s === 'high') return 'high'
  if (s === 'medium' || s === 'low' || s === 'minimal' || s === 'none') return 'low_med'
  return 'unknown'
}


export function contextTokensOf(usage) {
  if (!usage) return 0
  return num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens)
}

export function makePricer(card) {
  const rows = card.models
  const keys = Object.keys(rows).filter((k) => rows[k] && rows[k].priced !== false)
  const resolved = new Map()

  
  function resolve(model) {
    if (typeof model !== 'string' || model === '') return null
    if (resolved.has(model)) return resolved.get(model)
    let found = null
    if (hasOwn(rows, model) && rows[model].priced !== false) found = { key: model, row: rows[model] }
    else {
      let m = model
      const br = m.indexOf('[')
      if (br >= 0) m = m.slice(0, br)
      let best = null
      for (const k of keys) {
        if (m.startsWith(k) && (m.length === k.length || m[k.length] === '-') && (best === null || k.length > best.length)) best = k
      }
      if (best !== null) found = { key: best, row: rows[best] }
    }
    resolved.set(model, found)
    return found
  }

  
  function ratesFor(row, contextTokens) {
    const rIn = row.input
    const rOut = row.output
    const rCr = row.cache_read !== null && row.cache_read !== undefined ? row.cache_read : row.input
    const rW5 = row.cache_write_5m !== null && row.cache_write_5m !== undefined ? row.cache_write_5m : row.input
    const rW1 = row.cache_write_1h !== null && row.cache_write_1h !== undefined ? row.cache_write_1h : rW5
    if (row.tier_break_tokens && row.tier_above && contextTokens > row.tier_break_tokens) {
      const t = row.tier_above
      const aW5 = t.cache_write_5m !== null && t.cache_write_5m !== undefined ? t.cache_write_5m : rW5
      return {
        input: t.input,
        output: t.output,
        read: t.cache_read !== null && t.cache_read !== undefined ? t.cache_read : t.input,
        w5: aW5,
        w1: t.cache_write_1h !== null && t.cache_write_1h !== undefined ? t.cache_write_1h : aW5,
        isTier: true,
      }
    }
    return { input: rIn, output: rOut, read: rCr, w5: rW5, w1: rW1, isTier: false }
  }

  
  
  
  
  function price(model, usage, opts) {
    const isMain = !!(opts && opts.main)
    const inp = num(usage && usage.input_tokens)
    const out = num(usage && usage.output_tokens)
    const cr = num(usage && usage.cache_read_input_tokens)
    const cw = num(usage && usage.cache_creation_input_tokens)
    const split = usage && usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation : null
    const cw5 = split ? num(split.ephemeral_5m_input_tokens) : 0
    const cw1 = split ? num(split.ephemeral_1h_input_tokens) : 0
    const unsplit = Math.max(cw - cw5 - cw1, 0)
    const w5tokens = cw5 + (isMain ? 0 : unsplit)
    const w1tokens = cw1 + (isMain ? unsplit : 0)
    const context = inp + cr + cw
    const hit = resolve(model)
    const tokens = { input: inp, output: out, read: cr, write5: w5tokens, write1h: w1tokens }
    if (hit === null) return { usd: 0, priced: false, key: null, parts: null, tokens, context }
    const r = ratesFor(hit.row, context)
    const parts = {
      input: (inp * r.input) / 1e6,
      output: (out * r.output) / 1e6,
      read: (cr * r.read) / 1e6,
      write5: (w5tokens * r.w5) / 1e6,
      write1h: (w1tokens * r.w1) / 1e6,
    }
    const usd = parts.input + parts.read + parts.write5 + parts.write1h + parts.output
    return { usd, priced: true, key: hit.key, parts, tokens, context }
  }

  return { price, resolve, ratesFor }
}
