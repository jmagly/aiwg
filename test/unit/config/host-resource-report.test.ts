import { describe, it, expect } from 'vitest';
import { hostResourceReport } from '../../../src/config/host-resource-report.mjs';
import { readLiveHostResources, countWorkerProcesses } from '../../../src/config/host-resource-runtime.mjs';
import { resolveDispatchHostThresholds } from '../../../src/config/dispatch-thresholds-runtime.mjs';
import { hostResourceReaders, healthyHostResources, ownedWorkerReaders } from '../../fixtures/host-resources.js';

const config = { parallelism: { max_parallel_subagents: 6 } } as any;
const report = (live = healthyHostResources(), extra = {}) => hostResourceReport({ config, live, ...extra });

describe('normalized host resource capacity', () => {
  it('admits one worker unit despite fourteen host Codex processes', () => {
    const unit = 'aiwg-worker-one.service';
    const readers = ownedWorkerReaders([unit], Array.from({ length: 14 }, (_, index) =>
      index < 4 ? { invocation: 'one', unit } : {}));
    const config = { parallelism: { max_parallel_subagents: 10, groups: { coding: { maxParallel: 4 } },
      admission: { cliCaps: { codex: 4 }, memberCaps: { primary: 4 }, groupCaps: { coding: 4 } } } } as any;
    const result = hostResourceReport({ config, readers });
    expect(result).toMatchObject({ ok: true, slots: 4, measured: { workers: 1, workerUnits: 1,
      hostCliProcesses: { codex: 14, muse: 0 } } });
    for (const limit of result.limits.filter(limit => /max_parallel|groups\.|admission\./.test(limit.threshold))) {
      expect(limit.slots).toBe(limit.threshold === 'max_parallel_subagents' ? 9 : 3);
    }
  });

  it.each([[], undefined])('counts two marked invocations once each with units %j', units => {
    const readers = ownedWorkerReaders(units, [
      { invocation: 'a', comm: 'node' }, { invocation: 'a' }, { invocation: 'a' },
      { invocation: 'b' }, { invocation: 'b', comm: 'muse-bin' }, {}, {},
    ]);
    const result = hostResourceReport({ config, readers });
    expect(result).toMatchObject({ ok: true, slots: 3, measured: { workers: 2,
      workerCountingSource: units ? 'systemd-units-and-marked-processes' : 'owned-process-fallback',
      hostCliProcesses: { codex: 5, muse: 1 } } });
    expect(result.counting).toContain('not used for admission');
    if (!units) expect(result.counting).toContain('systemd unavailable');
  });
  it('samples injected /proc and disk readers and takes the minimum capacity', () => {
    const result = hostResourceReport({ config, readers: hostResourceReaders() });
    expect(result.measured).toMatchObject({ availMemGb: 32, cores: 8, load1: 1, memPsiAvg10: 2, memPsiAvg60: 1, freeDiskGb: 32, workers: 1 });
    expect(result).toMatchObject({ slots: 4, ok: true, failures: [] });
    expect(result.limits).toContainEqual({ threshold: 'max_parallel_subagents', slots: 5 });
  });

  it.each([
    ['/proc/meminfo', 'MemAvailable: 4194304 kB\n', 'min_avail_mem_gb'],
    ['/proc/loadavg', '8.1 0 0 1/100 42', 'max_load_ratio'],
    ['/proc/pressure/memory', 'some avg10=31 avg60=1 avg300=0 total=1', 'max_mem_psi_avg10'],
    ['/proc/pressure/memory', 'some avg10=1 avg60=11 avg300=0 total=1', 'max_mem_psi_avg60'],
  ])('blocks a binding threshold from %s', (path, contents, threshold) => {
    const result = hostResourceReport({ config, readers: hostResourceReaders({ [path]: contents }) });
    expect(result).toMatchObject({ slots: 0, ok: false });
    expect(result.failures.map(f => f.signal)).toContain(threshold);
  });

  it('blocks low/unknown disk with injected filesystem samples', () => {
    for (const statfs of [() => ({ bavail: 1, bsize: 1024 ** 3 }), () => { throw new Error('unreadable'); }]) {
      const result = hostResourceReport({ config, readers: { ...hostResourceReaders(), statfs } });
      expect(result.slots).toBe(0);
      expect(result.failures.map(f => f.signal)).toContain('min_free_disk_gb');
    }
  });

  it('blocks before a full core of load headroom is exhausted', () => {
    expect(report({ ...healthyHostResources(), load1: 7.1, loadRatio: 7.1 / 8 }).slots).toBe(0);
    expect(report({ ...healthyHostResources(), load1: 7, loadRatio: 7 / 8 }).slots).toBe(1);
  });

  it('intersects host max_workers and remaining request caps', () => {
    expect(report(undefined, { thresholdOverlay: { max_workers: 2 } }).slots).toBe(1);
    expect(report(undefined, { thresholdOverlay: { max_workers: 1 } })).toMatchObject({ slots: 0, ok: false });
    expect(report(undefined, { caps: [{ threshold: 'request.maxParallel', limit: 2, running: 0 }] }).slots).toBe(2);
    expect(report(undefined, { caps: [{ threshold: 'admission.cliCaps', limit: 1 }] }).failures)
      .toContainEqual(expect.objectContaining({ signal: 'admission.cliCaps' }));
    expect(report({ ...healthyHostResources(), workers: undefined }, { thresholdOverlay: { max_workers: 3 } }).slots).toBe(0);
  });

  it('fails closed on unsupported signals, missing samples and invalid thresholds', () => {
    expect(report({ supported: false, reason: 'no proc' })).toMatchObject({ slots: 0, ok: false });
    expect(report({ supported: true })).toMatchObject({ slots: 0, ok: false });
    expect(report(undefined, { thresholdOverlay: { max_workers: 0 } })).toMatchObject({ slots: 0, thresholds: null });
    expect(hostResourceReport({ live: healthyHostResources() }).slots).toBe(4);
    expect(report(undefined, { caps: [{ threshold: 'unused', limit: null }, { threshold: 'unset' }] }).slots).toBe(4);
  });

  it('reports groups separately and excludes tuple caps from the generic doctor verdict', () => {
    const config = { parallelism: { max_parallel_subagents: 8,
      groups: { on: { maxParallel: 5 }, off: { enabled: false, maxParallel: 0 } },
      admission: { cliCaps: { codex: 2 }, modelCaps: { model: 4 } } } } as any;
    expect(report(undefined, { config })).toMatchObject({ slots: 4, groups: [{ group: 'on', slots: 4 }, { group: 'off', slots: 0 }] });
    config.parallelism.admission.cliCaps.codex = 1;
    expect(report(undefined, { config }).failures).toEqual([]);
  });

  it('retains default/project/task origins and never widens a threshold', () => {
    const origins: Record<string, string[]> = {};
    const result = resolveDispatchHostThresholds({ min_avail_mem_gb: 12, max_workers: 4 },
      { min_avail_mem_gb: 10, max_workers: 3 }, { min_avail_mem_gb: 12, max_workers: 5 }, origins);
    expect(result).toMatchObject({ min_avail_mem_gb: 12, max_workers: 3 });
    expect(origins.min_avail_mem_gb).toEqual(['project:build.resource_preflight.dispatch', 'task']);
    expect(origins.max_workers).toEqual(['project:parallelism.admission.hostResources']);
    expect(origins.max_mem_psi_avg10).toEqual(['default']);
    expect(report(undefined, { thresholdOverlay: { max_load_ratio: 1 } }).origins.max_load_ratio).toEqual(['default', 'task']);
  });

  it.each([null, [], 'bad'])('rejects invalid threshold layers (%j)', value => {
    expect(() => resolveDispatchHostThresholds(value as any)).toThrow(/must be an object/);
  });

  it('counts exact CLI comm names by UID without matching its own shell or argv', () => {
    const records: Record<string, [number, string]> = {
      1: [1000, 'codex'], 2: [1000, 'codex'], 3: [1000, 'muse-bin'], 4: [1000, 'muse'],
      5: [2000, 'codex'], 6: [1000, 'bash'], 7: [1000, 'codex-fake'], 8: [1000, 'node'],
    };
    const readers = { uid: 1000, readDir: () => ['self', ...Object.keys(records), '99'], countWorkerUnits: () => 5,
      readText: (path: string) => {
        const [, , pid, field] = path.split('/');
        if (!records[pid]) throw new Error('exited');
        return field === 'status' ? `Uid: ${records[pid][0]}\n` : records[pid][1];
      } };
    expect(countWorkerProcesses(readers)).toEqual({ byGroup: {}, workspace: undefined, unknown: 5,
      attributions: [{ kind: 'unit-count', id: '(unit identities unavailable)', count: 5, attribution: 'unknown' }], total: 5, hostCliProcesses: { codex: 2, muse: 2 }, units: 5,
      source: 'systemd-units-and-marked-processes' });
    const live = readLiveHostResources({ ...hostResourceReaders(), ...readers, countWorkers: undefined });
    expect(live).toMatchObject({ workers: 5, hostCliProcesses: { codex: 2, muse: 2 }, workerUnits: 5 });
    expect(countWorkerProcesses({ ...readers, countWorkerUnits: () => { throw new Error('no manager'); } })?.total).toBe(0);
    expect(countWorkerProcesses({ ...readers, readDir: () => { throw new Error('no proc'); } })).toEqual({
      byGroup: {}, workspace: undefined, unknown: 5, attributions: [{ kind: 'unit-count', id: '(unit identities unavailable)', count: 5, attribution: 'unknown' }], total: 5, units: 5,
      source: 'systemd-units-and-marked-processes' });
    expect(countWorkerProcesses({ ...readers, countWorkerUnits: () => undefined, readDir: () => { throw new Error('no proc'); } })).toBeUndefined();
  });
});
