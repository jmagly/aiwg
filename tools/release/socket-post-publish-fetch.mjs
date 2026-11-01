// Query Socket artifacts with bounded HTTP retries and quota-window pacing.
const socketAuthorization = token => `Basic ${Buffer.from(`${token}:`).toString('base64')}`

/**
 * Wait for the next Socket quota window when a request was rate limited.
 * Returns false when the window opens after the pacing deadline, so the caller
 * reports the 429 instead of waiting without bound.
 */
async function waitForQuotaWindow({ token, fetchImpl, deadline, now, sleep, log }) {
  let refreshAt = Number.NaN
  try {
    const response = await fetchImpl('https://api.socket.dev/v0/quota', {
      signal: AbortSignal.timeout(Math.max(1, Math.ceil(deadline - now()))),
      headers: { authorization: socketAuthorization(token), accept: 'application/json' }
    })
    if (response.ok) refreshAt = Date.parse((await response.json()).nextWindowRefresh)
  } catch { /* fall back to a one-minute wait below */ }
  const resumeAt = Number.isFinite(refreshAt) ? Math.max(now() + 1000, refreshAt + 5000) : now() + 60000
  if (resumeAt > deadline) return false
  log(`Socket quota exhausted; waiting until ${new Date(resumeAt).toISOString()} for the next window`)
  await sleep(Math.max(0, resumeAt - now()))
  return true
}

// Socket bills the org-scoped purl endpoint per request (up to 100 units on a
// 500-unit hourly free plan), not per component, so a release of ~800
// components must go in a few large requests rather than many small ones.
export const SOCKET_PURL_BATCH_SIZE = 500

export async function fetchArtifacts({
  components,
  token,
  orgSlug,
  fetchImpl = fetch,
  paceQuotaMs = 0,
  deadline = Infinity,
  batchSize = SOCKET_PURL_BATCH_SIZE,
  now = Date.now,
  quotaDeadline = paceQuotaMs > 0 ? now() + paceQuotaMs : null,
  onBatch = () => true,
  sleep = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms)),
  log = message => console.error(message)
}) {
  const all = []
  // Opt-in pacing for plans whose hourly quota is smaller than one full run:
  // a 429 waits for the next quota window (bounded by paceQuotaMs overall)
  // instead of consuming a retry. Without it, behaviour is unchanged.
  const paceDeadline = quotaDeadline === null ? null : Math.min(quotaDeadline, deadline)
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error('Socket batch size must be a positive integer')
  for (let offset = 0; offset < components.length; offset += batchSize) {
    const batch = components.slice(offset, offset + batchSize)
    const url = new URL(`https://api.socket.dev/v0/orgs/${encodeURIComponent(orgSlug)}/purl`)
    url.search = new URLSearchParams({ alerts: 'true', poll: 'true', timeoutSec: '300', summary: 'true' }).toString()
    let response
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (now() >= deadline) throw new Error('Socket scan wait deadline reached')
      response = await fetchImpl(url, {
        ...(Number.isFinite(deadline) ? { signal: AbortSignal.timeout(Math.max(1, Math.ceil(deadline - now()))) } : {}),
        method: 'POST',
        headers: { authorization: socketAuthorization(token), 'content-type': 'application/json', accept: 'application/x-ndjson' },
        body: JSON.stringify({ components: batch.map(({ purl }) => ({ purl })) })
      })
      if (response.ok || (response.status !== 429 && response.status < 500)) break
      if (response.status === 429 && paceDeadline !== null
        && await waitForQuotaWindow({ token, fetchImpl, deadline: paceDeadline, now, sleep, log })) {
        attempt -= 1
        continue
      }
      await sleep(Math.max(0, Math.min(attempt * 1000, deadline - now())))
    }
    if (!response?.ok) throw new Error(`Socket API request failed with HTTP ${response?.status ?? 'unknown'}`)
    const text = await response.text()
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      try { all.push(JSON.parse(line)) } catch { throw new Error('Socket API returned malformed NDJSON') }
    }
    if (!onBatch(all)) break
  }
  return all
}
