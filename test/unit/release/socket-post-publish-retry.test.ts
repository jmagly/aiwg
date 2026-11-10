// Exercise published-scan retries with synthetic HTTP responses and a virtual clock.
import { describe, expect, it } from 'vitest'
import { evaluateSocketArtifacts } from '../../../tools/release/socket-post-publish-audit.mjs'
import { auditWithPendingScans, scanWaitMarkdown, SOCKET_SCAN_WAIT_MS } from '../../../tools/release/socket-post-publish-retry.mjs'

const version = '2026.10.19'
const root = { purl: `pkg:npm/aiwg@${version}`, depth: 'direct' }
const cli = { purl: `pkg:npm/%40aiwg/cli@${version}`, depth: 'direct' }
const third = { purl: 'pkg:npm/example@1.0.0', depth: 'transitive' }
const baseline = {
  policy: { materialScoreDrop: 0.1, blockingSeverities: ['high', 'critical'] },
  packages: { aiwg: { scores: { quality: 1 } } },
  reviewedCapabilityAlerts: []
}
const ready = (purl = root.purl) => ({ inputPurl: purl, alerts: [] })
const pending = (purl = root.purl, reason = 'pendingScan') => ({ inputPurl: purl, alerts: [{ type: reason }] })
const purlError = (purl = root.purl, error = 'pendingScan') => ({ _type: 'purlError', value: { inputPurl: purl, error } })

function harness(respond: (attempt: number, purls: string[]) => unknown[]) {
  let current = Date.parse('2026-10-19T12:00:00Z')
  const requests: string[][] = []
  const sleeps: number[] = []
  const logs: string[] = []
  const now = () => current
  const sleep = async (ms: number) => { sleeps.push(ms); current += ms }
  const fetchImpl = async (_url: URL | string, init?: { body?: string }) => {
    const purls = JSON.parse(String(init?.body)).components.map((component: { purl: string }) => component.purl)
    requests.push(purls)
    const artifacts = respond(requests.length, purls)
    return { ok: true, status: 200, text: async () => artifacts.map(item => JSON.stringify(item)).join('\n') } as never
  }
  const options = { token: 'synthetic', orgSlug: 'fixture', version, baseline, evaluate: evaluateSocketArtifacts, now, sleep, fetchImpl, log: (message: string) => logs.push(message) }
  return { options, now, sleep, requests, sleeps, logs }
}

describe('Socket published-scan retry', () => {
  it.each(['pendingScan', 'notFound'])('retries an explicit %s release PURL and preserves completed evidence', async reason => {
    const artifact = { ...ready(third.purl), alerts: [{ type: 'notice', severity: 'low' }] }
    const clock = harness(attempt => attempt === 1 ? [pending(root.purl, reason), ready(cli.purl), artifact] : [ready()])
    const report = await auditWithPendingScans({ ...clock.options, components: [root, cli, third] })
    expect(report.status).toBe('pass')
    expect(clock.requests).toEqual([[root.purl, cli.purl, third.purl], [root.purl]])
    expect(clock.sleeps).toEqual([60_000])
    expect(report.summary.componentsReturned).toBe(3)
    expect(report.findings.transitive).toHaveLength(1)
    expect(report.scanWait).toMatchObject({ waitedMs: 60_000, purls: [root.purl], finalStatus: 'pass' })
    expect(report.scanWait.attempts).toHaveLength(2)
    expect(clock.logs[0]).toContain('attempt 1')
    expect(clock.logs[0]).toContain('next retry at 2026-10-19T12:01:00.000Z')
    expect(scanWaitMarkdown(report.scanWait)).toContain('Waited: 1 minutes')
    expect(scanWaitMarkdown(report.scanWait)).toContain(root.purl)
    expect(scanWaitMarkdown(report.scanWait)).toContain('**PASS**')
  })

  it('retries a release PURL that Socket reports in decoded form, re-querying the canonical PURL', async () => {
    const decoded = `pkg:npm/@aiwg/cli@${version}`
    const clock = harness(attempt => attempt === 1 ? [ready(), pending(decoded)] : [ready(cli.purl)])
    const report = await auditWithPendingScans({ ...clock.options, components: [root, cli] })
    expect(report.status).toBe('pass')
    expect(clock.requests).toEqual([[root.purl, cli.purl], [cli.purl]])
    expect(report.scanWait).toMatchObject({ purls: [cli.purl], finalStatus: 'pass' })
  })

  it('does not wait on a bare missing-response with no explicit pending reason', async () => {
    const clock = harness(() => [ready()])
    const report = await auditWithPendingScans({ ...clock.options, components: [root, cli] })
    expect(report.status).toBe('unavailable')
    expect(clock.requests).toEqual([[root.purl, cli.purl]])
    expect(clock.sleeps).toEqual([])
  })

  it('bounds pending scans to 75 minutes and records every attempt on exhaustion', async () => {
    const clock = harness(() => [pending()])
    const report = await auditWithPendingScans({ ...clock.options, components: [root] })
    expect(report.status).toBe('unavailable')
    expect(clock.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(SOCKET_SCAN_WAIT_MS)
    expect(clock.sleeps.slice(0, 4)).toEqual([60_000, 120_000, 240_000, 300_000])
    expect(clock.sleeps.every(ms => ms <= 300_000)).toBe(true)
    expect(report.scanWait).toMatchObject({ waitedMs: SOCKET_SCAN_WAIT_MS, purls: [root.purl], finalStatus: 'unavailable' })
    expect(report.findings.unavailable).toEqual([{ purl: root.purl, reason: 'pendingScan' }])
    expect(report.scanWait.attempts).toHaveLength(clock.requests.length)
    expect(clock.requests.length).toBeGreaterThan(10)
    report.scanWait.attempts.forEach((attempt, index) => {
      expect(attempt).toMatchObject({ attempt: index + 1, queriedPurls: [root.purl], pendingPurls: [root.purl], status: 'unavailable' })
      expect(Date.parse(attempt.nextRetryAt)).toBeLessThanOrEqual(Date.parse(report.scanWait.deadline))
    })
    expect(scanWaitMarkdown(report.scanWait)).toContain('Waited: 75 minutes')
    expect(scanWaitMarkdown(report.scanWait)).toContain('**UNAVAILABLE**')
  })

  it.each([
    { name: 'blocking alert', artifact: { ...ready(), alerts: [{ type: 'newRisk', severity: 'high' }] } },
    { name: 'score regression', artifact: { ...ready(), name: 'aiwg', score: { quality: 0.5 } } },
    { name: 'validation error', artifact: { ...ready(), alerts: [{ type: 'notice', file: 123 }] } }
  ])('fails immediately on a $name alongside a pending scan', async ({ artifact }) => {
    const clock = harness(() => [artifact, pending(cli.purl)])
    const report = await auditWithPendingScans({ ...clock.options, components: [root, cli] })
    expect(report.status).toBe('fail')
    expect(clock.requests).toHaveLength(1)
    expect(clock.sleeps).toEqual([])
    expect(report.scanWait).toMatchObject({ waitedMs: 0, purls: [], finalStatus: 'fail' })
  })

  it.each([
    { name: 'third-party notFound', components: [third], artifacts: [pending(third.purl, 'notFound')] },
    { name: 'old AIWG version', components: [{ ...root, purl: 'pkg:npm/aiwg@2026.10.17' }], artifacts: [pending('pkg:npm/aiwg@2026.10.17')] },
    { name: 'bare missing response', components: [root], artifacts: [] },
    { name: 'pending release plus a third-party miss', components: [root, third], artifacts: [pending(), pending(third.purl, 'notFound')] }
  ])('leaves $name unavailable without waiting', async ({ components, artifacts }) => {
    const clock = harness(() => artifacts)
    const report = await auditWithPendingScans({ ...clock.options, components })
    const original = evaluateSocketArtifacts({ artifacts, components, baseline, now: new Date(clock.now()) })
    expect(report.status).toBe('unavailable')
    expect(report.findings).toEqual(original.findings)
    expect(clock.requests).toHaveLength(1)
    expect(clock.sleeps).toEqual([])
  })

  it('handles Socket purlError records and retries only PURLs still pending', async () => {
    const clock = harness(attempt => attempt === 1 ? [purlError(), purlError(cli.purl, 'notFound')]
      : attempt === 2 ? [ready(), purlError(cli.purl)] : [ready(cli.purl)])
    const report = await auditWithPendingScans({ ...clock.options, components: [root, cli] })
    expect(report.status).toBe('pass')
    expect(report.scanWait.purls).toEqual([root.purl, cli.purl])
    expect(clock.requests).toEqual([[root.purl, cli.purl], [root.purl, cli.purl], [cli.purl]])
    expect(clock.sleeps).toEqual([60_000, 120_000])
    expect(report.summary.componentsReturned).toBe(2)
  })

  it('stops on a real finding returned by a retry', async () => {
    const clock = harness(attempt => attempt === 1 ? [pending()] : [{ ...pending(), alerts: [{ type: 'pendingScan' }, { type: 'newRisk', severity: 'critical' }] }])
    const report = await auditWithPendingScans({ ...clock.options, components: [root] })
    expect(report.status).toBe('fail')
    expect(report.findings.blocking).toHaveLength(1)
    expect(clock.sleeps).toEqual([60_000])
    expect(report.scanWait.finalStatus).toBe('fail')
  })

  it('fails on the first blocking batch before fetching or pacing later batches', async () => {
    const clock = harness(() => [{ ...ready(), alerts: [{ type: 'newRisk', severity: 'high' }] }])
    const report = await auditWithPendingScans({ ...clock.options, batchSize: 1, components: [root, cli] })
    expect(report.status).toBe('fail')
    expect(report.findings.blocking).toHaveLength(1)
    expect(clock.requests).toEqual([[root.purl]])
    expect(clock.sleeps).toEqual([])
    expect(clock.logs[0]).toContain('attempt 1: fail; next retry: none')
  })

  it.each([
    { name: 'blocking alert', artifact: { ...ready(), alerts: [{ type: 'newRisk', severity: 'high' }] } },
    { name: 'score regression', artifact: { ...ready(), name: 'aiwg', score: { quality: 0.5 } } },
    { name: 'validation error', artifact: { ...ready(), alerts: [{ type: 'notice', file: 123 }] } }
  ])('reports the 386 unsent cargo PURLs as not-queried after a $name', async ({ artifact }) => {
    const npm = [root, ...Array.from({ length: 499 }, (_, i) => ({ purl: `pkg:npm/p${i}@1.0.0`, depth: 'transitive' }))]
    const cargo = Array.from({ length: 386 }, (_, i) => ({ purl: `pkg:cargo/c${i}@1.0.0`, depth: 'transitive' }))
    // Omit a PURL that was sent, to distinguish it from the unsent cargo batch.
    const clock = harness(() => [artifact, ...npm.slice(2).map(item => ready(item.purl))])
    const report = await auditWithPendingScans({ ...clock.options, components: [...npm, ...cargo] })
    expect(clock.requests).toEqual([npm.map(item => item.purl)])
    expect(clock.sleeps).toEqual([])
    expect(report.status).toBe('fail')
    expect(report.summary).toMatchObject({ componentsRequested: 886, componentsReturned: 499, unavailable: 387, notQueried: 386 })
    expect(report.findings.unavailable).toEqual([
      { purl: npm[1].purl, reason: 'missing-response' },
      ...cargo.map(({ purl }) => ({ purl, reason: 'not-queried', note: 'Fetching stopped after a failing batch to save quota.' }))
    ])
    expect(report.scanWait.attempts[0].queriedPurls).toEqual(npm.map(item => item.purl))
  })

  it.each([2, 3])('tracks only batches after failing batch %i as not-queried', async failingBatch => {
    const components = [root, cli, third]
    const clock = harness((attempt, purls) => purls.map(purl => ({
      ...ready(purl), alerts: attempt === failingBatch ? [{ type: 'newRisk', severity: 'high' }] : []
    })))
    const report = await auditWithPendingScans({ ...clock.options, batchSize: 1, components })
    expect(report.status).toBe('fail')
    expect(clock.requests).toEqual(components.slice(0, failingBatch).map(({ purl }) => [purl]))
    expect(report.summary).toMatchObject({ componentsReturned: failingBatch, unavailable: 3 - failingBatch, notQueried: 3 - failingBatch })
    expect(report.findings.unavailable.map(item => item.purl)).toEqual(components.slice(failingBatch).map(item => item.purl))
  })

  it('continues fetching after an incomplete batch and leaves sent omissions as missing-response', async () => {
    const clock = harness(attempt => attempt === 1 ? [] : [ready(cli.purl)])
    const report = await auditWithPendingScans({ ...clock.options, batchSize: 1, components: [root, cli] })
    expect(clock.requests).toEqual([[root.purl], [cli.purl]])
    expect(report.status).toBe('unavailable')
    expect(report.summary).toMatchObject({ unavailable: 1, notQueried: 0 })
    expect(report.findings.unavailable).toEqual([{ purl: root.purl, reason: 'missing-response' }])
  })

  it('preserves wait history and completed findings when a retry request fails', async () => {
    const clock = harness(attempt => {
      if (attempt > 1) throw new Error('synthetic transport failure')
      return [pending(), { ...ready(third.purl), alerts: [{ type: 'notice', severity: 'low' }] }]
    })
    const report = await auditWithPendingScans({ ...clock.options, components: [root, third] })
    expect(report.status).toBe('unavailable')
    expect(report.findings.transitive).toHaveLength(1)
    expect(report.findings.unavailable[0].reason).toBe('synthetic transport failure')
    expect(report.scanWait).toMatchObject({ waitedMs: 60_000, purls: [root.purl], finalStatus: 'unavailable' })
    expect(report.scanWait.attempts).toHaveLength(2)
  })

  it('caps quota pacing during a scan retry at the shared scan deadline', async () => {
    const clock = harness(() => [pending()])
    let posts = 0
    const fetchImpl = async (url: URL | string, init?: { body?: string }) => {
      if (String(url).endsWith('/quota')) return { ok: true, json: async () => ({ nextWindowRefresh: new Date(clock.now() + 80 * 60_000).toISOString() }) } as never
      posts += 1
      if (posts > 1) return { ok: false, status: 429 } as never
      return clock.options.fetchImpl(url, init)
    }
    const report = await auditWithPendingScans({ ...clock.options, fetchImpl, paceQuotaMs: 120 * 60_000, components: [root] })
    expect(report.status).toBe('unavailable')
    expect(report.scanWait.waitedMs).toBeLessThanOrEqual(SOCKET_SCAN_WAIT_MS)
    expect(clock.sleeps.every(ms => ms < 60 * 60_000)).toBe(true)
    expect(report.findings.unavailable[0].reason).toContain('HTTP 429')
  })

  it('keeps the original quota deadline across successive scan retries', async () => {
    const clock = harness(() => [pending()])
    const startedAt = clock.now()
    let posts = 0
    let quotaQueries = 0
    const fetchImpl = async (url: URL | string, init?: { body?: string }) => {
      if (String(url).endsWith('/quota')) {
        quotaQueries += 1
        const minutes = quotaQueries === 1 ? 4 : 7
        return { ok: true, json: async () => ({ nextWindowRefresh: new Date(startedAt + minutes * 60_000).toISOString() }) } as never
      }
      posts += 1
      if (posts === 1 || posts === 3) return clock.options.fetchImpl(url, init)
      if (clock.now() >= startedAt + 7 * 60_000) return { ok: true, text: async () => JSON.stringify(ready()) } as never
      return { ok: false, status: 429 } as never
    }
    const report = await auditWithPendingScans({ ...clock.options, fetchImpl, paceQuotaMs: 5 * 60_000, components: [root] })
    expect(report.status).toBe('unavailable')
    expect(clock.sleeps).toEqual([60_000, 185_000, 120_000, 1000, 2000, 3000])
    expect(report.scanWait.attempts).toHaveLength(3)
    expect(report.scanWait.waitedMs).toBe(371_000)
    expect(report.findings.unavailable[0].reason).toContain('HTTP 429')
  })
})
