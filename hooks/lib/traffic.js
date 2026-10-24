import { writeSettingsStore } from './settings_store.js'
import { ERROR_LOG_CAP } from './pins.js'

import { fileProjectionReader, isoOf, projectEnvNames, steersLaunch, tailLines } from './util.js'
export const truthy = (v) => typeof v === 'string' && v.trim() !== '' && !['0', 'false', 'no', 'off'].includes(v.trim().toLowerCase())





export const HELPER_PROCESS_ENV = {
  NODE_OPTIONS: '', NODE_PATH: '', LD_PRELOAD: '', LD_LIBRARY_PATH: '', LD_AUDIT: '',
  DYLD_INSERT_LIBRARIES: '', DYLD_LIBRARY_PATH: '', DYLD_FRAMEWORK_PATH: '',
  DYLD_FALLBACK_LIBRARY_PATH: '', DYLD_FALLBACK_FRAMEWORK_PATH: '',
  PYTHONPATH: '', PYTHONHOME: '', PYTHONSTARTUP: '', BASH_ENV: '', ENV: '',
}

export function homeFrom(profile, home) {
  for (const value of [profile, home]) {
    if (typeof value !== 'string' || value === '' || /[\x00-\x1f]/.test(value)) continue
    if (/^[A-Za-z]:[\\/]/.test(value) || /^\/(?!\/)/.test(value)) return value
  }
  return null
}

export function pathIn(base, ...parts) {
  if (typeof base !== 'string' || base === '') return ''
  const sep = /^[A-Za-z]:[\\/]/.test(base) || base.includes('\\') ? '\\' : '/'
  return base.replace(/[\\/]+$/, '').replace(/[\\/]+/g, sep) + sep + parts.map((part) =>
    String(part).replace(/^[\\/]+|[\\/]+$/g, '').replace(/[\\/]+/g, sep)).join(sep)
}




async function projectEnvFree(readSettings, names, steers = () => false) {
  const set = await projectEnvNames(readSettings)
  return set !== null && ![...set].some(name => names.includes(name) || steers(name))
}


const HOME_ENV = ['HOME', 'USERPROFILE', 'SYSTEMROOT', 'CLAUDE_CONFIG_DIR']



export const homeTrusted = (readSettings) => projectEnvFree(readSettings, HOME_ENV)






export const processTrusted = (readSettings) => projectEnvFree(readSettings, [...HOME_ENV,
  'PATH', 'PATHEXT', 'COMSPEC', ...Object.keys(HELPER_PROCESS_ENV)], steersLaunch)






export async function trustedSettingsHome(access) {
  if (!(await homeTrusted(access.readSettings))) return null
  try { return homeFrom(undefined, await access.home()) } catch (_) { return null }
}


export function storedUsageReporting(settings) {
  if (settings === undefined) return 'on'
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return 'off'
  return !Object.hasOwn(settings, 'usageReporting') || settings.usageReporting === 'on' ? 'on' : 'off'
}

const settingsFile = fileProjectionReader(text => {
  const value = JSON.parse(text)
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
})
const credentialFile = fileProjectionReader(text => validKey(text))



export async function readDeviceSettings(access) {
  try {
    const home = await trustedSettingsHome(access)
    return home ? await settingsFile(access, pathIn(home, '.claude/iq/settings.json')) : null
  } catch (_) { return null }
}

export function invalidateDeviceSettings(path) { settingsFile.invalidate(path) }

export async function readUsageReporting(access) {
  return storedUsageReporting(await readDeviceSettings(access))
}





async function noteSaveFailure(access, home, error) {
  try {
    if (typeof access.exists !== 'function' || typeof access.read !== 'function' || typeof access.write !== 'function') return
    const message = String(error?.message), os = String(error?.code)
    const code = /^settings_[a-z_]{1,40}$/.test(message) ? message : /^E[A-Z0-9]{2,20}$/.test(os) ? os : 'settings_save_failed'
    const detail = typeof error?.detail === 'string' && /^[a-z0-9 ]{1,24}$/.test(error.detail) ? ' ' + error.detail : ''
    const path = pathIn(home, '.claude/iq/router/errors.log')
    const present = await access.exists(path)
    if (present !== true && present !== false) return
    const before = present ? await access.read(path) : ''
    if (typeof before !== 'string') return
    const line = isoOf(Date.now()) + ' settings.save ' + code + ' ' + (/^[A-Za-z]:[\\/]/.test(home) ? 'windows' : 'posix') + detail + '\n'
    await access.write(path, tailLines(before + line, ERROR_LOG_CAP))
  } catch (_) {}
}



export async function writeTrustedSettings(access, text, patch) {
  const home = await trustedSettingsHome(access)
  if (!home) throw new Error('settings_home_untrusted')
  const changes = patch === undefined ? JSON.parse(text) : patch
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('settings_patch_invalid')
  let saved
  try { saved = await writeSettingsStore(access, home, changes, HELPER_PROCESS_ENV) }
  catch (error) { await noteSaveFailure(access, home, error); throw error }
  invalidateDeviceSettings(pathIn(home, '.claude/iq/settings.json'))
  return saved
}



export async function persistPlanRestriction(kind, access, state) {
  if (!['plan_required', 'allowance', 'free_quota', 'free_daily'].includes(kind) || state.getSetting('keepRoutingOn') !== true) return false
  try {
    if (!(await trustedSettingsHome(access))) return false
    return await state.saveSettings({ routingEligible: false }, (text, patch) => writeTrustedSettings(access, text, patch),
      () => state.getSetting('keepRoutingOn') === true)
  } catch (_) { return false }
}

export function validKey(text) {
  const key = typeof text === 'string' ? text.trim() : ''
  return key.length > 0 && key.length <= 4096 && /^[A-Za-z0-9._~+\/-]+=*$/.test(key) ? key : null
}

export const LOGGED_OUT_KEY = '!iq-code-logged-out!'


export function credentialAccess(configured) {
  let override = null
  let denied = false
  return {
    read: () => denied ? LOGGED_OUT_KEY : override || configured,
    activate: (key) => { const clean = validKey(key); if (!clean) return false; override = clean; denied = false; return true },
    clear: () => { override = null },
    deny: () => { override = null; denied = true },
    configured: () => denied ? null : validKey(configured),
    reauthorize: () => !denied && validKey(configured) !== null,
  }
}

export async function readKey(access) {
  try {
    const configured = access.configured ? await access.configured() : undefined
    if (configured === LOGGED_OUT_KEY) return null
    if (configured !== undefined && configured !== null && configured !== '') return validKey(configured)
    const home = await access.home()
    if (!home) return null
    const fileKey = await credentialFile(access, pathIn(home, '.claude/iq/key'))
    if (fileKey !== undefined) return fileKey


    const user = await access.user()
    return validKey(user && user.env && user.env.IQ_ROUTER_KEY)
  } catch (_) { return null }
}

export async function trafficOff(access) {
  try {
    if (access.blocked && (await access.blocked()) !== false) return true
    if ((await access.nonessential()) !== undefined) return true
    if (truthy(await access.disabled())) return true
    const home = await access.home()
    if (!home) return true

    return (await access.exists(pathIn(home, '.claude/iq/router/OFF'))) !== false
  } catch (_) { return true }
}
