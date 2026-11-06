// Detect group-shared workspaces and preserve their permissions across atomic replacement.
import { chmodSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// ACL subprocesses must address the parent's pinned descriptors, not their own fd table.
const aclPath = file => file.replace(/^\/proc\/self\/fd\//, `/proc/${process.pid}/fd/`);
const directoryAcls = new Map();

function hasDefaultAcl(directory, info) {
  const identity = `${info.dev}:${info.ino}:${info.ctimeMs}:${info.mode}:${info.gid}`;
  const cached = directoryAcls.get(directory);
  if (cached?.identity === identity) return cached.present;
  const acl = readAcl(directory);
  if (acl === null) return false; // Unavailable tooling or a timeout is not a cacheable ACL observation.
  const present = /^default:/m.test(acl);
  // chmod, chown and setfacl change ctime; never reuse ACL detection across those changes.
  if (directoryAcls.size >= 1024) directoryAcls.delete(directoryAcls.keys().next().value);
  directoryAcls.set(directory, { identity, present });
  return present;
}

export function readAcl(file) {
  const result = spawnSync('getfacl', ['-cpn', '--', aclPath(file)], { encoding: 'utf8', timeout: 1000 });
  return result.status === 0 ? result.stdout : null;
}

/** Walk enclosing directories, including a not-yet-created artifact root. Never read file contents. */
export function groupSharedWorkspace(directory) {
  for (let current = resolve(directory);;) {
    try {
      const info = lstatSync(current);
      if (info.isDirectory() && (info.mode & 0o007) === 0
        && ((info.mode & 0o2000) !== 0 || hasDefaultAcl(current, info))) {
        return { directory: current, gid: info.gid };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function workspaceDirectoryMode(directory, fallback = 0o700) {
  return groupSharedWorkspace(directory) ? 0o777 : fallback;
}

export function workspaceFileMode(file, fallback = 0o600) {
  return groupSharedWorkspace(dirname(file)) ? 0o666 : fallback;
}

/** Existing readers keep their exact access, even when the umask or default ACL has changed. */
export function preserveWorkspaceReplacement(original, temporary, workspaceDirectory = dirname(original)) {
  if (!groupSharedWorkspace(workspaceDirectory)) return;
  let info;
  try { info = lstatSync(original); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!info.isFile()) throw new Error(`Refusing to preserve permissions of a non-regular file: ${original}`);
  chmodSync(temporary, info.mode & 0o777);
  const acl = readAcl(original);
  if (acl && /^mask::/m.test(acl)) {
    const result = spawnSync('setfacl', ['--set-file=-', '--', aclPath(temporary)], {
      input: acl, encoding: 'utf8', timeout: 1000,
    });
    if (result.status !== 0) throw new Error(`Cannot preserve workspace ACL: ${original}`);
  }
}

/** Private by default; group access requires the enclosing shared workspace's group. */
export function workspacePermissionsAllowed(info, directory) {
  if ((info.mode & 0o007) !== 0) return false;
  if ((info.mode & 0o070) === 0) return true;
  const workspace = groupSharedWorkspace(directory);
  return workspace !== null && info.gid === workspace.gid;
}
