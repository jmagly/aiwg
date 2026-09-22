export interface DecisionBatchBenchmarkSample {
  mode: 'native-batch' | 'single-call';
  providerCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
}

export interface DecisionBatchBenchmarkSummary {
  samples: number;
  providerCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
}

export interface DecisionBatchBenchmarkReport {
  schemaVersion: 'decision-batch-benchmark/v1';
  workloadDigest: `sha256:${string}`;
  repetitions: number;
  nativeBatch: DecisionBatchBenchmarkSummary;
  singleCall: DecisionBatchBenchmarkSummary;
}

function finiteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and non-negative`);
}

function sumKnown(values: Array<number | null>): number | null {
  return values.some(value => value === null) ? null : (values as number[]).reduce((sum, value) => sum + value, 0);
}

function summarize(samples: DecisionBatchBenchmarkSample[]): DecisionBatchBenchmarkSummary {
  return {
    samples: samples.length,
    providerCalls: samples.reduce((sum, value) => sum + value.providerCalls, 0),
    inputTokens: sumKnown(samples.map(value => value.inputTokens)),
    outputTokens: sumKnown(samples.map(value => value.outputTokens)),
    latencyMs: samples.reduce((sum, value) => sum + value.latencyMs, 0),
  };
}

/**
 * Produces workload-pinned comparative evidence without asserting that a
 * synthetic improvement generalizes to another provider, model, or workload.
 */
export function decisionBatchBenchmarkReport(
  workloadDigest: `sha256:${string}`,
  samples: readonly DecisionBatchBenchmarkSample[],
): DecisionBatchBenchmarkReport {
  if (!/^sha256:[a-f0-9]{64}$/.test(workloadDigest)) throw new Error('invalid workload digest');
  for (const sample of samples) {
    if (!Number.isSafeInteger(sample.providerCalls) || sample.providerCalls < 1) {
      throw new Error('providerCalls must be a positive integer');
    }
    finiteNonNegative(sample.latencyMs, 'latencyMs');
    if (sample.inputTokens !== null) finiteNonNegative(sample.inputTokens, 'inputTokens');
    if (sample.outputTokens !== null) finiteNonNegative(sample.outputTokens, 'outputTokens');
  }
  const nativeBatch = samples.filter(sample => sample.mode === 'native-batch');
  const singleCall = samples.filter(sample => sample.mode === 'single-call');
  if (nativeBatch.length === 0 || nativeBatch.length !== singleCall.length) {
    throw new Error('paired batch benchmark requires equal non-empty mode samples');
  }
  return {
    schemaVersion: 'decision-batch-benchmark/v1',
    workloadDigest,
    repetitions: nativeBatch.length,
    nativeBatch: summarize(nativeBatch),
    singleCall: summarize(singleCall),
  };
}
