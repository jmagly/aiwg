import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { refreshRecordedContextOutput } from '../../providers/context-output-ownership.js';
import { trackTemporaryDirectory } from '../../utils/temporary-directory.js';

const JOURNAL_ENV = 'AIWG_CONTEXT_WRITE_JOURNAL';
export const CONTEXT_STAGE_ENV = 'AIWG_CONTEXT_STAGE_LOG';
interface Identity { dev: string; ino: string }
interface FileVersion extends Identity { size: string; mtime: string }
interface FileState extends FileVersion { bytes: string; mode: number; hash: string }
export interface ContextWriteEntry {
  path: string;
  prior: FileState | null;
  result: Omit<FileState, 'bytes'>;
  ancestors: Identity[];
}
export interface ContextRollbackResult {
  restored: string[];
  conflicts: Array<{ path: string; reason: string }>;
}
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const identity = (stat: fs.BigIntStats): Identity => ({ dev: String(stat.dev), ino: String(stat.ino) });
const sameIdentity = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
const sameAncestors = (a: Identity[], b: Identity[]) => a.length === b.length && a.every((identity, index) => sameIdentity(identity, b[index]));

// Optional flags are absent on some supported hosts (notably Windows).
function flags(...names: Array<keyof typeof fs.constants>): number {
  return names.reduce((value, name) => {
    const flag = fs.constants[name];
    return typeof flag === 'number' ? value | flag : value;
  }, 0);
}
// Identity is dev/ino/size/mtime. A replacement that recycles the freed inode
// number with the same size inside one coarse timestamp tick is
// indistinguishable by metadata; the content hash still has to match deploy
// output, so restoring over such a file loses nothing the deploy wrote.
const version = (stat: fs.BigIntStats): FileVersion => ({ ...identity(stat), size: String(stat.size), mtime: String(stat.mtimeNs) });
const sameVersion = (a: FileVersion, b: FileVersion) => sameIdentity(a, b) && a.size === b.size && a.mtime === b.mtime;

/** Probe child traversal, not just the descriptor link itself. /dev/fd on macOS
 * can expose a descriptor without supporting directory-relative child opens. */
function descriptorRoot(root: string): string | null {
  if (process.platform !== 'linux') return null;
  let fd;
  try {
    fd = fs.openSync(root, flags('O_RDONLY', 'O_DIRECTORY', 'O_NOFOLLOW'));
    const child = `/proc/self/fd/${fd}/.`;
    return sameIdentity(identity(fs.statSync(child, { bigint: true })), identity(fs.fstatSync(fd, { bigint: true }))) ? '/proc/self/fd' : null;
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Pin directories on Linux when descriptor-relative child traversal works.
 * Elsewhere lstat every ancestor and recheck paths around each mutation. The
 * portable fallback has a residual check-then-write race: only descriptor
 * anchoring closes the interval between the last path check and the write. */
function withParent<T>(file: string, create: boolean, action: (anchored: string, ancestors: Identity[], verify: () => void) => T): T {
  const absolute = path.resolve(file);
  const root = path.parse(absolute).root;
  const parts = path.relative(root, absolute).split(path.sep);
  const descriptors: number[] = [];
  const identities: Identity[] = [];
  const fdRoot = descriptorRoot(root);
  try {
    let directory = root;
    for (const part of ['', ...parts.slice(0, -1)]) {
      const next = part ? path.join(directory, part) : directory;
      // Drive roots already exist; mkdir on a Windows drive root can be EPERM.
      if (create && part) {
        try { fs.mkdirSync(next); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      const checked = fs.lstatSync(next, { bigint: true });
      if (checked.isSymbolicLink() || !checked.isDirectory()) throw new Error('Context ancestor changed');
      identities.push(identity(checked));
      directory = next;
      if (fdRoot) {
        const fd = fs.openSync(next, flags('O_RDONLY', 'O_DIRECTORY', 'O_NOFOLLOW'));
        descriptors.push(fd);
        if (!sameIdentity(identity(fs.fstatSync(fd, { bigint: true })), identity(checked))) throw new Error('Context ancestor changed');
        directory = `${fdRoot}/${fd}`;
      }
    }
    const verify = () => {
      let current = root;
      for (let i = 0; i < identities.length; i++) {
        if (i) current = path.join(current, parts[i - 1]);
        const stat = fs.lstatSync(current, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(identity(stat), identities[i])) throw new Error('Context ancestor changed');
      }
    };
    verify();
    return action(path.join(directory, parts[parts.length - 1]), identities, verify);
  } finally { for (const fd of descriptors.reverse()) fs.closeSync(fd); }
}

function checkedVersion(stat: fs.BigIntStats): FileVersion {
  if (stat.isSymbolicLink() || !stat.isFile() || !(stat.mode & 0o444n) || !(stat.mode & 0o222n) || stat.nlink !== 1n) throw new Error('Refusing unreadable, unwritable, linked or non-file context target');
  return version(stat);
}
function verifyTarget(file: string, expected: FileVersion): void {
  if (!sameVersion(checkedVersion(fs.lstatSync(file, { bigint: true })), expected)) throw new Error('Context identity changed');
}
function state(fd: number): FileState {
  const stat = fs.fstatSync(fd, { bigint: true });
  const before = checkedVersion(stat);
  const bytes = Buffer.alloc(Number(stat.size));
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (!count) throw new Error('Context changed while reading');
    offset += count;
  }
  if (!sameVersion(checkedVersion(fs.fstatSync(fd, { bigint: true })), before)) throw new Error('Context changed while reading');
  return { ...before, mode: Number(stat.mode & 0o7777n), bytes: bytes.toString('base64'), hash: digest(bytes) };
}
function readState(file: string): FileState | null {
  let checked;
  try { checked = checkedVersion(fs.lstatSync(file, { bigint: true })); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const fd = fs.openSync(file, flags('O_RDONLY', 'O_NOFOLLOW', 'O_NONBLOCK'));
  try {
    const result = state(fd);
    if (!sameVersion(result, checked)) throw new Error('Context identity changed');
    verifyTarget(file, result);
    return result;
  } finally { fs.closeSync(fd); }
}
function matches(a: FileState, b: Omit<FileState, 'bytes'>): boolean {
  return sameVersion(a, b) && a.hash === b.hash && a.mode === b.mode;
}
function entries(): ContextWriteEntry[] {
  const file = process.env[JOURNAL_ENV];
  return file ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as ContextWriteEntry) : [];
}

/** Every context writer uses this boundary, including staged provider writers.
 * Record immediately after the mutation, before returning to a fallible step. */
export function writeContextFileSync(file: string, content: string | Buffer, _encoding?: string): void {
  const absolute = path.resolve(file);
  const stageLog = process.env[CONTEXT_STAGE_ENV];
  const priorEntries = stageLog ? [] : entries();
  withParent(absolute, true, (anchored, ancestors, verify) => {
    const prior = readState(anchored);
    const previous = priorEntries.reverse().find(entry => entry.path === absolute);
    if (previous && (!prior || !matches(prior, previous.result) || !sameAncestors(ancestors, previous.ancestors))) throw new Error(`Context changed during deployment: ${absolute}`);
    verify();
    const fd = fs.openSync(anchored, flags('O_RDWR', 'O_NOFOLLOW', 'O_NONBLOCK', ...(prior ? [] : ['O_CREAT', 'O_EXCL'] as const)), prior?.mode ?? 0o666);
    try {
      verify();
      if (prior && !matches(state(fd), prior)) throw new Error(`Context identity changed: ${absolute}`);
      verify();
      verifyTarget(anchored, prior ?? checkedVersion(fs.fstatSync(fd, { bigint: true })));
      const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
      const opened = fs.fstatSync(fd, { bigint: true });
      const priorBytes = prior ? Buffer.from(prior.bytes, 'base64') : Buffer.alloc(0);
      const expected = Buffer.alloc(Math.max(buffer.length, priorBytes.length));
      priorBytes.copy(expected);
      let length = priorBytes.length;
      try {
        let offset = 0;
        while (offset < buffer.length) {
          const count = fs.writeSync(fd, buffer, offset, buffer.length - offset, offset);
          if (!count) throw new Error('Context write made no progress');
          buffer.copy(expected, offset, offset, offset + count);
          offset += count;
          length = Math.max(length, offset);
        }
        fs.ftruncateSync(fd, buffer.length);
        length = buffer.length;
      } finally {
        // Hash the bytes this writer produced, never a later read that could
        // accidentally claim an operator's concurrent edit as deploy-owned.
        const completed = fs.fstatSync(fd, { bigint: true });
        const result = { ...version(completed), ...identity(opened), size: String(length), mode: Number(opened.mode & 0o7777n), hash: digest(expected.subarray(0, length)) };
        if (stageLog) fs.appendFileSync(stageLog, `${JSON.stringify(absolute)}\n`);
        else if (process.env[JOURNAL_ENV]) fs.appendFileSync(process.env[JOURNAL_ENV]!, `${JSON.stringify({ path: absolute, prior, result, ancestors })}\n`);
        verify();
        verifyTarget(anchored, result);
        if (!matches(state(fd), result)) throw new Error(`Context changed during write: ${absolute}`);
        if (!stageLog) refreshRecordedContextOutput(absolute, prior?.hash, result.hash, writeContextFileSync);
      }
    } finally { fs.closeSync(fd); }
  });
}

/** Verify before reading provider startup files as well as at the write boundary. */
export async function assertSafeContextFile(file: string): Promise<void> {
  try { withParent(file, false, anchored => { readState(anchored); }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error(`Refusing unsafe ${path.basename(file)} target: ${file}`, { cause: error });
  }
}

/** Owned by the outer use invocation; the private log also crosses subprocesses. */
export class ContextWriteJournal {
  private readonly directory = fs.mkdtempSync(path.join(tmpdir(), 'aiwg-context-writes-'));
  private readonly removeDirectory = trackTemporaryDirectory(this.directory);
  private readonly previous = process.env[JOURNAL_ENV];
  constructor() {
    fs.chmodSync(this.directory, 0o700);
    const file = path.join(this.directory, 'writes.jsonl');
    fs.writeFileSync(file, '', { mode: 0o600, flag: 'wx' });
    process.env[JOURNAL_ENV] = file;
  }
  rollback(): ContextRollbackResult {
    const result: ContextRollbackResult = { restored: [], conflicts: [] };
    const blocked = new Set<string>();
    // Restoring a later pass changes mtime. Carry that verified version back
    // through earlier entries rather than treating our own restore as an edit.
    const restoredVersions = new Map<string, FileState>();
    for (const entry of entries().reverse()) {
      if (blocked.has(entry.path)) continue;
      try {
        withParent(entry.path, false, (anchored, ancestors, verify) => {
          if (!sameAncestors(ancestors, entry.ancestors)) throw new Error('Context ancestor identity changed');
          const checked = checkedVersion(fs.lstatSync(anchored, { bigint: true }));
          const fd = fs.openSync(anchored, flags('O_RDWR', 'O_NOFOLLOW', 'O_NONBLOCK'));
          try {
            verify();
            const current = state(fd);
            if (!sameVersion(current, checked)) throw new Error('Context identity changed');
            if (!matches(current, restoredVersions.get(entry.path) ?? entry.result)) throw new Error('Context changed since deployment wrote it');
            verify();
            verifyTarget(anchored, current);
            if (!matches(state(fd), current)) throw new Error('Context changed before restore');
            if (entry.prior) {
              const bytes = Buffer.from(entry.prior.bytes, 'base64');
              let offset = 0;
              while (offset < bytes.length) {
                const count = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
                if (!count) throw new Error('Context restore made no progress');
                offset += count;
              }
              fs.ftruncateSync(fd, bytes.length);
              fs.fchmodSync(fd, entry.prior.mode);
              verify();
              const restored = state(fd);
              if (!sameIdentity(restored, current) || restored.hash !== entry.prior.hash || restored.mode !== entry.prior.mode) throw new Error('Context changed during restore');
              verifyTarget(anchored, restored);
              restoredVersions.set(entry.path, restored);
            } else {
              // Quarantine before deleting: a final-component swap between the
              // identity check and rename must be kept, never silently unlinked.
              const quarantine = fs.mkdtempSync(path.join(path.dirname(anchored), '.aiwg-context-rollback-'));
              const retained = path.join(quarantine, 'context');
              try {
                fs.renameSync(anchored, retained);
                try {
                  const moved = readState(retained);
                  if (!moved || !matches(moved, current)) throw new Error('Context changed during removal');
                  verify();
                  fs.unlinkSync(retained);
                } catch (error) {
                  try { fs.linkSync(retained, anchored); fs.unlinkSync(retained); }
                  catch {
                    const saved = path.join(path.dirname(entry.path), path.basename(quarantine), 'context');
                    throw new Error(`Context changed during removal; preserved at ${saved}`, { cause: error });
                  }
                  throw error;
                }
                verify();
                if (fs.existsSync(anchored)) throw new Error('Context path replaced during rollback');
              } finally {
                try { fs.rmdirSync(quarantine); } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error;
                }
              }
            }
          } finally { fs.closeSync(fd); }
        });
        if (!result.restored.includes(entry.path)) result.restored.push(entry.path);
      } catch (error) {
        blocked.add(entry.path);
        result.conflicts.push({ path: entry.path, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  }
  dispose(): void {
    if (this.previous === undefined) delete process.env[JOURNAL_ENV];
    else process.env[JOURNAL_ENV] = this.previous;
    this.removeDirectory();
  }
}
