

function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value : undefined }
export function usageNumbers(u) {
  if (!u || typeof u !== 'object') return null
  const out = {}
  if (u.speed === 'fast' || u.speed === 'standard') out.speed = u.speed
  for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'thinking_tokens', 'reasoning_tokens']) out[key] = count(u[key])
  if (u.cache_creation && typeof u.cache_creation === 'object') out.cache_creation = {
    ephemeral_5m_input_tokens: count(u.cache_creation.ephemeral_5m_input_tokens),
    ephemeral_1h_input_tokens: count(u.cache_creation.ephemeral_1h_input_tokens),
  }
  if (u.output_tokens_details && typeof u.output_tokens_details === 'object') out.output_tokens_details = {
    thinking_tokens: count(u.output_tokens_details.thinking_tokens), reasoning_tokens: count(u.output_tokens_details.reasoning_tokens),
  }
  if (Array.isArray(u.iterations)) out.iterations = u.iterations.map(p => ({ ...usageNumbers(p),
    type: typeof p?.type === 'string' ? p.type : null, model: typeof p?.model === 'string' ? p.model : null }))
  return out
}

export const TRANSCRIPT_USAGE_MAX_BYTES = 32 * 1024 * 1024

function usageReadLimit(maxBytes) {
  return Number.isSafeInteger(maxBytes) && maxBytes > 0 ? Math.min(maxBytes, 32 * 1024 * 1024) : 32 * 1024 * 1024
}


function usageByteLength(text, limit) {
  if (text.length > limit) return limit + 1
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const n = text.charCodeAt(i)
    if (n < 0x80) bytes += 1
    else if (n < 0x800) bytes += 2
    else if (n >= 0xd800 && n <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i += 1 }
    else bytes += 3
    if (bytes > limit) return bytes
  }
  return bytes
}

function usageSkipped(reason, bytesRead = 0) {
  return { calls: [], duplicates: 0, malformed: 0, issues: [{ kind: reason, ms: null }],
    bytesRead, skipped: true, reason }
}



function usageHeaderMs(line) {
  const match = /(?:^|[,{])\s*"timestamp"\s*:\s*"([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+-]+Z?)"/.exec(line)
  const ms = match ? Date.parse(match[1]) : NaN
  return Number.isFinite(ms) ? ms : null
}

export function transcriptUsage(text, { source = null, sinceMs = null, maxBytes } = {}) {
  const limit = usageReadLimit(maxBytes)
  if (typeof text !== 'string') return usageSkipped('transcript_unavailable')
  const bytesRead = usageByteLength(text, limit)
  if (bytesRead > limit) return usageSkipped('transcript_over_cap')
  const calls = new Map(), issues = [], pending = []
  let seq = 0, duplicates = 0, beforeMs = null, sourceStartMs = null, firstRecordSeen = false, lineNumber = 0, lastMain = null
  for (const line of text.split('\n')) {
    lineNumber += 1
    if (!firstRecordSeen && /\S/.test(line)) {
      firstRecordSeen = true
      sourceStartMs = usageHeaderMs(line)
    }

    if (!line.includes('"usage"')) continue
    let r
    try { r = JSON.parse(line) } catch (_) {
      const issue = { kind: 'malformed_usage', ms: usageHeaderMs(line), beforeMs, afterMs: null, line: lineNumber }
      issues.push(issue); pending.push(issue)
      continue
    }
    if (r?.type !== 'assistant' || r.isApiErrorMessage || r.message?.model === '<synthetic>') continue
    const m = r.message, usage = usageNumbers(m?.usage)
    if (!usage) continue
    const stamp = Date.parse(r.timestamp), ms = Number.isFinite(stamp) ? stamp : null
    if (!r.isSidechain && !r.agentId && !r.agent_id) lastMain = { speed: usage.speed ?? null, model: typeof m.model === 'string' ? m.model : null, ms }
    if (ms !== null) {
      if (sourceStartMs === null) sourceStartMs = ms
      beforeMs = ms
      for (const issue of pending) issue.afterMs = ms
      pending.length = 0
    }
    const id = [m.id, r.requestId, r.uuid].find(value => typeof value === 'string' && value !== '') ||
      (source || 'transcript') + ':record-' + (++seq)
    const prior = calls.get(id)
    if (prior) duplicates += 1

    calls.set(id, { messageId: id, sourcePath: source,
      model: typeof m.model === 'string' ? m.model : prior?.model ?? null,
      effort: typeof r.effort === 'string' || Number.isFinite(r.effort) ? r.effort : prior?.effort ?? null,
      ms: prior?.ms ?? ms, usage })
  }
  const resuming = Number.isFinite(sinceMs) && sinceMs > 0



  const keptIssues = issues.filter(issue => !resuming || (Number.isFinite(issue.ms)
    ? issue.ms >= sinceMs : Number.isFinite(issue.beforeMs) && issue.beforeMs >= sinceMs))
  return { calls: [...calls.values()].filter(call => !resuming || Number.isFinite(call.ms) && call.ms >= sinceMs)
    .map(call => ({ ...call, sourceStartMs })),
    duplicates, malformed: keptIssues.length, issues: keptIssues, bytesRead, skipped: false, reason: null, lastMain }
}

export const TRANSCRIPT_USAGE_READ_BYTES = 8 * 1024 * 1024

function incrementalReadLimit(maxBytes) {
  return Number.isSafeInteger(maxBytes) && maxBytes > 0 ? Math.min(maxBytes, 8 * 1024 * 1024) : 8 * 1024 * 1024
}



function readUsageIncrement(target, options, fs, bytes) {
  const limit = incrementalReadLimit(options.maxBytes)
  let fd, bytesRead = 0
  try {
    fd = fs.openSync(target, 'r')
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) throw Error('not_file')
    const old = options.cursor
    const reset = !!old && (old.dev !== stat.dev || old.ino !== stat.ino || stat.size < old.size)
    const continuing = !!old && !reset
    const base = continuing ? old.scanOffset ?? old.offset : 0
    const overflow = stat.size - base > limit
    const tail = !options.helper && overflow && (!old || continuing && !old.catchingUp)
    const start = tail ? stat.size - limit : base
    const end = Math.min(stat.size, start + limit), chunks = []
    while (start + bytesRead < end) {
      const chunk = bytes.allocUnsafe(Math.min(64 * 1024, end - start - bytesRead))
      const n = fs.readSync(fd, chunk, 0, chunk.length, start + bytesRead)
      if (!n) break
      chunks.push(chunk.subarray(0, n)); bytesRead += n
    }
    const data = bytes.concat(chunks, bytesRead)
    const skipHead = tail || continuing && old.discarding
    const firstBreak = data.indexOf(10), lastBreak = data.lastIndexOf(10)
    const begin = skipHead ? firstBreak < 0 ? data.length : firstBreak + 1 : 0
    const completeEnd = lastBreak >= begin ? lastBreak + 1 : begin
    const text = data.subarray(begin, completeEnd).toString('utf8')
    const previousMs = continuing ? old.lastMs : null
    const read = transcriptUsage(text, { source: target, maxBytes: limit })
    let sourceStartMs = continuing ? old.sourceStartMs : null
    if (sourceStartMs === null || sourceStartMs === undefined) sourceStartMs = read.calls[0]?.sourceStartMs ?? usageHeaderMs(text)
    const stamps = read.calls.map(call => call.ms).filter(Number.isFinite)
    const firstMs = stamps.length ? stamps[0] : null
    const lastMs = stamps.length ? stamps[stamps.length - 1] : previousMs
    for (const issue of read.issues) {
      if (!Number.isFinite(issue.beforeMs)) issue.beforeMs = previousMs
      issue.offset = start + begin
      issue.observedAtMs = Number.isFinite(options.asOfMs) ? options.asOfMs : null
    }
    let pendingGap = continuing ? old.pendingGap || null : null
    if (tail && continuing && !pendingGap) pendingGap = { kind: 'transcript_gap', ms: null,
      beforeMs: previousMs, afterMs: null, offset: base,
      observedAtMs: Number.isFinite(options.asOfMs) ? options.asOfMs : null }
    if (pendingGap) {
      pendingGap = { ...pendingGap, afterMs: firstMs }
      read.issues.push(pendingGap)
      if (Number.isFinite(firstMs)) pendingGap = null
    }


    if (tail && !old) read.issues.push({ kind: 'transcript_history', history: true,
      ms: null, beforeMs: null, afterMs: firstMs, offset: 0 })
    let offset = continuing ? old.offset : 0
    if (lastBreak >= 0) offset = start + lastBreak + 1
    const noCompleteBoundary = lastBreak < 0 && bytesRead >= limit
    const discarding = noCompleteBoundary || skipHead && firstBreak < 0
    const scanOffset = discarding ? start + bytesRead : offset
    return { ...read, bytesRead, reset, cursor: { path: target, dev: stat.dev, ino: stat.ino, size: stat.size,
      offset, scanOffset, discarding, catchingUp: !tail && end < stat.size,
      sourceStartMs: sourceStartMs ?? null, lastMs: lastMs ?? null, pendingGap,
      lastMain: read.lastMain ?? (continuing ? old.lastMain ?? null : null) } }
  } catch (_) { return usageSkipped('transcript_unavailable', bytesRead) }
  finally { if (fd !== undefined) fs.closeSync(fd) }
}



function readUsageFile(target, options, fs, bytes) {
  if (!options.helper) return readUsageIncrement(target, options, fs, bytes)
  const deadline = Date.now() + 1500, calls = new Map(), issues = []
  let cursor = options.cursor, last, bytesRead = 0, duplicates = 0, reset = false
  do {
    const read = readUsageIncrement(target, { ...options, cursor }, fs, bytes)
    if (read.skipped) {
      if (!last) return read
      issues.push(...read.issues)
      break
    }
    bytesRead += read.bytesRead; duplicates += read.duplicates; reset ||= read.reset
    for (const call of read.calls) {
      if (calls.has(call.messageId)) duplicates += 1
      calls.set(call.messageId, call)
    }
    issues.push(...read.issues)
    last = read
    const progressed = (read.cursor.scanOffset ?? read.cursor.offset) > (cursor?.scanOffset ?? cursor?.offset ?? -1)
    cursor = read.cursor
    if (cursor.discarding || cursor.catchingUp && (!progressed || Date.now() >= deadline)) {
      issues.push({ kind: 'transcript_gap', ms: null, beforeMs: cursor.lastMs,
        afterMs: null, observedAtMs: options.asOfMs, offset: cursor.offset })
      break
    }
  } while (cursor.catchingUp)
  return { ...last, calls: [...calls.values()], issues, duplicates, bytesRead, reset }
}



const TRANSCRIPT_READ = [count, usageNumbers, usageReadLimit, usageByteLength, usageSkipped, usageHeaderMs,
  transcriptUsage, incrementalReadLimit, readUsageIncrement, readUsageFile].map(fn => fn.toString()).join('\n') + `
process.stdout.write(JSON.stringify(readUsageFile(process.argv[1], JSON.parse(process.argv[2]), require('node:fs'), Buffer)));
`

export async function readTranscriptUsage(access, path, { sinceMs = null, asOfMs = null, maxBytes, state = null, helper = false } = {}) {
  const prior = state?.path === path ? state : null
  const unavailable = (reason = 'transcript_unavailable') => ({ ...usageSkipped(reason), calls: prior?.calls || [], state: prior })
  if (typeof access?.run !== 'function' || typeof path !== 'string' || !path.endsWith('.jsonl')) return unavailable()
  const runtime = globalThis.process
  const fixed = /^[A-Za-z]:[\\/]/.test(path)
    ? [path.slice(0, 2) + '\\Program Files\\nodejs\\node.exe']
    : ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']
  const candidates = [...new Set(fixed.concat(runtime?.release?.name === 'node' && typeof runtime.execPath === 'string'
    ? [runtime.execPath, 'node'] : ['node']))]
  const cursor = prior ? Object.fromEntries(['path', 'dev', 'ino', 'size', 'offset', 'scanOffset', 'discarding',
    'catchingUp', 'sourceStartMs', 'lastMs', 'pendingGap', 'lastMain'].map(key => [key, prior[key]])) : null
  let readerRan = false
  for (const executable of candidates) {
    try {
      const result = await access.run([executable, '-e', TRANSCRIPT_READ, path,
        JSON.stringify({ maxBytes: incrementalReadLimit(maxBytes), cursor, asOfMs, helper })],
      { timeoutMs: 2000, env: { NODE_OPTIONS: '', NODE_PATH: '' } })

      if (result?.timedOut || result?.signal === 'SIGTERM' || result?.signal === 'SIGKILL') { readerRan = true; break }
      if (result?.exitCode !== 0) continue
      const projected = JSON.parse(result.stdout || '{}')
      if (!Array.isArray(projected.calls) || !Array.isArray(projected.issues)) continue
      readerRan = true
      if (!projected.cursor) continue
      const calls = new Map((prior?.calls || []).map(call => [call.messageId, call]))
      let duplicates = projected.duplicates || 0
      const resuming = Number.isFinite(sinceMs) && sinceMs > 0
      for (const call of projected.calls) {
        if (resuming && (!Number.isFinite(call.ms) || call.ms < sinceMs)) continue
        const previous = calls.get(call.messageId)
        if (previous) duplicates += 1
        calls.set(call.messageId, { ...call, ms: previous?.ms ?? call.ms,
          sourceStartMs: projected.cursor.sourceStartMs })
      }
      const nextMs = projected.calls.map(call => call.ms).find(Number.isFinite)
      const issues = new Map((prior?.issues || []).map(issue => {
        const resolved = issue.kind === 'malformed_usage' && !Number.isFinite(issue.afterMs) && Number.isFinite(nextMs)
          ? { ...issue, afterMs: nextMs } : issue
        return [issue.kind + ':' + issue.offset + ':' + (issue.line || 0), resolved]
      }))
      for (const issue of projected.issues) {
        const beforeResume = Number.isFinite(issue.ms) ? issue.ms < sinceMs :
          issue.kind === 'transcript_gap' && Number.isFinite(issue.observedAtMs)
            ? issue.observedAtMs < sinceMs || Number.isFinite(issue.afterMs) && issue.afterMs <= sinceMs
            : !Number.isFinite(issue.beforeMs) || issue.beforeMs < sinceMs
        if (resuming && !issue.history && beforeResume) continue
        issues.set(issue.kind + ':' + issue.offset + ':' + (issue.line || 0), issue)
      }
      const next = { ...projected.cursor, lastMain: projected.lastMain ?? projected.cursor.lastMain ?? (projected.reset ? null : prior?.lastMain ?? null),
        calls: [...calls.values()], issues: [...issues.values()] }
      return { calls: next.calls, duplicates, malformed: next.issues.filter(issue => issue.kind === 'malformed_usage').length,
        issues: next.issues, bytesRead: projected.bytesRead, skipped: false, reason: null, reset: projected.reset, state: next, lastMain: next.lastMain }
    } catch (error) {
      if (error?.killed || error?.code === 'ETIMEDOUT' || /time[ -]?out|timed out/i.test(String(error?.message))) { readerRan = true; break }

    }
  }
  return unavailable(readerRan ? 'transcript_unavailable' : 'reader_unavailable')
}
