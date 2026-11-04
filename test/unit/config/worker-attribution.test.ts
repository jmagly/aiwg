// T-OG-01: workspace attribution keeps group slots separate while retaining host occupancy.
import { describe, expect, it } from 'vitest';
import { countWorkerProcesses, readLiveHostResources } from '../../../src/config/host-resource-runtime.mjs';
import { hostResourceReport } from '../../../src/config/host-resource-report.mjs';
import { workerAttributionEnvironment, directWorkerEnvironment } from '../../../src/config/worker-attribution.mjs';
import { buildWorkerInvocationEnvironment } from '../../../tools/ralph-external/lib/worker-invocation-processes.mjs';
import { markWorkerServer } from '../../../src/mcp/tools/worker-stdin-runtime.mjs';
import { ownedWorkerReaders } from '../../fixtures/host-resources.js';

const config = { parallelism: { max_parallel_subagents: 4,
  groups: { workers: { maxParallel: 4 }, reviews: { maxParallel: 1 } } } } as any;
const units = ['aiwg-worker-r17-3768a-123.service', 'aiwg-worker-r17-3769a-456.service'];
const current = { workspace: '/synthetic', group: 'reviews' };
const other = { workspace: '/another-workspace', group: 'reviews' };

describe('T-OG-01 worker workspace attribution', () => {
  it('admits the sole review slot with opaque units from another workspace or group', () => {
    const readers = ownedWorkerReaders(units, [
      { invocation: 'opaque-a', unit: units[0], ...other },
      { invocation: 'opaque-b', unit: units[1], workspace: current.workspace, group: 'workers' },
    ]);
    const report = hostResourceReport({ config, readers, group: 'reviews' });
    expect(report).toMatchObject({ ok: true, slots: 1,
      measured: { workers: 2, workerUnknown: 0, workerGroups: { workers: 1 }, workerAttributions: [
        { id: units[0], ...other, attribution: 'attributed' }, { id: units[1], group: 'workers', attribution: 'attributed' },
      ] } });
    expect(report.limits).toContainEqual({ threshold: 'max_workers', slots: 3 });
  });

  it('keeps workers attributed to another workspace out of the project ceiling', () => {
    const readers = ownedWorkerReaders(units, [
      { invocation: 'opaque-a', unit: units[0], ...other }, { invocation: 'opaque-b', unit: units[1], ...other },
    ]);
    const capped = { parallelism: { ...config.parallelism, max_parallel_subagents: 2 } };
    const report = hostResourceReport({ config: capped, readers, group: 'reviews' });
    expect(report).toMatchObject({ ok: true, slots: 1, measured: { workers: 2, workerUnknown: 0 } });
    expect(report.limits).toContainEqual({ threshold: 'max_parallel_subagents', slots: 2 });
    expect(report.limits).toContainEqual({ threshold: 'max_workers', slots: 3 });
    const local = hostResourceReport({ config: capped, readers: ownedWorkerReaders(units, [
      { invocation: 'opaque-a', unit: units[0], ...other }, { invocation: 'opaque-b', unit: units[1], workspace: current.workspace, group: 'workers' },
    ]), group: 'reviews' });
    expect(local.limits).toContainEqual({ threshold: 'max_parallel_subagents', slots: 1 });
  });

  it('counts opaque unknown units at the host ceiling and lists inspectable blockers', () => {
    const report = hostResourceReport({ config, readers: ownedWorkerReaders(units, []), group: 'reviews',
      thresholdOverlay: { max_workers: 2 } });
    expect(report).toMatchObject({ ok: false, slots: 0, measured: { workers: 2, workerUnknown: 2 },
      groups: [{ group: 'workers', slots: 2 }, { group: 'reviews', slots: 0 }] });
    expect(report.failures).toContainEqual(expect.objectContaining({ code: 'OG_HOST_ATTRIBUTION', signal: 'max_workers',
      reason: expect.stringContaining('unattributed=2') }));
    for (const unit of units) expect(report.failures.map(failure => failure.reason).join()).toContain(unit);
  });

  it('charges unknown workers against every named group as well as the host', () => {
    const report = hostResourceReport({ config, readers: ownedWorkerReaders(units, []), group: 'reviews' });
    expect(report).toMatchObject({ ok: false, slots: 0, measured: { workers: 2, workerUnknown: 2 } });
    expect(report.failures).toContainEqual(expect.objectContaining({ code: 'OG_HOST_ATTRIBUTION',
      signal: 'groups.reviews.maxParallel', reason: expect.stringContaining('docs/getting-started/worker-attribution.md') }));
    expect(report.limits).toContainEqual({ threshold: 'max_parallel_subagents', slots: 2 });
  });

  it('deduplicates marked direct descendants and unit descendants, including escaped descendants', () => {
    const readers = ownedWorkerReaders([units[0]], [
      { invocation: 'managed', unit: units[0], ...other }, { invocation: 'managed', ...other },
      { invocation: 'direct', ...current }, { invocation: 'direct', ...current },
      { invocation: 'ignored', uid: 2000, ...current },
    ]);
    expect(countWorkerProcesses(readers)).toMatchObject({ total: 2, unknown: 0, byGroup: { reviews: 1 } });
    const report = hostResourceReport({ config, readers, group: 'reviews' });
    expect(report).toMatchObject({ ok: false, groups: [{ group: 'workers', slots: 4 }, { group: 'reviews', slots: 0 }] });
    expect(report.failures).toContainEqual(expect.objectContaining({ code: 'OG_HOST_CAPACITY', signal: 'groups.reviews.maxParallel' }));
  });

  it('treats conflicting descendant markers as unknown while retaining legacy unit prefixes', () => {
    const readers = ownedWorkerReaders([units[0], 'aiwg-worker-reviews-old.service'], [
      { invocation: 'shared', unit: units[0], ...other }, { invocation: 'shared', ...current },
    ]);
    expect(countWorkerProcesses({ ...readers, groupNames: ['workers', 'reviews'] })).toMatchObject({ total: 2, unknown: 1, byGroup: { reviews: 1 }, attributions: [
      { id: units[0], attribution: 'conflicting' }, { attribution: 'attributed', group: 'reviews' },
    ] });
  });

  it('keeps incomplete markers and numeric-only unit counts conservative', () => {
    const readers = ownedWorkerReaders(undefined, [
      { invocation: 'opaque-incomplete' }, { invocation: 'missing-workspace', group: 'reviews' },
      { invocation: 'missing-group', workspace: '/synthetic' },
    ]);
    expect(countWorkerProcesses(readers)).toMatchObject({ total: 3, unknown: 3, byGroup: {} });
    expect(countWorkerProcesses({ ...readers, listWorkerUnits: undefined, countWorkerUnits: () => 2 }))
      .toMatchObject({ total: 5, unknown: 5 });
    expect(readLiveHostResources(readers).workerAttributions).toHaveLength(3);
  });

  it('launchers override inherited attribution and expose the complete allowlist', () => {
    const invocation = { cwd: '/synthetic', selected: { group: 'reviews' } };
    const result = buildWorkerInvocationEnvironment(['PATH', 'AIWG_WORKER_GROUP'], 'new-id',
      { PATH: '/bin', AIWG_WORKER_GROUP: 'wrong', SECRET: 'not-forwarded' }, invocation);
    expect(result.env).toEqual({ PATH: '/bin', ...workerAttributionEnvironment('new-id', '/synthetic', 'reviews') });
    expect(result.envNames.sort()).toEqual(Object.keys(result.env).sort());
    expect(directWorkerEnvironment({ ...invocation, expiresAt: 'first-clock' } as any))
      .toEqual(directWorkerEnvironment({ ...invocation, expiresAt: 'revalidated-clock' } as any));
    const direct = directWorkerEnvironment({ ...invocation, invocationId: 'direct-id' } as any);
    expect(direct).toEqual(workerAttributionEnvironment('direct-id', '/synthetic', 'reviews'));
    const server = { cwd: '/mcp-installation', env: { CONFIG: 'fixture', AIWG_WORKER_GROUP: 'wrong' } };
    expect(markWorkerServer(server, invocation, 'spawned-mcp')).toEqual({ ...server, env: {
      CONFIG: 'fixture', ...workerAttributionEnvironment('spawned-mcp', '/synthetic', 'reviews'),
    } });
    expect(server.env.AIWG_WORKER_GROUP).toBe('wrong');
  });
});
