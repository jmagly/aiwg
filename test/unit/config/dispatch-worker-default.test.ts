import { expect, it } from 'vitest';
import { resolveDispatchHostThresholds } from '../../../src/config/dispatch-thresholds-runtime.mjs';
import { evaluateDispatchGate } from '../../../src/config/host-resource-runtime.mjs';
import { hostResourceReport } from '../../../src/config/host-resource-report.mjs';
import { healthyHostResources } from '../../fixtures/host-resources.js';

it('defaults max_workers to 5 with a default origin and preserves every other default', () => {
  const origins: Record<string, string[]> = {};
  expect(resolveDispatchHostThresholds(undefined, undefined, undefined, origins)).toEqual({
    min_avail_mem_gb: 8, max_load_ratio: 1, max_mem_psi_avg10: 30,
    max_mem_psi_avg60: 10, min_free_disk_gb: 2, max_workers: 5, max_snapshot_age_seconds: 300,
  });
  expect(origins.max_workers).toEqual(['default']);
});

it('blocks six running workers under the default worker cap', () => {
  expect(evaluateDispatchGate({ ...healthyHostResources(), workers: 6 }, resolveDispatchHostThresholds()))
    .toMatchObject({ ok: false, failures: [{ signal: 'workers', actual: 6, threshold: 5 }] });
});

it.each([0, 1, 2])('lets configured layer %i replace the default, including an equal value origin', index => {
  const layers = [undefined, undefined, undefined] as ({ max_workers: number } | undefined)[];
  for (const max_workers of [5, 10]) {
    layers[index] = { max_workers };
    const origins: Record<string, string[]> = {};
    const thresholds = resolveDispatchHostThresholds(layers[0], layers[1], layers[2], origins);
    expect(thresholds.max_workers).toBe(max_workers);
    expect(origins.max_workers).toEqual([
      ['project:build.resource_preflight.dispatch', 'project:parallelism.admission.hostResources', 'task'][index],
    ]);
    expect(evaluateDispatchGate({ ...healthyHostResources(), workers: 6 }, thresholds).ok).toBe(max_workers === 10);
  }
});

it.each([[10, 7, undefined], [7, 10, undefined], [10, undefined, 7], [undefined, 10, 7]])(
  'takes MIN across configured worker caps %j/%j/%j without clamping to 5', (build, admission, task) => {
    const layer = (max_workers: number | undefined) => max_workers === undefined ? undefined : { max_workers };
    expect(resolveDispatchHostThresholds(layer(build), layer(admission), layer(task)).max_workers).toBe(7);
  });

it('includes remaining max_workers in the slots verdict', () => {
  const report = hostResourceReport({ live: { ...healthyHostResources(), workers: 3 } });
  expect(report).toMatchObject({ slots: 2, ok: true, thresholds: { max_workers: 5 }, origins: { max_workers: ['default'] } });
  expect(report.limits).toContainEqual({ threshold: 'max_workers', slots: 2 });
});

it('keeps integer >= 1 validation for every configured layer even when superseded', () => {
  for (const max_workers of [0, -1, 1.5, NaN, Infinity]) {
    expect(() => resolveDispatchHostThresholds({ max_workers }, { max_workers: 1 })).toThrow(/max_workers/);
    expect(() => resolveDispatchHostThresholds(undefined, { max_workers }, { max_workers: 1 })).toThrow(/max_workers/);
    expect(() => resolveDispatchHostThresholds(undefined, undefined, { max_workers })).toThrow(/max_workers/);
  }
});
