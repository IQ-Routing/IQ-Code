









import { parseFrames, frameAt, frameMs, svgFrameAt, svgFrameMs, TEXT_MARK } from './lib/logo.js'
import { buildView, cleanSettings, setStateModule, servedOf, DEFAULT_SETTINGS } from './lib/view_model.js'
import { cacheTtlMs, ttlIsKnown, onSubscription } from './lib/router.js'
import { skinTabs, bandRows, spinnerStatus, tagOf, cardLine, turnLine, noticeModel, hintTail, WORDS } from './lib/skin.js'
import * as STATE from './lib/state.js'
import { safeErr, scrub, destinationFrom, displayText } from './lib/iq_client.js'
import { VERSION } from './lib/pins.js'
import { readKey } from './lib/traffic.js'
import { cleanFields, issueUrl, SUPPORT_EMAIL } from './lib/feedback.js'




async function userHome($) {
  const profile = await safe($.env.get('USERPROFILE'))
  const home = await safe($.env.get('HOME'))
  for (const value of [profile, home]) {
    if (typeof value !== 'string' || value === '' || /[\x00-\x1f]/.test(value)) continue
    if (/^[A-Za-z]:[\\/]/.test(value) || /^\/(?!\/)/.test(value)) return value
  }
  return null
}



function pathIn(base, ...parts) {
  if (typeof base !== 'string' || base === '') return ''
  const sep = /^[A-Za-z]:[\\/]/.test(base) || base.includes('\\') ? '\\' : '/'
  return base.replace(/[\\/]+$/, '').replace(/[\\/]+/g, sep) + sep + parts.map((part) =>
    String(part).replace(/^[\\/]+|[\\/]+$/g, '').replace(/[\\/]+/g, sep)).join(sep)
}

setStateModule(STATE) 

const SETTINGS_PATH = '/.claude/iq/settings.json' 
const UI_STATE_PATH = '/.claude/iq/ui_state.json' 
const STAMP_CAP = 400
const TICK_MS = 30000 
const HOME_LOOPS = 3 
const PLAN_CAP = 60

const STYLE = {
  title: { bold: true },
  head: { bold: true, color: 'claude' },
  bold: { bold: true },
  plain: {},
  dim: { dimColor: true },
  good: { color: 'green' },
  warn: { color: 'warning' },
  route_down: { color: 'claude' },
  route_kept: { color: 'claude' },
  route_wait: { dimColor: true },
}

let H = null 
let U = newUi() 

function newUi() {
  return {
    frames: null, 
    settings: { ...DEFAULT_SETTINGS },
    ttl: { force5m: false, envTtl: '', settingTtl: '', enable1h: false }, 
    onboarded: null, 
    home: null,
    plan: { five_hour: [], seven_day: [] }, 
    stamps: new Map(), 
    lastTag: null,
    timers: new Map(), 
    svgFrames: new Map(), 
    finished: new Set(), 
    cardNodes: new Map(), 
    tickTimer: null,
    loading: null, 
    errors: 0,
    quiet: false,
    feedback: null, 
  }
}

export function registerUi(on, host) {
  H = host

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!H.ready() || U.quiet) return next(e)
    if (!H.interactive() && !(await ensureInteractive($))) return next(e)
    try {
      return await drawBand($, e, next)
    } catch (err) {
      await noteError($, 'ui.render', err)
      return next(e)
    }
  })

  on('ui.render', { component: 'Pane', requestId: 'iq' }, async ($, e, next) => {
    try {
      return await drawPane($, e, next)
    } catch (err) {
      await noteError($, 'ui.render', err)
      return next(e)
    }
  })

  on('ui.render', { component: 'Pane', requestId: 'feedback' }, async ($, e, next) => {
    try {
      return drawFeedback($, e, next)
    } catch (_) {
      return next(e)
    }
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    try {
      return await drawSpinner($, e, next)
    } catch (err) {
      await noteError($, 'ui.render', err)
      return next(e)
    }
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    try {
      return await drawCard($, e, next, 'assistant')
    } catch (err) {
      await noteError($, 'ui.render', err)
      return next(e)
    }
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    try {
      return await drawCard($, e, next, 'tool')
    } catch (err) {
      await noteError($, 'ui.render', err)
      return next(e)
    }
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    try {
      return await drawCard($, e, next, 'tool')
    } catch (err) {
      await noteError($, 'ui.render', err)
      return next(e)
    }
  })

  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    try {
      return await drawTurn($, e, next)
    } catch (err) {
      await noteError($, 'ui.render', err)
      return next(e)
    }
  })

  on('ui.render', { component: 'InfoNotice' }, async ($, e, next) => {
    try {
      return await drawNotice($, e, next)
    } catch (err) {
      await noteError($, 'ui.render', err)
      return next(e)
    }
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    try {
      return await drawHint($, e, next)
    } catch (err) {
      await noteError($, 'ui.render', err)
      return next(e)
    }
  })

  on('command.run', { command: 'iq' }, async ($, e, next) => {
    if (typeof e.args === 'string' && e.args.trim() === 'feedback') return onFeedback($)
    try {
      return await onIq($, e)
    } catch (err) {
      await noteError($, 'command.run', err)
      say($, 'iq hit an internal error (see ~/.claude/iq/meter/errors.log).')
        return {}
    }
  })
}




export function uiReset() {
  try {
    stopAll()
    U = newUi()
  } catch (_) {
    
  }
}

export function uiTurnDone() {
  try {
    stopSpinners()
  } catch (_) {
    
  }
}

export function uiEnd() {
  try {
    stopAll()
  } catch (_) {
    
  }
}





async function ensureLoaded($) {
  if (U.loading === null) {
    U.loading = uiStart($).catch(async (err) => {
      await noteError($, 'ui.start', err)
    })
  }
  await U.loading
}

async function uiStart($) {
  U.home = await userHome($)
  const root = $.plugin.root
  const text = await safe($.fs.read(pathIn(root, 'data/logo_frames.json')))
  U.frames = typeof text === 'string' ? parseFrames(text) : null 
  U.ttl = await readTtl($)
  if (U.home) {
    const s = await readJson($, pathIn(U.home, SETTINGS_PATH))
    U.settings = { ...cleanSettings(s), subagentRouting: false } 
    const st = await readJson($, pathIn(U.home, UI_STATE_PATH), true)
    U.onboarded = st === undefined ? false : st === null ? true : st.onboarded === true 
  }
  
  
  if (U.tickTimer === null) U.tickTimer = $.clock.every(TICK_MS, () => tick($))
}

const truthy = (v) => typeof v === 'string' && v.trim() !== '' && !['0', 'false', 'no', 'off'].includes(v.trim().toLowerCase())


async function readTtl($) {
  const force = await safe($.env.get('FORCE_PROMPT_CACHING_5M'))
  const envTtl = await safe($.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'))
  const one = await safe($.env.get('ENABLE_PROMPT_CACHING_1H'))
  const st = await safe($.settings.read())
  return {
    force5m: truthy(force),
    envTtl: typeof envTtl === 'string' ? envTtl.trim() : '',
    settingTtl: st && typeof st.promptCacheTtl === 'string' ? st.promptCacheTtl : '',
    enable1h: truthy(one),
  }
}

async function tick($) {
  if (!H.interactive() || !H.ready() || H.working()) return
  const R = H.router()
  if (!R || !R.last) return
  const now = await $.clock.now()
  const ttl = ttlIsKnown(U.ttl, H.usage().rateLimits) ? cacheTtlMs({ ...U.ttl, onSubscription: onSubscription(H.usage().rateLimits) }) : null
  if (ttl !== null && now < R.last.endMs + ttl + 10000) $.ui.invalidate('ui.render')
}


async function readJson($, path, absentOk) {
  const has = await safe($.fs.exists(path))
  if (!has) return absentOk ? undefined : {}
  const text = await safe($.fs.read(path))
  try {
    const j = JSON.parse(text)
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null
  } catch (_) {
    return null
  }
}

function safe(p) {
  return Promise.resolve(p).then(
    (v) => v,
    () => undefined,
  )
}


function cancelTimer(t) {
  try {
    if (typeof t === 'function') t()
    else if (t && typeof t.cancel === 'function') t.cancel()
    else if (t && typeof t.then === 'function') t.then(cancelTimer, () => {})
  } catch (_) {
    
  }
}

function stopTimer(id) {
  const t = U.timers.get(id)
  U.timers.delete(id)
  U.svgFrames.delete(id)
  cancelTimer(t)
}

function stopSpinners() {
  for (const id of [...U.timers.keys()]) if (id.endsWith('/iq-spin')) stopTimer(id)
}

function stopMarks() {
  for (const id of [...U.timers.keys()]) if (id.endsWith('/iq-spin') || id.endsWith('/iq-home')) stopTimer(id)
}

function stopAll() {
  for (const id of [...U.timers.keys()]) stopTimer(id)
  if (U.tickTimer !== null) cancelTimer(U.tickTimer)
  U.tickTimer = null
}




const UI_LOG = '/.claude/iq/ui/errors.log'
const UI_LOG_CAP = 24 * 1024
const UI_MAX_ERRORS = 5 

async function noteError($, where, err) {
  U.errors += 1
  if (U.errors >= UI_MAX_ERRORS) U.quiet = true
  if (!U.home) return
  const key = await readKey({
    configured: () => H && H.pluginKey ? H.pluginKey() : undefined,
    home: () => U.home,
    exists: (path) => $.fs.exists(path),
    read: (path) => $.fs.read(path),
    user: () => $.settings.read({ source: 'user' }),
  })
  const msg = safeErr(err, [key, H && H.pluginKey ? H.pluginKey() : undefined])
  try {
    const path = pathIn(U.home, UI_LOG)
    const line = new Date().toISOString() + ' ' + where + ': ' + msg.slice(0, 300) + '\n'
    let text = ''
    if (await $.fs.exists(path)) text = await $.fs.read(path)
    text = scrub(text + line, [key, H && H.pluginKey ? H.pluginKey() : undefined]).slice(-UI_LOG_CAP)
    await $.fs.write(path, text)
  } catch (_) {
    
  }
}


function say($, text) {
  if (!H.interactive() || typeof text !== 'string' || text === '') return
  try {
    void safe($.ui.log(displayText(text)))
  } catch (_) {
    
  }
}

async function ensureInteractive($) {
  if (H.interactive()) return true
  const s = await safe($.session.surfaces())
  if (Array.isArray(s) && s.length > 0) {
    H.markInteractive()
    $.ui.invalidate('ui.render')
  }
  return H.interactive()
}





async function persistSetting($, key, value) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) return
  U.settings = cleanSettings({ ...U.settings, [key]: value })
  STATE.setSetting(key, U.settings[key]) 
  const text = STATE.takePendingSettings()
  if (text && U.home) await $.fs.write(pathIn(U.home, SETTINGS_PATH), text)
}

async function markOnboarded($) {
  U.onboarded = true
  if (!U.home) return
  await $.fs.write(pathIn(U.home, UI_STATE_PATH), JSON.stringify({ onboarded: true }) + '\n')
}

async function doControl($, d) {
  try {
    if (d.kind === 'set') await persistSetting($, d.key, d.value)
    else if (d.kind === 'routing' && typeof H.setRouting === 'function') say($, await H.setRouting(d.value)) 
    else if (d.kind === 'onboarded') await markOnboarded($)
    if (d.kind === 'set' && d.key === 'animation' && d.value === false) stopMarks() 
  } catch (err) {
    await noteError($, 'ui.press', err)
  }
  $.ui.invalidate('ui.render')
}




function notePlan(nowMs) {
  const lim = H.usage().rateLimits
  if (!Array.isArray(lim)) return
  for (const l of lim) {
    if (!l || (l.kind !== 'five_hour' && l.kind !== 'seven_day') || typeof l.percentUsed !== 'number') continue
    const arr = U.plan[l.kind]
    const last = arr[arr.length - 1]
    if (!last || last.pct !== l.percentUsed || nowMs - last.t >= 60000) {
      arr.push({ t: nowMs, pct: l.percentUsed })
      while (arr.length > PLAN_CAP) arr.shift()
    }
  }
}

function currentView(nowMs, working) {
  notePlan(nowMs)
  const view = buildView({
    router: H.router(),
    routing: H.routing(),
    meter: H.meter(working),
    usage: H.usage(),
    pricer: H.pricer(),
    nowMs,
    settings: U.settings,
    ttl: U.ttl,
    history: U.plan,
    working,
    sent: H.sent(),
    sessionId: H.sessionId(),
  })
  U.settings = cleanSettings(view.settings)
  if (U.settings.animation === false) stopMarks()
  return view
}




async function drawBand($, e, next) {
  const p = e.props || e
  if (p.hasSurvey) return next(e)
  await ensureLoaded($)
  const columns = typeof p.bodyColumns === 'number' ? p.bodyColumns : 80
  const nowMs = await $.clock.now()
  const working = !!p.isWorking
  const meter = H.meter(working)
  const rows = bandRows({ meter, routing: H.bandRouting(), view: currentView(nowMs, working), nowMs, columns })
  if (rows === null || rows.length === 0) return next(e)
  const { Box, Text } = $.ui.resolve(e)
  const text = (s) => Text({ ...(STYLE[s.style] || {}), wrap: 'truncate-end', children: displayText(s.text) })
  const lines = rows.map((r) => (r.length === 1 ? text(r[0]) : Box({ flexDirection: 'row', children: r.map(text) })))
  return Box({ flexDirection: 'column', paddingX: 1, children: lines })
}




async function drawSpinner($, e, next) {
  if (!H.interactive() || U.quiet) return next(e)
  await ensureLoaded($)
  const p = e.props || {}
  const view = currentView(await $.clock.now(), true)
  const status = spinnerStatus(view)
  if (status === null) return next(e)
  const { Box, Text, Raster, Svg } = $.ui.resolve(e)
  if (e.surface !== 'terminal') {
    const withStatus = { ...e, props: { ...p, suffix: ' · ' + status + (typeof p.suffix === 'string' ? p.suffix : '') } }
    const line = await next(withStatus)
    const animate = U.settings.animation !== false && H.working()
    const id = 'svg/' + e.requestId + '/iq-spin'
    if (e.surface === 'desktop' && Svg && U.frames && animate) startSvgTimer($, e.requestId, 'iq-spin')
    const flag = e.surface === 'desktop' && Svg && U.frames
      ? Svg({ source: svgFrameAt(U.frames, animate ? U.svgFrames.get(id) ?? 0 : -1), alt: 'IQ Code is working', width: 28, height: 28, isInteractive: false })
      : Text({ bold: true, color: 'claude', children: TEXT_MARK })
    
    return Box({ flexDirection: 'row', columnGap: 1, children: [Box({ key: 'iq-spin-flag', children: [flag] }), line] })
  }
  const engine = await next(e)
  const f = Raster && U.frames ? frameAt(U.frames, 'sm', U.settings.animation === false ? -1 : 0) : null
  const mark = f
    ? Raster({ key: 'iq-spin', columns: f.columns, rows: f.rows, cells: f.cells })
    : Text({ bold: true, color: 'claude', children: TEXT_MARK })
  if (f && H.working()) startMarkTimer($, e.requestId, 'iq-spin', 'sm') 
  const body = Box({ flexDirection: 'column', children: [engine, Text({ dimColor: true, children: displayText(status) })] })
  return Box({ flexDirection: 'row', columnGap: 1, children: [mark, body] })
}


function startMarkTimer($, requestId, key, size) {
  const id = requestId + '/' + key
  if (U.timers.has(id) || U.finished.has(id) || !U.frames || U.settings.animation === false) return
  let i = 0
  const limit = key === 'iq-home' && U.frames[size] && Array.isArray(U.frames[size].frames) ? HOME_LOOPS * U.frames[size].frames.length : Infinity
  const timer = $.clock.every(frameMs(U.frames), async () => {
    i += 1
    if (i >= limit) {
      
      stopTimer(id)
      U.finished.add(id)
      const rest = frameAt(U.frames, size, -1)
      if (rest) await safe($.ui.blit({ requestId, key, cells: rest.cells }))
      return
    }
    const f = frameAt(U.frames, size, i)
    const res = f ? await safe($.ui.blit({ requestId, key, cells: f.cells })) : { deny: 'no frame' }
    if (!res || res.deny) stopTimer(id) 
  })
  U.timers.set(id, timer)
}


function startSvgTimer($, requestId, key) {
  const id = 'svg/' + requestId + '/' + key 
  const frames = U.frames && U.frames.svg.frames
  if (U.timers.has(id) || U.finished.has(id) || !Array.isArray(frames) || !frames.length || U.settings.animation === false) return
  let i = 0
  const limit = key === 'iq-home' ? HOME_LOOPS * frames.length : Infinity
  U.svgFrames.set(id, i)
  U.timers.set(id, $.clock.every(svgFrameMs(U.frames), () => {
    if (key === 'iq-spin' && !H.working()) {
      stopTimer(id)
      return
    }
    i += 1
    if (i >= limit) {
      stopTimer(id)
      U.finished.add(id)
    } else U.svgFrames.set(id, i % frames.length)
    $.ui.invalidate('ui.render')
  }))
}





function stampFor(requestId, kind, p, nowMs) {
  let st = U.stamps.get(requestId)
  if (st) return st
  const served = servedOf(H.router(), H.routing(), H.working(), H.sent())
  const tag = tagOf(served)
  const show = tag !== null && (kind === 'assistant' ? p.isFirstOfReply === true : tag !== U.lastTag)
  st = { tag, show }
  if (tag !== null) U.lastTag = tag
  U.stamps.set(requestId, st)
  if (U.stamps.size > STAMP_CAP) U.stamps.delete(U.stamps.keys().next().value)
  void nowMs
  return st
}

async function drawCard($, e, next, kind) {
  if (!H.interactive() || U.quiet) return next(e)
  await ensureLoaded($)
  
  
  const props = e.props && typeof e.props === 'object' ? e.props : null
  const cols = props && typeof props.bodyColumns === 'number' ? props.bodyColumns : e.viewport && typeof e.viewport.columns === 'number' ? e.viewport.columns : 0
  const sig = props !== null ? propsSig(props) : null
  const hit = sig !== null ? U.cardNodes.get(e.requestId) : undefined
  if (hit && hit.sig === sig && hit.cols === cols && hit.surface === e.surface && hit.kind === kind) return hit.node
  const st = stampFor(e.requestId, kind, e.props || {}, 0)
  const node = await next(e)
  const line = st.show ? cardLine(st.tag) : null
  let out = node
  if (line !== null) {
    const { Box, Text } = $.ui.resolve(e)
    out = Box({ flexDirection: 'column', children: [node, Text({ dimColor: true, children: displayText(line) })] })
  }
  if (sig !== null) {
    U.cardNodes.set(e.requestId, { sig, cols, surface: e.surface, kind, node: out })
    if (U.cardNodes.size > STAMP_CAP) U.cardNodes.delete(U.cardNodes.keys().next().value)
  }
  return out
}


function propsSig(props) {
  try {
    const text = JSON.stringify(props)
    if (typeof text !== 'string' || text.length > 400000) return null
    let h = 0x811c9dc5
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    return text.length + ':' + (h >>> 0).toString(16)
  } catch (_) {
    return null
  }
}

async function drawTurn($, e, next) {
  if (!H.interactive() || U.quiet) return next(e)
  const tag = tagOf(servedOf(H.router(), H.routing(), false, H.sent()))
  const line = turnLine(e.props, tag)
  if (line === null) return next(e)
  const { Text } = $.ui.resolve(e)
  return Text({ dimColor: true, children: displayText(line) })
}

async function drawNotice($, e, next) {
  if (!H.interactive() || U.quiet) return next(e)
  const m = noticeModel(e.props)
  if (m === null) return next(e)
  const { Box, Text } = $.ui.resolve(e)
  const cmd = m.command ? (m.command.startsWith('/') ? m.command : '/' + m.command) : null
  return Box({
    flexDirection: 'row',
    children: [Text({ bold: true, color: 'claude', children: m.prefix + ' '}), Text({ dimColor: true, children: displayText(m.text + (cmd ? ' ' + cmd : '')) })],
  })
}

async function drawHint($, e, next) {
  if (!H.interactive() || U.quiet) return next(e)
  await ensureLoaded($)
  const p = e.props || {}
  const tail = hintTail(p, U.onboarded === false)
  if (tail === null) return next(e)
  const prop = e.surface === 'terminal' ? 'tail' : 'hint'
  return next({ ...e, props: { ...p, [prop]: (typeof p[prop] === 'string' ? p[prop] : '') + tail } })
}




async function onIq($, e) {
  await ensureInteractive($)
  if (!H.ready()) {
    say($, H.notReadyText())
    return {}
  }
  await ensureLoaded($)
  H.tab.set('home')
  stopTimer('iq/iq-home')
  U.finished.delete('iq/iq-home') 
  stopTimer('svg/iq/iq-home')
  U.finished.delete('svg/iq/iq-home')
  const opened = await $.ui.open({ id: 'iq', title: 'IQ', focus: true, closeOnEscape: true })
  if (opened && opened.isPlaced === false) {
    say($, 'iq could not open its pane (' + opened.reason + ').')
    return {}
  }
  $.ui.invalidate('ui.render')
  return {}
}

function markNode(E, surface) {
  const { Box, Text, Raster, Svg } = E
  const animate = U.settings.animation !== false
  if (surface === 'terminal' && Raster && U.frames) {
    const f = frameAt(U.frames, 'lg', animate ? 0 : -1)
    if (f) return { node: Raster({ key: 'iq-home', columns: f.columns, rows: f.rows, cells: f.cells }), animated: animate }
  }
  if (surface === 'desktop' && Svg && U.frames) {
    const playing = animate && !U.finished.has('svg/iq/iq-home') && Array.isArray(U.frames.svg.frames)
    const source = svgFrameAt(U.frames, playing ? U.svgFrames.get('svg/iq/iq-home') ?? 0 : -1)
    return { node: Box({ key: 'iq-home', children: [Svg({ source, alt: 'IQ Code mark', width: 72, height: 72, isInteractive: false })] }), animated: false, svgPlaying: playing }
  }
  return { node: Text({ bold: true, color: 'claude', children: TEXT_MARK }), animated: false }
}

async function drawPane($, e, next) {
  await ensureLoaded($)
  const E = $.ui.resolve(e)
  const { Box, Text, Button } = E
  const columns = e.props && typeof e.props.bodyColumns === 'number' ? e.props.bodyColumns : 80
  const surface = e.surface
  const nowMs = await $.clock.now()
  const view = currentView(nowMs, false)
  const model = skinTabs({
    meter: H.meter(false),
    routingState: H.routing(),
    view,
    read: H.read(),
    surface,
    columns,
    nowMs,
    firstRun: U.onboarded === false,
    canRoute: typeof H.setRouting === 'function',
    destinationHost: destinationFrom(await safe($.settings.read({ source: 'user' }))).host,
  })
  if (!model || !Array.isArray(model.tabs)) return next(e)
  const open = model.tabs.find((t) => t.id === H.tab.get()) || model.tabs[0]
  const row = Box({
    flexDirection: 'row',
    columnGap: 3,
    children: model.tabs.map((t, i) =>
      Button({
        key: 'tab-' + t.id,
        label: t.title,
        hotkey: String(i + 1),
        plain: true,
        dimColor: t.id !== open.id,
        onPress: () => {
          H.tab.set(t.id)
          $.ui.invalidate('ui.render')
        },
      }),
    ),
  })
  const button = (c) =>
    Button({
      key: 'ctl-' + c.key,
      label: displayText(c.label),
      hotkey: c.hotkey,
      plain: true,
      onPress: () => doControl($, c.do),
    })
  const kids = [row, Text({ children: ' ' })]
  for (const l of open.lines) {
    if (l.mark) {
      const m = markNode(E, surface)
      kids.push(m.node)
      if (m.animated) startMarkTimer($, 'iq', 'iq-home', 'lg')
      else if (m.svgPlaying) startSvgTimer($, 'iq', 'iq-home')
    } else if (l.raster) {
      if (surface === 'terminal' && E.Raster) kids.push(E.Raster({ key: 'spark', columns: l.raster.columns, rows: l.raster.rows, cells: l.raster.cells }))
    } else if (l.control) kids.push(button(l.control))
    else if (Array.isArray(l.controls)) kids.push(Box({ flexDirection: 'row', columnGap: 2, children: l.controls.map(button) }))
    else if (Array.isArray(l.spans)) kids.push(Box({ flexDirection: 'row', children: l.spans.map((s) => Text({ ...(STYLE[s.style] || {}), children: displayText(s.text) })) }))
    else kids.push(Text({ ...(STYLE[l.style] || {}), children: displayText(l.text) }))
  }
  return Box({ flexDirection: 'column', paddingX: 1, children: kids })
}


async function osLabel($) {
  if (await safe($.env.get('OS')) === 'Windows_NT') return 'Windows'
  const uname = await safe($.process.run(['uname', '-s']))
  const name = uname && uname.exitCode === 0 && typeof uname.stdout === 'string' ? uname.stdout.trim() : ''
  if (name === 'Linux') return 'Linux'
  if (name !== 'Darwin') return 'unknown'
  const version = await safe($.process.run(['sw_vers', '-productVersion']))
  const value = version && version.exitCode === 0 && typeof version.stdout === 'string' ? version.stdout.trim() : ''
  return /^\d+(\.\d+){1,2}$/.test(value) ? 'macOS ' + value : 'macOS'
}

async function claudeCodeBase($) {
  const version = await safe($.session.version())
  const match = version && typeof version.base === 'string' ? /^(\d+\.\d+\.\d+)\b/.exec(version.base) : null
  return match ? match[1] : 'unknown'
}

async function onFeedback($) {
  try {
    if (!(await ensureInteractive($))) return {}
    const routing = H.routing() || {}
    U.feedback = cleanFields({ iqVersion: VERSION, os: await osLabel($), claudeCode: await claudeCodeBase($), routing: routing.status, lastError: routing.last_error })
    const opened = await $.ui.open({ id: 'feedback', title: 'Feedback', focus: true, closeOnEscape: true })
    if (opened && opened.isPlaced === false) say($, 'feedback could not open its pane (' + displayText(opened.reason) + ').')
    else $.ui.invalidate('ui.render')
  } catch (_) {
    say($, 'feedback could not open its pane (unavailable).')
  }
  return {}
}

function drawFeedback($, e, next) {
  if (!U.feedback) return next(e)
  const { Box, Text, Link, Button } = $.ui.resolve(e)
  const f = U.feedback
  const kids = [
    Text({ bold: true, children: 'Send feedback' }),
    Text({ children: 'Each link opens a GitHub issue on the public repo, with these five values already filled in:' }),
    Text({ children: 'IQ Code version ' + f.iqVersion + ' · OS ' + f.os + ' · Claude Code version ' + f.claudeCodeVersion + ' · Routing ' + f.routing + ' · Last error ' + f.lastError }),
    Text({ children: ' ' }),
  ]
  for (const [kind, label] of [['bug', 'Report a bug'], ['feature', 'Request a feature'], ['question', 'Ask a routing question']]) {
    const href = issueUrl(kind, f)
    kids.push(Box({ flexDirection: 'row', columnGap: 2, children: [
      Link({ href, label }),
      Button({ key: 'copy-' + kind, label: 'Copy link', plain: true, onPress: async (press) => {
        let copied
        try { copied = await $.ui.copy({ text: href, surface: press.surface }) } catch (_) { /* unavailable */ }
        await safe($.ui.toast(copied && copied.isCopied ? 'Link copied.' : 'Copy is not available here. Select the link instead.'))
      } }),
    ] }))
  }
  kids.push(
    Text({ children: ' ' }),
    Text({ dimColor: true, children: 'Nothing else is included. No prompts, keys or file paths.' }),
    Text({ dimColor: true, children: 'Account, billing or sign-in? Email ' + SUPPORT_EMAIL + '. Do not put account details in a public issue.' }),
    Text({ dimColor: true, children: 'We read issues. We cannot promise a reply or a fix on any timeline.' }),
  )
  return Box({ flexDirection: 'column', paddingX: 1, children: kids })
}

export { WORDS }
