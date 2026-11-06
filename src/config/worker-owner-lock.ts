// Publishes complete owner identities atomically and fences dead-owner takeover by generation.
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { mkdir, writeFile, symlink, readlink, unlink, rm, readdir } from 'node:fs/promises';
import { readFileSync, readlinkSync } from 'node:fs';
import { projectControlPath } from './project-artifacts.js';

interface Owner { generation: string; host: string; pid: number; start: string | null; released?: boolean; proposalDigest?: string }
export interface WorkerWriteLease {
  path: string;
  generation: string;
  assertOwned(): void;
  release(keepBlocked?: boolean): Promise<void>;
}
export const workerWriteLock = (project: string): string => projectControlPath(project, 'aiwg.config.apply-lock');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
function processStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`;
  } catch { return null; }
}
function identity(): Owner {
  return { generation: randomUUID(), host: hostname(), pid: process.pid, start: processStart(process.pid) };
}
function provablyDead(owner: Owner): boolean {
  if (owner.released) return true; // The operation ended and explicitly relinquished exclusion.
  if (owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  const start = processStart(owner.pid);
  return typeof owner.start === 'string' && owner.start.length > 0 && start !== null && owner.start !== start;
}
function latest(directory: string): Owner {
  let owner = JSON.parse(readFileSync(join(directory, 'owner.json'), 'utf8')) as Owner;
  // Immutable successor links are a compare-and-swap: only one contender can claim a generation.
  for (;;) {
    if (!/^[a-f0-9-]{36}$/.test(owner.generation)) throw new Error('Invalid worker lock generation');
    try { owner = JSON.parse(readlinkSync(join(directory, `next-${owner.generation}`))) as Owner; }
    catch (error) { if (missing(error)) return owner; throw error; }
  }
}
async function sweepOrphanedOwners(path: string): Promise<void> {
  const parent = dirname(path);
  const prefix = `${basename(path)}.`;
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix) || !/^[a-f0-9-]{36}$/.test(entry.name.slice(prefix.length))) continue;
    const directory = join(parent, entry.name);
    let owner: Owner;
    try { owner = latest(directory); } catch { continue; } // Incomplete or unreadable identities cannot prove death.
    if (!provablyDead(owner)) continue;
    try {
      if (resolve(parent, await readlink(path)) === directory) continue;
    } catch (error) { if (!missing(error)) throw error; }
    await rm(directory, { recursive: true, force: true });
  }
}
function lease(path: string, directory: string, owner: Owner): WorkerWriteLease {
  const assertOwned = () => {
    try {
      if (readlinkSync(path) === basename(directory) && latest(directory).generation === owner.generation) return;
    } catch { /* Missing or replaced ownership must never authorize another write. */ }
    throw new Error(`Worker configuration lock ownership lost (${owner.generation}); dispatch remains closed at ${path}`);
  };
  return { path, generation: owner.generation, assertOwned, release: async (keepBlocked = false) => {
    assertOwned();
    if (keepBlocked) {
      // A caught failure can be retried even while this embedding process stays alive.
      await symlink(JSON.stringify({ ...identity(), released: true }), join(directory, `next-${owner.generation}`));
    } else {
      // A live owner cannot be reclaimed; unlink only while we still own this exact generation.
      await unlink(path);
      await rm(directory, { recursive: true });
    }
  } };
}
export async function acquireWorkerWriteLock(project: string, block = false, proposalDigest?: string): Promise<WorkerWriteLease> {
  const path = workerWriteLock(project);
  const owner = { ...identity(), ...(proposalDigest ? { proposalDigest } : {}) };
  const directory = `${path}.${owner.generation}`;
  await mkdir(dirname(path), { recursive: true });
  await sweepOrphanedOwners(path);
  await mkdir(directory);
  try {
    await writeFile(join(directory, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
    if (block) await writeFile(join(directory, 'blocked'), 'Worker policy apply/recovery in progress.\n', { mode: 0o600 });
    // No visible lock can exist without an owner, even if initialization is interrupted.
    await symlink(basename(directory), path);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Worker configuration is locked: ${path}; use authorized recovery after its owner exits`);
    throw error;
  }
  return lease(path, directory, owner);
}
export async function reclaimWorkerWriteLock(project: string): Promise<WorkerWriteLease> {
  const path = workerWriteLock(project);
  let directory: string;
  let previous: Owner;
  try {
    directory = resolve(dirname(path), await readlink(path));
    previous = latest(directory);
  } catch (error) {
    if (missing(error)) throw new Error(`No interrupted apply; nothing to recover at ${path}`);
    throw error;
  }
  if (!provablyDead(previous)) throw new Error(`Worker configuration is locked by a live or unverifiable owner (${previous.host}:${previous.pid}); ${path}`);
  const owner = identity();
  try { await symlink(JSON.stringify(owner), join(directory, `next-${previous.generation}`)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Worker configuration is locked: another recovery claimed generation ${previous.generation}`);
    throw error;
  }
  const result = lease(path, directory, owner);
  result.assertOwned();
  await writeFile(join(directory, 'blocked'), 'Worker policy recovery in progress.\n', { mode: 0o600 });
  return result;
}
