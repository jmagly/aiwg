import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

import { componentsFromCargoLock, componentsFromLock, evaluateSocketArtifacts, fetchArtifacts, SOCKET_PURL_BATCH_SIZE } from '../../../tools/release/socket-post-publish-audit.mjs'

const liveArtifacts = readFileSync(new URL('../../fixtures/release/socket-live-npm.ndjson', import.meta.url), 'utf8')
  .trim().split('\n').map(line => JSON.parse(line))
const liveBaseline = JSON.parse(readFileSync(new URL('../../../ci/socket-score-baseline.json', import.meta.url), 'utf8'))
const liveComponents = liveArtifacts.map(artifact => ({ purl: artifact.inputPurl, depth: 'transitive' }))
const capturedAt = new Date('2026-10-25T00:00:00Z')

const baseline = {
  policy: { materialScoreDrop: 0.1, blockingSeverities: ['high', 'critical'] },
  packages: {
    aiwg: { scores: { supplyChain: 0.57, quality: 1, maintenance: 0.95, vulnerability: 1, license: 0.7 } },
    '@aiwg/cli': { scores: { supplyChain: 0.57, quality: 1, maintenance: 0.95, vulnerability: 1, license: 1 } }
  },
  reviewedCapabilityAlerts: [{
    package: '*', depth: 'direct', type: 'shellAccess', classification: 'required-capability',
    rationale: 'reviewed reachable shell capability', artifactHash: 'sha256:abc',
    owner: 'maintainers', reviewedOn: '2026-08-01', expiresOn: '2026-11-01'
  }]
}

const roots = [
  { purl: 'pkg:npm/aiwg@2026.8.8', depth: 'direct' },
  { purl: 'pkg:npm/%40aiwg/cli@2026.8.8', depth: 'direct' }
]
const scores = { supplyChain: 0.57, quality: 1, maintenance: 0.95, vulnerability: 1, license: 0.7 }
const behavioralEvidence = {
  artifactHash: 'sha256:abc', file: 'dist/index.js', symbol: 'spawn', ruleId: 'socket:shell-access',
  excerpt: 'spawn(command)', confidenceRationale: 'reachable shell capability requested by the caller'
}

function rootsWith(alerts: unknown[] = [], aiwgScores = scores) {
  return [
    { inputPurl: roots[0].purl, name: 'aiwg', version: '2026.8.8', score: aiwgScores, alerts },
    { inputPurl: roots[1].purl, name: '@aiwg/cli', version: '2026.8.8', score: { ...scores, license: 1 }, alerts: [] }
  ]
}

describe('Socket post-publish audit', () => {
  it('records reviewed direct capability alerts without treating capability as a defect', () => {
    const result = evaluateSocketArtifacts({ artifacts: rootsWith([{ type: 'shellAccess', severity: 'high', ...behavioralEvidence }]), baseline, components: roots, now: new Date('2026-08-14T00:00:00Z') })
    expect(result.status).toBe('pass')
    expect(result.findings.direct[0].review?.classification).toBe('required-capability')
  })

  it('blocks new severe transitive alerts and preserves depth', () => {
    const transitive = { purl: 'pkg:npm/example@1.0.0', depth: 'transitive' }
    const artifacts = [...rootsWith(), { inputPurl: transitive.purl, name: 'example', version: '1.0.0', alerts: [{ type: 'malware', severity: 'critical' }] }]
    const result = evaluateSocketArtifacts({ artifacts, baseline, components: [...roots, transitive], now: new Date('2026-08-14T00:00:00Z') })
    expect(result.status).toBe('fail')
    expect(result.findings.transitive[0].type).toBe('malware')
  })

  it('matches scoped npm packages that Socket reports with a separate namespace', () => {
    const scoped = { purl: 'pkg:npm/%40modelcontextprotocol/client@2.0.0', depth: 'transitive' }
    const accepted = { ...baseline, reviewedCapabilityAlerts: [...baseline.reviewedCapabilityAlerts, {
      package: '@modelcontextprotocol/client', depth: 'transitive', type: 'cve', classification: 'accepted-risk',
      rationale: 'not reachable from AIWG', owner: 'maintainers', reviewedOn: '2026-08-01', expiresOn: '2026-12-01', reviewedVersion: '2.0.0'
    }] }
    const artifacts = [...rootsWith(), { inputPurl: scoped.purl, namespace: '@modelcontextprotocol', name: 'client', version: '2.0.0', alerts: [{ type: 'cve', severity: 'high', props: { cveId: 'CVE-2026-104850', ghsaId: 'GHSA-6qxp-vccf-f47h', url: 'https://github.com/advisories/GHSA-6qxp-vccf-f47h' } }] }]
    const result = evaluateSocketArtifacts({ artifacts, baseline: accepted, components: [...roots, scoped], now: new Date('2026-08-14T00:00:00Z') })
    expect(result.findings.transitive[0].package).toBe('@modelcontextprotocol/client')
    expect(result.findings.blocking).toEqual([])
    expect(result.status).toBe('pass')
  })

  it('fails on material category regression', () => {
    const result = evaluateSocketArtifacts({ artifacts: rootsWith([], { ...scores, supplyChain: 0.46 }), baseline, components: roots, now: new Date('2026-08-14T00:00:00Z') })
    expect(result.status).toBe('fail')
    expect(result.findings.scoreRegressions[0].category).toBe('supplyChain')
  })

  it('fails closed when a scan is pending or a response is absent', () => {
    const artifacts = rootsWith([{ type: 'pendingScan', severity: 'unknown' }]).slice(0, 1)
    const result = evaluateSocketArtifacts({ artifacts, baseline, components: roots, now: new Date('2026-08-14T00:00:00Z') })
    expect(result.status).toBe('unavailable')
    expect(result.findings.unavailable.length).toBeGreaterThan(1)
  })

  it('requires expired capability reviews to be renewed', () => {
    const result = evaluateSocketArtifacts({ artifacts: rootsWith([{ type: 'shellAccess', severity: 'high', ...behavioralEvidence }]), baseline, components: roots, now: new Date('2026-12-01T00:00:00Z') })
    expect(result.status).toBe('fail')
    expect(result.findings.blocking[0].review?.expired).toBe(true)
  })

  it('builds a direct and transitive inventory from a release lockfile', () => {
    const components = componentsFromLock({ packages: {
      'node_modules/aiwg': { name: 'aiwg', version: '2026.8.8' },
      'node_modules/@aiwg/cli': { name: '@aiwg/cli', version: '2026.8.8' },
      'node_modules/chalk': { version: '4.1.2' }
    } }, '2026.8.8')
    expect(components.filter(item => item.depth === 'direct').map(item => item.purl)).toEqual([
      'pkg:npm/aiwg@2026.8.8', 'pkg:npm/%40aiwg/cli@2026.8.8',
      'pkg:npm/%40aiwg/cockpit@2026.8.8', 'pkg:npm/%40aiwg/flue@2026.8.8'
    ])
    expect(components.find(item => item.purl.includes('chalk'))?.depth).toBe('transitive')
  })

  it('binds npm components to commit and lockfile provenance', () => {
    const components = componentsFromLock({ packages: { 'node_modules/chalk': { version: '4.1.2' } } }, '2026.8.8', {
      commitSha: 'abc123', workspace: 'tools/eval', manifestPath: 'tools/eval/package.json',
      lockfilePath: 'tools/eval/package-lock.json', lockfileDigest: 'sha256:lock'
    })
    expect(components.find(item => item.purl.includes('chalk'))).toMatchObject({
      ecosystem: 'npm', commitSha: 'abc123', lockfilePath: 'tools/eval/package-lock.json', lockfileDigest: 'sha256:lock'
    })
  })

  it('inventories Rust packages from Cargo.lock with provenance', () => {
    const components = componentsFromCargoLock('[[package]]\nname = "quick-xml"\nversion = "0.41.0"\n', {
      lockfilePath: 'apps/desktop/Cargo.lock', lockfileDigest: 'sha256:cargo'
    })
    expect(components).toEqual([expect.objectContaining({
      purl: 'pkg:cargo/quick-xml@0.41.0', ecosystem: 'cargo', lockfilePath: 'apps/desktop/Cargo.lock'
    })])
  })

  // Live behavioral alerts omit enrichments; absence alone is not a defect (#3578).
  it('accepts absent optional behavioral evidence', () => {
    const result = evaluateSocketArtifacts({
      artifacts: rootsWith([{ type: 'obfuscatedCode', severity: 'high', key: 'obfuscation' }]), baseline, components: roots
    })
    expect(result.status).toBe('pass')
    expect(result.findings.validationErrors).toEqual([])
    expect(result.findings.direct[0].evidence.artifactHash).toBeNull()
  })

  it('downgrades code-shape-only obfuscation evidence and deduplicates affected paths', () => {
    const component = { ...roots[0], dependencyPath: ['root', 'node_modules/example'] }
    const alert = {
      type: 'obfuscatedCode', severity: 'high', key: 'shape:minified', artifactHash: 'sha256:artifact',
      file: 'dist/min.js', ruleId: 'shape:minified', excerpt: 'a=>a^b',
      confidenceRationale: 'minified distribution artifact; no malicious behavior observed'
    }
    const result = evaluateSocketArtifacts({ artifacts: rootsWith([alert, alert]), baseline, components: [component, roots[1]] })
    expect(result.findings.direct).toHaveLength(1)
    expect(result.findings.direct[0].severity).toBe('informational')
    expect(result.findings.direct[0].originalSeverity).toBe('high')
  })

  it('rejects duplicate finding IDs and CVE rows without advisory identifiers', () => {
    const alerts = [
      { id: '0.72', type: 'cve', severity: 'moderate' },
      { id: '0.72', type: 'cve', severity: 'moderate', advisoryId: 'CVE-2026-1' }
    ]
    const result = evaluateSocketArtifacts({ artifacts: rootsWith(alerts), baseline, components: roots })
    expect(result.status).toBe('fail')
    expect(result.findings.validationErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '0.72', error: 'duplicate-finding-id' }),
      expect.objectContaining({ errors: expect.arrayContaining(['missing-advisory-identifier']) })
    ]))
  })

  it('does not carry an accept-risk review across artifact hashes', () => {
    const changed = { ...behavioralEvidence, artifactHash: 'sha256:changed' }
    const result = evaluateSocketArtifacts({
      artifacts: rootsWith([{ type: 'shellAccess', severity: 'high', ...changed }]), baseline, components: roots,
      now: new Date('2026-08-14T00:00:00Z')
    })
    expect(result.status).toBe('fail')
    expect(result.findings.direct[0].review).toBeNull()
  })

  // Socket's zod advisory supplies a cross-major fix; preserve upstream data (#3578).
  it('preserves valid patched versions from a different major line', () => {
    const result = evaluateSocketArtifacts({
      artifacts: rootsWith([{
        id: 'nanoid-advisory', type: 'vulnerability', severity: 'high', advisoryId: 'GHSA-example',
        advisoryUrl: 'https://example.test/GHSA-example', firstPatchedVersion: '5.1.6'
      }]).map(item => item.name === 'aiwg' ? { ...item, version: '3.3.17' } : item),
      baseline, components: roots
    })
    expect(result.findings.validationErrors).toEqual([])
    expect(result.findings.blocking[0].evidence.firstPatchedVersion).toBe('5.1.6')
  })

  it('excludes local Cargo 0.0.0 packages while retaining registry and git dependencies', async () => {
    const content = [
      '[[package]]', 'name = "aiwg-cockpit-desktop"', 'version = "0.0.0"',
      '[[package]]', 'name = "workspace-helper"', 'version = "0.0.0"',
      '[[package]]', 'name = "registry-dep"', 'version = "0.0.0"', 'source = "registry+https://example.test/index"',
      '[[package]]', 'name = "git-dep"', 'version = "0.0.0"', 'source = "git+https://example.test/repo"'
    ].join('\n')
    const components = componentsFromCargoLock(content)
    expect(components.map(component => component.purl)).toEqual(['pkg:cargo/registry-dep@0.0.0', 'pkg:cargo/git-dep@0.0.0'])
    const artifacts = components.map(component => ({ inputPurl: component.purl, alerts: [] }))
    const fetchImpl = async (_url: URL, options: RequestInit) => {
      expect(JSON.parse(options.body as string).components).toEqual(components.map(({ purl }) => ({ purl })))
      return { ok: true, text: async () => artifacts.map(artifact => JSON.stringify(artifact)).join('\n') } as Response
    }
    const returned = await fetchArtifacts({ components, token: 'fixture-token', orgSlug: 'fixture-org', fetchImpl })
    expect(evaluateSocketArtifacts({ artifacts: returned, baseline, components }).status).toBe('pass')
  })

  it('excludes secondary npm workspace roots and links but keeps published release roots', () => {
    const lock = { packages: {
      '': { name: 'workspace-root', version: '0.0.0', private: true },
      'node_modules/workspace-helper': { version: '0.0.0', link: true, resolved: 'packages/helper' },
      'node_modules/private-helper': { version: '0.0.0', private: true },
      'node_modules/chalk': { version: '4.1.2' }
    } }
    const secondary = componentsFromLock(lock, '2026.8.8', { releaseRoot: false })
    expect(secondary.map(component => component.purl)).toEqual(['pkg:npm/chalk@4.1.2'])
    expect(componentsFromLock(lock, '2026.8.8').filter(component => component.depth === 'direct')).toEqual(
      [...roots, { purl: 'pkg:npm/%40aiwg/cockpit@2026.8.8', depth: 'direct' }, { purl: 'pkg:npm/%40aiwg/flue@2026.8.8', depth: 'direct' }].map(root => expect.objectContaining(root))
    )
  })

  it.each([
    ['file', 42], ['symbol', {}], ['ruleId', ''], ['artifactHash', []],
    ['excerpt', false], ['behaviorTrace', 42], ['confidenceRationale', ' '],
    ['props', []], ['advisoryId', {}], ['advisoryUrl', 'javascript:alert(1)'], ['firstPatchedVersion', 'later']
  ])('rejects malformed supplied evidence: %s', (field, value) => {
    const result = evaluateSocketArtifacts({
      artifacts: rootsWith([{ type: 'shellAccess', severity: 'low', ...behavioralEvidence, [field]: value }]),
      baseline, components: roots
    })
    expect(result.status).toBe('fail')
    expect(result.findings.direct[0].evidenceErrors).toContain(`invalid-${field}`)
  })

  it.each([
    ['cveId', 42], ['ghsaId', {}], ['url', 'not-a-url'], ['firstPatchedVersionIdentifier', 'unknown']
  ])('rejects malformed CVE props even when a legacy field takes precedence: %s', (field, value) => {
    const alert = liveArtifacts.flatMap(artifact => artifact.alerts).find(alert => alert.type === 'cve')
    const result = evaluateSocketArtifacts({
      artifacts: rootsWith([{
        ...alert, advisoryId: 'CVE-2026-111181', advisoryUrl: 'https://example.test/advisory', firstPatchedVersion: '2.4.0',
        props: { ...alert.props, [field]: value }
      }]), baseline, components: roots
    })
    expect(result.status).toBe('fail')
    expect(result.findings.direct[0].evidenceErrors).toContain(`invalid-props.${field}`)
  })
})

describe('Socket captured live response', () => {
  it('evaluates real alert shapes without errors from absent enrichments or advisory-free capability alerts', () => {
    const result = evaluateSocketArtifacts({ artifacts: liveArtifacts, baseline: liveBaseline, components: liveComponents, now: capturedAt })
    expect(result.summary.validationErrors).toBe(0)
    expect(result.findings.validationErrors).toEqual([])
    expect(result.findings.unavailable).toEqual([])
    expect(result.summary.componentsReturned).toBe(liveComponents.length)
    const install = result.findings.transitive.find(finding => finding.type === 'installScripts')!
    expect(install.evidence).toMatchObject({
      file: 'package/package.json', ruleId: 'QBIzHC_QUrkK6uxhD9pzoPz3zQVqLj2FWb1q1z4IGKbk',
      props: { script: 'postinstall', source: 'node install.js' },
      artifactHash: null, symbol: null, excerpt: null, behaviorTrace: null, confidenceRationale: null
    })
    expect(result.findings.transitive.find(finding => finding.type === 'potentialVulnerability')?.evidenceErrors).toEqual([])
  })

  it('populates CVE advisory fields and still blocks high body-parser and zod CVEs', () => {
    const result = evaluateSocketArtifacts({ artifacts: liveArtifacts, baseline: liveBaseline, components: liveComponents, now: capturedAt })
    expect(result.status).toBe('fail')
    expect(result.findings.blocking.map(finding => [finding.package, finding.version, finding.type])).toEqual([
      ['body-parser', '2.3.0', 'cve'], ['zod', '4.3.5', 'cve']
    ])
    // The zod 3.25.76 copy nested under @fortemi/core carries a dated accepted-risk review (#3577).
    expect(result.findings.transitive.find(finding => finding.package === 'zod' && finding.version === '3.25.76')?.review)
      .toMatchObject({ classification: 'accepted-risk', expired: false })
    for (const finding of result.findings.transitive.filter(finding => /cve/i.test(finding.type))) {
      expect(finding.evidence.advisoryId).toBe(finding.evidence.props.cveId)
      expect(finding.evidence.advisoryUrl).toBe(finding.evidence.props.url)
      expect(finding.evidence.firstPatchedVersion).toBe(finding.evidence.props.firstPatchedVersionIdentifier)
    }
    expect(result.findings.blocking.find(finding => finding.package === 'body-parser')?.evidence).toMatchObject({
      advisoryId: 'CVE-2026-111181', advisoryUrl: 'https://github.com/advisories/GHSA-27r3-jxmh-p828', firstPatchedVersion: '2.4.0'
    })
    expect(result.findings.blocking.find(finding => finding.package === 'zod')?.evidence.firstPatchedVersion).toBe('4.6.6')
  })

  it('uses GHSA props when a CVE identifier has not been assigned', () => {
    const artifact = liveArtifacts.find(artifact => artifact.alerts.some(alert => alert.type === 'cve'))
    const alert = artifact.alerts.find(alert => alert.type === 'cve')
    const { cveId: _cveId, ...props } = alert.props
    const result = evaluateSocketArtifacts({
      artifacts: [{ ...artifact, alerts: [{ ...alert, props }] }], baseline: liveBaseline,
      components: [{ purl: artifact.inputPurl, depth: 'transitive' }], now: capturedAt
    })
    expect(result.findings.validationErrors).toEqual([])
    expect(result.findings.blocking[0].evidence.advisoryId).toBe('GHSA-27r3-jxmh-p828')
  })

  it('reports Socket replacement notices as informational without blocking', () => {
    const artifacts = liveArtifacts.filter(artifact => artifact.alerts.some(alert => alert.type === 'socketUpgradeAvailable'))
      .map(artifact => ({ ...artifact, alerts: artifact.alerts.filter(alert => alert.type === 'socketUpgradeAvailable') }))
    const result = evaluateSocketArtifacts({
      artifacts, baseline: liveBaseline, components: artifacts.map(artifact => ({ purl: artifact.inputPurl, depth: 'direct' })), now: capturedAt
    })
    expect(result.status).toBe('pass')
    expect(result.findings.direct).toHaveLength(3)
    for (const finding of result.findings.direct) {
      expect(finding.severity).toBe('informational')
      expect(finding.originalSeverity).toBe('high')
      expect(finding.evidence.props.replacementPURL).toMatch(/^pkg:npm\//)
    }
    expect(result.findings.blocking).toEqual([])
  })

  it('keeps unreviewed direct capabilities blocking even with Socket ignore actions', () => {
    const artifact = liveArtifacts.find(artifact => artifact.alerts.some(alert => alert.type === 'shellAccess'))
    const alert = artifact.alerts.find(alert => alert.type === 'shellAccess')
    expect(alert.action).toBe('ignore')
    const result = evaluateSocketArtifacts({
      artifacts: [{ ...artifact, alerts: [alert] }], baseline: liveBaseline,
      components: [{ purl: artifact.inputPurl, depth: 'direct' }], now: capturedAt
    })
    expect(result.status).toBe('fail')
    expect(result.findings.validationErrors).toEqual([])
    expect(result.findings.blocking).toHaveLength(1)
    expect(result.findings.blocking[0].type).toBe('shellAccess')
  })
})

describe('Socket quota pacing', () => {
  const components = [{ purl: 'pkg:npm/aiwg@1.0.0' }]
  const ndjson = (body: string) => ({ ok: true, status: 200, text: async () => body })
  const limited = { ok: false, status: 429, text: async () => '' }
  const quota = (refresh: string) => ({ ok: true, status: 200, json: async () => ({ quota: 0, maxQuota: 500, nextWindowRefresh: refresh }) })
  const clock = (start: number) => {
    let current = start
    return { now: () => current, sleep: async (ms: number) => { current += ms } }
  }

  it('waits for the next quota window on 429 and retries the same batch when pacing is enabled', async () => {
    const start = Date.parse('2026-10-16T18:00:00Z')
    const { now, sleep } = clock(start)
    const calls: string[] = []
    const responses = [limited, quota('2026-10-16T18:27:00Z'), ndjson('{"purl":"pkg:npm/aiwg@1.0.0"}\n')]
    const fetchImpl = async (url: URL | string) => { calls.push(String(url)); return responses.shift() as never }
    const artifacts = await fetchArtifacts({ components, token: 't', orgSlug: 'org', fetchImpl, paceQuotaMs: 60 * 60_000, now, sleep, log: () => {} })
    expect(artifacts).toEqual([{ purl: 'pkg:npm/aiwg@1.0.0' }])
    expect(calls.filter(url => url.endsWith('/v0/quota'))).toHaveLength(1)
    expect(now()).toBe(Date.parse('2026-10-16T18:27:05Z'))
  })

  it('reports the 429 instead of waiting past the pacing deadline', async () => {
    const { now, sleep } = clock(Date.parse('2026-10-16T18:00:00Z'))
    const fetchImpl = async (url: URL | string) => (String(url).endsWith('/v0/quota') ? quota('2026-10-16T19:00:00Z') : limited) as never
    await expect(fetchArtifacts({ components, token: 't', orgSlug: 'org', fetchImpl, paceQuotaMs: 10 * 60_000, now, sleep, log: () => {} }))
      .rejects.toThrow('HTTP 429')
  })

  it('first-party reviews match AIWG packages without a hash pin but never cover third-party code', () => {
    const firstParty = {
      ...baseline,
      firstPartyPackages: ['pkg:npm/aiwg', 'pkg:npm/%40aiwg/cli'],
      reviewedCapabilityAlerts: [{
        package: '*', depth: 'direct', type: 'shellAccess', scope: 'first-party', classification: 'required-capability',
        rationale: 'AIWG invokes local tools after approval', owner: 'maintainers', reviewedOn: '2026-10-25', expiresOn: '2027-01-25'
      }]
    }
    const shell = { key: 'Qshell-rule', type: 'shellAccess', severity: 'middle', file: 'dist/src/skills/cli.js' }
    const third = { purl: 'pkg:npm/commander@12.1.0', depth: 'direct' }
    const artifacts = [
      ...rootsWith([shell]),
      { inputPurl: third.purl, name: 'commander', version: '12.1.0', score: scores, alerts: [{ ...shell, artifactHash: 'sha512-x' }] }
    ]
    const result = evaluateSocketArtifacts({ artifacts, baseline: firstParty, components: [...roots, third], now: new Date('2026-10-25T00:00:00Z') })
    const blocking = result.findings.blocking.map((finding: { package: string }) => finding.package)
    expect(blocking).not.toContain('aiwg')
    expect(blocking).toContain('commander')
    const pinned = { ...firstParty, reviewedCapabilityAlerts: [...firstParty.reviewedCapabilityAlerts, {
      package: 'commander', depth: 'direct', type: 'shellAccess', classification: 'required-capability',
      rationale: 'no executable subcommands registered', artifactHash: 'sha512-x', owner: 'maintainers', reviewedOn: '2026-10-25', expiresOn: '2027-01-25'
    }] }
    const pinnedResult = evaluateSocketArtifacts({ artifacts, baseline: pinned, components: [...roots, third], now: new Date('2026-10-25T00:00:00Z') })
    expect(pinnedResult.findings.blocking.map((finding: { package: string }) => finding.package)).not.toContain('commander')
    const stale = { ...pinned, reviewedCapabilityAlerts: pinned.reviewedCapabilityAlerts.map(review => review.package === 'commander' ? { ...review, artifactHash: 'sha512-old' } : review) }
    const staleResult = evaluateSocketArtifacts({ artifacts, baseline: stale, components: [...roots, third], now: new Date('2026-10-25T00:00:00Z') })
    expect(staleResult.findings.blocking.map((finding: { package: string }) => finding.package)).toContain('commander')
  })

  it('treats an empty cveId as absent and scopes version-pinned reviews to that version', () => {
    const cargo = { purl: 'pkg:cargo/glib@0.18.5', depth: 'transitive' }
    const medium = { key: 'Qglib', type: 'mediumCVE', severity: 'middle', props: { cveId: '', ghsaId: 'GHSA-wrw7-89jp-8q8g', url: 'https://github.com/advisories/GHSA-wrw7-89jp-8q8g' } }
    const zodOld = { purl: 'pkg:npm/zod@3.25.76', depth: 'transitive' }
    const zodNew = { purl: 'pkg:npm/zod@4.3.5', depth: 'transitive' }
    const cve = { key: 'Qzod', type: 'cve', severity: 'high', props: { cveId: 'CVE-2023-54404', ghsaId: 'GHSA-mrhx-c7xc-m3w5', url: 'https://github.com/advisories/GHSA-mrhx-c7xc-m3w5' } }
    const accepted = { ...baseline, reviewedCapabilityAlerts: [{
      package: 'zod', depth: 'transitive', type: 'cve', classification: 'accepted-risk', reviewedVersion: '3.25.76',
      rationale: 'nested under an upstream pin', owner: 'maintainers', reviewedOn: '2026-10-25', expiresOn: '2026-12-15'
    }] }
    const artifacts = [
      { inputPurl: cargo.purl, name: 'glib', version: '0.18.5', score: scores, alerts: [medium] },
      { inputPurl: zodOld.purl, name: 'zod', version: '3.25.76', score: scores, alerts: [cve] },
      { inputPurl: zodNew.purl, name: 'zod', version: '4.3.5', score: scores, alerts: [cve] }
    ]
    const result = evaluateSocketArtifacts({ artifacts, baseline: accepted, components: [cargo, zodOld, zodNew], now: new Date('2026-10-25T00:00:00Z') })
    const glib = result.findings.transitive.find((finding: { package: string }) => finding.package === 'glib')
    expect(glib.evidenceErrors).toEqual([])
    expect(glib.evidence.advisoryId).toBe('GHSA-wrw7-89jp-8q8g')
    const blocking = result.findings.blocking.map((finding: { package: string, version: string }) => `${finding.package}@${finding.version}`)
    expect(blocking).toEqual(['zod@4.3.5'])
  })

  it('sends a release-sized component set in few large requests (Socket bills per request)', async () => {
    const many = Array.from({ length: 794 }, (_, i) => ({ purl: `pkg:npm/p${i}@1.0.0` }))
    const bodies: number[] = []
    const fetchImpl = async (_url: URL | string, init?: { body?: string }) => {
      bodies.push(JSON.parse(String(init?.body)).components.length)
      return ndjson('') as never
    }
    await fetchArtifacts({ components: many as never, token: 't', orgSlug: 'org', fetchImpl, log: () => {} })
    expect(SOCKET_PURL_BATCH_SIZE).toBe(500)
    expect(bodies).toEqual([500, 294])
    bodies.length = 0
    await fetchArtifacts({ components: many as never, token: 't', orgSlug: 'org', fetchImpl, batchSize: 1000, log: () => {} })
    expect(bodies).toEqual([794])
    await expect(fetchArtifacts({ components: many as never, token: 't', orgSlug: 'org', fetchImpl, batchSize: 0, log: () => {} }))
      .rejects.toThrow('batch size')
  })

  it('never queries the quota endpoint when pacing is off', async () => {
    const { now, sleep } = clock(0)
    const calls: string[] = []
    const fetchImpl = async (url: URL | string) => { calls.push(String(url)); return limited as never }
    await expect(fetchArtifacts({ components, token: 't', orgSlug: 'org', fetchImpl, now, sleep, log: () => {} })).rejects.toThrow('HTTP 429')
    expect(calls.some(url => url.endsWith('/v0/quota'))).toBe(false)
    expect(calls).toHaveLength(3)
  })
})
