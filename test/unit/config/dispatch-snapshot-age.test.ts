import { expect, it } from 'vitest';
import { resolveDispatchHostThresholds } from '../../../src/config/dispatch-thresholds-runtime.mjs';
import { validateParallelismConfig } from '../../../src/config/aiwg-config.js';

const sources = ['project:build.resource_preflight.dispatch', 'project:parallelism.admission.hostResources', 'task'];
it('defaults host snapshot age to 300 seconds with its default origin', () => {
  const origins: Record<string, string[]> = {};
  expect(resolveDispatchHostThresholds(undefined, undefined, undefined, origins).max_snapshot_age_seconds).toBe(300);
  expect(origins.max_snapshot_age_seconds).toEqual(['default']);
});

it.each([0, 1, 2])('tightens snapshot age with MIN in layer %i and reports binding origins', index => {
  for (const seconds of [60, 300, 600, 0.5]) {
    const layers = [undefined, undefined, undefined] as ({ max_snapshot_age_seconds: number } | undefined)[];
    layers[index] = { max_snapshot_age_seconds: seconds };
    const origins: Record<string, string[]> = {};
    expect(resolveDispatchHostThresholds(...layers, origins).max_snapshot_age_seconds).toBe(Math.min(seconds, 300));
    expect(origins.max_snapshot_age_seconds).toEqual(seconds < 300 ? [sources[index]]
      : seconds === 300 ? ['default', sources[index]] : ['default']);
  }
});

it('takes MIN across all layers and records equal binding origins', () => {
  const origins: Record<string, string[]> = {};
  expect(resolveDispatchHostThresholds({ max_snapshot_age_seconds: 120 }, { max_snapshot_age_seconds: 60 },
    { max_snapshot_age_seconds: 60 }, origins).max_snapshot_age_seconds).toBe(60);
  expect(origins.max_snapshot_age_seconds).toEqual(sources.slice(1));
});

it.each([0, 1, 2])('rejects invalid snapshot maxima in layer %i even if later tightened', index => {
  for (const seconds of [0, -1, NaN, Infinity, '60', null]) {
    const layers: any[] = [{ max_snapshot_age_seconds: 60 }, { max_snapshot_age_seconds: 60 }, { max_snapshot_age_seconds: 60 }];
    layers[index] = { max_snapshot_age_seconds: seconds };
    expect(() => resolveDispatchHostThresholds(...layers)).toThrow(/max_snapshot_age_seconds/);
  }
});

it('validates the admission host snapshot maximum through the existing config owner', () => {
  expect(validateParallelismConfig({ admission: { hostResources: { max_snapshot_age_seconds: 60 } } })).toEqual([]);
  expect(validateParallelismConfig({ admission: { hostResources: { max_snapshot_age_seconds: 0 } } }).join(' '))
    .toContain('max_snapshot_age_seconds');
});
