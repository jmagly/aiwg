import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { link, mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../../security/artifact-trust.js';
import type { SessionRepository } from '../../sessions/repository.js';
import { importDiscoveryManifest } from '../../sessions/batch-import.js';
import type { SessionDiscoveryManifest } from '../../sessions/workspace-discovery.js';
import type { SessionEvent } from '../../sessions/contracts.js';
import type { ReviewEffectReceipt } from './types.js';
import type { ReviewSessionAudit, VerifiedReviewEffectLedger } from './recovery.js';
import { assertReviewProjection, reviewDigest } from './validate.js';

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

/**
 * Persist an executor-attested completion before returning to the review service.
 * The external executor still owns idempotence for a crash before journal write;
 * this wrapper never interprets absence from the journal as permission to replay
 * a stale review continuation.
 */
export function journaledReviewExecutor(input: {
  ledger: FileVerifiedReviewEffectLedger;
  scope: { tenantId: string; projectId: string };
  reviewId: string;
  continuationId: string;
  proposalVersion: number;
  now: () => number;
  executeEffect: (effectId: string, action: unknown) => Promise<unknown>;
}) {
  return async (effectId: string, action: unknown): Promise<unknown> => {
    if (effectId !== reviewDigest({ reviewId: input.reviewId, continuationId: input.continuationId,
      proposalVersion: input.proposalVersion })) throw new Error('Executor effect identity mismatch');
    const query = { tenantId: input.scope.tenantId, projectId: input.scope.projectId, reviewId: input.reviewId, effectId };
    const existing = await input.ledger.completedReceipt(query);
    if (existing) {
      if (existing.continuationId !== input.continuationId || existing.proposalVersion !== input.proposalVersion) {
        throw new Error('Executor receipt identity mismatch');
      }
      return existing.result;
    }
    const result = await input.executeEffect(effectId, structuredClone(action));
    await input.ledger.recordCompleted(query, { effectId, continuationId: input.continuationId,
      proposalVersion: input.proposalVersion, completedAtEpochMs: input.now(), result });
    return result;
  };
}

/** Executor-owned receipt journal. Keep its key separate from review-store and session-index keys. */
export class FileVerifiedReviewEffectLedger implements VerifiedReviewEffectLedger {
  constructor(private readonly directory: string, private readonly integrityKey: Uint8Array) {
    if (integrityKey.length < 32) throw new Error('Executor ledger integrity key must be at least 32 bytes');
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
