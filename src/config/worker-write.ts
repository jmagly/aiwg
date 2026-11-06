// Shares atomic replacement and serialization across worker configuration owners.
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { statSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { acquireWorkerWriteLock, workerWriteLock } from './worker-owner-lock.js';
export { acquireWorkerWriteLock, reclaimWorkerWriteLock, workerWriteLock } from './worker-owner-lock.js';

const maintenance = new AsyncLocalStorage<boolean>();
export const runWorkerMaintenance = <T>(body: () => Promise<T>): Promise<T> => maintenance.run(true, body);
export const isWorkerMaintenance = (): boolean => maintenance.getStore() === true;
export function workerDispatchBlocked(project: string): boolean {
  try { statSync(join(workerWriteLock(project), 'blocked')); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
export async function atomicConfigWrite(file: string, content: string, assertOwned?: () => void): Promise<void> {
  assertOwned?.();
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  let mode = 0o600;
  try { mode = (await stat(file)).mode; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    assertOwned?.();
    await writeFile(temporary, content, { encoding: 'utf8', mode });
    assertOwned?.();
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export function workerRecoveryDiagnostic(project: string): string {
  const record = join(workerWriteLock(project), 'recovery.json');
  let digest = 'sha256:<original-proposal-digest>';
  try {
    const retained = JSON.parse(readFileSync(record, 'utf8')).proposal?.digest;
    if (typeof retained === 'string') digest = retained;
  } catch {
    try {
      const retained = JSON.parse(readFileSync(join(workerWriteLock(project), 'owner.json'), 'utf8')).proposalDigest;
      if (typeof retained === 'string') digest = retained;
    } catch { /* Legacy or unreadable records require the retained review's digest. */ }
  }
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  return `Worker dispatch is closed for project ${project}; recovery record: ${record}. Recover with: aiwg config set --project --target ${quote(project)} --recover --authorize ${quote(digest)}`;
}
export async function withWorkerWriteLock<T>(project: string, body: () => Promise<T>): Promise<T> {
  const lock = await acquireWorkerWriteLock(project);
  try { lock.assertOwned(); return await body(); } finally { await lock.release(); }
}
