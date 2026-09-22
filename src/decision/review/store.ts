import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../../security/artifact-trust.js';
import type { DecisionReview, ReviewStore } from './types.js';
import { assertImmutable, ReviewIntegrityError, validateReview } from './validate.js';

export class FileDecisionReviewStore implements ReviewStore {
  constructor(private readonly directory: string, private readonly integrityKey: Uint8Array) {
    if (integrityKey.length < 32) throw new Error('Review integrity key must be at least 32 bytes');
  }
  private prefix(id: string) { return createHash('sha256').update(id).digest('hex'); }
  private path(id: string, revision: number) { return join(this.directory, `${this.prefix(id)}.r${revision}.json`); }
  private mac(review: DecisionReview) { return createHmac('sha256', this.integrityKey).update(canonicalJson(review)).digest('hex'); }

  async read(reviewId: string, tenantId: string, projectId: string): Promise<DecisionReview | null> {
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

  async create(review: DecisionReview): Promise<boolean> { validateReview(review); return this.publish(review); }
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
