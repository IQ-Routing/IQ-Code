
import { createAuth } from './lib/auth.js'
import { configureSecret, launchBrowser, resolveClaudeExecutable } from './lib/auth_process.js'
import { authCommandMatches, loginPane } from './lib/login_pane.js'
import { readKey, trafficOff, homeFrom, processTrusted, trustedSettingsHome, writeTrustedSettings } from './lib/traffic.js'
import { BROWSER_LOGIN_PLATFORMS, BROWSER_LOGIN_ENABLED, KEEP_ROUTING_ON_ENABLED } from './lib/release_flags.js'
import { destinationFrom, userOrigin } from './lib/iq_client.js'
import { VERSION } from './lib/pins.js'
import * as State from './lib/state.js'

let A = null
let H = null
let bridgeGeneration = 0
let commandGeneration = 0
const safe = (p) => Promise.resolve(p).catch(() => undefined)
export const authReset = () => { bridgeGeneration += 1; if (A) A.end(); A = null }
export const authEnd = () => { bridgeGeneration += 1; if (A) A.end() }
export const authOff = () => { commandGeneration += 1; if (A) A.off() }
export const authCancel = () => { commandGeneration += 1; if (A) A.cancel() }

function access($) {
  return { configured: () => H.pluginKey(), home: async () => homeFrom(await $.env.get('USERPROFILE'), await $.env.get('HOME')),
    exists: (path) => $.fs.exists(path), read: (path) => $.fs.read(path), user: () => $.settings.read({ source: 'user' }),
    readSettings: (source) => $.settings.read({ source }), write: (path, text) => $.fs.write(path, text),
    nonessential: () => $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'), disabled: () => $.env.get('IQ_ROUTER_DISABLED'),
    cwd: () => $.session.cwd(), settings: () => $.settings.read(), force5m: () => $.env.get('FORCE_PROMPT_CACHING_5M'),
    envTtl: () => $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'), oneHour: () => $.env.get('ENABLE_PROMPT_CACHING_1H'),
    invalidate: () => $.ui.invalidate('ui.render') }
}

async function controller($) {
  if (A) return A
  const generation = bridgeGeneration
  const host = H
  const io = access($)
  const home = await io.home()
  const windows = typeof home === 'string' && /^[A-Za-z]:[\\/]/.test(home)
  const mac = !windows && await safe($.fs.exists('/System/Library/CoreServices/SystemVersion.plist')) === true
  const platform = windows ? 'windows' : mac ? 'macos' : 'linux'
  const processHost = { platform, home: io.home, systemRoot: () => $.env.get('SystemRoot'), exists: io.exists,
    run: (argv, init) => $.process.run(argv, init) }
  const trusted = () => processTrusted(io.readSettings)
  if (generation !== bridgeGeneration) return null
  const allowed = async () => generation === bridgeGeneration && host.interactive() && host.ready() && host.directoryAllowed(await io.cwd(), await io.home()) &&
    !(await trafficOff(io)) && destinationFrom(await io.user()).base !== null
  const cleanupAllowed = async () => !(await trafficOff(io)) && destinationFrom(await io.user()).base !== null
  A = createAuth({ enabled: () => host.enabled() && BROWSER_LOGIN_PLATFORMS.includes(platform), allowed, cleanupAllowed, now: () => Date.now(), after: (ms, fn) => $.clock.after(ms, fn),
    preflight: async () => {
      
      
      try {
        if (!(await trusted())) return false
        const executable = await resolveClaudeExecutable(processHost)
        if (!executable) return false
        const result = await $.process.run([executable, '--version'], { timeoutMs: 5000, cwd: home })
        return result && result.exitCode === 0
      }
      catch (_) { return false }
    },
    platform, version: VERSION, destination: async () => destinationFrom(await io.user()),
    request: async (request, metadata) => {
      if (!(await (metadata && metadata.cleanup ? cleanupAllowed() : allowed()))) return null
      return $.http.fetch(request.url, request.init)
    },
    configure: (key, guard) => configureSecret(processHost, key, async () => await trusted() && await guard() === true),
    saveSettings: async (patch, stillCurrent = () => true) => {
      const currentHome = await trustedSettingsHome(io)
      if (!currentHome) return false
      return State.saveSettings(patch, (text) => writeTrustedSettings(io, text), stillCurrent)
    },
    readKey: () => readKey(io), installKey: (key, live) => host.installKey(key, live),
    activate: (key, live) => host.activate(key, live, { ...io, blocked: () => State.getSetting('authBlocked') === true }),
    disarm: host.disarm, stopRouting: host.stopRouting, changed: io.invalidate,
    openBrowser: async () => {
      
      const ssh = await $.env.get('SSH_CONNECTION')
      const tty = await $.env.get('SSH_TTY')
      if (ssh !== undefined || tty !== undefined) return { ok: false, code: 'opener_unavailable' }
      if (!(await trusted())) return { ok: false, code: 'opener_unavailable' }
      return launchBrowser(processHost)
    },
  })
  return A
}

export function registerAuth(on, host) {
  authEnd()
  bridgeGeneration += 1
  A = null
  H = host
  on('command.run', { command: 'iq', args: /^\s*(?:login(?:\s+(?:status|cancel))?|logout)\s*$/i }, async ($, e, next) => {
    if (!BROWSER_LOGIN_ENABLED || !KEEP_ROUTING_ON_ENABLED) return next(e)
    if (!authCommandMatches(e.args)) return next(e)
    if (!userOrigin(e) || !H.interactive()) return {}
    try {
      const generation = bridgeGeneration
      const arg = e.args.trim().toLowerCase().replace(/\s+/g, ' ')
      const intent = arg === 'login status' ? commandGeneration : ++commandGeneration
      
      const logoutKey = arg === 'logout' ? readKey(access($)) : null
      if (arg === 'logout') { if (A) A.off(); H.disarm() }
      const auth = await controller($)
      if (!auth || generation !== bridgeGeneration) return {}
      if (arg === 'logout') void auth.logout(() => logoutKey).catch(() => {})
      else if (arg === 'login cancel') auth.cancel()
      await $.ui.open({ id: 'iq-login', title: 'IQ connection', focus: true, closeOnEscape: true })
      if (generation !== bridgeGeneration || intent !== commandGeneration) return {}
      if (arg === 'login') { if (H.enabled()) H.begin(); await auth.login(e) }
      $.ui.invalidate('ui.render')
    } catch (_) {
      
      await safe($.ui.log('IQ connection is unavailable. Routing remains off.'))
    }
    return {}
  })
  on('ui.render', { component: 'Pane', requestId: 'iq-login' }, async ($, e, next) => {
    if (!BROWSER_LOGIN_ENABLED || !KEEP_ROUTING_ON_ENABLED || !H.interactive()) return next(e)
    try { return loginPane($.ui.resolve(e), A ? A.pane() : { phase: 'idle' }, () => { if (A) A.cancel(); $.ui.invalidate('ui.render') }) }
    catch (_) { return next(e) }
  })
}
