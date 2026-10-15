import { newMeasuredLedger, addMeasured, measuredSnapshot } from './measured_cost.js'























export const COLD_GAP_MS = 3600 * 1000
export const HELPER_STALE_MS = 30 * 60 * 1000
export const ACTIVE_GAP_MS = 600 * 1000
export const PENDING_STALE_MS = 2 * 3600 * 1000
export const PROMPT_HISTORY_CAP = 20
const KEEP_RECENT = PROMPT_HISTORY_CAP
const MAX_INFLIGHT = 200
const MAX_HELPERS = 400



const HUMAN_KINDS = new Set(['composer', 'bridge', 'sdk'])
export const isHumanKind = (kind) => HUMAN_KINDS.has(kind)

export function newTracker() {
  return {
    
    usd: 0, 
    measured: newMeasuredLedger(),
    measuredStartMs: null,
    ownUsd: 0, 
    calls: 0,
    mainCalls: 0,
    helperCalls: 0,
    helperUsd: 0,
    unpriced: 0, 
    ownUnpriced: 0, 
    advisorUnpriced: 0, 
    activeMs: 0,
    lastCallMs: null,
    humanPrompts: 0, 
    boot: null, 
    
    lastMainEndMs: null,
    lastMainCtx: null,
    lastMainModel: null,
    lastMainModelClass: null,
    lastMainEffortClass: null,
    historyKnown: false, 
    resumed: false, 
    
    helpers: new Map(),
    subagentTotals: new Map(), 
    omittedSubagents: false,
    
    segCount: 0,
    cur: null,
    recent: [],
    pending: null, 
    inflight: new Map(),
    turnOpen: false,
  }
}

function newSegment(idx, nowMs, human) {
  return {
    idx,
    human,
    startMs: nowMs,
    k: 0,
    usd: 0,
    measured: newMeasuredLedger(),
    ownUsd: 0, 
    unpriced: 0,
    advisorUnpriced: 0,
    mainCalls: 0,
    helperCalls: 0,
    helperUsd: 0,
    lastEstimate: null, 
    completed: false,
    usageIncomplete: false,
    ctx: null, 
    mainModel: null,
    mainModelClass: null,
    mainEffortClass: null,
    anyModelClass: null,
    helperModelClass: null,
    helperEffortClass: null,
    pred0: null,
    ctx0: null,
    cold0: undefined,
    state0: null,
    pend: null, 
    turns: 0,
    turnsDone: 0,
    helpersMax: 0,
    dirty: false,
    lastAborted: false,
    lastDurationMs: 0,
    rowsWritten: 0,
  }
}


export function aliveHelpers(T, nowMs) {
  let n = 0
  for (const h of T.helpers.values()) if (!h.done && nowMs - h.lastMs <= HELPER_STALE_MS) n += 1
  return n
}


export function coldFlag(T, nowMs) {
  if (T.lastMainEndMs !== null) return nowMs - T.lastMainEndMs > COLD_GAP_MS
  if (T.historyKnown) return undefined
  return true 
}







export function noteSubmit(T, a) {
  if (!isHumanKind(a.kind)) return null
  const pend = { ms: a.nowMs, chars: a.chars, state0: null, pred0: null, filled: false }
  T.pending = pend
  return pend
}



export function fillSubmit(T, pend, a) {
  if (!pend || pend.filled) return false
  pend.filled = true
  pend.state0 = a.state0 || null
  pend.pred0 = a.pred0 || null
  const segs = T.cur ? T.recent.concat([T.cur]) : T.recent
  for (const seg of segs) {
    if (seg.pend !== pend) continue
    seg.pred0 = pend.pred0
    seg.state0 = pend.state0
    seg.ctx0 = pend.state0 && pend.state0.ctx_tokens !== undefined ? pend.state0.ctx_tokens : null
    seg.cold0 = pend.state0 ? pend.state0.cold_start : undefined
    if (pend.state0 && !seg.mainModelClass) seg.mainModelClass = pend.state0.model_class || null
    if (pend.state0 && !seg.mainEffortClass) seg.mainEffortClass = pend.state0.effort_class || null
  }
  return true
}


export function dropPending(T, pend) {
  if (pend === undefined || T.pending === pend) T.pending = null
}

function closeSegment(T, seg) {
  T.recent.push(seg)
  if (T.recent.length > KEEP_RECENT) T.recent.shift()
}

function startSegment(T, nowMs, pending) {
  if (T.cur) closeSegment(T, T.cur)
  const human = pending !== null
  if (human) T.humanPrompts += 1
  T.segCount += 1
  const seg = newSegment(human ? T.humanPrompts : 0, nowMs, human)
  if (pending) {
    seg.pend = pending
    seg.pred0 = pending.pred0 || null
    seg.state0 = pending.state0 || null
    seg.ctx0 = pending.state0 && pending.state0.ctx_tokens !== undefined ? pending.state0.ctx_tokens : null
    seg.cold0 = pending.state0 ? pending.state0.cold_start : undefined
    seg.mainModelClass = pending.state0 ? pending.state0.model_class || null : null
    seg.mainEffortClass = pending.state0 ? pending.state0.effort_class || null : null
  }
  T.cur = seg
  return seg
}


function bindPending(T, nowMs) {
  const p = T.pending
  if (p === null) return false
  T.pending = null
  if (nowMs - p.ms > PENDING_STALE_MS) return false
  startSegment(T, nowMs, p)
  return true
}


export function onTurnStart(T, a) {
  let isNew = bindPending(T, a.nowMs)
  if (T.cur === null) {
    startSegment(T, a.nowMs, null)
    isNew = true
  }
  T.cur.turns += 1
  T.cur.completed = false
  T.turnOpen = true
  return { seg: T.cur, isNew }
}


function pruneHelpers(T, nowMs) {
  for (const [id, h] of T.helpers) {
    if (h.done || nowMs - h.lastMs > HELPER_STALE_MS) T.helpers.delete(id)
  }
}


export function onStepStart(T, a) {
  T.inflight.set(a.key, { agentId: a.agentId || null, ms: a.nowMs })
  if (T.inflight.size > MAX_INFLIGHT) T.inflight.delete(T.inflight.keys().next().value) 
  if (a.agentId) {
    let h = T.helpers.get(a.agentId)
    if (!h) {
      if (T.helpers.size >= MAX_HELPERS) pruneHelpers(T, a.nowMs)
      h = { home: T.cur ? T.cur.idx : 0, homeSeg: T.cur, firstMs: a.nowMs, lastMs: a.nowMs, done: false }
      T.helpers.set(a.agentId, h)
    } else {
      h.done = false
      h.lastMs = a.nowMs
    }
    if (T.cur) T.cur.helpersMax = Math.max(T.cur.helpersMax, aliveHelpers(T, a.nowMs))
    return
  }
  bindPending(T, a.nowMs)
  if (T.cur === null) startSegment(T, a.nowMs, null)
  const seg = T.cur
  T.turnOpen = true
  seg.completed = false
  
  if (a.model) {
    seg.mainModel = a.model
    seg.mainModelClass = a.modelClass || seg.mainModelClass
    T.lastMainModel = a.model
    T.lastMainModelClass = a.modelClass || T.lastMainModelClass
  }
  if (a.effort !== undefined && a.effort !== null) {
    const ec = a.effortClass || 'unknown'
    seg.mainEffortClass = ec
    T.lastMainEffortClass = ec
  }
}





export function onStepEnd(T, a) {
  T.inflight.delete(a.key)
  if (a.agentId) {
    const h = T.helpers.get(a.agentId)
    if (h) h.lastMs = a.nowMs
  }
  if (!a.hasUsage || !a.price) return { counted: false, seg: T.cur }
  let seg
  if (a.agentId) {
    const h = T.helpers.get(a.agentId)
    seg = (h && h.homeSeg) || T.cur
  } else seg = T.cur
  if (seg === null) seg = startSegment(T, a.nowMs, null)
  if (a.measured) {
    addMeasured(T.measured, a.measured)
    addMeasured(seg.measured, a.measured)
    if (T.measuredStartMs === null) T.measuredStartMs = a.nowMs
  }
  seg.k += 1
  if (a.usageComplete === false) seg.usageIncomplete = true
  
  
  const dollars = Number.isFinite(a.price.usd) ? a.price.usd : 0
  const own = Number.isFinite(a.price.own) ? a.price.own : dollars 
  const partial = !a.price.priced || a.price.partial === true
  const advisor = Number.isInteger(a.price.advisor) && a.price.advisor > 0 ? a.price.advisor : 0 
  seg.usd += dollars
  seg.ownUsd += own
  seg.advisorUnpriced += advisor
  if (partial) seg.unpriced += 1
  seg.ctx = a.price.context
  seg.anyModelClass = a.modelClass || seg.anyModelClass
  seg.dirty = true
  if (a.agentId) {
    seg.helperCalls += 1
    seg.helperUsd += dollars
    T.helperUsd += dollars
    let total = T.subagentTotals.get(a.agentId)
    if (!total) {
      if (T.subagentTotals.size >= MAX_HELPERS) {
        T.subagentTotals.delete(T.subagentTotals.keys().next().value)
        T.omittedSubagents = true
      }
      total = { id: a.agentId, usd: 0, calls: 0, unpriced: 0 }
      T.subagentTotals.set(a.agentId, total)
    }
    total.usd += dollars
    total.calls += 1
    if (partial) total.unpriced += 1
    seg.helperModelClass = a.modelClass || seg.helperModelClass
    if (a.effort !== undefined && a.effort !== null) seg.helperEffortClass = a.effortClass || 'unknown'
    T.helperCalls += 1
  } else {
    seg.mainCalls += 1
    seg.mainModel = a.model || seg.mainModel
    seg.mainModelClass = a.modelClass || seg.mainModelClass
    if (a.effort !== undefined && a.effort !== null) seg.mainEffortClass = a.effortClass || 'unknown'
    T.lastMainEndMs = a.nowMs
    T.lastMainCtx = Number.isFinite(a.mainCtx) ? a.mainCtx : a.price.context
    T.lastMainModel = a.model || T.lastMainModel
    T.lastMainModelClass = a.modelClass || T.lastMainModelClass
    if (a.effort !== undefined && a.effort !== null) T.lastMainEffortClass = a.effortClass || 'unknown'
    T.mainCalls += 1
  }
  
  T.calls += 1
  T.usd += dollars
  T.ownUsd += own
  T.advisorUnpriced += advisor
  if (partial) T.unpriced += 1
  if (!a.price.priced) T.ownUnpriced += 1
  if (T.lastCallMs !== null && a.nowMs - T.lastCallMs <= ACTIVE_GAP_MS) T.activeMs += Math.max(a.nowMs - T.lastCallMs, 0)
  T.lastCallMs = a.nowMs
  return { counted: true, seg }
}



export const forecastSpend = (T) => (Number.isFinite(T.ownUsd) ? T.ownUsd : T.usd)
export const forecastUnpriced = (T) => (Number.isFinite(T.ownUnpriced) ? T.ownUnpriced : T.unpriced)


export function onTurnComplete(T, a) {
  if (a.agentId) {
    const h = T.helpers.get(a.agentId)
    if (h) {
      h.done = true
      h.lastMs = a.nowMs
    }
    return { isMain: false, seg: null }
  }
  T.turnOpen = false
  const seg = T.cur
  if (seg) {
    seg.completed = true
    seg.turnsDone += 1
    seg.lastAborted = !!a.isAborted
    seg.lastDurationMs = Number(a.durationMs) || 0
    seg.dirty = true
  }
  return { isMain: true, seg }
}



export function sessionMeter(meter, T) {
  const row = (s) => ({ idx: s.idx, at_ms: s.startMs, usd: s.measured.calls > 0 ? s.measured.paid_usd : s.usd, calls: s.k,
    helper_usd: s.helperUsd, helper_calls: s.helperCalls, unpriced: s.unpriced, advisorUnpriced: s.advisorUnpriced,
    completed: s.completed, estimate: s.lastEstimate ? { ...s.lastEstimate } : null })
  const prompts = (T.cur ? T.recent.concat([T.cur]) : T.recent).filter((s) => s.human).slice(-PROMPT_HISTORY_CAP).reverse().map(row)
  const last = !T.turnOpen && !T.pending && T.cur && T.cur.human && T.cur.completed ? row(T.cur) : null
  return { ...meter, prompt: meter.prompt ? { ...meter.prompt, measured: T.cur ? measuredSnapshot(T.cur.measured) : null,
    spend_usd: T.cur?.measured.calls > 0 ? T.cur.measured.paid_usd : meter.prompt.spend_usd, helper_usd: T.cur ? T.cur.helperUsd : 0,
    helper_calls: T.cur ? T.cur.helperCalls : 0, unpriced: T.cur ? T.cur.unpriced : 0, advisorUnpriced: T.cur ? T.cur.advisorUnpriced : 0 } : null,
    
    
    
    session: { ...meter.session, usd: T.measured.calls > 0 ? T.measured.paid_usd : meter.session?.usd, prompts, last_prompt: last, measured: T.measured.calls > 0 ? { ...measuredSnapshot(T.measured), started_at_ms: T.measuredStartMs, elapsed_ms: T.activeMs, paid_complete: T.measured.paid_complete && !(T.resumed && !T.boot),
      rows: (T.cur ? T.recent.concat([T.cur]) : T.recent).filter((s) => s.measured.calls > 0).slice(-PROMPT_HISTORY_CAP).reverse()
        .map((s) => ({ idx: s.idx, at_ms: s.startMs, completed: s.completed, ...measuredSnapshot(s.measured) })) } : null, unpriced: T.unpriced, advisorUnpriced: T.advisorUnpriced, resumed: T.resumed === true && !T.boot,
      subagents: [...T.subagentTotals.values()].map((s) => ({ ...s })), omitted_subagents: T.omittedSubagents } }
}








export function applyBootstrap(T, boot) {
  if (!boot || T.boot) return false
  T.boot = boot
  T.historyKnown = true
  addMeasured(T.measured, { paid_usd: Number(boot.usd) || 0, baseline_usd: null, saved_usd: null, rebuild_debit_usd: null,
    model: 'mixed', effort: null, named_model: null, named_effort: null, usage: {}, complete: false,
    paid_complete: !(Number(boot.unpriced) > 0), missing: ['historical_baseline'], skipped: true })
  T.usd += Number(boot.usd) || 0
  T.ownUsd += Number(boot.usd) || 0
  T.calls += Number(boot.calls) || 0
  T.mainCalls += Number(boot.mainCalls) || 0
  T.helperCalls += Number(boot.helperCalls) || 0
  T.unpriced += Number(boot.unpriced) || 0
  T.ownUnpriced += Number(boot.unpriced) || 0
  T.activeMs += Number(boot.activeMs) || 0
  if (typeof boot.lastMainEndMs === 'number' && (T.lastMainEndMs === null || boot.lastMainEndMs > T.lastMainEndMs)) T.lastMainEndMs = boot.lastMainEndMs
  if (T.lastMainCtx === null && typeof boot.lastMainCtx === 'number') T.lastMainCtx = boot.lastMainCtx
  if (T.lastMainModel === null && boot.lastMainModel) T.lastMainModel = boot.lastMainModel
  if (T.lastMainModelClass === null && boot.lastMainModelClass) T.lastMainModelClass = boot.lastMainModelClass
  if (T.lastMainEffortClass === null && boot.lastMainEffortClass) T.lastMainEffortClass = boot.lastMainEffortClass
  return true
}


export function dirtySegments(T) {
  const out = []
  for (const s of T.recent) if (s.dirty) out.push(s)
  if (T.cur && T.cur.dirty) out.push(T.cur)
  return out
}
