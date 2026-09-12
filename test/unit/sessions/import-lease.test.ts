import {
  mkdir, mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import leaseFs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireImportLease,
  importLeasePath,
  SessionRepository,
} from '../../../src/sessions/index.js';
import { itWithSqlite } from '../../helpers/sqlite.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('session import lease', () => {
  it('persists heartbeat advancement and drains a queued write before release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-session-heartbeat-'));
    roots.push(root);
    const database = join(root, 'catalog.sqlite');
    const lock = importLeasePath(database);
    const ownerPath = join(lock, 'owner.json');
    const dates = ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z',
      '2026-01-01T00:00:02.000Z'];
    let tick = 0;
    let unblockWrite!: () => void;
    const writeGate = new Promise<void>(resolve => { unblockWrite = resolve; });
    let queuedWriteStarted = false;
    let releasingLease = false;
    let releaseReadStarted = false;
    const realWriteFile = leaseFs.writeFile;
    const realReadFile = leaseFs.readFile;
    const writer = vi.spyOn(leaseFs, 'writeFile').mockImplementation(async (...args) => {
      if (args[0] === `${ownerPath}.tmp-${process.pid}` && String(args[1]).includes(dates[2])) {
        queuedWriteStarted = true;
        await writeGate;
      }
      return realWriteFile(...args);
    });
    const reader = vi.spyOn(leaseFs, 'readFile').mockImplementation((...args) => {
      if (releasingLease && args[0] === ownerPath) releaseReadStarted = true;
      return realReadFile(...args);
    });
    syncBuiltinESMExports();
    let lease: Awaited<ReturnType<typeof acquireImportLease>> | undefined;
    let releasing: Promise<void> | undefined;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      lease = await acquireImportLease(database, 'heartbeat-run', {
        heartbeatMs: 60_000, now: () => new Date(dates[tick++]!),
      });
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(async () => {
        expect(JSON.parse(await readFile(ownerPath, 'utf8'))).toEqual({
          contractVersion: '1.0.0', runId: 'heartbeat-run', pid: process.pid,
          host: hostname(), startedAt: dates[0], heartbeatAt: dates[1],
        });
      });
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(queuedWriteStarted).toBe(true));
      let released = false;
      releasingLease = true;
      releasing = lease.release().then(() => { released = true; });
      // release executes synchronously until its first await: ownership must
      // not be read while the scheduled write is still blocked.
      expect(releaseReadStarted).toBe(false);
      // A second real read allows asynchronous release work to proceed while
      // the queued heartbeat remains deliberately blocked.
      expect(JSON.parse(await realReadFile(ownerPath, 'utf8')).heartbeatAt).toBe(dates[1]);
      expect(released).toBe(false);
      unblockWrite();
      await releasing;
      await expect(readFile(ownerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(tick).toBe(3);
      expect(await leaseFs.readdir(root)).toEqual([]);
    } finally {
      unblockWrite();
      try {
        await releasing;
        await lease?.release();
      } finally {
        writer.mockRestore();
        reader.mockRestore();
        syncBuiltinESMExports();
        vi.useRealTimers();
      }
    }
  });

  it('reports the active owner after a bounded wait and leaves readers unconstrained', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-session-lease-'));
    roots.push(root);
    const database = join(root, 'catalog.sqlite');
    const first = await acquireImportLease(database, 'run-first', {
      waitMs: 10,
      heartbeatMs: 5,
    });
    try {
      await expect(acquireImportLease(database, 'run-second', {
        waitMs: 10,
        pollMs: 2,
      })).rejects.toMatchObject({
        code: 'IMPORT_LOCKED',
        owner: {
          runId: 'run-first',
          pid: process.pid,
          host: hostname(),
        },
        waitMs: 10,
      });
      const owner = JSON.parse(await readFile(
        join(importLeasePath(database), 'owner.json'),
        'utf8',
      ));
      expect(owner).toMatchObject({
        contractVersion: '1.0.0',
        runId: 'run-first',
        startedAt: expect.any(String),
        heartbeatAt: expect.any(String),
      });
    } finally {
      await first.release();
    }
    const second = await acquireImportLease(database, 'run-second', { waitMs: 0 });
    try {
      expect(second.owner.runId).toBe('run-second');
    } finally {
      await second.release();
    }
  });

  it('recovers a confirmed stale owner but never breaks a live local owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-session-stale-lease-'));
    roots.push(root);
    const database = join(root, 'catalog.sqlite');
    const lock = importLeasePath(database);
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, 'owner.json'), JSON.stringify({
      contractVersion: '1.0.0',
      runId: 'stale-run',
      pid: 424242,
      host: hostname(),
      startedAt: '2000-01-01T00:00:00.000Z',
      heartbeatAt: '2000-01-01T00:00:00.000Z',
    }));
    const recovered = await acquireImportLease(database, 'recovered-run', {
      waitMs: 0,
      staleMs: 1,
      processAlive: () => false,
    });
    try {
      expect(recovered.owner.runId).toBe('recovered-run');
    } finally {
      await recovered.release();
    }
  });

  it('preserves a stale local lease when its process is confirmed alive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-session-live-lease-'));
    roots.push(root);
    const database = join(root, 'catalog.sqlite');
    const lock = importLeasePath(database);
    const owner = { contractVersion: '1.0.0', runId: 'live-run', pid: process.pid,
      host: hostname(), startedAt: '2000-01-01T00:00:00.000Z',
      heartbeatAt: '2000-01-01T00:00:00.000Z' };
    const bytes = JSON.stringify(owner);
    await mkdir(lock);
    await writeFile(join(lock, 'owner.json'), bytes);
    const processAlive = vi.fn(() => true);
    let unexpectedLease: Awaited<ReturnType<typeof acquireImportLease>> | undefined;
    try {
      await expect(acquireImportLease(database, 'contender', {
        waitMs: 0, staleMs: 1, processAlive,
      }).then(lease => { unexpectedLease = lease; return lease; }))
        .rejects.toMatchObject({ code: 'IMPORT_LOCKED', owner, waitMs: 0 });
      expect(processAlive.mock.calls).toEqual([[process.pid]]);
      expect(await readFile(join(lock, 'owner.json'), 'utf8')).toBe(bytes);
    } finally {
      await unexpectedLease?.release();
    }
  });

  it('makes repeated release harmless after another run acquires the lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-session-repeat-release-'));
    roots.push(root);
    const database = join(root, 'catalog.sqlite');
    const first = await acquireImportLease(database, 'first');
    try {
      await first.release();
      const second = await acquireImportLease(database, 'second');
      try {
        const ownerPath = join(importLeasePath(database), 'owner.json');
        const bytes = await readFile(ownerPath, 'utf8');
        await first.release();
        expect(await readFile(ownerPath, 'utf8')).toBe(bytes);
        expect(JSON.parse(bytes).runId).toBe('second');
      } finally {
        await second.release();
      }
    } finally {
      await first.release();
    }
  });

  it('preserves a replacement run identity when the original owner releases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-session-replaced-lease-'));
    roots.push(root);
    const database = join(root, 'catalog.sqlite');
    const lease = await acquireImportLease(database, 'original', { heartbeatMs: 60_000 });
    try {
      const ownerPath = join(importLeasePath(database), 'owner.json');
      const replacement = { ...lease.owner, runId: 'replacement' };
      const bytes = JSON.stringify(replacement);
      await writeFile(ownerPath, bytes);
      await lease.release();
      expect(await readFile(ownerPath, 'utf8')).toBe(bytes);
      expect(JSON.parse(bytes)).toEqual(replacement);
    } finally {
      await lease.release();
    }
  });

  it('does not auto-recover an unverifiable foreign-host lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-session-foreign-lease-'));
    roots.push(root);
    const database = join(root, 'catalog.sqlite');
    const lock = importLeasePath(database);
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, 'owner.json'), JSON.stringify({
      contractVersion: '1.0.0',
      runId: 'foreign-run',
      pid: 424242,
      host: 'remote-host.example.test',
      startedAt: '2000-01-01T00:00:00.000Z',
      heartbeatAt: '2000-01-01T00:00:00.000Z',
    }));
    await expect(acquireImportLease(database, 'local-run', {
      waitMs: 0,
      staleMs: 1,
      processAlive: () => false,
    })).rejects.toMatchObject({
      code: 'IMPORT_LOCKED',
      owner: { runId: 'foreign-run', host: 'remote-host.example.test' },
    });
  });

  itWithSqlite('keeps catalog readers available while an application import lease is held', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-session-reader-lease-'));
    roots.push(root);
    const database = join(root, 'catalog.sqlite');
    const initialized = new SessionRepository(database);
    initialized.close();
    const lease = await acquireImportLease(database, 'writer-run');
    try {
      const reader = new SessionRepository(database);
      try {
        expect(reader.listSessions({ workspaceId: 'workspace', limit: 10 })).toMatchObject({
          total: 0,
          items: [],
        });
      } finally {
        reader.close();
      }
    } finally {
      await lease.release();
    }
  });
});
