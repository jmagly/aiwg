// Stores grants in the existing signed ledger; the private descriptor index is derived only.
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../security/artifact-trust.js';
import { AUTHORIZATION_GRANT_KIND, assertAuthorizationGrant, authorizationGrantIdentity, type AuthorizationGrant } from './authorization-grant.js';
import { integrityError } from './errors.js';
import { payloadDigest } from './identity.js';
import { assertKeyring } from './keyring.js';
import { recordIntent, type EffectLedger } from './ledger.js';
import { lineFailures, readAllSegments, readKeyring } from './reader.js';
import { ensureLedgerDirectories, replaceFile, withLedgerLock } from './store.js';
import type { EffectLinks } from './types.js';
import { verifyLedger, type LedgerVerifyFailure } from './verify.js';

export interface StoredAuthorizationGrant {
  grant: AuthorizationGrant;
  effectId: string;
  recordHash: string;
}
export interface AuthorizationGrantRead {
  grants: StoredAuthorizationGrant[];
  failures: LedgerVerifyFailure[];
}

/** Fail closed on ledger damage. Expired/revoked grants remain history; matching belongs to #4001. */
export async function readAuthorizationGrants(ledger: EffectLedger): Promise<AuthorizationGrantRead> {
  const verification = await verifyLedger(ledger);
  if (!verification.ok) return { grants: [], failures: verification.failures };
  const segments = await readAllSegments(ledger.paths());
  const count = segments.reduce((total, segment) => total + segment.lines.length, 0);
  if (count !== verification.records) return { grants: [], failures: [{ reason: 'ledger-changed-during-read' }] };
  if (!count) return { grants: [], failures: [] };
  const ring = await readKeyring(ledger.paths());
  try { assertKeyring(ring, ledger.scope); }
  catch { return { grants: [], failures: [{ reason: 'keyring-invalid' }] }; }
  const grants: StoredAuthorizationGrant[] = [];
  const failures: LedgerVerifyFailure[] = [];
  for (const segment of segments) {
    let previous: string | null = null;
    if (segment.torn) failures.push({ reason: 'segment-torn', writer: segment.writer });
    for (const read of segment.lines) {
      if (!read.decoded) { failures.push({ reason: read.failure!, writer: segment.writer, seq: read.index }); continue; }
      const { line, statement: { predicate } } = read.decoded;
      for (const reason of lineFailures(ring, ledger.scope, segment.writer, read.index, read.decoded, previous)) {
        failures.push({ reason, writer: segment.writer, seq: read.index });
      }
      previous = line.recordHash;
      if (predicate.kind === AUTHORIZATION_GRANT_KIND && predicate.phase === 'intent') {
        grants.push({ grant: structuredClone(predicate.authorizationGrant!), effectId: predicate.effectId, recordHash: line.recordHash });
      }
    }
  }
  // A purged grant is never resurrected from its earlier signed intent.
  const tombstoned = new Set(segments.flatMap(segment => segment.lines.flatMap(read =>
    read.decoded?.statement.predicate.phase === 'tombstone' ? [read.decoded.statement.predicate.effectId] : [])));
  return { grants: failures.length ? [] : grants.filter(entry => !tombstoned.has(entry.effectId))
    .sort((a, b) => a.effectId.localeCompare(b.effectId)), failures };
}

const indexPath = (ledger: EffectLedger) => join(ledger.paths().root, 'authorization-index.json');
const indexBytes = (ledger: EffectLedger, entries: StoredAuthorizationGrant[]) => `${canonicalJson({
  apiVersion: 'authorization-grant-index.aiwg.io/v1', ledgerScope: ledger.scope,
  entries: entries.map(({ grant, effectId, recordHash }) => ({
    grantId: grant.grantId, effectId, recordHash, scope: grant.scope, constraints: grant.constraints,
    createdAt: grant.createdAt, expiresAt: grant.expiresAt, revocation: grant.revocation,
  })),
})}\n`;

/** Trusted host API only: it records supplied human evidence, and does not authenticate a user. */
export async function recordAuthorizationGrant(ledger: EffectLedger, value: unknown, links: EffectLinks = {}) {
  assertAuthorizationGrant(value);
  const grant = structuredClone(value);
  const paths = ledger.paths();
  await ensureLedgerDirectories(paths);
  return withLedgerLock(paths, 'authorization-index', ledger.lockTimeoutMs, async () => {
    const before = await readAuthorizationGrants(ledger);
    if (before.failures.length) throw integrityError('authorization-ledger-invalid');
    const receipt = await recordIntent(ledger, {
      ...authorizationGrantIdentity(grant.grantId), authorizationGrant: grant,
      payloadDigest: payloadDigest(canonicalJson(grant)), links,
    });
    const after = await readAuthorizationGrants(ledger);
    if (after.failures.length) throw integrityError('authorization-ledger-invalid');
    await replaceFile(paths.root, indexPath(ledger), indexBytes(ledger, after.grants));
    return receipt;
  });
}

/** Inspect derived index drift without creating directories, repairing files or acquiring signing keys. */
export async function inspectAuthorizationIndex(ledger: EffectLedger, read: AuthorizationGrantRead) {
  try {
    const stat = await lstat(indexPath(ledger));
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) return 'drift' as const;
    return await readFile(indexPath(ledger), 'utf8') === indexBytes(ledger, read.grants) ? 'current' as const : 'drift' as const;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return read.grants.length ? 'missing' as const : 'absent' as const;
    throw error;
  }
}

/** Rebuild and compare the index, retaining a nonzero result for damage found before repair. */
export async function verifyAuthorizationGrants(ledger: EffectLedger) {
  const paths = ledger.paths();
  await ensureLedgerDirectories(paths);
  return withLedgerLock(paths, 'authorization-index', ledger.lockTimeoutMs, async () => {
    const read = await readAuthorizationGrants(ledger);
    const expected = indexBytes(ledger, read.grants);
    let current: string | null = null;
    let privateFile = true;
    try {
      const stat = await lstat(indexPath(ledger));
      privateFile = stat.isFile() && (stat.mode & 0o077) === 0;
      // Do not follow a substituted index symlink.
      if (stat.isFile()) current = await readFile(indexPath(ledger), 'utf8');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const indexChanged = current !== expected || !privateFile;
    const failures = [...read.failures];
    if ((!privateFile || current !== null) && indexChanged) failures.push({ reason: 'authorization-index-mismatch' });
    // A missing derived index is safe to rebuild; no grant data is trusted from it.
    if (indexChanged) await replaceFile(paths.root, indexPath(ledger), expected);
    return { ok: failures.length === 0, exitCode: failures.length ? 6 : 0, grants: read.grants.length, indexChanged, failures };
  });
}
