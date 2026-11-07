export interface PairedTimingSample {
  baselineBeforeMs: number;
  commandMs: number;
  baselineAfterMs: number;
}

export interface PairedTimingSummary {
  baselineMedianMs: number;
  commandMedianMs: number;
  overheadMedianMs: number;
  overheadMinMs: number;
  overheadMaxMs: number;
  overheadsMs: number[];
}

export function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  options: { minimum?: number; odd?: boolean } = {},
): number {
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  const minimum = options.minimum ?? 1;
  if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
  if (options.odd && parsed % 2 === 0) return fallback;
  return parsed;
}

export function median(values: number[]): number {
  if (values.length === 0) throw new Error('median requires at least one value');
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

/** Compare adjacent measurements without depending on absolute host speed. */
export function medianPairedRatio(numerators: number[], denominators: number[]): number {
  if (numerators.length === 0 || numerators.length !== denominators.length) {
    throw new Error('paired ratios require nonempty, equally sized samples');
  }
  return median(numerators.map((value, index) => value / denominators[index]!));
}

/** Amortize short-sample noise using this worker's CPU, excluding scheduler waits. */
export function measureThreadCpuBatch<T>(
  run: () => T,
  minimumCpuMs = 250,
  readCpu = () => process.threadCpuUsage(),
): { value: T; cpuMs: number; operations: number } {
  const started = readCpu();
  let value: T;
  let cpuMs = 0;
  let operations = 0;
  do {
    value = run();
    operations++;
    const elapsed = readCpu();
    cpuMs = (elapsed.user - started.user + elapsed.system - started.system) / 1000;
  } while (cpuMs < minimumCpuMs);
  return { value, cpuMs, operations };
}

export function summarizePairedTimings(samples: PairedTimingSample[]): PairedTimingSummary {
  if (samples.length === 0) throw new Error('paired timing summary requires at least one sample');
  const baselines = samples.map(sample => (sample.baselineBeforeMs + sample.baselineAfterMs) / 2);
  const commands = samples.map(sample => sample.commandMs);
  const overheads = samples.map((sample, index) => Math.max(0, sample.commandMs - baselines[index]!));
  return {
    baselineMedianMs: median(baselines),
    commandMedianMs: median(commands),
    overheadMedianMs: median(overheads),
    overheadMinMs: Math.min(...overheads),
    overheadMaxMs: Math.max(...overheads),
    overheadsMs: overheads,
  };
}

