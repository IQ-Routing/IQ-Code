



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


export function errText(err) {
  let m = ''
  try {
    m = err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err)
  } catch (_) {
    m = 'unprintable error'
  }
  return m.replace(/\s+/g, ' ').slice(0, 200)
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
