import {
  ensurePrivateDirectory as ensureProtectedDirectory,
  parseCanonical as parseProtectedCanonical,
  publishTombstone,
} from '../../storage/protected-files.js';
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

// Generic protected-file primitives live in src/storage; they are re-exported
// here so existing batch-store imports keep their names and behavior.
export {
  exists, keyedName, macFor, macMatches, publishExclusive, requireIntegrityKey, serialized, syncDirectory,
} from '../../storage/protected-files.js';

export function receiptLifecycleRule(binding: BatchStoreLifecycleBinding | undefined): DecisionLifecycleRule {
  validateDecisionLifecyclePolicy(binding?.lifecycle as DecisionLifecyclePolicy);
  return binding!.lifecycle.surfaces.receipt;
}

/** Stored bytes must be exactly the canonical serialization, so no byte can change unnoticed. */
export function parseCanonical(raw: string): unknown {
  return parseProtectedCanonical(raw, () => new BatchStoreIntegrityError());
}

export async function ensurePrivateDirectory(directory: string, message: string): Promise<void> {
  await ensureProtectedDirectory(directory, message, (text) => new BatchReceiptValidationError(text ?? message));
}

/** Body-free local tombstone. Its presence alone blocks reads, writes, acquisition and restore. */
export async function writeTombstone(directory: string, path: string, reference: DecisionLifecycleReference, deletedAt: number): Promise<void> {
  // An existing tombstone already has the same effect; erasure is idempotent.
  await publishTombstone(directory, path, { version: 'decision-batch-tombstone/v1', reference, deletedAtEpochMs: deletedAt }, 'batch-tombstone');
}

export function expired(createdAtEpochMs: number, now: number, rule: DecisionLifecycleRule): boolean {
  return !Number.isSafeInteger(now) || now < createdAtEpochMs || now - createdAtEpochMs >= rule.retentionMs;
}
