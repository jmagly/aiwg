import { mkdtemp, readFile, rm } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DecisionReviewService, FileDecisionReviewStore, ReviewAccessError, ReviewConflictError, ReviewDefinitiveExecutionError,
  auditedReviewReconciler, FileVerifiedReviewEffectLedger, reviewDigest, validateReview, assertImmutable, ReviewIntegrityError, type CreateReviewInput, type DecisionReview, type ReviewActor, type ReviewAuthorization, type ReviewScope,
} from '../../../src/decision/review/index.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const actor = (id: string, roles = ['reviewer']): ReviewActor => ({ id, roles, authorityContext: 'test-policy/v1' });
const scope = (who: ReviewActor): ReviewScope => ({ tenantId: 'tenant-a', projectId: 'project-a', actor: who });
const digest = `sha256:${'a'.repeat(64)}` as const;
const input = (now: number, overrides: Partial<CreateReviewInput> = {}): CreateReviewInput => ({
  reviewId: 'review-1', sourceReceipt: { id: 'receipt-1', digest }, evidencePins: [{ id: 'evidence', version: '1', digest }],
  policyPins: [{ id: 'policy', version: '1', digest }], reasonCodes: ['low-confidence'], riskTier: 'medium',
  presentation: { summary: 'Projected, non-sensitive evidence' }, action: { kind: 'notify', target: 'fixture' }, rationale: 'needs review',
  expiresAtEpochMs: now + 10_000, continuationId: 'continuation-1', resumeToken: 'secret-token', ...overrides,
});

async function harness(nowRef = { value: 1_000 }, authOverrides: Partial<ReviewAuthorization> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'aiwg-review-')); directories.push(directory);
  const authorization: ReviewAuthorization = {
    authorize: () => true, eligible: ({ actor: who }) => who.roles.includes('reviewer'),
    eligibleApproval: (_scope, _review, _proposal, decision) => decision.reviewer.roles.includes('reviewer'),
    authorizeAction: () => true, ...authOverrides,
  };
  const store = new FileDecisionReviewStore(directory, new Uint8Array(32).fill(7));
  return { directory, authorization, store, service: new DecisionReviewService(store, authorization, () => nowRef.value) };
}

describe('durable decision review runtime', () => {
  it('persists append-only review state across service/store restart', async () => {
    const h = await harness(); const requester = actor('alice', ['requester']); const reviewer = actor('bob');
    await h.service.create(scope(requester), input(1_000));
    await h.service.claim(scope(reviewer), 'review-1', 'taking review');
    const restarted = new DecisionReviewService(new FileDecisionReviewStore(h.directory, new Uint8Array(32).fill(7)), h.authorization, () => 1_001);
    const review = await restarted.read(scope(reviewer), 'review-1');
    expect(review).toMatchObject({ revision: 2, status: 'claimed' });
    expect(review?.events.map(event => event.type)).toEqual(['created', 'claimed']);
  });

  it('uses CAS so concurrent final approvals create one ordered history', async () => {
    const h = await harness(); await h.service.create(scope(actor('alice', ['requester'])), input(1_000, { quorum: 2 }));
    await Promise.all([h.service.decide(scope(actor('bob')), 'review-1', 'approve', 'one'), h.service.decide(scope(actor('carol')), 'review-1', 'approve', 'two')]);
    const review = await h.service.read(scope(actor('auditor')), 'review-1');
    expect(review?.status).toBe('approved'); expect(review?.decisions).toHaveLength(2);
    expect(review?.events.map(event => event.sequence)).toEqual([1, 2, 3]);
  });

  it('edits by appending a proposal version and requires a fresh approval', async () => {
    const h = await harness(); await h.service.create(scope(actor('alice', ['requester'])), input(1_000));
    await h.service.decide(scope(actor('bob')), 'review-1', 'approve', 'approve v1');
    await expect(h.service.edit(scope(actor('carol')), 'review-1', { kind: 'notify', target: 'changed' }, 'safer target')).rejects.toBeInstanceOf(ReviewConflictError);
    const h2 = await harness(); await h2.service.create(scope(actor('alice', ['requester'])), input(1_000));
    const edited = await h2.service.edit(scope(actor('carol')), 'review-1', { kind: 'notify', target: 'changed' }, 'safer target');
    expect(edited).toMatchObject({ status: 'pending', proposals: [{ version: 1 }, { version: 2 }] });
    const approved = await h2.service.decide(scope(actor('bob')), 'review-1', 'approve', 'approve v2');
    expect(approved.decisions.at(-1)?.proposalVersion).toBe(2);
  });

  it('revalidates expiry, eligibility, action authorization, and denies self approval', async () => {
    const time = { value: 1_000 }; let allowAction = true;
    const h = await harness(time, { authorizeAction: () => allowAction });
    await h.service.create(scope(actor('alice', ['requester'])), input(time.value));
    await expect(h.service.decide(scope(actor('alice', ['requester', 'reviewer'])), 'review-1', 'approve', 'self')).rejects.toBeInstanceOf(ReviewAccessError);
    await h.service.decide(scope(actor('bob')), 'review-1', 'approve', 'approved'); allowAction = false;
    await expect(h.service.resume(scope(actor('bob')), 'review-1', 'secret-token', async () => 'done')).rejects.toBeInstanceOf(ReviewAccessError);
    const denied = await h.store.read('review-1', 'tenant-a', 'project-a');
    expect(denied?.events.at(-1)?.type).toBe('authorization-denied');
    const schema = JSON.parse(await readFile(new URL('../../../schemas/decision/DecisionReview.schema.json', import.meta.url), 'utf8'));
    expect(new Ajv2020({ strict: false }).validate(schema, denied)).toBe(true);
    expect(denied?.status).toBe('approved');
    expect(denied?.events.some(event => event.type === 'approved')).toBe(true);
    allowAction = true; time.value = 20_000;
    await expect(h.service.resume(scope(actor('bob')), 'review-1', 'secret-token', async () => 'done')).rejects.toBeInstanceOf(ReviewConflictError);
  });

  it('HITL-PRIVACY rejects restricted payloads before storage, including edit and receipt paths', async () => {
    const h = await harness();
    for (const changes of [
      { presentation: { credential: 'synthetic-only' } },
      { presentation: { summary: 'vault://synthetic/fixture' } },
      { action: { privateReasoning: 'synthetic-only' } },
      { rationale: 'sk-test-synthetic-canary-123456' },
    ]) {
      await expect(h.service.create(scope(actor('alice', ['requester'])), input(1000, changes)))
        .rejects.toThrow('Restricted review payload');
      expect(await h.store.read('review-1', 'tenant-a', 'project-a')).toBeNull();
    }
    await h.service.create(scope(actor('alice', ['requester'])), input(1000));
    await expect(h.service.edit(scope(actor('bob')), 'review-1', { providerBody: 'synthetic-only' }, 'edit'))
      .rejects.toThrow('Restricted review payload');
    await h.service.decide(scope(actor('bob')), 'review-1', 'approve', 'approved');
    await expect(h.service.resume(scope(actor('bob')), 'review-1', 'secret-token', async () => ({ apiKey: 'synthetic-only' })))
      .rejects.toThrow('Restricted review payload');
    const review = await h.store.read('review-1', 'tenant-a', 'project-a');
    expect(review?.status).toBe('resuming');
    expect(JSON.stringify(review)).not.toContain('synthetic-only');
  });

  it('HITL-REVOKE blocks execution after an approver loses authority and preserves the approval', async () => {
    const time = { value: 1000 };
    let bobActive = true;
    const h = await harness(time, { eligibleApproval: (_scope, _review, _proposal, decision) => decision.reviewer.id !== 'bob' || bobActive });
    await h.service.create(scope(actor('alice', ['requester'])), input(time.value));
    await h.service.decide(scope(actor('bob')), 'review-1', 'approve', 'yes');
    bobActive = false;
    const execute = vi.fn(async () => 'done');
    await expect(h.service.resume(scope(actor('carol')), 'review-1', 'secret-token', execute)).rejects.toBeInstanceOf(ReviewAccessError);
    expect(execute).not.toHaveBeenCalled();
    const review = await h.service.read(scope(actor('auditor')), 'review-1');
    expect(review?.decisions).toHaveLength(1);
    expect(review?.events.at(-1)?.type).toBe('authorization-denied');
  });

  it('HITL-LINEAGE rejects forged statuses, reordered approvals, preapproval dispatch and swapped receipts', async () => {
    const h = await harness();
    const created = await h.service.create(scope(actor('alice', ['requester'])), input(1_000));
    const forged = structuredClone(created);
    forged.status = 'approved';
    expect(() => validateReview(forged)).toThrow(ReviewIntegrityError);
    forged.status = 'resuming';
    expect(() => validateReview(forged)).toThrow(ReviewIntegrityError);
    const approved = await h.service.decide(scope(actor('bob')), 'review-1', 'approve', 'yes');
    const schema = JSON.parse(await readFile(new URL('../../../schemas/decision/DecisionReview.schema.json', import.meta.url), 'utf8'));
    const schemaValid = new Ajv2020({ strict: false }).compile(schema);
    expect(schemaValid(approved), JSON.stringify(schemaValid.errors)).toBe(true);
    const changedPins = structuredClone(approved);
    changedPins.policyPins[0]!.digest = `sha256:${'b'.repeat(64)}`;
    expect(() => assertImmutable(created, changedPins)).toThrow(/policyPins/);
    const changedExpiry = structuredClone(approved);
    changedExpiry.expiresAtEpochMs += 1000;
    expect(() => assertImmutable(created, changedExpiry)).toThrow(/expiresAtEpochMs/);
    const changedHistory = structuredClone(approved);
    changedHistory.decisions[0]!.rationale = 'forged';
    expect(() => validateReview(changedHistory)).toThrow(/Decision event mismatch/);
    const swapped = structuredClone(approved);
    swapped.decisions[0]!.reviewer.id = 'mallory';
    expect(() => validateReview(swapped)).toThrow(/Decision event mismatch/);
    const reordered = structuredClone(approved);
    reordered.events[1]!.sequence = 1;
    expect(() => validateReview(reordered)).toThrow(/event lineage/i);
    const fakeReceipt = structuredClone(approved);
    fakeReceipt.effectReceipt = { effectId: 'forged', continuationId: fakeReceipt.continuation.id,
      proposalVersion: 1, completedAtEpochMs: 1000, result: 'forged' };
    expect(() => validateReview(fakeReceipt)).toThrow(/Effect receipt/);
    const forgedEvent = structuredClone(approved);
    forgedEvent.events[1]!.type = 'execution-completed';
    expect(() => validateReview(forgedEvent)).toThrow(ReviewIntegrityError);
  });

  it('enforces deterministic expiry, escalation, rejection, and cancellation transitions', async () => {
    const time = { value: 1_000 }; const h = await harness(time);
    await h.service.create(scope(actor('alice', ['requester'])), input(time.value, { escalationAtEpochMs: 1_500 }));
    await expect(h.service.escalate(scope(actor('operator')), 'review-1', 'too early')).rejects.toBeInstanceOf(ReviewConflictError);
    time.value = 1_500; expect((await h.service.escalate(scope(actor('operator')), 'review-1', 'deadline')).status).toBe('escalated');
    expect((await h.service.cancel(scope(actor('operator')), 'review-1', 'withdrawn')).status).toBe('canceled');
    await expect(h.service.claim(scope(actor('bob')), 'review-1', 'late claim')).rejects.toBeInstanceOf(ReviewConflictError);

    const h2 = await harness(time); await h2.service.create(scope(actor('alice', ['requester'])), input(time.value));
    expect((await h2.service.decide(scope(actor('bob')), 'review-1', 'reject', 'unsafe')).status).toBe('rejected');
    await expect(h2.service.decide(scope(actor('carol')), 'review-1', 'approve', 'late')).rejects.toBeInstanceOf(ReviewConflictError);

    const h3 = await harness(time); await h3.service.create(scope(actor('alice', ['requester'])), input(time.value, { expiresAtEpochMs: 1_600 }));
    time.value = 1_600; expect((await h3.service.expireDue(scope(actor('operator')), 'review-1')).status).toBe('expired');
  });

  it('executes once under concurrent resume and returns the durable receipt on duplicates and restart', async () => {
    const h = await harness(); await h.service.create(scope(actor('alice', ['requester'])), input(1_000));
    await h.service.decide(scope(actor('bob')), 'review-1', 'approve', 'approved');
    const execute = vi.fn(async (effectId: string) => ({ effectId, delivered: true }));
    const [first, second] = await Promise.all([
      h.service.resume(scope(actor('bob')), 'review-1', 'secret-token', execute),
      h.service.resume(scope(actor('bob')), 'review-1', 'secret-token', execute),
    ]);
    expect(execute).toHaveBeenCalledTimes(1); expect(second).toEqual(first);
    const restarted = new DecisionReviewService(new FileDecisionReviewStore(h.directory, new Uint8Array(32).fill(7)), h.authorization, () => 1_100);
    expect(await restarted.resume(scope(actor('bob')), 'review-1', 'secret-token', execute)).toEqual(first);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('reconciles a stale continuation without executing a second remote effect', async () => {
    const time = { value: 1_000 }; const h = await harness(time);
    await h.service.create(scope(actor('alice', ['requester'])), input(time.value));
    const approved = await h.service.decide(scope(actor('bob')), 'review-1', 'approve', 'approved');
    const effectId = reviewDigest({ reviewId: 'review-1', continuationId: approved.continuation.id, proposalVersion: 1 });
    const stranded: DecisionReview = {
      ...structuredClone(approved), revision: approved.revision + 1, status: 'resuming', updatedAtEpochMs: time.value,
      events: [...approved.events, { sequence: approved.events.length + 1, type: 'resumed', atEpochMs: time.value,
        actor: actor('bob'), proposalVersion: 1, rationale: 'continuation acquired', data: { effectId } }],
    };
    expect(await h.store.compareAndSwap('review-1', 'tenant-a', 'project-a', approved.revision, stranded)).toBe(true);
    time.value += 101;
    const restarted = new DecisionReviewService(new FileDecisionReviewStore(h.directory, new Uint8Array(32).fill(7)), h.authorization, () => time.value, { resumingLeaseMs: 100 });
    const execute = vi.fn(async () => 'must-not-run');
    await expect(restarted.resume(scope(actor('bob')), 'review-1', 'secret-token', execute))
      .rejects.toThrow(/requires effect reconciliation/);
    await expect(restarted.resume(scope(actor('bob')), 'review-1', 'secret-token', execute, async () => null))
      .rejects.toThrow(/remains unknown/);
    expect(execute).not.toHaveBeenCalled();
    const authoritative = { effectId, continuationId: approved.continuation.id, proposalVersion: 1,
      completedAtEpochMs: time.value, result: { reconciled: true } };
    let coverage: 'partial' | 'covered' = 'partial';
    const catalog = {
      hydrate: vi.fn(async (workspaceId: string, previousSessionId: string) => ({ workspaceId, previousSessionId, coverage })),
      findAttempt: vi.fn(async () => ({ workspaceId: '/workspace/aiwg', sessionId: 'prior-run', reviewId: 'review-1', effectId })),
    };
    const ledger = { completedReceipt: vi.fn(async () => authoritative) };
    const reconcile = auditedReviewReconciler({ workspaceId: '/workspace/aiwg', previousSessionId: 'prior-run',
      reviewId: 'review-1', scope: scope(actor('bob')), catalog, ledger });
    await expect(restarted.resume(scope(actor('bob')), 'review-1', 'secret-token', execute, reconcile))
      .rejects.toThrow(/remains unknown/);
    expect(catalog.findAttempt).not.toHaveBeenCalled();
    expect(ledger.completedReceipt).not.toHaveBeenCalled();
    coverage = 'covered';
    const receipt = await restarted.resume(scope(actor('bob')), 'review-1', 'secret-token', execute, reconcile);
    expect(receipt).toEqual(authoritative);
    expect(execute).not.toHaveBeenCalled();
    const stored = await h.store.read('review-1', 'tenant-a', 'project-a');
    expect(stored?.events.at(-2)).toMatchObject({ type: 'resumed', data: { effectId, recovered: true } });
    expect(stored?.status).toBe('completed');
  });

  it('HITL-RESTART reconciles a completed external effect from an authenticated journal after dispatch crash', async () => {
    const time = { value: 1000 }; const h = await harness(time);
    const ledgerDirectory = await mkdtemp(join(tmpdir(), 'aiwg-review-ledger-')); directories.push(ledgerDirectory);
    const ledger = new FileVerifiedReviewEffectLedger(ledgerDirectory, new Uint8Array(32).fill(8));
    await h.service.create(scope(actor('alice', ['requester'])), input(time.value));
    await h.service.decide(scope(actor('bob')), 'review-1', 'approve', 'approved');
    const execute = vi.fn(async (effectId: string) => {
      const receipt = { effectId, continuationId: 'continuation-1', proposalVersion: 1, completedAtEpochMs: time.value, result: 'delivered' };
      await ledger.recordCompleted({ tenantId: 'tenant-a', projectId: 'project-a', reviewId: 'review-1', effectId }, receipt);
      throw new Error('lost response after journal publication');
    });
    await expect(h.service.resume(scope(actor('bob')), 'review-1', 'secret-token', execute)).rejects.toThrow(/lost response/);
    time.value += 101;
    const restarted = new DecisionReviewService(new FileDecisionReviewStore(h.directory, new Uint8Array(32).fill(7)), h.authorization,
      () => time.value, { resumingLeaseMs: 100 });
    const catalog = { hydrate: async (workspaceId: string, previousSessionId: string) => ({ workspaceId, previousSessionId, coverage: 'covered' as const }),
      findAttempt: async (q: { workspaceId: string; previousSessionId: string; reviewId: string; effectId: string }) =>
        ({ workspaceId: q.workspaceId, sessionId: q.previousSessionId, reviewId: q.reviewId, effectId: q.effectId }) };
    const reconcile = auditedReviewReconciler({ workspaceId: '/workspace', previousSessionId: 'prior-session', reviewId: 'review-1',
      scope: scope(actor('bob')), catalog, ledger: new FileVerifiedReviewEffectLedger(ledgerDirectory, new Uint8Array(32).fill(8)) });
    const recovered = await restarted.resume(scope(actor('bob')), 'review-1', 'secret-token', execute, reconcile);
    expect(recovered.result).toBe('delivered');
    expect((await restarted.resume(scope(actor('bob')), 'review-1', 'secret-token', execute, reconcile))).toEqual(recovered);
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await h.store.read('review-1', 'tenant-a', 'project-a'))?.status).toBe('completed');
  });

  it('reauthorizes token, reviewer, and action before stale-resume recovery', async () => {
    const time = { value: 1_000 }; let eligible = true;
    const h = await harness(time, { eligible: () => eligible });
    await h.service.create(scope(actor('alice', ['requester'])), input(time.value));
    const approved = await h.service.decide(scope(actor('bob')), 'review-1', 'approve', 'approved');
    const effectId = reviewDigest({ reviewId: 'review-1', continuationId: approved.continuation.id, proposalVersion: 1 });
    const stranded: DecisionReview = { ...structuredClone(approved), revision: approved.revision + 1, status: 'resuming', updatedAtEpochMs: time.value,
      events: [...approved.events, { sequence: approved.events.length + 1, type: 'resumed', atEpochMs: time.value, actor: actor('bob'), proposalVersion: 1, rationale: 'acquired', data: { effectId } }] };
    await h.store.compareAndSwap('review-1', 'tenant-a', 'project-a', approved.revision, stranded); time.value += 101;
    const restarted = new DecisionReviewService(h.store, h.authorization, () => time.value, { resumingLeaseMs: 100 });
    await expect(restarted.resume(scope(actor('bob')), 'review-1', 'wrong', async () => 'no')).rejects.toBeInstanceOf(ReviewAccessError);
    eligible = false;
    await expect(restarted.resume(scope(actor('bob')), 'review-1', 'secret-token', async () => 'no')).rejects.toBeInstanceOf(ReviewAccessError);
  });

  it('HITL-UNKNOWN leaves ambiguous executor rejection open for reconciliation without persisting private errors', async () => {
    const time = { value: 1000 }; const h = await harness(time);
    await h.service.create(scope(actor('alice', ['requester'])), input(time.value));
    await h.service.decide(scope(actor('bob')), 'review-1', 'approve', 'approved');
    const execute = vi.fn(async () => { throw new Error('private-test-payload'); });
    await expect(h.service.resume(scope(actor('bob')), 'review-1', 'secret-token', execute)).rejects.toThrow('private-test-payload');
    const stored = await h.store.read('review-1', 'tenant-a', 'project-a');
    expect(stored?.status).toBe('resuming');
    expect(JSON.stringify(stored)).not.toContain('private-test-payload');
    time.value += 101;
    const restarted = new DecisionReviewService(h.store, h.authorization, () => time.value, { resumingLeaseMs: 100 });
    await expect(restarted.resume(scope(actor('bob')), 'review-1', 'secret-token', execute)).rejects.toThrow(/requires effect reconciliation/);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('HITL-FAIL stores only a fixed error class for executor-attested definitive failures', async () => {
    const h = await harness();
    await h.service.create(scope(actor('alice', ['requester'])), input(1_000));
    await h.service.decide(scope(actor('bob')), 'review-1', 'approve', 'approved');
    await expect(h.service.resume(scope(actor('bob')), 'review-1', 'secret-token', async () => {
      throw new ReviewDefinitiveExecutionError('private-test-payload');
    })).rejects.toThrow('private-test-payload');
    const stored = await h.store.read('review-1', 'tenant-a', 'project-a');
    expect(stored?.status).toBe('execution-failed');
    expect(stored?.executionError).toBe('executor-failed');
    expect(JSON.stringify(stored)).not.toContain('private-test-payload');
  });

  it('filters list/read/export without object enumeration and applies tombstone/legal hold lifecycle', async () => {
    const hidden = new Set(['review-hidden']);
    const h = await harness({ value: 1_000 }, { authorize: (_scope, operation, review) => {
      if (operation === 'list' || operation === 'create' || operation === 'legal-hold' || operation === 'delete' || operation === 'tombstone') return true;
      return !review || !hidden.has(review.reviewId);
    } });
    await h.service.create(scope(actor('alice', ['requester'])), input(1_000));
    await h.service.create(scope(actor('alice', ['requester'])), input(1_000, { reviewId: 'review-hidden' }));
    expect((await h.service.list(scope(actor('auditor')))).map(review => review.reviewId)).toEqual(['review-1']);
    expect(await h.service.read(scope(actor('auditor')), 'review-hidden')).toBeNull();
    expect(await h.service.read(scope(actor('auditor')), 'does-not-exist')).toBeNull();
    expect(await h.service.export(scope(actor('auditor')), 'review-hidden')).toBeNull();

    await h.service.setLegalHold(scope(actor('operator')), 'review-1', true, 'case preservation');
    await expect(h.service.delete(scope(actor('operator')), 'review-1', 'retention elapsed')).rejects.toThrow(/legal hold/);
    await h.service.setLegalHold(scope(actor('operator')), 'review-1', false, 'case closed');
    const tombstone = await h.service.delete(scope(actor('operator')), 'review-1', 'retention elapsed');
    expect(tombstone).toMatchObject({ status: 'tombstoned', lifecycle: { legalHold: false, tombstoneReason: 'retention elapsed' } });
    expect(await h.service.read(scope(actor('auditor')), 'review-1')).toBeNull();
    expect(await h.service.list(scope(actor('auditor')))).toEqual([]);
    expect((await h.service.list(scope(actor('auditor')), { includeTombstoned: true })).map(review => review.reviewId)).toEqual(['review-1']);
    expect(await h.service.export(scope(actor('auditor')), 'review-1')).toMatchObject({ status: 'tombstoned' });
    expect(await h.service.tombstone(scope(actor('operator')), 'review-1', 'idempotent retry')).toEqual(tombstone);
  });

  it('rejects cross-project lookup without disclosing the object', async () => {
    const h = await harness(); await h.service.create(scope(actor('alice', ['requester'])), input(1_000));
    const foreign = { tenantId: 'tenant-a', projectId: 'project-b', actor: actor('mallory') };
    expect(await h.service.read(foreign, 'review-1')).toBeNull();
  });
});
