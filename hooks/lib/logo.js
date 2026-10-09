



export const MAX_FPS = 10 
export const MAX_SVG_FPS = 8 
export const TEXT_MARK = 'IQ' 

const isNum = (x) => typeof x === 'number' && Number.isFinite(x)
const B64 = /^[A-Za-z0-9+/]+={0,2}$/

function bytesOf(b64) {
  if (typeof b64 !== 'string' || b64.length === 0 || b64.length % 4 !== 0 || !B64.test(b64)) return -1
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return (b64.length / 4) * 3 - pad
}

function goodSize(s) {
  if (!s || typeof s !== 'object' || !Number.isInteger(s.columns) || !Number.isInteger(s.rows)) return false
  if (s.columns < 1 || s.columns > 512 || s.rows < 1 || s.rows > 256) return false
  const want = s.columns * s.rows * 12
  if (!Array.isArray(s.frames) || s.frames.length < 1 || s.frames.length > 64) return false
  return s.frames.every((f) => bytesOf(f) === want) && bytesOf(s.rest) === want
}

const goodSvg = (x) => typeof x === 'string' && x.startsWith('<svg ') && x.length <= 131072 && !/<script|\son[a-z]+\s*=|javascript:/i.test(x)


export function parseFrames(text) {
  let d
  try {
    d = JSON.parse(text)
  } catch (_) {
    return null
  }
  if (!d || typeof d !== 'object' || d.v !== 1 || !isNum(d.fps) || d.fps <= 0) return null
  if (!goodSize(d.sm) || !goodSize(d.lg)) return null
  if (!d.svg || !goodSvg(d.svg.rest) || !goodSvg(d.svg.anim)) return null
  if (d.svg.frames !== undefined && (!Array.isArray(d.svg.frames) || d.svg.frames.length < 8 || d.svg.frames.length > 12 ||
    !isNum(d.svg.fps) || d.svg.fps <= 0 || !d.svg.frames.every((f) => goodSvg(f) && !/<animate|<set\b|<style\b/i.test(f)))) return null
  return d
}


export function frameMs(d) {
  const fps = d && isNum(d.fps) && d.fps > 0 ? Math.min(d.fps, MAX_FPS) : MAX_FPS
  return Math.ceil(1000 / fps)
}


export function frameAt(d, size, i) {
  const s = d && d[size]
  if (!s || !Array.isArray(s.frames) || s.frames.length === 0) return null
  const cells = i < 0 ? s.rest : s.frames[((i % s.frames.length) + s.frames.length) % s.frames.length]
  return typeof cells === 'string' ? { columns: s.columns, rows: s.rows, cells } : null
}


export function svgFrameAt(d, i) {
  const s = d && d.svg
  if (!s) return null
  if (i < 0 || !Array.isArray(s.frames) || s.frames.length === 0) return s.rest
  return s.frames[((i % s.frames.length) + s.frames.length) % s.frames.length]
}

export function svgFrameMs(d) {
  const fps = d && d.svg && isNum(d.svg.fps) && d.svg.fps > 0 ? Math.min(d.svg.fps, MAX_SVG_FPS) : MAX_SVG_FPS
  return Math.ceil(1000 / fps)
}
