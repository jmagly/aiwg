import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../../security/artifact-trust.js';
import type { DecisionReview, ReviewPurgeReceipt, ReviewStore } from './types.js';
import { assertImmutable, ReviewIntegrityError, validateReview } from './validate.js';

export class FileDecisionReviewStore implements ReviewStore {
  constructor(private readonly directory: string, private readonly integrityKey: Uint8Array,
    private readonly options: { fault?: (boundary: 'purge-marker-published') => void } = {}) {
    if (integrityKey.length < 32) throw new Error('Review integrity key must be at least 32 bytes');
  }
  private prefix(id: string) { return createHash('sha256').update(id).digest('hex'); }
  private path(id: string, revision: number) { return join(this.directory, `${this.prefix(id)}.r${revision}.json`); }
  private markerPath(id: string) { return join(this.directory, `${this.prefix(id)}.purged.json`); }
  private mac(value: unknown) { return createHmac('sha256', this.integrityKey).update(canonicalJson(value)).digest('hex'); }
  private async marker(id: string): Promise<ReviewPurgeReceipt | null> {
    let raw: string;
    try { raw = await readFile(this.markerPath(id), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    try {
      const envelope = JSON.parse(raw) as { receipt: ReviewPurgeReceipt; mac: string };
      const expected = Buffer.from(this.mac(envelope.receipt), 'hex');
      const actual = Buffer.from(envelope.mac ?? '', 'hex');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected) ||
        envelope.receipt.reviewIdDigest !== `sha256:${this.prefix(id)}` ||
        !Number.isSafeInteger(envelope.receipt.lastRevision) || envelope.receipt.lastRevision < 1) throw new Error();
      return envelope.receipt;
    } catch { throw new ReviewIntegrityError('Review purge marker integrity check failed'); }
  }

  async read(reviewId: string, tenantId: string, projectId: string): Promise<DecisionReview | null> {
    if (await this.marker(reviewId)) return null;
    let names: string[];
    try { names = await readdir(this.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const prefix = `${this.prefix(reviewId)}.r`;
    const revisions = names.filter(name => name.startsWith(prefix) && name.endsWith('.json')).map(name => Number(name.slice(prefix.length, -5))).sort((a, b) => a - b);
    if (!revisions.length) return null;
    let previous: DecisionReview | null = null;
    for (let i = 0; i < revisions.length; i += 1) {
      if (revisions[i] !== i + 1) throw new ReviewIntegrityError('Review revision gap');
      const envelope = JSON.parse(await readFile(this.path(reviewId, revisions[i]!), 'utf8')) as { review: DecisionReview; mac: string };
      const expected = Buffer.from(this.mac(envelope.review), 'hex');
      const actual = Buffer.from(envelope.mac ?? '', 'hex');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new ReviewIntegrityError('Review integrity check failed');
      validateReview(envelope.review);
      if (envelope.review.revision !== revisions[i] || envelope.review.reviewId !== reviewId) throw new ReviewIntegrityError('Review revision identity mismatch');
      if (previous) assertImmutable(previous, envelope.review);
      previous = envelope.review;
    }
    if (previous!.tenantId !== tenantId || previous!.projectId !== projectId) return null;
    return structuredClone(previous!);
  }

  async create(review: DecisionReview): Promise<boolean> {
    validateReview(review);
    if (await this.marker(review.reviewId)) return false;
    return this.publish(review);
  }
  async list(tenantId: string, projectId: string): Promise<DecisionReview[]> {
    let names: string[];
    try { names = await readdir(this.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const ids = new Set<string>();
    for (const name of names.filter(candidate => /\.r\d+\.json$/.test(candidate))) {
      const envelope = JSON.parse(await readFile(join(this.directory, name), 'utf8')) as { review?: DecisionReview };
      if (envelope.review?.reviewId) ids.add(envelope.review.reviewId);
    }
    const reviews = await Promise.all([...ids].map(id => this.read(id, tenantId, projectId)));
    return reviews.filter((review): review is DecisionReview => review !== null).sort((a, b) => a.reviewId.localeCompare(b.reviewId));
  }
  async compareAndSwap(reviewId: string, tenantId: string, projectId: string, expectedRevision: number, next: DecisionReview): Promise<boolean> {
    const current = await this.read(reviewId, tenantId, projectId);
    if (!current) throw new ReviewIntegrityError('Missing review');
    if (current.revision !== expectedRevision) return false;
    assertImmutable(current, next);
    return this.publish(next);
  }
  async purgeTombstoned(reviewId: string, tenantId: string, projectId: string): Promise<ReviewPurgeReceipt> {
    let receipt = await this.marker(reviewId);
    if (!receipt) {
      const review = await this.read(reviewId, tenantId, projectId);
      if (!review || review.status !== 'tombstoned' || review.lifecycle?.legalHold) throw new ReviewIntegrityError('Review purge requires an unheld tombstone');
      receipt = {
        reviewIdDigest: `sha256:${this.prefix(reviewId)}`, tenantDigest: `sha256:${this.prefix(tenantId)}`,
        projectDigest: `sha256:${this.prefix(projectId)}`, lastRevision: review.revision,
        finalReviewMac: this.mac(review),
      };
      const destination = this.markerPath(reviewId);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(`${JSON.stringify({ receipt, mac: this.mac(receipt) })}\n`); await file.sync(); }
      finally { await file.close(); }
      try {
        await link(temporary, destination);
        const dir = await open(this.directory, 'r'); try { await dir.sync(); } finally { await dir.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        receipt = (await this.marker(reviewId))!;
      } finally { await rm(temporary, { force: true }); }
    }
    if (receipt.tenantDigest !== `sha256:${this.prefix(tenantId)}` || receipt.projectDigest !== `sha256:${this.prefix(projectId)}`) {
      throw new ReviewIntegrityError('Review purge scope mismatch');
    }
    this.options.fault?.('purge-marker-published');
    const names = await readdir(this.directory);
    for (const name of names.filter(item => new RegExp(`^${this.prefix(reviewId)}\\.r[0-9]+\\.json$`).test(item))) {
      await rm(join(this.directory, name));
    }
    const dir = await open(this.directory, 'r'); try { await dir.sync(); } finally { await dir.close(); }
    return receipt;
  }

  private async publish(review: DecisionReview): Promise<boolean> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.path(review.reviewId, review.revision);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify({ review, mac: this.mac(review) })}\n`); await file.sync(); } finally { await file.close(); }
    try {
      await link(temporary, destination);
      const dir = await open(this.directory, 'r'); try { await dir.sync(); } finally { await dir.close(); }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
