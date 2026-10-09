




const isNum = (x) => typeof x === 'number' && Number.isFinite(x)
const SERIES_CAP = 40


export function meterView(a) {
  const working = a.working === true && !!a.seg
  let prompt = null
  if (working) {
    const r = a.rem
    prompt = {
      spend_usd: a.seg.usd,
      calls: a.seg.k,
      rem: null,
    }
  }
  const limits = Array.isArray(a.rateLimits) ? a.rateLimits : []
  return {
    v: 1,
    working,
    prompt,
    session: { usd: a.totals.usd, calls: a.totals.calls, active_hours: isNum(a.totals.activeMs) ? a.totals.activeMs / 3600000 : null, prompt_usd: Array.isArray(a.promptUsd) ? a.promptUsd.map((p) => p[1]) : [] },
    rate_limits: limits.filter((l) => l && typeof l === 'object').map((l) => ({ kind: l.kind, percent_used: l.percentUsed, resets_at: l.resetsAt === undefined ? null : l.resetsAt })),
  }
}


export function noteSeries(series, idx, usd) {
  const last = series[series.length - 1]
  if (last && last[0] === idx) last[1] = usd
  else series.push([idx, usd])
  while (series.length > SERIES_CAP) series.shift()
}
