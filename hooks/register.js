


























import { NAME, VERSION, CARD_FILE, PIN_CARD, DATA_DIR, MAX_ERRORS, ERROR_LOG_CAP, LOG_PART_CAP, LOG_MAX_PARTS } from './lib/pins.js'
import * as State from './lib/state.js'
import { SAVINGS_MODES_ENABLED, USAGE_REPORTS_ENABLED, LIMIT_AWARE_ENABLED } from './lib/usage_flags.js'
import { newUsageReportClient } from './lib/usage_report.js'
import { newUsageSession } from './lib/usage_session.js'
import { newLimitState, readLimitAuth } from './lib/limit_state.js'
import { turnBillingMode, modelFamily, limitsBlock } from './lib/limits.js'
import { FORCE_SERVER } from './lib/runtime_mode.js'
import { SUB_TEXT, readAliasHost, resolveBase } from './lib/subagents.js'
import { makePricer, booked, advisorCallsIn, mainPass, latestCacheWriteTtlMs, modelClass, effortClass } from './lib/pricing.js'
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
import { measuredSpendLine, estimatedSavingsText, SAVINGS_NOTE, NOTICE, noUsageLine } from './lib/format.js'
import { bytesFromBase64, sha256Hex, utf8, dayOf, isoOf, errText, tailLines, mergeRows } from './lib/util.js'
import { meterView, noteSeries } from './lib/meterview.js'
import { trivialTurn } from './lib/trivial_turn.js'
import { measureCall, rebuildDebit } from './lib/measured_cost.js'
import { routeFetch } from './lib/route_transport.js'
import { applyDataFeaturesPreference } from './lib/iq_client.js'
import { registerUi, uiReset, uiTurnDone, uiEnd } from './ui_handlers.js'
import { buildRouteBody, estimateRequest, consumeRouteReset, usageRequest, parseRoutingPlan, isFreePlan, routingUsage, classifyResponse, safeErr, deadlineFrom, BACKOFF_MS, destinationFrom, effortSettings, userOrigin, scrub, cleanText, MAX_HISTORY_MESSAGES, displayText } from './lib/iq_client.js'
import { readKey, validKey, trafficOff, readUsageReporting, homeFrom, pathIn, credentialAccess, LOGGED_OUT_KEY, trustedSettingsHome, writeTrustedSettings, persistPlanRestriction } from './lib/traffic.js'
import { BROWSER_LOGIN_ENABLED, KEEP_ROUTING_ON_ENABLED } from './lib/release_flags.js'
import { registerAuth, authReset, authEnd, authOff, authCancel } from './auth_handlers.js'
import { guessEffort, sameModel, sameChoice, canonicalModel, effortFacts, explicitModel, applicableChoice, applyChoice, effortLabel, EFFORTS, validateAnswer } from './lib/models.js'
import {
  noteRoutingUsage,
  RT_DIR,
  RT_VERSION,
  MAX_IQ_FAILS,
  TEXT,
  newRouter,
  newRecord,
  carryPick,
  carryReason,
  fingerprintKey,
  noteRoutingReply,
  carryEligible,
  rememberSpawnPick,
  settleCarried,
  settleUserChoice,
  statusOf,
  forgetRecord,
  planSubmit,
  fastSubmit,
  installRouteHold,
  clearRouteHold,
  settleKept,
  decide,
  settleDecision,
  settleNone,
  settlePause,
  settleRefused,
  noteMainStep,
  noteCompaction,
  noteRecStep,
  noteTurnDone,
  savedCacheStart,
  cacheStartText,
  CACHE_START_FILE,
  decisionRow,
  lineFor,
  statusLines,
  onLine,
  planPauseText,
  routingState,
  cacheTtlMs,
  onSubscription,
  ttlIsKnown,
  routeCacheTtlSeconds,
  routeContextFacts,
  routeCacheAgeSeconds,
  writeTtlMs,
} from './lib/router.js'
import { registerRoute, cancelRouteWork } from './route_handlers.js'
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
    readSettings: (source) => $.settings.read({ source }),
    run: (argv, init) => $.process.run(argv, init),
    write: (path, text) => $.fs.write(path, text),
    nonessential: () => $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'),
    disabled: () => $.env.get('IQ_ROUTER_DISABLED'),
    blocked: () => State.getSetting('authBlocked') === true,
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
    explicitEffort: null,
    explicitModel: null,
    modelSource: null,
    modelEpoch: 0,
    effortEpoch: 0,
    carryEffort: null,
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

let usageReport = null
let usageSession = newUsageSession()
let usageIdentity = null
let usageNoUsagePause = false
let usageHelpers = new Map()
let limitState = newLimitState()
let limitAuthKind
let limitObservationVersion = 0
let limitRefreshSequence = 0
let limitAppliedRefresh = 0

function limitSettings() {
  return Object.fromEntries(['planType', 'planTier', 'allowFable', 'fableBilling'].map((key) => [key, State.getSetting(key)]))
}
function savingsBilling(facts) {
  if (!facts) return undefined
  const model = R.named?.model || M.sent?.model
  const billingMode = turnBillingMode(facts, model)
  return { billingMode, creditBilledFamily: billingMode === 'extra_usage' && facts.credit_billed_families.includes(modelFamily(model)) ? 'fable' : null }
}
function currentLimits(nowMs = Math.max(M.nowMs, RM.nowMs)) {
  if (!LIMIT_AWARE_ENABLED) return null
  const facts = limitState.configure(limitSettings(), nowMs)
  R.limitFacts = facts
  R.noUsage = limitState.blocked(nowMs)
  if (!R.noUsage && R.pause?.kind === 'no_usage') { R.pause = null; R.pauseNoted = false }
  return { ...facts, blocked: R.noUsage, authKind: limitAuthKind }
}

function saveLimits(nowMs) {
  if (!LIMIT_AWARE_ENABLED) return
  currentLimits(nowMs)
  State.setLimitReading(limitState.saved(nowMs))
}

async function refreshLimits($) {
  if (!LIMIT_AWARE_ENABLED) return null
  return refreshLimitFacts({
    authorize: () => $.session.authorize(),
    authStatus: async () => {
      const result = await $.process.run(['claude', 'auth', 'status'])
      return result?.exitCode === 0 ? result.stdout : null
    },
    apiKeyPresent: async () => {
      const value = await $.env.get('ANTHROPIC_API_KEY')
      return typeof value === 'string' && value.trim() !== ''
    },
    usage: () => $.session.usage(), now: () => $.clock.now(),
  })
}

async function refreshLimitFacts(access) {
  if (!LIMIT_AWARE_ENABLED) return null
  const state = limitState
  const version = limitObservationVersion
  const sequence = ++limitRefreshSequence
  const auth = await readLimitAuth(access)
  const observed = await safe(access.usage())
  const nowMs = await access.now()

  if (state !== limitState || version !== limitObservationVersion || sequence < limitAppliedRefresh) return currentLimits(nowMs)
  limitAppliedRefresh = sequence
  limitAuthKind = auth.kind
  limitState.configure(limitSettings(), nowMs)
  limitState.auth(auth.kind, auth.apiKeyPresent, nowMs)
  if (Array.isArray(observed?.rateLimits)) limitState.reading(observed.rateLimits, nowMs)
  saveLimits(nowMs)
  if (SAVINGS_MODES_ENABLED || USAGE_REPORTS_ENABLED) usageSession.reading(M.usage.rateLimits, nowMs, State.getSetting('planType'), savingsBilling(currentLimits(nowMs)))
  return currentLimits(nowMs)
}

function noUsage(nowMs) { return LIMIT_AWARE_ENABLED && currentLimits(nowMs).blocked }
function noteNoUsage(nowMs) {
  if (!LIMIT_AWARE_ENABLED) return
  limitObservationVersion += 1
  limitState.refused(nowMs)
  usageSession.invalidateReporting()
  saveLimits(nowMs)
}

async function flushLimitSettings($) {
  if (!LIMIT_AWARE_ENABLED) return
  const text = State.takePendingSettings()
  if (text !== null) await safe(writeTrustedSettings(iqAccess($), text))
}

function skippedNoUsage(nowMs) {
  if (!LIMIT_AWARE_ENABLED) return false
  const notice = limitState.notice(nowMs)

  const facts = currentLimits(nowMs)
  usageSession.skipNoUsage({ at: nowMs, billingMode: facts.billing_mode, familiesExhaustedCount: facts.exhausted_families.length,
    reportEligible: USAGE_REPORTS_ENABLED && State.getSetting('usageReporting') === 'on' && State.getSetting('authBlocked') !== true && !!usageIdentity?.paid,
    setting: State.getSetting('planType') })
  return notice
}

function usageEntitlement(key, paid) {
  if (usageIdentity && usageIdentity.key !== key) usageSession.invalidateReporting()
  usageIdentity = { key, paid }
  if (!paid) usageSession.invalidateReporting()
  else if (usageReport) void usageReport.refresh()
}

async function usageEligibility($) {
  usageSession.expire(Math.max(M.nowMs, Date.now()))
  const key = USAGE_REPORTS_ENABLED ? await readKey(iqAccess($)) : null
  const killed = USAGE_REPORTS_ENABLED ? await trafficOff(iqAccess($)) : true
  const { base, dev } = USAGE_REPORTS_ENABLED ? destinationFrom(await safe($.settings.read({ source: 'user' }))) : { base: null, dev: false }
  return { eligible: USAGE_REPORTS_ENABLED && RM.ready && R.armed && !killed && !R.killed && !R.errorsOff && !R.stopped && !R.pause &&
    !usageNoUsagePause && !noUsage(Math.max(M.nowMs, Date.now())) && State.getSetting('authBlocked') !== true && State.getSetting('usageReporting') === 'on' &&
    !!usageIdentity && usageIdentity.paid && usageIdentity.key === key && typeof key === 'string' && !!key && !!base,
    key, base, dev, context: typeof key === 'string' ? key + '|' + (RM.cwd || '') : '' }
}

function usageStart($) {
  if (usageReport) usageReport.dispose()
  usageIdentity = null
  usageHelpers = new Map()
  usageNoUsagePause = false
  usageReport = USAGE_REPORTS_ENABLED ? newUsageReportClient({ now: () => Math.max(M.nowMs, Date.now()),
    later: (ms, fn) => $.clock.after(ms, fn), fetch: (url, init) => noUsage(Math.max(M.nowMs, Date.now())) ? null : $.http.fetch(url, init), eligibility: () => usageEligibility($) }) : null
  usageSession = newUsageSession(usageReport)
  usageSession.reading(M.usage.rateLimits, M.nowMs, State.getSetting('planType'), savingsBilling(currentLimits(M.nowMs)))
}

async function usageStep($, e, result, begun, pricing) {
  if (!SAVINGS_MODES_ENABLED && !USAGE_REPORTS_ENABLED || !result) return
  const at = await $.clock.now()
  const u = result.usage && typeof result.usage === 'object' ? result.usage : null
  const model = u && u.model || e.model
  const row = begun.measured
  const price = row ? { usd: row.paid_usd, priced: row.paid_usd !== null } : null
  const helper = e.agentId && usageHelpers.get(e.agentId)
  let helperDecision = 'none'
  let helperEligible = false
  if (helper) {
    helperDecision = helper.routed ? 'routed' : helper.kept ? 'kept' : 'none'
    helperEligible = helper.routed || !!(helper.prev && helper.prev.routed)
  }
  if (helper && u && RM.pricer) {
    pricing = row ? { actualUsd: row.paid_usd, namedUsd: row.saved_usd === null ? null : row.paid_usd + row.saved_usd } : null
    helper.prev = { ctx: row ? row.usage.input + row.usage.cache_read + row.usage.cache_write_5m + row.usage.cache_write_1h : 0, startMs: begun.startMs, endMs: at, routed: helper.routed }

  }
  if (!u) { usageNoUsagePause = true; usageSession.invalidateReporting() }
  else usageNoUsagePause = false
  const session = usageSession
  const gate = USAGE_REPORTS_ENABLED ? await usageEligibility($) : { eligible: false }
  if (session !== usageSession) return
  const facts = currentLimits(at)
  const completionMode = facts?.billing_mode
  const billingMode = begun.billingMode === 'subscription' && completionMode === 'extra_usage' ? 'extra_usage' : begun.billingMode ?? turnBillingMode(facts, model)
  const billing = LIMIT_AWARE_ENABLED ? { billingMode, creditBilledFamily: begun.creditBilledFamily, familiesExhaustedCount: facts.exhausted_families.length } : {}
  session.stage({ rec: e.agentId ? null : begun.rec, changed: begun.changed === true, model, usage: u, price, pricing,
    ...billing,
    at, reportEligible: gate.eligible, rateLimits: M.usage.rateLimits, setting: State.getSetting('planType'), helperDecision, helperEligible })
}
let credentials = null
let sessionOff = false
let sessionGeneration = 0
let routingIntent = 0

export function register(on, options = {}) {
  let lastPlanType = State.getSetting('planType')
  let lastReporting = State.getSetting('usageReporting')
  let lastAuthBlocked = State.getSetting('authBlocked')
  State.subscribe(() => {
    const plan = State.getSetting('planType')
    const reporting = State.getSetting('usageReporting')
    const authBlocked = State.getSetting('authBlocked')
    if (plan !== lastPlanType) clearRouteHold(R)
    if (plan !== lastPlanType) usageSession.reading(M.usage.rateLimits, M.nowMs, plan)
    if (reporting !== lastReporting || authBlocked !== lastAuthBlocked) {
      usageSession.invalidateReporting()
      if (usageReport && reporting === 'on' && authBlocked !== true) void usageReport.refresh()
    }
    lastPlanType = plan; lastReporting = reporting; lastAuthBlocked = authBlocked
    currentLimits(Math.max(M.nowMs, RM.nowMs))
  })
  const configuredKey = options.iq_api_key
  credentials = credentialAccess(configuredKey)
  pluginKey = () => State.getSetting('authBlocked') === true ? LOGGED_OUT_KEY : credentials.read()

  registerRoute(on, { getR: () => R, getRM: () => RM, getM: () => M, getT: () => T, pluginKey,
    limitState: currentLimits, refreshLimits: refreshLimitFacts, noUsage, noteNoUsage,
    noteUsageEntitlement: (key, paid) => usageEntitlement(key, paid),
    writeSubagentDecision: (row, access) => rtAppendRows(access, [row], Date.parse(row.ts)),
    noteHelperPlan: (id, plan) => { if (SAVINGS_MODES_ENABLED || USAGE_REPORTS_ENABLED) { usageHelpers.set(id, { ...plan, prev: null }); if (usageHelpers.size > 128) usageHelpers.delete(usageHelpers.keys().next().value) } },
  })




  on('session.start', async ($, e, next) => {
    if (LIMIT_AWARE_ENABLED) limitObservationVersion += 1
    R.armed = false
    RM.requestEpoch += 1
    sessionGeneration += 1
    sessionOff = false
    authReset()
    await State.settingsSettled()
    State.loadSettings(null)
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
    await flushLimitSettings($)
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
    if (LIMIT_AWARE_ENABLED) await safe(refreshLimits($))
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
    await flushLimitSettings($)
    return result
  }).catch(($, e, next) => next(e))

  on('agent.spawn', { subagentType: /./ }, async ($, e, next) => {
    const router = R
    const activePick = R.lastAppliedPick
    let pick = null
    try { if (rtLive() && statusOf(R, await $.clock.now()) === 'on') pick = activePick } catch (_) {}
    const result = await next(e)
    try { if (router === R && !result?.deny) rememberSpawnPick(R, pick, e, result) } catch (_) {}
    return result
  })

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
    let begun = { e2: e, startMs: null, rec: null, namedOriginal: { model: e.model, effort: e.effort } }
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

    if (begun.e2 !== e) {
      const nowMs = key !== null ? M.nowMs : RM.nowMs
      const reason = begun.rec?.carry ? carryReason(R, begun.rec.carry, nowMs, begun.carryFingerprint) : null
      if (reason || R.routingRefused || !rtLive() || statusOf(R, nowMs) !== 'on') {
        if (reason) { begun.rec.named = { ...begun.namedOriginal }; settleKept(R, begun.rec, reason) }
        begun.e2 = e
        begun.changed = false
        if (key !== null) noteStepStart(e, key, nowMs)
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
        begun = { e2: e, startMs: begun.startMs, rec: begun.rec, namedOriginal: { model: e.model, effort: e.effort } }
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
        await stepEnd($, begun.e2, key, result, begun)
      } catch (err) {
        countError($, 'turn.step', err)
      }
    }
    try {
      const pricing = await rtStepEnd($, begun.e2, result, begun)
      if (LIMIT_AWARE_ENABLED) {
        const nowMs = await $.clock.now()
        limitObservationVersion += 1
        limitState.step({ model: begun.e2.model, result, nowMs, agentId: e.agentId, startedAtMs: begun.startMs, exhaustedAtStart: begun.limitAllExhausted })
        saveLimits(nowMs)
      }
      await usageStep($, begun.e2, result, begun, pricing)
      await flushLimitSettings($)
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



  on('session.compact', { trigger: ['manual', 'auto', 'plugin'] }, async ($, e, next) => {
    const result = await next(e)
    try {
      if (!e.agentId && result && !result.skip) {
        noteCompaction(R)
        $.ui.invalidate('ui.render')
      }
    } catch (err) {
      await rtNoteError($, 'session.compact', err, { count: false })
    }
    return result
  })



  on('session.compact', { trigger: ['manual', 'auto', 'plugin'] }, async ($, e, next) => {
    if (!e.agentId) clearRouteHold(R)
    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    const result = await next(e)
    try {
      if (!M.interactive) {
        M.interactive = true
        await rtAutoArm($)
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
    if (LIMIT_AWARE_ENABLED) {
      try {
        const nowMs = await $.clock.now()
        clearRouteHold(R)
        limitObservationVersion += 1
        limitState.reading(e.rateLimits, nowMs, { fresh: Array.isArray(e.changed) && e.changed.includes('rateLimits') })
        saveLimits(nowMs)
        await flushLimitSettings($)
      } catch (_) {}
    }
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
    sessionGeneration += 1
    authEnd()

    R.armed = false
    RM.requestEpoch += 1
    if (SD) SD.client.end()
    SD = null
    if (LIMIT_AWARE_ENABLED && e.reason === 'logout') { limitObservationVersion += 1; limitState.logout(); limitAuthKind = null; saveLimits(await $.clock.now()); usageSession.invalidateReporting() }
    await flushLimitSettings($)
    usageSession.end()
    if (usageReport) void usageReport.end()
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

  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const result = await next(e)
    if (userOrigin(e) && !result?.deny) {
      const value = String(e.args ?? '').trim().toLowerCase()
      if (EFFORTS.includes(value) || value === 'auto' || value === 'default') {
        RM.effortEpoch = (RM.effortEpoch || 0) + 1
        RM.carryEffort = EFFORTS.includes(value) ? value : null
      }
      if (EFFORTS.includes(value)) RM.explicitEffort = value
      else if (value === 'auto' || value === 'default') RM.explicitEffort = null
    }
    return result
  })

  on('command.run', { command: 'model' }, async ($, e, next) => {
    const result = await next(e)


    return result
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    const result = await next(e)
    if (typeof e.to_model === 'string' && e.to_model !== '') {
      RM.modelSource = e.source
      const explicit = ['picker', 'command', 'sdk'].includes(e.source) &&
        e.requested_model != null && !['default', 'auto'].includes(String(e.requested_model).trim().toLowerCase())
      RM.explicitModel = explicit ? e.to_model : null
      RM.modelEpoch = (RM.modelEpoch || 0) + 1
      if (['picker', 'command', 'sdk'].includes(e.source)) {
        RM.explicitEffort = null
        RM.effortEpoch = (RM.effortEpoch || 0) + 1
        RM.carryEffort = null
      }
    }
    return result
  })

  on('command.run', { command: 'clear' }, async ($, e, next) => {
    const result = await next(e)
    if (userOrigin(e) && !result?.deny) RM.explicitEffort = null
    return result
  })

  if (BROWSER_LOGIN_ENABLED === true && KEEP_ROUTING_ON_ENABLED === true) registerAuth(on, {
    enabled: () => BROWSER_LOGIN_ENABLED === true && KEEP_ROUTING_ON_ENABLED === true,
    interactive: () => M.interactive,
    ready: () => M.ready && RM.ready,
    directoryAllowed: (cwd, home) => {
      if (typeof cwd !== 'string' || typeof home !== 'string') return false
      return true
    },
    pluginKey,
    begin: () => { routingIntent += 1; sessionOff = false },
    stopRouting: () => { rtDisarm(); cancelRouteWork() },
    disarm: () => {
      routingIntent += 1
      credentials.deny()
      usageIdentity = null
      if (LIMIT_AWARE_ENABLED) { limitObservationVersion += 1; limitState.logout(); limitAuthKind = null; saveLimits(Math.max(M.nowMs, RM.nowMs)) }
      rtDisarm()
      cancelRouteWork()
    },
    installKey: (key, stillCurrent) => !sessionOff && stillCurrent() && credentials.activate(key),
    activate: async (key, stillCurrent, access) => {
      const generation = sessionGeneration
      const live = () => generation === sessionGeneration && !sessionOff && stillCurrent()
      if (!live() || !credentials.activate(key)) return false
      try {
        const armed = await rtArm(access, live)
        if (!armed && live()) { rtDisarm(); cancelRouteWork() }
        return armed
      } catch (_) { if (live()) { rtDisarm(); cancelRouteWork() } return false }
    },
  })


  registerUi(on, {
    pluginKey,
    limitState: currentLimits, refreshLimits: refreshLimitFacts,
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
    usageState: (nowMs = M.nowMs) => ({ ...usageSession.view(State.getSetting('planType'), nowMs), free: !!usageIdentity && !usageIdentity.paid,
      reportingActive: USAGE_REPORTS_ENABLED && RM.ready && State.getSetting('authBlocked') !== true && State.getSetting('usageReporting') === 'on' && !!usageIdentity && usageIdentity.paid && R.armed && !R.killed && !R.pause && !R.stopped && !R.errorsOff && !usageNoUsagePause && !noUsage(nowMs) }),
    paidForKey: (key) => !!usageIdentity && usageIdentity.paid && usageIdentity.key === key,
    read: () => M.read,
    tab: { get: () => M.tab, set: (t) => (M.tab = t) },
    keepRoutingEnabled: () => KEEP_ROUTING_ON_ENABLED === true,
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
    const home = await trustedSettingsHome(iqAccess($))
    const path = pathIn(home, '.claude/iq/settings.json')
    const exists = home ? await $.fs.exists(path) : null
    if (exists === true) State.loadSettings(JSON.parse(await $.fs.read(path)))
    else State.loadSettings(exists === false ? undefined : null)
  } catch (_) { State.loadSettings(null) }
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
  const held = await safe($.session.turns())
  if (typeof held === 'number' && held > 0) T.resumed = true
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
  if (SAVINGS_MODES_ENABLED || USAGE_REPORTS_ENABLED) usageSession.reading(M.usage.rateLimits, M.nowMs, State.getSetting('planType'), savingsBilling(currentLimits(M.nowMs)))
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
    T.resumed = true
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
  noteStepStart(e, key, nowMs)
  $.ui.invalidate('ui.render')
  return key
}

function noteStepStart(e, key, nowMs) {
  onStepStart(T, { key, agentId: e.agentId, model: e.model, effort: e.effort, nowMs, modelClass: modelClass(e.model), effortClass: effortClass(e.effort) })
  if (!e.agentId) M.sent = { model: e.model, effort: e.effort === undefined ? null : e.effort }
}

async function stepEnd($, e, key, result, begun = {}) {
  const nowMs = await $.clock.now()
  M.nowMs = nowMs
  const u = result && result.usage && typeof result.usage === 'object' ? result.usage : null
  const model = (u && u.model) || e.model

  const advisorCalls = advisorCallsIn(result)
  const priced = u ? M.pricer.price(model, u, { main: !e.agentId, passes: advisorCalls + 1 }) : null


  const price = priced === null ? null : booked(priced, advisorCalls)

  const mainCtx = u && !e.agentId ? mainPass(u, model, advisorCalls).ctx : undefined

  const helper = e.agentId && usageHelpers.get(e.agentId)
  const named = helper ? { model: helper.model, effort: helper.effort } : begun.rec?.named || begun.namedOriginal || { model: e.model, effort: e.effort }
  const skipped = !!(begun.rec?.localSkipped || begun.rec?.reason === 'trivial_turn' || (!begun.rec && !R.last?.routed))
  const switched = helper ? !!(helper.routed || helper.prev?.routed) : !e.agentId && !skipped && !!(begun.changed || R.last?.routed)
  const settingsTtl = ttlIsKnown(RM.ttl || {}, M.usage?.rateLimits) ? cacheTtlMs({ ...(RM.ttl || {}), onSubscription: onSubscription(M.usage?.rateLimits, nowMs) }) : null
  const writeTtl = e.agentId ? 300 : (latestCacheWriteTtlMs(u, model) ?? R.observedCacheTtlMs ?? settingsTtl ?? (R.ttlKnown ? R.ttlMs : null)) / 1000 || null
  const rebuildUsd = rebuildDebit(M.pricer, { named, usage: u, prev: e.agentId ? helper?.prev : R.last,
    startMs: begun.startMs ?? nowMs, ttlMs: R.last?.ttlMs ?? (R.ttlKnown ? R.ttlMs : 3600000), switched, writeTtl, advisorCalls })
  const measured = u ? measureCall(M.pricer, { model, effort: e.effort, named, usage: u,
    main: !e.agentId, advisorCalls, writeTtl, switched, rebuildUsd, skipped: e.agentId ? !switched : skipped }) : null
  begun.measured = measured
  onStepEnd(T, { key, agentId: e.agentId, model, effort: e.effort, hasUsage: price !== null, price, measured, mainCtx, nowMs, modelClass: modelClass(model), effortClass: effortClass(e.effort),
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
    await rtAutoArm($)
    $.ui.invalidate('ui.render')
  }
  return M.interactive
}


function say($, text) {
  if (!M.interactive) return
  try {
    if (text === TEXT.quiet) {
      if (R.failureNotices.has('quiet')) return
      R.failureNotices.add('quiet')
    }
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
  if (LIMIT_AWARE_ENABLED) {
    limitState = newLimitState(State.getLimitReading())
    limitObservationVersion += 1
    await refreshLimits($)
  }
  usageStart($)

  try {
    await $.command.register({ name: 'iq-route', description: "Route this session's model and thinking level with IQ: on, off, status or reset. Wait up to 7 s for the first route or after ten minutes without a route call, 4 s otherwise; IQ_ROUTER_DEADLINE_MS overrides.", argumentHint: 'on|off|status|reset|subagents on|off', immediate: true })
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
  await rtAutoArm($)
}


async function rtAutoArm($) {
  const generation = sessionGeneration, intent = routingIntent, router = R, runtime = RM
  const sameSession = () => generation === sessionGeneration && intent === routingIntent && R === router && RM === runtime && !sessionOff
  const current = () => sameSession() && State.getSetting('keepRoutingOn') === true &&
    State.getSetting('routingEligible') !== false && State.getSetting('authBlocked') !== true
  if (KEEP_ROUTING_ON_ENABLED !== true || !M.interactive || !RM.ready || R.armed || !sameSession()) return false
  let settings = null
  try {
    const access = iqAccess($)
    const home = await trustedSettingsHome(access)
    if (home) {
      const path = pathIn(home, '.claude/iq/settings.json')
      const exists = await access.exists(path)
      if (exists === true) {
        const stored = JSON.parse(await access.read(path))
        if (stored && typeof stored === 'object' && !Array.isArray(stored)) settings = stored
      } else if (exists === false) settings = {}
    }
  } catch (_) {}
  if (!sameSession() || settings === null) return false
  State.refreshRoutingConsent(settings)
  if (!current()) return false
  return rtArm(armAccess($), current)
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
  if (typeof cwd === 'string' && cwd !== RM.cwd) usageSession.invalidateReporting()
  if (typeof cwd === 'string') RM.cwd = cwd
}


async function rtKillCheck($) {
  R.killed = await trafficOff(iqAccess($))
}

function armAccess($) {
  return { ...iqAccess($), cwd: () => $.session.cwd(), settings: () => $.settings.read(),
    force5m: () => $.env.get('FORCE_PROMPT_CACHING_5M'), envTtl: () => $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
    oneHour: () => $.env.get('ENABLE_PROMPT_CACHING_1H'), invalidate: () => $.ui.invalidate('ui.render') }
}

async function rtArm(access, live = () => true) {
  const router = R, runtime = RM, requestEpoch = RM.requestEpoch
  const current = () => R === router && RM === runtime && RM.requestEpoch === requestEpoch && live()
  if (!RM.ready || !M.interactive || !RM.home || R.stopped || R.pause?.kind === 'plan' || isFreePlan(R.plan) || State.getSetting('routingEligible') === false || !current()) return false
  R.killed = await trafficOff(access)
  const key = await readKey(access)
  R.hasKey = typeof key === 'string' && key !== ''
  const cwd = await access.cwd()
  if (typeof cwd === 'string') RM.cwd = cwd
  if (R.killed || !R.hasKey || R.dirRefused || !current()) return false
  const destination = destinationFrom(await access.user())
  if (!destination.base) return false
  const settings = await access.settings()
  RM.ttl = { force5m: truthy(await access.force5m()), envTtl: await access.envTtl(),
    settingTtl: settings && typeof settings.promptCacheTtl === 'string' ? settings.promptCacheTtl : '', enable1h: truthy(await access.oneHour()) }
  if (!current() || await trafficOff(access) || !current() || R.stopped || R.pause?.kind === 'plan' || isFreePlan(R.plan) || State.getSetting('routingEligible') === false || await readKey(access) !== key || !current()) return false
  R.armed = true
  if (R.pause && R.pause.kind === 'auth') R.pause = null
  R.errorsOff = false
  R.errors = 0
  R.iqFails = 0
  access.invalidate()
  return true
}

function rtDisarm() {
  R.routeHold = null
  usageSession.invalidateReporting()
  RM.requestEpoch += 1
  R.armed = false
  if (R.current && !R.current.decided) settleNone(R, R.current, 'off', 'off')
  R.current = null
  R.named = null
  R.lastAppliedPick = null
  R.agentPicks.clear()
}


async function rtReadTtl($) {
  const force = await safe($.env.get('FORCE_PROMPT_CACHING_5M'))
  const envTtl = await safe($.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'))
  const one = await safe($.env.get('ENABLE_PROMPT_CACHING_1H'))
  const s = await safe($.settings.read())
  return {
    force5m: truthy(force),
    envTtl: typeof envTtl === 'string' ? envTtl.trim() : '',
    settingTtl: s && typeof s.promptCacheTtl === 'string' ? s.promptCacheTtl : '',
    enable1h: truthy(one),
  }
}


async function rtSettings($) {
  RM.ttl = await rtReadTtl($)
}




async function rtNamedHint($, prompt = '') {
  const sessionModel = await safe($.session.model())
  const model = typeof sessionModel === 'string' && sessionModel !== '' ? sessionModel : R.named?.model
  const env = await safe($.env.get('CLAUDE_CODE_EFFORT_LEVEL'))
  const sources = {}
  for (const name of ['user', 'project', 'local', 'flag', 'policy']) sources[name] = effortSettings(await safe($.settings.read({ source: name })))
  const runtimeEffort = RM.explicitEffort ?? undefined
  const host = await readAliasHost({ version: () => $.session.version(), bedrock: () => $.env.get('CLAUDE_CODE_USE_BEDROCK'),
    vertex: () => $.env.get('CLAUDE_CODE_USE_VERTEX'), foundry: () => $.env.get('CLAUDE_CODE_USE_FOUNDRY'), baseUrl: () => $.env.get('ANTHROPIC_BASE_URL') })
  const modelExplicit = explicitModel({ env: await safe($.env.get('ANTHROPIC_MODEL')), sources, runtimeModel: RM.explicitModel,
    startupModel: model, resolveModel: value => resolveBase(value, model, host) }) !== null
  return { model, modelExplicit, ...effortFacts({ model, env, sources, runtimeEffort, runtimeExplicit: RM.explicitEffort != null, prompt }) }
}




const rtIsHuman = (e) => {
  return userOrigin(e)
}


async function rtSubmit($, e) {
  if (!RM.ready || !R.armed || e.agentId != null || (!rtIsHuman(e) && !carryEligible(e))) return null
  if (e.turnId !== undefined) return null
  const nowMs = await $.clock.now()
  RM.nowMs = nowMs
  if (carryEligible(e) || trivialTurn(e.text)) {
    const rec = newRecord(R, { nowMs, sessionModel: await safe($.session.model()) })
    rec.carry = carryEligible(e) ? carryPick(R, e) : null
    rec.effortHint = await rtNamedHint($, e.text)
    rec.local = { action: 'local', phase: 'kept', reason: 'trivial_turn', source: 'none', counted: false }
    const sub = { rec, prev: R.current, runtime: RM, router: R, skipped: true }
    R.current = rec
    RM.pending = rec
    return sub
  }
  await rtKillCheck($)
  const holdBefore = R.routeHold ? { ...R.routeHold, choice: { ...R.routeHold.choice } } : null
  let plan = planSubmit(R, nowMs, R.ttlMs)
  if (plan.action === 'call') plan = fastSubmit(R, nowMs, e.text, R.routeHold ? await rtNamedHint($, e.text) : null) || plan
  else clearRouteHold(R)
  if (LIMIT_AWARE_ENABLED) {
    if (plan.reason === 'no_usage') {
      if (skippedNoUsage(nowMs)) say($, noUsageLine(R.limitFacts.next_reset))
    } else limitState.notice(nowMs)
  }
  if (plan.action === 'skip') return null
  R.seq += 1
  R.deadlineMs = State.routeDeadline(M.sessionId, await safe($.env.get('IQ_ROUTER_DEADLINE_MS')), nowMs)
  const sessionModel = R.named ? null : await safe($.session.model())
  const rec = newRecord(R, { nowMs, sessionModel })
  rec.counted = plan.counted
  if (rec.counted) R.counters.prompts += 1
  const sub = { rec, prev: R.current, runtime: RM, router: R, holdBefore }
  R.current = rec
  RM.pending = rec
  if (plan.action === 'local') {
    rec.local = plan
    if (plan.reason !== 'server_hold') return sub
    rec.local.choice = { ...holdBefore.choice }
    rec.local.lease = R.routeHold
  }
  const key = await readKey(iqAccess($))
  if (typeof key !== 'string' || key.trim() === '') {
    rec.local = { action: 'local', phase: 'error', reason: 'error', source: 'none', counted: true, error: 'no_key' }
    return sub
  }
  rec.keyFingerprint = await fingerprintKey(key)

  rec.result = null
  let finish
  rec.job = new Promise((resolve) => {
    finish = resolve
  })
  const text = typeof e.text === 'string' ? e.text : ''
  const rows = RM.typedPrompts.slice()
  const runtime = RM
  const requestEpoch = RM.requestEpoch
  const startRoute = (immediate = false) => {
    if (RM !== runtime || RM.requestEpoch !== requestEpoch) { finish(); return }
    const launch = () => {
      void rtEstimateJob($, rec, text, key.trim(), rows, runtime, requestEpoch).then(
        (c) => {
          rec.result = c
          if (rec.decided && typeof c.doneMs === 'number') rec.lateMs = Math.max(0, c.doneMs - rec.submitMs)
          finish()
        }, () => finish(),
      )
    }

    if (immediate) launch()
    else $.clock.after(0, launch)
  }
  sub.start = () => {
    if (RM !== runtime || RM.requestEpoch !== requestEpoch) { finish(); return }
    RM.typedPrompts.push({ role: 'user', source: 'typed', text: scrub(cleanText(text), [key]).slice(-32000) })
    if (RM.typedPrompts.length > MAX_HISTORY_MESSAGES) RM.typedPrompts.shift()
    if (rec.local?.reason === 'server_hold') rec.startRoute = startRoute
    else startRoute()
  }
  return sub
}


function rtDropped(sub) {
  if (RM !== sub.runtime || R !== sub.router) return
  if (sub.rec.local?.reason === 'server_hold' && sub.holdBefore && R.routeHold?.untilMs === sub.holdBefore.untilMs) R.routeHold.remaining += 1
  if (RM.pending === sub.rec) RM.pending = null
  if (sub.rec.counted) R.counters.prompts -= 1
  if (!sub.skipped) R.seq -= 1
  if (R.current === sub.rec) R.current = sub.prev
  RM.droppedPrompt = true
  forgetRecord(R, sub.rec)
}


async function rtFetch($, req, deadlineMs, runtime, requestEpoch) {
  if (deadlineMs <= await $.clock.now() || !R.armed || await trafficOff(iqAccess($)) || RM !== runtime || RM.requestEpoch !== requestEpoch) return null
  if (LIMIT_AWARE_ENABLED) {
    const facts = await refreshLimits($)
    if (!R.armed || RM !== runtime || RM.requestEpoch !== requestEpoch) return null
    if (noUsage(await $.clock.now())) return null
    const body = JSON.parse(req.init.body)
    if (body.routing) {
      body.routing.limits = limitsBlock(facts)
      if (body.routing.turn_kind === 'main') body.routing.cache_ttl_seconds = routeCacheTtlSeconds(R.cacheRestart ? null : R.last, R)
      req.init.body = JSON.stringify(body)
    }
  }
  const callMs = await $.clock.now()
  return routeFetch({ fetch: async (url, init) => {
    State.refreshUsageReporting(await readUsageReporting(iqAccess($)))
    if (!R.armed || RM !== runtime || RM.requestEpoch !== requestEpoch || deadlineMs <= await $.clock.now()) return null
    consumeRouteReset(R, req)
    State.noteRouteCall(M.sessionId, callMs)
    applyDataFeaturesPreference(req, State.getSetting('usageReporting'))
    return $.http.fetch(url, init)
  }, later: (ms, fn) => $.clock.after(ms, fn), now: () => $.clock.now() }, req, deadlineMs)

}


async function rtEstimateJob($, rec, text, key, rows, runtime, requestEpoch) {
  try {
    if (!R.armed || await trafficOff(iqAccess($)) || RM !== runtime || RM.requestEpoch !== requestEpoch) return { kind: 'error', code: 'traffic_disabled', latencyMs: 0, doneMs: RM.nowMs }
    const named = await rtNamedHint($, text)
    if (rec.explicitEffort != null) { named.effort = rec.explicitEffort; named.effortExplicit = true }
    rec.effortHint = named
    if (rec.named) rec.named.modelExplicit = named.modelExplicit
    if (!rec.named && named.effortExplicit === true) rec.explicitEffort = named.effort
    const observed = await safe($.session.usage())
    const limits = LIMIT_AWARE_ENABLED ? await refreshLimits($) : null
    if (limits?.blocked) return { kind: 'local_no_usage', doneMs: RM.nowMs, latencyMs: 0 }
    const seen = observed && observed.context && observed.context.tokens
    const contextFacts = routeContextFacts(R, seen)
    let context = contextFacts.context_tokens
    if (context === null && freshSession()) context = windowEstimate(await safe($.session.usage({ breakdown: 'summary' }))) || null
    const now = await $.clock.now()
    R.ttlMs = cacheTtlMs({ ...RM.ttl, onSubscription: limits?.billing_mode === 'subscription' || onSubscription(observed && observed.rateLimits, now) })
    R.ttlKnown = ttlIsKnown(RM.ttl, observed && observed.rateLimits)
    if (LIMIT_AWARE_ENABLED && ['api', 'extra_usage', 'cloud_credits'].includes(turnBillingMode(limits, named.model))) { R.ttlMs = 300000; R.ttlKnown = true }
    if (R.observedCacheTtlMs !== null) { R.ttlMs = R.observedCacheTtlMs; R.ttlKnown = true }
    const built = buildRouteBody(Array.isArray(rows) ? rows : [], text, [key], {
      chosen: { model: named.model, effort: named.effort ?? null },
      last_served: R.last ? { model: R.last.model, effort: R.last.effort } : null,
      seconds_since_last_call: routeCacheAgeSeconds(R.last, now),
      context_tokens: context, cached_prefix_tokens: contextFacts.cached_prefix_tokens,
      cache_ttl_seconds: routeCacheTtlSeconds(R.cacheRestart ? null : R.last, R), turn_kind: 'main',
      ...(LIMIT_AWARE_ENABLED ? { limits, allow_fable: limits.allow_fable } : {}),
    })
    rec.sent = built.sent
    const { base, dev } = destinationFrom(await safe($.settings.read({ source: 'user' })))
    if (base === null) return { kind: 'error', code: 'bad_base', latencyMs: 0, doneMs: RM.nowMs }
    if (LIMIT_AWARE_ENABLED) {
      const sendLimits = await refreshLimits($)
      if (sendLimits.blocked) return { kind: 'local_no_usage', doneMs: RM.nowMs, latencyMs: 0 }
      built.body.routing.limits = limitsBlock(sendLimits)
    }
    const req = estimateRequest({ base, key, body: built.body, named, version: RT_VERSION, dev })
    if (req === null) return { kind: 'error', code: 'bad_base', latencyMs: 0, doneMs: RM.nowMs }
    const t0 = await $.clock.now()
    rec.transportStartedMs = t0
    const transport = await rtFetch($, req, rec.deadlineMs, runtime, requestEpoch)
    rec.latencyMs = transport?.latencyMs ?? Math.max(0, (await $.clock.now()) - t0)
    if (transport?.error) throw transport.error
    const res = transport?.response ?? null
    if (RM !== runtime || RM.requestEpoch !== requestEpoch) return { kind: 'error', code: 'traffic_disabled', latencyMs: 0, doneMs: runtime.nowMs }
    if (LIMIT_AWARE_ENABLED && noUsage(await $.clock.now())) return { kind: 'local_no_usage', doneMs: RM.nowMs, latencyMs: 0 }
    if (res === null) return { kind: 'timeout', code: 'timeout', latencyMs: Math.max(0, (await $.clock.now()) - t0), doneMs: await $.clock.now() }
    const t1 = await $.clock.now()
    const c = classifyResponse(res)
    if (LIMIT_AWARE_ENABLED && c.kind === 'no_usage') noteNoUsage(t1)
    noteRoutingUsage(R, c.usage, t1)
    if ((SAVINGS_MODES_ENABLED || USAGE_REPORTS_ENABLED) && c.kind === 'ok' && c.usage) {
      const routePlan = parseRoutingPlan(res.text)

      const plan = { ...(R.plan || {}), ...(routePlan || c.usage), tier: routePlan?.tier ?? R.plan?.tier ?? null }
      usageEntitlement(key.trim(), !isFreePlan(plan))
      if (SAVINGS_MODES_ENABLED && !usageIdentity.paid) { c.kind = 'plan_required'; c.code = 'plan_required'; usageSession.invalidateReporting() }
    }
    if (c.kind === 'plan_required' || c.kind === 'auth_required') {
      if (c.kind === 'plan_required') usageEntitlement(key.trim(), false)
      else usageIdentity = null
      usageSession.invalidateReporting()
    }
    rec.replySequence = noteRoutingReply(R, c.kind, c.kind === 'ok' && validateAnswer(c.parsed?.block, named).ok)
    rec.decisionMs = t1
    c.latencyMs = Math.max(0, t1 - t0)
    c.doneMs = t1
    if (c.kind === 'rate_limited') {
      R.backoffUntil = t1 + BACKOFF_MS
      R.backoffNoted = false
    }
    return c
  } catch (err) {
    await rtNoteError($, 'estimate', new Error('network'), { count: false })
    return { kind: 'error', code: 'network', latencyMs: rec.latencyMs ?? 0, doneMs: await $.clock.now() }
  }
}

function rtTurnStart(e) {
  if (e.agentId) return
  if (RM.droppedPrompt && !RM.pending) { RM.droppedPrompt = false; return }
  RM.droppedPrompt = false
  let rec = RM.pending
  if (!rec) {
    if (!rtLive() || RM.byTurn.has(e.turnId)) return

    rec = newRecord(R, { nowMs: RM.nowMs, sessionModel: R.named?.model })
    rec.carry = carryEligible(e) ? carryPick(R, e) : null
    rec.local = { action: 'local', phase: 'kept', reason: 'trivial_turn', source: 'local', counted: false }
    R.current = rec
  }
  if (rec.local?.reason === 'trivial_turn' && rec.carry === undefined && carryEligible(e)) rec.carry = carryPick(R, e)
  RM.pending = null
  rec.turnId = e.turnId
  RM.byTurn.set(e.turnId, rec)
  if (RM.byTurn.size > 64) RM.byTurn.delete(RM.byTurn.keys().next().value)
}




const rtLive = () => RM.ready && R.armed && !R.errorsOff && !R.stopped && !R.killed


async function rtStepBegin($, e) {
  const out = { e2: e, startMs: null, rec: null, changed: false, namedOriginal: { model: e.model, effort: e.effort } }
  if (!RM.ready) return out
  const main = e.agentId === undefined || e.agentId === null
  if (!main) return out
  const rec = RM.byTurn.get(e.turnId) || null

  if ((!rec || !rec.decided) && RM.explicitEffort != null && RM.explicitEffort !== e.effort) {
    if (rec?.effortHint?.effort === RM.explicitEffort) rec.effortHint = { ...rec.effortHint, effortExplicit: false }
    RM.explicitEffort = null
  }
  if (!rec && !rtLive()) {


    out.startMs = await $.clock.now()
    return out
  }
  out.rec = rec
  await rtKillCheck($)
  if (rec !== null && !rec.decided) {
    if (!rec.effortHint) rec.effortHint = await rtNamedHint($)
    rec.explicitEffort = rec.effortHint?.effortExplicit || RM.explicitEffort != null ? e.effort ?? null : null
    rec.named = { model: e.model, effort: e.effort === undefined ? null : e.effort, effortExplicit: rec.explicitEffort != null, modelExplicit: rec.effortHint?.modelExplicit !== false }
    R.named = rec.named
    await rtDecide($, rec)
    rec.pickEpochs ||= { model: RM.modelEpoch || 0, effort: RM.effortEpoch || 0 }
  }
  out.startMs = await $.clock.now()
  if (LIMIT_AWARE_ENABLED) {
    const facts = currentLimits(out.startMs)
    out.billingMode = turnBillingMode(facts, e.model)
    if (rec?.pricedAs) out.billingMode = { api: 'api', credits: 'extra_usage', plan: 'subscription' }[rec.pricedAs]
    out.limitAllExhausted = facts.all_exhausted
    if (out.billingMode === 'extra_usage' && facts.credit_billed_families.includes(modelFamily(e.model))) out.creditBilledFamily = modelFamily(e.model)
  }
  RM.nowMs = out.startMs

  await rtKillCheck($)

  if (rec?.carry) {
    const fingerprint = await fingerprintKey(await readKey(iqAccess($)))
    out.carryFingerprint = fingerprint
    RM.nowMs = await $.clock.now()
    const reason = carryReason(R, rec.carry, RM.nowMs, fingerprint)
    if (reason) {
      rec.named = { ...out.namedOriginal }
      settleKept(R, rec, reason)
    }
  }
  if (rec !== null && rec.decided) out.e2 = rtApply(e, rec)
  out.changed = out.e2 !== e
  if (rec?.reason === 'carried_forward' && rtLive() && statusOf(R, out.startMs) === 'on') {
    rec.choice = { model: out.e2.model, effort: out.e2.effort ?? null }
    rec.chosen = { model: out.e2.model, effort: effortLabel(out.e2.effort) }
  }
  if (!R.routingRefused && rec?.reason !== 'carried_forward' && !rec?.userOverride && rec?.phase === 'applied' && rtLive() && statusOf(R, out.startMs) === 'on') {
    R.lastAppliedPick = { choice: { model: out.e2.model, effort: out.e2.effort ?? null },
      named: { ...rec.named }, epochs: { model: RM.modelEpoch || 0, effort: RM.effortEpoch || 0 }, pricedAs: rec.pricedAs,
      keyFingerprint: rec.keyFingerprint, decisionMs: rec.decisionMs }
  }
  return out
}



function rtApply(e, rec) {
  if (e.agentId != null || !rtLive() || rec.phase !== 'applied' || !rec.named || ((RM.modelEpoch || 0) <= (rec.pickEpochs?.model || 0) && e.model !== (rec.requestModel || rec.named.model))) return e
  if (R.routingRefused || statusOf(R, RM.nowMs) !== 'on') return e
  const named = { model: e.model, effort: e.effort ?? null }
  let choice = rec.reason === 'carried_forward' ? { ...rec.choice } : applicableChoice(rec.choice, named, rec.explicitEffort)
  const automatic = { ...choice }
  if ((RM.modelEpoch || 0) > (rec.pickEpochs?.model || 0)) choice = { ...choice, model: e.model }
  if ((RM.effortEpoch || 0) > (rec.pickEpochs?.effort || 0)) choice = { ...choice, effort: RM.carryEffort ?? e.effort ?? null }
  if (!sameChoice(automatic, choice)) rec.userOverride = true
  if (rec.userOverride) {
    settleUserChoice(R, rec, named)
    return e
  }
  return applyChoice(e, choice)
}


async function rtDecide($, rec) {
  const t0 = await $.clock.now()
  let t1 = t0
  if (rtLive() && rec.local?.reason === 'server_hold' && (R.routeHold !== rec.local.lease || t0 >= rec.local.lease.untilMs || !sameChoice(rec.local.choice, rec.named))) {
    clearRouteHold(R)
    rec.local = null
    rec.counted = true
    R.counters.prompts += 1
    if (rec.startRoute) rec.startRoute(true)
  }
  if (!rtLive()) {
    if (rec.carry) settleKept(R, rec, 'carry_unauthorized')
    else settleNone(R, rec, 'off', 'off')
  } else if (rec.local) {
    const p = rec.local
    const pick = rec.carry
    const fingerprint = pick ? await fingerprintKey(await readKey(iqAccess($))) : null
    const unauthorized = pick ? carryReason(R, pick, t0, fingerprint) : null
    const validCarry = pick && !unauthorized && sameModel(rec.named.model, pick.named.model) && validateAnswer({
      v: 2, ...pick.choice, stay: false, reason_code: 'carried_forward' }, rec.named).ok
    if (validCarry && p.reason === 'trivial_turn' && statusOf(R, t0) === 'on' && !(R.backoffUntil > t0) && (!R.lastError || R.lastError === 'decisions.write')) {
      rec.requestModel = rec.named.model
      settleCarried(R, rec, pick)
    } else if (p.phase === 'kept') settleKept(R, rec, unauthorized || p.reason)
    else if (p.phase === 'paused') settleNone(R, rec, 'paused', p.reason)
    else if (p.error === 'no_key') settleNone(R, rec, 'error', 'error', 'no_key')
    else settleNone(R, rec, 'error', 'backoff', 'http_429')
  } else {
    if (rec.result === null && rec.deadlineMs > t0) await rtRace($, rec.job, rec.deadlineMs - t0)
    t1 = await $.clock.now()
    rec.waitMs = Math.max(0, t1 - t0)
    const c = rec.result
    rec.latencyMs = typeof c?.latencyMs === 'number' ? c.latencyMs : Math.max(0, t1 - (rec.transportStartedMs ?? rec.submitMs))
    if (LIMIT_AWARE_ENABLED && c?.kind === 'local_no_usage') {
      if (rec.counted) { rec.counted = false; R.counters.prompts -= 1 }
      if (skippedNoUsage(t1)) say($, noUsageLine(R.limitFacts.next_reset))
      settleNone(R, rec, 'paused', 'no_usage')
    } else if (c === null || c.kind === 'timeout') {
      settleNone(R, rec, 'timeout', 'timeout', 'timeout')
      R.iqFails += 1
      await rtNoteError($, 'iq', new Error('timeout'), { count: false })
    } else if (c.kind === 'ok') {
      rec.latencyMs = c.latencyMs
      rec.iqRequestId = c.parsed.request_id
      const d = decide(R, { nowMs: t1, named: rec.named, est: c.parsed, explicitEffort: rec.explicitEffort })
      settleDecision(R, rec, d)
      if (d.error === null) installRouteHold(R, c.parsed, t1, d.choice)
      if (LIMIT_AWARE_ENABLED && d.error === null && ['plan', 'credits', 'api'].includes(c.parsed.block?.priced_as)) rec.pricedAs = c.parsed.block.priced_as
      if (d.error !== null) {
        R.iqFails += 1
        await rtNoteError($, 'iq', new Error(d.error), { count: false })
      } else R.iqFails = 0
    } else if (c.kind === 'rate_limited') {
      rec.latencyMs = c.latencyMs
      settleNone(R, rec, 'error', 'error', 'http_429')
      await rtNoteError($, 'iq', new Error('http_429'), { count: false })
    } else if (['plan_required', 'allowance', 'free_quota', 'free_daily', 'auth_required', ...(LIMIT_AWARE_ENABLED ? ['no_usage'] : [])].includes(c.kind)) {

      rec.latencyMs = typeof c.latencyMs === 'number' ? c.latencyMs : null
      settlePause(R, rec, c.kind === 'plan_required' ? 'plan' : c.kind === 'auth_required' ? 'auth' : c.kind, t1)
      await persistPlanRestriction(c.kind, iqAccess($), State)
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
  if (!['timeout', 'error', 'paused'].includes(rec.phase)) return


  if (rec.reason === 'backoff' || rec.error === 'http_429') {
    if (R.backoffNoted) return
    R.backoffNoted = true
    say($, lineFor(rec, nowMs, R))
    return
  }
  if (LIMIT_AWARE_ENABLED && rec.reason === 'no_usage') {
    if (rec.error === 'no_usage_left' && !R.failureNotices.has(rec.error)) {
      R.failureNotices.add(rec.error)
      say($, lineFor(rec, nowMs, R))
    }
    return
  }
  if (rec.phase === 'paused') {
    if (!rec.error && R.pauseNoted) return
    R.pauseNoted = true
  }
  const code = rec.error || (R.pause && R.pause.kind) || rec.phase
  if (['plan_required', 'allowance_exceeded', 'free_quota_exhausted', 'free_global_daily_quota_exhausted'].includes(code)) {
    if (R.failureNotices.has('routing_restriction')) return
    R.failureNotices.add('routing_restriction')
  }
  if (R.failureNotices.has(code)) return
  R.failureNotices.add(code)
  const line = lineFor(rec, nowMs, R)
  if (line !== null) say($, line)
}


function rtRace($, promise, ms) {


  if (!(ms > 0)) return Promise.resolve()
  return new Promise((resolve) => {
    let timer = null, finished = false
    const done = () => {
      if (finished) return
      finished = true
      try { timer?.cancel() } catch (_) {}
      resolve()
    }
    promise.then(done, done)
    try { timer = $.clock.after(ms, done); if (finished) timer?.cancel() } catch (_) { done() }
  })
}

async function rtStepEnd($, e2, result, begun) {
  if (begun.startMs === null || e2.agentId) return
  const u = result && result.usage && typeof result.usage === 'object' ? result.usage : null
  if (u === null) return
  const nowMs = await $.clock.now()
  RM.nowMs = nowMs
  await rtCacheStartLoad($)
  const prev = R.last
  const started = R.cacheStart
  const sessionModel = await safe($.session.model())

  const observed = await safe($.session.usage())
  const rateLimits = observed && observed.rateLimits
  const settings = await rtReadTtl($)
  const derivedMs = latestCacheWriteTtlMs(u, e2.model) ?? R.observedCacheTtlMs ?? (ttlIsKnown(settings, rateLimits) ? cacheTtlMs({ ...settings, onSubscription: onSubscription(rateLimits, nowMs) }) : null)
  const cachePrev = R.cacheModels && R.cacheModels[canonicalModel(e2.model)]
  const ttlMs = latestCacheWriteTtlMs(u, e2.model) ?? writeTtlMs({ derivedMs, usage: u, prev: cachePrev ? cachePrev.last : prev, model: e2.model })
  noteMainStep(R, { model: e2.model, effort: e2.effort, startMs: begun.startMs, endMs: nowMs, usage: u, routed: begun.changed === true && !begun.rec?.userOverride, sessionModel, ttlMs, advisorCalls: advisorCallsIn(result) })
  RM.turnSteps.set(e2.turnId, (RM.turnSteps.get(e2.turnId) || 0) + 1)
  let pricing
  if (begun.rec !== null && RM.pricer !== null) {

    pricing = noteRecStep(begun.rec, { model: e2.model, effort: e2.effort, usage: u, pricer: RM.pricer, prev, startMs: begun.startMs, ttlMs: prev?.ttlMs ?? (R.ttlKnown ? R.ttlMs : 60 * 60 * 1000), changed: begun.changed === true, advisorCalls: advisorCallsIn(result), writeTtl: ttlMs ? ttlMs / 1000 : null, measured: begun.measured })
  }
  if (R.cacheStart && R.cacheStart !== started) await rtCacheStartSave($, R.cacheStart)
  return pricing
}



async function rtCacheStartLoad($) {
  const router = R
  if (router.cacheStartRead === true) return
  router.cacheStartRead = true
  if (router.cacheStart || !RM.home) return
  const sid = await safe($.session.id())
  if (typeof sid !== 'string' || sid === '' || sid.length > 64) return
  const path = pathIn(RM.home, DATA_DIR, CACHE_START_FILE)
  if (!(await safe($.fs.exists(path)))) return
  const saved = savedCacheStart(await safe($.fs.read(path)), sid)
  if (saved !== null && R === router && !router.cacheStart) router.cacheStart = saved
}

async function rtCacheStartSave($, start) {
  if (!RM.home) return
  const sid = await safe($.session.id())
  if (typeof sid !== 'string' || sid === '' || sid.length > 64) return
  const path = pathIn(RM.home, DATA_DIR, CACHE_START_FILE)
  const run = async () => {
    const old = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
    await $.fs.write(path, cacheStartText(old, sid, start))
  }
  RM.chain = RM.chain.then(run, run)
  try {
    await RM.chain
  } catch (err) {
    await rtNoteError($, 'cache.start', err, { count: false })
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
  if (e.reason === 'error' || e.isAborted) clearRouteHold(R)
  noteTurnDone(R, rec)
  usageSession.finalize(rec)

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
    RM.explicitEffort = null
    usageSession.invalidateReporting()
    if (usageReport) usageReport.dispose()
    usageSession = newUsageSession()
    usageIdentity = null
    R.armed = false
    RM.requestEpoch += 1
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
    if (e.reason === 'clear') await rtAutoArm($)
  }
}




async function rtWriteRows($, recs) {
  const nowMs = await $.clock.now()
  RM.nowMs = nowMs
  const sid = await safe($.session.id())
  const rows = recs.map((rec) => decisionRow(R, rec, { nowMs, sessionId: typeof sid === 'string' ? sid : null }))
  await rtAppendRows({ exists: (path) => $.fs.exists(path), read: (path) => $.fs.read(path), write: (path, text) => $.fs.write(path, text) }, rows, nowMs)
}

async function rtAppendRows(access, rows, nowMs) {
  const run = () => rtWriteFile(access, rows, nowMs)
  RM.chain = RM.chain.then(run, run)
  try {
    await RM.chain
  } catch (err) {

    R.lastError = 'decisions.write'
  }
}

async function rtWriteFile(access, rows, nowMs) {
  if (!RM.home) return
  const day = dayOf(nowMs)
  if (RM.day !== day) {
    RM.day = day
    RM.part = 0
  }
  RM.logTag ||= Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  const dir = pathIn(RM.home, RT_DIR, 'decisions')
  const addLen = rows.reduce((n, r) => n + JSON.stringify(r).length + 1, 0)
  for (let part = RM.part; part < LOG_MAX_PARTS; part++) {
    const path = pathIn(dir, day + '-' + RM.logTag + (part === 0 ? '' : '-' + (part + 1)) + '.jsonl')
    let text = ''
    if (await access.exists(path)) text = await access.read(path)
    if (text.length + addLen > LOG_PART_CAP) continue
    await access.write(path, mergeRows(text, rows))
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
    if (LIMIT_AWARE_ENABLED) {
      await refreshLimits($)
      if (noUsage(await $.clock.now()) || !current()) return null
    }
    let response = null
    const job = $.http.fetch(req.url, req.init).then((res) => { response = res }, () => {})
    await rtRace($, job, ms)
    return response && response.status >= 200 && response.status < 300
      ? { plan: parseRoutingPlan(response.text), usage: routingUsage(response.text) } : null
  } catch (_) { return null }
}

async function rtCommand($, e) {
  if (!userOrigin(e)) return {}
  const arg = (typeof e.args === 'string' ? e.args : '').trim().toLowerCase()
  const intent = arg === 'off' || arg === 'on' && KEEP_ROUTING_ON_ENABLED === true ? ++routingIntent : routingIntent
  const generation = sessionGeneration
  let offSave = null
  if (arg === 'off') {
    sessionOff = true
    authOff()
    rtDisarm()
    if (R.pause && R.pause.kind === 'plan' && R.pause.posted !== true) R.pause = null
    cancelRouteWork()

    if (KEEP_ROUTING_ON_ENABLED === true || State.getSetting('keepRoutingOn') === true) {
      const io = iqAccess($)
      offSave = State.saveSettings({ keepRoutingOn: false }, (text, patch) => writeTrustedSettings(io, text, patch))
    }
    $.ui.invalidate('ui.render')
  }


  if (!(await ensureInteractive($))) return {}
  if (generation !== sessionGeneration || intent !== routingIntent) return {}
  const nowMs = await $.clock.now()
  RM.nowMs = nowMs
  if (arg === 'on') {
    const router = R, runtime = RM, requestEpoch = RM.requestEpoch
    const current = () => R === router && RM === runtime && RM.requestEpoch === requestEpoch && generation === sessionGeneration && intent === routingIntent
    if (!RM.ready) return { text: TEXT.cardChanged }
    if (credentials && credentials.configured() && (State.getSetting('authBlocked') === true || credentials.read() === LOGGED_OUT_KEY)) {
      const home = await trustedSettingsHome(iqAccess($))
      if (!home || !(await State.saveSettings({ authBlocked: false }, (text, patch) => writeTrustedSettings(iqAccess($), text, patch), () => generation === sessionGeneration && intent === routingIntent))) {
        return { text: TEXT.off }
      }
      credentials.reauthorize()
    }
    authCancel()
    sessionOff = false
    await rtGates($)
    if (!current()) return { text: TEXT.off }
    if (R.killed) return { text: TEXT.killed }
    if (!R.hasKey) return { text: TEXT.noKey }
    if (!RM.home) return { text: TEXT.noHome }
    if (R.stopped) return { text: TEXT.stopped }
    if (R.pause && R.pause.kind === 'plan') return { text: planPauseText(R) }
    if (KEEP_ROUTING_ON_ENABLED === true) {
      const saved = await State.saveSettings({ keepRoutingOn: true, routingEligible: true },
        (text, patch) => writeTrustedSettings(iqAccess($), text, patch), current)
      if (!current()) return { text: TEXT.off }
      if (!saved) return { text: TEXT.off + ' Could not save routing on for this device. Try /iq Settings.' }
    }
    if (LIMIT_AWARE_ENABLED) {
      await refreshLimits($)
      if (!current()) return { text: TEXT.off }
    }
    if (!R.armed && !R.plan && !(LIMIT_AWARE_ENABLED && noUsage(nowMs))) {
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
      await persistPlanRestriction('plan_required', iqAccess($), State)
      if (!current()) return { text: TEXT.off }
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
    if (R.stopped) return { text: TEXT.stopped }
    R.armed = true
    if (R.pause && R.pause.kind === 'auth') R.pause = null
    R.errorsOff = false
    R.errors = 0
    R.iqFails = 0
    $.ui.invalidate('ui.render')
    const lines = [onLine(R, nowMs)]
    if (serverMode()) lines.push(State.getSetting('subagentRouting') === true ? SUB_TEXT.pubStatusOn : SUB_TEXT.pubStatusOff)
    return { text: lines.join('\n') }
  }
  if (arg === 'off') {
    if (offSave === null) return { text: TEXT.off }
    const saved = await offSave
    return { text: TEXT.off + ' ' + (saved ? 'Keep routing on is turned off on this device.' : 'This session is off, but Keep routing on could not be turned off; use /iq Settings.') }
  }
  if (arg === 'reset') {
    R.resetNextRoute = true
    clearRouteHold(R)
    return { text: TEXT.reset }
  }
  if (arg === 'status' || arg === '') {
    if (RM.ready) await rtGates($)
    const lines = statusLines(R, nowMs)
    const measured = sessionMeter(currentMeterView(false), T).session.measured
    if (R.armed && measured) lines.push(measuredSpendLine(measured), estimatedSavingsText(measured.saved_usd), SAVINGS_NOTE)
    if (KEEP_ROUTING_ON_ENABLED === true && State.getSetting('keepRoutingOn') === true && State.getSetting('routingEligible') === false && !lines.includes(TEXT.pausedPlan) && !lines.includes(TEXT.pausedPlanRefused)) lines.push(TEXT.pausedPlan)
    if (serverMode()) lines.push(State.getSetting('subagentRouting') === true ? SUB_TEXT.pubStatusOn : SUB_TEXT.pubStatusOff)
    return { text: lines.map(displayText).join('\n') }
  }
  return { text: TEXT.usage }
}
