import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SnapshotManager } from '../../../tools/ralph-external/snapshot-manager.mjs';

let root;
let manager;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'snapshot-resilience-'));
  manager = new SnapshotManager(root);
  vi.spyOn(manager, 'captureGitStatus').mockReturnValue({ commit: 'unknown' });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
function artifact(path) {
  const file = join(root, path);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, '{}');
  return file;
}

describe('snapshot omissions', () => {
  it('excludes derived index state and persists explicit partial pre/post snapshots', () => {
    const index = artifact('.aiwg/.index/project/refresh-state.json');
    chmodSync(index, 0);
    artifact('.aiwg/working/readable.json');
    const out = join(root, 'snapshots');
    for (const snapshot of [manager.capturePreSnapshot(root, out), manager.capturePostSnapshot(root, out)]) {
      expect(snapshot.aiwg.files.map(file => file.path)).toEqual(['.aiwg/working/readable.json']);
      expect(snapshot.completeness).toEqual({ status: 'partial', omissions: [
        { path: '.aiwg/.index', reason: 'derived-index' },
      ] });
    }
    expect(statSync(index).mode & 0o777).toBe(0);
    expect(JSON.parse(readFileSync(join(out, 'post-snapshot.json'), 'utf8')).completeness.status).toBe('partial');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('.aiwg/.index'));
  });

  it.skipIf(process.getuid?.() === 0)('skips chmod 000 files and directories without broadening permissions', () => {
    const privateFile = artifact('.aiwg/working/private.json');
    const keyFile = artifact('package.json');
    const testResult = artifact('.aiwg/testing/test-results.md');
    const privateDir = join(root, '.aiwg/private');
    artifact('.aiwg/private/hidden.json');
    for (const path of [privateFile, keyFile, testResult, privateDir]) chmodSync(path, 0);
    try {
      const pre = manager.capturePreSnapshot(root, join(root, 'snapshots'));
      const post = manager.capturePostSnapshot(root, join(root, 'snapshots'));
      expect(pre.keyFiles).toEqual([]);
      for (const snapshot of [pre, post]) {
        expect(snapshot.completeness.status).toBe('partial');
        expect(snapshot.aiwg.files).toEqual([]);
        expect(snapshot.completeness.omissions).toEqual(expect.arrayContaining([
          { path: '.aiwg/working/private.json', reason: 'EACCES' },
          { path: '.aiwg/private', reason: 'EACCES' },
          { path: '.aiwg/testing/test-results.md', reason: 'EACCES' },
        ]));
      }
      for (const path of [privateFile, keyFile, testResult, privateDir]) expect(statSync(path).mode & 0o777).toBe(0);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('EACCES'));
    } finally { chmodSync(privateDir, 0o700); }
  });

  it('does not follow unrelated symlinked test artifacts', () => {
    const target = artifact('private-result.json');
    writeFileSync(target, '{"numTotalTests": 2}');
    mkdirSync(join(root, '.aiwg/testing'), { recursive: true });
    symlinkSync(target, join(root, '.aiwg/testing/test-results.md'));
    const out = join(root, 'snapshots');
    manager.capturePreSnapshot(root, out);
    const snapshot = manager.capturePostSnapshot(root, out);
    expect(snapshot.tests.found).toBe(false);
    expect(snapshot.completeness).toEqual({ status: 'partial', omissions: [
      { path: '.aiwg/testing/test-results.md', reason: 'not-regular-file' },
    ] });
  });

  it('reports a complete snapshot when nothing was omitted and resets omissions each time', () => {
    artifact('.aiwg/.index/derived.json');
    expect(manager.capturePreSnapshot(root, join(root, 'first')).completeness.status).toBe('partial');
    rmSync(join(root, '.aiwg/.index'), { recursive: true });
    artifact('.aiwg/working/file.json');
    const snapshot = manager.capturePreSnapshot(root, join(root, 'snapshots'));
    expect(snapshot.completeness).toEqual({ status: 'complete', omissions: [] });
  });
});
