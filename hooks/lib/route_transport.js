

export async function routeFetch({ fetch, later, now }, req, deadlineMs) {
  let startedMs
  try { startedMs = await now() }
  catch (error) { return { response: null, latencyMs: 0, error } }
  const remainingMs = Math.max(0, deadlineMs - startedMs)
  if (remainingMs <= 0) return { response: null, latencyMs: 0 }
  return new Promise((resolve) => {
    let settled = false, finishing = false, scheduling = true
    let timer = null
    let canceled = false
    const cancelTimer = () => {
      if (!timer || canceled) return
      canceled = true
      try { timer.cancel() } catch (_) {}
    }
    const complete = (response, endedMs, error) => {
      if (settled) return
      settled = true
      cancelTimer()
      resolve({ response, latencyMs: Number.isFinite(endedMs) ? Math.max(0, endedMs - startedMs) : 0,
        ...(error === undefined ? {} : { error }) })
    }
    const finish = (response, error) => {
      if (settled || finishing) return
      finishing = true
      try { Promise.resolve(now()).then((endedMs) => complete(response, endedMs, error), () => complete(response, startedMs, error)) }
      catch (_) { complete(response, startedMs, error) }
    }


    try { timer = later(remainingMs, () => complete(null, scheduling ? startedMs : deadlineMs)) }
    catch (error) { complete(null, startedMs, error); return }
    scheduling = false

    if (settled || finishing) { if (settled) cancelTimer(); return }
    try {
      Promise.resolve(fetch(req.url, req.init)).then((response) => finish(response), (error) => finish(null, error))
    } catch (error) { finish(null, error) }
  })
}
