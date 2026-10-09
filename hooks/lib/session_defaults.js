
import { settingsRequest, parseSettingsResponse } from './iq_client.js'

export const SETTINGS_INTERVAL_MS = 10 * 60 * 1000
export const SETTINGS_TIMEOUT_MS = 750

export function newSettingsClient({ now, later, fetch, onResult }) {
  let lastAttempt = null
  let inFlight = false
  let ended = false
  let timer = null
  function request(options) {
    const time = now()
    if (ended || inFlight || !Number.isFinite(time) || lastAttempt !== null && time - lastAttempt < SETTINGS_INTERVAL_MS) return false
    const req = settingsRequest(options)
    if (!req) return false
    lastAttempt = time
    inFlight = true
    let finished = false
    const finish = (value) => {
      if (finished || ended) return
      finished = true
      try { if (timer) timer.cancel() } catch (_) {}
      try { onResult(value) } catch (_) {}
    }
    timer = later(SETTINGS_TIMEOUT_MS, () => finish(null))
    
    
    Promise.resolve().then(() => ended ? null : fetch(req.url, req.init)).then(
      (res) => finish(parseSettingsResponse(res)), () => finish(null),
    ).finally(() => { inFlight = false })
    return true
  }
  return { request, end() { ended = true; try { if (timer) timer.cancel() } catch (_) {} } }
}
