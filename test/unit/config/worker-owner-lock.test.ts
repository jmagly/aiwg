// Covers empty recovery and conservative cleanup of unpublished worker lock owners.
import { mkdtemp, link, mkdir, writeFile, readFile, readlink, readdir, unlink, symlink, rm } from 'node:fs/promises';
import { existsSync, lstatSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireWorkerWriteLock, reclaimWorkerWriteLock, workerWriteLock } from '../../../src/config/worker-owner-lock.js';

const fsFailures = vi.hoisted(() => ({
  link: undefined as Error | undefined, temporaryUnlink: undefined as Error | undefined,
  // Failure points inside Windows record publication (open/write/close of the temporary record).
  open: undefined as Error | undefined, write: undefined as Error | undefined, close: undefined as Error | undefined,
  removeTemporaryBeforeUnlink: false,
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    link: async (source: Parameters<typeof actual.link>[0], destination: Parameters<typeof actual.link>[1]) => {
      if (fsFailures.link) throw fsFailures.link;
      return actual.link(source, destination);
    },
    unlink: async (target: Parameters<typeof actual.unlink>[0]) => {
      if (fsFailures.temporaryUnlink && String(target).includes('.worker-lock-record-')) throw fsFailures.temporaryUnlink;
      if (fsFailures.removeTemporaryBeforeUnlink && String(target).includes('.worker-lock-record-')) await actual.rm(target, { force: true });
      return actual.unlink(target);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      if (fsFailures.open && String(args[0]).includes('.worker-lock-record-')) throw fsFailures.open;
      const handle = await actual.open(...args);
      if (!String(args[0]).includes('.worker-lock-record-')) return handle;
      return new Proxy(handle, { get(target, key) {
        if (key === 'writeFile' && fsFailures.write) return async () => { throw fsFailures.write; };
        if (key === 'close' && fsFailures.close) return async () => { await target.close(); throw fsFailures.close; };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    },
  };
});

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
function emulateWindows() {
  Object.defineProperty(process, 'platform', { ...realPlatform, value: 'win32' });
}

const roots: string[] = [];
afterEach(async () => {
  Object.defineProperty(process, 'platform', realPlatform);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fsFailures.link = undefined;
  fsFailures.temporaryUnlink = undefined;
  fsFailures.open = undefined;
  fsFailures.write = undefined;
  fsFailures.close = undefined;
  fsFailures.removeTemporaryBeforeUnlink = false;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-worker-owner-'));
  roots.push(root);
  vi.stubEnv('AIWG_ARTIFACTS_PATH', join(root, 'artifacts'));
  return root;
}

async function createDirectoryPointer(directory: string, path: string) {
  await mkdir(dirname(path), { recursive: true });
  if (process.platform === 'win32') await symlink(resolve(directory), path, 'junction');
  else await symlink(relative(dirname(path), directory), path);
}

async function createGenerationRecord(directory: string, generation: string, owner: object, keepTemporary = false) {
  const path = join(directory, `next-${generation}`);
  const value = JSON.stringify(owner);
  if (process.platform !== 'win32') return symlink(value, path);
  const temporary = join(directory, `.test-worker-lock-record-${randomUUID()}.tmp`);
  await writeFile(temporary, value, { flag: 'wx', mode: 0o600 });
  await link(temporary, path);
  if (!keepTemporary) await unlink(temporary);
}

async function deadPid(): Promise<number> {
  for (let pid = process.pid + 1000; pid < process.pid + 1100; pid++) {
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid; }
  }
  throw new Error('Could not find a vacant process ID for the stale-owner fixture');
}

function comparablePath(path: string) {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

it.each(['missing', 'dangling', 'missing owner'])('reports nothing to recover for a %s lock', async state => {
  const root = await fixture();
  const path = workerWriteLock(root);
  if (state !== 'missing') {
    await mkdir(dirname(path), { recursive: true });
    const directory = `${path}.${randomUUID()}`;
    if (state === 'missing owner') await mkdir(directory);
    await createDirectoryPointer(directory, path);
  }
  await expect(reclaimWorkerWriteLock(root)).rejects.toThrow(/no interrupted apply; nothing to recover/i);
});

it.skipIf(process.platform === 'win32')('reports no interrupted apply through worker adoption recovery', async () => {
  const { recoverWorkerAdoption } = await import('../../../src/config/worker-adoption.js');
  for (const state of ['missing', 'dangling', 'missing owner']) {
    const root = await fixture();
    const path = workerWriteLock(root);
    if (state !== 'missing') {
      await mkdir(dirname(path), { recursive: true });
      const directory = `${path}.${randomUUID()}`;
      if (state === 'missing owner') await mkdir(directory);
      await createDirectoryPointer(directory, path);
    }
    await expect(recoverWorkerAdoption(root, { digest: 'unused' })).rejects.toThrow(/no interrupted apply; nothing to recover/i);
  }
});

// Windows publication (junction pointer, hard-link generation records) also runs on Linux by
// emulating process.platform; Linux ignores the junction type and supports same-directory hard links.
describe.each(['native', 'win32'] as const)('%s lock publication', mode => {
  beforeEach(() => { if (mode === 'win32' && process.platform !== 'win32') emulateWindows(); });
  it('resolves and releases the platform-specific owner directory pointer', async () => {
    const root = await fixture();
    const lease = await acquireWorkerWriteLock(root);
    const path = workerWriteLock(root);
    const directory = `${path}.${lease.generation}`;
    const resolved = resolve(dirname(path), await readlink(path));
    expect(comparablePath(resolved)).toBe(comparablePath(directory));
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(existsSync(join(path, 'owner.json'))).toBe(true);
    lease.assertOwned();
    await lease.release();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(directory)).toBe(false);
  });

  it('preserves the first owner during contention and removes the losing reservation', async () => {
    const root = await fixture();
    const first = await acquireWorkerWriteLock(root);
    const path = workerWriteLock(root);
    const directory = resolve(dirname(path), await readlink(path));
    await expect(acquireWorkerWriteLock(root)).rejects.toThrow(/worker configuration is locked/i);
    first.assertOwned();
    expect(existsSync(join(directory, 'owner.json'))).toBe(true);
    const owners = await readdir(dirname(path));
    expect(owners.filter(name => name.startsWith(`${basename(path)}.`) && /^[a-f0-9-]{36}$/.test(name.slice(basename(path).length + 1)))).toEqual([basename(directory)]);
    await first.release();
  });

  it('sweeps only unreferenced, provably dead owner directories on acquire', async () => {
    const root = await fixture();
    const lease = await acquireWorkerWriteLock(root);
    const path = workerWriteLock(root);
    const aliveDirectory = resolve(dirname(path), await readlink(path));
    const owner = JSON.parse(await readFile(join(aliveDirectory, 'owner.json'), 'utf8'));
    await unlink(path); // Simulate an unpublished directory while its owner is still alive.
    const orphan = async (details: object | null) => {
      const directory = `${path}.${randomUUID()}`;
      await mkdir(directory);
      if (details) await writeFile(join(directory, 'owner.json'), JSON.stringify({ ...owner, generation: randomUUID(), ...details }));
      return directory;
    };
    const deadDetails = { pid: await deadPid(), start: 'old-boot:old-process' };
    const dead = await orphan(deadDetails);
    const remote = await orphan({ ...deadDetails, host: `${owner.host}-remote` });
    const unverifiable = await orphan({ start: null });
    const missingStart = await orphan({ start: undefined });
    const incomplete = await orphan(null);
    const unrelated = `${path}.backup`;
    await mkdir(unrelated);
    await writeFile(join(unrelated, 'owner.json'), JSON.stringify({ ...owner, start: 'old-boot:old-process' }));
    // Follow successor generations: the original owner is dead but its successor is alive.
    const successor = await orphan(deadDetails);
    const original = JSON.parse(await readFile(join(successor, 'owner.json'), 'utf8'));
    await createGenerationRecord(successor, original.generation, { ...owner, generation: randomUUID() });
    const next = await acquireWorkerWriteLock(root);
    expect(existsSync(dead)).toBe(false);
    for (const directory of [aliveDirectory, remote, unverifiable, missingStart, incomplete, successor, unrelated]) expect(existsSync(directory)).toBe(true);
    await next.release();
    await expect(lease.release()).rejects.toThrow(/ownership lost/);
  });

  it('reclaims a dead owner, advances its generation, and cleans the owner directory', async () => {
    const root = await fixture();
    const oldLease = await acquireWorkerWriteLock(root, true);
    const path = workerWriteLock(root);
    const directory = resolve(dirname(path), await readlink(path));
    const ownerFile = join(directory, 'owner.json');
    const previous = JSON.parse(await readFile(ownerFile, 'utf8'));
    await writeFile(ownerFile, JSON.stringify({ ...previous, pid: await deadPid(), start: 'old-boot:old-process' }));

    const recovered = await reclaimWorkerWriteLock(root);
    expect(recovered.generation).not.toBe(oldLease.generation);
    expect(comparablePath(resolve(dirname(path), await readlink(path)))).toBe(comparablePath(directory));
    expect(() => oldLease.assertOwned()).toThrow(/ownership lost/);
    recovered.assertOwned();
    expect(existsSync(join(path, 'blocked'))).toBe(true);
    await recovered.release();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(directory)).toBe(false);
  });

  it('preserves a referenced dead owner for authorized recovery', async () => {
    const root = await fixture();
    const lease = await acquireWorkerWriteLock(root, true);
    const file = join(lease.path, 'owner.json');
    const owner = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...owner, start: 'old-boot:old-process' }));
    await expect(acquireWorkerWriteLock(root)).rejects.toThrow(/locked/);
    expect(existsSync(file)).toBe(true);
  });

  it('keeps a failed apply blocked and permits explicit recovery', async () => {
    const root = await fixture();
    const failed = await acquireWorkerWriteLock(root, true);
    const path = workerWriteLock(root);
    const directory = resolve(dirname(path), await readlink(path));

    await failed.release(true);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(path, 'blocked'))).toBe(true);
    expect(() => failed.assertOwned()).toThrow(/ownership lost/);

    const recovered = await reclaimWorkerWriteLock(root);
    recovered.assertOwned();
    await recovered.release();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(directory)).toBe(false);
  });

  it('reclaims an interruption after publishing a generation record', async () => {
    const root = await fixture();
    const oldLease = await acquireWorkerWriteLock(root);
    const path = workerWriteLock(root);
    const directory = resolve(dirname(path), await readlink(path));
    const ownerFile = join(directory, 'owner.json');
    const previous = JSON.parse(await readFile(ownerFile, 'utf8'));
    const dead = { ...previous, pid: await deadPid(), start: 'old-boot:old-process' };
    await writeFile(ownerFile, JSON.stringify(dead));

    const crashedSuccessor = { ...dead, generation: randomUUID() };
    await createGenerationRecord(directory, dead.generation, crashedSuccessor, true);
    const recovered = await reclaimWorkerWriteLock(root);
    expect(recovered.generation).not.toBe(crashedSuccessor.generation);
    recovered.assertOwned();
    await recovered.release();
    expect(existsSync(directory)).toBe(false);
    await expect(oldLease.release()).rejects.toThrow(/ownership lost/);
  });

  it('allows only one concurrent recovery of a dead generation', async () => {
    const root = await fixture();
    const oldLease = await acquireWorkerWriteLock(root);
    const path = workerWriteLock(root);
    const directory = resolve(dirname(path), await readlink(path));
    const ownerFile = join(directory, 'owner.json');
    const owner = JSON.parse(await readFile(ownerFile, 'utf8'));
    await writeFile(ownerFile, JSON.stringify({ ...owner, pid: await deadPid(), start: 'old-boot:old-process' }));

    const results = await Promise.allSettled([reclaimWorkerWriteLock(root), reclaimWorkerWriteLock(root)]);
    const winners = results.filter(result => result.status === 'fulfilled');
    const losers = results.filter(result => result.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as PromiseRejectedResult).reason.message).toMatch(/another recovery claimed generation|locked by a live or unverifiable owner/i);
    const recovered = (winners[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof reclaimWorkerWriteLock>>>).value;
    recovered.assertOwned();
    expect((await readdir(directory)).filter(name => name.startsWith('.worker-lock-record-'))).toEqual([]);
    await recovered.release();
    await expect(oldLease.release()).rejects.toThrow(/ownership lost/);
  });

  async function deadOwnerLock() {
    const root = await fixture();
    const oldLease = await acquireWorkerWriteLock(root);
    const path = workerWriteLock(root);
    const directory = resolve(dirname(path), await readlink(path));
    const ownerFile = join(directory, 'owner.json');
    const previous = JSON.parse(await readFile(ownerFile, 'utf8'));
    await writeFile(ownerFile, JSON.stringify({ ...previous, pid: await deadPid(), start: 'old-boot:old-process' }));
    return { root, oldLease, directory, previous };
  }
  const records = async (directory: string) => (await readdir(directory)).filter(name => name.startsWith('.worker-lock-record-'));
  const fsError = (message: string, code: string) => Object.assign(new Error(message), { code }) as NodeJS.ErrnoException;

  it.runIf(mode === 'win32')('records nothing when the temporary record cannot be opened', async () => {
    const { root, oldLease, directory } = await deadOwnerLock();
    const openError = fsError('forced open failure', 'EACCES');
    fsFailures.open = openError;
    await expect(reclaimWorkerWriteLock(root)).rejects.toBe(openError);
    fsFailures.open = undefined;
    expect(await records(directory)).toEqual([]);
    const recovered = await reclaimWorkerWriteLock(root);
    await recovered.release();
    await expect(oldLease.release()).rejects.toThrow(/ownership lost/);
  });

  it.runIf(mode === 'win32')('removes the temporary record when writing it fails', async () => {
    const { root, oldLease, directory } = await deadOwnerLock();
    const writeError = fsError('forced write failure', 'ENOSPC');
    fsFailures.write = writeError;
    await expect(reclaimWorkerWriteLock(root)).rejects.toBe(writeError);
    fsFailures.write = undefined;
    expect(await records(directory)).toEqual([]);
    const recovered = await reclaimWorkerWriteLock(root);
    await recovered.release();
    await expect(oldLease.release()).rejects.toThrow(/ownership lost/);
  });

  it.runIf(mode === 'win32')('reports write and close failures together and leaves no record', async () => {
    const { root, oldLease, directory } = await deadOwnerLock();
    const writeError = fsError('forced write failure', 'ENOSPC');
    const closeError = fsError('forced close failure', 'EIO');
    fsFailures.write = writeError;
    fsFailures.close = closeError;
    const error = await reclaimWorkerWriteLock(root).catch(reason => reason);
    fsFailures.write = undefined;
    fsFailures.close = undefined;
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([writeError, closeError]);
    expect(await records(directory)).toEqual([]);
    const recovered = await reclaimWorkerWriteLock(root);
    await recovered.release();
    await expect(oldLease.release()).rejects.toThrow(/ownership lost/);
  });

  it.runIf(mode === 'win32')('surfaces a close failure after a complete write', async () => {
    const { root, oldLease, directory } = await deadOwnerLock();
    const closeError = fsError('forced close failure', 'EIO');
    fsFailures.close = closeError;
    await expect(reclaimWorkerWriteLock(root)).rejects.toBe(closeError);
    fsFailures.close = undefined;
    expect(await records(directory)).toEqual([]);
    const recovered = await reclaimWorkerWriteLock(root);
    await recovered.release();
    await expect(oldLease.release()).rejects.toThrow(/ownership lost/);
  });

  it.runIf(mode === 'win32')('tolerates a temporary record that is already gone during cleanup', async () => {
    const { root, oldLease, directory } = await deadOwnerLock();
    const publishError = fsError('forced hard-link publication failure', 'EPERM');
    fsFailures.link = publishError;
    fsFailures.removeTemporaryBeforeUnlink = true;
    await expect(reclaimWorkerWriteLock(root)).rejects.toBe(publishError);
    fsFailures.link = undefined;
    expect(await records(directory)).toEqual([]);
    const recovered = await reclaimWorkerWriteLock(root);
    await recovered.release();
    await expect(oldLease.release()).rejects.toThrow(/ownership lost/);
  });

  it('rejects a generation record that is neither a file nor a symlink', async () => {
    const { root, oldLease, directory, previous } = await deadOwnerLock();
    await mkdir(join(directory, `next-${previous.generation}`));
    await expect(reclaimWorkerWriteLock(root)).rejects.toThrow(/invalid worker lock generation record/i);
    await rm(join(directory, `next-${previous.generation}`), { recursive: true, force: true });
    const recovered = await reclaimWorkerWriteLock(root);
    await recovered.release();
    await expect(oldLease.release()).rejects.toThrow(/ownership lost/);
  });

  it.runIf(mode === 'win32')('cleans the unpublished temporary record when hard-link publication fails', async () => {
    const root = await fixture();
    const oldLease = await acquireWorkerWriteLock(root);
    const path = workerWriteLock(root);
    const directory = resolve(dirname(path), await readlink(path));
    const ownerFile = join(directory, 'owner.json');
    const previous = JSON.parse(await readFile(ownerFile, 'utf8'));
    await writeFile(ownerFile, JSON.stringify({ ...previous, pid: await deadPid(), start: 'old-boot:old-process' }));

    const publishError = Object.assign(new Error('forced hard-link publication failure'), { code: 'EPERM' }) as NodeJS.ErrnoException;
    fsFailures.link = publishError;
    try {
      await expect(reclaimWorkerWriteLock(root)).rejects.toBe(publishError);
      expect((await readdir(directory)).filter(name => name.startsWith('.worker-lock-record-'))).toEqual([]);
    } finally {
      fsFailures.link = undefined;
    }

    const recovered = await reclaimWorkerWriteLock(root);
    recovered.assertOwned();
    await recovered.release();
    await expect(oldLease.release()).rejects.toThrow(/ownership lost/);
  });

  it.runIf(mode === 'win32')('reports publication and cleanup failures together', async () => {
    const root = await fixture();
    const oldLease = await acquireWorkerWriteLock(root);
    const path = workerWriteLock(root);
    const directory = resolve(dirname(path), await readlink(path));
    const ownerFile = join(directory, 'owner.json');
    const previous = JSON.parse(await readFile(ownerFile, 'utf8'));
    await writeFile(ownerFile, JSON.stringify({ ...previous, pid: await deadPid(), start: 'old-boot:old-process' }));

    const publishError = Object.assign(new Error('forced hard-link publication failure'), { code: 'EPERM' }) as NodeJS.ErrnoException;
    const cleanupError = Object.assign(new Error('forced temporary-file cleanup failure'), { code: 'EIO' }) as NodeJS.ErrnoException;
    fsFailures.link = publishError;
    fsFailures.temporaryUnlink = cleanupError;
    try {
      const error = await reclaimWorkerWriteLock(root).catch(reason => reason);
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual(expect.arrayContaining([publishError, cleanupError]));
      expect((await readdir(directory)).filter(name => name.startsWith('.worker-lock-record-'))).toHaveLength(1);
    } finally {
      fsFailures.link = undefined;
      fsFailures.temporaryUnlink = undefined;
    }

    const recovered = await reclaimWorkerWriteLock(root);
    recovered.assertOwned();
    await recovered.release();
    expect(existsSync(directory)).toBe(false);
    await expect(oldLease.release()).rejects.toThrow(/ownership lost/);
  });

  it.runIf(mode === 'win32')('keeps a published record valid when temporary-name cleanup fails', async () => {
    const root = await fixture();
    const oldLease = await acquireWorkerWriteLock(root);
    const path = workerWriteLock(root);
    const directory = resolve(dirname(path), await readlink(path));
    const ownerFile = join(directory, 'owner.json');
    const previous = JSON.parse(await readFile(ownerFile, 'utf8'));
    await writeFile(ownerFile, JSON.stringify({ ...previous, pid: await deadPid(), start: 'old-boot:old-process' }));

    const cleanupError = Object.assign(new Error('forced temporary-name cleanup failure'), { code: 'EPERM' }) as NodeJS.ErrnoException;
    fsFailures.temporaryUnlink = cleanupError;
    const warningSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    let recovered: Awaited<ReturnType<typeof reclaimWorkerWriteLock>>;
    try {
      recovered = await reclaimWorkerWriteLock(root);
      recovered.assertOwned();
      expect((await readdir(directory)).filter(name => name.startsWith('.worker-lock-record-'))).toHaveLength(1);
      expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('forced temporary-name cleanup failure'), expect.objectContaining({ code: 'AIWG_WORKER_LOCK_TEMP_CLEANUP' }));
    } finally {
      fsFailures.temporaryUnlink = undefined;
      warningSpy.mockRestore();
    }

    await recovered!.release();
    expect(existsSync(directory)).toBe(false);
    await expect(oldLease.release()).rejects.toThrow(/ownership lost/);
  });

  it('rejects a replaced owner pointer that escapes the reserved directory', async () => {
    const root = await fixture();
    const lease = await acquireWorkerWriteLock(root);
    const path = workerWriteLock(root);
    const directory = resolve(dirname(path), await readlink(path));
    const foreign = join(dirname(path), `foreign-${randomUUID()}`);
    await mkdir(foreign);
    await writeFile(join(foreign, 'owner.json'), await readFile(join(directory, 'owner.json'), 'utf8'));
    await unlink(path);
    await createDirectoryPointer(foreign, path);
    expect(() => lease.assertOwned()).toThrow(/ownership lost/);
    await unlink(path);
    await rm(directory, { recursive: true, force: true });
    await rm(foreign, { recursive: true, force: true });
  });

  it('refuses recovery when the owner pointer escapes the control directory', async () => {
    const root = await fixture();
    const path = workerWriteLock(root);
    const foreign = join(root, `foreign-${randomUUID()}`);
    const owner = { generation: randomUUID(), host: hostname(), pid: await deadPid(), start: 'old-boot:old-process' };
    const ownerBytes = JSON.stringify(owner);
    await mkdir(foreign);
    await writeFile(join(foreign, 'owner.json'), ownerBytes);
    await createDirectoryPointer(foreign, path);

    await expect(reclaimWorkerWriteLock(root)).rejects.toThrow(/invalid worker configuration lock target/i);
    expect(await readdir(foreign)).toEqual(['owner.json']);
    expect(await readFile(join(foreign, 'owner.json'), 'utf8')).toBe(ownerBytes);
  });
});

it.skipIf(process.platform === 'win32')('reads legacy symlink generation records on Unix-like platforms', async () => {
  const root = await fixture();
  const path = workerWriteLock(root);
  const directory = `${path}.${randomUUID()}`;
  await mkdir(directory, { recursive: true });
  const previous = { generation: randomUUID(), host: `${hostname()}-legacy`, pid: 1, start: 'old-boot:old-process' };
  await writeFile(join(directory, 'owner.json'), JSON.stringify(previous));
  await symlink(basename(directory), path);
  await symlink(JSON.stringify({ ...previous, generation: randomUUID(), host: hostname(), pid: await deadPid() }), join(directory, `next-${previous.generation}`));
  const recovered = await reclaimWorkerWriteLock(root);
  recovered.assertOwned();
  await recovered.release();
});
