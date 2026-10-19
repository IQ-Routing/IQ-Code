
import { canonicalModel } from './models.js'
export const FAST_NOTE = 'IQ Code: fast mode is on; routing is paused.'
const FAST_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8'])
const SETTINGS_PRIORITY = ['policy', 'flag', 'local', 'project', 'user']
export function resolveFastSettings(sources) {
  const selected = { policyOff: sources?.policy?.fastMode === false }
  for (const key of ['fastMode', 'fastModePerSessionOptIn']) {
    for (const source of SETTINGS_PRIORITY) {
      const value = sources?.[source]?.[key]
      if (typeof value !== 'boolean') continue
      selected[key] = value
      break
    }
  }
  return selected
}

function disabledFast(value) {
  return value === true || typeof value === 'string' && value.trim() !== '' &&
    !['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase())
}
export function newFastMode() { return { active: false, blocked: false, noted: false, evidence: null, settingsReadErrors: 0, settingsErrorNoted: false } }
export function observeFastMode(state, { settings, model, lastMain, disabled, policyOff = false } = {}) {
  const repliedFast = lastMain?.speed === 'fast'
  const configured = settings?.fastMode === true && settings.fastModePerSessionOptIn !== true && FAST_MODELS.has(canonicalModel(model))
  state.active = !disabledFast(disabled) && policyOff !== true && (repliedFast || configured)
  state.evidence = state.active ? repliedFast ? 'main usage.speed' : 'settings.fastMode' : null
  state.blocked = state.active
  if (!state.blocked) state.noted = false
  return state.blocked
}
