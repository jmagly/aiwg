// Regression coverage for load-independent redaction growth measurements.
import { describe, expect, it } from 'vitest';
import { measureThreadCpuBatch, medianPairedRatio } from '../../helpers/cli-perf-policy.js';

describe('redaction growth measurement', () => {
  it('keeps linear work green when an isolated small sample runs with less contention (#3863)', () => {
    // The first pair reproduces the reported failure; later pairs share load.
    const small = [85.989, 160, 150, 170, 155];
    const large = [262.345, 320, 300, 340, 310];
    expect(medianPairedRatio(large, small)).toBeLessThan(3);
  });

  it('rejects sustained quadratic growth even when host speed changes between pairs', () => {
    const small = [85.989, 160, 150, 170, 155];
    const large = small.map(value => value * 4);
    expect(medianPairedRatio(large, small)).toBeGreaterThanOrEqual(3);
    // One favorable sample must not conceal a sustained regression either.
    large[0] = small[0] * 2;
    expect(medianPairedRatio(large, small)).toBeGreaterThanOrEqual(3);
  });

  it('tolerates isolated noise on either side while preserving the strict growth bound', () => {
    expect(medianPairedRatio([400, 200, 200, 200, 200], [100, 100, 400, 100, 100])).toBe(2);
    expect(medianPairedRatio([300, 300, 300, 300, 300], [100, 100, 100, 100, 100])).toBe(3);
  });

  it('requires matched, nonempty pairs', () => {
    expect(() => medianPairedRatio([], [])).toThrow(/paired ratios/);
    expect(() => medianPairedRatio([1], [1, 2])).toThrow(/paired ratios/);
  });

  it('batches until the worker CPU budget is reached and normalizes by operation count', () => {
    let operations = 0;
    const batch = measureThreadCpuBatch(() => ++operations, 250,
      () => ({ user: 10_000 + operations * 40_000, system: 20_000 + operations * 10_000 }));
    expect(batch).toEqual({ value: 5, cpuMs: 250, operations: 5 });
    expect(batch.cpuMs / batch.operations).toBe(50);
  });
});
