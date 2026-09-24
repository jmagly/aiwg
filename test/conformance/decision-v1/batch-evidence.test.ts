import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decisionBatchBenchmarkReport,
  evaluateDecisionRuleset,
  executeQualificationPlan,
  JevDecisionAdapter,
  verifyQualificationArtifacts,
  writeQualificationEvidenceManifest,
  type DecisionBatchBenchmarkSample,
  type DecisionBinding,
  type DecisionDefinition,
  type DecisionRuleset,
  type RulesetResult,
} from '../../../src/decision/index.js';

const roots: string[] = [];
const fixture = async <T>(name: string): Promise<T> => JSON.parse(
  await readFile(join('agentic/code/addons/decision-engine/examples', name), 'utf8'),
) as T;

function response(body: Record<string, unknown>): Response {
  const questions = body.questions as Record<string, { type: string }>;
  const answers = Object.fromEntries(Object.entries(questions).reverse().map(([id, question]) => [id,
    question.type === 'choice'
      ? { type: 'choice', choice: 'documentation', probabilities: { documentation: 1, runtime: 0, other: 0 }, confidence: 1 }
      : question.type === 'score'
        ? { type: 'score', score: 0.25, probabilities: { 0: 0.75, 1: 0.25, 2: 0 },
            legend: { 0: 'Cosmetic or documentation issue; core functions work.', 1: 'A feature fails but has a workaround.', 2: 'Core functions unavailable.' }, confidence: 0.8 }
        : { type: 'noul', noul: 0.05 },
  ]));
  return new Response(JSON.stringify({ answers, model: 'jev-fixture', usage: { input_tokens: 9, output_tokens: 3 } }),
    { status: 200 });
}

async function pairedBenchmark(repetitions = 3): Promise<{
  report: ReturnType<typeof decisionBatchBenchmarkReport>;
  nativeResult: RulesetResult;
  singleResult: RulesetResult;
}> {
  const ruleset = await fixture<DecisionRuleset>('ruleset.json');
  const binding = await fixture<DecisionBinding>('binding-jev.json');
  const definitions = {
    category: await fixture<DecisionDefinition>('decision-category.json'),
    severity: await fixture<DecisionDefinition>('decision-severity.json'),
    core: await fixture<DecisionDefinition>('decision-core_unavailable.json'),
  };
  const input = await fixture<unknown>('input.json');
  const workloadDigest = `sha256:${createHash('sha256').update(JSON.stringify({ ruleset, binding, definitions, input })).digest('hex')}` as const;
  const samples: DecisionBatchBenchmarkSample[] = [];
  let nativeResult!: RulesetResult;
  let singleResult!: RulesetResult;
  for (const mode of ['native-batch', 'single-call'] as const) {
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      let providerCalls = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      const fetchImpl = vi.fn(async (_url, options) => {
        providerCalls += 1;
        inputTokens += 9;
        outputTokens += 3;
        return response(JSON.parse(String(options?.body)) as Record<string, unknown>);
      }) as typeof fetch;
      const started = performance.now();
      const result = await evaluateDecisionRuleset({
        ruleset, binding, definitions, input, runId: `batch-evidence-${mode}-${repetition}`,
        invocationId: `batch-evidence-${mode}-${repetition}`, adapters: { jev: new JevDecisionAdapter({ fetch: fetchImpl }) },
        batching: mode === 'native-batch'
          ? { enabled: true, evaluations: Object.fromEntries(['category', 'severity', 'core_unavailable'].map(alias => [alias,
              { decisionSubject: 'ticket:42', independent: true, egressPolicy: 'jev-public-v1', hostPolicy: 'host-policy-v1' }])) }
          : { enabled: false, evaluations: {} },
        resolveCredential: async () => new TextEncoder().encode('offline-fixture'),
      });
      samples.push({ mode, providerCalls, inputTokens, outputTokens,
        latencyMs: Math.max(0, performance.now() - started) });
      if (mode === 'native-batch') nativeResult = result;
      else singleResult = result;
    }
  }
  return { report: decisionBatchBenchmarkReport(workloadDigest, samples), nativeResult, singleResult };
}

function semantics(result: RulesetResult): unknown {
  return Object.fromEntries(Object.entries(result.spec.evaluations).map(([alias, evaluation]) => [alias, {
    status: evaluation.spec.status, value: evaluation.spec.value,
    decisionId: evaluation.spec.decision.id,
  }]));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('native batch qualification evidence', () => {
  it('executes a paired workload and links TV01/TV08/TV22 into D11-verifiable artifacts', async () => {
    const benchmark = await pairedBenchmark();
    expect(benchmark.report.repetitions).toBe(3);
    expect(benchmark.report.nativeBatch).toMatchObject({ samples: 3, providerCalls: 3, inputTokens: 27, outputTokens: 9 });
    expect(benchmark.report.singleCall).toMatchObject({ samples: 3, providerCalls: 9, inputTokens: 81, outputTokens: 27 });
    expect(semantics(benchmark.nativeResult)).toEqual(semantics(benchmark.singleResult));

    const artifactRoot = await mkdtemp(join(tmpdir(), 'batch-qualification-'));
    roots.push(artifactRoot);
    const caseIds = ['TV01', 'TV08', 'TV22'];
    const run = await executeQualificationPlan({
      artifactRoot,
      manifest: {
        schemaVersion: 'decision-qualification-run/v1', mode: 'offline', runId: 'd04-native-batch-v1',
        generatedAt: '2026-09-22T00:00:00.000Z', sourceCommit: 'working-tree', dirty: true,
        cases: caseIds.map(id => ({ id, kind: 'vendor' as const, mandatory: true,
          candidateTests: ['test/conformance/decision-v1/batch-evidence.test.ts'] })),
      },
      executors: {
        TV01: () => ({ outcome: 'pass', details: { benchmark: benchmark.report } }),
        TV08: () => ({ outcome: 'pass', details: { heterogeneousPrimitiveParity: semantics(benchmark.nativeResult) } }),
        TV22: () => ({ outcome: 'pass', details: { nativeCalls: benchmark.report.nativeBatch.providerCalls,
          singleCalls: benchmark.report.singleCall.providerCalls, workloadDigest: benchmark.report.workloadDigest } }),
      },
    });
    expect(run.evidence.map(item => [item.caseId, item.outcome])).toEqual(caseIds.map(id => [id, 'pass']));
    expect((await verifyQualificationArtifacts(run, artifactRoot)).every(item => item.verified)).toBe(true);
    const linked = await writeQualificationEvidenceManifest(run, artifactRoot, '.', Object.fromEntries(
      caseIds.map(id => [id, ['agentic/code/addons/decision-engine/examples/input.json', 'agentic/code/addons/decision-engine/examples/binding-jev.json']]),
    ));
    expect(linked.manifest.evidence.map(item => item.caseId)).toEqual(caseIds);
    expect(linked.manifest.evidence.every(item => item.executable && item.outcome === 'pass'
      && item.sourceGoldens.length === 2)).toBe(true);
    expect(linked.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
