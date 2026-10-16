
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


export function storedUsageReporting(settings) {
  if (settings === undefined) return 'on'
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return 'off'
  return !Object.hasOwn(settings, 'usageReporting') || settings.usageReporting === 'on' ? 'on' : 'off'
}

export async function readUsageReporting(access) {
  try {
    const home = await trustedSettingsHome(access)
    if (!home) return 'off'
    const target = pathIn(home, '.claude/iq/settings.json')
    const exists = await access.exists(target)
    if (exists === false) return 'on'
    if (exists !== true) return 'off'
    const text = await access.read(target)
    if (typeof text !== 'string') return 'off'
    return storedUsageReporting(JSON.parse(text))
  } catch (_) { return 'off' }
}



const SETTINGS_TRANSACTION = `
const fs = require('node:fs'), path = require('node:path');
const target = process.argv[1], patch = JSON.parse(process.argv[2]);
const lock = target + '.lock';
const reclaim = lock + '.reclaim';
(async () => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let fd;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { fd = fs.openSync(lock, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let reclaiming = false;
      try {
        // A process can die while holding cleanup. Its marker expires after
        // thirty seconds; ordinary cleanup holds it only for synchronous I/O.
        try { if (Date.now() - fs.statSync(reclaim).mtimeMs > 30000) fs.rmdirSync(reclaim); }
        catch (markerError) { if (markerError.code !== 'ENOENT') throw markerError; }
        fs.mkdirSync(reclaim); reclaiming = true;
        // Inspect only after claiming cleanup. Another saver may have replaced
        // the abandoned lock while this process was waiting for cleanup.
        if (Date.now() - fs.statSync(lock).mtimeMs > 10000) { fs.unlinkSync(lock); continue; }
      } catch (lockError) { if (lockError.code === 'ENOENT') continue; if (lockError.code !== 'EEXIST') throw lockError; }
      finally { if (reclaiming) { try { fs.rmdirSync(reclaim); } catch (error) { if (error.code !== 'ENOENT') throw error; } } }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  if (fd === undefined) throw Error('settings_lock_busy');
  const temporary = target + '.' + process.pid + '.tmp';
  try {
    let current = {}, recovered = false;
    try { current = JSON.parse(fs.readFileSync(target, 'utf8')); }
    catch (error) { if (error instanceof SyntaxError) recovered = true; else if (error.code !== 'ENOENT') throw error; }
    if (!current || typeof current !== 'object' || Array.isArray(current)) recovered = true;
    if (recovered) current = { keepRoutingOn: false, authBlocked: true, routingEligible: false, usageReporting: 'off' };
    const merged = { ...current, ...patch, v: 1 };
    if (recovered && patch.usageReporting !== 'on') merged.usageReporting = 'off';
    delete merged.subagentRouting; // session-only: never saved
    fs.writeFileSync(temporary, JSON.stringify(merged, null, 1) + '\\n', { mode: 0o600 });
    fs.renameSync(temporary, target);
    process.stdout.write(JSON.stringify(Object.fromEntries(['keepRoutingOn', 'authBlocked', 'routingEligible', 'usageReporting'].filter(key => Object.hasOwn(merged, key)).map(key => [key, merged[key]]))));
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) {}
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
})().catch(() => { process.exitCode = 1; });
`

export async function writeTrustedSettings(access, text, patch) {
  const home = await trustedSettingsHome(access)
  if (!home) throw new Error('settings_home_untrusted')
  const changes = patch === undefined ? JSON.parse(text) : patch
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('settings_patch_invalid')
  const target = pathIn(home, '.claude/iq/settings.json')

  const candidates = /^[A-Za-z]:[\\/]/.test(home)
    ? [home.slice(0, 2) + '\\Program Files\\nodejs\\node.exe']
    : ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']
  if (typeof access.run === 'function') for (const executable of candidates) {
    try {
      const result = await access.run([executable, '-e', SETTINGS_TRANSACTION, target, JSON.stringify(changes)], { timeoutMs: 5000, env: { NODE_OPTIONS: '', NODE_PATH: '' } })
      if (result?.exitCode === 0) return JSON.parse(result.stdout || '{}')
      break
    } catch (error) {
      if (error?.code === 'ENOENT' || /\bENOENT\b/.test(String(error?.message))) continue
      break
    }
  }



  const exists = await access.exists(target)
  if (exists !== true && exists !== false) throw new Error('settings_read_unavailable')
  let current = {}, recovered = false
  if (exists) {
    const stored = await access.read(target)
    try { current = JSON.parse(stored) }
    catch (error) { if (error instanceof SyntaxError) recovered = true; else throw error }
    if (!current || typeof current !== 'object' || Array.isArray(current)) recovered = true
  }


  if (recovered) current = { keepRoutingOn: false, authBlocked: true, routingEligible: false, usageReporting: 'off' }
  const merged = { ...current, ...changes, v: 1 }
  if (recovered && changes.usageReporting !== 'on') merged.usageReporting = 'off'
  delete merged.subagentRouting
  await access.write(target, JSON.stringify(merged, null, 1) + '\n')
  return Object.fromEntries(['keepRoutingOn', 'authBlocked', 'routingEligible', 'usageReporting'].filter(key => Object.hasOwn(merged, key)).map(key => [key, merged[key]]))
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
