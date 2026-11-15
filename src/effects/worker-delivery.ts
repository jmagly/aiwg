// Signed publication receipts and current-byte lookup for verified worker artifacts.
import { readFile, realpath } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertKeyring } from './keyring.js';
import { sha256Digest } from './identity.js';
import { recordIntent, recordOutcome, type EffectLedger } from './ledger.js';
import { readAllSegments, readKeyring, lineFailures } from './reader.js';
import { verifyLedger } from './verify.js';
import { ensureLedgerDirectories, withLedgerLock } from './store.js';

interface DeliveryBytes {
  artifactDigest: string;
  deliverablePath: string;
  verifierId: string;
}
export type WorkerDelivery = DeliveryBytes & (
  { kind?: 'worker'; runDir: string; invocationId: string }
  | { kind: 'typed-stop'; verifierId: 'typed-stop@1'; runDir?: never; invocationId?: never }
);
const canonicalDestination = async (destination: string) => join(await realpath(dirname(destination)), basename(destination));

/** A signed intent reserves the path even if publication crashed or bytes changed. */
async function reserveDelivery(ledger: EffectLedger, delivery: WorkerDelivery, target: string) {
  const paths = ledger.paths();
  await ensureLedgerDirectories(paths);
  return withLedgerLock(paths, 'worker-delivery', ledger.lockTimeoutMs, async () => {
    if (!(await verifyLedger(ledger, { checkIndex: false })).ok) throw new Error('Delivery ledger integrity failed; publication refused');
    const records = (await readAllSegments(paths)).flatMap(segment => segment.lines.flatMap(line => line.decoded ? [line.decoded] : []));
    const conflict = records.some(({ statement: { predicate: p } }) => p.kind === 'file.digest' && p.target === `file:${target}`
      && typeof p.context?.deliveryId === 'string' && (delivery.kind === 'typed-stop' || p.context?.kind === 'typed-stop'));
    if (conflict) throw Object.assign(new Error('TYPED_STOP_CONFLICT: a delivery record already exists for this path'), { code: 'TYPED_STOP_CONFLICT' });
    const context: Record<string, string> = { artifactDigest: delivery.artifactDigest, verifierId: delivery.verifierId,
      deliverablePath: target, deliveryId: randomUUID() };
    if (delivery.kind) context.kind = delivery.kind;
    if (delivery.kind !== 'typed-stop') { context.runDir = delivery.runDir; context.invocationId = delivery.invocationId; }
    return recordIntent(ledger, { kind: 'file.digest', target: `file:${target}`, context, payloadDigest: delivery.artifactDigest });
  });
}

/** Persist intent before publication, then complete only after the digest-checked rename. */
export async function prepareWorkerDelivery(ledger: EffectLedger, delivery: WorkerDelivery) {
  if (delivery.kind === 'typed-stop' && (delivery.verifierId !== 'typed-stop@1' || 'runDir' in delivery || 'invocationId' in delivery)) {
    throw Object.assign(new Error('TYPED_STOP_INVALID: typed stops cannot have worker lineage'), { code: 'TYPED_STOP_INVALID' });
  }
  const target = await canonicalDestination(delivery.deliverablePath);
  const intent = await reserveDelivery(ledger, delivery, target);
  return async () => {
    if (sha256Digest(await readFile(target)) !== delivery.artifactDigest) throw new Error('Published deliverable digest does not match acceptance; delivery record refused');
    return recordOutcome(ledger, intent.effectId, { phase: 'completed', payloadDigest: delivery.artifactDigest,
      verification: { verifier: { kind: 'file.digest', version: '1.0.0', canReportAbsent: false }, result: 'present', reason: 'digest-match', complete: true, checkedAt: ledger.now(), evidenceDigest: delivery.artifactDigest } });
  };
}

/** Read-only: signatures/chains and a completed delivery must match the current bytes. */
export async function lookupWorkerDelivery(ledger: EffectLedger, deliverablePath: string) {
  let target: string, artifactDigest: string;
  try {
    target = await canonicalDestination(deliverablePath);
    artifactDigest = sha256Digest(await readFile(target));
  } catch { return { verified: false, deliverablePath, reason: 'deliverable-unreadable' }; }
  const verification = await verifyLedger(ledger, { checkIndex: false });
  if (!verification.ok) return { verified: false, deliverablePath: target, artifactDigest, reason: 'ledger-integrity-failed' };
  const records = (await readAllSegments(ledger.paths())).flatMap(segment => segment.lines.flatMap(line => line.decoded ? [line.decoded] : []));
  const keyring = await readKeyring(ledger.paths());
  if (!keyring) return { verified: false, deliverablePath: target, artifactDigest, reason: 'ledger-empty' };
  assertKeyring(keyring, ledger.scope);
  const previous = new Map<string, string>();
  for (const record of records) {
    if (lineFailures(keyring, ledger.scope, record.line.writer, record.line.seq, record, previous.get(record.line.writer) ?? null).length) return { verified: false, deliverablePath: target, artifactDigest, reason: 'ledger-integrity-failed' };
    previous.set(record.line.writer, record.line.recordHash);
  }
  const match = records.reverse().find(({ statement: { predicate: p } }) => p.kind === 'file.digest' && p.phase === 'completed'
    && p.target === `file:${target}` && p.payloadDigest === artifactDigest && p.context?.artifactDigest === artifactDigest
    && typeof p.context?.deliveryId === 'string' && typeof p.context?.verifierId === 'string'
    && (p.context?.kind === 'typed-stop'
      ? p.context.verifierId === 'typed-stop@1' && !('runDir' in p.context) && !('invocationId' in p.context)
      : typeof p.context?.runDir === 'string' && typeof p.context?.invocationId === 'string'));
  if (!match) return { verified: false, deliverablePath: target, artifactDigest, reason: 'matching-delivery-missing' };
  return { verified: true, ...match.statement.predicate.context, recordHash: match.line.recordHash };
}
