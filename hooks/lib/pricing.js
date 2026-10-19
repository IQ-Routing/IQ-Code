

























const hasOwn = (obj, key) => obj !== null && obj !== undefined && Object.prototype.hasOwnProperty.call(obj, key)
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
const isStr = (x) => typeof x === 'string' && x !== ''


const idOf = (id) => {
  if (typeof id !== 'string') return ''
  let m = id.trim().toLowerCase()
  const br = m.indexOf('[')
  if (br >= 0) m = m.slice(0, br)
  const slash = m.lastIndexOf('/')
  if (slash >= 0) m = m.slice(slash + 1)
  return m.replace(/-20\d{6}$/, '')
}
const sameId = (a, b) => idOf(a) !== '' && idOf(a) === idOf(b)




function ownPasses(usage, model) {
  const its = usage && Array.isArray(usage.iterations) ? usage.iterations : []
  const fallback = its.find((e) => e && typeof e === 'object' && e.type === 'fallback_message' && isStr(e.model))
  const ran = fallback ? fallback.model : isStr(usage && usage.model) ? usage.model : model
  const own = []
  const other = []
  for (const e of its) {
    if (!e || typeof e !== 'object' || !isStr(e.type)) continue
    if (e.type === 'fallback_message') own.push(e)
    else if (e.type === 'message' && (!isStr(e.model) || sameId(e.model, ran))) own.push(e)
    else other.push(e)
  }
  return { ran, own, other }
}


export function extraPasses(usage, model) {
  return ownPasses(usage, model).other.map((e) => ({ type: e.type, model: isStr(e.model) ? e.model : null, usage: e }))
}





export function latestCacheWriteTtlMs(usage, model) {
  const passes = Array.isArray(usage?.iterations) ? ownPasses(usage, model).own : [usage]
  let ttl = null
  for (const pass of passes) {
    const split = pass?.cache_creation
    if (num(split?.ephemeral_1h_input_tokens) > 0) return 3_600_000
    if (num(split?.ephemeral_5m_input_tokens) > 0) ttl = 300_000
  }
  return ttl
}




export function lastPass(usage, model) {
  const { own } = ownPasses(usage, model)
  const e = own.length > 0 ? own[own.length - 1] : null
  if (e === null) return null
  const prefix = num(e.cache_read_input_tokens) + num(e.cache_creation_input_tokens)
  return { ctx: num(e.input_tokens) + prefix, prefix }
}







export function mainPass(usage, model, advisorCalls) {
  const listed = lastPass(usage, model)
  if (listed !== null) return listed
  const prefix = num(usage && usage.cache_read_input_tokens) + num(usage && usage.cache_creation_input_tokens)
  const ctx = num(usage && usage.input_tokens) + prefix
  const calls = Number.isInteger(advisorCalls) && advisorCalls > 0 ? advisorCalls : 0
  return calls > 0 ? { ctx: Math.round(ctx / (calls + 1)), prefix: Math.round(prefix / (calls + 1)) } : { ctx, prefix }
}




export function advisorCallsIn(result) {
  const uses = result && Array.isArray(result.serverToolUses) ? result.serverToolUses : []
  let n = 0
  for (const u of uses) {
    if (u && typeof u === 'object' && typeof u.name === 'string' && u.name.trim().toLowerCase() === 'advisor' && u.endedAt !== undefined && u.endedAt !== null) n += 1
  }
  return n
}






export function booked(priced, advisorMade = 0) {
  const made = Number.isInteger(advisorMade) && advisorMade > 0 ? advisorMade : 0
  return { ...priced, usd: priced.usd + priced.extra.usd, own: priced.usd, partial: priced.extra.unpriced > 0, advisor: Math.max(0, made - priced.extra.advisor) }
}


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


  function ratesFor(row, contextTokens, speed) {
    row = speed === 'fast' ? row.fast : row
    if (!row) return null
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




  function priceCounters(row, usage, isMain, passes = 1) {
    const inp = num(usage && usage.input_tokens)
    const out = num(usage && usage.output_tokens)
    const cr = num(usage && usage.cache_read_input_tokens)
    const cw = num(usage && usage.cache_creation_input_tokens)
    const split = usage && usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation : null
    const named = split !== null && (Number.isFinite(split.ephemeral_5m_input_tokens) || Number.isFinite(split.ephemeral_1h_input_tokens))
    const cw5 = named ? num(split.ephemeral_5m_input_tokens) : 0
    const cw1 = named ? num(split.ephemeral_1h_input_tokens) : 0
    const unsplit = Math.max(cw - cw5 - cw1, 0)

    const w5tokens = cw5 + (named || !isMain ? unsplit : 0)
    const w1tokens = cw1 + (!named && isMain ? unsplit : 0)
    const context = inp + cr + cw
    const tokens = { input: inp, output: out, read: cr, write5: w5tokens, write1h: w1tokens }
    if (row === null) return { usd: 0, priced: false, parts: null, tokens, context }
    const r = ratesFor(row, passes > 1 ? context / passes : context, usage?.speed)

    if (!r) return { usd: 0, priced: false, parts: null, tokens, context }
    const parts = {
      input: (inp * r.input) / 1e6,
      output: (out * r.output) / 1e6,
      read: (cr * r.read) / 1e6,
      write5: (w5tokens * r.w5) / 1e6,
      write1h: (w1tokens * r.w1) / 1e6,
    }
    return { usd: parts.input + parts.read + parts.write5 + parts.write1h + parts.output, priced: true, parts, tokens, context }
  }












  function price(model, usage, opts) {
    const isMain = !!(opts && opts.main)
    const hit = resolve(model)
    const given = opts && Number.isInteger(opts.passes) && opts.passes > 1 ? opts.passes : 1
    const own = priceCounters(hit === null ? null : hit.row, usage, isMain, Math.max(given, ownPasses(usage, model).own.length))
    const extra = { usd: 0, passes: 0, unpriced: 0, advisor: 0 }
    for (const pass of extraPasses(usage, model)) {
      const at = pass.model === null ? null : resolve(pass.model)
      extra.passes += 1
      if (pass.type === 'advisor_message') extra.advisor += 1
      const cost = priceCounters(at === null ? null : at.row, pass.usage, false)
      if (!cost.priced) extra.unpriced += 1
      else extra.usd += cost.usd
    }
    return { usd: own.usd, priced: own.priced, key: hit === null ? null : hit.key, parts: own.parts, tokens: own.tokens, context: own.context, extra }
  }

  return { price, resolve, ratesFor }
}
