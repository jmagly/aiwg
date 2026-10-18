import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDefaultLane } from '../../../tools/testing/run-default-lane.mjs';

import { DEFAULT_ALLOWED_ENTRIES, findLeakedEntries } from '../../../tools/testing/check-tmpdir-leaks.mjs';

const tmpRoots = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tmpRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function tmpDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

describe('tmpdir leak gate (#3018)', () => {
  it('reports no leaks for an empty directory', async () => {
    const dir = await tmpDir('aiwg-leak-gate-empty-');
    expect(findLeakedEntries(dir)).toEqual([]);
  });

  it('reports no leaks (not an error) for a directory that does not exist', () => {
    expect(findLeakedEntries('/does/not/exist/aiwg-leak-gate')).toEqual([]);
  });

  it('ignores the default allowlist (process-wide Node/tsx compile caches)', async () => {
    const dir = await tmpDir('aiwg-leak-gate-allowed-');
    await mkdir(join(dir, 'node-compile-cache'));
    await mkdir(join(dir, 'tsx-1000'));
    await mkdir(join(dir, 'tsx-0'));
    expect(findLeakedEntries(dir)).toEqual([]);
  });

  it('flags any other entry a test run left behind', async () => {
    const dir = await tmpDir('aiwg-leak-gate-flagged-');
    await mkdir(join(dir, 'aiwg-skill-usage-abc123'));
    await writeFile(join(dir, 'stray-file.json'), '{}');
    expect(findLeakedEntries(dir)).toEqual(['aiwg-skill-usage-abc123', 'stray-file.json']);
  });

  it('honors caller-supplied allow patterns in addition to the defaults', async () => {
    const dir = await tmpDir('aiwg-leak-gate-custom-allow-');
    await mkdir(join(dir, 'known-fixture-cache'));
    await mkdir(join(dir, 'aiwg-skill-usage-abc123'));
    expect(findLeakedEntries(dir, { allow: [/^known-fixture-cache$/] })).toEqual(['aiwg-skill-usage-abc123']);
  });

  it('exposes the default allowlist as patterns, not hardcoded strings callers must duplicate', () => {
    expect(DEFAULT_ALLOWED_ENTRIES.every(pattern => pattern instanceof RegExp)).toBe(true);
    expect(DEFAULT_ALLOWED_ENTRIES.some(pattern => pattern.test('node-compile-cache'))).toBe(true);
    expect(DEFAULT_ALLOWED_ENTRIES.some(pattern => pattern.test('tsx-12345'))).toBe(true);
  });
});


describe('default lane private TMPDIR', () => {
  async function runChild(source) {
    const root = await tmpDir('aiwg-lane-wrapper-');
    vi.stubEnv('TMPDIR', root);
    const code = await runDefaultLane([], { runnerArgs: ['-e', source] });
    return { root, code, entries: await readdir(root) };
  }

  it('leaves the caller temp directory empty on success', async () => {
    const result = await runChild('process.exit(0)');
    expect(result).toMatchObject({ code: 0, entries: [] });
  });

  it('preserves existing entries in the caller temp directory', async () => {
    const root = await tmpDir('aiwg-lane-existing-');
    await writeFile(join(root, 'unrelated.txt'), 'keep');
    vi.stubEnv('TMPDIR', root);
    expect(await runDefaultLane([], { runnerArgs: ['-e', 'process.exit(0)'] })).toBe(0);
    expect(await readdir(root)).toEqual(['unrelated.txt']);
  });

  it('preserves test failure status and still removes its empty directory', async () => {
    const result = await runChild('process.exit(7)');
    expect(result).toMatchObject({ code: 7, entries: [] });
  });

  it('removes its empty directory when the runner cannot start', async () => {
    const root = await tmpDir('aiwg-lane-spawn-error-');
    vi.stubEnv('TMPDIR', root);
    await expect(runDefaultLane([], { command: '/does/not/exist/aiwg-runner' }))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(root)).toEqual([]);
  });

  it('checks cleanup when the child terminates on a signal', async () => {
    const result = await runChild("process.kill(process.pid, 'SIGTERM')");
    expect(result).toMatchObject({ code: 1, entries: [] });
  });

  it.each([0, 7])('fails on leaks even when the child exits %i', async (exitCode) => {
    const result = await runChild(`
      require('node:fs').mkdirSync(require('node:path').join(require('node:os').tmpdir(), 'leaked-fixture'));
      process.exit(${exitCode});
    `);
    expect(result.code).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(await readdir(join(result.root, result.entries[0]))).toEqual(['leaked-fixture']);
  });

  it('cleans process-owned tooling caches before checking the lane result', async () => {
    const result = await runChild(`
      const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
      for (const name of ['node-compile-cache', 'tsx-1000']) fs.mkdirSync(path.join(os.tmpdir(), name));
    `);
    expect(result).toMatchObject({ code: 0, entries: [] });
  });
});
