// Deterministic filesystem-work bounds for allowance-ledger contention (#4081).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, mkdir, rename, symlink, open, lstat, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants } from 'node:fs';

const probe = vi.hoisted(() => ({ counts: {}, recording: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal();
  const count = name => {
    if (probe.recording) probe.counts[name] = (probe.counts[name] ?? 0) + 1;
  };
  return { ...actual, ...Object.fromEntries(['open', 'lstat', 'readdir'].map(name =>
    [name, async (...args) => {
      count(name);
      const result = await actual[name](...args);
      if (name === 'open') {
        const sync = result.sync.bind(result);
        result.sync = async () => { count('sync'); return sync(); };
      }
      return result;
    }])) };
});
import { reserveDirectWorkerAllowance, debitDirectWorkerAllowance } from '../../../tools/ralph-external/session-launcher.mjs';

describe('allowance ledger filesystem work', () => {
  afterEach(() => { probe.recording = false; });

  it('does not reopen directory ancestry for each occupied slot or validated entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-ledger-work-'));
    const maxAttempts = 8;
    const samples = [];
    try {
      for (let n = 0; n < maxAttempts; n += 1) {
        probe.counts = {};
        probe.recording = true;
        const ledger = await reserveDirectWorkerAllowance({ captureRoot: root,
          taskChainDigest: 'work-bound', invocationId: `inv-${n}`, maxAttempts });
        await debitDirectWorkerAllowance(ledger);
        probe.recording = false;
        samples.push({ ...probe.counts });
      }
      console.log('ledger filesystem work:', JSON.stringify(samples));
      // Only the six additional O_EXCL probes need opens. Directory
      // validation still stats EVERY entry and durability still syncs.
      expect(samples.at(-1).lstat - samples[1].lstat).toBe(2 * (maxAttempts - 2));
      expect(samples.at(-1).sync).toBe(samples[1].sync);
      expect(samples.at(-1).open - samples[1].open).toBeLessThanOrEqual(maxAttempts - 2);
    } finally {
      probe.recording = false;
      await rm(root, { recursive: true, force: true });
    }
  });
});

// The batch keeps the same no-follow ancestry guarantees as withWorkerPath.
// Import via the namespace so the pre-fix work-bound test can run alone.
import * as workerInputs from '../../../tools/ralph-external/lib/worker-inputs.mjs';

describe('pinned ledger directory operations', () => {
  it('pins the chain across replacement and closes the descriptor on return', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-ledger-pin-'));
    const dir = join(root, 'chain');
    const moved = join(root, 'original');
    const outside = join(root, 'outside');
    let pinned;
    try {
      await mkdir(dir);
      await mkdir(outside);
      await workerInputs.withWorkerDirectory(dir, async withPath => {
        pinned = await withPath(dir, target => target);
        await rename(dir, moved);
        await symlink(outside, dir);
        await withPath(join(dir, 'attempt-1'), async target => {
          const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { await handle.writeFile('owned'); } finally { await handle.close(); }
        });
        // A pinned directory is also valid as the operation's own target.
        expect((await withPath(dir, target => lstat(target))).isDirectory()).toBe(true);
      });
      expect(await readFile(join(moved, 'attempt-1'), 'utf8')).toBe('owned');
      await expect(lstat(join(outside, 'attempt-1'))).rejects.toMatchObject({ code: 'ENOENT' });
      // The pinned chain directory now lives at `moved`. Its descriptor number may be reused by
      // another open (CI run 103829 saw a directory there), so occupy it deterministically.
      const handles = await occupyDescriptor(pinned, outside);
      try { await expectHandleReleased(pinned, moved); } finally { for (const handle of handles) await handle.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects symlinked chain directories and child symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-ledger-no-follow-'));
    const dir = join(root, 'chain');
    try {
      await mkdir(dir);
      await symlink(dir, join(root, 'alias'));
      await expect(workerInputs.withWorkerDirectory(join(root, 'alias'), () => {})).rejects.toThrow();
      await symlink(join(root, 'outside'), join(dir, 'attempt-1'));
      await workerInputs.withWorkerDirectory(dir, async withPath => {
        await expect(withPath(join(dir, 'attempt-1'), target =>
          open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)))
          .rejects.toMatchObject({ code: 'EEXIST' });
      });
      await expect(lstat(join(root, 'outside'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects paths outside the pinned directory and closes on callback failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-ledger-pin-error-'));
    let pinned;
    try {
      await expect(workerInputs.withWorkerDirectory(root, async withPath => {
        pinned = await withPath(root, target => target);
        for (const filename of [join(root, 'nested', 'slot'), root + '/../slot', root + '/..', root + '-other/slot', 'relative', root + '/bad\0name']) {
          const operation = vi.fn();
          await expect(withPath(filename, operation)).rejects.toThrow(/Invalid worker path/);
          expect(operation).not.toHaveBeenCalled();
        }
        throw new Error('callback failed');
      })).rejects.toThrow('callback failed');
      await expectHandleReleased(pinned, root);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  // The pinned path is /proc/self/fd/<n>/. Once closed, the process may reuse <n> for
  // any file (ENOTDIR) or directory, so closure means it no longer resolves to root.
  it('treats a reused descriptor number as released, not as the pinned directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-ledger-pin-reuse-'));
    let pinned;
    try {
      await workerInputs.withWorkerDirectory(root, async withPath => { pinned = await withPath(root, target => target); });
      const occupant = join(root, 'occupant');
      await writeFile(occupant, 'x');
      const handle = await open(occupant, 'r');
      try { await expectHandleReleased(pinned, root); } finally { await handle.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

// Open directory handles until one takes the released descriptor number from /proc/self/fd/<n>/.
async function occupyDescriptor(pinned, directory) {
  const wanted = Number(/\/proc\/self\/fd\/(\d+)/.exec(pinned)?.[1]);
  const handles = [];
  for (let i = 0; i < 64 && !handles.some(handle => handle.fd === wanted); i++) handles.push(await open(directory, 'r'));
  expect(handles.map(handle => handle.fd)).toContain(wanted);
  return handles;
}

async function expectHandleReleased(pinned, root) {
  const rootInode = (await stat(root)).ino;
  const after = await stat(pinned).catch(error => ({ error }));
  if ('error' in after) expect(['ENOENT', 'ENOTDIR']).toContain(after.error.code);
  else expect(after.ino).not.toBe(rootInode);
}
