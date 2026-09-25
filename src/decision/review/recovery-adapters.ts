import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { link, mkdir, open, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../../security/artifact-trust.js';
import type { SessionRepository } from '../../sessions/repository.js';
import { importDiscoveryManifest } from '../../sessions/batch-import.js';
import type { SessionDiscoveryManifest } from '../../sessions/workspace-discovery.js';
import type { SessionEvent } from '../../sessions/contracts.js';
import type { ReviewEffectReceipt } from './types.js';
import type {
  ReviewEffectQuery, ReviewEffectReconcileOptions, ReviewEffectVerification, ReviewSessionAudit, VerifiedReviewEffectLedger,
} from './recovery.js';
import { assertReviewProjection, ReviewConflictError, reviewDigest } from './validate.js';

/** Caller supplies an authorized, exact-workspace refresh; never discovers provider roots implicitly. */
export class WorkspaceReviewSessionAudit implements ReviewSessionAudit {
  private covered = new Set<string>();
  constructor(private readonly repository: SessionRepository,
    private readonly refresh: (workspaceId: string, previousSessionId: string) => Promise<void>,
    private readonly locate: (event: SessionEvent) => { reviewId: string; effectId: string } | null) {}

  private exactCoverage(workspaceId: string, previousSessionId: string): 'covered' | 'partial' | 'stale' | 'unavailable' {
    const coverage = this.repository.getCoverage(workspaceId);
    if (coverage.status === 'stale') return 'stale';
    const session = this.repository.getSession(previousSessionId, workspaceId);
    if (!session) return 'unavailable';
    if (!coverage.manifestId || session.consistency === 'provisional') return 'partial';
    const run = this.repository.getBatchImportRunForManifest(coverage.manifestId, workspaceId);
    const source = run?.sources.find(item => item.sourceId === session.sourceId && item.provider === session.provider);
    // Other providers may legitimately require a separate export. Global
    // workspace coverage can be partial while this exact committed source is
    // covered. No session from an uncommitted/rejected source is accepted.
    return source && ['committed', 'previously-committed', 'duplicate'].includes(source.status) &&
      ['complete', 'partial'].includes(run!.status) ? 'covered' : 'partial';
  }

  async hydrate(workspaceId: string, previousSessionId: string) {
    this.covered.delete(`${workspaceId}\0${previousSessionId}`);
    await this.refresh(workspaceId, previousSessionId);
    const status = this.exactCoverage(workspaceId, previousSessionId);
    if (status === 'covered') this.covered.add(`${workspaceId}\0${previousSessionId}`);
    return { workspaceId, previousSessionId, coverage: status };
  }

  async findAttempt(query: { workspaceId: string; previousSessionId: string; reviewId: string; effectId: string }) {
    if (!this.covered.has(`${query.workspaceId}\0${query.previousSessionId}`) ||
        this.exactCoverage(query.workspaceId, query.previousSessionId) !== 'covered') return null;
    const matches = this.repository.listEvents(query.previousSessionId, query.workspaceId)
      .filter(event => {
        if (event.origin !== 'tool-control' || event.consistency !== 'complete') return false;
        const marker = this.locate(event);
        return marker?.reviewId === query.reviewId && marker.effectId === query.effectId;
      });
    // An ambiguous marker never attests a specific attempt. Transcript text is
    // not a completion receipt; the independent executor ledger is mandatory.
    return matches.length === 1 ? { workspaceId: query.workspaceId, sessionId: query.previousSessionId,
      reviewId: query.reviewId, effectId: query.effectId } : null;
  }
}

/** Import only a previously reviewed manifest after fresh workspace/session authorization. */
export function authorizedReviewCatalogRefresh(input: {
  repository: SessionRepository;
  manifest: SessionDiscoveryManifest;
  authorize: (workspaceId: string, previousSessionId: string, manifest: SessionDiscoveryManifest) => boolean | Promise<boolean>;
}) {
  return async (workspaceId: string, previousSessionId: string): Promise<void> => {
    if (workspaceId !== input.manifest.workspaceId || !previousSessionId ||
        !await input.authorize(workspaceId, previousSessionId, input.manifest)) {
      throw new Error('Review catalog refresh denied');
    }
    await importDiscoveryManifest({ manifest: input.manifest, repository: input.repository });
  };
}

/** The D13 effect identity: `reviewDigest({reviewId, continuationId, proposalVersion})` within a tenant and project. */
export interface ReviewEffectIdentity {
  tenantId: string;
  projectId: string;
  reviewId: string;
  continuationId: string;
  proposalVersion: number;
}

/**
 * Executor-side journal port for `journaledReviewExecutor`. The effect-ledger
 * adapter (`LedgerReviewEffectJournal`) implements every member; the deprecated
 * HMAC journal implements only the read and post-execution members.
 */
export interface ReviewEffectJournal extends VerifiedReviewEffectLedger {
  /** Record completion after the effect. The ledger adapter records `completed` only on a `present` verification. */
  recordCompleted(query: ReviewEffectQuery, receipt: ReviewEffectReceipt): Promise<boolean>;
  /** Append a signed intent before the effect. `pending`: an earlier intent has no outcome. */
  recordIntent?(identity: ReviewEffectIdentity, actionDigest: string): Promise<'recorded' | 'pending'>;
  /** Reconcile through the kind verifier without replaying the effect. */
  reconcileReceipt?(query: ReviewEffectQuery, options?: ReviewEffectReconcileOptions): Promise<ReviewEffectVerification>;
}

/**
 * Wrap the effectful executor so the journal records an `intent` BEFORE the
 * effect and a verified `completed` after it.
 *
 * - A known completed receipt is returned without re-executing.
 * - An earlier intent without an outcome (a stale lease) is reconciled through
 *   the kind verifier: `present` returns the recovered result; `absent` stays
 *   uncertain unless the target is declared idempotent on the effect ID;
 *   `unknown` never replays. Both refusals leave the review in `resuming`.
 * - A journal without `recordIntent` (the deprecated HMAC journal) keeps its
 *   post-execution journaling only.
 */
export function journaledReviewExecutor(input: {
  ledger: ReviewEffectJournal;
  scope: { tenantId: string; projectId: string };
  reviewId: string;
  continuationId: string;
  proposalVersion: number;
  now: () => number;
  executeEffect: (effectId: string, action: unknown) => Promise<unknown>;
  /**
   * The target deduplicates on the effect ID (for example an idempotency key),
   * so a complete `absent` may be replayed under the same ID. Off by default.
   */
  idempotentTarget?: boolean;
}) {
  return async (effectId: string, action: unknown): Promise<unknown> => {
    if (effectId !== reviewDigest({ reviewId: input.reviewId, continuationId: input.continuationId,
      proposalVersion: input.proposalVersion })) throw new Error('Executor effect identity mismatch');
    const query = { tenantId: input.scope.tenantId, projectId: input.scope.projectId, reviewId: input.reviewId, effectId };
    const known = (receipt: ReviewEffectReceipt) => {
      if (receipt.continuationId !== input.continuationId || receipt.proposalVersion !== input.proposalVersion) {
        throw new Error('Executor receipt identity mismatch');
      }
      return receipt.result;
    };
    const existing = await input.ledger.completedReceipt(query);
    if (existing) return known(existing);
    if (input.ledger.recordIntent) {
      const identity = { tenantId: query.tenantId, projectId: query.projectId, reviewId: input.reviewId,
        continuationId: input.continuationId, proposalVersion: input.proposalVersion };
      const state = await input.ledger.recordIntent(identity, reviewDigest(action));
      if (state === 'pending') {
        const settled: ReviewEffectVerification = input.ledger.reconcileReceipt
          ? await input.ledger.reconcileReceipt(query, { identity: { continuationId: input.continuationId, proposalVersion: input.proposalVersion } })
          : { result: 'unknown', receipt: null };
        if (settled.result === 'present' && settled.receipt) return known(settled.receipt);
        if (settled.result !== 'absent' || !input.idempotentTarget) {
          throw new ReviewConflictError(settled.result === 'absent' ? 'Effect outcome remains uncertain' : 'Effect outcome remains unknown');
        }
      }
    }
    const result = await input.executeEffect(effectId, structuredClone(action));
    await input.ledger.recordCompleted(query, { effectId, continuationId: input.continuationId,
      proposalVersion: input.proposalVersion, completedAtEpochMs: input.now(), result });
    return result;
  };
}

/**
 * HMAC-only executor receipt journal.
 *
 * @deprecated Compatibility shim. Use the effect-ledger adapter
 * (`LedgerReviewEffectJournal` / `openReviewEffectLedger`), which records a
 * signed intent before the effect. Migrate existing receipts with
 * `LedgerReviewEffectJournal.importLegacyReceipts`; see docs/decision/review.md.
 * Keep its key separate from review-store and session-index keys.
 */
export class FileVerifiedReviewEffectLedger implements ReviewEffectJournal {
  constructor(private readonly directory: string, private readonly integrityKey: Uint8Array,
    options: { independentOf?: Uint8Array[] } = {}) {
    if (integrityKey.length < 32) throw new Error('Executor ledger integrity key must be at least 32 bytes');
    for (const other of options.independentOf ?? []) {
      if (other.length === integrityKey.length && timingSafeEqual(Buffer.from(other), Buffer.from(integrityKey))) {
        throw new Error('Executor ledger key must be independent of review-store and session-index keys');
      }
    }
  }
  private scope(query: { tenantId: string; projectId: string; reviewId: string; effectId: string }) {
    const { tenantId, projectId, reviewId, effectId } = query;
    if (![tenantId, projectId, reviewId, effectId].every(value => typeof value === 'string' && value.length > 0)) throw new Error('Invalid executor ledger scope');
    return { tenantId, projectId, reviewId, effectId };
  }
  private path(query: { tenantId: string; projectId: string; reviewId: string; effectId: string }) {
    const digest = createHash('sha256').update(canonicalJson(this.scope(query))).digest('hex');
    return join(this.directory, `${digest}.json`);
  }
  private mac(record: unknown) { return createHmac('sha256', this.integrityKey).update(canonicalJson(record)).digest('hex'); }

  /** Only the effectful executor calls this after independently verifying completion. */
  async recordCompleted(query: { tenantId: string; projectId: string; reviewId: string; effectId: string }, receipt: ReviewEffectReceipt): Promise<boolean> {
    if (receipt.effectId !== query.effectId || !receipt.continuationId || !Number.isSafeInteger(receipt.proposalVersion) || receipt.proposalVersion < 1 ||
        !Number.isSafeInteger(receipt.completedAtEpochMs) || receipt.completedAtEpochMs < 0) throw new Error('Invalid executor completion receipt');
    assertReviewProjection(receipt.result);
    const record = { query: this.scope(query), receipt };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.path(query);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify({ record, mac: this.mac(record) })}\n`); await file.sync(); } finally { await file.close(); }
    try {
      await link(temporary, destination);
      const dir = await open(this.directory, 'r'); try { await dir.sync(); } finally { await dir.close(); }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const existing = await this.completedReceipt(query);
        if (existing && canonicalJson(existing) === canonicalJson(receipt)) return false;
        throw new Error('Conflicting executor completion receipt');
      }
      throw error;
    } finally { await rm(temporary, { force: true }); }
  }

  async completedReceipt(query: { tenantId: string; projectId: string; reviewId: string; effectId: string }): Promise<ReviewEffectReceipt | null> {
    let raw: string;
    try { raw = await readFile(this.path(query), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    return this.verifyEntry(raw, query);
  }

  /** Every verified receipt in the journal, for migration to the effect ledger. Any invalid entry fails the listing. */
  async listReceipts(): Promise<Array<{ query: ReviewEffectQuery; receipt: ReviewEffectReceipt }>> {
    let names: string[];
    try { names = (await readdir(this.directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const out: Array<{ query: ReviewEffectQuery; receipt: ReviewEffectReceipt }> = [];
    for (const name of names) {
      const raw = await readFile(join(this.directory, name), 'utf8');
      let query: ReviewEffectQuery;
      try { query = this.scope((JSON.parse(raw) as { record: { query: ReviewEffectQuery } }).record.query); }
      catch { throw new Error('Invalid executor ledger entry'); }
      if (this.path(query) !== join(this.directory, name)) throw new Error('Invalid executor ledger entry');
      out.push({ query, receipt: this.verifyEntry(raw, query) });
    }
    return out;
  }

  private verifyEntry(raw: string, query: ReviewEffectQuery): ReviewEffectReceipt {
    try {
      const envelope = JSON.parse(raw) as { record: { query: typeof query; receipt: ReviewEffectReceipt }; mac: string };
      const expected = Buffer.from(this.mac(envelope.record), 'hex');
      const actual = Buffer.from(envelope.mac ?? '', 'hex');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected) ||
          canonicalJson(envelope.record.query) !== canonicalJson(this.scope(query)) || envelope.record.receipt.effectId !== query.effectId ||
          !envelope.record.receipt.continuationId || !Number.isSafeInteger(envelope.record.receipt.proposalVersion) ||
          envelope.record.receipt.proposalVersion < 1 || !Number.isSafeInteger(envelope.record.receipt.completedAtEpochMs) ||
          envelope.record.receipt.completedAtEpochMs < 0) throw new Error('Invalid executor ledger entry');
      assertReviewProjection(envelope.record.receipt.result);
      return structuredClone(envelope.record.receipt);
    } catch { throw new Error('Invalid executor ledger entry'); }
  }
}
