import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planIndexRefresh, refreshIndexes, refreshResourceGate, runIndexRefresh } from '../../../src/artifacts/index-refresh.js';
import { acquireDirectoryLock } from '../../../src/artifacts/prebuilt-build-lock.js';
import { getGraphIndexDir, loadUserGraphConfigs } from '../../../src/artifacts/types.js';
import { syncFortemiCoreIndex } from '../../../src/artifacts/fortemi-core-sync.js';
import { discoverWorkspaceHistories, readDiscoveryManifest, writeDiscoveryManifest } from '../../../src/sessions/workspace-discovery.js';

let root: string;
let workspace: string;
let state: string;
const admitted = { gate: async () => ({ ok: true }) };

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function config(ws: string, graphs: Record<string, unknown> = {}): void {
  write(path.join(ws, '.aiwg/aiwg.config'), JSON.stringify({ index: { graphs } }));
}

function snapshot(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  if (!fs.existsSync(directory)) return files;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, snapshot(file));
    else files[file] = `${fs.statSync(file).mtimeMs}:${fs.readFileSync(file, 'base64')}`;
  }
  return files;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-index-refresh-'));
  workspace = path.join(root, 'workspace');
  state = path.join(root, 'state/aiwg');
  config(workspace);
  write(path.join(workspace, '.aiwg/requirements/UC-001.md'), '# Example\n\nAn indexed requirement.\n');
  write(path.join(workspace, 'src/example.ts'), 'export const example = 1;\n');
  for (const [key, value] of Object.entries({
    HOME: path.join(root, 'home'), XDG_STATE_HOME: path.join(root, 'state'),
    XDG_DATA_HOME: path.join(root, 'data'), XDG_CONFIG_HOME: path.join(root, 'config'),
  })) vi.stubEnv(key, value);
  fs.mkdirSync(process.env.HOME!, { recursive: true });
});

afterEach(() => {
  process.exitCode = 0;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('index refresh', () => {
  it('plans ordered default, configured, built, cache, and existing session jobs without writes', async () => {
    config(workspace, {
      refs: { scanDirs: ['refs'], defaultBuild: false, buildTier: 'lightweight' },
    });
    write(path.join(workspace, '.aiwg/.index/source/metadata.json'), JSON.stringify({ builtAt: '2026-01-01', entries: {} }));
    write(path.join(workspace, '.aiwg/.index/fortemi-core/project/manifest.json'), '{}');
    write(path.join(workspace, '.aiwg/sessions/catalog.sqlite'), 'existing catalog');
    const before = snapshot(root);
    const report = await refreshIndexes({ cwd: workspace, dryRun: true });
    expect(report.jobs.map(job => [job.kind, job.graph])).toEqual([
      ['graph', 'refs'], ['graph', 'project'], ['graph', 'codebase'], ['graph', 'source'],
      ['cache', 'project'], ['sessions', undefined],
    ]);
    expect(report.jobs.every(job => job.status === 'planned')).toBe(true);
    expect(snapshot(root)).toEqual(before);
    expect(fs.existsSync(state)).toBe(false);
  });

  it('finds the current project from a subdirectory and stops at repository boundaries', () => {
    const jobs = planIndexRefresh({ cwd: path.join(workspace, 'src') });
    expect(jobs.every(job => job.workspace === workspace)).toBe(true);
    const nested = path.join(workspace, 'nested');
    fs.mkdirSync(path.join(nested, '.git'), { recursive: true });
    expect(planIndexRefresh({ cwd: nested }).every(job => job.workspace === nested)).toBe(true);
  });

  it('uses the dispatch gate with 8 GiB memory and 0.8 load per core, including stricter configured limits', async () => {
    const live = { supported: true, availMemGb: 8, loadRatio: 0.8, memPsiAvg10: 0, memPsiAvg60: 0, freeDiskGb: 100 };
    expect(await refreshResourceGate(workspace, live)).toEqual({ ok: true, reason: undefined });
    expect(await refreshResourceGate(workspace, { ...live, availMemGb: 7.9 })).toMatchObject({ ok: false });
    expect(await refreshResourceGate(workspace, { ...live, loadRatio: 0.81 })).toMatchObject({ ok: false });
    expect(await refreshResourceGate(workspace, { ...live, memPsiAvg10: 31 })).toMatchObject({ ok: false });
    write(path.join(workspace, '.aiwg/aiwg.config'), JSON.stringify({
      build: { resource_preflight: { dispatch: { min_avail_mem_gb: 10 } } },
    }));
    expect(await refreshResourceGate(workspace, live)).toMatchObject({ ok: false });
    write(path.join(workspace, '.aiwg/aiwg.config'), '{invalid');
    await expect(refreshResourceGate(workspace, live)).rejects.toThrow();
  });

  it('builds incrementally, then skips unchanged graphs and caches without rewriting outputs', async () => {
    const first = await refreshIndexes({ cwd: workspace }, admitted);
    expect(first.totals).toMatchObject({ ok: 2, errors: 0 });
    loadUserGraphConfigs(workspace);
    syncFortemiCoreIndex(workspace, { graph: 'project' });
    const before = snapshot(path.join(workspace, '.aiwg/.index'));
    const second = await refreshIndexes({ cwd: workspace }, admitted);
    expect(second.status).toBe('ok');
    expect(second.jobs).toHaveLength(3);
    expect(second.jobs.every(job => job.status === 'skipped' && job.reason === 'unchanged')).toBe(true);
    expect(snapshot(path.join(workspace, '.aiwg/.index'))).toEqual(before);
    expect(fs.existsSync(path.join(state, 'index-refresh-checkpoint.json'))).toBe(false);

    write(path.join(workspace, '.aiwg/requirements/UC-002.md'), '# Added requirement\n');
    const changed = await refreshIndexes({ cwd: workspace }, admitted);
    expect(changed.jobs.find(job => job.graph === 'project' && job.kind === 'graph')?.status).toBe('ok');
    expect(changed.jobs.find(job => job.kind === 'cache')?.status).toBe('ok');
    fs.unlinkSync(path.join(workspace, '.aiwg/requirements/UC-002.md'));
    const deleted = await refreshIndexes({ cwd: workspace }, admitted);
    expect(deleted.jobs[0].status).toBe('ok');
    expect(JSON.parse(fs.readFileSync(path.join(workspace, '.aiwg/.index/project/metadata.json'), 'utf8')).entries)
      .not.toHaveProperty('.aiwg/requirements/UC-002.md');
    const full = await refreshIndexes({ cwd: workspace, full: true }, admitted);
    expect(full.mode).toBe('full');
    expect(full.jobs.every(job => job.status === 'ok')).toBe(true);
  });

  it('skips a concurrent invocation with locked status and leaves the checkpoint alone', async () => {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let unblock!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const first = refreshIndexes({ cwd: workspace }, { gate: async () => { entered(); await blocked; return { ok: true }; } });
    await started;
    const checkpoint = fs.readFileSync(path.join(state, 'index-refresh-checkpoint.json'), 'utf8');
    try {
      const second = await refreshIndexes({ cwd: workspace }, admitted);
      expect(second).toMatchObject({ status: 'skipped', reason: 'locked', totals: { errors: 0 } });
      expect(fs.readFileSync(path.join(state, 'index-refresh-checkpoint.json'), 'utf8')).toBe(checkpoint);
    } finally {
      unblock();
      await first;
    }
  });

  it('reclaims a same-host dead PID lease and preserves live and foreign-host leases', async () => {
    const lock = path.join(state, 'index-refresh.lock');
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 123456789) throw Object.assign(new Error('dead'), { code: 'ESRCH' });
      return true;
    });
    write(path.join(lock, 'owner'), `123456789:old:${os.hostname()}\n`);
    expect((await refreshIndexes({ cwd: workspace }, admitted)).status).toBe('ok');
    expect(fs.existsSync(lock)).toBe(false);
    const release = await acquireDirectoryLock(lock);
    try {
      expect((await refreshIndexes({ cwd: workspace }, admitted)).reason).toBe('locked');
    } finally { await release(); }
    write(path.join(lock, 'owner'), '123456789:old:another-host\n');
    expect((await refreshIndexes({ cwd: workspace }, admitted)).reason).toBe('locked');
    expect(kill).toHaveBeenCalledWith(123456789, 0);
  });

  it('resumes after interruption and skips completed jobs from the matching checkpoint', async () => {
    await expect(refreshIndexes({ cwd: workspace, full: true }, {
      ...admitted,
      afterJob: (_job, count) => { if (count === 1) throw new Error('simulated interruption'); },
    })).rejects.toThrow('simulated interruption');
    const checkpointPath = path.join(state, 'index-refresh-checkpoint.json');
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    expect(checkpoint).toMatchObject({ mode: 'full', completed: [checkpoint.jobs[0]] });
    expect(checkpoint.runId).toBeTypeOf('string');
    const graphDirectory = getGraphIndexDir(workspace, 'project');
    const before = snapshot(graphDirectory);
    const report = await refreshIndexes({ cwd: workspace, full: true }, admitted);
    expect(report.jobs[0]).toMatchObject({ status: 'skipped', reason: 'checkpoint' });
    expect(report.jobs[1].status).toBe('ok');
    expect(snapshot(graphDirectory)).toEqual(before);
    expect(fs.existsSync(checkpointPath)).toBe(false);
  });

  it('does not reuse a checkpoint for another mode or job list', async () => {
    const interrupt = { ...admitted, afterJob: () => { throw new Error('stop'); } };
    await expect(refreshIndexes({ cwd: workspace }, interrupt)).rejects.toThrow('stop');
    const full = await refreshIndexes({ cwd: workspace, full: true }, admitted);
    expect(full.jobs.every(job => job.reason !== 'checkpoint')).toBe(true);
    await expect(refreshIndexes({ cwd: workspace, full: true }, interrupt)).rejects.toThrow('stop');
    config(workspace, { extra: { scanDirs: ['src'], defaultBuild: false } });
    const changedPlan = await refreshIndexes({ cwd: workspace, full: true }, admitted);
    expect(changedPlan.jobs.every(job => job.reason !== 'checkpoint')).toBe(true);
  });

  it('checks the gate before every job and keeps progress on deferral', async () => {
    const gate = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValue({ ok: false, reason: 'memory pressure' });
    const report = await refreshIndexes({ cwd: workspace }, { gate });
    expect(report).toMatchObject({ status: 'deferred', reason: 'memory pressure', totals: { ok: 1, deferred: 1, errors: 0 } });
    expect(gate).toHaveBeenCalledTimes(2);
    const checkpointPath = path.join(state, 'index-refresh-checkpoint.json');
    expect(JSON.parse(fs.readFileSync(checkpointPath, 'utf8')).completed).toHaveLength(1);
    const next = await refreshIndexes({ cwd: workspace }, admitted);
    expect(next.jobs[0].reason).toBe('checkpoint');
    expect(next.jobs[1].status).toBe('ok');
    expect(fs.existsSync(checkpointPath)).toBe(false);
  });

  it('skips all session jobs with one sqlite remedy while completing graph jobs', async () => {
    const other = path.join(root, 'other');
    config(other);
    for (const ws of [workspace, other]) write(path.join(ws, '.aiwg/sessions/catalog.sqlite'), 'catalog');
    const available = vi.fn(async () => false);
    const report = await refreshIndexes({ workspaces: [workspace, other] }, { ...admitted, sessionsAvailable: available });
    expect(report.status).toBe('partial');
    expect(report.totals.errors).toBe(0);
    expect(report.jobs.filter(job => job.kind === 'sessions').every(job => job.reason === 'sqlite unavailable')).toBe(true);
    expect(report.jobs.filter(job => job.kind === 'graph' && job.workspace === workspace).every(job => job.status === 'ok')).toBe(true);
    expect(report.messages).toEqual(['Session refresh skipped: run `aiwg features install sqlite`.']);
    expect(available).toHaveBeenCalledTimes(1);
  });

  it('scans to depth four, excludes caches and symlinks, and deduplicates repeated workspaces', () => {
    const tree = path.join(root, 'dev');
    for (const relative of ['a', 'a/b/c/d', 'a/b/c/d/e', 'node_modules/ignored', '.git/ignored', '.worktrees/ignored', 'aiwg-wt/ignored']) config(path.join(tree, relative));
    fs.symlinkSync(workspace, path.join(tree, 'link'), 'dir');
    const jobs = planIndexRefresh({ root: tree, workspaces: [workspace, workspace], only: 'graphs' });
    expect([...new Set(jobs.map(job => job.workspace))]).toEqual([path.join(tree, 'a'), path.join(tree, 'a/b/c/d'), workspace].sort());
  });

  it('isolates graph registrations with the same name across workspaces and honors --only', async () => {
    const other = path.join(root, 'other');
    config(other, { custom: { scanDirs: ['other-docs'], defaultBuild: false } });
    config(workspace, { custom: { scanDirs: ['docs'], defaultBuild: false } });
    write(path.join(workspace, 'docs/a.md'), '# First\n');
    write(path.join(other, 'other-docs/b.md'), '# Second\n');
    const report = await refreshIndexes({ workspaces: [workspace, other], only: 'graphs' }, admitted);
    expect(report.totals.errors).toBe(0);
    for (const [ws, expected] of [[workspace, 'docs/a.md'], [other, 'other-docs/b.md']]) {
      const index = JSON.parse(fs.readFileSync(path.join(ws, '.aiwg/.index/custom/metadata.json'), 'utf8'));
      expect(Object.keys(index.entries)).toEqual([expected]);
    }
    expect(planIndexRefresh({ cwd: workspace, only: 'sessions' })).toEqual([]);
    expect(planIndexRefresh({ cwd: workspace, only: 'caches' })).toEqual([]);
  });

  it('keeps shared global graphs idempotent across workspaces with different package files', async () => {
    const other = path.join(root, 'other');
    config(other);
    write(path.join(workspace, 'package.json'), '{"name":"first"}');
    write(path.join(other, 'package.json'), '{"name":"second"}');
    const shared = path.join(root, 'shared-docs');
    write(path.join(shared, 'a.md'), '# Shared note\n');
    write(path.join(process.env.HOME!, '.aiwg/aiwg.config'), JSON.stringify({
      index: { graphs: { notes: { scanDirs: [shared], defaultBuild: false } } },
    }));
    const options = { workspaces: [workspace, other], only: 'graphs' as const };
    expect((await refreshIndexes(options, admitted)).totals.errors).toBe(0);
    const directory = path.join(process.env.XDG_DATA_HOME!, 'aiwg/index/notes');
    const before = snapshot(directory);
    const report = await refreshIndexes(options, admitted);
    expect(report.jobs.filter(job => job.graph === 'notes').every(job => job.reason === 'unchanged')).toBe(true);
    expect(snapshot(directory)).toEqual(before);
  });

  it('keeps job failures resumable and emits the versioned JSON contract with a failing exit code', async () => {
    write(path.join(workspace, '.aiwg/.index/project'), 'blocks graph output');
    const report = await refreshIndexes({ cwd: workspace }, admitted);
    expect(report).toMatchObject({ status: 'partial', totals: { errors: 1, ok: 1 } });
    expect(report.jobs[0].error).toBeTypeOf('string');
    expect(JSON.parse(fs.readFileSync(path.join(state, 'index-refresh-checkpoint.json'), 'utf8')).completed).toHaveLength(1);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const cli = await runIndexRefresh(['--only', 'invalid', '--json'], workspace);
    expect(cli.status).toBe('error');
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({ contractVersion: '1.0.0', command: 'index.refresh', status: 'error' });
    process.exitCode = 0;
    log.mockClear();
    await runIndexRefresh(['--workspace', workspace, '--dry-run', '--json']);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({ status: 'ok', mode: 'incremental' });
    expect(process.exitCode).toBe(0);
  });

  it('never discovers a provider root that was not already authorized', async () => {
    const authorized = path.join(root, 'authorized-claude');
    write(path.join(authorized, 'one.jsonl'), JSON.stringify({ type: 'user', sessionId: 'one', cwd: workspace, message: { role: 'user', content: 'hello' } }) + '\n');
    const hiddenCodex = path.join(root, 'unauthorized-codex');
    write(path.join(hiddenCodex, 'two.jsonl'), '{}\n');
    const manifest = await discoverWorkspaceHistories({
      workspace, expectedProviders: ['claude', 'codex'],
      authorizedRoots: { claude: [authorized] }, codexRoot: hiddenCodex,
    });
    expect(manifest.authorizedRoots).toEqual({ claude: [authorized] });
    expect(manifest.sources.map(source => source.provider)).toEqual(['claude']);
    const saved = path.join(workspace, '.aiwg/sessions/discovery-manifest.json');
    await writeDiscoveryManifest(saved, manifest);
    expect((await readDiscoveryManifest(saved)).authorizedRoots).toEqual({ claude: [authorized] });
  });

});
