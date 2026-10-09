









import { workingBand, idleBand, paneModel, paneNote, subagentShare, usd, count, plural, percent, resetText, stamp, LABEL } from './format.js'
import { FORCE_SERVER } from './runtime_mode.js'

import { displayText, ROUTING_PLAN_TEXT, ROUTING_REFUSED_TEXT, ROUTING_KEY_TEXT } from './iq_client.js'

const SEP = ' · '
const SHORT = 'API-eq.'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const BLOCKS = '▁▂▃▄▅▆▇█'
const DEFAULT_COLOR = 0x01000000 

export const STATUSES = ['off', 'on', 'paused_errors', 'paused_plan', 'paused_allowance', 'killed', 'no_key',
]
export const PHASES = ['deciding', 'applied', 'kept', 'timeout', 'error', 'paused', 'off']

const OFF_STATE = { v: 1, status: 'off', pause_until: null, named: null, current: null, session: null, last_error: null }

const isNum = (x) => typeof x === 'number' && Number.isFinite(x)
const isStr = (x) => typeof x === 'string' && x !== ''





function readRouting(r) {
  if (r === null || r === undefined) return OFF_STATE
  if (typeof r !== 'object' || r.v !== 1 || !STATUSES.includes(r.status)) return null
  const c = r.current
  if (c !== null && c !== undefined) {
    if (typeof c !== 'object' || !PHASES.includes(c.phase)) return null
    if ((c.phase === 'applied' || c.phase === 'kept') && !(c.chosen && isStr(c.chosen.model))) return null
  }
  return r
}


function readMeter(m) {
  if (!m || typeof m !== 'object' || m.v !== 1) return null
  if (!m.session || typeof m.session !== 'object') return null
  return m
}





export function shortModel(id) {
  if (!isStr(id)) return '?'
  const s = displayText(id).replace(/\[[^\]]*\]$/, '')
  let m = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(s)
  if (m) return cap(m[1]) + ' ' + m[2] + (m[3] !== undefined ? '.' + m[3] : '')
  m = /^claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku)(?:-\d{8})?$/.exec(s)
  if (m) return cap(m[3]) + ' ' + m[1] + (m[2] !== undefined ? '.' + m[2] : '')
  return s.length > 24 ? s.slice(0, 23) + '…' : s
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}


function modelLabel(m) {
  if (!m || !isStr(m.model)) return null
  return shortModel(m.model) + (isStr(m.effort) ? SEP + m.effort : '')
}


function dateText(s) {
  const m = typeof s === 'string' ? /^\d{4}-(\d{2})-(\d{2})$/.exec(s) : null
  if (!m) return ''
  const mo = Number(m[1])
  if (mo < 1 || mo > 12) return ''
  return MONTHS[mo - 1] + ' ' + Number(m[2])
}


function qualifier(cur) {
  const bits = []
  
  if (isStr(cur.tier) && !(cur.phase === 'applied' && cur.chosen && cur.chosen.effort === cur.tier)) bits.push(cur.tier)
  if (cur.reason === 'cache_warm_hold') bits.push('cache warm')
  return bits.length > 0 ? ' (' + bits.join(', ') + ')' : ''
}


function noDecision(cur) {
  if (cur.phase === 'timeout') return 'no answer, kept your model'
  if (cur.reason === 'backoff') return 'backing off, kept your model'
  return 'error, kept your model'
}


function savedText(x) {
  if (!isNum(x)) return '-'
  return x < 0 ? '-' + usd(-x) : usd(x)
}


export function planPauseLine(r) {
  if (!r || r.pause_reply !== true) return ROUTING_PLAN_TEXT
  return r.last_error === 'key_rejected' ? ROUTING_KEY_TEXT : ROUTING_REFUSED_TEXT
}


function statusLine(r) {
  switch (r.status) {
    case 'paused_errors':
      return { text: 'IQ routing paused after errors, your model is used', style: 'warn' }
    case 'paused_plan':
      return { text: planPauseLine(r), style: 'warn' }
    case 'paused_allowance': {
      const d = dateText(r.pause_until)
      return { text: "IQ routing used this month's decisions, so your model is used" + (d ? ' until ' + d : ''), style: 'warn' }
    }
    case 'killed':
      return { text: 'IQ routing is switched off by its kill switch', style: 'warn' }
    case 'no_key':
      return { text: 'IQ routing has no key, so your model is used', style: 'warn' }
    default:
      return null
  }
}


function badgeOf(r) {
  if (r.status !== 'on') return statusLine(r)
  const cur = r.current
  if (!cur) return { text: 'IQ routing on', style: 'route_wait' }
  switch (cur.phase) {
    case 'deciding':
      return { text: 'IQ deciding…', style: 'route_wait' }
    case 'applied':
      return { text: 'IQ → ' + modelLabel(cur.chosen) + qualifier(cur), style: 'route_down' }
    case 'kept':
      return { text: 'IQ kept ' + modelLabel(cur.chosen) + qualifier(cur), style: 'route_kept' }
    case 'timeout':
    case 'error':
      return { text: 'IQ: ' + noDecision(cur), style: 'warn' }
    case 'paused':
      return { text: 'IQ: paused, kept your model', style: 'route_wait' }
    default:
      return null 
  }
}




function widthOf(columns) {
  return isNum(columns) && columns > 20 ? columns - 3 : 100
}


export function fit(row, width) {
  let total = 0
  for (const s of row) total += s.text.length
  if (total <= width) return row
  const out = []
  let left = width - 1
  for (const s of row) {
    if (left <= 0) break
    if (s.text.length <= left) {
      out.push(s)
      left -= s.text.length
    } else {
      out.push({ text: s.text.slice(0, left), style: s.style })
      left = 0
    }
  }
  if (out.length > 0) out[out.length - 1] = { text: out[out.length - 1].text + '…', style: out[out.length - 1].style }
  return out
}

export const dot = () => ({ text: SEP, style: 'dim' })



function promptBand(p, columns) {
  const share = subagentShare(p.helper_usd, p.helper_calls)
  const cols = share && isNum(columns) ? Math.max(21, columns - share.length) : columns
  const rows = workingBand({ spend: p.spend_usd, k: p.calls, rem: p.rem, forecastNote: p.forecast_note, columns: cols })
  if (share && rows.length) rows[0] = rows[0].replace(SEP + plural(p.calls, 'call', 'calls'), SEP + plural(p.calls, 'call', 'calls') + share)
  return rows
}


function summaryRow(r) {
  const row = [{ text: 'IQ routing on', style: 'head' }]
  const s = r.session && typeof r.session === 'object' ? r.session : null
  if (s && isNum(s.prompts) && s.prompts > 0) {
    row.push(dot(), { text: (isNum(s.routed) ? count(s.routed) : '0') + ' of ' + plural(s.prompts, 'prompt', 'prompts') + ' routed', style: 'plain' })
    if (isNum(s.est_saved_usd)) {
      if (s.est_saved_usd < 0) row.push(dot(), { text: 'est. extra ' + usd(-s.est_saved_usd) + ' (' + SHORT + ')', style: 'warn' })
      else row.push(dot(), { text: 'est. saved ' + usd(s.est_saved_usd) + ' (' + SHORT + ')', style: s.est_saved_usd > 0 ? 'route_down' : 'plain' })
    }
  }
  return row
}



export function bandModel(a) {
  const m = readMeter(a && a.meter)
  const r = readRouting(a && a.routing)
  if (m === null || r === null) return null
  const columns = a.columns
  const routingOn = r.status !== 'off'
  const working = m.working === true && m.prompt && typeof m.prompt === 'object'
  const lim = Array.isArray(m.rate_limits) ? m.rate_limits : []
  const idleRows = (cols) =>
    idleBand({
      usd: m.session.usd,
      calls: m.session.calls,
      activeHours: m.session.active_hours,
      lastPrompt: m.session.last_prompt,
      rateLimits: lim.map((l) => (l ? { kind: l.kind, percentUsed: l.percent_used, resetsAt: l.resets_at } : l)),
      columns: cols,
    })

  if (!routingOn) {
    
    if (working) return promptBand(m.prompt, columns).map((t, i) => [{ text: t, style: i === 0 ? 'plain' : 'dim' }])
    return idleRows(columns).map((t) => [{ text: t, style: 'dim' }])
  }

  const width = widthOf(columns)
  if (working) {
    const badge = badgeOf(r)
    if (badge === null) {
      
      return promptBand(m.prompt, columns).map((t, i) => [{ text: t, style: i === 0 ? 'plain' : 'dim' }])
    }
    const inner = promptBand(m.prompt, isNum(columns) && columns > 20 ? Math.max(21, columns - badge.text.length - SEP.length) : undefined)
    const rows = [fit([{ text: badge.text, style: badge.style }, dot(), { text: inner[0], style: 'plain' }], width)]
    if (inner.length > 1) rows.push(fit([{ text: inner[1], style: 'dim' }], width))
    return rows
  }

  
  const status = r.status === 'on' ? null : statusLine(r)
  const first = status === null ? summaryRow(r) : [{ text: status.text, style: status.style }]
  const rows = [fit(first, width)]
  const meterRows = idleRows(columns)
  if (meterRows.length > 0) rows.push(fit([{ text: meterRows.join(SEP), style: 'dim' }], width))
  return rows
}


export function answerSuffix(routing) {
  const r = readRouting(routing)
  if (r === null || r.status !== 'on' || !r.current) return null
  const cur = r.current
  switch (cur.phase) {
    case 'applied':
      return SEP + 'IQ: ' + modelLabel(cur.chosen) + qualifier(cur)
    case 'kept':
      return SEP + 'IQ: kept ' + modelLabel(cur.chosen) + qualifier(cur)
    case 'timeout':
    case 'error':
      return SEP + 'IQ: ' + noDecision(cur)
    default:
      return null
  }
}




function pad(s, n) {
  s = String(s)
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

function padL(s, n) {
  s = String(s)
  return s.length >= n ? s : ' '.repeat(n - s.length) + s
}

const OUTCOME = { applied: 'routed', kept: 'kept', timeout: 'no answer', error: 'error', paused: 'paused', deciding: 'deciding', off: 'off' }
const OUTCOME_STYLE = { applied: 'route_down', kept: 'route_kept', timeout: 'warn', error: 'warn', paused: 'route_wait', deciding: 'route_wait', off: 'dim' }

function latencyText(ms) {
  if (!isNum(ms)) return '-'
  return ms < 1000 ? String(Math.round(ms)) + ' ms' : (ms / 1000).toFixed(1) + ' s'
}

function decisionLine(d) {
  const phase = typeof d.phase === 'string' ? d.phase : 'off'
  const text =
    pad(isNum(d.at_ms) ? stamp(d.at_ms) : '-', 14) +
    pad(isStr(d.tier) ? d.tier : '-', 9) +
    pad(modelLabel(d.chosen) || '-', 22) +
    pad(OUTCOME[phase] || phase, 11) +
    padL(latencyText(d.latency_ms), 8) +
    padL(savedText(d.est_saved_usd), 11)
  return { style: OUTCOME_STYLE[phase] || 'plain', text }
}

function routingTab(r) {
  const L = []
  const add = (style, text) => L.push({ style, text })
  const blank = () => L.push({ style: 'plain', text: ' ' })
  add('title', 'IQ routing')
  if (r === null) {
    add('warn', 'The routing state is not one this version of IQ Code knows.')
    return L
  }
  if (r.status === 'off') add('plain', 'IQ routing is off. It starts off in every session.')
  else if (r.status === 'on') add('route_down', 'IQ routing is on for this session.')
  else {
    const b = statusLine(r)
    add(b.style, b.text + (r.status === 'paused_plan' ? '' : '.'))
  }
  add('dim', 'Turn on: /iq-route on · turn off: /iq-route off · status: /iq-route status')

  const named = modelLabel(r.named)
  if (named) add('plain', 'Your model: ' + named)
  const badge = r.status === 'on' ? badgeOf(r) : null
  if (badge && r.current) add(badge.style, 'Last prompt: ' + badge.text)

  const s = r.session && typeof r.session === 'object' ? r.session : null
  if (s && isNum(s.prompts) && (s.prompts > 0 || r.status === 'on')) {
    blank()
    add('head', 'This session')
    add('plain', plural(s.prompts, 'prompt', 'prompts') + SEP + count(s.routed) + ' routed' + SEP + count(s.kept) + ' kept' + SEP + count(s.no_decision) + ' with no decision')
    if (isNum(s.est_saved_usd)) {
      add(s.est_saved_usd > 0 ? 'route_down' : 'plain', (s.est_saved_usd < 0 ? 'est. extra ' : 'est. saved ') + usd(Math.abs(s.est_saved_usd)) + ' (' + LABEL + ')')
      add('dim', 'An estimate: the same tokens priced at your own model, less what they cost.')
    }
    const bm = s.by_model && typeof s.by_model === 'object' ? Object.keys(s.by_model) : []
    if (bm.length > 0) add('plain', 'Models used: ' + bm.map((k) => shortModel(k) + ' (' + count(s.by_model[k]) + ')').join(', '))
  }

  blank()
  add('dim', 'IQ never routes above the model you chose.')

  blank()
  add('head', 'Last 10 decisions')
  let rows = []
  if (Array.isArray(r.recent) && r.recent.length > 0) rows = r.recent.slice(-10).reverse()
  else if (r.current && r.current.phase !== 'off') rows = [r.current]
  if (rows.length === 0) add('dim', 'None yet this session.')
  else {
    add('dim', pad('when', 14) + pad('rating', 9) + pad('chosen', 22) + pad('outcome', 11) + padL('latency', 8) + padL('est. saved', 11) + ' (' + SHORT + ')')
    for (const d of rows) if (d && typeof d === 'object') L.push(decisionLine(d))
  }
  if (r.last_error) add('warn', 'Last error: ' + String(r.last_error))
  return L
}



function bar(p) {
  const w = 20
  const n = Math.max(0, Math.min(w, Math.round((p / 100) * w)))
  return '█'.repeat(n) + '░'.repeat(w - n)
}

function textSpark(values) {
  const top = Math.max.apply(null, values.concat([0.000001]))
  let out = ''
  for (const v of values) out += BLOCKS[Math.min(7, Math.max(0, Math.floor(((isNum(v) ? v : 0) / top) * 7)))]
  return out
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'


function base64(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)] + (i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '=') + (i + 2 < bytes.length ? B64[c & 63] : '=')
  }
  return out
}


export function sparkRaster(values, columns, rows) {
  const n = values.length
  const top = Math.max.apply(null, values.concat([0.000001]))
  const levels = rows * 8
  const words = new Uint32Array(n * rows * 3)
  const color = (f) => (f < 0.34 ? 0x43a047 : f < 0.67 ? 0xf9a825 : 0xe53935)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < n; c++) {
      const v = isNum(values[c]) && values[c] > 0 ? values[c] : 0
      let level = Math.round((v / top) * levels)
      if (v > 0 && level < 1) level = 1
      const fill = Math.max(0, Math.min(8, level - (rows - 1 - r) * 8))
      const i = (r * n + c) * 3
      words[i] = fill === 0 ? 0x20 : BLOCKS.codePointAt(fill - 1)
      words[i + 1] = fill === 0 ? DEFAULT_COLOR : color(v / top)
      words[i + 2] = DEFAULT_COLOR
    }
  }
  return { columns: n, rows, cells: base64(new Uint8Array(words.buffer)) }
}

function planTab(m, surface, columns) {
  const L = []
  const add = (style, text) => L.push({ style, text })
  const blank = () => L.push({ style: 'plain', text: ' ' })
  add('title', 'Plan')
  add('dim', 'Percents are exactly as Claude Code reports them. Dollars here are ' + LABEL + ' and are never turned into plan percent.')
  const lim = m && Array.isArray(m.rate_limits) ? m.rate_limits : []
  const five = lim.find((l) => l && l.kind === 'five_hour')
  const week = lim.find((l) => l && l.kind === 'seven_day')
  blank()
  if ((five && isNum(five.percent_used)) || (week && isNum(week.percent_used))) {
    if (five && isNum(five.percent_used)) {
      const r = resetText(five.resets_at, false)
      add('plain', pad('5-hour', 8) + bar(five.percent_used) + '  ' + percent(five.percent_used) + (r ? ' (resets ' + r + ')' : ''))
    }
    if (week && isNum(week.percent_used)) {
      const r = resetText(week.resets_at, true)
      add('plain', pad('weekly', 8) + bar(week.percent_used) + '  ' + percent(week.percent_used) + (r ? ' (resets ' + r + ')' : ''))
    }
  } else add('dim', 'Claude Code has not reported plan limits for this session yet.')

  blank()
  add('head', 'Dollars per prompt this session (' + SHORT + ')')
  const series = m && m.session && Array.isArray(m.session.prompt_usd) ? m.session.prompt_usd.filter(isNum).slice(-40) : []
  if (series.length === 0) add('dim', 'No finished prompt yet.')
  else {
    const maxCols = isNum(columns) && columns > 8 ? columns - 4 : 40
    const vals = series.slice(-maxCols)
    const top = Math.max.apply(null, vals)
    if (surface === 'terminal') L.push({ style: 'plain', raster: sparkRaster(vals, vals.length, 3) })
    else add('plain', textSpark(vals))
    add('dim', 'last ' + plural(vals.length, 'prompt', 'prompts') + SEP + 'tallest ' + usd(top) + ' (' + SHORT + ')')
  }
  return L
}




export function paneTabs(a) {
  const m = readMeter(a && a.meter)
  const r = readRouting(a && a.routing)
  const read = a && a.read && typeof a.read === 'object' ? a.read : { state: 'idle', data: null, note: '' }
  const costLines = read.state === 'ready' ? paneModel(read.data, { columns: a.columns }) : paneNote(read.note || 'Run /cost-read to read this session.')
  costLines.push(...sessionCostLines(m))
  return {
    tabs: [
      { id: 'routing', title: 'Routing', lines: routingTab(r) },
      { id: 'cost', title: 'Cost', lines: costLines },
      { id: 'plan', title: 'Plan', lines: planTab(m, a && a.surface, a && a.columns) },
    ],
  }
}


export function sessionCostLines(m) {
  const s = m && m.session
  if (!s || !Array.isArray(s.prompts)) return []
  const L = [{ style: 'plain', text: ' ' }, { style: 'head', text: 'Prompts this session (newest first, API-equivalent)' }]
  const add = (style, text) => L.push({ style, text })
  for (const p of s.prompts.slice(0, 20)) {
    let text = '#' + count(p.idx) + SEP + usd(p.usd) + SEP + plural(p.calls, 'call', 'calls') + subagentShare(p.helper_usd, p.helper_calls)
    if (!p.completed) text += SEP + 'running'
    if (p.unpriced > 0) text += SEP + plural(p.unpriced, 'unpriced call', 'unpriced calls')
    add('plain', text)
  }
  if (s.prompts.length === 0) add('dim', 'No prompt observed yet.')
  add('dim', FORCE_SERVER ? 'Late subagent calls update their original prompt.' : 'The estimate is the extra spend shown during the prompt. Late subagent calls update their original prompt.')
  add('plain', ' ')
  add('head', 'Subagents this session (API-equivalent)')
  const agents = Array.isArray(s.subagents) ? s.subagents : []
  for (const agent of agents) add('plain', displayText(String(agent.id)).slice(0, 64) + SEP + usd(agent.usd) + SEP + plural(agent.calls, 'call', 'calls') + (agent.unpriced > 0 ? SEP + plural(agent.unpriced, 'unpriced call', 'unpriced calls') : ''))
  if (agents.length === 0) add('dim', 'No subagent calls observed yet.')
  if (s.omitted_subagents) add('dim', 'Older subagent entries were dropped from this capped list; prompt and session totals still include their calls.')
  add('dim', 'Includes foreground and background subagent calls delivered to this session. Separate background sessions and team members are not aggregated here unless the host delivers their call hooks to this session.')
  add('dim', 'This history covers calls observed since IQ Code started in this session and clears on /clear.')
  return L
}
