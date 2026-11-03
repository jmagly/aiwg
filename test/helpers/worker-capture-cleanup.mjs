// Restore sealed snapshot directory permissions only when removing synthetic temporary test trees.
import { chmodSync, lstatSync, readdirSync, rmSync as removeSync } from 'node:fs';
import { rm as remove } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, basename } from 'node:path';

function unlockSnapshots(root) {
  const within = relative(tmpdir(), root);
  if (!within || within === '..' || within.startsWith('../') || isAbsolute(within)) throw new Error('Worker fixture cleanup requires a temporary tree');
  let stat;
  try { stat = lstatSync(root); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!stat.isDirectory()) return;
  if (basename(root).startsWith('.captures-')) chmodSync(root, 0o700);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) unlockSnapshots(join(root, entry.name));
  }
}

export async function rm(root, options) {
  if (options?.recursive) unlockSnapshots(root);
  return remove(root, options);
}

export function rmSync(root, options) {
  if (options?.recursive) unlockSnapshots(root);
  return removeSync(root, options);
}
