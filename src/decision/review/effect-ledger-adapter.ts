/**
 * D13 adoption of the AIWG effect ledger (#2721, answers #2677).
 *
 * `LedgerReviewEffectJournal` implements `VerifiedReviewEffectLedger` (and the
 * `ReviewEffectJournal` write port used by `journaledReviewExecutor`) over the
 * signed effect ledger in `src/effects`. It keeps D13's effect identity exactly:
 * the `d13.review/v1` derivation is `reviewDigest({reviewId, continuationId,
 * proposalVersion})`, so reviews persisted before the ledger stay valid.
 *
 * Target systems remain the authorities. The ledger records a signed `intent`
 * before the effect and `completed` only after the `decision.review.continuation`
 * verifier reports `present`; `absent` and `unknown` never authorize a replay.
 *
 * @see docs/decision/review.md "Effect ledger"
 * @see docs/contracts/effect-ledger.v1.md
 */

import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../../security/artifact-trust.js';
import { publishExclusive } from '../../storage/protected-files.js';
import {
  EffectLedger,
  createBuiltinVerifierRegistry,
  createVerifierRegistry,
  effectId as deriveEffectId,
  effectSha256Digest,
  evidenceDigest,
  isValidEffectId,
  lookupEffect,
  reconcileEffect,
  recordIntent,
  reviewContinuationTarget,
  type EffectLookup,
  type EffectRecordSummary,
  type EffectVerifier,
  type EffectVerifierEvidence,
  type EffectVerifierRegistry,
  type LedgerKeyProvider,
  type ReviewContinuationVerifierOptions,
} from '../../effects/index.js';
import { readWriterSegment } from '../../effects/reader.js';
import type { CheckpointSink } from '../../effects/checkpoint-sinks.js';
import type { ReviewEffectReceipt, ReviewStore } from './types.js';
import type { ReviewEffectQuery, ReviewEffectReconcileOptions, ReviewEffectVerification } from './recovery.js';
import type { FileVerifiedReviewEffectLedger, ReviewEffectIdentity, ReviewEffectJournal } from './recovery-adapters.js';
import { assertReviewProjection, reviewDigest } from './validate.js';

export const REVIEW_EFFECT_KIND = 'decision.review.continuation' as const;
export const REVIEW_EFFECT_DERIVATION = 'd13.review/v1' as const;
/** `result` of a receipt rebuilt from ledger records when the receipt body was never archived. */
export const REVIEW_EFFECT_REFERENCE_SCHEMA = 'aiwg.review-effect-reference/v1' as const;
const ARCHIVE_SCHEMA = 'aiwg.review-effect-receipt/v1' as const;
/** Version of the one-shot verifier that imports legacy HMAC receipts (`method: legacy-hmac`). */
export const LEGACY_HMAC_IMPORT_VERIFIER_VERSION = '0.2.0';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');
const invalidEntry = () => new Error('Invalid executor ledger entry');

/** The ledger intent (kind, target, context) for one review continuation. */
export function reviewEffectIntent(identity: ReviewEffectIdentity) {
  return {
    kind: REVIEW_EFFECT_KIND,
    target: reviewContinuationTarget(identity.tenantId, identity.projectId, identity.reviewId),
    context: { reviewId: identity.reviewId, continuationId: identity.continuationId, proposalVersion: identity.proposalVersion },
    derivation: REVIEW_EFFECT_DERIVATION,
  };
}

/** The ledger effect ID for a review continuation; equal to D13's `reviewDigest` identity. */
export function reviewEffectId(identity: ReviewEffectIdentity): string {
  const intent = reviewEffectIntent(identity);
  return deriveEffectId({ scope: { tenant: identity.tenantId, project: identity.projectId, subsystem: 'review' },
    kind: intent.kind, target: intent.target, context: intent.context }, REVIEW_EFFECT_DERIVATION);
}

/** Ed25519 key ID the first 32 bytes of `material` would produce as a ledger seed. */
function seedKeyid(material: Uint8Array): string | null {
  if (material.length < 32) return null;
  try {
    const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(material.subarray(0, 32))]), format: 'der', type: 'pkcs8' });
    return effectSha256Digest(createPublicKey(key).export({ format: 'der', type: 'spki' }) as Buffer);
  } catch { return null; }
}

export interface LedgerReviewEffectJournalOptions {
  /** Defaults to the ledger's registry. It must register `decision.review.continuation`. */
  verifiers?: EffectVerifierRegistry;
  /** Verifier timeout in milliseconds. */
  timeoutMs?: number;
  /**
   * Review-store and session-index key material. Writes are refused when the
   * ledger signing key was derived from any of them: the ledger key is
   * independent of every other D13 key.
   */
  independentOf?: Uint8Array[];
}

interface ArchivedReceipt {
  schema: typeof ARCHIVE_SCHEMA;
  effectId: string;
  recordHash: string;
  receipt: ReviewEffectReceipt;
  evidence: EffectVerifierEvidence;
}

/**
 * `VerifiedReviewEffectLedger` backed by the effect ledger. Scope: the ledger's
 * `{tenant, project}` are the review's `{tenantId, projectId}`, subsystem `review`.
 */
export class LedgerReviewEffectJournal implements ReviewEffectJournal {
  private keysChecked = false;
  constructor(readonly ledger: EffectLedger, private readonly options: LedgerReviewEffectJournalOptions = {}) {
    if (ledger.scope.subsystem !== 'review') throw new Error('Review effect ledger must use the review subsystem');
  }

  private inScope(query: { tenantId: string; projectId: string }): boolean {
    return query.tenantId === this.ledger.scope.tenant && query.projectId === this.ledger.scope.project;
  }

  private async assertIndependentKey(): Promise<void> {
    if (this.keysChecked) return;
    const { keyid } = await this.ledger.signingKey();
    for (const material of this.options.independentOf ?? []) {
      if (seedKeyid(material) === keyid) throw new Error('Effect ledger key must be independent of review-store and session-index keys');
    }
    this.keysChecked = true;
  }

  private archivePath(effectId: string): { directory: string; file: string } {
    const directory = join(this.ledger.paths().root, 'receipts');
    return { directory, file: join(directory, `${sha256Hex(effectId)}.json`) };
  }

  /** The verified intent identity behind a lookup; throws on any mismatch. */
  private async intentIdentity(lookup: EffectLookup): Promise<ReviewEffectIdentity> {
    const intent = lookup.records.find(record => record.phase === 'intent');
    if (!intent) throw invalidEntry();
    const segment = await readWriterSegment(this.ledger.paths(), intent.writer);
    const decoded = segment?.lines[intent.seq]?.decoded;
    if (!decoded || decoded.line.recordHash !== intent.recordHash) throw invalidEntry();
    const predicate = decoded.statement.predicate;
    const context = predicate.context ?? {};
    const identity = {
      tenantId: this.ledger.scope.tenant, projectId: this.ledger.scope.project, reviewId: context.reviewId as string,
      continuationId: context.continuationId as string, proposalVersion: context.proposalVersion as number,
    };
    if (predicate.kind !== REVIEW_EFFECT_KIND || predicate.idDerivation !== REVIEW_EFFECT_DERIVATION
      || predicate.effectId !== lookup.effectId || reviewEffectId(identity) !== lookup.effectId) throw invalidEntry();
    return identity;
  }

  private async archived(effectId: string, completed: EffectRecordSummary, identity: ReviewEffectIdentity): Promise<ReviewEffectReceipt | null> {
    let raw: string;
    try { raw = await readFile(this.archivePath(effectId).file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    try {
      const value = JSON.parse(raw) as ArchivedReceipt;
      const receipt = value.receipt;
      if (value.schema !== ARCHIVE_SCHEMA || value.effectId !== effectId || value.recordHash !== completed.recordHash
        || evidenceDigest(value.evidence) !== completed.verification?.evidenceDigest
        || value.evidence.expectedDigest !== reviewDigest(receipt)
        || receipt.effectId !== effectId || receipt.continuationId !== identity.continuationId
        || receipt.proposalVersion !== identity.proposalVersion
        || !Number.isSafeInteger(receipt.completedAtEpochMs) || receipt.completedAtEpochMs < 0) throw invalidEntry();
      assertReviewProjection(receipt.result);
      return structuredClone(receipt);
    } catch { throw invalidEntry(); }
  }

  /** Receipt for a signed `completed` record; the archived body when present, else a digest reference. */
  async completedReceipt(query: ReviewEffectQuery): Promise<ReviewEffectReceipt | null> {
    if (!this.inScope(query) || !isValidEffectId(query.effectId, REVIEW_EFFECT_DERIVATION)) return null;
    const lookup = await lookupEffect(this.ledger, query.effectId);
    const completed = lookup.records.find(record => record.phase === 'completed');
    if (!completed) return null;
    const identity = await this.intentIdentity(lookup);
    if (identity.reviewId !== query.reviewId) return null;
    const body = await this.archived(query.effectId, completed, identity);
    if (body) return body;
    const completedAtEpochMs = Date.parse(completed.recordedAt);
    if (!Number.isSafeInteger(completedAtEpochMs)) throw invalidEntry();
    return {
      effectId: query.effectId, continuationId: identity.continuationId, proposalVersion: identity.proposalVersion, completedAtEpochMs,
      result: { effectLedger: { schema: REVIEW_EFFECT_REFERENCE_SCHEMA, recordHash: completed.recordHash, keyid: completed.keyid,
        evidenceDigest: completed.verification?.evidenceDigest ?? null } },
    };
  }

  /** Append the signed intent before the effect. `pending`: an earlier intent has no outcome yet. */
  async recordIntent(identity: ReviewEffectIdentity, actionDigest: string): Promise<'recorded' | 'pending'> {
    if (!this.inScope(identity)) throw new Error('Invalid executor ledger scope');
    await this.assertIndependentKey();
    const intent = reviewEffectIntent(identity);
    const receipt = await recordIntent(this.ledger, { ...intent, payloadDigest: actionDigest });
    if (receipt.effectId !== reviewDigest({ reviewId: identity.reviewId, continuationId: identity.continuationId,
      proposalVersion: identity.proposalVersion })) throw invalidEntry();
    return receipt.idempotent ? 'pending' : 'recorded';
  }

  /**
   * Reconcile through the kind verifier; every call appends one signed
   * `reconciled` record and `present` also records `completed`. With no intent
   * the effect is `unknown` unless the caller supplies the identity and action
   * digest, in which case the intent is recorded first (a crash before intent).
   */
  async reconcileReceipt(query: ReviewEffectQuery, options: ReviewEffectReconcileOptions = {}): Promise<ReviewEffectVerification> {
    const unknown: ReviewEffectVerification = { result: 'unknown', receipt: null };
    if (!this.inScope(query) || !isValidEffectId(query.effectId, REVIEW_EFFECT_DERIVATION)) return unknown;
    const lookup = await lookupEffect(this.ledger, query.effectId);
    if (!lookup.records.some(record => record.phase === 'intent')) {
      if (!options.identity || !options.actionDigest) return unknown;
      const identity = { tenantId: query.tenantId, projectId: query.projectId, reviewId: query.reviewId, ...options.identity };
      if (reviewEffectId(identity) !== query.effectId) return unknown;
      await this.recordIntent(identity, options.actionDigest);
    } else if ((await this.intentIdentity(lookup)).reviewId !== query.reviewId) return unknown;
    await this.assertIndependentKey();
    const expectedDigest = options.receipt ? reviewDigest(options.receipt) : undefined;
    const outcome = await reconcileEffect(this.ledger, query.effectId, {
      verifiers: this.options.verifiers, timeoutMs: this.options.timeoutMs, expected: expectedDigest ? { digest: expectedDigest } : {},
    });
    const result = outcome.result.verification.result;
    if (result !== 'present') return { result, receipt: null };
    if (options.receipt && outcome.completed && !outcome.completed.idempotent && outcome.evidence) {
      assertReviewProjection(options.receipt.result);
      const { directory, file } = this.archivePath(query.effectId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const archived: ArchivedReceipt = { schema: ARCHIVE_SCHEMA, effectId: query.effectId, recordHash: outcome.completed.recordHash,
        receipt: structuredClone(options.receipt), evidence: outcome.evidence };
      await publishExclusive(directory, file, `${canonicalJson(archived)}\n`, 'receipt');
    }
    const receipt = await this.completedReceipt(query);
    return receipt ? { result: 'present', receipt } : unknown;
  }

  /** Called by the executor after the effect: verify, then record `completed` only on `present`. */
  async recordCompleted(query: ReviewEffectQuery, receipt: ReviewEffectReceipt): Promise<boolean> {
    if (receipt.effectId !== query.effectId) throw new Error('Invalid executor completion receipt');
    assertReviewProjection(receipt.result);
    return (await this.reconcileReceipt(query, { receipt })).result === 'present';
  }

  /**
   * Import receipts from the deprecated HMAC journal as `completed` records.
   * Each is verified by a one-shot `legacy-hmac` verifier over the legacy
   * journal (evidence `method: legacy-hmac`), and its body is archived so the
   * same receipt is returned afterwards. Receipts already completed are skipped.
   */
  async importLegacyReceipts(legacy: FileVerifiedReviewEffectLedger): Promise<{ imported: number; skipped: number }> {
    let imported = 0; let skipped = 0;
    for (const { query, receipt } of await legacy.listReceipts()) {
      if (!this.inScope(query) || await this.completedReceipt(query)) { skipped += 1; continue; }
      const identity = { tenantId: query.tenantId, projectId: query.projectId, reviewId: query.reviewId,
        continuationId: receipt.continuationId, proposalVersion: receipt.proposalVersion };
      if (reviewEffectId(identity) !== query.effectId) { skipped += 1; continue; }
      await this.recordIntent(identity, reviewDigest({ legacyReceipt: reviewDigest(receipt) }));
      const importer = new LedgerReviewEffectJournal(this.ledger, {
        ...this.options, verifiers: createVerifierRegistry([legacyHmacImportVerifier(legacy)]),
      });
      const settled = await importer.reconcileReceipt(query, { receipt });
      if (settled.result === 'present') imported += 1; else skipped += 1;
    }
    return { imported, skipped };
  }
}

/** One-shot importer verifier: `present` only when the legacy HMAC journal holds the exact expected receipt. */
function legacyHmacImportVerifier(legacy: FileVerifiedReviewEffectLedger): EffectVerifier {
  return {
    kind: REVIEW_EFFECT_KIND, version: LEGACY_HMAC_IMPORT_VERIFIER_VERSION, canReportAbsent: false,
    async verify(request) {
      const { reviewId } = request.context;
      const expected = request.expected.digest ?? null;
      const found = await legacy.completedReceipt({ tenantId: request.scope.tenant, projectId: request.scope.project,
        reviewId: String(reviewId), effectId: request.effectId }).catch(() => null);
      const actual = found ? reviewDigest(found) : null;
      const evidence = { source: 'd13-legacy-journal', method: 'legacy-hmac', expectedDigest: expected, receiptDigest: actual };
      return actual && actual === expected
        ? { result: 'present', reason: 'digest-match', complete: true, evidence }
        : { result: 'unknown', reason: 'evidence-conflict', complete: false, evidence };
    },
  };
}

/** Factory form of the ledger-backed `VerifiedReviewEffectLedger`. */
export function ledgerVerifiedReviewEffectLedger(ledger: EffectLedger, options: LedgerReviewEffectJournalOptions = {}): LedgerReviewEffectJournal {
  return new LedgerReviewEffectJournal(ledger, options);
}

export interface OpenReviewEffectLedgerOptions {
  projectDir: string;
  tenantId: string;
  projectId: string;
  /** This process's segment writer ID. */
  writer: string;
  /** The dedicated ledger key (`credentialStoreKeyProvider` in production). */
  keyProvider: LedgerKeyProvider;
  /** The D13 review store the verifier reads. */
  store: Pick<ReviewStore, 'read'>;
  /** Host probe for the effect at its own target; see `reviewContinuationVerifier`. */
  execution?: ReviewContinuationVerifierOptions['execution'];
  /** Review-store and session-index key material the ledger key must differ from. */
  independentOf?: Uint8Array[];
  /** Further verifiers (tracker kinds, `x.<vendor>.<name>`). */
  extensions?: EffectVerifier[];
  sink?: CheckpointSink;
  clock?: () => number;
  timeoutMs?: number;
}

/** Production wiring: a `review` ledger with the built-in verifiers and the review-store verifier. */
export function openReviewEffectLedger(options: OpenReviewEffectLedgerOptions): LedgerReviewEffectJournal {
  const verifiers = createBuiltinVerifierRegistry({ review: { store: options.store, execution: options.execution } }, options.extensions ?? []);
  const ledger = new EffectLedger({
    projectDir: options.projectDir, scope: { tenant: options.tenantId, project: options.projectId, subsystem: 'review' },
    writer: options.writer, keyProvider: options.keyProvider, verifiers, sink: options.sink, clock: options.clock,
  });
  return new LedgerReviewEffectJournal(ledger, { verifiers, independentOf: options.independentOf, timeoutMs: options.timeoutMs });
}

/**
 * Production `reconcile(effectId)` for `DecisionReviewService.resume`. It
 * returns a receipt only for a signed `completed` record or a `present`
 * verifier result under the exact D13 identity; `absent` and `unknown` return
 * `null`, so the stale continuation stays uncertain and is never replayed.
 */
export function ledgerReviewReconciler(input: {
  journal: Pick<ReviewEffectJournal, 'completedReceipt' | 'reconcileReceipt'>;
  scope: { tenantId: string; projectId: string };
  reviewId: string;
  continuationId: string;
  proposalVersion: number;
  /** `proposal.actionDigest`; lets a crash before the intent record it late and still reconcile. */
  actionDigest?: string;
}): (effectId: string) => Promise<ReviewEffectReceipt | null> {
  return async effectId => {
    if (effectId !== reviewDigest({ reviewId: input.reviewId, continuationId: input.continuationId, proposalVersion: input.proposalVersion })) return null;
    const query = { tenantId: input.scope.tenantId, projectId: input.scope.projectId, reviewId: input.reviewId, effectId };
    const known = await input.journal.completedReceipt(query);
    if (known) return known.effectId === effectId ? known : null;
    if (!input.journal.reconcileReceipt) return null;
    const settled = await input.journal.reconcileReceipt(query, {
      identity: { continuationId: input.continuationId, proposalVersion: input.proposalVersion }, actionDigest: input.actionDigest,
    });
    return settled.result === 'present' && settled.receipt?.effectId === effectId ? settled.receipt : null;
  };
}
