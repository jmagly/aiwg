// Capture readable snapshot state and report every intentional or access-related omission.
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { relative, join } from 'node:path';
import { createHash } from 'node:crypto';

export function snapshotCompleteness() {
  return { status: 'complete', omissions: [] };
}

function omit(manager, root, path, reason) {
  const report = manager.completeness;
  const name = relative(root, path);
  if (!report.omissions.some(entry => entry.path === name && entry.reason === reason)) {
    report.omissions.push({ path: name, reason });
    report.status = 'partial';
    console.warn(`[External Ralph] Partial snapshot: omitted ${name} (${reason})`);
  }
}

function accessFailure(manager, root, path, error) {
  if (!['EACCES', 'EPERM', 'ENOENT'].includes(error.code)) throw error;
  omit(manager, root, path, error.code);
}

export function captureReadableFile(manager, root, path) {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile()) {
      omit(manager, root, path, 'not-regular-file');
      return null;
    }
    const content = readFileSync(path);
    return { path: relative(root, path), hash: createHash('sha256').update(content).digest('hex'),
      size: stats.size, mtime: stats.mtime.toISOString() };
  } catch (error) {
    accessFailure(manager, root, path, error);
    return null;
  }
}

export function readSnapshotText(manager, path) {
  try {
    if (!lstatSync(path).isFile()) {
      omit(manager, manager.projectRoot, path, 'not-regular-file');
      return null;
    }
    return readFileSync(path, 'utf8');
  }
  catch (error) { accessFailure(manager, manager.projectRoot, path, error); return null; }
}

export function listSnapshotDirectory(manager, dir, options) {
  try { return readdirSync(dir, options); }
  catch (error) { accessFailure(manager, manager.projectRoot, dir, error); return []; }
}

export function walkSnapshotDirectory(manager, dir, callback) {
  const root = manager.projectRoot;
  if (relative(root, dir) === join('.aiwg', '.index')) {
    omit(manager, root, dir, 'derived-index');
    return;
  }
  const entries = listSnapshotDirectory(manager, dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkSnapshotDirectory(manager, path, callback);
    else if (entry.isFile()) callback(path);
    else omit(manager, root, path, 'not-regular-file');
  }
}
