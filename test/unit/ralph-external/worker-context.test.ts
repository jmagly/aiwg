/**
 * Unit tests for the tools-side worker-context loader and launch ensure
 * (#3685 round 2, T-OG-04).
 *
 * The config loads through the existing `readAiwgConfig` loader and the
 * union resolves through the src-side pure function; both seams are
 * injected here (synthetic config-shaped objects, no real HOME). The
 * `ensureFn` seam stubs the whole deploy path; the real one-pass deploy
 * against the built CLI is proven by the conformance deploy test.
 *
 * @source @tools/ralph-external/lib/worker-context.mjs
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ensureWorkerContextForLaunch,
  resolveWorkerContextProviders,
  defaultDeployWorkerContext,
  listDeployDirtiedBridges,
} from '../../../tools/ralph-external/lib/worker-context.mjs';
import { resolveWorkerContextProvidersFromConfig } from '../../../src/config/worker-context.js';

const REAL_UNION = resolveWorkerContextProvidersFromConfig;
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function workdir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'tools-worker-context-')); roots.push(dir); return dir;
}

describe('resolveWorkerContextProviders (tools): loader plus src-side union', () => {
  it('returns an explicit list verbatim without touching the loader', async () => {
    const readConfig = async () => { throw new Error('must not load config for an explicit list'); };
    await expect(resolveWorkerContextProviders({ repoRoot: '/repo', providers: ['b', 'a', 'b'], readConfig }))
      .resolves.toEqual({ providers: ['b', 'a'], skipped: [] });
  });

  it('loads the config through the injected loader and resolves the union through the src function', async () => {
    const config = {
      providers: ['muse'],
      parallelism: {
        clis: { codex: { adapter: 'providers:codex' } },
        groups: { harness: { members: [{ id: 'm1', cli: 'codex' }] } },
      },
    };
    await expect(resolveWorkerContextProviders({
      repoRoot: '/repo', readConfig: async () => config, resolveFromConfig: REAL_UNION,
    })).resolves.toEqual({ providers: ['muse', 'codex'], skipped: [] });
  });

  it('reports skipped non-provider adapters from orchestration config', async () => {
    const config = {
      providers: ['muse'],
      parallelism: { clis: { local: { adapter: 'workerAdapters:local-http' } }, groups: {} },
    };
    await expect(resolveWorkerContextProviders({
      repoRoot: '/repo', readConfig: async () => config, resolveFromConfig: REAL_UNION,
    })).resolves.toEqual({ providers: ['muse'], skipped: ['clis/local: workerAdapters:local-http'] });
  });

  it('fails closed on a missing config, an empty union, and an empty explicit list', async () => {
    await expect(resolveWorkerContextProviders({ repoRoot: '/repo', readConfig: async () => null }))
      .rejects.toThrow(/configured providers/);
    await expect(resolveWorkerContextProviders({
      repoRoot: '/repo', readConfig: async () => ({}), resolveFromConfig: REAL_UNION,
    })).rejects.toThrow(/union.*is empty/);
    await expect(resolveWorkerContextProviders({ repoRoot: '/repo', providers: [] }))
      .rejects.toThrow(/non-empty array/);
  });
});

describe('ensureWorkerContextForLaunch: cli mapping, one-pass deploy set, typed refusal', () => {
  const config = {
    providers: ['muse'],
    parallelism: { clis: { codex: { adapter: 'providers:codex' } }, groups: {} },
  };

  it('maps the worker CLI and deploys only its provider in one project-local ensure call', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const outcome = await ensureWorkerContextForLaunch({
      workdir: '/w', cli: 'codex', config, resolveFromConfig: REAL_UNION,
      mapCli: async (cli: string) => ({ provider: 'codex' }),
      ensureFn: async (opts: Record<string, unknown>) => {
        seen.push(opts);
        return { ensured: true, providers: opts.providers, skippedBridges: [] };
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ workdir: '/w', provider: 'codex', providers: ['codex'], projectLocal: true });
    expect(outcome).toMatchObject({ ensured: true, provider: 'codex', skipped: [] });
  });

  it('refuses with a typed diagnostic naming the remedy when the CLI maps nowhere', async () => {
    const error = await ensureWorkerContextForLaunch({
      workdir: '/w', cli: 'local', config,
      mapCli: async () => ({ skipped: 'clis/local: workerAdapters:local-http' }),
      ensureFn: async () => { throw new Error('must not deploy an unmappable CLI'); },
    }).then(() => { throw new Error('must have refused'); }, (caught: unknown) => caught) as Record<string, unknown>;
    expect(error.code).toBe('OG_WORKER_CONTEXT_UNAVAILABLE');
    expect(String(error.message)).toMatch(/maps to no AIWG provider/);
    expect(String(error.remedy)).toMatch(/parallelism\.clis\.local/);
  });

  it('propagates the ensure failure instead of launching', async () => {
    await expect(ensureWorkerContextForLaunch({
      workdir: '/w', cli: 'codex', providers: ['codex'],
      mapCli: async () => ({ provider: 'codex' }),
      ensureFn: async () => { throw Object.assign(new Error('deploy broke'), { code: 'OG_WORKER_CONTEXT_UNAVAILABLE', remedy: 'fix it' }); },
    })).rejects.toMatchObject({ code: 'OG_WORKER_CONTEXT_UNAVAILABLE' });
  });

  it('refuses missing workdir and CLI before invoking the ensure seam', async () => {
    const ensureFn = vi.fn();
    await expect(ensureWorkerContextForLaunch({ ensureFn })).rejects.toThrow(/needs a workdir/);
    await expect(ensureWorkerContextForLaunch({ workdir: workdir(), ensureFn })).rejects.toThrow(/worker CLI id/);
    expect(ensureFn).not.toHaveBeenCalled();
  });

  it('reports an unmapped CLI even when the mapper supplies no diagnostic', async () => {
    await expect(ensureWorkerContextForLaunch({ workdir: workdir(), cli: 'local', mapCli: async () => ({}) }))
      .rejects.toMatchObject({ code: 'OG_WORKER_CONTEXT_UNAVAILABLE', message: expect.stringContaining('(unmapped)') });
  });

  it('loads repo config when absent and passes all ensure seams through', async () => {
    const dir = workdir(), statusFn = vi.fn(), deployFn = vi.fn(), skipWorktreeFn = vi.fn();
    const ensureFn = vi.fn(async ({ providers }) => ({ providers, ensured: false, skippedBridges: [] }));
    await expect(ensureWorkerContextForLaunch({ workdir: dir, repoRoot: dir, cli: 'codex',
      readConfig: async () => config, resolveFromConfig: REAL_UNION, mapCli: async () => ({ provider: 'codex' }),
      ensureFn, statusFn, deployFn, skipWorktreeFn,
    })).resolves.toMatchObject({ provider: 'codex', providers: ['codex'] });
    expect(ensureFn).toHaveBeenCalledWith(expect.objectContaining({ statusFn, deployFn, skipWorktreeFn }));
  });
});

describe('T-OG-04 tools context deploy and bridge refusals', () => {
  it('refuses a missing binary and never spawns after validation fails', async () => {
    const spawn = vi.fn();
    await expect(defaultDeployWorkerContext({ worktreePath: workdir(), providers: ['muse'], aiwgBin: '', spawn }))
      .rejects.toThrow(/an aiwg binary/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('falls back to the requested providers when an injected sync supplies no union', async () => {
    const dir = workdir(), spawn = vi.fn(() => ({ status: 0 })), argvFn = vi.fn(async () => ['use', 'all']);
    await expect(defaultDeployWorkerContext({ worktreePath: dir, providers: ['muse'],
      syncFn: async () => null, argvFn, spawn,
    })).resolves.toEqual({ providers: ['muse'] });
    expect(argvFn).toHaveBeenCalledWith(['muse'], dir);
  });

  it.each([{ error: new Error('git missing') }, { status: 128, stderr: undefined }])(
    'reports failed bridge discovery %j', result => {
      expect(() => listDeployDirtiedBridges({ worktreePath: workdir(), spawn: () => result })).toThrow(/git status/);
    },
  );

  it('treats absent status stdout as clean', () => {
    expect(listDeployDirtiedBridges({ worktreePath: workdir(), spawn: () => ({ status: 0 }) })).toEqual([]);
  });
});
