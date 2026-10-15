import { LIMIT_AWARE_ENABLED } from './usage_flags.js'










import { paneModel, paneNote, subagentShare, measuredDollars, floorMark, usd, count, plural, percent, resetText, stamp, LABEL, noUsageLine, windowReset, WINDOW_RESET } from './format.js'
import { FORCE_SERVER } from './runtime_mode.js'
import { effortRaise } from './models.js'

import { displayText, ROUTING_PLAN_TEXT, ROUTING_REFUSED_TEXT, ROUTING_KEY_TEXT, FREE_ROUTING } from './iq_client.js'

const SEP = ' · '
const SHORT = 'API-eq.'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const BLOCKS = '▁▂▃▄▅▆▇█'
const DEFAULT_COLOR = 0x01000000 

export const STATUSES = ['off', 'on', 'paused_errors', 'paused_plan', 'paused_allowance', 'paused_no_usage', 'killed', 'no_key',
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
  return bits.length > 0 ? ' (' + bits.join(', ') + ')' : ''
}


export function cacheStayText(cur) {
  if (!cur || cur.reason !== 'cache_warm_hold') return null
  const amount = cur.cacheAdvantageUsd
  return 'stayed: warm cache cheaper' + (isNum(amount) && amount >= 0 ? ' by ' + usd(amount) : '')
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

const PLAN_URL = 'iq-routing.com/billing'




function pauseLine(r) {
  const date = dateText(r.pause_until)
  switch (r.status) {
    case 'paused_no_usage':
      return LIMIT_AWARE_ENABLED ? { forms: [noUsageLine(r.no_usage_reset), 'No Claude usage left'], style: 'warn' } : null
    case 'paused_errors':
      return { forms: ['IQ routing paused after errors, your model is used', 'Routing paused after errors', 'Routing paused'], style: 'warn' }
    case 'paused_plan': {
      const whole = planPauseLine(r)
      if (whole === ROUTING_KEY_TEXT) return { forms: [whole, 'IQ did not accept your key. Check it, then /iq-route on', 'Check your IQ key, then /iq-route on', '/iq-route on'], style: 'warn' }
      return { forms: [whole, 'Routing needs the Personal plan ($6/month): ' + PLAN_URL, 'Routing needs the Personal plan: ' + PLAN_URL, 'Needs the Personal plan: ' + PLAN_URL, 'Personal plan: ' + PLAN_URL, PLAN_URL], style: 'warn' }
    }
    case 'paused_allowance':
      
      if (r.last_error === FREE_ROUTING.dailyCode) return { forms: ['Free routing is used up for today, so your model is used' + (date ? ' until ' + date : ''), 'Free routing is used up for today' + (date ? ', back ' + date : ''), 'Free routing used up' + (date ? ', back ' + date : ''), 'Free routing used up'], style: 'warn' }
      return { forms: ["IQ routing used this month's decisions, so your model is used" + (date ? ' until ' + date : ''), 'Routing limit reached, your model is used' + (date ? ' until ' + date : ''), 'Routing limit reached' + (date ? ' until ' + date : ''), 'Routing limit reached'], style: 'warn' }
    case 'killed':
      return { forms: ['IQ routing is switched off by its kill switch', 'Routing is switched off'], style: 'warn' }
    case 'no_key':
      return { forms: ['IQ routing has no key, so your model is used', 'IQ routing has no key'], style: 'warn' }
    default:
      return null
  }
}


function statusLine(r) {
  const p = pauseLine(r)
  return p === null ? null : { text: p.forms[0], style: p.style }
}


function badgeOf(r) {
  if (r.status !== 'on') return statusLine(r)
  const cur = r.current
  if (!cur) return { text: 'IQ routing on', style: 'route_wait' }
  const raised = effortRaise(r.named?.effort, cur.chosen?.effort)
  if (cur.phase === 'applied' && raised) return { text: 'IQ → ' + modelLabel(cur.chosen) + ' thinking' + (isStr(cur.tier) ? ' (IQ rated it ' + cur.tier + ')' : '') + SEP + raised, style: 'route_down' }
  switch (cur.phase) {
    case 'deciding':
      return { text: 'IQ deciding…', style: 'route_wait' }
    case 'applied':
      return { text: 'IQ → ' + modelLabel(cur.chosen) + (cacheStayText(cur) ? SEP + cacheStayText(cur) : qualifier(cur)), style: 'route_down' }
    case 'kept':
      if (cur.reason === 'trivial_turn') return { text: 'IQ kept', style: 'route_kept' }
      return { text: 'IQ kept ' + modelLabel(cur.chosen) + (cacheStayText(cur) ? SEP + cacheStayText(cur) : qualifier(cur)), style: 'route_kept' }
    case 'timeout':
    case 'error':
      return { text: 'IQ: ' + noDecision(cur), style: 'warn' }
    case 'paused':
      return { text: 'IQ: paused, kept your model', style: 'route_wait' }
    default:
      return null 
  }
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


export const rowWidth = (row) => row.reduce((n, s) => n + s.text.length, 0)


export function joinGroups(groups) {
  const row = []
  groups.forEach((g, i) => {
    if (i > 0) row.push(dot())
    for (const s of g) row.push(s)
  })
  return row
}



export function fitChunks(groups, width) {
  const have = groups.filter((g) => g && g.length > 0)
  for (let n = have.length; n >= 1; n--) {
    const row = joinGroups(have.slice(0, n))
    if (rowWidth(row) <= width) return row
  }
  return have.length > 0 ? fit(have[0], width) : []
}



export function fitText(text, style, width) {
  if (text.length <= width) return [{ text, style }]
  return fitChunks(text.split(SEP).map((t) => [{ text: t, style }]), width)
}



export function bandModel(a) {
  const r = readRouting(a && a.routing)
  if (r === null) return null
  if (r.status === 'off') return []
  if (r.status !== 'on' || r.current?.phase === 'paused') {
    return [[{ text: 'IQ · paused (/iq)', style: 'warn' }]]
  }
  const label = modelLabel(r.current?.chosen) || modelLabel(r.named)
  return [[{ text: 'IQ' + (label ? SEP + label : ''), style: 'route_down' }]]
}


export function answerSuffix(routing) {
  const r = readRouting(routing)
  if (r === null || r.status !== 'on' || !r.current) return null
  const cur = r.current
  switch (cur.phase) {
    case 'applied':
      return SEP + 'IQ: ' + modelLabel(cur.chosen) + qualifier(cur)
    case 'kept':
      return SEP + 'IQ: kept ' + modelLabel(cur.chosen) + (cacheStayText(cur) ? SEP + cacheStayText(cur) : qualifier(cur))
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

function decisionLine(d, measured) {
  const phase = typeof d.phase === 'string' ? d.phase : 'off'
  const text =
    pad(isNum(d.at_ms) ? stamp(d.at_ms) : '-', 14) +
    pad(isStr(d.tier) ? d.tier : '-', 9) +
    pad(modelLabel(d.chosen) || '-', 22) +
    pad(OUTCOME[phase] || phase, 11) +
    padL(latencyText(d.latency_ms), 8) +
    (measured ? '' : padL(savedText(d.est_saved_usd), 11))
  return { style: OUTCOME_STYLE[phase] || 'plain', text }
}

function routingTab(r, measured) {
  const L = []
  const add = (style, text) => L.push({ style, text })
  const blank = () => L.push({ style: 'plain', text: ' ' })
  add('title', 'IQ routing')
  if (r === null) {
    add('warn', 'The routing state is not one this version of IQ Code knows.')
    return L
  }
  if (r.status === 'off') add('plain', 'IQ routing is off for this and future sessions.')
  else if (r.status === 'on') add('route_down', 'IQ routing is on. It stays on in new sessions on this device until /iq-route off.')
  else {
    const b = statusLine(r)
    add(b.style, b.text + (r.status === 'paused_plan' ? '' : '.'))
  }
  add('dim', 'Turn on: /iq-route on · turn off: /iq-route off · status: /iq-route status')
  add('dim', 'IQ picks thinking from low to max. Settings are a starting point; an explicit /effort or ultrathink still decides.')

  const named = modelLabel(r.named)
  if (named) add('plain', 'Your model: ' + named)
  const badge = r.status === 'on' ? badgeOf(r) : null
  if (badge && r.current) add(badge.style, 'Last prompt: ' + badge.text)

  const s = r.session && typeof r.session === 'object' ? r.session : null
  if (s && isNum(s.prompts) && (s.prompts > 0 || r.status === 'on')) {
    blank()
    add('head', 'This session')
    add('plain', plural(s.prompts, 'prompt', 'prompts') + SEP + count(s.routed) + ' routed' + SEP + count(s.kept) + ' kept' + SEP + count(s.no_decision) + ' with no decision')
    if (!measured && isNum(s.est_saved_usd)) {
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
    add('dim', pad('when', 14) + pad('rating', 9) + pad('chosen', 22) + pad('outcome', 11) + padL('latency', 8) + (measured ? '' : padL('est. saved', 11) + ' (' + SHORT + ')'))
    for (const d of rows) if (d && typeof d === 'object') L.push(decisionLine(d, measured))
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

function planTab(m, surface, columns, nowMs) {
  const L = []
  const add = (style, text) => L.push({ style, text })
  const blank = () => L.push({ style: 'plain', text: ' ' })
  add('title', 'Plan')
  add('dim', 'Percents are Claude Code\'s own, to the nearest whole number. Dollars here are ' + LABEL + ' and are never turned into plan percent.')
  const lim = m && Array.isArray(m.rate_limits) ? m.rate_limits : []
  const five = lim.find((l) => l && l.kind === 'five_hour')
  const week = lim.find((l) => l && l.kind === 'seven_day')
  blank()
  if ((five && isNum(five.percent_used)) || (week && isNum(week.percent_used))) {
    
    let finished = false
    if (five && isNum(five.percent_used)) {
      if (windowReset(five.resets_at, nowMs).passed) { finished = true; add('plain', pad('5-hour', 8) + WINDOW_RESET) }
      else {
        const r = resetText(five.resets_at, false)
        add('plain', pad('5-hour', 8) + bar(five.percent_used) + '  ' + percent(five.percent_used) + (r ? ' (resets ' + r + ')' : ''))
      }
    }
    if (week && isNum(week.percent_used)) {
      if (windowReset(week.resets_at, nowMs).passed) { finished = true; add('plain', pad('weekly', 8) + WINDOW_RESET) }
      else {
        const r = resetText(week.resets_at, true)
        add('plain', pad('weekly', 8) + bar(week.percent_used) + '  ' + percent(week.percent_used) + (r ? ' (resets ' + r + ')' : ''))
      }
    }
    if (finished) add('dim', 'Claude Code reports a new reading with its next reply.')
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
  const readerLines = FORCE_SERVER ? [] : paneNote(read.state === 'ready' ? 'Cost read' : read.note || 'Run /cost-read to read this session.')
  const costLines = m && m.session.measured ? [...measuredCostLines(m), ...readerLines] : read.state === 'ready' ? paneModel(read.data, { columns: a.columns }) : paneNote(read.note || 'Run /cost-read to read this session.')
  costLines.push(...sessionCostLines(m))
  return {
    tabs: [
      { id: 'routing', title: 'Routing', lines: routingTab(r, m && m.session.measured) },
      { id: 'cost', title: 'Cost', lines: costLines },
      { id: 'plan', title: 'Plan', lines: planTab(m, a && a.surface, a && a.columns, a && a.nowMs) },
    ],
  }
}


export function sessionCostLines(m) {
  const s = m && m.session
  if (!s || !Array.isArray(s.prompts)) return []
  const L = [{ style: 'plain', text: ' ' }, { style: 'head', text: 'Prompts this session (newest first, API-equivalent)' }]
  const add = (style, text) => L.push({ style, text })
  for (const p of s.prompts.slice(0, 20)) {
    let text = '#' + count(p.idx) + SEP + usd(p.usd) + floorMark(p) + SEP + plural(p.calls, 'call', 'calls') + subagentShare(p.helper_usd, p.helper_calls)
    if (!p.completed) text += SEP + 'running'
    if (p.unpriced > 0) text += SEP + plural(p.unpriced, 'unpriced call', 'unpriced calls')
    add('plain', text)
  }
  if (s.prompts.length === 0) add('dim', 'No prompt observed yet.')
  add('dim', 'Late subagent calls update their original prompt.')
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


export function measuredCostLines(m) {
  const measured = m && m.session && m.session.measured
  if (!measured) return []
  const money = measuredDollars
  const paid = (row) => money(row.paid_usd) + (isNum(row.paid_usd) && row.paid_complete === false ? '+' : '')
  const L = [
    { style: 'title', text: 'Measured cost · API-equivalent dollars' },
    { style: measured.saved_usd < 0 ? 'warn' : 'plain', text: 'Totals: ' + paid(measured) + ' paid' + SEP + money(measured.baseline_usd) + ' baseline' + SEP + money(measured.saved_usd) + ' delta' },
    { style: 'dim', text: 'Baseline: your named model at your starting effort, using the same token classes. Switch cache rebuilds count against routing.' },
    { style: 'head', text: 'Turns this session (newest first)' },
  ]
  const rows = Array.isArray(measured.rows) ? measured.rows : []
  L.push({ style: 'dim', text: 'Delta = baseline − paid − routing rebuild debit (' + money(measured.rebuild_debit_usd) + ').' })
  for (const row of rows.slice(0, 20)) {
    L.push({ style: row.saved_usd < 0 ? 'warn' : 'plain', text: '#' + count(row.idx) + SEP + shortModel(row.model) + SEP + (isStr(row.effort) ? row.effort : 'n/a') + SEP + paid(row) + ' paid' + SEP + money(row.baseline_usd) + ' baseline' + SEP + money(row.saved_usd) + ' delta' + (row.skipped ? SEP + 'kept, no savings credited' : '') })
    const usage = row.usage || {}
    if (row.rebuild_debit_usd > 0) L.push({ style: 'warn', text: 'Routing rebuild debit: ' + money(row.rebuild_debit_usd) })
    L.push({ style: 'dim', text: [ ['input', 'input'], ['cache read', 'cache_read'], ['5m write', 'cache_write_5m'], ['1h write', 'cache_write_1h'], ['output', 'output'], ['thinking', 'thinking'] ].map(([label, key]) => label + ' ' + (isNum(usage[key]) ? count(usage[key]) : 'n/a')).join(SEP) })
  }
  if (!rows.length) L.push({ style: 'dim', text: 'No usage observed yet.' })
  L.push({ style: 'dim', text: 'Missing token classes stay n/a. Totals include all observed turns; the list shows the latest 20.' })
  return L
}
