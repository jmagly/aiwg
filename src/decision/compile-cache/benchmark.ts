export interface CacheBenchmarkSample {
  mode: 'cache-disabled' | 'cache-enabled';
  preparationLatencyMs: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  costUsd: number | null;
  memoryBytes: number;
  storageBytes: number;
  outcome: 'hit' | 'miss' | 'bypass' | 'unknown';
  invalidated: boolean;
}

export interface CacheBenchmarkReport {
  schemaVersion: 'decision-cache-benchmark/v1';
  configurationDigest: `sha256:${string}`;
  warmupCalls: number;
  measuredCalls: number;
  minimumBenefitTargetBps: number;
  confidenceInterval: string;
  disabled: ReturnType<typeof summarize>;
  enabled: ReturnType<typeof summarize>;
}

export function cacheBenchmarkReport(configurationDigest: `sha256:${string}`, warmupCalls: number,
  minimumBenefitTargetBps: number, confidenceInterval: string, samples: CacheBenchmarkSample[]): CacheBenchmarkReport {
  if (!samples.some(value => value.mode === 'cache-disabled') || !samples.some(value => value.mode === 'cache-enabled')) {
    throw new Error('paired cache benchmark requires enabled and disabled samples');
  }
  return { schemaVersion: 'decision-cache-benchmark/v1', configurationDigest, warmupCalls,
    measuredCalls: samples.length, minimumBenefitTargetBps, confidenceInterval,
    disabled: summarize(samples.filter(value => value.mode === 'cache-disabled')),
    enabled: summarize(samples.filter(value => value.mode === 'cache-enabled')) };
}

/** Deterministic paired bootstrap interval; positive differences favor enabled caching. */
export function pairedPreparationLatencyInterval(disabled: readonly number[], enabled: readonly number[],
  iterations = 233): string {
  if (disabled.length !== enabled.length || disabled.length < 2 ||
      !Number.isSafeInteger(iterations) || iterations < 2 ||
      [...disabled, ...enabled].some(value => !Number.isFinite(value) || value < 0)) {
    throw new Error('paired latency interval requires equal non-negative measured samples');
  }
  const differences = disabled.map((value, index) => value - enabled[index]!);
  let seed = 0x2603;
  const means = Array.from({ length: iterations }, () => {
    let total = 0;
    for (let index = 0; index < differences.length; index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      total += differences[seed % differences.length]!;
    }
    return total / differences.length;
  }).sort((left, right) => left - right);
  return `95% paired bootstrap CI [${means[Math.floor(iterations * 0.025)]!.toFixed(3)}, ${means[Math.ceil(iterations * 0.975) - 1]!.toFixed(3)}] ms`;
}

function summarize(samples: CacheBenchmarkSample[]) {
  const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const nullableAverage = (values: Array<number | null>) => values.some(value => value === null) ? null : average(values as number[]);
  return { calls: samples.length, averagePreparationLatencyMs: average(samples.map(value => value.preparationLatencyMs)),
    averageInputTokens: nullableAverage(samples.map(value => value.inputTokens)),
    averageCachedInputTokens: nullableAverage(samples.map(value => value.cachedInputTokens)),
    averageCostUsd: nullableAverage(samples.map(value => value.costUsd)),
    peakMemoryBytes: Math.max(...samples.map(value => value.memoryBytes)),
    peakStorageBytes: Math.max(...samples.map(value => value.storageBytes)),
    hitRateBps: Math.round(samples.filter(value => value.outcome === 'hit').length * 10_000 / samples.length),
    invalidationRateBps: Math.round(samples.filter(value => value.invalidated).length * 10_000 / samples.length) };
}
