// Wait for newly published AIWG scans while preserving completed evidence and policy failures.
import { fetchArtifacts } from './socket-post-publish-fetch.mjs'

export const SOCKET_SCAN_WAIT_MS = 75 * 60_000
const RELEASE_PACKAGES = ['pkg:npm/aiwg', 'pkg:npm/%40aiwg/cli', 'pkg:npm/%40aiwg/cockpit', 'pkg:npm/%40aiwg/flue']
const PENDING_REASONS = new Set(['pendingScan', 'notFound'])

function pendingReleasePurls(report, version) {
  const releasePurls = new Set(RELEASE_PACKAGES.map(base => `${base}@${encodeURIComponent(version)}`))
  const unavailable = report.findings.unavailable
  const pending = new Set(unavailable.filter(item => PENDING_REASONS.has(item.reason)).map(item => item.purl))
  // Socket purlError records also produce a missing-response entry in the evaluator.
  const retryable = unavailable.every(item => releasePurls.has(item.purl) && pending.has(item.purl)
    && (PENDING_REASONS.has(item.reason) || item.reason === 'missing-response'))
  return retryable ? [...pending] : []
}

function wasQueried(artifact, purls) {
  const purl = artifact.inputPurl ?? artifact.purl ?? artifact.value?.inputPurl
  if (purl) return purls.has(purl)
  return [...purls].some(value => decodeURIComponent(value) === `pkg:npm/${artifact.name}@${artifact.version}`)
}

export async function auditWithPendingScans({
  components, version, baseline, evaluate,
  now = Date.now,
  sleep = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms)),
  log = message => console.error(message),
  ...fetchOptions
}) {
  const quotaDeadline = fetchOptions.paceQuotaMs > 0 ? now() + fetchOptions.paceQuotaMs : null
  let artifacts = []
  let report
  let requested = [...new Set(components.map(item => item.purl))]
  let startedAt = null
  let deadline = Infinity
  const waitedPurls = new Set()
  const attempts = []

  while (true) {
    let error = null
    try {
      const queried = new Set(requested)
      const retained = artifacts.filter(item => item._type !== 'summary' && !wasQueried(item, queried))
      const results = await fetchArtifacts({
        ...fetchOptions, components: requested.map(purl => ({ purl })),
        now, sleep, log, quotaDeadline, deadline,
        onBatch: received => {
          artifacts = [...retained, ...received]
          return evaluate({ artifacts, baseline, components, now: new Date(now()) }).status !== 'fail'
        }
      })
      artifacts = [...retained, ...results]
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
    report = evaluate({ artifacts, baseline, components, now: new Date(now()) })
    if (error) {
      report.findings.unavailable.unshift({ purl: '*', reason: error })
      report.summary.unavailable = report.findings.unavailable.length
      if (report.status !== 'fail') report.status = 'unavailable'
    }
    const pendingPurls = report.status === 'unavailable' && !error ? pendingReleasePurls(report, version) : []
    const attempt = { attempt: attempts.length + 1, queriedPurls: requested, evaluatedAt: new Date(now()).toISOString(), status: report.status, pendingPurls, nextRetryAt: null }
    attempts.push(attempt)
    if (!pendingPurls.length) {
      log(`Socket scan attempt ${attempt.attempt}: ${report.status}; next retry: none`)
      break
    }
    if (startedAt === null) {
      startedAt = now()
      deadline = startedAt + SOCKET_SCAN_WAIT_MS
    }
    for (const purl of pendingPurls) waitedPurls.add(purl)
    if (now() >= deadline) {
      log(`Socket scan attempt ${attempt.attempt}: deadline reached; next retry: none`)
      break
    }
    const delay = Math.min(60_000 * 2 ** Math.min(attempt.attempt - 1, 3), 5 * 60_000, deadline - now())
    attempt.nextRetryAt = new Date(now() + delay).toISOString()
    log(`Socket scan attempt ${attempt.attempt}: waiting on ${pendingPurls.join(', ')}; next retry at ${attempt.nextRetryAt}`)
    await sleep(delay)
    if (now() >= deadline) break
    requested = pendingPurls
  }

  report.scanWait = {
    maxWaitMs: SOCKET_SCAN_WAIT_MS,
    waitedMs: startedAt === null ? 0 : now() - startedAt,
    startedAt: startedAt === null ? null : new Date(startedAt).toISOString(),
    deadline: Number.isFinite(deadline) ? new Date(deadline).toISOString() : null,
    purls: [...waitedPurls], attempts, finalStatus: report.status
  }
  log(`Socket scan attempts: ${attempts.length}; waited ${report.scanWait.waitedMs}ms; final status: ${report.status}`)
  return report
}

export function scanWaitMarkdown(wait) {
  if (!wait) return ''
  const rows = [
    '## Published scan wait', '',
    `- Waited: ${wait.waitedMs / 60_000} minutes (maximum ${wait.maxWaitMs / 60_000})`,
    `- Attempts: ${wait.attempts.length}`,
    `- Final status: **${wait.finalStatus.toUpperCase()}**`,
    ...wait.purls.map(purl => `- Waited for: \`${purl}\``), '',
    '| Attempt | Evaluated | Status | Pending PURLs | Next retry |',
    '| ---: | --- | --- | --- | --- |',
    ...wait.attempts.map(attempt => `| ${attempt.attempt} | ${attempt.evaluatedAt} | ${attempt.status} | ${attempt.pendingPurls.join(', ')} | ${attempt.nextRetryAt ?? 'none'} |`), ''
  ]
  return `${rows.join('\n')}\n`
}
