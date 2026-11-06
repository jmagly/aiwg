// Exercise first-use project discovery with isolated local sources and caches.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as builder from '../../../src/artifacts/index-builder.js';
import { discoverCapability } from '../../../src/artifacts/query-engine-discover.js';
import { main } from '../../../src/artifacts/cli.js';
import { getGraphIndexDir } from '../../../src/artifacts/types.js';

let root: string;
let project: string;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
const notice = 'Building the project index for this workspace (first use)…';
const binary = fileURLToPath(new URL('../../../bin/aiwg.mjs', import.meta.url));

function put(relative: string, content: string): void {
  const file = path.join(project, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function snapshot(): string[] {
  return fs.readdirSync(root, { recursive: true }).map(String).sort().map(relative => {
    const file = path.join(root, relative);
    return fs.statSync(file).isFile() ? `${relative}:${fs.readFileSync(file, 'hex')}` : relative;
  });
}

function output() {
  expect(log).toHaveBeenCalledOnce();
  return JSON.parse(String(log.mock.calls[0][0]));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-discover-project-'));
  project = path.join(root, 'project');
  fs.mkdirSync(project);
  for (const key of ['HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
    vi.stubEnv(key, path.join(root, key));
  }
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR',
    'AIWG_PROJECT_LOCAL_PATHS', 'AIWG_FRAMEWORK_INDEX_CACHE', 'AIWG_FRAMEWORK_INDEX_CACHE_SOURCE']) vi.stubEnv(key, '');
  vi.stubEnv('AIWG_ROOT', path.join(root, 'runtime'));
  vi.stubEnv('AIWG_CONFIG', path.join(root, 'config'));
  vi.stubEnv('AIWG_INDEX_WORKERS', '0');
  put('.aiwg/skills/workspace-orbit/SKILL.md',
    '---\nname: workspace-orbit\ndescription: Coordinate workspace orbit\n---\n# Workspace orbit\n');
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('first-use project index', () => {
  for (const backend of ['local', 'fortemi-core'] as const) {
    for (const state of ['missing', 'empty']) {
      it(`builds a ${state} index once and returns project results (${backend})`, async () => {
        if (state === 'empty') put('.aiwg/.index/project/metadata.json', '{"entries":{}}');
        const build = vi.spyOn(builder, 'buildIndex');
        const params = { phrase: 'workspace orbit', graph: 'project', backend, json: true } as const;
        await discoverCapability(project, params);
        expect(output().results[0]).toMatchObject({ name: 'workspace-orbit', provenance: { graph: 'project' } });
        expect(build).toHaveBeenCalledOnce();
        expect(error.mock.calls).toEqual([[notice]]);
        const before = snapshot();
        log.mockClear();
        error.mockClear();
        await discoverCapability(project, params);
        expect(output().results[0].name).toBe('workspace-orbit');
        expect(build).toHaveBeenCalledOnce();
        expect(error).not.toHaveBeenCalled();
        expect(snapshot()).toEqual(before);
      });
    }
  }

  it.each(['local', 'fortemi-core'] as const)('keeps default discovery complete (%s)', async backend => {
    await discoverCapability(project, { phrase: 'workspace orbit', backend, json: true });
    expect(output().results.some((result: { name: string }) => result.name === 'workspace-orbit')).toBe(true);
    expect(error.mock.calls.filter(([text]) => text === notice)).toHaveLength(1);
  });

  it.each([{ promptContext: true }, { noBuild: true }])('keeps %j silent and read-only', async mode => {
    const build = vi.spyOn(builder, 'buildIndex');
    const before = snapshot();
    await discoverCapability(project, { phrase: 'workspace orbit', json: true, ...mode });
    expect(output().results).toEqual([]);
    expect(build).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });

  it.each(['local', 'fortemi-core'] as const)('falls back without failing after a build error (%s)', async backend => {
    vi.spyOn(builder, 'buildIndex').mockRejectedValue(new Error('Synthetic build failure'));
    await discoverCapability(project, { phrase: 'workspace orbit', backend, graph: 'project', json: true });
    expect(output().results).toEqual([]);
    expect(error.mock.calls).toEqual([[notice], [expect.stringContaining('project capabilities could not be loaded')]]);
    expect(fs.existsSync(path.join(getGraphIndexDir(project, 'project'), 'metadata.json'))).toBe(false);
  });

  it('does not attempt a build when the project root is not writable', async () => {
    const directory = getGraphIndexDir(project, 'framework');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'metadata.json'), JSON.stringify({ entries: { cached: {
      name: 'cached-orbit', title: 'Cached orbit', path: 'cached/SKILL.md', type: 'skill',
      tags: [], capability: 'workspace orbit', summary: 'workspace orbit',
    } } }));
    const build = vi.spyOn(builder, 'buildIndex');
    const access = fs.accessSync;
    vi.spyOn(fs, 'accessSync').mockImplementation((file, mode) => {
      if (file === project && mode === fs.constants.W_OK) throw new Error('Read-only fixture');
      return access(file, mode);
    });
    await discoverCapability(project, { phrase: 'workspace orbit', backend: 'local', json: true });
    expect(output().results[0].name).toBe('cached-orbit');
    expect(build).not.toHaveBeenCalled();
    expect(error.mock.calls.flat()).not.toContain(notice);
  });

  it('honours the CLI --no-build flag without creating an index or receipt', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    const before = snapshot();
    const build = vi.spyOn(builder, 'buildIndex');
    await main(['discover', 'workspace orbit', '--no-build', '--json']);
    expect(output().results).toEqual([]);
    expect(build).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });

  it('serves warm results through --no-build without updating caches', async () => {
    await discoverCapability(project, { phrase: 'workspace orbit', graph: 'project', json: true });
    log.mockClear();
    error.mockClear();
    const build = vi.spyOn(builder, 'buildIndex');
    const before = snapshot();
    await discoverCapability(project, { phrase: 'workspace orbit', noBuild: true, json: true });
    expect(output().results[0].name).toBe('workspace-orbit');
    expect(build).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });

  it('shares one build across concurrent queries', async () => {
    const build = vi.spyOn(builder, 'buildIndex');
    await Promise.all([1, 2].map(() => discoverCapability(project, {
      phrase: 'workspace orbit', graph: 'project', backend: 'local', json: true,
    })));
    expect(build).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledTimes(2);
    expect(error.mock.calls).toEqual([[notice]]);
  });

  it('keeps built CLI JSON stdout parseable and notices only the first call', () => {
    const invoke = () => spawnSync(process.execPath, [binary, 'discover', 'workspace orbit', '--graph', 'project', '--json'], {
      cwd: project, env: { ...process.env }, encoding: 'utf8', timeout: 30_000,
    });
    const first = invoke();
    expect(first.status, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout).results[0].name).toBe('workspace-orbit');
    expect(first.stderr.trim()).toBe(notice);
    const metadata = fs.readFileSync(path.join(getGraphIndexDir(project, 'project'), 'metadata.json'), 'utf8');
    const second = invoke();
    expect(second.status, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout).results[0].name).toBe('workspace-orbit');
    expect(second.stderr).toBe('');
    expect(fs.readFileSync(path.join(getGraphIndexDir(project, 'project'), 'metadata.json'), 'utf8')).toBe(metadata);
  });
});
