import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hostname } from 'node:os';

export interface DirectoryLockOptions {
  timeoutMs?: number;
  pollMs?: number;
  /** Reclaim only owners proven dead on this host; opt-in for maintenance. */
  reclaimDeadOwner?: boolean;
}

export class DirectoryLockContentionError extends Error {}

/**
 * Acquire a cross-process directory lock and return an ownership-safe release.
 *
 * Package builds fail after a bounded wait. Maintenance can opt into recovery
 * of owners proven dead on the same host; healthy or unknown owners are retained.
 */
export async function acquireDirectoryLock(
  lockPath: string,
  options: DirectoryLockOptions = {},
): Promise<() => Promise<void>> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const pollMs = options.pollMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  const token = `${process.pid}:${randomUUID()}:${hostname()}`;
  const ownerPath = path.join(lockPath, 'owner');

  await mkdir(path.dirname(lockPath), { recursive: true });
  while (true) {
    try {
      await mkdir(lockPath);
      try {
        await writeFile(ownerPath, `${token}\n`, { mode: 0o600 });
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (options.reclaimDeadOwner && await reclaimDeadLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new DirectoryLockContentionError(`timed out waiting for build lock: ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  return async () => {
    try {
      if ((await readFile(ownerPath, 'utf8')).trim() !== token) return;
    } catch {
      return;
    }
    await rm(lockPath, { recursive: true, force: true });
  };
}

/** Serialize stale-owner recovery so two waiters cannot remove a new lease. */
async function reclaimDeadLock(lockPath: string): Promise<boolean> {
  let release: () => Promise<void>;
  try {
    release = await acquireDirectoryLock(`${lockPath}.recovery`, { timeoutMs: 0, reclaimDeadOwner: true });
  } catch (error) {
    if (error instanceof DirectoryLockContentionError) return false;
    throw error;
  }
  try {
    let owner: string;
    try {
      owner = (await readFile(path.join(lockPath, 'owner'), 'utf8')).trim();
    } catch {
      return false;
    }
    const [pidText, , host] = owner.split(':');
    const pid = Number(pidText);
    if (host !== hostname() || !Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
    }
    await rm(lockPath, { recursive: true, force: true });
    return true;
  } finally {
    await release();
  }
}
