import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DISPATCH_HOST_THRESHOLDS,
  resolveDispatchHostThresholds,
  resolveParallelism,
  validateParallelismConfig,
} from '../../../src/config/aiwg-config.js';
import { DEFAULT_DISPATCH_THRESHOLDS, resolveDispatchThresholds } from '../../../tools/scripts/resource-preflight.mjs';

describe('dispatch host thresholds config plane (FR-OG-107)', () => {
  it('shares one conservative default set with the preflight tool', () => {
    expect(DEFAULT_DISPATCH_HOST_THRESHOLDS).toEqual(DEFAULT_DISPATCH_THRESHOLDS);
    expect(DEFAULT_DISPATCH_HOST_THRESHOLDS).toMatchObject({
      min_avail_mem_gb: 8, max_load_ratio: 1.0, max_mem_psi_avg10: 30, max_mem_psi_avg60: 10,
    });
  });

  it('clamps build dispatch and admission hostResources', () => {
    expect(resolveDispatchHostThresholds()).toMatchObject({ min_avail_mem_gb: 8 });
    const merged = resolveDispatchHostThresholds(
      { min_avail_mem_gb: 8, max_load_ratio: 0.5 },
      { min_avail_mem_gb: 2 },
    );
    expect(merged).toMatchObject({ min_avail_mem_gb: 8, max_load_ratio: 0.5 });
    expect(merged.max_workers).toBe(5);
    expect(resolveDispatchHostThresholds(undefined, { max_workers: 3 }).max_workers).toBe(3);
  });

  it('rejects non-finite, negative, and non-integer thresholds', () => {
    expect(() => resolveDispatchHostThresholds({ max_load_ratio: Number.NaN })).toThrow(/OG_CONFIG_REFERENCE/);
    expect(() => resolveDispatchHostThresholds({ min_avail_mem_gb: -1 })).toThrow(/OG_CONFIG_REFERENCE/);
    expect(() => resolveDispatchHostThresholds(undefined, { max_workers: 1.5 })).toThrow(/max_workers/);
  });

  it('accepts admission hostResources and rejects invalid values', () => {
    const ok = {
      worker_dispatch: true,
      admission: { hostResources: { min_avail_mem_gb: 12, max_workers: 4 } },
    };
    expect(validateParallelismConfig(ok)).toEqual([]);
    // The configured free-disk floor validates through the shipped JSON schema.
    expect(validateParallelismConfig({
      worker_dispatch: true,
      admission: { hostResources: { min_free_disk_gb: 4 } },
    })).toEqual([]);
    expect(validateParallelismConfig({
      worker_dispatch: true,
      admission: { hostResources: { min_free_disk_gb: -1 } },
    }).length).toBeGreaterThan(0);
    // Schema lane: the shipped JSON schema also admits the new block.
    expect(validateParallelismConfig({
      worker_dispatch: true,
      admission: { hostResources: { max_load_ratio: 'high' } },
    }).length).toBeGreaterThan(0);
    expect(validateParallelismConfig({
      worker_dispatch: true,
      admission: { hostResources: { max_workers: 0 } },
    }).join(' ')).toContain('admission/hostResources');
  });

  it('passes hostResources through resolved parallelism only when dispatch is on', () => {
    const policy = {
      worker_dispatch: true,
      admission: { hostResources: { min_avail_mem_gb: 12 } },
    };
    const resolved = resolveParallelism(policy, 'claude');
    expect(resolved.admission?.hostResources).toEqual({ min_avail_mem_gb: 12 });
    // Legacy behaviour unchanged: dispatch off drops the whole worker block.
    expect(resolveParallelism({ worker_dispatch: false }, 'claude')).toEqual(resolveParallelism(undefined, 'claude'));
  });
});


it('uses one resolver for all configured layers, including the conservative defaults', () => {
  const build = { min_avail_mem_gb: 12, max_load_ratio: 0.8, max_mem_psi_avg10: 20, max_workers: 5 };
  const admission = { min_avail_mem_gb: 6, max_load_ratio: 0.9, max_mem_psi_avg10: 25, max_mem_psi_avg60: 4, max_workers: 8 };
  const overlay = { min_avail_mem_gb: 10, max_load_ratio: 0.6, max_mem_psi_avg10: 10, max_workers: 7 };
  const resolved = resolveDispatchHostThresholds(build, admission, overlay);
  expect(resolved).toEqual({ min_avail_mem_gb: 12, max_load_ratio: 0.6, max_mem_psi_avg10: 10, max_mem_psi_avg60: 4, min_free_disk_gb: 2, max_workers: 5, max_snapshot_age_seconds: 300 });
  expect(resolveDispatchThresholds({ buildDispatch: build, admissionHostResources: admission, overlay })).toEqual(resolved);
  expect(() => resolveDispatchHostThresholds({ max_load_ratio: NaN }, { max_load_ratio: 0.5 })).toThrow(/OG_CONFIG_REFERENCE/);
  expect(() => resolveDispatchHostThresholds({}, {}, { max_workers: 0 })).toThrow(/max_workers/);
});
