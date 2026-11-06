// Enforce journals' no-other-access invariant only on newly created shared entries.
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { groupSharedWorkspace, workspaceDirectoryMode, workspaceFileMode } from '../utils/workspace-permissions.mjs';

export async function createJournalDirectory(directory: string, fallback: number): Promise<void> {
  const shared = groupSharedWorkspace(directory);
  const first = await mkdir(directory, { recursive: true, mode: workspaceDirectoryMode(directory, fallback) });
  if (!shared || !first) return;
  let current = first;
  for (const part of ['', ...relative(first, directory).split(sep).filter(Boolean)]) {
    current = part ? join(current, part) : current;
    const info = await lstat(current);
    if (!info.isDirectory()) throw new Error('Unsafe new journal directory');
    if (info.mode & 0o007) await chmod(current, info.mode & 0o7777 & ~0o007);
  }
}

export async function openJournalFile(file: string, flags: number, fallback: number) {
  if (!(flags & constants.O_CREAT)) return open(file, flags);
  let handle;
  try { handle = await open(file, flags | constants.O_EXCL, workspaceFileMode(file, fallback)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || (flags & constants.O_EXCL)) throw error;
    return open(file, flags & ~constants.O_CREAT);
  }
  try {
    const info = await handle.stat();
    // Request 0666 and inherit the ACL/umask, then enforce the journal-specific invariant.
    // Keeping the inherited group bits leaves the ACL mask intact.
    if ((info.mode & 0o007) && groupSharedWorkspace(dirname(file))) await handle.chmod(info.mode & 0o777 & ~0o007);
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
