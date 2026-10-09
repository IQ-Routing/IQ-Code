
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

export function validKey(text) {
  const key = typeof text === 'string' ? text.trim() : ''
  return key.length > 0 && key.length <= 4096 && /^[A-Za-z0-9._~+\/-]+=*$/.test(key) ? key : null
}

export async function readKey(access) {
  try {
    const configured = access.configured ? await access.configured() : undefined
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
    if ((await access.nonessential()) !== undefined) return true
    if (truthy(await access.disabled())) return true
    const home = await access.home()
    if (!home) return true
    
    return (await access.exists(pathIn(home, '.claude/iq/router/OFF'))) !== false
  } catch (_) { return true }
}
