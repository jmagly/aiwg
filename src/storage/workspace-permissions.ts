// Stat-only permission policy for non-secret files in setgid, closed-to-others workspaces.
import { lstatSync, type Stats } from 'node:fs';
import { chmod, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** Walk existing directories only; no ACL commands, subprocesses, or cached policy. */
export function sharedWorkspace(directory: string): { gid: number } | null {
  if (process.platform === 'win32') return null;
  let current = resolve(directory);
  for (;;) {
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink()) return null;
      if (info.isDirectory() && (info.mode & 0o2000) !== 0) {
        return (info.mode & 0o007) === 0 ? { gid: info.gid } : null;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// Group bits leave the inherited ACL mask usable; umask/default ACL still apply.
export const workspaceFileMode = (file: string): number => sharedWorkspace(dirname(file)) ? 0o660 : 0o600;
export const workspaceDirectoryMode = (directory: string): number => sharedWorkspace(directory) ? 0o770 : 0o700;

/** Private files remain valid; shared files must match the workspace gid and exclude others. */
export function workspacePermissionsAllowed(file: string, info: Pick<Stats, 'mode' | 'gid'> & Partial<Pick<Stats, 'isDirectory'>>): boolean {
  if ((info.mode & 0o077) === 0) return true;
  const shared = sharedWorkspace(info.isDirectory?.() ? file : dirname(file));
  return (info.mode & 0o007) === 0 && shared !== null && info.gid === shared.gid;
}

/** chmod after creation preserves the target mode even when umask filters temporary-file creation. */
export async function preserveReplacementMode(temporary: string, destination: string): Promise<void> {
  try {
    const info = await lstat(destination);
    if (info.isFile()) await chmod(temporary, info.mode & 0o777);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
