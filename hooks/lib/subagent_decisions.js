
import { effortLabel } from './models.js'
import { isoOf } from './util.js'

const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:@/-]{1,128}$/.test(value) ? value : null
const choice = (value) => ({ model: id(value?.model), effort: effortLabel(value?.effort) })
export function subagentDecisionRow(a) {
  return { v: 1, t: 'dec', kind: 'subagent', ts: isoOf(a.nowMs), sid: id(a.sessionId), agent_id: id(a.agentId),
    subagent_type: id(a.subagentType), read_only: a.readOnly === true,
    parent: choice(a.parent), named: choice(a.named), chosen: choice(a.chosen || a.named),
    outcome: ['applied', 'kept', 'failed', 'paused', 'off'].includes(a.outcome) ? a.outcome : 'failed',
    reason: a.reason === 'subagents off' ? a.reason : id(a.reason), rated: a.rated === true,
    latency_ms: Number.isFinite(a.latencyMs) ? Math.max(0, a.latencyMs) : null }
}

export function rememberSubagentDecision(router, row) {
  if (!Array.isArray(router.subagentRecent)) router.subagentRecent = []
  router.subagentRecent.push(row)
  if (router.subagentRecent.length > 50) router.subagentRecent.shift()
  if (row.rated) router.subagentsRated = (router.subagentsRated || 0) + 1
}
