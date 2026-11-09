import fs from 'node:fs';
import path from 'node:path';

/** Create a read-only reference to trusted provider snapshot inputs.
 * Windows directory symbolic links can require elevated privilege, so use a
 * junction with an absolute target there. POSIX keeps the existing `dir`
 * symlink behavior. Junction creation errors propagate; callers own cleanup. */
export function createStagedDirectoryReference(from, to) {
  if (process.platform === 'win32') {
    fs.symlinkSync(path.resolve(from), to, 'junction');
    return;
  }
  fs.symlinkSync(from, to, 'dir');
}
