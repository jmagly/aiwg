import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  artifactPin, buildQualificationReleaseRecord, captureQualificationLifetime, decisionResultForExport,
  evaluateDecisionRuleset, evaluateExecutedQualification, executeQualificationPlan, FileDecisionReceiptStore, JevDecisionAdapter,
  QUALIFICATION_CACHE_LAYERS, scanQualificationPrivacy, withQualificationPrivacyScan,
  writeQualificationEvidenceManifest, type DecisionBinding, type DecisionDefinition, type DecisionRuleset,
  type DecisionProjectionPolicy, type DecisionTelemetrySpan, type QualificationCacheLayerEvidence,
  type QualificationEvidenceManifest, type QualificationPrivacyCapture, type QualificationReleaseRecord,
} from '../../../src/decision/index.js';
import { buildIntegrityMetadata } from '../../../tools/eval/src/integrity.js';
import { DECISION_CASE_COVERAGE } from './coverage-map.js';
import { CACHE_LAYERS, executors as layerExecutors } from './vectors/layers.js';
import { loadQualificationRegistry } from './vectors/registry.js';

/**
 * The D11 aggregate release pipeline: every registered vector in one offline run,
 * the full-lifetime privacy scan, three separate cache-layer runs, and the
 * release record. Used to produce the retained exact-commit record in
 * docs/decision/evidence/d11-aggregate-release-v1 and to re-run it for comparison.
 */
export const AGGREGATE_CANARIES = ['synthetic-credential', 'synthetic-canary-credential', 'offline-fixture', 'aggregate-canary-credential'];
export const AGGREGATE_RELEASE_COMMAND = 'AIWG_D11_RELEASE_OUT=docs/decision/evidence/d11-aggregate-release-v1 AIWG_D11_SOURCE_COMMIT=<sha> '
  + 'npx vitest run --config config/vitest.config.js test/conformance/decision-v1/qualification-release-evidence.test.ts';

const sha = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}` as const;
const example = async <T>(name: string): Promise<T> =>
  JSON.parse(await readFile(`agentic/code/addons/decision-engine/examples/${name}`, 'utf8')) as T;
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? filesUnder(join(dir, entry.name))
    : Promise.resolve([join(dir, entry.name)])))).flat();
}
async function contentUnder(dir: string): Promise<string> {
  const parts: string[] = [];
  for (const file of (await filesUnder(dir)).sort()) parts.push(await readFile(file, 'utf8'));
  return parts.join('\n');
}

/** A telemetry-, receipt- and export-producing evaluation whose credential is a canary. */
async function privacyProbe(receipts: string, spans: DecisionTelemetrySpan[], activity: unknown[]) {
  const policy = await example<DecisionProjectionPolicy>('projection-policy-jev.json');
  const answers = (body: Record<string, any>) => Object.fromEntries(Object.entries(body.questions as Record<string, any>).map(([id, q]) => [id,
    q.type === 'choice' ? { type: 'choice', choice: 'documentation', confidence: 0.9, probabilities: { documentation: 1, runtime: 0, other: 0 } }
      : q.type === 'score' ? { type: 'score', score: 0, confidence: 0.8, probabilities: Object.fromEntries((q.criteria as unknown[]).map((_, i) => [i, i ? 0 : 1])),
        legend: Object.fromEntries((q.criteria as unknown[]).map((level, i) => [i, level])) } : { type: 'noul', noul: 0.05 }]));
  const result = await evaluateDecisionRuleset({ ruleset: await example<DecisionRuleset>('ruleset.json'),
    binding: await example<DecisionBinding>('binding-jev.json'), definitions: { category: await example<DecisionDefinition>('decision-category.json'),
      severity: await example<DecisionDefinition>('decision-severity.json'), core: await example<DecisionDefinition>('decision-core_unavailable.json') },
    input: await example('input.json'), runId: 'privacy-probe', invocationId: 'privacy-probe',
    adapters: { jev: new JevDecisionAdapter({ region: policy.region, fetch: async (_url, init) => new Response(JSON.stringify({ model: 'jev-fixture',
      usage: { input_tokens: 1, output_tokens: 1 }, answers: answers(JSON.parse(String(init?.body))) }),
    { headers: { 'x-typesafe-request-id': 'req_probe_1' } }) }) },
    resolveCredential: async () => new TextEncoder().encode('aggregate-canary-credential'),
    receiptStore: new FileDecisionReceiptStore(receipts, { integrityKey: new Uint8Array(32).fill(7) }),
    projection: { resolve: () => structuredClone(policy), onEvidence: value => { activity.push(structuredClone(value)); } },
    telemetry: { hook: { emit: span => { spans.push(span); } } } });
  return decisionResultForExport(result);
}

export interface AggregateReleaseRun {
  record: QualificationReleaseRecord;
  evidenceManifest: { manifest: QualificationEvidenceManifest; digest: `sha256:${string}` };
  /** Artifact-root-relative paths of the written evidence manifests (main run first, then each cache layer). */
  manifestFiles: { main: string } & Record<(typeof QUALIFICATION_CACHE_LAYERS)[number], string>;
  cacheLayers: Record<(typeof QUALIFICATION_CACHE_LAYERS)[number], QualificationCacheLayerEvidence>;
  privacyClean: boolean;
}

export async function runAggregateRelease(options: {
  root: string; receipts: string; runId: string; sourceCommit: string; dirty: boolean; generatedAt: string;
}): Promise<AggregateReleaseRun> {
  const { root, receipts, runId, sourceCommit, dirty, generatedAt } = options;
  const registry = await loadQualificationRegistry();
  const cases = DECISION_CASE_COVERAGE.map(item => registry.evidenceIds[item.id]
    ? { ...item, evidenceIds: [...registry.evidenceIds[item.id]!] } : item);
  const spans: DecisionTelemetrySpan[] = [];
  const activity: unknown[] = [];
  const sources = Object.fromEntries(Object.entries(registry.suiteByCase)
    .map(([caseId, suite]) => [caseId, [suite.suite, suite.module, ...suite.sources]]));
  const captured = await captureQualificationLifetime(async () => {
    const run = await executeQualificationPlan({
      artifactRoot: root, executors: registry.executors, concurrency: 1, timeoutMs: 60_000,
      manifest: { schemaVersion: 'decision-qualification-run/v1', mode: 'offline', runId, generatedAt, sourceCommit, dirty, cases },
    });
    const exported = await privacyProbe(receipts, spans, activity);
    const linked = await writeQualificationEvidenceManifest(run, root, process.cwd(), sources);
    return { run, exported, linked };
  });
  if (captured.threw || !captured.result) throw new Error('aggregate qualification run threw');
  const { run, exported, linked } = captured.result;
  const captures: QualificationPrivacyCapture[] = [...captured.captures,
    { surface: 'trace', content: JSON.stringify(spans) },
    { surface: 'receipt', content: await contentUnder(receipts) },
    { surface: 'export', content: JSON.stringify(exported) },
    { surface: 'snapshot', content: await contentUnder(root) },
    { surface: 'test-report', content: JSON.stringify(linked.manifest) },
    { surface: 'activity-record', content: JSON.stringify(activity) }];
  const privacyClean = scanQualificationPrivacy(captures, AGGREGATE_CANARIES).clean;
  const evaluated = await evaluateExecutedQualification(withQualificationPrivacyScan(run, captures, AGGREGATE_CANARIES), root);

  const cacheLayers = {} as AggregateReleaseRun['cacheLayers'];
  const manifestFiles = { main: linked.artifact } as AggregateReleaseRun['manifestFiles'];
  for (const layer of QUALIFICATION_CACHE_LAYERS) {
    const spec = CACHE_LAYERS[layer];
    const layerRun = await executeQualificationPlan({ artifactRoot: root, executors: { [spec.caseId]: layerExecutors[spec.caseId]! },
      manifest: { schemaVersion: 'decision-qualification-run/v1', mode: 'offline', runId: spec.runId, generatedAt, sourceCommit, dirty,
        cases: [{ id: spec.caseId, kind: 'baseline', mandatory: true, candidateTests: [] }] } });
    if (layerRun.evidence[0]?.outcome !== 'pass') throw new Error(`cache layer ${layer} did not pass`);
    const written = await writeQualificationEvidenceManifest(layerRun, root, process.cwd(), { [spec.caseId]: [...spec.sources] });
    cacheLayers[layer] = { manifest: written.manifest, digest: written.digest };
    manifestFiles[layer] = written.artifact;
  }
  const [ruleset, binding, category] = await Promise.all([example<DecisionRuleset>('ruleset.json'),
    example<DecisionBinding>('binding-jev.json'), example<DecisionDefinition>('decision-category.json')]);
  const record = buildQualificationReleaseRecord(evaluated, {
    commands: [AGGREGATE_RELEASE_COMMAND],
    environment: `offline-aggregate node-${process.versions.node.split('.')[0]}`,
    pins: { definition: artifactPin(category).digest, ruleset: artifactPin(ruleset).digest, binding: artifactPin(binding).digest,
      adapter: sha('jev@1.0.0'), requestedModel: sha('jev-latest'), servedModel: sha('jev-fixture'), policy: sha('typed-value'),
      calibration: sha(await readFile('test/fixtures/decision/calibration-compatibility-cross-product-v1.json', 'utf8')),
      dataset: sha(await readFile('test/fixtures/decision/vendor-vectors-v1.json', 'utf8')), split: sha('no-heldout-split'),
      seed: sha('seed:none'), priceCatalog: sha('price-catalog:none') },
    budgets: { providerCalls: 0 }, actuals: { providerCalls: 0 }, reviewer: null, cacheLayers,
    // Offline vector pass rate with no protected-artifact snapshot: integrity is not assessed, so HOLD.
    integrity: buildIntegrityMetadata({ mode: 'standard', freshWorkspaceRequired: false, freshWorkspaceVerified: false,
      changedArtifacts: [], sampleN: run.evidence.length, overallScore: 100,
      passedN: run.evidence.filter(item => item.outcome === 'pass').length }),
  });
  return { record, evidenceManifest: { manifest: linked.manifest, digest: linked.digest }, manifestFiles, cacheLayers, privacyClean };
}
