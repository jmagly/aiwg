import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../../security/artifact-trust.js';
import type { DecisionReview, ReviewPurgeReceipt, ReviewStore } from './types.js';
import { assertImmutable, ReviewIntegrityError, validateReview } from './validate.js';

/**
 * Revisions live in one directory per (tenant, project) scope, named by a keyed
 * digest, so reading or listing a scope never opens another scope's files.
 */
export class FileDecisionReviewStore implements ReviewStore {
  constructor(private readonly directory: string, private readonly integrityKey: Uint8Array,
    private readonly options: { fault?: (boundary: 'review-before-publication' | 'review-after-publication' | 'purge-marker-published') => void } = {}) {
    if (integrityKey.length < 32) throw new Error('Review integrity key must be at least 32 bytes');
  }
  private prefix(id: string) { return createHash('sha256').update(id).digest('hex'); }
  /** Keyed so a directory name cannot be confirmed from guessed tenant or project names. */
  scopeDirectory(tenantId: string, projectId: string): string {
    return join(this.directory, createHmac('sha256', this.integrityKey)
      .update(`decision-review-scope/v1\0${canonicalJson([tenantId, projectId])}`).digest('hex'));
  }
  private path(scope: string, id: string, revision: number) { return join(scope, `${this.prefix(id)}.r${revision}.json`); }
  private markerPath(scope: string, id: string) { return join(scope, `${this.prefix(id)}.purged.json`); }
  private mac(value: unknown) { return createHmac('sha256', this.integrityKey).update(canonicalJson(value)).digest('hex'); }
  private async names(scope: string): Promise<string[]> {
    try { return (await readdir(scope)).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  private async marker(scope: string, idDigest: string): Promise<ReviewPurgeReceipt | null> {
    let raw: string;
    try { raw = await readFile(join(scope, `${idDigest}.purged.json`), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    try {
      const envelope = JSON.parse(raw) as { receipt: ReviewPurgeReceipt; mac: string };
      const expected = Buffer.from(this.mac(envelope.receipt), 'hex');
      const actual = Buffer.from(envelope.mac ?? '', 'hex');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected) ||
        envelope.receipt.reviewIdDigest !== `sha256:${idDigest}` ||
        !Number.isSafeInteger(envelope.receipt.lastRevision) || envelope.receipt.lastRevision < 1) throw new Error();
      return envelope.receipt;
    } catch { throw new ReviewIntegrityError('Review purge marker integrity check failed'); }
  }

  async read(reviewId: string, tenantId: string, projectId: string): Promise<DecisionReview | null> {
    const scope = this.scopeDirectory(tenantId, projectId);
    const review = await this.readChain(scope, this.prefix(reviewId), await this.names(scope));
    if (review && review.reviewId !== reviewId) throw new ReviewIntegrityError('Review revision identity mismatch');
    return review && review.tenantId === tenantId && review.projectId === projectId ? review : null;
  }

  /** Verify one review's revision chain using names already listed from its scope directory. */
  private async readChain(scope: string, idDigest: string, names: string[]): Promise<DecisionReview | null> {
    if (await this.marker(scope, idDigest)) return null;
    const prefix = `${idDigest}.r`;
    const revisions = names.filter(name => name.startsWith(prefix) && name.endsWith('.json')).map(name => Number(name.slice(prefix.length, -5))).sort((a, b) => a - b);
    if (!revisions.length) return null;
    let previous: DecisionReview | null = null;
    for (let i = 0; i < revisions.length; i += 1) {
      if (revisions[i] !== i + 1) throw new ReviewIntegrityError('Review revision gap');
      const envelope = JSON.parse(await readFile(join(scope, `${prefix}${revisions[i]}.json`), 'utf8')) as { review: DecisionReview; mac: string };
      const expected = Buffer.from(this.mac(envelope.review), 'hex');
      const actual = Buffer.from(envelope.mac ?? '', 'hex');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new ReviewIntegrityError('Review integrity check failed');
      validateReview(envelope.review);
      if (envelope.review.revision !== revisions[i] || this.prefix(envelope.review.reviewId) !== idDigest) throw new ReviewIntegrityError('Review revision identity mismatch');
      if (previous) assertImmutable(previous, envelope.review);
      previous = envelope.review;
    }
    return structuredClone(previous!);
  }

  async create(review: DecisionReview): Promise<boolean> {
    validateReview(review);
    if (await this.marker(this.scopeDirectory(review.tenantId, review.projectId), this.prefix(review.reviewId))) return false;
    return this.publish(review);
  }
  async list(tenantId: string, projectId: string): Promise<DecisionReview[]> {
    // Enumerate and open only this scope's directory, in sorted digest order.
    const scope = this.scopeDirectory(tenantId, projectId);
    const names = await this.names(scope);
    const digests = [...new Set(names.flatMap(name => /^([0-9a-f]{64})\.r\d+\.json$/.exec(name)?.[1] ?? []))];
    const reviews: DecisionReview[] = [];
    for (const digest of digests) {
      const review = await this.readChain(scope, digest, names);
      if (review && review.tenantId === tenantId && review.projectId === projectId) reviews.push(review);
    }
    return reviews.sort((a, b) => a.reviewId.localeCompare(b.reviewId));
  }
  async compareAndSwap(reviewId: string, tenantId: string, projectId: string, expectedRevision: number, next: DecisionReview): Promise<boolean> {
    const current = await this.read(reviewId, tenantId, projectId);
    if (!current) throw new ReviewIntegrityError('Missing review');
    if (current.revision !== expectedRevision) return false;
    assertImmutable(current, next);
    return this.publish(next);
  }
  async purgeTombstoned(reviewId: string, tenantId: string, projectId: string): Promise<ReviewPurgeReceipt> {
    const scope = this.scopeDirectory(tenantId, projectId);
    let receipt = await this.marker(scope, this.prefix(reviewId));
    if (!receipt) {
      const review = await this.read(reviewId, tenantId, projectId);
      if (!review || review.status !== 'tombstoned' || review.lifecycle?.legalHold) throw new ReviewIntegrityError('Review purge requires an unheld tombstone');
      receipt = {
        reviewIdDigest: `sha256:${this.prefix(reviewId)}`, tenantDigest: `sha256:${this.prefix(tenantId)}`,
        projectDigest: `sha256:${this.prefix(projectId)}`, lastRevision: review.revision,
        finalReviewMac: this.mac(review),
      };
      const destination = this.markerPath(scope, reviewId);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(`${JSON.stringify({ receipt, mac: this.mac(receipt) })}\n`); await file.sync(); }
      finally { await file.close(); }
      try {
        await link(temporary, destination);
        const dir = await open(scope, 'r'); try { await dir.sync(); } finally { await dir.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        receipt = (await this.marker(scope, this.prefix(reviewId)))!;
      } finally { await rm(temporary, { force: true }); }
    }
    if (receipt.tenantDigest !== `sha256:${this.prefix(tenantId)}` || receipt.projectDigest !== `sha256:${this.prefix(projectId)}`) {
      throw new ReviewIntegrityError('Review purge scope mismatch');
    }
    this.options.fault?.('purge-marker-published');
    const names = await this.names(scope);
    for (const name of names.filter(item => new RegExp(`^${this.prefix(reviewId)}\\.r[0-9]+\\.json$`).test(item))) {
      await rm(join(scope, name));
    }
    const dir = await open(scope, 'r'); try { await dir.sync(); } finally { await dir.close(); }
    return receipt;
  }

  private async publish(review: DecisionReview): Promise<boolean> {
    const scope = this.scopeDirectory(review.tenantId, review.projectId);
    await mkdir(scope, { recursive: true, mode: 0o700 });
    const destination = this.path(scope, review.reviewId, review.revision);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify({ review, mac: this.mac(review) })}\n`); await file.sync(); } finally { await file.close(); }
    try {
      this.options.fault?.('review-before-publication');
      await link(temporary, destination);
      const dir = await open(scope, 'r'); try { await dir.sync(); } finally { await dir.close(); }
      this.options.fault?.('review-after-publication');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
