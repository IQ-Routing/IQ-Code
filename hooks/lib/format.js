





export const LABEL = 'API-equivalent'
const SHORT_LABEL = 'API-eq.'
const SEP = ' · ' 
const BARS = '▁▂▃▄▅▆▇█'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']




const isNum = (x) => typeof x === 'number' && Number.isFinite(x)


export function usd(x) {
  if (!isNum(x)) return '$?'
  const a = Math.abs(x)
  if (a === 0) return '$0.00'
  if (a < 0.005) return '<$0.01'
  if (a < 100) return '$' + a.toFixed(2)
  if (a < 1000) return '$' + String(Math.round(a))
  if (a < 10000) return '$' + (a / 1000).toFixed(1) + 'k'
  return '$' + String(Math.round(a / 1000)) + 'k'
}

export function count(n) {
  if (!isNum(n)) return '?'
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function plural(n, one, many) {
  return n === 1 ? '1 ' + one : count(n) + ' ' + many
}


export function tokens(n) {
  if (!isNum(n)) return '?'
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return String(Math.round(n / 1e3)) + 'k'
  return String(Math.round(n))
}

export function percent(p) {
  if (!isNum(p)) return '?%'
  return String(p) + '%' 
}

export function hours(h) {
  if (!isNum(h)) return '?'
  if (h < 1) return String(Math.max(Math.round(h * 60), 0)) + ' min'
  if (h < 100) return h.toFixed(1) + ' h'
  return String(Math.round(h)) + ' h'
}

export function minutes(m) {
  if (!isNum(m)) return '?'
  if (m >= 90) return (m / 60).toFixed(1) + ' h'
  return String(Math.max(Math.round(m), 1)) + ' min'
}

function two(n) {
  return n < 10 ? '0' + n : String(n)
}


function clock12(d) {
  const h = d.getHours()
  const m = d.getMinutes()
  const ap = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return String(h12) + ':' + two(m) + ap
}


export function resetText(iso, withDay) {
  if (typeof iso !== 'string') return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return (withDay ? DAYS[d.getDay()] + ' ' : '') + clock12(d)
}


export function stamp(ms) {
  if (!isNum(ms)) return '?'
  const d = new Date(ms)
  return MONTHS[d.getMonth()] + ' ' + d.getDate() + ' ' + two(d.getHours()) + ':' + two(d.getMinutes())
}






export function sendLine(pred) { return null }


export function answerLine(a) { return usd(a.usd) + SEP + plural(a.calls, 'call', 'calls') + ' (' + LABEL + ')' }



export function workingBand(b) { return ['this prompt ' + usd(b.spend) + ' so far (' + SHORT_LABEL + ')' + SEP + plural(b.k, 'call', 'calls')] }

export function subagentShare(dollars, calls) {
  return isNum(calls) && calls > 0 ? ' (subagents ' + usd(dollars) + ', ' + plural(calls, 'call', 'calls') + ')' : ''
}

export function promptResult(p) { return p ? 'last prompt ' + usd(p.usd) + SEP + plural(p.calls, 'call', 'calls') + subagentShare(p.helper_usd, p.helper_calls) : null }



export function idleBand(s) {
  const parts = []
  if (s.calls > 0) {
    parts.push('session ' + usd(s.usd) + ' (' + SHORT_LABEL + ')')
    if (isNum(s.activeHours) && s.activeHours >= 0.02) parts.push(hours(s.activeHours) + ' active')
    if (isNum(s.activeHours) && s.activeHours >= 0.05 && isNum(s.usd)) parts.push(usd(s.usd / s.activeHours) + '/h')
  }
  const limits = Array.isArray(s.rateLimits) ? s.rateLimits : []
  const five = limits.find((l) => l && l.kind === 'five_hour')
  const week = limits.find((l) => l && l.kind === 'seven_day')
  const wide = isNum(s.columns) && s.columns >= 130
  if (five && isNum(five.percentUsed)) {
    const r = wide ? resetText(five.resetsAt, false) : ''
    parts.push('5-hour ' + percent(five.percentUsed) + (r ? ' (resets ' + r + ')' : ''))
  }
  if (week && isNum(week.percentUsed)) {
    const r = resetText(week.resetsAt, true)
    parts.push('weekly ' + percent(week.percentUsed) + (r ? ' (resets ' + r + ')' : ''))
  }
  const last = promptResult(s.lastPrompt)
  if (last) return [last, parts.join(SEP)].filter(Boolean)
  if (parts.length === 0) return []
  const all = parts.join(SEP)
  const width = isNum(s.columns) && s.columns > 20 ? s.columns - 3 : 100
  if (all.length <= width || parts.length < 3) return [all]
  const cut = Math.ceil(parts.length / 2)
  return [parts.slice(0, cut).join(SEP), parts.slice(cut).join(SEP)]
}




export const NOTICE = {
  tablesChanged: 'iq meter is off: its cost data is not the version it was built with. Reinstall the iq-code plugin to turn it back on.',
  dataMissing: 'iq meter is off: its cost data files could not be read. Reinstall the iq-code plugin to turn it back on.',
  quiet: 'iq meter paused for this session after repeated internal errors (see ~/.claude/iq/meter/errors.log).',
  notReady: 'iq meter is off: ',
}




function sparkline(values) {
  if (!Array.isArray(values) || values.length === 0) return ''
  const top = Math.max.apply(null, values.concat([1]))
  let out = ''
  for (const v of values) {
    const i = Math.min(BARS.length - 1, Math.max(0, Math.floor(((isNum(v) ? v : 0) / top) * (BARS.length - 1))))
    out += BARS[i]
  }
  return out
}

function pad(s, n) {
  s = String(s)
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

function padL(s, n) {
  s = String(s)
  return s.length >= n ? s : ' '.repeat(n - s.length) + s
}


export function paneModel(data, opts) { const t = data && data.totals || {}; return [{ style: 'title', text: 'Measured cost · API-equivalent dollars' }, { style: 'plain', text: usd(t.usd) + SEP + plural(t.calls, 'call', 'calls') }, { style: 'dim', text: 'Measured calls since IQ Code started in this session.' }] }


export function paneNote(text) {
  return [
    { style: 'title', text: 'Cost read ' + SEP.trim() + ' ' + LABEL + ' dollars' },
    { style: 'plain', text },
  ]
}
