import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  decisionBatchBenchmarkReport, evaluateDecisionRuleset, JevDecisionAdapter, type DecisionBatchBenchmarkSample,
  type DecisionBinding, type DecisionDefinition, type DecisionRuleset, type QualificationCaseExecutor, type RulesetResult,
} from '../../../../src/decision/index.js';

export const CASE_IDS = ['TV01', 'TV08', 'TV22'] as const;

const fixture = async <T>(name: string): Promise<T> => JSON.parse(
  await readFile(join('examples/decision', name), 'utf8'),
) as T;

/** Workload inputs that a mutation test may perturb to prove the executors derive their outcome. */
export interface BatchBenchmarkInputs {
  repetitions: number;
  /** Native-batch mode uses the batching planner; false degrades it to individual calls. */
  nativeBatching: boolean;
  /** Choice returned to the native-batch mode only; parity requires the single-call choice. */
  nativeChoice: 'documentation' | 'runtime';
  /** Provider usage reported per request by the fake transport. */
  usagePerRequest: { input_tokens: number; output_tokens: number };
}

export const DEFAULT_BATCH_INPUTS: BatchBenchmarkInputs = {
  repetitions: 3, nativeBatching: true, nativeChoice: 'documentation', usagePerRequest: { input_tokens: 9, output_tokens: 3 },
};

function response(body: Record<string, unknown>, choice: string, usage: BatchBenchmarkInputs['usagePerRequest']): Response {
  const questions = body.questions as Record<string, { type: string }>;
  const answers = Object.fromEntries(Object.entries(questions).reverse().map(([id, question]) => [id,
    question.type === 'choice'
      ? { type: 'choice', choice, probabilities: { documentation: choice === 'documentation' ? 1 : 0,
          runtime: choice === 'runtime' ? 1 : 0, other: 0 }, confidence: 1 }
      : question.type === 'score'
        ? { type: 'score', score: 0.25, probabilities: { 0: 0.75, 1: 0.25, 2: 0 },
            legend: { 0: 'Cosmetic or documentation issue; core functions work.', 1: 'A feature fails but has a workaround.', 2: 'Core functions unavailable.' }, confidence: 0.8 }
        : { type: 'noul', noul: 0.05 },
  ]));
  return new Response(JSON.stringify({ answers, model: 'jev-fixture', usage }), { status: 200 });
}

export interface PairedBatchBenchmark {
  report: ReturnType<typeof decisionBatchBenchmarkReport>;
  nativeResult: RulesetResult;
  singleResult: RulesetResult;
  inputs: BatchBenchmarkInputs;
}

/** Runs the same pinned workload in native-batch and single-call modes against a recorded fake transport. */
export async function pairedBenchmark(inputs: BatchBenchmarkInputs = DEFAULT_BATCH_INPUTS): Promise<PairedBatchBenchmark> {
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
    for (let repetition = 0; repetition < inputs.repetitions; repetition += 1) {
      let providerCalls = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      const choice = mode === 'native-batch' ? inputs.nativeChoice : 'documentation';
      const fetchImpl = (async (_url: unknown, options?: RequestInit) => {
        providerCalls += 1;
        inputTokens += inputs.usagePerRequest.input_tokens;
        outputTokens += inputs.usagePerRequest.output_tokens;
        return response(JSON.parse(String(options?.body)) as Record<string, unknown>, choice, inputs.usagePerRequest);
      }) as typeof fetch;
      const started = performance.now();
      const result = await evaluateDecisionRuleset({
        ruleset, binding, definitions, input, runId: `batch-evidence-${mode}-${repetition}`,
        invocationId: `batch-evidence-${mode}-${repetition}`, adapters: { jev: new JevDecisionAdapter({ fetch: fetchImpl }) },
        batching: mode === 'native-batch' && inputs.nativeBatching
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
  return { report: decisionBatchBenchmarkReport(workloadDigest, samples), nativeResult, singleResult, inputs };
}

export function semantics(result: RulesetResult): unknown {
  return Object.fromEntries(Object.entries(result.spec.evaluations).map(([alias, evaluation]) => [alias, {
    status: evaluation.spec.status, value: evaluation.spec.value,
    decisionId: evaluation.spec.decision.id,
  }]));
}

/**
 * Executors assert inside the runner callback, so an assertion failure is
 * recorded as a `fail` artifact. The benchmark is computed once per executor set.
 */
export function createBatchExecutors(
  inputs: BatchBenchmarkInputs = DEFAULT_BATCH_INPUTS,
): Record<(typeof CASE_IDS)[number], QualificationCaseExecutor> {
  let pending: Promise<PairedBatchBenchmark> | undefined;
  const benchmark = () => (pending ??= pairedBenchmark(inputs));
  const questions = 3;
  return {
    // TV01: same-subject questions over one shared state are answered by one
    // provider request per invocation instead of one request per question.
    TV01: async () => {
      const { report } = await benchmark();
      assert.equal(report.nativeBatch.samples, inputs.repetitions);
      assert.equal(report.singleCall.samples, inputs.repetitions);
      assert.equal(report.nativeBatch.providerCalls, inputs.repetitions);
      assert.equal(report.singleCall.providerCalls, inputs.repetitions * questions);
      return { outcome: 'pass', details: { benchmark: report } };
    },
    // TV08: heterogeneous primitives (Choice, Score, NOUL) in one shared-state
    // request normalize to exactly the single-call semantics.
    TV08: async () => {
      const { nativeResult, singleResult } = await benchmark();
      const native = semantics(nativeResult);
      assert.deepEqual(native, semantics(singleResult));
      assert.equal(nativeResult.spec.status, singleResult.spec.status);
      return { outcome: 'pass', details: { heterogeneousPrimitiveParity: native } };
    },
    // TV22: usage is request-level. A native batch reports one usage block per
    // request, so tokens scale with requests, not with questions.
    TV22: async () => {
      const { report } = await benchmark();
      const perRequest = inputs.usagePerRequest;
      assert.equal(report.nativeBatch.inputTokens, report.nativeBatch.providerCalls * perRequest.input_tokens);
      assert.equal(report.nativeBatch.outputTokens, report.nativeBatch.providerCalls * perRequest.output_tokens);
      assert.equal(report.singleCall.inputTokens, report.singleCall.providerCalls * perRequest.input_tokens);
      assert.ok(report.nativeBatch.providerCalls < report.singleCall.providerCalls);
      assert.ok((report.nativeBatch.inputTokens ?? Infinity) < (report.singleCall.inputTokens ?? 0));
      return { outcome: 'pass', details: { nativeCalls: report.nativeBatch.providerCalls,
        singleCalls: report.singleCall.providerCalls, workloadDigest: report.workloadDigest } };
    },
  };
}

export const executors = createBatchExecutors();
