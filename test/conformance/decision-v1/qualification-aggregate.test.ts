import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  artifactPin, buildQualificationReleaseRecord, captureQualificationLifetime, DECISION_GATE_SUITES, decisionResultForExport,
  evaluateDecisionRuleset, evaluateExecutedQualification, executeQualificationPlan, FileDecisionReceiptStore, JevDecisionAdapter,
  QUALIFICATION_CACHE_LAYERS, qualificationReleaseSummary, scanQualificationPrivacy, withQualificationPrivacyScan,
  writeQualificationEvidenceManifest, type DecisionBinding, type DecisionDefinition, type DecisionRuleset,
  type DecisionProjectionPolicy, type DecisionTelemetrySpan, type QualificationCacheLayerEvidence, type QualificationPrivacyCapture,
} from '../../../src/decision/index.js';
import { buildIntegrityMetadata } from '../../../tools/eval/src/integrity.js';
import { DECISION_CASE_COVERAGE } from './coverage-map.js';
import { CACHE_LAYERS, executors as layerExecutors } from './vectors/layers.js';
import { loadQualificationRegistry, QUALIFICATION_VECTOR_SUITES } from './vectors/registry.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

// Files whose `C01: () => ...` style callbacks exercise runner mechanics, not vectors.
const RUNNER_MECHANICS = new Set([
  'test/unit/decision/qualification-runner.test.ts',
  'test/unit/decision/qualification-release.test.ts',
  'test/unit/decision/qualification-gates.test.ts',
]);

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory()
    ? sourceFiles(join(dir, entry.name)) : Promise.resolve(entry.name.endsWith('.ts') ? [join(dir, entry.name)] : [])));
  return nested.flat();
}

/** Case IDs defined as executor callbacks (`C31: async () =>`), by file. */
async function executorDefinitions(): Promise<Map<string, Set<string>>> {
  const found = new Map<string, Set<string>>();
  for (const dir of ['test/conformance/decision-v1', 'test/unit/decision']) {
    for (const file of await sourceFiles(dir)) {
      const path = relative(process.cwd(), file);
      if (RUNNER_MECHANICS.has(path)) continue;
      const ids = [...(await readFile(file, 'utf8')).matchAll(/^\s+((?:C|TV)\d{2}): (?:async )?\(/gm)].map(match => match[1]!);
      if (ids.length) found.set(path, new Set(ids));
    }
  }
  return found;
}

// Credential values the vectors hand to adapters. None may reach any output surface.
const CANARIES = ['synthetic-credential', 'synthetic-canary-credential', 'offline-fixture', 'aggregate-canary-credential'];
const sha = (value: unknown) => `sha256:${createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')}` as const;

async function filesUnder(dir: string): Promise<string> {
  const parts: string[] = [];
  for (const file of (await sourceFilesAll(dir)).sort()) parts.push(await readFile(file, 'utf8'));
  return parts.join('\n');
}
async function sourceFilesAll(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? sourceFilesAll(join(dir, entry.name))
    : Promise.resolve([join(dir, entry.name)])))).flat();
}
const fixture = async <T>(name: string): Promise<T> => JSON.parse(await readFile(`agentic/code/addons/decision-engine/examples/${name}`, 'utf8')) as T;

/** A telemetry-, receipt- and export-producing evaluation whose credential is a canary. */
async function privacyProbe(receipts: string, spans: DecisionTelemetrySpan[], activity: unknown[]) {
  const policy = await fixture<DecisionProjectionPolicy>('projection-policy-jev.json');
  const answers = (body: Record<string, any>) => Object.fromEntries(Object.entries(body.questions as Record<string, any>).map(([id, q]) => [id,
    q.type === 'choice' ? { type: 'choice', choice: 'documentation', confidence: 0.9, probabilities: { documentation: 1, runtime: 0, other: 0 } }
      : q.type === 'score' ? { type: 'score', score: 0, confidence: 0.8, probabilities: Object.fromEntries((q.criteria as unknown[]).map((_, i) => [i, i ? 0 : 1])),
        legend: Object.fromEntries((q.criteria as unknown[]).map((level, i) => [i, level])) } : { type: 'noul', noul: 0.05 }]));
  const result = await evaluateDecisionRuleset({ ruleset: await fixture<DecisionRuleset>('ruleset.json'),
    binding: await fixture<DecisionBinding>('binding-jev.json'), definitions: { category: await fixture<DecisionDefinition>('decision-category.json'),
      severity: await fixture<DecisionDefinition>('decision-severity.json'), core: await fixture<DecisionDefinition>('decision-core_unavailable.json') },
    input: await fixture('input.json'), runId: 'privacy-probe', invocationId: 'privacy-probe',
    adapters: { jev: new JevDecisionAdapter({ region: policy.region, fetch: async (_url, init) => new Response(JSON.stringify({ model: 'jev-fixture',
      usage: { input_tokens: 1, output_tokens: 1 }, answers: answers(JSON.parse(String(init?.body))) }),
    { headers: { 'x-typesafe-request-id': 'req_probe_1' } }) }) },
    resolveCredential: async () => new TextEncoder().encode('aggregate-canary-credential'),
    receiptStore: new FileDecisionReceiptStore(receipts, { integrityKey: new Uint8Array(32).fill(7) }),
    // Projection evidence is host-visible activity, so it is scanned as the activity-record surface.
    projection: { resolve: () => structuredClone(policy), onEvidence: value => { activity.push(structuredClone(value)); } },
    telemetry: { hook: { emit: span => { spans.push(span); } } } });
  return decisionResultForExport(result);
}

describe('D11 aggregate qualification run', () => {
  it('maps every hinted case to a registered executor from that suite, and every executor to its hint', async () => {
    const registry = await loadQualificationRegistry();
    for (const item of DECISION_CASE_COVERAGE) {
      const suite = registry.suiteByCase[item.id];
      if (item.candidateTests.length) {
        expect(suite, `${item.id} is mapped but has no registered executor`).toBeDefined();
        expect(item.candidateTests).toContain(suite!.suite);
      } else {
        expect(suite, `${item.id} has an executor but no coverage hint`).toBeUndefined();
      }
    }
    for (const caseId of Object.keys(registry.executors)) {
      expect(DECISION_CASE_COVERAGE.map(item => item.id)).toContain(caseId);
    }
  });

  it('finds no executor defined in the repository that is missing from the registry', async () => {
    const registry = await loadQualificationRegistry();
    const modules = new Map(QUALIFICATION_VECTOR_SUITES.map(suite => [suite.module, suite]));
    const definitions = await executorDefinitions();
    // Every registered module is found by the scan, so an empty scan cannot pass vacuously.
    expect([...definitions.keys()].sort()).toEqual([...modules.keys()].sort());
    for (const [file, ids] of definitions) {
      expect(modules.has(file), `${file} defines vector executors outside the registry`).toBe(true);
      for (const id of ids) expect(registry.suiteByCase[id]?.module, `${id} in ${file}`).toBe(file);
    }
  });

  it('runs every registered executor in one run and binds each outcome to a verified digest', async () => {
    const registry = await loadQualificationRegistry();
    const root = await mkdtemp(join(tmpdir(), 'decision-aggregate-')); roots.push(root);
    const cases = DECISION_CASE_COVERAGE.map(item => registry.evidenceIds[item.id]
      ? { ...item, evidenceIds: [...registry.evidenceIds[item.id]!] } : item);
    const run = await executeQualificationPlan({
      artifactRoot: root, executors: registry.executors, concurrency: 1, timeoutMs: 60_000,
      manifest: { schemaVersion: 'decision-qualification-run/v1', mode: 'offline', runId: 'd11-aggregate',
        generatedAt: '2026-09-24T00:00:00.000Z', sourceCommit: 'working-tree', dirty: true, cases },
    });
    const registered = new Set(Object.keys(registry.executors));
    const failures = run.evidence.filter(item => registered.has(item.caseId) && item.outcome !== 'pass').map(item => item.caseId);
    expect(failures).toEqual([]);
    for (const item of run.evidence) {
      if (registered.has(item.caseId)) {
        expect(item).toMatchObject({ executable: true, outcome: 'pass' });
        expect(item.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      } else {
        expect(item).toMatchObject({ executable: false, outcome: 'skip' });
      }
    }

    const evaluated = await evaluateExecutedQualification(run, root);
    expect(evaluated.verification.every(item => item.verified)).toBe(true);
    const unregistered = cases.map(item => item.id).filter(id => !registered.has(id));
    const g0 = evaluated.report.gates.find(gate => gate.id === 'G0')!;
    expect(g0.missing).toEqual(unregistered.map(id => `case:${id}`).sort());
    // Suite flags come from the recorded run, not from callbacks.
    for (const name of Object.keys(DECISION_GATE_SUITES)) expect(run.evidenceFlags[name], name).toBe(true);
    expect(evaluated.report.decision).toBe('HOLD');

    const executed = { ...run, evidence: run.evidence.filter(item => registered.has(item.caseId)) };
    const linked = await writeQualificationEvidenceManifest(executed, root, process.cwd(), Object.fromEntries(
      Object.entries(registry.suiteByCase).map(([caseId, suite]) => [caseId, [suite.suite, suite.module, ...suite.sources]]),
    ));
    expect(linked.manifest.evidence).toHaveLength(registered.size);
    expect(linked.manifest.evidence.every(item => item.sourceGoldens.length >= 2)).toBe(true);
  }, 120_000);

  it('AC10/AC11 scans every surface of the whole run and emits a HOLD release record bound to its evidence', async () => {
    const registry = await loadQualificationRegistry();
    const root = await mkdtemp(join(tmpdir(), 'decision-aggregate-release-'));
    const receipts = await mkdtemp(join(tmpdir(), 'decision-aggregate-receipts-'));
    roots.push(root, receipts);
    const cases = DECISION_CASE_COVERAGE.map(item => registry.evidenceIds[item.id]
      ? { ...item, evidenceIds: [...registry.evidenceIds[item.id]!] } : item);
    const spans: DecisionTelemetrySpan[] = [];
    const activity: unknown[] = [];
    const captured = await captureQualificationLifetime(async () => {
      const run = await executeQualificationPlan({
        artifactRoot: root, executors: registry.executors, concurrency: 1, timeoutMs: 60_000,
        manifest: { schemaVersion: 'decision-qualification-run/v1', mode: 'offline', runId: 'd11-aggregate-release',
          generatedAt: '2026-09-24T00:00:00.000Z', sourceCommit: 'working-tree', dirty: true, cases },
      });
      const exported = await privacyProbe(receipts, spans, activity);
      const linked = await writeQualificationEvidenceManifest(run, root, process.cwd(), Object.fromEntries(
        Object.entries(registry.suiteByCase).map(([caseId, suite]) => [caseId, [suite.suite, suite.module, ...suite.sources]])));
      return { run, exported, linked };
    });
    expect(captured.threw).toBe(false);
    const { run, exported, linked } = captured.result!;
    expect(spans.length).toBeGreaterThan(0);
    expect(activity.length).toBeGreaterThan(0);
    const captures: QualificationPrivacyCapture[] = [...captured.captures,
      { surface: 'trace', content: JSON.stringify(spans) },
      { surface: 'receipt', content: await filesUnder(receipts) },
      { surface: 'export', content: JSON.stringify(exported) },
      { surface: 'snapshot', content: await filesUnder(root) },
      { surface: 'test-report', content: JSON.stringify(linked.manifest) },
      { surface: 'activity-record', content: JSON.stringify(activity) }];
    expect(scanQualificationPrivacy(captures, CANARIES)).toEqual({ clean: true, missing: [], affected: [] });
    const scanned = withQualificationPrivacyScan(run, captures, CANARIES);
    const evaluated = await evaluateExecutedQualification(scanned, root);
    const status = Object.fromEntries(evaluated.report.gates.map(gate => [gate.id, gate.status]));
    // Recorded suites carry G0, G1, G2 and G4. Held-out data, load results and a reviewer are #2684 inputs.
    expect(status).toEqual({ G0: 'pass', G1: 'pass', G2: 'pass', G3: 'fail', G4: 'pass', G5: 'fail', G6: 'fail' });
    expect(evaluated.report.gates.find(gate => gate.id === 'G6')!.missing).toEqual(['evidence:review-decision-recorded']);

    // AC15: each cache layer is a separate verified run, and its manifest digest becomes the release pin.
    const cacheLayers = {} as Record<(typeof QUALIFICATION_CACHE_LAYERS)[number], QualificationCacheLayerEvidence>;
    for (const layer of QUALIFICATION_CACHE_LAYERS) {
      const spec = CACHE_LAYERS[layer];
      const layerRun = await executeQualificationPlan({ artifactRoot: root, executors: { [spec.caseId]: layerExecutors[spec.caseId]! },
        manifest: { schemaVersion: 'decision-qualification-run/v1', mode: 'offline', runId: spec.runId,
          generatedAt: '2026-09-24T00:00:00.000Z', sourceCommit: 'working-tree', dirty: true,
          cases: [{ id: spec.caseId, kind: 'baseline', mandatory: true, candidateTests: [] }] } });
      expect(layerRun.evidence[0]).toMatchObject({ outcome: 'pass' });
      cacheLayers[layer] = await writeQualificationEvidenceManifest(layerRun, root, process.cwd(), { [spec.caseId]: [...spec.sources] });
    }
    const [ruleset, binding, category] = await Promise.all([fixture<DecisionRuleset>('ruleset.json'),
      fixture<DecisionBinding>('binding-jev.json'), fixture<DecisionDefinition>('decision-category.json')]);
    const record = buildQualificationReleaseRecord(evaluated, {
      commands: ['npx vitest run --config config/vitest.config.js test/conformance/decision-v1/qualification-aggregate.test.ts'],
      environment: `offline-aggregate node-${process.versions.node}`,
      pins: { definition: artifactPin(category).digest, ruleset: artifactPin(ruleset).digest, binding: artifactPin(binding).digest,
        adapter: sha('jev@1.0.0'), requestedModel: sha('jev-latest'), servedModel: sha('jev-fixture'), policy: sha('typed-value'),
        calibration: sha(await readFile('test/fixtures/decision/calibration-compatibility-cross-product-v1.json', 'utf8')),
        dataset: sha(await readFile('test/fixtures/decision/vendor-vectors-v1.json', 'utf8')), split: sha('no-heldout-split'),
        seed: sha('seed:none'), priceCatalog: sha('price-catalog:none') },
      budgets: { providerCalls: 0 }, actuals: { providerCalls: 0 }, reviewer: null, cacheLayers,
      // The offline vector pass rate, without a protected-artifact snapshot: integrity is not assessed, so HOLD.
      integrity: buildIntegrityMetadata({ mode: 'standard', freshWorkspaceRequired: false, freshWorkspaceVerified: false,
        changedArtifacts: [], sampleN: run.evidence.length, overallScore: 100,
        passedN: run.evidence.filter(item => item.outcome === 'pass').length }),
    });
    expect(record.decision).toBe('HOLD');
    expect(record.suites).toHaveLength(67);
    expect(record.suites.every(item => item.outcome === 'pass' && item.verified)).toBe(true);
    expect(record.pins.compilePrefixCache).toBe(cacheLayers.compilePrefixCache.digest);
    expect(new Set([record.pins.compilePrefixCache, record.pins.receiptReplay, record.pins.resultCache]).size).toBe(3);
    const summary = qualificationReleaseSummary(record);
    expect(summary).toContain('Decision: HOLD');
    expect(CANARIES.some(canary => summary.includes(canary) || JSON.stringify(record).includes(canary))).toBe(false);
  }, 120_000);

  it('PRV-LIFETIME-01 detects a canary written to any process stream during the captured run', async () => {
    const leaked = await captureQualificationLifetime(async () => {
      console.warn('diagnostic', { token: 'aggregate-canary-credential' });
      throw new Error('failed with synthetic-credential');
    });
    expect(leaked.threw).toBe(true);
    const others = (['trace', 'receipt', 'export', 'snapshot', 'test-report'] as const).map(surface => ({ surface, content: '' }));
    expect(scanQualificationPrivacy([...leaked.captures, ...others], CANARIES).affected).toEqual(['stderr', 'thrown-error']);
  });
});
