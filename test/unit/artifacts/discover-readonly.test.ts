// Exercise sandbox write failures through the built CLI with synthetic indexes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildIndex } from '../../../src/artifacts/index-builder.js';
import { getFortemiCoreIndexDir } from '../../../src/artifacts/fortemi-core-sync.js';
import { getGraphIndexDir } from '../../../src/artifacts/types.js';

const binary = fileURLToPath(new URL('../../../bin/aiwg.mjs', import.meta.url));
let tmp: string;
let root: string;
let project: string;
let preload: string;

function put(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-discover-readonly-'));
  root = path.join(tmp, 'runtime');
  project = path.join(tmp, 'project');
  fs.mkdirSync(project);
  for (const key of ['HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
    vi.stubEnv(key, path.join(tmp, key));
  }
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR',
    'AIWG_PROJECT_LOCAL_PATHS', 'AIWG_FRAMEWORK_INDEX_CACHE', 'AIWG_FRAMEWORK_INDEX_CACHE_SOURCE']) vi.stubEnv(key, '');
  vi.stubEnv('AIWG_ROOT', root);
  vi.stubEnv('AIWG_CONFIG', path.join(tmp, 'config'));
  vi.stubEnv('AIWG_INDEX_WORKERS', '0');
  put(path.join(root, 'package.json'), '{"name":"aiwg","version":"1.0.0"}');
  for (const kind of ['frameworks', 'addons', 'extensions', 'agents', 'behaviors']) {
    fs.mkdirSync(path.join(root, 'agentic/code', kind), { recursive: true });
  }
  put(path.join(root, 'agentic/code/addons/probe/skills/orbit/SKILL.md'),
    '---\nname: orbit\ndescription: Coordinate workspace orbit\n---\n# Workspace orbit\n');
  preload = path.join(tmp, 'readonly.cjs');
  put(preload, `
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const blocked = process.env.TEST_READONLY_PATH;
// The fixture owns its corpus; the checkout's shipped export is not installed here.
const readFileSync = fs.readFileSync;
fs.readFileSync = function(file, ...args) {
  if (String(file).includes(require('node:path').sep + 'prebuilt' + require('node:path').sep)
      && !String(file).startsWith(process.env.AIWG_ROOT + require('node:path').sep)) {
    throw Object.assign(new Error('Fixture has no packaged index'), { code: 'ENOENT' });
  }
  return readFileSync.call(this, file, ...args);
};
function deny(file) {
  if (String(file).startsWith(blocked)) {
    const error = new Error(process.env.TEST_READONLY_CODE + ': sandbox write denied, mkdir ' + file);
    error.code = process.env.TEST_READONLY_CODE;
    throw error;
  }
}
const mkdir = fs.promises.mkdir;
fs.promises.mkdir = async function(file, ...args) { deny(file); return mkdir.call(this, file, ...args); };
const mkdirSync = fs.mkdirSync;
fs.mkdirSync = function(file, ...args) { deny(file); return mkdirSync.call(this, file, ...args); };
syncBuiltinESMExports();
`);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function invoke(blocked: string, code: string, args: string[] = []) {
  return spawnSync(process.execPath, ['--require', preload, binary, 'discover', 'workspace orbit', '--json', ...args], {
    cwd: project, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, TEST_READONLY_PATH: blocked, TEST_READONLY_CODE: code },
  });
}

describe('discover with read-only index storage (#3902)', () => {
  for (const code of ['EROFS', 'EACCES', 'EPERM']) {
    for (const backend of ['local', 'fortemi-core']) {
      it(`serves existing metadata with one stale warning (${code}, ${backend})`, async () => {
        await buildIndex(root, { graph: 'framework', quiet: true });
        const directory = getGraphIndexDir(project, 'framework');
        const metadata = fs.readFileSync(path.join(directory, 'metadata.json'), 'utf8');
        // Deny the actual asynchronous lock mkdir, after the source receipt succeeds.
        const result = invoke(path.join(directory, 'capability-refresh.lock'), code, ['--backend', backend]);
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout).results[0].name).toBe('orbit');
        expect(JSON.parse(result.stdout).stale).toBe(true);
        expect(result.stderr.trim().split('\n')).toEqual([expect.stringMatching(/Warning:.*stale/i)]);
        expect(fs.readFileSync(path.join(directory, 'metadata.json'), 'utf8')).toBe(metadata);
      });

      it(`fails actionably without a usable index (${code}, ${backend})`, () => {
        const result = invoke(getGraphIndexDir(project, 'framework'), code, ['--backend', backend]);
        expect(result.status).not.toBe(0);
        expect(result.stderr.trim().split('\n')).toEqual([
          expect.stringMatching(/index.*writable.*XDG_DATA_HOME/i),
        ]);
        expect(result.stdout).toBe('');
      });
    }
  }

  it('serves metadata when the entire index root is read-only and relations are missing', async () => {
    await buildIndex(root, { graph: 'framework', quiet: true });
    const directory = getGraphIndexDir(project, 'framework');
    fs.rmSync(path.join(directory, 'relations.json'));
    const result = invoke(directory, 'EROFS');
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ stale: true, results: [{ name: 'orbit' }] });
    expect(result.stderr.trim().split('\n')).toEqual([expect.stringMatching(/Warning:.*stale/i)]);
  });

  it('rejects an empty existing index when refreshing is denied', () => {
    const directory = getGraphIndexDir(project, 'framework');
    put(path.join(directory, 'metadata.json'), '{"entries":{}}');
    const result = invoke(directory, 'EROFS');
    expect(result.status).not.toBe(0);
    expect(result.stderr.trim().split('\n')).toEqual([expect.stringMatching(/index.*writable.*XDG_DATA_HOME/i)]);
    expect(result.stdout).toBe('');
  });

  it('serves a project index published before its derived-cache write fails', () => {
    put(path.join(project, '.aiwg/skills/local/SKILL.md'),
      '---\nname: local\ndescription: Coordinate workspace orbit\n---\n# Workspace orbit\n');
    const result = invoke(getFortemiCoreIndexDir(project, 'project'), 'EPERM', ['--graph', 'project']);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ stale: true, results: [{ name: 'local' }] });
    expect(result.stderr.match(/Warning:/g)).toHaveLength(1);
  });

  it('uses framework results if the first-use project auto-build is denied', async () => {
    await buildIndex(root, { graph: 'framework', quiet: true });
    put(path.join(project, '.aiwg/skills/local/SKILL.md'), '# Local capability\n');
    const result = invoke(getGraphIndexDir(project, 'project'), 'EROFS');
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).results[0].name).toBe('orbit');
    expect(result.stderr.match(/Warning:/g)).toHaveLength(1);
    expect(result.stderr).toMatch(/stale/i);
  });

  it('fails actionably if the project auto-build is denied without an existing index', () => {
    put(path.join(project, '.aiwg/skills/local/SKILL.md'), '# Local capability\n');
    const result = invoke(getGraphIndexDir(project, 'project'), 'EACCES', ['--graph', 'project']);
    expect(result.status).not.toBe(0);
    expect(result.stderr.trim().split('\n')).toEqual([
      expect.stringMatching(/index.*writable.*AIWG_ARTIFACTS_PATH/i),
    ]);
    expect(result.stdout).toBe('');
  });
});
