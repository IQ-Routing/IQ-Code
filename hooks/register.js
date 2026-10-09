



























import { NAME, VERSION, CARD_FILE, PIN_CARD, DATA_DIR, MAX_ERRORS, ERROR_LOG_CAP, LOG_PART_CAP, LOG_MAX_PARTS } from './lib/pins.js'
import * as State from './lib/state.js'
import { FORCE_SERVER } from './lib/runtime_mode.js'
import { makePricer, modelClass, effortClass } from './lib/pricing.js'
import {
  newTracker,
  noteSubmit,
  fillSubmit,
  dropPending,
  onTurnStart,
  onStepStart,
  onStepEnd,
  onTurnComplete,
  applyBootstrap,
  dirtySegments,
  isHumanKind,
  sessionMeter,
} from './lib/tracker.js'
import { sendLine, NOTICE } from './lib/format.js'
import { bytesFromBase64, sha256Hex, utf8, dayOf, isoOf, errText, tailLines, mergeRows } from './lib/util.js'
import { meterView, noteSeries } from './lib/meterview.js'
import { registerUi, uiReset, uiTurnDone, uiEnd } from './ui_handlers.js' 
import { buildRouteBody, estimateRequest, usageRequest, parseRoutingPlan, isFreePlan, routingUsage, classifyResponse, safeErr, deadlineFrom, BACKOFF_MS, destinationFrom, effortSettings, userOrigin, scrub, cleanText, MAX_HISTORY_MESSAGES, displayText } from './lib/iq_client.js'
import { readKey, validKey, trafficOff, homeFrom, pathIn } from './lib/traffic.js'
import { guessEffort, sameModel, capEffort } from './lib/models.js'
import {
  noteRoutingUsage,
  usageLine,
  RT_DIR,
  RT_VERSION,
  MAX_IQ_FAILS,
  TEXT,
  newRouter,
  newRecord,
  forgetRecord,
  planSubmit,
  decide,
  settleDecision,
  settleNone,
  settlePause,
  settleRefused,
  noteMainStep,
  noteRecStep,
  noteTurnDone,
  decisionRow,
  lineFor,
  statusLines,
  onLine,
  planPauseText,
  routingState,
  cacheTtlMs,
  onSubscription,
  ttlIsKnown,
} from './lib/router.js'
import { registerRoute } from './route_handlers.js'
import { measureTaskBudget } from './route_handlers.js'
import { newSettingsClient } from './lib/session_defaults.js'

const PANE = 'iq'

async function userHome($) {
  return homeFrom(await safe($.env.get('USERPROFILE')), await safe($.env.get('HOME')))
}


function iqAccess($) {
  return {
    configured: () => pluginKey(),
    home: async () => homeFrom(await $.env.get('USERPROFILE'), await $.env.get('HOME')),
    exists: (path) => $.fs.exists(path),
    read: (path) => $.fs.read(path),
    user: () => $.settings.read({ source: 'user' }),
    nonessential: () => $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'),
    disabled: () => $.env.get('IQ_ROUTER_DISABLED'),
  }
}

const serverMode = () => FORCE_SERVER

let T = newTracker() 
let M = newMeter() 
let R = newRouter() 
let RM = newRuntime() 

function newMeter() {
  return {
    ready: false, 
    off: null, 
    tableHash: null,
    pricer: null,
    root: null,
    home: null,
    sessionId: null,
    startedMs: 0,
    nowMs: 0, 
    errors: 0,
    quiet: false,
    sent: null, 
    usage: { rateLimits: [], contextTokens: undefined },
    lastPlan: '',
    read: { state: 'idle', data: null, note: '' },
    tab: 'routing', 
    series: [], 
    readEpoch: 0,
    epoch: 0,
    boot: 'idle', 
    bootAsOf: 0,
    effortTried: false,
    interactive: false, 
    endReason: null, 
    provisionalKnown: false, 
    chain: Promise.resolve(),
    errChain: Promise.resolve(),
    errQueue: [], 
  }
}

function newRuntime() {
  return {
    ready: false, 
    pricer: null,
    root: null,
    home: null,
    cwd: null,
    nowMs: 0, 
    requestEpoch: 0,
    planProbe: null, 
    typedPrompts: [], 
    pending: null, 
    byTurn: new Map(), 
    turnSteps: new Map(), 
    chain: Promise.resolve(), 
    errChain: Promise.resolve(),
    errQueue: [], 
    day: '',
    part: 0,
    ttl: { force5m: false, envTtl: '', settingTtl: '', enable1h: false },
  }
}


let pluginKey = () => undefined
let SD = null

function startSessionDefaults($) {
  if (SD) SD.client.end()
  State.startSettingsSession()
  const record = { sid: M.sessionId, client: null }
  record.client = newSettingsClient({ now: () => M.nowMs, later: (ms, fn) => $.clock.after(ms, fn),
    fetch: (url, init) => $.http.fetch(url, init),
    onResult: (value) => { if (SD === record && M.sessionId === record.sid) State.stageDashboardDefaults(value) },
  })
  SD = record
  scheduleSessionDefaults($)
}

function scheduleSessionDefaults($) {
  const record = SD
  if (!record) return
  $.clock.after(0, () => {
    void (async () => {
      if (SD !== record || record.sid !== M.sessionId || await trafficOff(iqAccess($))) return
      const key = await readKey(iqAccess($))
      if (!key) return
      const destination = destinationFrom(await safe($.settings.read({ source: 'user' })))
      if (SD === record && record.sid === M.sessionId) record.client.request({ ...destination, key })
    })().catch(() => {}) 
  })
}

function prepareSessionDefaults($) {
  if (!SD || SD.sid !== M.sessionId) startSessionDefaults($)
  State.applyDashboardDefaults()
  scheduleSessionDefaults($)
}

export function register(on, options = {}) {
  const configuredKey = options.iq_api_key
  pluginKey = () => configuredKey
  
  registerRoute(on, { getR: () => R, getRM: () => RM, getM: () => M, getT: () => T, pluginKey,
  })
  

  
  
  on('session.start', async ($, e, next) => {
    try {
      await startMeter($, e)
    } catch (err) {
      countError($, 'session.start', err)
    }
    try {
      await rtStart($, e)
    } catch (err) {
      await rtNoteError($, 'session.start', err)
    }
    uiReset() 
    try { startSessionDefaults($) } catch (_) {}
    const result = await next(e)
    try {
      await writeStatus($, e)
    } catch (err) {
      countError($, 'session.start', err)
    }
    await flushErrors($)
    return result
  })

  
  
  
  on('prompt.submit', async ($, e, next) => {
    await safe(ensureInteractive($)) 
    let sub = null
    if (M.ready && !M.quiet) {
      try {
        sub = await onSubmit($, e)
      } catch (err) {
        countError($, 'prompt.submit', err)
      }
    }
    let rsub = null
    try { prepareSessionDefaults($) } catch (_) {}
    try {
      rsub = await rtSubmit($, e)
    } catch (err) {
      await rtNoteError($, 'prompt.submit', err)
    }
    let result
    try { result = await next(e) } catch (err) { if (rsub !== null) rtDropped(rsub); throw err }
    if (rsub !== null && result && result.drop !== undefined) {
      try {
        rtDropped(rsub) 
      } catch (err) {
        await rtNoteError($, 'prompt.submit', err)
      }
    }
    else if (rsub && rsub.start) rsub.start()
    if (sub !== null) {
      try {
        if (result && result.drop !== undefined) dropPending(sub.tracker, sub.pend)
        else if (!M.quiet) {
          const line = await onSubmitLate($, e, sub)
          if (line) say($, line)
        }
      } catch (err) {
        countError($, 'prompt.submit', err)
      }
    }
    await flushErrors($)
    return result
  }).catch(($, e, next) => next(e)) 

  on('turn.start', async ($, e, next) => {
    if (M.ready && !M.quiet) {
      try {
        M.nowMs = await $.clock.now()
        onTurnStart(T, { nowMs: M.nowMs })
        $.ui.invalidate('ui.render')
      } catch (err) {
        countError($, 'turn.start', err)
      }
    }
    try {
      rtTurnStart(e)
    } catch (err) {
      await rtNoteError($, 'turn.start', err)
    }
    const result = await next(e)
    await flushErrors($)
    return result
  })

  
  
  
  on('turn.step', async function* ($, e, next) {
    let begun = { e2: e, startMs: null, rec: null }
    try {
      begun = await rtStepBegin($, e)
    } catch (err) {
      await rtNoteError($, 'turn.step', err)
    }
    let key = null
    if (M.ready && !M.quiet) {
      try {
        key = await stepBegin($, begun.e2)
      } catch (err) {
        countError($, 'turn.step', err)
      }
    }
    let result
    if (begun.e2 === e) {
      result = yield* next(e)
    } else {
      let started = false
      let finished = false
      let stream = null
      try {
        stream = next(begun.e2)
        let s = await stream.next()
        while (s.done !== true) {
          started = true
          yield s.value
          s = await stream.next()
        }
        result = s.value
        finished = true
      } catch (err) {
        finished = true 
        if (started) throw err
        await rtNoteError($, 'turn.step.rewrite', err)
        if (begun.rec !== null) settleRefused(R, begun.rec) 
        begun = { e2: e, startMs: begun.startMs, rec: begun.rec }
        result = yield* next(e)
      } finally {
        if (!finished && stream !== null) {
          try {
            await stream.return(undefined) 
          } catch (_) {
            
          }
        }
      }
    }
    if (key !== null && !M.quiet) {
      try {
        await stepEnd($, begun.e2, key, result)
      } catch (err) {
        countError($, 'turn.step', err)
      }
    }
    try {
      await rtStepEnd($, begun.e2, result, begun)
    } catch (err) {
      await rtNoteError($, 'turn.step', err)
    }
    await flushErrors($)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    await safe(ensureInteractive($))
    let line = null
    if (M.ready && !M.quiet) {
      try {
        line = await onComplete($, e)
      } catch (err) {
        countError($, 'turn.complete', err)
      }
    }
    const result = await next(e)
    try {
      await rtComplete($, e) 
    } catch (err) {
      await rtNoteError($, 'turn.complete', err)
    }
    uiTurnDone() 
    if (M.ready && !M.quiet) {
      try {
        await flushRows($, M.nowMs) 
      } catch (err) {
        countError($, 'turn.complete', err)
      }
    }
    await flushErrors($)
    if (line === null || !M.interactive) return result
    
    const inner = result && typeof result.text === 'string' && result.text !== e.answer && result.text !== '' ? result.text + '\n' : ''
    return { ...result, text: inner + line }
  })

  
  
  on('session.attach', async ($, e, next) => {
    const result = await next(e)
    try {
      if (!M.interactive) {
        M.interactive = true
        $.ui.invalidate('ui.render')
        await writeStatus($, e)
      }
    } catch (err) {
      countError($, 'session.attach', err)
    }
    await flushErrors($)
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (M.ready && !M.quiet) {
      try {
        await onMeasure($, e)
        if (measureTaskBudget()) $.ui.invalidate('ui.render')
      } catch (err) {
        countError($, 'session.measure', err)
      }
    }
    await flushErrors($)
    return result
  })

  
  on('session.end', async ($, e, next) => {
    
    R.armed = false
    RM.requestEpoch += 1
    if (SD) SD.client.end()
    SD = null
    if (M.ready && !M.quiet) {
      try {
        await onEnd($, e)
      } catch (err) {
        countError($, 'session.end', err)
      }
    }
    try {
      await rtEnd($, e)
    } catch (err) {
      await rtNoteError($, 'session.end', err)
    }
    uiEnd() 
    await flushErrors($)
    return next(e)
  })

  
  
  on('command.run', { command: 'cost-read' }, async ($, e, next) => {
    try {
      return await onCostRead($, e)
    } catch (err) {
      countError($, 'command.run', err)
      say($, 'cost-read hit an internal error (see ~/.claude/iq/meter/errors.log).')
      await flushErrors($)
      return {}
    }
  })

  on('command.run', { command: 'iq-route' }, async ($, e, next) => {
    try {
      return await rtCommand($, e)
    } catch (err) {
      await rtNoteError($, 'command.run', err)
      await flushErrors($)
      return { text: 'iq-route hit an internal error (see ~/.claude/iq/router/errors.log).' }
    }
  })

  
  registerUi(on, {
    pluginKey,
    ready: () => M.ready && !M.quiet,
    interactive: () => M.interactive,
    markInteractive: () => (M.interactive = true),
    meter: (isWorking) => sessionMeter(currentMeterView(isWorking), T),
    routing: () => currentRouting(),
    bandRouting: () => bandRouting(),
    router: () => R,
    pricer: () => RM.pricer || M.pricer,
    usage: () => M.usage,
    working: () => T.turnOpen === true,
    sent: () => M.sent,
    sessionId: () => M.sessionId,
    read: () => M.read,
    tab: { get: () => M.tab, set: (t) => (M.tab = t) },
    notReadyText: () => NOTICE.notReady + (M.off || 'it did not start') + '.',
  })
  
}




async function startMeter($, e) {
  M = newMeter()
  T = newTracker()
  M.interactive = !!(e && e.isInteractive === true) 
  if (!M.interactive) await ensureInteractive($) 
  M.root = $.plugin.root
  M.startedMs = await $.clock.now()
  M.nowMs = M.startedMs
  M.home = await userHome($)
  
  try {
    await $.command.register({ name: 'cost-read', description: 'Cost read of this session (API-equivalent dollars)', argumentHint: '[session id]', immediate: true })
    await $.command.register({ name: 'iq', description: 'IQ routing, cost and plan at a glance', immediate: true })
  } catch (err) {
    countError($, 'session.start.command', err)
  }
  
  State.loadSettings(null)
  try {
    const path = pathIn(M.home, '.claude/iq/settings.json')
    if (M.home && await $.fs.exists(path)) State.loadSettings(JSON.parse(await $.fs.read(path)))
  } catch (_) {}
  let problem = null
  try {
    problem = await loadData($)
  } catch (err) {
    problem = 'missing'
    countError($, 'session.start.load', err)
  }
  if (problem !== null) {
    M.off = problem === 'changed' ? 'its cost data is not the version it was built with' : 'its cost data files could not be read'
    say($, problem === 'changed' ? NOTICE.tablesChanged : NOTICE.dataMissing)
    return
  }
  M.ready = true
  M.sessionId = (await safe($.session.id())) || null
  const usage = await safe($.session.usage())
  if (usage) takeUsage(usage)
  M.bootAsOf = M.startedMs
  await maybeBootstrap($, false)
}


async function loadData($) {
  const c = await $.fs.read(pathIn(M.root, CARD_FILE), { as: 'bytes' })
  const cb = bytesFromBase64(c.base64)
  if ((await sha256Hex(cb)) !== PIN_CARD) return 'changed'
  M.pricer = makePricer(JSON.parse(utf8(cb)))
  if (serverMode()) return null
  return null
}





async function writeStatus($, e) {
  if (!M.home) return
  try {
    const ver = await safe($.session.version())
    const status = {
      name: NAME,
      version: VERSION,
      started: isoOf(M.startedMs),
      meter: M.ready ? 'on' : 'off',
      reason_off: M.off,
      claude_code: ver ? ver.version : null,
      claude_code_base: ver && ver.base ? ver.base : null,
      surface: e && e.surface ? e.surface : null,
      interactive: M.interactive,
      ...(serverMode() ? { forecast_source: 'server' } : {}),
      card_sha256: PIN_CARD.slice(0, 16),
    }
    await $.fs.write(pathIn(M.home, DATA_DIR, 'status.json'), JSON.stringify(status, null, 1) + '\n')
  } catch (err) {
    countError($, 'status.write', err)
  }
}

function takeUsage(u) {
  M.usage = {
    rateLimits: Array.isArray(u.rateLimits) ? u.rateLimits : [],
    contextTokens: u.context && typeof u.context.tokens === 'number' ? u.context.tokens : undefined,
  }
}



async function maybeBootstrap($, force) { const turns = await safe($.session.turns()); const known = force === true || typeof turns === 'number' && turns > 0; T.historyKnown = known; M.boot = known ? 'failed' : 'none' }









async function onSubmit($, e) {
  const kind = e.origin && e.origin.kind
  if (!isHumanKind(kind)) return null
  const got = await Promise.all([safe($.clock.now()), safe($.session.id())])
  const nowMs = typeof got[0] === 'number' ? got[0] : M.nowMs
  M.nowMs = nowMs
  if (syncSession(got[1])) {
    
    M.bootAsOf = nowMs
    await maybeBootstrap($, true)
  }
  const usage = await safe($.session.usage())
  if (usage) takeUsage(usage)
  
  const prev = usage ? M.usage.contextTokens : T.lastMainCtx === null ? undefined : T.lastMainCtx
  
  
  const estimate = prev === undefined && M.interactive ? safe($.session.usage({ breakdown: 'summary' })) : null
  const chars = typeof e.text === 'string' ? e.text.length : 0
  const pend = noteSubmit(T, { kind, nowMs, chars })
  return { pend, tracker: T, nowMs, chars, prev, estimate }
}



async function onSubmitLate($, e, sub) { return null }



function freshSession() {
  return R.last === null && R.stats.turns === 0 && T.lastMainEndMs === null && T.historyKnown !== true && M.boot !== 'done' && M.boot !== 'running'
}


function windowEstimate(u) {
  const b = u && u.context && u.context.breakdown
  const n = b && typeof b.totalTokens === 'number' ? b.totalTokens : undefined
  return n !== undefined && Number.isFinite(n) && n >= 0 ? n : undefined
}

async function settingsEffort($) {
  try {
    const s = await $.settings.read()
    const lv = s && typeof s.effortLevel === 'string' ? s.effortLevel : null
    return lv ? effortClass(lv) : null
  } catch (_) {
    return null
  }
}


function syncSession(sid) {
  if (typeof sid !== 'string' || sid === '') return false
  if (M.sessionId === null) {
    M.sessionId = sid
    if (M.boot !== 'idle') return false 
    noteNewSession()
    return true
  }
  if (sid !== M.sessionId) {
    resetForNewSession(sid)
    noteNewSession()
    return true
  }
  return false
}





function noteNewSession() {
  const why = M.endReason
  M.endReason = null
  if (why === 'clear') M.effortTried = false
  else if (why !== null) {
    T.historyKnown = true
    M.provisionalKnown = true
  }
}

function resetForNewSession(sid) {
  T = newTracker()
  M.sessionId = sid
  M.epoch += 1
  M.readEpoch += 1
  M.read = { state: 'idle', data: null, note: '' }
  M.series = []
  M.boot = 'idle'
  M.lastPlan = ''
  M.provisionalKnown = false
}




async function stepBegin($, e) {
  const nowMs = await $.clock.now()
  M.nowMs = nowMs
  const key = String(e.turnId) + ':' + String(e.index) + ':' + (e.agentId ? String(e.agentId) : '')
  onStepStart(T, { key, agentId: e.agentId, model: e.model, effort: e.effort, nowMs, modelClass: modelClass(e.model), effortClass: effortClass(e.effort) })
  if (!e.agentId) M.sent = { model: e.model, effort: e.effort === undefined ? null : e.effort } 
  $.ui.invalidate('ui.render')
  return key
}

async function stepEnd($, e, key, result) {
  const nowMs = await $.clock.now()
  M.nowMs = nowMs
  const u = result && result.usage && typeof result.usage === 'object' ? result.usage : null
  const model = (u && u.model) || e.model
  const price = u ? M.pricer.price(model, u, { main: !e.agentId }) : null
  onStepEnd(T, { key, agentId: e.agentId, model, effort: e.effort, hasUsage: price !== null, price, nowMs, modelClass: modelClass(model), effortClass: effortClass(e.effort),
    usageComplete: !!u && ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].every((k) => Number.isSafeInteger(u[k]) && u[k] >= 0) })
  if (T.cur && T.cur.human) noteSeries(M.series, T.cur.idx, T.cur.usd)
  $.ui.invalidate('ui.render')
}




async function onComplete($, e) {
  const nowMs = await $.clock.now()
  M.nowMs = nowMs
  const r = onTurnComplete(T, { agentId: e.agentId, nowMs, isAborted: e.isAborted, durationMs: e.durationMs })
  $.ui.invalidate('ui.render')
  if (!r.isMain || !r.seg) return null
  const seg = r.seg
  
  if (seg.k === 0 || !M.interactive) return null
  
  
  return null
}

async function onMeasure($, e) { M.nowMs = await $.clock.now(); takeUsage(e); $.ui.invalidate('ui.render') }

async function onEnd($, e) {
  try {
    const nowMs = await $.clock.now()
    M.nowMs = nowMs
    await flushRows($, nowMs)
  } finally {
    if (e.reason === 'clear' || e.reason === 'resume') {
      resetForNewSession(null) 
      M.endReason = e.reason 
    }
  }
}





const r6 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : null)






async function flushRows($, nowMs) {}


async function queueWrite($, rows, nowMs) {}











function countError($, where, err) {
  M.errors += 1
  if (M.home) {
    const nowMs = typeof M.nowMs === 'number' && M.nowMs > 0 ? M.nowMs : Date.now()
    M.errQueue.push(isoOf(nowMs) + ' ' + where + ' ' + safeErr(err, [pluginKey(), validKey(pluginKey())]) + '\n')
    if (M.errQueue.length > 50) M.errQueue.shift()
  }
  if (M.errors >= MAX_ERRORS && !M.quiet) {
    M.quiet = true
    say($, NOTICE.quiet)
  }
}

async function flushErrors($) {
  if (M.errQueue.length > 0) {
    const lines = M.errQueue.join('')
    M.errQueue = []
    try {
      const path = pathIn(M.home, DATA_DIR, 'errors.log')
      const run = async () => {
        let text = ''
        if (await $.fs.exists(path)) text = await $.fs.read(path)
        await $.fs.write(path, tailLines(text + lines, ERROR_LOG_CAP))
      }
      M.errChain = M.errChain.then(run, run)
      await M.errChain
    } catch (_) {
      
    }
  }
  if (RM.errQueue.length > 0) {
    const lines = RM.errQueue.join('')
    RM.errQueue = []
    try {
      const path = pathIn(RM.home, RT_DIR, 'errors.log')
      const run = async () => {
        let text = ''
        if (await $.fs.exists(path)) text = await $.fs.read(path)
        await $.fs.write(path, tailLines(text + lines, ERROR_LOG_CAP))
      }
      RM.errChain = RM.errChain.then(run, run)
      await RM.errChain
    } catch (_) {
      
    }
  }
}




async function ensureInteractive($) {
  if (M.interactive) return true
  const s = await safe($.session.surfaces())
  if (Array.isArray(s) && s.length > 0) {
    M.interactive = true
    $.ui.invalidate('ui.render')
  }
  return M.interactive
}


function say($, text) {
  if (!M.interactive) return
  try {
    void safe($.ui.log(displayText(text)))
  } catch (_) {
    
  }
}

function safe(p) {
  return Promise.resolve(p).then(
    (v) => v,
    () => undefined,
  )
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch (_) {
    return null
  }
}











async function onCostRead($, e) { await ensureInteractive($); M.tab = 'cost'; M.read = { state: 'ready', data: { ok: true, totals: { usd: T.usd, calls: T.calls, main_calls: T.mainCalls, helper_calls: T.helperCalls, unpriced_calls: T.unpriced } }, note: '' }; await $.ui.open({ id: PANE, title: 'Measured cost', focus: true, closeOnEscape: true }); return {} }








function currentMeterView(isWorking) { return meterView({ working: !!(isWorking && T.cur), seg: isWorking ? T.cur : null, rem: null, totals: { usd: T.usd, calls: T.calls, activeMs: T.activeMs }, rateLimits: M.usage.rateLimits, promptUsd: M.series }) }



function currentRouting() {
  try {
    return routingState(R, Math.max(M.nowMs, RM.nowMs))
  } catch (_) {
    return ROUTING_OFF
  }
}


function bandRouting() {
  const r = currentRouting()
  return R.armed || r.status === 'paused_plan' ? r : ROUTING_OFF
}
const ROUTING_OFF = { v: 1, status: 'off', pause_until: null, named: null, current: null, session: null, last_error: null }




async function rtStart($, e) {
  R = newRouter()
  RM = newRuntime()
  RM.nowMs = await $.clock.now()
  RM.home = await userHome($)
  RM.cwd = e && typeof e.cwd === 'string' ? e.cwd : null
  RM.root = $.plugin.root
  
  try {
    await $.command.register({ name: 'iq-route', description: "Route this session's model and thinking level with IQ: on, off or status", argumentHint: 'on|off|status', immediate: true })
  } catch (err) {
    await rtNoteError($, 'session.start.command', err)
  }
  let problem = null
  try {
    problem = await rtLoadCard($)
  } catch (err) {
    problem = 'missing'
    await rtNoteError($, 'session.start.load', err)
  }
  if (problem !== null) {
    R.cardBad = true
    R.lastError = 'card_' + problem
    say($, TEXT.cardChanged)
    return
  }
  RM.ready = true
  await rtGates($)
}


async function rtLoadCard($) {
  const c = await $.fs.read(pathIn(RM.root, CARD_FILE), { as: 'bytes' })
  const bytes = bytesFromBase64(c.base64)
  if ((await sha256Hex(bytes)) !== PIN_CARD) return 'changed'
  RM.pricer = makePricer(JSON.parse(utf8(bytes)))
  return null
}

const truthy = (v) => typeof v === 'string' && v.trim() !== '' && !['0', 'false', 'no', 'off'].includes(v.trim().toLowerCase())



async function rtGates($) {
  R.killed = await trafficOff(iqAccess($))
  const key = await readKey(iqAccess($))
  R.hasKey = typeof key === 'string' && key.trim() !== ''
  const cwd = (await safe($.session.cwd())) || RM.cwd
  if (typeof cwd === 'string') RM.cwd = cwd
}


async function rtKillCheck($) {
  R.killed = await trafficOff(iqAccess($))
}


async function rtSettings($) {
  const force = await safe($.env.get('FORCE_PROMPT_CACHING_5M'))
  const envTtl = await safe($.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'))
  const one = await safe($.env.get('ENABLE_PROMPT_CACHING_1H'))
  const s = await safe($.settings.read())
  RM.ttl = {
    force5m: truthy(force),
    envTtl: typeof envTtl === 'string' ? envTtl.trim() : '',
    settingTtl: s && typeof s.promptCacheTtl === 'string' ? s.promptCacheTtl : '',
    enable1h: truthy(one),
  }
}




async function rtNamedHint($) {
  const sessionModel = await safe($.session.model())
  const model = typeof sessionModel === 'string' && sessionModel !== '' ? sessionModel : R.named ? R.named.model : undefined
  if (R.named && sameModel(R.named.model, model)) return { model, effort: R.named.effort }
  
  if (!R.named && R.last && sameModel(R.last.model, model)) return { model, effort: R.last.effort }
  const env = await safe($.env.get('CLAUDE_CODE_EFFORT_LEVEL'))
  const sources = {}
  for (const name of ['user', 'project', 'local', 'flag', 'policy']) sources[name] = effortSettings(await safe($.settings.read({ source: name })))
  return { model, effort: guessEffort({ model, env, sources }) }
}




const rtIsHuman = (e) => {
  return userOrigin(e)
}


async function rtSubmit($, e) {
  if (!RM.ready || !R.armed || !rtIsHuman(e)) return null 
  if (e.turnId !== undefined) return null 
  const nowMs = await $.clock.now()
  RM.nowMs = nowMs
  await rtKillCheck($)
  const plan = planSubmit(R, nowMs, R.ttlMs)
  if (plan.action === 'skip') return null
  R.seq += 1
  R.deadlineMs = deadlineFrom(await safe($.env.get('IQ_ROUTER_DEADLINE_MS')))
  const sessionModel = R.named ? null : await safe($.session.model())
  const rec = newRecord(R, { nowMs, sessionModel })
  rec.counted = plan.counted
  if (rec.counted) R.counters.prompts += 1
  const sub = { rec, prev: R.current, runtime: RM, router: R }
  R.current = rec
  RM.pending = rec
  if (plan.action === 'local') {
    rec.local = plan
    return sub
  }
  const key = await readKey(iqAccess($))
  if (typeof key !== 'string' || key.trim() === '') {
    rec.local = { action: 'local', phase: 'error', reason: 'error', source: 'none', counted: true, error: 'no_key' }
    return sub
  }
  
  rec.result = null
  let finish
  rec.job = new Promise((resolve) => {
    finish = resolve
  })
  const text = typeof e.text === 'string' ? e.text : ''
  const rows = RM.typedPrompts.slice()
  const runtime = RM
  const requestEpoch = RM.requestEpoch
  sub.start = () => {
    if (RM !== runtime || RM.requestEpoch !== requestEpoch) { finish(); return }
    RM.typedPrompts.push({ role: 'user', source: 'typed', text: scrub(cleanText(text), [key]).slice(-32000) })
    if (RM.typedPrompts.length > MAX_HISTORY_MESSAGES) RM.typedPrompts.shift()
    $.clock.after(0, () => {
      void rtEstimateJob($, rec, text, key.trim(), rows, runtime, requestEpoch).then(
        (c) => {
          rec.result = c
          if (rec.decided && typeof c.doneMs === 'number') rec.lateMs = Math.max(0, c.doneMs - rec.submitMs)
          finish()
        },
        () => finish(),
      )
    })
  }
  return sub
}


function rtDropped(sub) {
  if (RM !== sub.runtime || R !== sub.router) return
  if (RM.pending === sub.rec) RM.pending = null
  if (sub.rec.counted) R.counters.prompts -= 1
  R.seq -= 1
  if (R.current === sub.rec) R.current = sub.prev
  forgetRecord(R, sub.rec)
}


async function rtFetch($, req, ms, runtime, requestEpoch) {
  if (ms <= 0 || !R.armed || await trafficOff(iqAccess($)) || RM !== runtime || RM.requestEpoch !== requestEpoch) return null
  return new Promise((resolve, reject) => {
    let done = false
    const timer = $.clock.after(ms, () => { if (!done) { done = true; resolve(null) } })
    $.http.fetch(req.url, req.init).then(
      (res) => { if (!done) { done = true; timer.cancel(); resolve(res) } },
      (err) => { if (!done) { done = true; timer.cancel(); reject(err) } },
    )
  })
}


async function rtEstimateJob($, rec, text, key, rows, runtime, requestEpoch) {
  try {
    if (!R.armed || await trafficOff(iqAccess($)) || RM !== runtime || RM.requestEpoch !== requestEpoch) return { kind: 'error', code: 'traffic_disabled', latencyMs: 0, doneMs: RM.nowMs }
    const named = await rtNamedHint($)
    const observed = await safe($.session.usage())
    const seen = observed && observed.context && observed.context.tokens
    let context = Math.max(typeof seen === 'number' ? seen : 0, R.last ? R.last.ctx : 0) || null
    if (context === null && freshSession()) context = windowEstimate(await safe($.session.usage({ breakdown: 'summary' }))) || null
    R.ttlMs = cacheTtlMs({ ...RM.ttl, onSubscription: onSubscription(observed && observed.rateLimits) })
    R.ttlKnown = ttlIsKnown(RM.ttl, observed && observed.rateLimits)
    const now = await $.clock.now()
    const built = buildRouteBody(Array.isArray(rows) ? rows : [], text, [key], {
      chosen: { model: named.model, effort: named.effort ?? null },
      last_served: R.last ? { model: R.last.model, effort: R.last.effort } : null,
      seconds_since_last_call: R.last ? Math.max(0, (now - R.last.endMs) / 1000) : null,
      context_tokens: context, cached_prefix_tokens: R.last ? Math.min(context ?? 0, R.last.cachedPrefix || 0) : 0,
      cache_ttl_seconds: R.ttlKnown ? (R.ttlMs >= 3600000 ? 3600 : 300) : null, turn_kind: 'main',
    })
    rec.sent = built.sent
    const { base, dev } = destinationFrom(await safe($.settings.read({ source: 'user' })))
    if (base === null) return { kind: 'error', code: 'bad_base', latencyMs: 0, doneMs: RM.nowMs }
    const req = estimateRequest({ base, key, body: built.body, named, version: RT_VERSION, dev })
    if (req === null) return { kind: 'error', code: 'bad_base', latencyMs: 0, doneMs: RM.nowMs }
    const t0 = await $.clock.now()
    const res = await rtFetch($, req, Math.max(0, rec.deadlineMs - t0), runtime, requestEpoch)
    if (res === null) return { kind: 'timeout', code: 'timeout', latencyMs: Math.max(0, (await $.clock.now()) - t0), doneMs: await $.clock.now() }
    const t1 = await $.clock.now()
    const c = classifyResponse(res)
    noteRoutingUsage(R, c.usage, t1)
    c.latencyMs = Math.max(0, t1 - t0)
    c.doneMs = t1
    if (c.kind === 'rate_limited') {
      R.backoffUntil = t1 + BACKOFF_MS
      R.backoffNoted = false
    }
    return c
  } catch (err) {
    await rtNoteError($, 'estimate', err, { secrets: [key], count: false })
    return { kind: 'error', code: 'network', latencyMs: 0, doneMs: RM.nowMs }
  }
}

function rtTurnStart(e) {
  const rec = RM.pending
  if (!rec) return
  RM.pending = null
  rec.turnId = e.turnId
  RM.byTurn.set(e.turnId, rec)
  if (RM.byTurn.size > 64) RM.byTurn.delete(RM.byTurn.keys().next().value) 
}




const rtLive = () => RM.ready && R.armed && !R.errorsOff && !R.stopped && !R.killed


async function rtStepBegin($, e) {
  const out = { e2: e, startMs: null, rec: null, changed: false }
  if (!RM.ready) return out
  const main = e.agentId === undefined || e.agentId === null
  if (!main) return out 
  const rec = RM.byTurn.get(e.turnId) || null
  if (!rec && !rtLive()) {
    
    
    out.startMs = await $.clock.now()
    return out
  }
  out.rec = rec
  if (rec !== null && !rec.decided) {
    rec.named = { model: e.model, effort: e.effort === undefined ? null : e.effort }
    R.named = rec.named
    await rtDecide($, rec)
  }
  out.startMs = await $.clock.now()
  RM.nowMs = out.startMs
  if (rec !== null && rec.decided) out.e2 = rtApply(e, rec)
  out.changed = out.e2 !== e 
  return out
}



function rtApply(e, rec) {
  if (R.stopped || rec.phase !== 'applied' || !rec.named || e.model !== rec.named.model) return e
  const want = rec.choice
  const e2 = { ...e }
  let changed = false
  if (want.model !== e.model) {
    e2.model = want.model
    changed = true
  }
  const effort = capEffort(want.effort, e.effort)
  if (effort !== null && effort !== undefined && effort !== e.effort) {
    e2.effort = effort
    changed = true
  }
  return changed ? e2 : e
}


async function rtDecide($, rec) {
  const t0 = await $.clock.now()
  let t1 = t0
  if (!rtLive()) {
    settleNone(R, rec, 'off', 'off')
  } else if (rec.local) {
    const p = rec.local
    if (p.phase === 'paused') settleNone(R, rec, 'paused', 'paused')
    else if (p.error === 'no_key') settleNone(R, rec, 'error', 'error', 'no_key')
    else settleNone(R, rec, 'error', 'backoff', 'http_429')
  } else {
    if (rec.result === null && rec.deadlineMs > t0) await rtRace($, rec.job, rec.deadlineMs - t0)
    t1 = await $.clock.now()
    rec.waitMs = Math.max(0, t1 - t0)
    const c = rec.result
    if (c === null || c.kind === 'timeout') {
      settleNone(R, rec, 'timeout', 'timeout', 'timeout')
      R.iqFails += 1
      await rtNoteError($, 'iq', new Error('timeout'), { count: false })
    } else if (c.kind === 'ok') {
      rec.latencyMs = c.latencyMs
      rec.iqRequestId = c.parsed.request_id
      const d = decide(R, { nowMs: t1, named: rec.named, est: c.parsed })
      settleDecision(R, rec, d)
      if (d.error !== null) {
        R.iqFails += 1
        await rtNoteError($, 'iq', new Error(d.error), { count: false })
      } else R.iqFails = 0
    } else if (c.kind === 'rate_limited') {
      rec.latencyMs = c.latencyMs
      settleNone(R, rec, 'error', 'error', 'http_429')
      await rtNoteError($, 'iq', new Error('http_429'), { count: false })
    } else if (['plan_required', 'allowance', 'free_quota', 'free_daily', 'auth_required'].includes(c.kind)) {
      
      rec.latencyMs = typeof c.latencyMs === 'number' ? c.latencyMs : null
      settlePause(R, rec, c.kind === 'plan_required' ? 'plan' : c.kind === 'auth_required' ? 'auth' : c.kind, t1)
      await rtNoteError($, 'iq', new Error(c.code), { count: false })
    } else {
      rec.latencyMs = typeof c.latencyMs === 'number' ? c.latencyMs : null
      settleNone(R, rec, 'error', 'error', c.code)
      R.iqFails += 1
      await rtNoteError($, 'iq', new Error(c.code), { count: false })
    }
  }
  if (R.iqFails >= MAX_IQ_FAILS && !R.errorsOff) {
    R.errorsOff = true
    say($, TEXT.quiet)
  }
  rtLineFor($, rec, t1)
  $.ui.invalidate('ui.render') 
}


function rtLineFor($, rec, nowMs) {
  if (rec.phase === 'paused') {
    if (['plan_required', 'allowance_exceeded', 'free_quota_exhausted', 'free_global_daily_quota_exhausted', 'key_rejected'].includes(rec.error)) R.pauseNoted = true 
    else {
      if (R.pauseNoted) return
      R.pauseNoted = true
    }
  } else if (rec.reason === 'backoff') {
    if (R.backoffNoted) return
    R.backoffNoted = true
  } else if (rec.error === 'http_429') R.backoffNoted = true
  const line = lineFor(rec, nowMs, R)
  if (line !== null) say($, line)
  const usage = usageLine(R, nowMs)
  if (usage && rec.source === 'iq_block') say($, usage)
}


function rtRace($, promise, ms) {
  return new Promise((resolve) => {
    let timer = null
    const done = () => {
      try {
        if (timer && typeof timer.cancel === 'function') timer.cancel()
      } catch (_) {
        
      }
      resolve()
    }
    promise.then(done, done)
    timer = $.clock.after(ms, done)
  })
}

async function rtStepEnd($, e2, result, begun) {
  if (begun.startMs === null || e2.agentId) return
  const u = result && result.usage && typeof result.usage === 'object' ? result.usage : null
  if (u === null) return 
  const nowMs = await $.clock.now()
  RM.nowMs = nowMs
  const prev = R.last 
  noteMainStep(R, { model: e2.model, effort: e2.effort, startMs: begun.startMs, endMs: nowMs, usage: u, routed: begun.changed === true })
  RM.turnSteps.set(e2.turnId, (RM.turnSteps.get(e2.turnId) || 0) + 1)
  if (begun.rec !== null && RM.pricer !== null) {
    
    noteRecStep(begun.rec, { model: e2.model, usage: u, pricer: RM.pricer, prev, startMs: begun.startMs, ttlMs: R.ttlKnown ? R.ttlMs : 60 * 60 * 1000, changed: begun.changed === true })
  }
}




async function rtComplete($, e) {
  if (!RM.ready || e.agentId) return
  const n = RM.turnSteps.get(e.turnId) || 0
  RM.turnSteps.delete(e.turnId)
  if (n > 0) R.stats.turns += 1
  const rec = RM.byTurn.get(e.turnId) || null
  if (rec === null) return
  RM.byTurn.delete(e.turnId)
  noteTurnDone(R, rec)
  
  if (!rec.decided) settleNone(R, rec, 'off', 'off')
  
  
  
  if (rec.routed && rec.steps === 0 && e.reason === 'error' && !R.stopped) {
    R.stopped = true
    rec.error = 'routed_request_rejected'
    R.lastError = 'routed_request_rejected'
    await rtNoteError($, 'turn.complete', new Error('routed_turn_failed'), { count: false })
    say($, TEXT.stopped)
    $.ui.invalidate('ui.render')
  }
  await rtWriteRows($, [rec])
}

async function rtEnd($, e) {
  if (e && (e.reason === 'clear' || e.reason === 'resume')) {
    RM.typedPrompts = []
  }
  if (!RM.ready) return
  const open = []
  for (const rec of RM.byTurn.values()) {
    if (!rec.decided) settleNone(R, rec, 'off', 'off') 
    if (!rec.done) {
      noteTurnDone(R, rec)
      open.push(rec)
    }
  }
  RM.byTurn.clear()
  if (open.length > 0) await rtWriteRows($, open)
  
  if (e && (e.reason === 'clear' || e.reason === 'resume')) {
    const flags = { killed: R.killed, cardBad: R.cardBad }
    R = newRouter()
    R.killed = flags.killed
    R.cardBad = flags.cardBad
    RM.pending = null
    RM.turnSteps.clear()
    await rtGates($)
  }
}




async function rtWriteRows($, recs) {
  const nowMs = await $.clock.now()
  RM.nowMs = nowMs
  const sid = await safe($.session.id())
  const rows = recs.map((rec) => decisionRow(R, rec, { nowMs, sessionId: typeof sid === 'string' ? sid : null }))
  const run = () => rtWriteFile($, rows, nowMs)
  RM.chain = RM.chain.then(run, run)
  try {
    await RM.chain
  } catch (err) {
    await rtNoteError($, 'decisions.write', err, { count: false })
  }
}

async function rtWriteFile($, rows, nowMs) {
  if (!RM.home) return
  const day = dayOf(nowMs)
  if (RM.day !== day) {
    RM.day = day
    RM.part = 0
  }
  const dir = pathIn(RM.home, RT_DIR, 'decisions')
  const addLen = rows.reduce((n, r) => n + JSON.stringify(r).length + 1, 0)
  for (let part = RM.part; part < LOG_MAX_PARTS; part++) {
    const path = pathIn(dir, day + (part === 0 ? '' : '-' + (part + 1)) + '.jsonl')
    let text = ''
    if (await $.fs.exists(path)) text = await $.fs.read(path) 
    if (text.length + addLen > LOG_PART_CAP) continue
    await $.fs.write(path, mergeRows(text, rows))
    RM.part = part
    return
  }
  
}






async function rtNoteError($, where, err, opt) {
  const o = opt || {}
  if (o.count !== false) {
    R.errors += 1
    R.lastError = 'internal'
  }
  if (RM.home) {
    const nowMs = typeof RM.nowMs === 'number' && RM.nowMs > 0 ? RM.nowMs : Date.now()
    RM.errQueue.push(isoOf(nowMs) + ' ' + where + ' ' + safeErr(err, [pluginKey(), validKey(pluginKey()), ...(o.secrets || [])]) + '\n')
    if (RM.errQueue.length > 50) RM.errQueue.shift()
  }
  if (R.errors >= MAX_ERRORS && !R.errorsOff) {
    R.errorsOff = true
    say($, TEXT.quiet)
  }
}






async function rtPlanCheck($, current) {
  try {
    const key = await readKey(iqAccess($))
    if (typeof key !== 'string' || key.trim() === '') return null
    const { base, dev } = destinationFrom(await safe($.settings.read({ source: 'user' })))
    const req = usageRequest({ base, key: key.trim(), version: RT_VERSION, dev })
    const ms = deadlineFrom(await safe($.env.get('IQ_ROUTER_DEADLINE_MS')))
    if (!req || await trafficOff(iqAccess($)) || !current()) return null
    let response = null
    const job = $.http.fetch(req.url, req.init).then((res) => { response = res }, () => {})
    await rtRace($, job, ms)
    return response && response.status >= 200 && response.status < 300
      ? { plan: parseRoutingPlan(response.text), usage: routingUsage(response.text) } : null
  } catch (_) { return null }
}

async function rtCommand($, e) {
  if (!userOrigin(e)) return {}
  
  
  if (!(await ensureInteractive($))) return {}
  const arg = (typeof e.args === 'string' ? e.args : '').trim().toLowerCase()
  const nowMs = await $.clock.now()
  RM.nowMs = nowMs
  if (arg === 'on') {
    const router = R, runtime = RM, requestEpoch = RM.requestEpoch
    const current = () => R === router && RM === runtime && RM.requestEpoch === requestEpoch
    if (!RM.ready) return { text: TEXT.cardChanged }
    await rtGates($)
    if (!current()) return { text: TEXT.off }
    if (R.killed) return { text: TEXT.killed }
    if (!R.hasKey) return { text: TEXT.noKey }
    if (!RM.home) return { text: TEXT.noHome }
    if (R.stopped) return { text: TEXT.stopped } 
    if (R.pause && R.pause.kind === 'plan') return { text: planPauseText(R) }
    if (!R.armed && !R.plan) {
      if (!runtime.planProbe || runtime.planProbe.epoch !== requestEpoch) {
        runtime.planProbe = { epoch: requestEpoch, job: rtPlanCheck($, current) }
      }
      const probe = runtime.planProbe
      const answer = await probe.job
      if (runtime.planProbe === probe) runtime.planProbe = null
      if (!current()) return { text: TEXT.off }
      if (R.pause && R.pause.kind === 'plan') return { text: planPauseText(R) }
      if (answer) {
        R.plan = answer.plan
        noteRoutingUsage(R, answer.usage, nowMs)
      }
    }
    if (isFreePlan(R.plan)) {
      R.armed = false
      R.pause = { kind: 'plan' }
      R.pauseNoted = true
      $.ui.invalidate('ui.render')
      return { text: TEXT.pausedPlan }
    }
    await rtSettings($)
    if (!current()) return { text: TEXT.off }
    await rtGates($)
    if (!current()) return { text: TEXT.off }
    if (R.killed) return { text: TEXT.killed }
    if (!R.hasKey) return { text: TEXT.noKey }
    if (R.pause && R.pause.kind === 'plan') return { text: planPauseText(R) }
    R.armed = true
    if (R.pause && R.pause.kind === 'auth') R.pause = null
    R.errorsOff = false
    R.errors = 0
    R.iqFails = 0
    $.ui.invalidate('ui.render')
    return { text: onLine(R, nowMs) }
  }
  if (arg === 'off') {
    RM.requestEpoch += 1
    R.armed = false
    if (R.current && !R.current.decided) settleNone(R, R.current, 'off', 'off')
    R.current = null
    R.named = null
    $.ui.invalidate('ui.render')
    return { text: TEXT.off }
  }
  if (arg === 'reset') {
    return { text: TEXT.reset }
  }
  if (arg === 'status' || arg === '') {
    if (RM.ready) await rtGates($)
    return { text: statusLines(R, nowMs).map(displayText).join('\n') }
  }
  return { text: TEXT.usage }
}
