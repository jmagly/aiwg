import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  closeSync, constants as fsConstants, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync,
  readlinkSync, rmSync, truncateSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  MAX_ARTIFACT_BYTES, MAX_TREE_BYTES, MAX_TREE_ENTRIES, MAX_TREE_FILE_BYTES, WorktreeEscapeError, computeWorktreeTreeDigest,
  pinArtifact, verifyWorkerArtifact,
} from '../../../tools/ralph-external/lib/trusted-verification.mjs';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    fstatSync: vi.fn(actual.fstatSync),
    readSync: vi.fn(actual.readSync),
    openSync: vi.fn(actual.openSync),
    closeSync: vi.fn(actual.closeSync),
  };
});

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'aiwg-verification-bounds-'));
  roots.push(root);
  const artifact = path.join(root, 'artifact');
  writeFileSync(artifact, 'bounded artifact');
  return { root, artifact };
}
// Some sandbox mounts fail the required same-device check.
const supportsPinnedFixtures = process.platform === 'linux' && (() => {
  const { root, artifact } = fixture();
  try { const pinned = pinArtifact(root, artifact); closeSync(pinned.fd); return true; }
  catch { return false; }
})();

function expectDescriptorsClosed() {
  const opens = vi.mocked(openSync);
  const closes = vi.mocked(closeSync);
  const events = opens.mock.results.flatMap((result, index) => result.type === 'return'
    ? [{ order: opens.mock.invocationCallOrder[index], fd: result.value, open: true }] : []);
  events.push(...closes.mock.calls.map(([fd], index) => ({ order: closes.mock.invocationCallOrder[index], fd, open: false })));
  const active = new Set<number>();
  for (const event of events.sort((a, b) => a.order - b.order)) {
    if (event.open) { expect(active.has(event.fd)).toBe(false); active.add(event.fd); }
    else {
      const closeIndex = closes.mock.invocationCallOrder.indexOf(event.order);
      expect(closes.mock.results[closeIndex].type).toBe('return');
      expect(active.delete(event.fd)).toBe(true);
    }
  }
  expect(active.size).toBe(0);
}

afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('trusted artifact resource bounds', () => {
  it.skipIf(!supportsPinnedFixtures)('rejects a FIFO with no writer without blocking the conductor', () => {
    const { root, artifact } = fixture();
    rmSync(artifact);
    expect(spawnSync('mkfifo', [artifact], { timeout: 2000 }).status).toBe(0);
    const moduleUrl = new URL('../../../tools/ralph-external/lib/trusted-verification.mjs', import.meta.url).href;
    const output = path.join(root, 'probe-output');
    const outputFd = openSync(output, 'w');
    let child;
    try {
      child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { verifyWorkerArtifact } from ${JSON.stringify(moduleUrl)};
      const result = verifyWorkerArtifact({ worktreeRoot: process.argv[1], artifactPath: process.argv[2] });
      console.log(JSON.stringify(result));
    `, root, artifact], { timeout: 3000, stdio: ['ignore', outputFd, outputFd] });
    } finally {
      closeSync(outputFd);
    }
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    const result = JSON.parse(readFileSync(output, 'utf8'));
    expect(result.status).toBe('rejected');
    expect(result.findings.join(';')).toMatch(/regular file|different filesystem/);
    expect(() => pinArtifact(root, artifact)).toThrow(/regular file/);
  });

  it.skipIf(!supportsPinnedFixtures)('rejects a real Unix socket artifact when sockets are permitted', async context => {
    const { root, artifact } = fixture();
    rmSync(artifact);
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(artifact, resolve);
      });
    } catch (error) {
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        context.skip('Unix socket creation is prohibited on this host');
        return;
      }
      throw error;
    }
    try {
      expect(() => pinArtifact(root, artifact)).toThrow(WorktreeEscapeError);
      expect(verifyWorkerArtifact({ worktreeRoot: root, artifactPath: artifact }).status).toBe('rejected');
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it.skipIf(!supportsPinnedFixtures)('rejects a non-regular artifact and closes the pinned descriptor', async () => {
    const { root, artifact } = fixture();
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(fstatSync).mockImplementation(fd => {
      const stat = actual.fstatSync(fd);
      if (readlinkSync(`/proc/self/fd/${fd}`) === artifact) {
        return Object.assign(stat, { isFile: () => false });
      }
      return stat;
    });
    expect(() => pinArtifact(root, artifact)).toThrow(/regular file/);
    const index = vi.mocked(openSync).mock.calls.findIndex(([target]) => target === artifact);
    const flags = vi.mocked(openSync).mock.calls[index][1] as number;
    expect(flags & fsConstants.O_NONBLOCK).toBe(fsConstants.O_NONBLOCK);
    expect(flags & fsConstants.O_NOFOLLOW).toBe(fsConstants.O_NOFOLLOW);
    expectDescriptorsClosed();
    expect(vi.mocked(readSync)).not.toHaveBeenCalled();
  });

  it.skipIf(!supportsPinnedFixtures)('rejects a real device when this host permits creating one', context => {
    const { root, artifact } = fixture();
    rmSync(artifact);
    const created = spawnSync('mknod', [artifact, 'c', '1', '3'], { timeout: 2000, encoding: 'utf8' });
    if (created.status !== 0) { context.skip('device-node creation is unavailable'); return; }
    expect(() => pinArtifact(root, artifact)).toThrow(WorktreeEscapeError);
    expect(verifyWorkerArtifact({ worktreeRoot: root, artifactPath: artifact }).status).toBe('rejected');
  });

  it.skipIf(!supportsPinnedFixtures).each([MAX_ARTIFACT_BYTES + 1, 2 * 1024 * 1024 * 1024])('rejects a sparse artifact of %i bytes before reading it', size => {
    const { root, artifact } = fixture();
    truncateSync(artifact, size);
    expect(() => pinArtifact(root, artifact)).toThrow(/maximum size/);
    const result = verifyWorkerArtifact({ worktreeRoot: root, artifactPath: artifact });
    expect(result.status).toBe('rejected');
    expect(result.findings.join(';')).toMatch(/maximum size/);
    expect(vi.mocked(readSync)).not.toHaveBeenCalled();
  });

  it.skipIf(!supportsPinnedFixtures).each([0, 64 * 1024 + 7, MAX_ARTIFACT_BYTES])('hashes a %i-byte artifact correctly with fixed chunks', size => {
    const { root, artifact } = fixture();
    writeFileSync(artifact, '');
    truncateSync(artifact, size);
    const expected = createHash('sha256');
    const zeros = Buffer.alloc(64 * 1024);
    for (let offset = 0; offset < size; offset += zeros.length) {
      expected.update(zeros.subarray(0, Math.min(zeros.length, size - offset)));
    }
    const result = verifyWorkerArtifact({ worktreeRoot: root, artifactPath: artifact });
    expect(result.status).toBe('accepted');
    expect(result.artifactDigest).toBe(`sha256:${expected.digest('hex')}`);
    // The pre-check artifact digest is the first read, before the tree walk.
    expect(vi.mocked(readSync).mock.calls[0][1].byteLength).toBe(64 * 1024);
  });

  it.skipIf(process.platform !== 'linux')('rejects a tree entry swapped to a non-regular file after lstat and opens it without blocking', async () => {
    const { root } = fixture();
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(fstatSync).mockImplementation(fd => Object.assign(actual.fstatSync(fd), { isFile: () => false }));
    expect(() => computeWorktreeTreeDigest(root)).toThrow(/changed to a non-regular file/);
    const childOpen = vi.mocked(openSync).mock.calls.find(([target]) => /^\/proc\/self\/fd\/\d+\/artifact$/.test(String(target)));
    expect(childOpen).toBeDefined();
    expect((childOpen![1] as number) & fsConstants.O_NONBLOCK).toBe(fsConstants.O_NONBLOCK);
    expect(vi.mocked(readSync)).not.toHaveBeenCalled();
  });

  it.skipIf(!supportsPinnedFixtures).each(['grow', 'truncate'])('rejects an artifact that changes size during hashing (%s) and releases descriptors', async mutation => {
    const { root, artifact } = fixture();
    truncateSync(artifact, 64 * 1024 + 7);
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(readSync).mockImplementationOnce((...args) => {
      truncateSync(artifact, mutation === 'grow' ? MAX_ARTIFACT_BYTES + 1 : 0);
      return actual.readSync(...args);
    });
    const result = verifyWorkerArtifact({ worktreeRoot: root, artifactPath: artifact });
    expect(result.status).toBe('rejected');
    expect(result.findings.join(';')).toMatch(/artifact digest failed/);
    expectDescriptorsClosed();
  });
});

describe('trusted tree resource bounds', () => {
  it.skipIf(process.platform !== 'linux').each([MAX_TREE_FILE_BYTES + 1, 2 * 1024 * 1024 * 1024])(
    'rejects a non-artifact sparse file of %i bytes before reading it', size => {
      const { root, artifact } = fixture();
      truncateSync(artifact, size);
      expect(() => computeWorktreeTreeDigest(root)).toThrow(/tree file .* exceeds maximum size/);
      expect(vi.mocked(readSync)).not.toHaveBeenCalled();
      expectDescriptorsClosed();
    });

  it.skipIf(process.platform !== 'linux')('rejects total tree bytes beyond the budget', () => {
    const { root, artifact } = fixture(); rmSync(artifact);
    for (let i = 0; i <= MAX_TREE_BYTES / MAX_TREE_FILE_BYTES; i++) {
      const file = path.join(root, `file-${String(i).padStart(2, '0')}`);
      writeFileSync(file, ''); truncateSync(file, MAX_TREE_FILE_BYTES);
    }
    expect(() => computeWorktreeTreeDigest(root)).toThrow(/tree byte budget exceeded/);
    const bytesRead = vi.mocked(readSync).mock.results.reduce((total, result) => total + (result.type === 'return' ? result.value : 0), 0);
    expect(bytesRead).toBe(MAX_TREE_BYTES);
    expectDescriptorsClosed();
  });

  it.skipIf(process.platform !== 'linux')('rejects too many tree entries before opening their content', () => {
    const { root, artifact } = fixture(); rmSync(artifact);
    for (let i = 0; i <= MAX_TREE_ENTRIES; i++) writeFileSync(path.join(root, `file-${i}`), '');
    expect(() => computeWorktreeTreeDigest(root)).toThrow(/tree entry budget exceeded/);
    expect(vi.mocked(readSync)).not.toHaveBeenCalled();
    expectDescriptorsClosed();
  });

  it.skipIf(process.platform !== 'linux')('bounds nested-directory depth and closes every opened directory', () => {
    const { root } = fixture();
    let directory = root;
    for (let i = 0; i < 130; i++) { directory = path.join(directory, 'd'); mkdirSync(directory); }
    expect(() => computeWorktreeTreeDigest(root)).toThrow(/tree depth budget exceeded/);
    expectDescriptorsClosed();
  });

  it.skipIf(process.platform !== 'linux').each(['grow', 'truncate'])(
    'rejects a tree file changing size during hashing (%s)', async mutation => {
      const { root, artifact } = fixture(); truncateSync(artifact, 64 * 1024 + 7);
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      vi.mocked(readSync).mockImplementationOnce((...args) => {
        truncateSync(artifact, mutation === 'grow' ? MAX_TREE_FILE_BYTES + 1 : 0);
        return actual.readSync(...args);
      });
      expect(() => computeWorktreeTreeDigest(root)).toThrow(/tree file (truncated|size changed)/);
      expectDescriptorsClosed();
    });

  it.skipIf(process.platform !== 'linux').each(['dev', 'ino'])(
    'rejects a file whose %s changes between lstat and open', async field => {
      const { root } = fixture();
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      vi.mocked(fstatSync).mockImplementation(fd => {
        const stat = actual.fstatSync(fd); return Object.assign(stat, { [field]: stat[field as 'dev' | 'ino'] + 1 });
      });
      expect(() => computeWorktreeTreeDigest(root)).toThrow(/identity changed before hashing/);
      expect(vi.mocked(readSync)).not.toHaveBeenCalled();
      expectDescriptorsClosed();
    });

  it.skipIf(process.platform !== 'linux')('records the opened file mode with chunked content and an EOF check', async () => {
    const { root, artifact } = fixture();
    const contents = Buffer.alloc(64 * 1024 + 7, 120); writeFileSync(artifact, contents);
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(fstatSync).mockImplementation(fd => Object.assign(actual.fstatSync(fd), { mode: 0o100600 }));
    const contentHash = createHash('sha256').update(contents).digest('hex');
    const expected = createHash('sha256').update(`file\u0000artifact\u0000600\u0000${contents.length}\u0000${contentHash}\n`).digest('hex');
    expect(computeWorktreeTreeDigest(root)).toBe(`fd-tree:sha256:${expected}`);
    expect(vi.mocked(readSync).mock.calls.map(call => call[3])).toEqual([64 * 1024, 7, 1]);
    expect(vi.mocked(readSync).mock.calls.every(call => call[1].byteLength === 64 * 1024)).toBe(true);
    expectDescriptorsClosed();
  });
});
