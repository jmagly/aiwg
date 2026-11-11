// Read bounded worker inputs through pinned, no-follow directory handles.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';

// Linux directory handles pin each ancestor. O_NOFOLLOW on a pathname alone
// cannot protect an ancestor that the worker replaces after inspection.
export async function withWorkerPath(filename, operation) {
  if (!isAbsolute(filename) || filename.includes('\0') || filename.split('/').includes('..')) throw new Error('Invalid worker path');
  const components = filename.split('/').filter(Boolean);
  const leaf = components.pop();
  let directory = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const component of components) {
      const next = await open(`/proc/self/fd/${directory.fd}/${component}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await directory.close(); directory = next;
    }
    return await operation(`/proc/self/fd/${directory.fd}/${leaf ?? '.'}`);
  } finally { await directory.close(); }
}

// Reuse one pinned directory for a batch of direct-child operations. Every
// ancestor and the directory itself are still opened with O_NOFOLLOW;
// callers retain the leaf operation's own no-follow/exclusive-create checks.
export async function withWorkerDirectory(directory, operation) {
  return withWorkerPath(directory, async anchored => {
    const handle = await open(anchored, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      return await operation(async (filename, action) => {
        if (filename.includes('\0') || filename.split('/').includes('..')
          || (filename !== directory && dirname(filename) !== directory)) {
          throw new Error('Invalid worker path outside pinned directory');
        }
        const leaf = filename === directory ? '.' : basename(filename);
        return action(`/proc/self/fd/${handle.fd}/${leaf}`);
      });
    } finally { await handle.close(); }
  });
}

// #2915 review 4 (finding 4): `privateOutput: true` REPAIRS a loose mode
// (chmod 0600) rather than rejecting it — correct for the worker's own
// final-output file, which the launcher itself created and is free to
// re-tighten. `rejectInsecureMode: true` additionally REFUSES a mode other
// than exactly 0600 instead of repairing it, for evidence this launcher
// did NOT create moments ago (retry predecessor metadata) — a 0666 file
// there is itself a signal worth refusing on, not silently normalizing
// away.
export async function boundedPrivateRead(filename, limit, inspect, privateOutput = false, rejectInsecureMode = false) {
  if (!await inspect(filename, 'file')) throw new Error('Required worker input is missing');
  const handle = await withWorkerPath(filename, target => open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error('Worker input must be a bounded unaliased regular file');
    if (privateOutput) {
      if (stat.uid !== process.getuid()) throw new Error('Worker final must be conductor-owned');
      if (rejectInsecureMode) {
        if ((stat.mode & 0o777) !== 0o600) throw new Error('Worker input mode must already be exactly 0600; insecure modes are refused, not repaired');
      } else {
        await handle.chmod(0o600);
      }
    }
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error('Worker input exceeds bound');
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}

