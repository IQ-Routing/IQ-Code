
import { authRequest, parseAuthResponse, AUTH_VERIFICATION_URL, userOrigin } from './iq_client.js'
import { validKey, LOGGED_OUT_KEY } from './traffic.js'

export const AUTH_TIMEOUT_MS = 10000
export const LOGOUT_TIMEOUT_MS = 3500
export const MAX_AUTH_POLLS = 180
const FIXED_CONFIGURE_CODES = new Set(['cli_missing', 'configure_failed', 'invalid_credential'])
const succeeded = (result) => result === true || !!(result && result.ok === true)

let authIntentOwner = null

export function createAuth(h) {
  let generation = 0
  let alive = true
  let attempt = null
  let configureQueue = Promise.resolve()
  let phase = 'idle', code = null, keyExpiresAt = null
  let logoutBusy = false
  let logoutPromise = null
  let localOwner = null
  const waits = new Set()
  const enabled = () => { try { return (typeof h.enabled === 'function' ? h.enabled() : h.enabled) === true } catch (_) { return false } }
  const ownsIntent = () => localOwner === null || authIntentOwner === localOwner
  const current = (gen) => alive && generation === gen && enabled() && ownsIntent()
  const notify = () => { try { if (h.changed) h.changed() } catch (_) {} }
  const set = (nextPhase, nextCode = null) => { phase = nextPhase; code = nextCode; notify() }
  const stopTimer = (a) => {
    if (a && a.timer) { try { a.timer.cancel() } catch (_) {} a.timer = null }
  }
  const allowed = async (gen, stage, requireEnabled = true) => {
    if (!alive || generation !== gen || !ownsIntent() || requireEnabled && !enabled()) return false
    try {
      const ok = await h.allowed(stage)
      return ok === true && alive && generation === gen && ownsIntent() && (!requireEnabled || enabled())
    } catch (_) { return false }
  }
  const cleanupAllowed = async () => {
    try { return (await (h.cleanupAllowed ? h.cleanupAllowed() : h.allowed('cleanup'))) === true } catch (_) { return false }
  }

  const wait = (operation, ms, onLate) => new Promise((resolve) => {
    let done = false, timer
    const item = { cancel: () => finish({ ok: false, code: 'cancelled' }) }
    function finish(value) {
      if (done) return
      done = true; waits.delete(item)
      if (timer) { try { timer.cancel() } catch (_) {} }
      resolve(value)
    }
    waits.add(item)
    try { timer = h.after(ms, () => finish({ ok: false, code: 'request_timeout' })) }
    catch (_) { finish({ ok: false, code: 'request_failed' }); return }
    if (done) return
    let promise
    try { promise = Promise.resolve(operation()) } catch (_) { finish({ ok: false, code: 'request_failed' }); return }
    promise.then((value) => {
      if (!done) finish({ ok: true, value })
      else if (onLate) Promise.resolve().then(() => onLate(value)).catch(() => {})
    }, () => finish({ ok: false, code: 'request_failed' }))
  })
  const request = async (gen, action, secret, ms = AUTH_TIMEOUT_MS, onLate, cleanup = false) => {
    const permitted = () => cleanup ? cleanupAllowed() : allowed(gen, action, action !== 'logout')
    if (!await permitted()) return { ok: false, code: 'traffic_blocked' }
    let destination
    try { destination = await h.destination() } catch (_) { return { ok: false, code: 'destination_blocked' } }
    if (!await permitted()) return { ok: false, code: 'traffic_blocked' }
    const req = authRequest({ ...destination, action, secret, platform: h.platform, version: h.version })
    if (!req) return { ok: false, code: 'destination_blocked' }
    const result = await wait(() => h.request(req, { cleanup }), ms, onLate && ((response) => onLate(parseAuthResponse(response, req, action))))
    if (!result.ok) return result
    const parsed = parseAuthResponse(result.value, req, action)

    if (!await permitted()) return parsed.ok && action === 'token' ? { ...parsed, stale: true } : { ok: false, code: 'traffic_blocked' }
    return parsed
  }
  const enqueueConfigure = (value, guard) => {
    const job = configureQueue.then(async () => {
      if (await guard() !== true) return { ok: false, code: 'cancelled' }
      try { return await h.configure(value, guard) } catch (_) { return { ok: false, code: 'configure_failed' } }
    })
    configureQueue = job.catch(() => {})
    return job
  }
  const revoke = async (key) => {
    const gen = generation
    if (!validKey(key)) return false
    const result = await request(gen, 'logout', key, LOGOUT_TIMEOUT_MS, undefined, true)
    return result.ok === true
  }
  const abandon = (a) => {
    stopTimer(a)
    if (!a || !a.key || a.revoking) return
    const key = a.key; a.key = null; a.revoking = true

    Promise.resolve().then(() => revoke(key)).catch(() => {})
  }
  const rollbackConsent = (a) => {
    if (!a || !a.consentStarted) return
    a.consentStarted = false
    const owned = () => authIntentOwner === a.owner
    if (!owned()) return
    try { h.disarm() } catch (_) {}
    Promise.resolve().then(async () => {
      let reverted = false
      try { reverted = succeeded(await h.saveSettings({ keepRoutingOn: false, authBlocked: true }, owned)) } catch (_) {}
      if (!reverted && owned()) {
        const sentinel = await enqueueConfigure(LOGGED_OUT_KEY, owned)
        if (!succeeded(sentinel) && owned() && alive && generation === a.gen) set('error', 'login_persistence_failed')
      }
    }).catch(() => {})
  }
  const invalidate = () => {
    generation += 1
    for (const item of [...waits]) item.cancel()
    const old = attempt; attempt = null
    if (old) {
      old.deviceCode = null; old.userCode = null
      if (old.activating) { try { h.disarm() } catch (_) {} }
      rollbackConsent(old)
      abandon(old)
    }
    return old
  }
  const fail = (a, error) => {
    if (!current(a.gen)) { rollbackConsent(a); abandon(a); return }
    attempt = null; a.deviceCode = null; a.userCode = null; rollbackConsent(a); abandon(a)
    set('error', error)
  }
  const schedule = (a, ms) => {
    if (!current(a.gen) || attempt !== a) return
    stopTimer(a)
    try {
      a.timer = h.after(Math.min(ms, Math.max(0, a.expiresAt - h.now())), () => {
        a.timer = null
        if (!current(a.gen) || attempt !== a) return
        if (h.now() >= a.expiresAt) { fail(a, 'expired_token'); return }
        Promise.resolve().then(() => poll(a)).catch(() => fail(a, 'auth_failed'))
      })
    } catch (_) { fail(a, 'timer_unavailable') }
  }
  const connect = async (a, token) => {
    a.key = token.key; a.deviceCode = null; a.userCode = null
    if (!current(a.gen) || attempt !== a) { rollbackConsent(a); abandon(a); return }
    if (token.stale) { fail(a, 'traffic_blocked'); return }
    if (!await allowed(a.gen, 'save')) { fail(a, 'traffic_blocked'); return }
    set('saving')
    const result = await enqueueConfigure(a.key, async () => current(a.gen) && attempt === a && await allowed(a.gen, 'save'))
    if (!current(a.gen) || attempt !== a) { rollbackConsent(a); abandon(a); return }
    if (!succeeded(result)) { fail(a, FIXED_CONFIGURE_CODES.has(result && result.code) ? result.code : 'configure_failed'); return }
    if (!await allowed(a.gen, 'save')) { fail(a, 'traffic_blocked'); return }
    set('confirming')
    let confirmed = false
    for (let retries = 0; retries < 3; retries += 1) {
      const ack = await request(a.gen, 'complete', a.key)
      if (!current(a.gen) || attempt !== a) { rollbackConsent(a); abandon(a); return }
      if (ack.ok) { confirmed = true; break }
      if (!['request_timeout', 'request_failed', 'unavailable', 'rate_limited'].includes(ack.code) || retries === 2) { fail(a, 'confirmation_failed'); return }
      const delay = await wait(() => new Promise((resolve) => {
        a.timer = h.after(1000 * (retries + 1), () => { a.timer = null; resolve() })
      }), 1000 * (retries + 1) + 100)
      stopTimer(a)
      if (!delay.ok || !current(a.gen)) { abandon(a); return }
    }
    if (!confirmed || !await allowed(a.gen, 'save')) { fail(a, 'traffic_blocked'); return }
    let saved = false
    a.consentStarted = true
    try { saved = succeeded(await h.saveSettings({ keepRoutingOn: true, authBlocked: false, routingEligible: token.routingEligible }, () => current(a.gen) && attempt === a)) } catch (_) {}
    if (!current(a.gen) || attempt !== a) { rollbackConsent(a); abandon(a); return }
    if (!saved) { fail(a, 'settings_save_failed'); return }
    if (!await allowed(a.gen, 'activate')) { fail(a, 'traffic_blocked'); return }

    if (h.installKey) {
      let installed = false
      try { installed = (await h.installKey(a.key, () => current(a.gen) && attempt === a)) === true } catch (_) {}
      if (!current(a.gen) || attempt !== a) { rollbackConsent(a); abandon(a); return }
      if (!installed) { fail(a, 'configure_failed'); return }
      if (!await allowed(a.gen, 'activate')) { fail(a, 'traffic_blocked'); return }
    }
    let activated = false
    if (token.routingEligible === true) {
      a.activating = true
      try { activated = (await h.activate(a.key, () => current(a.gen) && attempt === a)) === true } catch (_) {}
      a.activating = false
    }
    if (!current(a.gen) || attempt !== a) { rollbackConsent(a); abandon(a); return }
    const finalAllowed = await allowed(a.gen, 'activate')
    if (!current(a.gen) || attempt !== a) { rollbackConsent(a); abandon(a); return }
    if (!finalAllowed) {
      try { h.disarm() } catch (_) {}
      fail(a, 'traffic_blocked'); return
    }
    keyExpiresAt = token.keyExpiresAt
    a.key = null; a.consentStarted = false; attempt = null
    set('connected', token.routingEligible === false ? 'free' : activated ? 'paid' : 'blocked')
  }
  const poll = async (a) => {
    if (!current(a.gen) || attempt !== a) return
    if (h.now() >= a.expiresAt || a.polls >= MAX_AUTH_POLLS) { fail(a, 'expired_token'); return }
    a.polls += 1
    const answer = await request(a.gen, 'token', a.deviceCode, AUTH_TIMEOUT_MS, (late) => late.ok && late.key ? revoke(late.key) : undefined)
    if (answer.ok) { await connect(a, answer); return }
    if (!current(a.gen) || attempt !== a) return
    if (answer.code === 'authorization_pending') { a.failures = 0; schedule(a, a.interval); return }
    if (answer.code === 'slow_down') { a.failures = 0; a.interval = Math.min(60000, a.interval + 5000); schedule(a, a.interval); return }
    if (['unavailable', 'rate_limited', 'request_failed'].includes(answer.code) && a.failures < 4) {
      a.failures += 1; schedule(a, Math.min(60000, a.interval * 2 ** a.failures)); return
    }
    fail(a, answer.code)
  }
  const start = async (a) => {
    try {
      if (h.interactive && await h.interactive() !== true) { fail(a, 'interactive_required'); return }
    } catch (_) { fail(a, 'interactive_required'); return }
    if (!await allowed(a.gen, 'start')) { fail(a, 'traffic_blocked'); return }
    if (h.preflight) {
      let capable = false
      try { capable = (await h.preflight()) === true } catch (_) {}
      if (!current(a.gen) || attempt !== a) return
      if (!capable) { fail(a, 'cli_missing'); return }
      if (!await allowed(a.gen, 'start')) { fail(a, 'traffic_blocked'); return }
    }
    a.owner = {}; localOwner = a.owner; authIntentOwner = a.owner
    try { (h.stopRouting || h.disarm)() } catch (_) {}
    const answer = await request(a.gen, 'start')
    if (!current(a.gen) || attempt !== a) return
    if (!answer.ok) { fail(a, answer.code); return }
    a.deviceCode = answer.deviceCode; a.userCode = answer.userCode
    a.interval = answer.interval * 1000; a.expiresAt = h.now() + answer.expiresIn * 1000
    set('pending')
    schedule(a, a.interval)
    if (h.openBrowser && await allowed(a.gen, 'open')) {

      Promise.resolve().then(() => current(a.gen) && h.openBrowser(AUTH_VERIFICATION_URL)).catch(() => {})
    }
  }
  const logout = (readEffective = h.readKey) => {
    if (logoutPromise) return logoutPromise
    let keyRead
    try { keyRead = Promise.resolve(readEffective()) } catch (_) { keyRead = Promise.resolve(null) }
    const owner = {}; localOwner = owner; authIntentOwner = owner
    const owned = () => authIntentOwner === owner
    invalidate()
    const gen = generation
    try { h.disarm() } catch (_) {}
    keyExpiresAt = null; logoutBusy = true; set('disconnected', 'logout_pending')
    const work = async () => {
      let saved = false, overwritten = false
      try { saved = succeeded(await h.saveSettings({ authBlocked: true, keepRoutingOn: false }, owned)) } catch (_) {}

      const sentinel = await enqueueConfigure(LOGGED_OUT_KEY, owned)
      overwritten = succeeded(sentinel)
      const keyResult = await wait(() => keyRead, 1000)
      let revoked = false
      if (keyResult.ok && validKey(keyResult.value) && alive && generation === gen) revoked = (await request(gen, 'logout', keyResult.value, LOGOUT_TIMEOUT_MS)).ok === true
      if (generation === gen && owned()) set('disconnected', !saved && !overwritten ? 'logout_persistence_failed' : revoked ? 'logged_out' : 'logout_local_only')
      return { local: true, durable: saved || overwritten, revoked }
    }
    const result = work().catch(() => {
      if (generation === gen) set('disconnected', 'logout_persistence_failed')
      return { local: true, durable: false, revoked: false }
    })
    logoutPromise = result.finally(() => { logoutBusy = false; logoutPromise = null })
    return logoutPromise
  }
  return {
    login(e) {
      if (!alive || logoutBusy || !userOrigin(e)) { set('error', !userOrigin(e) ? 'human_required' : 'auth_busy'); return false }
      if (!enabled()) { set('error', 'feature_disabled'); return false }
      invalidate(); localOwner = null; keyExpiresAt = null
      const a = { gen: generation, deviceCode: null, userCode: null, key: null, timer: null, expiresAt: 0, interval: 5000, polls: 0, failures: 0 }
      attempt = a; set('starting')
      Promise.resolve().then(() => start(a)).catch(() => fail(a, 'auth_failed'))
      return true
    },
    cancel(reason = 'cancelled') {
      if (!attempt) return false
      const old = invalidate()
      if (old) set('cancelled', ['session_ended', 'session_reset', 'routing_off'].includes(reason) ? reason : 'cancelled')
      return !!old
    },
    off() { const old = invalidate(); try { (h.stopRouting || h.disarm)() } catch (_) {} if (old) set('cancelled', 'routing_off') },
    reset() { invalidate(); alive = true; keyExpiresAt = null; set('idle') },
    end() { invalidate(); alive = false; keyExpiresAt = null; set('idle', 'session_ended') },
    logout,
    status: () => ({ phase, code, keyExpiresAt }),
    pane: () => ({ phase, code, userCode: attempt && attempt.userCode || null, verificationUrl: AUTH_VERIFICATION_URL,
      expiresAt: attempt && attempt.expiresAt || null, keyExpiresAt }),
  }
}
