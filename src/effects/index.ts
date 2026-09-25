/**
 * AIWG effect ledger core library (#2717, epic #2714).
 *
 * A signed proof and deduplication index for side effects. It is not an
 * exactly-once mechanism and it never authorizes an effect.
 *
 * @see docs/contracts/effect-ledger.v1.md
 * @see docs/architecture/adr-effect-ledger.md
 */

export * from './types.js';
export {
  EFFECT_EXIT_CODES,
  EffectLedgerError,
  type EffectExitCode,
  type EffectLedgerErrorCode,
} from './errors.js';
export {
  D13_REVIEW_ID_PATTERN,
  EFFECT_ID_DERIVATIONS,
  EFFECT_ID_V1_PATTERN,
  assertEffectId,
  base32Lower,
  defaultDerivationFor,
  effectId,
  effectIdDerivation,
  isEffectKind,
  isValidEffectId,
  payloadDigest,
  sha256Digest as effectSha256Digest,
  type EffectIdDerivation,
} from './identity.js';
export {
  DEFAULT_LEDGER_KEY_SERVICE,
  LEDGER_TEST_KEY_ENV,
  LedgerSigningKey,
  credentialStoreKeyProvider,
  environmentTestKeyProvider,
  generateLedgerKeySecret,
  staticKeyProvider,
  type CredentialStoreKeyProviderOptions,
  type LedgerKeyProvider,
} from './keys.js';
export { activeKey, keyValidAt, keyringDigest, keyringFailure } from './keyring.js';
export {
  EffectLedger,
  effectOutputJson,
  initLedgerKeyring,
  lookupEffect,
  readLedgerKeyring,
  openEffectLedger,
  reconcileEffect,
  recordIntent,
  recordOutcome,
  recordReconciled,
  rotateKey,
  type EffectLookup,
  type EffectLookupStatus,
  type EffectReceipt,
  type EffectRecordSummary,
  type OpenEffectLedgerOptions,
  type ReconcileOptions,
  type ReconcileOutcome,
  type RecordIntentInput,
  type RecordOutcomeInput,
  type RotateKeyOptions,
} from './ledger.js';
export * from './verifiers/index.js';
export {
  gitRefCheckpointSink,
  memoryCheckpointSink,
  type CheckpointSink,
  type CheckpointSinkReceipt,
  type GitRefCheckpointSinkOptions,
  type GitRunner,
} from './checkpoint-sinks.js';
export { writeCheckpoint, type WriteCheckpointResult } from './checkpoint.js';
export {
  checkpointDigest,
  verifyLedger,
  type LedgerVerification,
  type LedgerVerifyFailure,
  type VerifyLedgerOptions,
} from './verify.js';
export { EFFECT_RETENTION_POLICY, purgeEffect, type PurgeEffectOptions, type PurgeEffectResult } from './lifecycle.js';
export {
  LEDGER_LOCK_NAME_PATTERN,
  LOCK_RECOVERY_KIND,
  LOCK_RECOVERY_VERIFIER_VERSION,
  inspectLedgerLock,
  inspectLedgerLocks,
  ledgerLockRecoveryVerifier,
  lockRecoveryTarget,
  recoverStaleLedgerLock,
  type LedgerLockInspection,
  type LedgerLockOwnerState,
  type LockRecoveryOptions,
  type LockRecoveryResult,
} from './lock-recovery.js';
export { assertDigestOnly, containsRestrictedMaterial } from './redaction.js';
export { EFFECT_SCHEMA_IDS, effectSchemaErrors, isEffectSchemaValid, type EffectSchemaName } from './schema.js';
