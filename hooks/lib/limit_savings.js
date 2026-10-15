

const finite = (x) => typeof x === 'number' && Number.isFinite(x)
export const roundMoney = (x) => finite(x) ? Math.round(x * 1e6) / 1e6 : null
export const wirePercent = (x) => finite(x) ? (Math.sign(x) * Math.round(Math.min(100, Math.abs(x)) * 10) / 10 || 0) : null
export const displayPercent = (x) => finite(x) ? (Math.sign(x) * Math.round(Math.min(100, Math.abs(x))) || 0) : null

export function newLimitSavings() {
  let spend = 0
  let boundary = null
  let nextEpoch = 0
  const blank = () => ({ epoch: ++nextEpoch, row: null, anchor: null, lastPct: null, capacityUsd: null, savedUsd: 0, incomplete: false })
  const windows = { five_hour: blank(), seven_day: blank() }
  const clear = (kind) => { windows[kind] = blank() }
  function reading(rateLimits, nowMs, billingMode = 'subscription') {
    if (billingMode !== boundary) {
      clear('five_hour'); clear('seven_day'); boundary = billingMode
    }
    for (const kind of ['five_hour', 'seven_day']) {
      const matches = (Array.isArray(rateLimits) ? rateLimits : []).filter((r) => r && r.kind === kind)
      const row = matches.length === 1 ? matches[0] : null
      const reset = row && typeof row.resetsAt === 'string' ? Date.parse(row.resetsAt) : null
      const valid = billingMode === 'subscription' && row && finite(row.percentUsed) && row.percentUsed >= 0 && row.percentUsed <= 100 && (reset === null || finite(reset) && reset > nowMs)
      if (!valid) { if (windows[kind].row || windows[kind].anchor) clear(kind); continue }
      let w = windows[kind]
      const resetKey = reset === null ? null : reset
      if (w.row && (w.row.reset !== resetKey || row.percentUsed < w.lastPct)) { clear(kind); w = windows[kind] }
      w.row = { percentUsed: row.percentUsed, reset: resetKey }
      w.lastPct = row.percentUsed
      if (!w.anchor) w.anchor = { pct: row.percentUsed, spend }
      const dp = row.percentUsed - w.anchor.pct
      const dollars = roundMoney(spend - w.anchor.spend)
      if (dp >= 1 && dollars >= 0.05) w.capacityUsd = roundMoney(dollars / dp * 100)
    }
    return snapshot()
  }
  function observe({ actualUsd, complete = true, billingMode = 'subscription' }) {
    const tags = { five_hour: windows.five_hour.epoch, seven_day: windows.seven_day.epoch }
    if (billingMode !== 'subscription') {
      for (const w of Object.values(windows)) { w.anchor = null; w.capacityUsd = null }
      return tags
    }
    if (!complete || !finite(actualUsd) || actualUsd < 0) {
      for (const w of Object.values(windows)) { w.anchor = null; w.capacityUsd = null }
    } else spend = roundMoney(spend + actualUsd)
    return tags
  }
  function saving({ savedUsd, tags, billingMode = 'subscription' }) {
    if (billingMode !== 'subscription') return
    for (const kind of ['five_hour', 'seven_day']) {
      const w = windows[kind]
      if (!w.row || !tags || tags[kind] !== w.epoch) continue
      if (finite(savedUsd)) w.savedUsd = roundMoney(w.savedUsd + savedUsd)
      else w.incomplete = true
    }
  }
  function snapshot(nowMs = null) {
    if (finite(nowMs)) for (const kind of ['five_hour', 'seven_day']) {
      const w = windows[kind]
      if (w.row && finite(w.row.reset) && w.row.reset <= nowMs) clear(kind)
    }
    const out = {}
    for (const [kind, w] of Object.entries(windows)) {
      const capacity = w.row && finite(w.capacityUsd) && w.capacityUsd > 0 ? w.capacityUsd : null
      const raw = capacity !== null && !w.incomplete ? 100 * w.savedUsd / capacity : null
      out[kind] = { epoch: w.epoch, capacityUsd: capacity, savedUsd: roundMoney(w.savedUsd), percent: finite(raw) ? (Math.sign(raw) * Math.min(100, Math.abs(raw)) || 0) : null }
    }
    return out
  }
  return { reading, observe, saving, snapshot, reset() { spend = 0; boundary = null; clear('five_hour'); clear('seven_day') } }
}
