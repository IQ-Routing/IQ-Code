
export const ISSUES_URL = 'https://github.com/IQ-Routing/IQ-Code/issues'
export const SUPPORT_EMAIL = 'support@iq-routing.com'
export const TEMPLATE = Object.freeze({ bug: 'bug_report.yml', feature: 'feature_request.yml', question: 'routing_question.yml' })
const SEMVER = /^\d+\.\d+\.\d+$/
const CODE = /^[a-z][a-z0-9_]{0,39}$/
const OS = /^(Windows|Linux|unknown|macOS( \d+(\.\d+){1,2})?)$/
const ROUTING = new Set(['on', 'off', 'killed', 'no_key', 'paused_errors', 'paused_plan', 'paused_allowance',
])
const matches = (pattern, value) => typeof value === 'string' && !/[\r\n]/.test(value) && pattern.test(value)

export function cleanFields({ iqVersion, os, claudeCode, routing, lastError } = {}) {
  return {
    iqVersion: matches(SEMVER, iqVersion) ? iqVersion : 'unknown',
    os: matches(OS, os) ? os : 'unknown',
    claudeCodeVersion: matches(SEMVER, claudeCode) ? claudeCode : 'unknown',
    routing: ROUTING.has(routing) ? routing : 'unknown',
    lastError: lastError == null ? 'none' : matches(CODE, lastError) ? lastError : 'unknown',
  }
}

export function issueUrl(kind, fields = {}) {
  if (!Object.prototype.hasOwnProperty.call(TEMPLATE, kind)) throw new Error('Unknown feedback kind')
  const f = cleanFields({ ...fields, claudeCode: fields.claudeCodeVersion })
  const pairs = [['template', TEMPLATE[kind]], ['iq_version', f.iqVersion], ['os', f.os],
    ['claude_code_version', f.claudeCodeVersion], ['routing', f.routing], ['last_error', f.lastError]]
  return ISSUES_URL + '/new?' + pairs.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&')
}
