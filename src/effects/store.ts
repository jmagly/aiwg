/**
 * Effect ledger storage under the artifact store.
 *
 *   effects/<subsystem>/
 *     segments/<writer-id>.jsonl   one hash-chained segment per writer
 *     segments/<writer-id>.pending a signed line awaiting append after its index claim
 *     index/<keyed-name>.json      exclusive-create, one per effect ID (and one per outcome)
 *     checkpoints/<sequence>.json  EffectCheckpoint.v1
 *     keyring.json                 EffectKeyring.v1
 *     index.key                    per-ledger key for index file names
 *     locks/                       same-host directory locks
 *
 * The root resolves only through `projectAiwgWritePath`, which fails closed when
 * a configured external artifact root is unavailable. Directories are 0700 and
 * files 0600.
 */

import { randomBytes } from 'node:crypto';
import { lstat, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireDirectoryLock } from '../artifacts/prebuilt-build-lock.js';
import { projectAiwgWritePath } from '../config/project-artifacts.js';
import { canonicalJson } from '../security/artifact-trust.js';
import {
  ensurePrivateDirectory,
  exists,
  keyedName,
  publishExclusive,
  syncDirectory,
} from '../storage/protected-files.js';
import { EffectLedgerError, integrityError } from './errors.js';
import { assertWriterId, SHA256_DIGEST_PATTERN, WRITER_ID_PATTERN } from './identity.js';
import { INDEX_SCHEMA_VERSION, type EffectPhase, type EffectScope, type EffectSubsystem } from './types.js';

export interface LedgerPaths {
  root: string;
  segments: string;
  index: string;
  checkpoints: string;
  locks: string;
  keyring: string;
  indexKey: string;
}

/** Resolve the ledger root for one subsystem. Throws exit 7 when the artifact root is unavailable. */
export function resolveLedgerPaths(projectDir: string, subsystem: EffectSubsystem): LedgerPaths {
  let root: string;
  try { root = projectAiwgWritePath(projectDir, 'effects', subsystem); }
  catch (error) {
    throw new EffectLedgerError('artifact-root-unavailable', `${(error as Error).message} (effect ledger)`, 'artifact-root-unavailable');
  }
  return {
    root,
    segments: join(root, 'segments'),
    index: join(root, 'index'),
    checkpoints: join(root, 'checkpoints'),
    locks: join(root, 'locks'),
    keyring: join(root, 'keyring.json'),
    indexKey: join(root, 'index.key'),
  };
}

const PERMISSIONS_MESSAGE = 'Effect ledger directories must be owner-only (0700)';
const permissionError = (message?: string) => new EffectLedgerError('integrity', message ?? PERMISSIONS_MESSAGE, 'ledger-permissions');

export async function ensureLedgerDirectories(paths: LedgerPaths): Promise<void> {
  for (const directory of [paths.root, paths.segments, paths.index, paths.checkpoints, paths.locks]) {
    await ensurePrivateDirectory(directory, PERMISSIONS_MESSAGE, permissionError);
  }
}

export const segmentFile = (paths: LedgerPaths, writer: string) => join(paths.segments, `${writer}.jsonl`);
const pendingFile = (paths: LedgerPaths, writer: string) => join(paths.segments, `${writer}.pending`);

/** Serialize work for one lock name across processes on this host. */
export async function withLedgerLock<T>(paths: LedgerPaths, name: string, timeoutMs: number, work: () => Promise<T>): Promise<T> {
  let release: () => Promise<void>;
  try { release = await acquireDirectoryLock(join(paths.locks, `${name}.lock`), { timeoutMs, pollMs: 20 }); }
  catch { throw new EffectLedgerError('lock-timeout', 'Timed out waiting for the effect ledger lock', 'lock-timeout'); }
  try { return await work(); }
  finally { await release(); }
}

/** Writers with a segment file, sorted by writer ID. */
export async function listWriters(paths: LedgerPaths): Promise<string[]> {
  let names: string[];
  try { names = await readdir(paths.segments); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return names.filter(name => name.endsWith('.jsonl')).map(name => name.slice(0, -'.jsonl'.length))
    .filter(writer => WRITER_ID_PATTERN.test(writer)).sort();
}

/**
 * Raw lines of one writer's segment, or null when the segment does not exist.
 * `torn` is true when the file does not end with a newline.
 */
export async function readSegment(paths: LedgerPaths, writer: string): Promise<{ lines: string[]; torn: boolean } | null> {
  let raw: string;
  try { raw = await readFile(segmentFile(paths, writer), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (raw === '') return { lines: [], torn: false };
  const torn = !raw.endsWith('\n');
  const lines = raw.split('\n');
  if (!torn) lines.pop();
  return { lines, torn };
}

/** Append one serialized line and fsync. The caller holds the writer lock. */
export async function appendSegmentLine(paths: LedgerPaths, writer: string, line: unknown): Promise<void> {
  assertWriterId(writer);
  const file = segmentFile(paths, writer);
  const created = !(await exists(file));
  const handle = await open(file, 'a', 0o600);
  try { await handle.appendFile(`${JSON.stringify(line)}\n`, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  if (created) await syncDirectory(paths.segments);
}

/** Atomically replace a whole segment (purge only). The caller holds the writer lock. */
export async function replaceSegment(paths: LedgerPaths, writer: string, lines: string[]): Promise<void> {
  await replaceFile(paths.segments, segmentFile(paths, writer), lines.map(line => `${line}\n`).join(''));
}

/** Write a 0600 file through a temporary name, fsync and rename. */
export async function replaceFile(directory: string, file: string, contents: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(contents, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, file); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
  await syncDirectory(directory);
}

/** The per-ledger index-naming key, created once with an exclusive publish. */
export async function loadIndexKey(paths: LedgerPaths): Promise<Buffer> {
  if (!(await exists(paths.indexKey))) {
    await publishExclusive(paths.root, paths.indexKey, `${randomBytes(32).toString('hex')}\n`, 'index-key');
  }
  const stat = await lstat(paths.indexKey);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw integrityError('index-key-permissions');
  const value = (await readFile(paths.indexKey, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(value)) throw integrityError('index-key-malformed');
  return Buffer.from(value, 'hex');
}

export type IndexRole = 'intent' | 'outcome';

/** Keyed file name, so plaintext effect IDs never appear in directory listings. */
export function indexName(key: Buffer, scope: EffectScope, effectId: string, role: IndexRole): string {
  return `${keyedName(key, `aiwg.effect.index/v1/${role}`, [canonicalJson(scope), effectId])}.json`;
}

export interface IndexEntry {
  schemaVersion: typeof INDEX_SCHEMA_VERSION;
  role: IndexRole;
  effectId: string;
  payloadDigest: string;
  phase: Exclude<EffectPhase, 'tombstone'>;
  writer: string;
  seq: number;
  recordHash: string;
}

function isIndexEntry(value: unknown): value is IndexEntry {
  const entry = value as IndexEntry;
  return !!entry && entry.schemaVersion === INDEX_SCHEMA_VERSION && (entry.role === 'intent' || entry.role === 'outcome')
    && typeof entry.effectId === 'string' && SHA256_DIGEST_PATTERN.test(entry.payloadDigest)
    && ['intent', 'completed', 'failed', 'reconciled'].includes(entry.phase)
    && WRITER_ID_PATTERN.test(entry.writer) && Number.isSafeInteger(entry.seq) && entry.seq >= 0
    && SHA256_DIGEST_PATTERN.test(entry.recordHash);
}

export async function readIndexEntry(paths: LedgerPaths, name: string): Promise<IndexEntry | null> {
  let raw: string;
  try { raw = await readFile(join(paths.index, name), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw integrityError('index-entry-malformed'); }
  if (!isIndexEntry(value) || `${canonicalJson(value)}\n` !== raw) throw integrityError('index-entry-malformed');
  return value;
}

export async function listIndexEntries(paths: LedgerPaths): Promise<Array<{ name: string; entry: IndexEntry }>> {
  let names: string[];
  try { names = await readdir(paths.index); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const out: Array<{ name: string; entry: IndexEntry }> = [];
  for (const name of names.filter(file => /^[a-f0-9]{64}\.json$/.test(file)).sort()) {
    const entry = await readIndexEntry(paths, name);
    if (entry) out.push({ name, entry });
  }
  return out;
}

/** Exclusive create. Returns false when another writer already claimed the name. */
export async function claimIndex(paths: LedgerPaths, name: string, entry: IndexEntry): Promise<boolean> {
  return publishExclusive(paths.index, join(paths.index, name), `${canonicalJson(entry)}\n`, 'index');
}

export interface PendingAppend { indexName: string; line: unknown }

export async function writePending(paths: LedgerPaths, writer: string, pending: PendingAppend): Promise<void> {
  await replaceFile(paths.segments, pendingFile(paths, writer), `${canonicalJson(pending)}\n`);
}

export async function readPending(paths: LedgerPaths, writer: string): Promise<PendingAppend | null> {
  let raw: string;
  try { raw = await readFile(pendingFile(paths, writer), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const value = JSON.parse(raw) as PendingAppend;
    return typeof value?.indexName === 'string' && value.line && typeof value.line === 'object' ? value : null;
  } catch { return null; }
}

export async function clearPending(paths: LedgerPaths, writer: string): Promise<void> {
  await rm(pendingFile(paths, writer), { force: true });
}
