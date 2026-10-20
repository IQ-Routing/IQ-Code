
import { homeFrom, pathIn, validKey, LOGGED_OUT_KEY, HELPER_PROCESS_ENV, trustedSettingsHome, processTrusted } from './traffic.js'
import { AUTH_VERIFICATION_URL } from './iq_client.js'

export const CONFIGURE_TIMEOUT_MS = 15000
export const OPENER_TIMEOUT_MS = 5000

let configureWrites = Promise.resolve()

async function homeOf(host) {
  try {
    const value = homeFrom(undefined, await host.home())
    return value && !value.split(/[\\/]+/).some((part) => part === '.' || part === '..') ? value : null
  } catch (_) { return null }
}
async function firstExisting(host, candidates) {
  for (const path of candidates) {
    try {
      const exists = await host.exists(path)
      if (exists === true) return path
      if (exists !== false) return null
    } catch (_) { return null }
  }
  return null
}
function platformOf(host) {
  const value = typeof host.platform === 'function' ? host.platform() : host.platform
  return value === 'macos' ? 'darwin' : value === 'windows' ? 'win32' : value
}
export async function resolveClaudeExecutable(host) {
  const home = await homeOf(host)
  if (!home) return null
  const platform = platformOf(host)
  if (platform === 'darwin') return firstExisting(host, [pathIn(home, '.local/bin/claude'),
    '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe'])
  if (platform === 'linux') return firstExisting(host, [pathIn(home, '.local/bin/claude'), '/usr/local/bin/claude', '/usr/bin/claude'])

  if (platform === 'win32') return firstExisting(host, [pathIn(home, '.local/bin/claude.exe'),
    pathIn(home, 'AppData/Local/Microsoft/WinGet/Links/claude.exe')])
  return null
}



export async function readAuthStatus(access) {
  try {

    const home = await trustedSettingsHome(access)
    if (!home || !(await processTrusted(access.readSettings))) return null
    const platform = /^[A-Za-z]:[\\/]/.test(home) ? 'win32' :
      await access.exists('/System/Library/CoreServices/SystemVersion.plist') === true ? 'darwin' : 'linux'
    const executable = await resolveClaudeExecutable({ platform, home: async () => home, exists: access.exists })
    if (!executable) return null
    const result = await access.run([executable, 'auth', 'status'], {
      timeoutMs: 5000, cwd: home, env: { ...HELPER_PROCESS_ENV },
    })
    return result?.exitCode === 0 ? result.stdout : null
  } catch (_) { return null }
}

export async function configureSecret(host, value, stillCurrent = () => true) {
  if (value !== LOGGED_OUT_KEY && validKey(value) !== value) return { ok: false, code: 'invalid_credential' }
  const job = configureWrites.then(async () => {
    try {
      if (await stillCurrent() !== true) return { ok: false, code: 'cancelled' }
      const home = await homeOf(host)
      const executable = home && await resolveClaudeExecutable(host)
      if (!executable) return { ok: false, code: 'cli_missing' }
      if (await stillCurrent() !== true) return { ok: false, code: 'cancelled' }
      const result = await host.run([executable, 'plugin', 'configure', 'iq-code@iq-routing', '--values-stdin'], {
        stdin: JSON.stringify({ iq_api_key: value }) + '\n', timeoutMs: CONFIGURE_TIMEOUT_MS, cwd: home, env: { ...HELPER_PROCESS_ENV },
      })
      return result && result.exitCode === 0 ? { ok: true, code: 'saved' } : { ok: false, code: 'configure_failed' }
    } catch (_) { return { ok: false, code: 'configure_failed' } }
  })
  configureWrites = job.catch(() => {})
  return job
}

export async function launchBrowser(host) {
  try {
    const home = await homeOf(host)
    if (!home) return { ok: false, code: 'opener_unavailable' }
    const platform = platformOf(host)
    let executable, argv
    if (platform === 'darwin') executable = await firstExisting(host, ['/usr/bin/open'])
    else if (platform === 'linux') executable = await firstExisting(host, ['/usr/bin/xdg-open', '/usr/local/bin/xdg-open'])
    else if (platform === 'win32') {
      const root = homeFrom(undefined, await host.systemRoot())
      if (!root || !/^[A-Za-z]:[\\/]Windows[\\/]?$/i.test(root)) return { ok: false, code: 'opener_unavailable' }
      executable = await firstExisting(host, [pathIn(root, 'System32/rundll32.exe')])
    }
    if (!executable) return { ok: false, code: 'opener_unavailable' }
    argv = platform === 'win32' ? [executable, 'url.dll,FileProtocolHandler', AUTH_VERIFICATION_URL] : [executable, AUTH_VERIFICATION_URL]
    const result = await host.run(argv, { timeoutMs: OPENER_TIMEOUT_MS, cwd: home, env: { ...HELPER_PROCESS_ENV } })
    return result && result.exitCode === 0 ? { ok: true, code: 'opened' } : { ok: false, code: 'opener_unavailable' }
  } catch (_) { return { ok: false, code: 'opener_unavailable' } }
}
