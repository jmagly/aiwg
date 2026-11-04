import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { parseMemAvailableGb, parseLoadAverages, parseMemoryPsi, readLiveHostResources,
  countWorkerUnits, defaultCountWorkers, evaluateDispatchGate, nearestDispatchPathSync } from '../../../src/config/host-resource-runtime.mjs';
import { resolveDispatchHostThresholds } from '../../../src/config/dispatch-thresholds-runtime.mjs';
import { healthyHostResources, hostResourceReaders, ownedWorkerReaders } from '../../fixtures/host-resources.js';
import { WORKER_INVOCATION_MARKER } from '../../../src/config/worker-invocation-marker.mjs';

describe('shared preflight measurement regressions', () => {
  it('parses only valid memory, PSI and load fixtures', () => {
    expect(parseMemAvailableGb('MemAvailable: 8388608 kB\n')).toBe(8);
    for (const text of [undefined, 'bad', 'MemAvailable: 999' + '9'.repeat(400) + ' kB']) expect(parseMemAvailableGb(text)).toBeUndefined();
    expect(parseLoadAverages('1 2 3 1/100 42')).toEqual({ load1: 1, load5: 2, load15: 3 });
    for (const text of [null, 'bad', '1 2', 'NaN 2 3']) expect(parseLoadAverages(text)).toBeNull();
    expect(parseMemoryPsi('full avg10=9 avg60=9 avg300=9\nsome avg10=1 avg60=2 avg300=3 total=4')).toEqual({ avg10: 1, avg60: 2, avg300: 3 });
    for (const text of [null, '', 'full avg10=1 avg60=2 avg300=3', 'some avg10=NaN avg60=1 avg300=2', 'some avg10=1 avg60=2']) expect(parseMemoryPsi(text)).toBeNull();
  });

  it('fails closed on unreadable /proc and invalid core counts', () => {
    const live = readLiveHostResources({ readText: () => { throw new Error('unavailable'); }, coreCount: () => NaN,
      countWorkers: () => { throw new Error('unavailable'); } });
    expect(live).toMatchObject({ supported: true, availMemGb: undefined, load1: undefined, cores: undefined,
      loadRatio: undefined, memPsiAvg10: undefined, workers: undefined, freeDiskGb: undefined });
  });

  it('samples the minimum across actual target filesystems and rejects broken disk samples', () => {
    expect(readLiveHostResources({ ...hostResourceReaders(), paths: ['evidence', 'tree'],
      statfsPath: path => ({ bavail: path === 'tree' ? 3 : 8, bsize: 1024 ** 3 }) }).freeDiskGb).toBe(3);
    for (const disk of [{ bavail: -1, bsize: 1 }, { bavail: NaN, bsize: 1 }, { bavail: Infinity, bsize: 1 }, {}]) {
      expect(readLiveHostResources({ ...hostResourceReaders(), statfs: () => disk as any }).freeDiskGb).toBeUndefined();
      expect(readLiveHostResources({ ...hostResourceReaders(), paths: ['tree'], statfsPath: () => disk as any }).freeDiskGb).toBeUndefined();
    }
    expect(readLiveHostResources({ ...hostResourceReaders(), paths: [] }).freeDiskGb).toBeUndefined();
    expect(readLiveHostResources({ ...hostResourceReaders(), paths: ['gone'], statfsPath: () => { throw new Error('gone'); } }).freeDiskGb).toBeUndefined();
  });

  it('picks the nearest usable ancestor of a not-yet-created worker folder, never / (#3856)', () => {
    const root = mkdtempSync(join(tmpdir(), 'aiwg-3856-'));
    try {
      expect(nearestDispatchPathSync(join(root, 'not', 'yet', 'created'))).toBe(root);
      expect(nearestDispatchPathSync(root)).toBe(root);
      // A file in the chain, a top-level path with only / above it, and a
      // non-ENOENT error all keep the original path so sampling fails closed.
      writeFileSync(join(root, 'file'), '');
      expect(nearestDispatchPathSync(join(root, 'file', 'out'))).toBe(join(root, 'file', 'out'));
      const topLevel = join('/', `${basename(root)}-absent`, 'out');
      expect(nearestDispatchPathSync(topLevel)).toBe(topLevel);
      const denied = join(root, 'missing');
      expect(nearestDispatchPathSync(denied, { access: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } })).toBe(denied);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts only explicit running/activating AIWG service units and rejects failed enumeration', () => {
    expect(countWorkerUnits({ spawn: (cmd, args) => {
      expect(cmd).toBe('systemctl'); expect(args).toContain('--state=running,activating');
      return { status: 0, stdout: 'aiwg-worker-one.service loaded active running\nother.service active\naiwg-worker-two.service loaded activating\n' };
    } })).toBe(2);
    expect(countWorkerUnits({ spawn: () => ({ status: 0 }) })).toBe(0);
    for (const spawn of [() => ({ status: 1 }), () => ({ error: new Error('spawn') }), () => { throw new Error('spawn'); }]) expect(countWorkerUnits({ spawn })).toBeUndefined();
  });

  it('retains process-only counts when service manager is unavailable or returns invalid data', () => {
    const readDir = () => ['1', '2', '3', '4'];
    const readText = (path: string) => path.endsWith('status') ? (path.includes('/4/') ? '' : 'Uid: 1000\n') : path.includes('/1/') ? 'codex' : 'muse-bin';
    for (const units of [undefined, -1, NaN, 1.5, 0]) expect(defaultCountWorkers({ uid: 1000, readDir, readText, countWorkerUnits: () => units })).toBe(0);
    expect(defaultCountWorkers({ uid: 1000, readDir, readText, countWorkerUnits: () => 5 })).toBe(5);
  });

  it('reuses the launcher marker and adds workers outside counted units exactly once', async () => {
    const launcher = await import('../../../tools/ralph-external/lib/worker-invocation-processes.mjs');
    expect(launcher.WORKER_INVOCATION_MARKER).toBe(WORKER_INVOCATION_MARKER);
    const unit = 'aiwg-worker-one.service';
    const readers = ownedWorkerReaders([unit], [{ invocation: 'one', unit },
      { invocation: 'one' }, { invocation: 'two' }, { invocation: 'two' },
      { uid: 2000, invocation: 'foreign' }, { invocation: '' }]);
    expect(defaultCountWorkers(readers)).toBe(2);
    const readText = readers.readText;
    readers.readText = filename => {
      if (filename.endsWith('/cgroup') && filename.includes('/1/')) throw new Error('unreadable');
      return readText(filename);
    };
    // Without readable unit membership the marked invocation is conservatively additional.
    expect(defaultCountWorkers(readers)).toBe(3);
  });

  it('preserves every original dispatch threshold boundary and failure diagnostic', () => {
    const thresholds = resolveDispatchHostThresholds(undefined, { max_workers: 3 });
    const good = healthyHostResources();
    expect(evaluateDispatchGate(good, thresholds).ok).toBe(true);
    expect(evaluateDispatchGate({ supported: false }, thresholds).failures[0].signal).toBe('platform');
    expect(evaluateDispatchGate(undefined as any, thresholds).ok).toBe(false);
    for (const [key, value, signal] of [
      ['availMemGb', 1, 'avail-mem'], ['loadRatio', 2, 'load'], ['memPsiAvg10', 31, 'mem-psi-avg10'],
      ['memPsiAvg60', 11, 'mem-psi-avg60'], ['workers', 3, 'workers'], ['freeDiskGb', 1, 'free-disk'],
    ] as const) {
      for (const sample of [value, undefined]) {
        const result = evaluateDispatchGate({ ...good, [key]: sample }, thresholds);
        expect(result.ok).toBe(false); expect(result.failures[0].signal).toBe(signal);
      }
    }
    for (const freeDiskGb of [NaN, Infinity, -1]) expect(evaluateDispatchGate({ ...good, freeDiskGb }, thresholds).ok).toBe(false);
    expect(evaluateDispatchGate({ ...good, availMemGb: 8, loadRatio: 1, memPsiAvg10: 30, memPsiAvg60: 10, freeDiskGb: 2, workers: 2 }, thresholds).ok).toBe(true);
    expect(evaluateDispatchGate({ ...good, workers: 99 }, resolveDispatchHostThresholds()).ok).toBe(false);
    expect(evaluateDispatchGate({ ...good, freeDiskGb: undefined }, { ...thresholds, min_free_disk_gb: 0 }).ok).toBe(true);
  });
});
