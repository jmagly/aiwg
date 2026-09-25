/**
 * Protected local file primitives shared by durable stores.
 *
 * Records are stored as exact RFC 8785 canonical bytes, keyed with HMAC-SHA256,
 * kept in owner-only directories, and published with exclusive hard links so a
 * destination is written at most once. Nothing here knows about any caller's
 * lifecycle or error taxonomy: callers supply their own error factories.
 *
 * This module must not import from `src/decision/**`.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { link, lstat, mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../security/artifact-trust.js';

/** Creates the error a caller throws. Keeps each store's error class and message unchanged. */
export type ProtectedFileErrorFactory = (message?: string) => Error;

/** Opaque by default: callers learn only that stored bytes failed verification. */
export class ProtectedFileIntegrityError extends Error {
  constructor() { super('Protected file integrity check failed'); this.name = 'ProtectedFileIntegrityError'; }
}

export function requireIntegrityKey(key: unknown, label: string): Buffer {
  if (!(key instanceof Uint8Array) || key.length < 32) throw new Error(`${label} integrity key must be at least 32 bytes`);
  return Buffer.from(key);
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

/** Parse stored bytes, refusing anything that is not exactly its canonical serialization. */
export function parseCanonical(raw: string, integrityError: ProtectedFileErrorFactory = () => new ProtectedFileIntegrityError()): unknown {
  const parsed = JSON.parse(raw) as unknown;
  if (serialized(parsed) !== raw) throw integrityError();
  return parsed;
}

/** Create (if needed) and require an owner-only directory. Any group or other permission bit is refused. */
export async function ensurePrivateDirectory(
  directory: string,
  message: string,
  error: ProtectedFileErrorFactory = (text) => new Error(text),
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw error(message);
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

/**
 * Publish a body-free tombstone record in canonical form. An existing tombstone
 * already has the same effect, so publication is idempotent.
 */
export async function publishTombstone(
  directory: string,
  path: string,
  record: Record<string, unknown>,
  temporaryPrefix: string,
): Promise<void> {
  await publishExclusive(directory, path, serialized(record), temporaryPrefix);
}
