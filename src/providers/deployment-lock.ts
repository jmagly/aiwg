// Serialize provider snapshots and writes that share user-home deployment state.
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import { acquireDirectoryLock, DirectoryLockContentionError } from '../artifacts/prebuilt-build-lock.js';
import { getUserStateDir } from '../config/user-state.js';

const ownerVariable = 'AIWG_PROVIDER_DEPLOYMENT_LOCK_OWNER';
const held = new AsyncLocalStorage<{ lockPath: string; token: string }>();

export interface ProviderDeploymentLock {
  (): Promise<void>;
  run<T>(work: () => Promise<T>): Promise<T>;
}

/** Forward ownership only to children launched from the owning async operation. */
export function providerDeploymentLockEnvironment(): NodeJS.ProcessEnv {
  const owner = held.getStore();
  return owner ? { [ownerVariable]: owner.token } : {};
}

export async function acquireProviderDeploymentLock(): Promise<ProviderDeploymentLock> {
  const lockPath = path.join(getUserStateDir(), 'provider-deployment.lock');
  const local = held.getStore();
  const inherited = local?.lockPath === lockPath ? local.token : process.env[ownerVariable];
  const readOwner = () => readFile(path.join(lockPath, 'owner'), 'utf8').then(value => value.trim());
  let release: (() => Promise<void>) | undefined;
  let token: string;
  // A stale or forged marker cannot bypass the on-disk lease. Borrowers never
  // remove the parent's lock; only the original acquisition may release it.
  if (inherited && await readOwner().catch(() => undefined) === inherited) {
    token = inherited;
  } else {
    release = await acquireSharedLock(lockPath);
    try { token = await readOwner(); }
    catch (error) { await release(); throw error; }
  }
  let active = true;
  return Object.assign(async () => {
    if (!active) return;
    active = false;
    await release?.();
  }, {
    async run<T>(work: () => Promise<T>): Promise<T> {
      if (!active) throw new Error('Provider deployment lock is released');
      return held.run({ lockPath, token }, work);
    },
  });
}

async function acquireSharedLock(lockPath: string): Promise<() => Promise<void>> {
  try {
    return await acquireDirectoryLock(lockPath, { timeoutMs: 0, reclaimDeadOwner: true });
  } catch (error) {
    if (!(error instanceof DirectoryLockContentionError)) throw error;
  }
  console.warn(`Waiting for shared user-home provider deployment lock: ${lockPath}`);
  try {
    return await acquireDirectoryLock(lockPath, { timeoutMs: 120_000, reclaimDeadOwner: true });
  } catch (error) {
    if (!(error instanceof DirectoryLockContentionError)) throw error;
    throw new Error(`Timed out waiting for shared user-home provider deployment lock: ${lockPath}`);
  }
}

export async function withProviderDeploymentLock<T>(work: () => Promise<T>): Promise<T> {
  const release = await acquireProviderDeploymentLock();
  try { return await release.run(work); } finally { await release(); }
}
