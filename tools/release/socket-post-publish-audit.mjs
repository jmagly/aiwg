#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, relative, resolve } from 'node:path'
import { boundedExecFileSync } from '../../src/process/bounded-child-process.mjs'
import { pathToFileURL } from 'node:url'
import { valid as validVersion } from 'semver'

import { fetchArtifacts, SOCKET_PURL_BATCH_SIZE } from './socket-post-publish-fetch.mjs'
import { auditWithPendingScans, scanWaitMarkdown } from './socket-post-publish-retry.mjs'
export { fetchArtifacts, SOCKET_PURL_BATCH_SIZE }

const SCORE_KEYS = ['supplyChain', 'quality', 'maintenance', 'vulnerability', 'license']
const CAPABILITY_ALERTS = new Set(['shellAccess', 'filesystemAccess', 'networkAccess', 'envVars', 'urlAccess'])

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) continue
    const key = value.slice(2)
    const next = argv[index + 1]
    values[key] = key === 'dependency-lock'
      ? [...(Array.isArray(values[key]) ? values[key] : values[key] ? [values[key]] : []), next]
      : next
    index += 1
  }
  return values
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

function npmPurl(name, version) {
  if (name.startsWith('@')) {
    const [scope, packageName] = name.slice(1).split('/')
    return `pkg:npm/%40${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}@${encodeURIComponent(version)}`
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`
}

export function componentsFromLock(lock, version, provenance = {}) {
  const rootMetadata = lock.packages?.[''] ?? {}
  // Secondary locks describe local workspace roots, not published scan targets.
  const roots = new Set(provenance.releaseRoot === false
    ? []
    : [npmPurl('aiwg', version), npmPurl('@aiwg/cli', version), npmPurl('@aiwg/cockpit', version), npmPurl('@aiwg/flue', version)])
  const directNames = new Set(Object.keys({
    ...(rootMetadata.dependencies ?? {}),
    ...(rootMetadata.optionalDependencies ?? {}),
    ...(rootMetadata.peerDependencies ?? {})
  }))
  const common = { ecosystem: 'npm', ...provenance }
  const components = new Map([...roots].map(purl => [purl, { purl, depth: 'direct', dependencyPath: ['release-root', purl], ...common }]))
  for (const [location, metadata] of Object.entries(lock.packages ?? {})) {
    if (!location.includes('node_modules/') || !metadata?.version || metadata.link || metadata.private) continue
    const inferredName = location.match(/node_modules\/((?:@[^/]+\/)?[^/]+)$/)?.[1]
    const name = metadata.name ?? inferredName
    if (!name) continue
    const purl = npmPurl(name, metadata.version)
    const isTopLevel = location === `node_modules/${name}`
    const depth = roots.has(purl) || (isTopLevel && directNames.has(name)) ? 'direct' : 'transitive'
    if (!components.has(purl)) components.set(purl, {
      purl,
      depth,
      dependencyPath: [rootMetadata.name ?? 'release-root', location],
      artifactHash: metadata.integrity ?? null,
      ...common
    })
  }
  return [...components.values()]
}

export function componentsFromCargoLock(content, provenance = {}) {
  const components = []
  for (const block of content.split(/\n(?=\[\[package\]\]\n)/)) {
    const name = block.match(/^name = "([^"]+)"$/m)?.[1]
    const version = block.match(/^version = "([^"]+)"$/m)?.[1]
    if (!name || !version) continue
    // Cargo omits source for local path/workspace packages. Do not hide a
    // registry or git dependency merely because its version is also 0.0.0.
    if (version === '0.0.0' && !/^source\s*=/m.test(block)) continue
    components.push({
      purl: `pkg:cargo/${encodeURIComponent(name)}@${encodeURIComponent(version)}`,
      depth: 'transitive',
      dependencyPath: ['cargo-root', `${name}@${version}`],
      ecosystem: 'cargo',
      ...provenance
    })
  }
  return components
}

function alertType(alert) {
  return String(alert?.type ?? alert?.value?.type ?? alert?.key ?? 'unknown')
}

function alertSeverity(alert) {
  return String(alert?.severity ?? alert?.value?.severity ?? 'unknown').toLowerCase()
}

function artifactPurl(artifact) {
  return artifact.inputPurl ?? artifact.purl ?? (artifact.name && artifact.version ? npmPurl(artifact.name, artifact.version) : '')
}

// Socket returns npm scopes in a separate namespace field; keep the full scoped name so
// baseline entries such as @modelcontextprotocol/client and @aiwg/cli can match.
function packageName(artifact) {
  if (artifact.name) {
    const scope = typeof artifact.namespace === 'string' && artifact.namespace ? artifact.namespace : ''
    return scope ? `${scope.startsWith('@') ? scope : `@${scope}`}/${artifact.name}` : artifact.name
  }
  return decodeURIComponent(artifactPurl(artifact).replace(/^pkg:npm\//, '').replace(/@[^@/]+$/, ''))
}

// Socket sends empty strings for absent identifiers (for example cveId: "" on a
// GHSA-only advisory); treat them as absent rather than as invalid values.
function present(value) {
  return value !== undefined && value !== null && value !== ''
}

function firstValue(...values) {
  return values.find(value => value !== undefined && value !== null) ?? null
}

function isBehavioral(type) {
  return /obfuscat|malware|install.?script|behavior|telemetry|network|filesystem|shell/i.test(type)
}

function normalizeEvidence(artifact, alert, component) {
  const value = alert?.value ?? {}
  const props = firstValue(alert.props, value.props)
  return {
    props,
    artifactHash: firstValue(alert.artifactHash, value.artifactHash, artifact.integrity, artifact.hash, component?.artifactHash),
    file: firstValue(alert.file, value.file, alert.location?.file, value.location?.file),
    symbol: firstValue(alert.symbol, value.symbol, alert.location?.symbol, value.location?.symbol),
    ruleId: firstValue(alert.ruleId, value.ruleId, alert.key),
    excerpt: firstValue(alert.excerpt, value.excerpt),
    behaviorTrace: firstValue(alert.behaviorTrace, value.behaviorTrace),
    confidenceRationale: firstValue(alert.confidenceRationale, value.confidenceRationale),
    advisoryId: firstValue(alert.advisoryId, value.advisoryId, alert.cve, value.cve, alert.ghsa, value.ghsa, alert.rustsec, value.rustsec, present(props?.cveId) ? props.cveId : null, present(props?.ghsaId) ? props.ghsaId : null),
    advisoryUrl: firstValue(alert.url, value.url, alert.advisoryUrl, value.advisoryUrl, props?.url),
    firstPatchedVersion: firstValue(alert.firstPatchedVersion, value.firstPatchedVersion, alert.fixedVersion, value.fixedVersion, props?.firstPatchedVersionIdentifier)
  }
}

function evidenceErrors(type, evidence) {
  const errors = []
  const isText = value => typeof value === 'string' && value.trim().length > 0
  const isUrl = value => {
    if (!isText(value)) return false
    try { return ['https:', 'http:'].includes(new URL(value).protocol) } catch { return false }
  }
  const isVersion = value => isText(value) && validVersion(value) !== null
  // Live alerts omit these enrichments; supplied values must still be usable.
  for (const [key, value] of Object.entries(evidence)) {
    if (value === null) continue
    const valid = key === 'props' ? typeof value === 'object' && !Array.isArray(value)
      : key === 'advisoryUrl' ? isUrl(value)
      : key === 'firstPatchedVersion' ? isVersion(value) : isText(value)
    if (!valid) errors.push(`invalid-${key}`)
  }
  // Validate recognized props even if a legacy top-level field takes precedence.
  for (const [key, validate] of Object.entries({ cveId: isText, ghsaId: isText, url: isUrl, firstPatchedVersionIdentifier: isVersion })) {
    const value = evidence.props?.[key]
    if (present(value) && !validate(value)) errors.push(`invalid-props.${key}`)
  }
  if (isBehavioral(type) && evidence.ruleId === null) errors.push('missing-ruleId')
  if (/cve/i.test(type) && evidence.advisoryId === null) errors.push('missing-advisory-identifier')
  if ((/cve|advisory/i.test(type) || type === 'vulnerability' || evidence.advisoryId !== null) && evidence.advisoryUrl === null) {
    errors.push('missing-advisory-url')
  }
  return errors
}

function purlBase(purl) {
  return String(purl ?? '').replace(/@[^@/]+$/, '')
}

// First-party packages (AIWG's own published packages) are reviewed in this
// repository, and Socket returns no artifact hash for them, so a first-party
// review matches by package without a hash pin. It never covers third-party code.
function isFirstParty(finding, baseline) {
  return (baseline?.firstPartyPackages ?? []).includes(purlBase(finding.purl))
}

function reviewMatches(review, finding, baseline) {
  const firstPartyReview = review.scope === 'first-party'
  if (firstPartyReview && !isFirstParty(finding, baseline)) return false
  return review.type === finding.type &&
    (review.package === '*' || review.package === finding.package) &&
    (!review.reviewedVersion || review.reviewedVersion === finding.version) &&
    review.depth === finding.depth &&
    (!isBehavioral(finding.type) || (
      Boolean(review.rationale) && (
        firstPartyReview ||
        (Boolean(review.artifactHash) && review.artifactHash === finding.evidence.artifactHash)
      )
    ))
}

function isoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value ?? '') ? value : null
}

export function evaluateSocketArtifacts({ artifacts, baseline, components, now = new Date() }) {
  const componentsByPurl = new Map()
  for (const component of components) {
    const matches = componentsByPurl.get(component.purl) ?? []
    matches.push(component)
    componentsByPurl.set(component.purl, matches)
  }
  const componentDepth = new Map(components.map(item => [item.purl, item.depth]))
  const requested = new Set(componentDepth.keys())
  const returned = new Set()
  const findings = []
  const scoreRegressions = []
  const unavailable = []
  const validationErrors = []
  const findingKeys = new Map()
  const today = now.toISOString().slice(0, 10)

  for (const artifact of artifacts) {
    if (artifact?._type === 'summary') continue
    if (artifact?._type === 'purlError') {
      unavailable.push({ purl: artifact.value?.inputPurl ?? 'unknown', reason: artifact.value?.error ?? 'purlError' })
      continue
    }
    const purl = artifactPurl(artifact)
    if (purl) returned.add(purl)
    const depth = componentDepth.get(purl) ?? (artifact.direct ? 'direct' : 'transitive')
    for (const alert of artifact.alerts ?? []) {
      const type = alertType(alert)
      if (type === 'pendingScan' || type === 'notFound') {
        unavailable.push({ purl, reason: type })
        continue
      }
      const matchingComponents = componentsByPurl.get(purl) ?? []
      const component = matchingComponents[0]
      const evidence = normalizeEvidence(artifact, alert, component)
      const errors = evidenceErrors(type, evidence)
      const originalSeverity = alertSeverity(alert)
      const rationale = evidence.confidenceRationale ?? ''
      const hasSecurityBehavior = Boolean(evidence.behaviorTrace || (
        /malicious|tamper|exfiltrat|remote execution/i.test(rationale) &&
        !/no malicious|not malicious|benign|code[- ]shape|generated|minified|test vector|ffi|platform binary/i.test(rationale)
      ))
      const severity = baseline.policy.informationalAlertTypes?.includes(type) || (/obfuscat/i.test(type) && !hasSecurityBehavior)
        ? 'informational' : originalSeverity
      const finding = {
        id: firstValue(alert.id),
        package: packageName(artifact),
        version: artifact.version ?? null,
        purl,
        depth,
        type,
        severity,
        originalSeverity: severity === originalSeverity ? null : originalSeverity,
        key: alert.key ?? null,
        provenance: matchingComponents.map(item => ({
          commitSha: item.commitSha ?? null,
          workspace: item.workspace ?? null,
          manifestPath: item.manifestPath ?? null,
          lockfilePath: item.lockfilePath ?? null,
          lockfileDigest: item.lockfileDigest ?? null,
          dependencyPath: item.dependencyPath ?? null,
          ecosystem: item.ecosystem ?? null
        })),
        evidence,
        evidenceErrors: errors,
        affectedPaths: matchingComponents.flatMap(item => item.dependencyPath ? [item.dependencyPath] : [])
      }
      if (errors.length) validationErrors.push({ purl, type, errors })
      if (finding.id && findingKeys.has(finding.id)) validationErrors.push({ id: finding.id, error: 'duplicate-finding-id' })
      if (finding.id) findingKeys.set(finding.id, true)
      const review = baseline.reviewedCapabilityAlerts.find(candidate => reviewMatches(candidate, finding, baseline))
      finding.review = review ? {
        classification: review.classification,
        rationale: review.rationale,
        artifactHash: review.artifactHash,
        owner: review.owner,
        reviewedOn: review.reviewedOn,
        expiresOn: review.expiresOn,
        expired: !isoDate(review.expiresOn) || review.expiresOn < today
      } : null
      const dedupeKey = [purl, type, evidence.ruleId ?? '', evidence.artifactHash ?? ''].join('|')
      const existing = findings.find(item => item._dedupeKey === dedupeKey)
      if (existing) {
        for (const item of matchingComponents) {
          if (!item.dependencyPath) continue
          const serialized = JSON.stringify(item.dependencyPath)
          if (!existing.affectedPaths.some(path => JSON.stringify(path) === serialized)) existing.affectedPaths.push(item.dependencyPath)
        }
      } else {
        Object.defineProperty(finding, '_dedupeKey', { value: dedupeKey, enumerable: false })
        findings.push(finding)
      }
    }

    if (depth !== 'direct') continue
    const expected = baseline.packages[packageName(artifact)]?.scores
    if (!expected || !artifact.score) continue
    for (const key of SCORE_KEYS) {
      if (!Number.isFinite(expected[key]) || !Number.isFinite(artifact.score[key])) continue
      const drop = expected[key] - artifact.score[key]
      if (drop >= baseline.policy.materialScoreDrop) {
        scoreRegressions.push({ package: packageName(artifact), category: key, baseline: expected[key], current: artifact.score[key], drop })
      }
    }
  }

  for (const purl of requested) {
    if (!returned.has(purl)) unavailable.push({ purl, reason: 'missing-response' })
  }

  const blocking = findings.filter(finding => {
    if (finding.evidenceErrors.length) return true
    if (finding.review?.expired) return true
    if (finding.review) return false
    if (finding.depth === 'direct' && CAPABILITY_ALERTS.has(finding.type)) return true
    return baseline.policy.blockingSeverities.includes(finding.severity)
  })
  const status = blocking.length || scoreRegressions.length || validationErrors.length ? 'fail' : (unavailable.length ? 'unavailable' : 'pass')
  return {
    schemaVersion: 2,
    status,
    evaluatedAt: now.toISOString(),
    summary: {
      componentsRequested: requested.size,
      componentsReturned: returned.size,
      directAlerts: findings.filter(item => item.depth === 'direct').length,
      transitiveAlerts: findings.filter(item => item.depth === 'transitive').length,
      blockingFindings: blocking.length,
      scoreRegressions: scoreRegressions.length,
      unavailable: unavailable.length,
      validationErrors: validationErrors.length
    },
    findings: {
      direct: findings.filter(item => item.depth === 'direct'),
      transitive: findings.filter(item => item.depth === 'transitive'),
      blocking,
      scoreRegressions,
      unavailable,
      validationErrors
    }
  }
}

function reportMarkdown(report, version, organization = 'AIWG') {
  const rows = [
    '# Socket post-publish audit', '',
    `- Release: \`${version}\``,
    `- Organization: ${organization}`,
    `- Status: **${report.status.toUpperCase()}**`,
    `- Evaluated: ${report.evaluatedAt}`, '',
    '| Evidence | Count |', '| --- | ---: |',
    `| Components requested | ${report.summary.componentsRequested} |`,
    `| Components returned | ${report.summary.componentsReturned} |`,
    `| Direct alerts | ${report.summary.directAlerts} |`,
    `| Transitive alerts | ${report.summary.transitiveAlerts} |`,
    `| Blocking findings | ${report.summary.blockingFindings} |`,
    `| Material score regressions | ${report.summary.scoreRegressions} |`,
    `| Unavailable/incomplete results | ${report.summary.unavailable} |`, ''
  ]
  if (report.status === 'unavailable') rows.push('The scanner did not return complete evidence. This run is not a clean result and must be retried or investigated.', '')
  if (report.findings.blocking.length) {
    rows.push('## Blocking findings', '')
    for (const finding of report.findings.blocking) rows.push(`- \`${finding.depth}\` \`${finding.package}\`: ${finding.type} (${finding.severity})`)
    rows.push('')
  }
  if (report.findings.validationErrors.length) {
    rows.push('## Export validation errors', '')
    for (const item of report.findings.validationErrors) rows.push(`- ${JSON.stringify(item)}`)
    rows.push('')
  }
  if (report.findings.scoreRegressions.length) {
    rows.push('## Material score changes', '')
    for (const item of report.findings.scoreRegressions) rows.push(`- \`${item.package}\` ${item.category}: ${item.baseline} → ${item.current}`)
    rows.push('', 'A score change triggers review; it does not by itself authorize removing supported capability.', '')
  }
  return `${rows.join('\n')}\n${scanWaitMarkdown(report.scanWait)}`
}


async function main() {
  const args = parseArgs(process.argv.slice(2))
  const version = args.version
  if (!version) throw new Error('--version is required')
  const baselinePath = resolve(args.baseline ?? 'ci/socket-score-baseline.json')
  const outputDir = resolve(args['output-dir'] ?? 'test-results/socket-post-publish')
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'))
  let components = [
    { purl: npmPurl('aiwg', version), depth: 'direct' },
    { purl: npmPurl('@aiwg/cli', version), depth: 'direct' },
    { purl: npmPurl('@aiwg/cockpit', version), depth: 'direct' },
    { purl: npmPurl('@aiwg/flue', version), depth: 'direct' }
  ]
  if (args['dependency-lock']) {
    const commitSha = args.commit ?? boundedExecFileSync('git', ['rev-parse', 'HEAD'], 'quick', { encoding: 'utf8' }).trim()
    components = []
    for (const [lockIndex, lockArg] of args['dependency-lock'].entries()) {
      const lockPath = resolve(lockArg)
      const content = await readFile(lockPath, 'utf8')
      const lockfilePath = relative(process.cwd(), lockPath)
      const provenance = {
        commitSha,
        workspace: relative(process.cwd(), dirname(lockPath)) || '.',
        manifestPath: relative(process.cwd(), resolve(dirname(lockPath), lockPath.endsWith('Cargo.lock') ? 'Cargo.toml' : 'package.json')),
        lockfilePath,
        lockfileDigest: `sha256:${sha256(content)}`,
        releaseRoot: lockIndex === 0
      }
      components.push(...(lockPath.endsWith('Cargo.lock')
        ? componentsFromCargoLock(content, provenance)
        : componentsFromLock(JSON.parse(content), version, provenance)))
    }
  }

  let artifacts
  let report
  let fetchError = null
  try {
    if (args.input) {
      const input = await readFile(resolve(args.input), 'utf8')
      artifacts = input.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    } else {
      const token = process.env.SOCKET_API_TOKEN
      const orgSlug = process.env.SOCKET_ORG_SLUG
      if (!token || !orgSlug) throw new Error('Socket audit credentials are unavailable')
      const paceMinutes = Number(args['pace-quota-minutes'] ?? process.env.SOCKET_PACE_QUOTA_MINUTES ?? 0)
      if (!Number.isFinite(paceMinutes) || paceMinutes < 0) throw new Error('--pace-quota-minutes must be a non-negative number')
      const batchSize = Number(args['batch-size'] ?? process.env.SOCKET_PURL_BATCH_SIZE ?? SOCKET_PURL_BATCH_SIZE)
      if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error('--batch-size must be a positive integer')
      report = await auditWithPendingScans({ components, version, baseline, evaluate: evaluateSocketArtifacts, token, orgSlug, paceQuotaMs: paceMinutes * 60_000, batchSize })
    }
  } catch (error) {
    fetchError = error instanceof Error ? error.message : String(error)
    artifacts = []
  }

  report ??= evaluateSocketArtifacts({ artifacts, baseline, components })
  if (fetchError) report.findings.unavailable.unshift({ purl: '*', reason: fetchError })
  if (fetchError) {
    report.status = 'unavailable'
    report.summary.unavailable = report.findings.unavailable.length
  }
  await mkdir(outputDir, { recursive: true })
  await writeFile(resolve(outputDir, 'socket-audit.json'), `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(resolve(outputDir, 'socket-audit.md'), reportMarkdown(report, version, args.organization ?? baseline.organization ?? process.env.SOCKET_ORG_SLUG ?? 'AIWG'))
  console.log(`Socket post-publish audit: ${report.status} (${report.summary.directAlerts} direct, ${report.summary.transitiveAlerts} transitive alerts)`)
  if (report.status !== 'pass') process.exitCode = report.status === 'unavailable' ? 2 : 1
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? basename(import.meta.url))).href) {
  main().catch(error => {
    console.error(`Socket post-publish audit failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  })
}
