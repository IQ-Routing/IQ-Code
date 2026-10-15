
export const truthy = (v) => typeof v === 'string' && v.trim() !== '' && !['0', 'false', 'no', 'off'].includes(v.trim().toLowerCase())

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


export async function processTrusted(readSettings) {
  try {
    for (const source of ['project', 'local']) {
      const settings = await readSettings(source)
      if (!settings || typeof settings !== 'object') return false
      const env = settings.env || {}
      if (['HOME', 'USERPROFILE', 'SystemRoot', 'CLAUDE_CONFIG_DIR'].some((key) => Object.prototype.hasOwnProperty.call(env, key))) return false
    }
    return true
  } catch (_) { return false }
}

export async function trustedSettingsHome(access) {
  if (!(await processTrusted(access.readSettings))) return null
  try { return homeFrom(undefined, await access.home()) } catch (_) { return null }
}

export async function writeTrustedSettings(access, text) {
  const home = await trustedSettingsHome(access)
  if (!home) throw new Error('settings_home_untrusted')
  await access.write(pathIn(home, '.claude/iq/settings.json'), text)
}



export async function persistPlanRestriction(kind, access, state) {
  if (kind !== 'plan_required' || state.getSetting('keepRoutingOn') !== true) return false
  try {
    if (!(await trustedSettingsHome(access))) return false
    return await state.saveSettings({ routingEligible: false }, (text) => writeTrustedSettings(access, text),
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
    const exists = await access.exists(pathIn(home, '.claude/iq/key'))
    if (exists === true) return validKey(await access.read(pathIn(home, '.claude/iq/key')))
    if (exists !== false) return null
    
    
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
