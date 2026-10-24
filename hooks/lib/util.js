




export function bytesFromBase64(b64) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function hexOf(buf) {
  const u = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < u.length; i++) s += (u[i] < 16 ? '0' : '') + u[i].toString(16)
  return s
}


export async function sha256Hex(bytes) {
  return hexOf(await crypto.subtle.digest('SHA-256', bytes))
}

export function utf8(bytes) {
  return new TextDecoder().decode(bytes)
}

const two = (n) => (n < 10 ? '0' + n : String(n))


export function dayOf(ms) {
  const d = new Date(ms)
  return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate())
}

export function isoOf(ms) {
  return new Date(ms).toISOString()
}


export function tailLines(text, cap) {
  if (text.length <= cap) return text
  const cut = text.slice(text.length - cap)
  const nl = cut.indexOf('\n')
  return nl >= 0 ? cut.slice(nl + 1) : cut
}



export function mergeRows(text, rows) {
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n')
  for (const r of rows) {
    const s = JSON.stringify(r)
    if (r.t === 'seg' && lines.length > 0) {
      const last = lines[lines.length - 1]
      if (last.startsWith('{"v":1,"t":"seg"') && last.includes('"key":' + JSON.stringify(r.key))) {
        lines[lines.length - 1] = s
        continue
      }
    }
    lines.push(s)
  }
  return lines.join('\n') + '\n'
}




export function fileProjectionReader(project) {
  const entries = new Map(), noIdentity = new Set()
  const stamp = value => {
    if (!value || value.kind !== 'file' || value.isLink === true ||
        !Number.isFinite(value.mtimeMs) || !Number.isSafeInteger(value.size) || value.size < 0 ||
        !(typeof value.ino === 'string' && value.ino !== '' || Number.isSafeInteger(value.ino) && value.ino > 0)) return null
    return JSON.stringify([value.mtimeMs, value.size, value.ino, value.dev ?? null, value.ctimeMs ?? null, value.realPath ?? null])
  }
  const metadata = async (access, path) => {
    if (noIdentity.has(path) || typeof access.stat !== 'function') return null
    try {
      const info = await access.stat(path)
      if (info && info.kind === 'file' && info.ino === undefined) {
        noIdentity.add(path)
        if (noIdentity.size > 16) noIdentity.delete(noIdentity.values().next().value)
      }
      return stamp(info)
    } catch (_) { return null }
  }
  const read = async (access, path) => {
    const exists = await access.exists(path)
    if (exists !== true) {
      entries.delete(path)
      if (exists === false) return undefined
      throw new Error('file_read_unavailable')
    }
    const before = await metadata(access, path)
    const previous = entries.get(path)
    if (before !== null && previous?.stamp === before) return previous.value
    entries.delete(path)
    const value = project(await access.read(path))
    if (before !== null && before === await metadata(access, path)) {
      entries.set(path, { stamp: before, value })

      if (entries.size > 16) entries.delete(entries.keys().next().value)
    }
    return value
  }
  read.invalidate = path => { entries.delete(path); noIdentity.delete(path) }
  return read
}




export async function projectEnvNames(readSettings) {
  try {
    const names = new Set()
    for (const source of ['project', 'local']) {
      const settings = await readSettings(source)
      if (!settings || typeof settings !== 'object') return null
      for (const key of Object.keys(settings.env || {})) names.add(key.toUpperCase())
    }
    return names
  } catch (_) { return null }
}







const OPENSSL_LOADERS = ['OPENSSL_CONF', 'OPENSSL_CONF_INCLUDE', 'OPENSSL_MODULES', 'OPENSSL_ENGINES']
const LIBC_LOADERS = ['GCONV_PATH', 'LOCPATH', 'NLSPATH']

const OPENER_LOOKUP = ['BROWSER', 'XDG_DATA_HOME', 'XDG_DATA_DIRS', 'XDG_CONFIG_HOME', 'XDG_CONFIG_DIRS']
const loaderFamily = name => name.startsWith('DYLD_') || name.startsWith('LD_')



export const steersLaunch = name => loaderFamily(name) || OPENSSL_LOADERS.includes(name) ||
  LIBC_LOADERS.includes(name) || OPENER_LOOKUP.includes(name) || name === 'DEVELOPER_DIR' || name === '__PYVENV_LAUNCHER__'






export function steersProgram(names, program, blanked = {}) {
  if (names === null) return true
  const base = String(program).split(/[\\/]/).pop().toLowerCase()
  const python = /^(?:py|python[\d.]*)(?:\.exe)?$/.test(base)
  for (const name of names) {
    if (OPENSSL_LOADERS.includes(name) || LIBC_LOADERS.includes(name)) return true
    if (loaderFamily(name) && !Object.hasOwn(blanked, name)) return true
    if (python && name === '__PYVENV_LAUNCHER__') return true
    if (name === 'DEVELOPER_DIR' && program === '/usr/bin/python3') return true
  }
  return false
}




export function runningNode(runtime = globalThis.process) {
  const path = runtime?.release?.name === 'node' && typeof runtime.execPath === 'string' ? runtime.execPath : ''
  return /^[A-Za-z]:[\\/]/.test(path) && /^node(?:\.exe)?$/i.test(path.split(/[\\/]/).pop()) ? path : null
}
