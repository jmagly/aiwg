import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { link, lstat, mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../../security/artifact-trust.js';
import { validateDecisionLifecyclePolicy, type DecisionLifecyclePolicy, type DecisionLifecycleReference,
  type DecisionLifecycleRule } from '../lifecycle.js';
import { BatchReceiptValidationError } from './validate.js';

/** Opaque by design: callers learn only that stored bytes failed verification. */
export class BatchStoreIntegrityError extends Error {
  constructor() { super('Batch store integrity check failed'); this.name = 'BatchStoreIntegrityError'; }
}

/** Erased, expired, or tombstoned durable state. Replay must neither re-dispatch nor serve it. */
export class BatchRecordUnavailableError extends Error {
  readonly code = 'batch-record-unavailable' as const;
  constructor() { super('Batch record unavailable'); this.name = 'BatchRecordUnavailableError'; }
}

/** Unkeyed records from before integrity protection. They are read-only until explicitly migrated. */
export class BatchStoreMigrationRequiredError extends Error {
  readonly code = 'batch-store-migration-required' as const;
  constructor() { super('Batch store requires explicit migration'); this.name = 'BatchStoreMigrationRequiredError'; }
}

/** D10 binding shared by the durable batch stores. Both stores use the `receipt` surface rule. */
export interface BatchStoreLifecycleBinding {
  lifecycle: DecisionLifecyclePolicy;
  clock?: () => number;
}

export interface BatchStoreRestoreReport { restored: number; refused: number }

export function requireIntegrityKey(key: unknown, label: string): Buffer {
  if (!(key instanceof Uint8Array) || key.length < 32) throw new Error(`${label} integrity key must be at least 32 bytes`);
  return Buffer.from(key);
}

export function receiptLifecycleRule(binding: BatchStoreLifecycleBinding | undefined): DecisionLifecycleRule {
  validateDecisionLifecyclePolicy(binding?.lifecycle as DecisionLifecyclePolicy);
  return binding!.lifecycle.surfaces.receipt;
}

export function keyedName(key: Buffer, domain: string, parts: string[]): string {
  return createHmac('sha256', key).update(`${domain}\0`).update(parts.join('\0')).digest('hex');
}

export function macFor(key: Buffer, domain: string, value: unknown): string {
  return createHmac('sha256', key).update(`${domain}:`).update(canonicalJson(value)).digest('hex');
}

export function macMatches(key: Buffer, domain: string, value: unknown, mac: unknown): boolean {
  return typeof mac === 'string' && /^[a-f0-9]{64}$/.test(mac)
    && timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(macFor(key, domain, value), 'hex'));
}

/** Stored bytes must be exactly the canonical serialization, so no byte can change unnoticed. */
export function serialized(value: unknown): string { return `${canonicalJson(value)}\n`; }

export function parseCanonical(raw: string): unknown {
  const parsed = JSON.parse(raw) as unknown;
  if (serialized(parsed) !== raw) throw new BatchStoreIntegrityError();
  return parsed;
}

export async function ensurePrivateDirectory(directory: string, message: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new BatchReceiptValidationError(message);
}

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** Exclusive hard-link publication. Returns false when the destination already exists. */
export async function publishExclusive(directory: string, destination: string, contents: string, temporaryPrefix: string): Promise<boolean> {
  const temporary = join(directory, `.${temporaryPrefix}-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(contents, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  try { await link(temporary, destination); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
  finally { await rm(temporary, { force: true }); }
  await syncDirectory(directory);
  return true;
}

/** Body-free local tombstone. Its presence alone blocks reads, writes, acquisition and restore. */
export async function writeTombstone(directory: string, path: string, reference: DecisionLifecycleReference, deletedAt: number): Promise<void> {
  const contents = serialized({ version: 'decision-batch-tombstone/v1', reference, deletedAtEpochMs: deletedAt });
  // An existing tombstone already has the same effect; erasure is idempotent.
  await publishExclusive(directory, path, contents, 'batch-tombstone');
}

export function expired(createdAtEpochMs: number, now: number, rule: DecisionLifecycleRule): boolean {
  return !Number.isSafeInteger(now) || now < createdAtEpochMs || now - createdAtEpochMs >= rule.retentionMs;
}
