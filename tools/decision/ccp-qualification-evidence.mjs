#!/usr/bin/env node
/**
 * Regenerate the retained D30 compile/prefix cache (CCP) qualification evidence.
 *
 * Requires a clean working tree and a current `npm run build:cli`. It runs the
 * CCP suites, maps them to the G0/G1/G2/G5 cases, executes the preregistered
 * offline benchmark and enforces its minimum benefit target. Offline only: no
 * provider request is made.
 *
 * Usage: node tools/decision/ccp-qualification-evidence.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  FileCompileCache, JevDecisionAdapter, cacheBenchmarkReport, compileCacheKey, evaluateCacheBenchmarkTarget,
  executeQualificationPlan, pairedPreparationLatencyInterval, prepareAdapterRequest, verifyQualificationArtifacts,
  writeQualificationEvidenceManifest, DECISION_LIFECYCLE_SURFACES, DECISION_LIFECYCLE_VERSION,
} from '../../dist/src/decision/index.js';

const root = process.cwd();
const evidenceRoot = 'docs/decision/evidence/compile-cache-ccp-v1';
const runId = 'd30-ccp-offline-v1';
const suites = ['test/unit/decision/compile-cache.test.ts', 'test/unit/decision/compile-cache-closure.test.ts'];

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const sourceCommit = git('rev-parse', 'HEAD');
const dirty = git('status', '--porcelain', '--untracked-files=no').length > 0;
if (!/^[0-9a-f]{40}$/.test(sourceCommit) || dirty) {
  process.stderr.write('CCP evidence requires a clean working tree at an exact commit.\n');
  process.exit(2);
}

// Gate mapping: each case passes only if every CCP test carrying its IDs passed.
const cases = [
  { id: 'D30-CCP-G0', gate: 'G0', evidenceIds: ['CCP-002', 'CCP-003', 'CCP-009', 'CCP-SCHEMA'] },
  { id: 'D30-CCP-G1', gate: 'G1', evidenceIds: ['CCP-001', 'CCP-004', 'CCP-007', 'CCP-012', 'CCP-013', 'CCP-014'] },
  { id: 'D30-CCP-G2', gate: 'G2', evidenceIds: ['CCP-005', 'CCP-006', 'CCP-008', 'CCP-010', 'CCP-015'] },
  { id: 'D30-CCP-G5', gate: 'G5', evidenceIds: ['CCP-011'] },
];

const scratch = await mkdtemp(join(tmpdir(), 'ccp-evidence-'));
try {
  const report = join(scratch, 'vitest.json');
  try {
    execFileSync(join(root, 'node_modules/.bin/vitest'), ['run', '--config', 'config/vitest.config.js', ...suites,
      '--reporter=json', `--outputFile=${report}`], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  } catch { /* failures are read from the report below */ }
  const tests = JSON.parse(await readFile(report, 'utf8')).testResults
    .flatMap(file => file.assertionResults.map(test => ({ id: /^(CCP-[A-Z0-9]+)/.exec(test.title)?.[1] ?? null,
      title: test.title, status: test.status })));

  const plan = JSON.parse(await readFile(join(evidenceRoot, 'benchmark-plan.json'), 'utf8'));
  const benchmark = await runBenchmark(plan);
  await writeFile(join(evidenceRoot, 'benchmark-report.json'), `${JSON.stringify(benchmark, null, 2)}\n`);

  await rm(join(evidenceRoot, runId), { recursive: true, force: true });
  const suitePassed = ids => ids.every(id => tests.some(test => test.id === id))
    && tests.filter(test => ids.includes(test.id)).every(test => test.status === 'passed');
  const run = await executeQualificationPlan({
    artifactRoot: evidenceRoot,
    manifest: { schemaVersion: 'decision-qualification-run/v1', mode: 'offline', runId, generatedAt: new Date().toISOString(),
      sourceCommit, dirty, cases: cases.map(item => ({ id: item.id, kind: 'baseline', mandatory: true,
        candidateTests: suites, evidenceIds: item.evidenceIds })) },
    executors: Object.fromEntries(cases.map(item => [item.id, () => {
      const selected = tests.filter(test => item.evidenceIds.includes(test.id)).map(({ id, status }) => ({ id, status }));
      const passed = suitePassed(item.evidenceIds) && (item.gate !== 'G5' || benchmark.target.outcome === 'pass');
      return { outcome: passed ? 'pass' : 'fail', details: { gate: item.gate, tests: selected,
        ...(item.gate === 'G5' ? { benchmarkTarget: benchmark.target } : {}) } };
    }])),
    sanitizeDetails: details => details,
    timeoutMs: 60_000,
  });
  const verification = await verifyQualificationArtifacts(run, evidenceRoot);
  if (verification.some(item => !item.verified)) throw new Error('CCP artifacts failed verification');
  await writeFile(join(evidenceRoot, runId, 'run-manifest.json'), `${JSON.stringify(run, null, 2)}\n`);
  const schemas = ['DecisionCompileCacheIdentity.v1', 'DecisionCompileCacheEntry.v1', 'DecisionCompileCacheTombstone.v1',
    'DecisionProviderPrefixIdentity.v1', 'DecisionProviderPrefixCompatibility.v1', 'DecisionCacheTelemetry.v1']
    .map(name => `schemas/decision/${name}.schema.json`);
  const linked = await writeQualificationEvidenceManifest(run, evidenceRoot, resolve(root), {
    'D30-CCP-G0': [...schemas, ...suites], 'D30-CCP-G1': suites, 'D30-CCP-G2': suites,
    'D30-CCP-G5': [`${evidenceRoot}/benchmark-plan.json`, `${evidenceRoot}/benchmark-report.json`],
  });
  process.stdout.write(`${JSON.stringify({ runId, sourceCommit, manifest: `${evidenceRoot}/${linked.artifact}`,
    digest: linked.digest, outcomes: Object.fromEntries(run.evidence.map(item => [item.caseId, item.outcome])),
    benchmarkTarget: benchmark.target })}\n`);
} finally { await rm(scratch, { recursive: true, force: true }); }

async function runBenchmark(plan) {
  const definition = JSON.parse(await readFile(plan.definition, 'utf8'));
  const binding = JSON.parse(await readFile('examples/decision/binding-jev.json', 'utf8'));
  const target = binding.spec.evaluations.category.targets[0];
  const adapter = new JevDecisionAdapter({ fetch: async () => { throw new Error('offline benchmark never dispatches'); } });
  const rule = { classification: 'internal', accessScopes: ['decision-runtime'], retentionMs: 3_600_000, export: 'denied',
    deletion: 'tombstone', backup: 'expire-with-primary' };
  const lifecyclePolicy = { version: DECISION_LIFECYCLE_VERSION,
    surfaces: Object.fromEntries(DECISION_LIFECYCLE_SURFACES.map(surface => [surface, rule])) };
  const directory = await mkdtemp(join(tmpdir(), 'ccp-benchmark-'));
  try {
    const store = new FileCompileCache(directory, { lifecyclePolicy });
    const identity = { identityVersion: 'decision-compile-cache-identity/v1', layer: 'adapter-compilation',
      sourceArtifactDigests: [`sha256:${'a'.repeat(64)}`], compiler: { id: 'jev-adapter', version: plan.adapter.version },
      runtimeVersion: process.version, schemaVersion: definition.apiVersion, canonicalizer: { id: 'rfc8785', version: '1' },
      adapter: { id: 'jev', version: plan.adapter.version, promptVersion: plan.adapter.compiledFormat },
      backendCapabilityMode: 'typed-output', modelPolicy: { requested: target.model, compatibleActualModels: [] },
      featureFlags: {}, tenantId: 'benchmark', projectId: 'benchmark', dataClass: 'internal' };
    const policy = enabled => ({ enabled, ttlMs: 3_600_000, store, identityFor: () => identity,
      context: () => ({ tenantId: 'benchmark', projectId: 'benchmark', nowEpochMs: Date.now(), authorize: () => true }) });
    const request = { alias: 'category', definition, input: {}, target, invocationId: 'benchmark', deadlineEpochMs: 0,
      signal: new AbortController().signal, resolveCredential: async () => new Uint8Array() };
    const bodies = new Set();
    for (let index = 0; index < plan.warmupCalls; index++) {
      for (const enabled of [false, true]) bodies.add(JSON.stringify((await prepareAdapterRequest(request, adapter, policy(enabled))).compiledArtifact));
    }
    const samples = []; const disabled = []; const enabled = [];
    for (let index = 0; index < plan.measuredPairs; index++) {
      for (const cached of [false, true]) {
        let outcome = 'bypass';
        const measured = { ...policy(cached), onResult: value => { outcome = value.outcome; } };
        const started = performance.now();
        const prepared = await prepareAdapterRequest(request, adapter, measured);
        const latency = performance.now() - started;
        bodies.add(JSON.stringify(prepared.compiledArtifact));
        (cached ? enabled : disabled).push(latency);
        samples.push({ mode: cached ? 'cache-enabled' : 'cache-disabled', preparationLatencyMs: latency, inputTokens: null,
          outputTokens: null, cachedInputTokens: null, costUsd: null,
          memoryBytes: Buffer.byteLength(JSON.stringify(prepared.compiledArtifact)),
          storageBytes: cached ? (await readFile(join(directory, `${compileCacheKey(identity).slice(7)}.json`))).length : 0,
          outcome, invalidated: false });
      }
    }
    if (bodies.size !== 1) throw new Error('cache and no-cache compiled artifacts diverged');
    const report = cacheBenchmarkReport(compileCacheKey(identity), plan.warmupCalls, plan.minimumBenefitTargetBps,
      pairedPreparationLatencyInterval(disabled, enabled), samples);
    return { schemaVersion: 'decision-cache-benchmark-result/v1', planId: plan.id, sourceCommit,
      environment: { node: process.version, platform: process.platform, arch: process.arch },
      report, target: evaluateCacheBenchmarkTarget(report), productionLatencyQualification: false };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
