/**
 * D13 adoption of the effect ledger (#2721): identity preservation, intent
 * before execution, verifier-backed reconcile, the reconciler fallback, the
 * legacy HMAC shim and its migration, key independence, the review-store
 * verifier and reviews persisted before the ledger. Offline only.
 */
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DecisionReviewService, FileDecisionReviewStore, FileVerifiedReviewEffectLedger, LedgerReviewEffectJournal, ReviewConflictError,
  auditedReviewReconciler, journaledReviewExecutor, ledgerReviewReconciler, openReviewEffectLedger, reviewDigest, reviewEffectId,
  validateReview, type ReviewAuthorization, type ReviewScope, type ReviewSessionAudit, type ReviewStore,
} from '../../../src/decision/review/index.js';
import {
  createBuiltinVerifierRegistry, effectId, lookupEffect, memoryCheckpointSink, payloadDigest, runVerifier, staticKeyProvider,
  type EffectVerifierObservation, type EffectVerifierRequest,
} from '../../../src/effects/index.js';
import { testKey, testKeySeedHex } from '../effects/helpers.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const directory = async () => { const dir = await mkdtemp(join(tmpdir(), 'review-effect-ledger-')); dirs.push(dir); return dir; };

const tenant = { tenantId: 'tenant-e', projectId: 'project-e' };
const storeKey = new Uint8Array(32).fill(0x11);
const authorization: ReviewAuthorization = {
  authorize: (scope, operation) => operation === 'create' ? scope.actor.roles.includes('requester') : !scope.actor.roles.includes('requester'),
  eligible: scope => scope.actor.roles.includes('reviewer') || scope.actor.roles.includes('executor'),
  eligibleApproval: (_scope, _review, _proposal, decision) => decision.reviewer.roles.includes('reviewer'),
  authorizeAction: () => true,
};
const actor = (id: string, role: string, scope = tenant): ReviewScope => ({ ...scope, actor: { id, roles: [role], authorityContext: 'unit/v1' } });
const digest = `sha256:${'d'.repeat(64)}` as const;
const createInput = (reviewId: string) => ({
  reviewId, sourceReceipt: { id: 'receipt', digest }, evidencePins: [{ id: 'evidence', version: '1', digest }],
  policyPins: [{ id: 'policy', version: '1', digest }], reasonCodes: ['unit'], riskTier: 'low',
  presentation: { summary: 'synthetic' }, action: { kind: 'fixture', value: reviewId },
  rationale: 'review required', expiresAtEpochMs: 10_000_000, continuationId: `${reviewId}-continuation`, resumeToken: `${reviewId}-token`,
});

type ProbeMode = 'truthful' | 'absent' | 'unknown';
/** A target that carries the effect ID, and its probe. */
function target() {
  const performed: string[] = [];
  let mode: ProbeMode = 'truthful';
  const execution = vi.fn(async (request: EffectVerifierRequest): Promise<EffectVerifierObservation> => {
    if (mode === 'unknown') return { result: 'unknown', reason: 'network-error', complete: false };
    if (mode === 'absent' || !performed.includes(request.effectId)) return { result: 'absent', reason: 'complete-query-no-match', complete: true, evidence: { found: false } };
    return { result: 'present', reason: 'marker-match', complete: true, evidence: { found: true } };
  });
  return { performed, execution, setMode: (next: ProbeMode) => { mode = next; } };
}

async function setup(options: { probe?: boolean; scope?: typeof tenant; independentOf?: Uint8Array[]; key?: string } = {}) {
  const dir = await directory();
  const scope = options.scope ?? tenant;
  const store = new FileDecisionReviewStore(join(dir, 'reviews'), storeKey);
  let clock = 5_000;
  const service = new DecisionReviewService(store, authorization, () => clock, { resumingLeaseMs: 1_000, pollIntervalMs: 5 });
  const probe = target();
  const journal = openReviewEffectLedger({
    projectDir: dir, tenantId: scope.tenantId, projectId: scope.projectId, writer: 'executor-a',
    keyProvider: staticKeyProvider(testKey(options.key ?? 'review')), store, execution: options.probe === false ? undefined : probe.execution,
    sink: memoryCheckpointSink(), independentOf: options.independentOf,
  });
  return { dir, store, service, probe, journal, advance: (ms: number) => { clock += ms; } };
}

const identity = (reviewId: string, scope = tenant) => ({ ...scope, reviewId, continuationId: `${reviewId}-continuation`, proposalVersion: 1 });
const idOf = (reviewId: string) => reviewDigest({ reviewId, continuationId: `${reviewId}-continuation`, proposalVersion: 1 });

async function approved(ctx: Awaited<ReturnType<typeof setup>>, reviewId: string) {
  await ctx.service.create(actor('requester', 'requester'), createInput(reviewId));
  await ctx.service.decide(actor('reviewer', 'reviewer'), reviewId, 'approve', 'approve');
}

function executorFor(ctx: Awaited<ReturnType<typeof setup>>, reviewId: string, effect: (id: string) => Promise<unknown>, idempotentTarget = false) {
  return journaledReviewExecutor({ ledger: ctx.journal, scope: tenant, reviewId, continuationId: `${reviewId}-continuation`,
    proposalVersion: 1, now: () => 7_000, executeEffect: effect, idempotentTarget });
}

describe('D13 effect identity', () => {
  it('REV-EFF-ID-01 the ledger effect ID equals reviewDigest({reviewId, continuationId, proposalVersion})', async () => {
    const ctx = await setup();
    expect(reviewEffectId(identity('r-1'))).toBe(idOf('r-1'));
    expect(effectId({ scope: { tenant: tenant.tenantId, project: tenant.projectId, subsystem: 'review' }, kind: 'decision.review.continuation',
      target: 'review:tenant-e/project-e/r-1', context: { reviewId: 'r-1', continuationId: 'r-1-continuation', proposalVersion: 1 } })).toBe(idOf('r-1'));
    expect(await ctx.journal.recordIntent(identity('r-1'), payloadDigest('action'))).toBe('recorded');
    const lookup = await lookupEffect(ctx.journal.ledger, idOf('r-1'));
    expect(lookup).toMatchObject({ effectId: idOf('r-1'), status: 'intent', kind: 'decision.review.continuation', target: 'review:tenant-e/project-e/r-1' });
    expect(await ctx.journal.recordIntent(identity('r-1'), payloadDigest('action'))).toBe('pending');
    await expect(ctx.journal.recordIntent({ ...identity('r-1'), tenantId: 'other' }, payloadDigest('action'))).rejects.toThrow(/scope/);
  });
});

describe('journaledReviewExecutor over the effect ledger', () => {
  it('REV-EFF-EXE-01 records a signed intent BEFORE the effect and a verified completed after it', async () => {
    const ctx = await setup(); await approved(ctx, 'r-1');
    const seen: string[] = [];
    const receipt = await ctx.service.resume(actor('executor', 'executor'), 'r-1', 'r-1-token', executorFor(ctx, 'r-1', async id => {
      seen.push((await lookupEffect(ctx.journal.ledger, id)).status);
      ctx.probe.performed.push(id);
      return { delivered: true };
    }));
    expect(seen).toEqual(['intent']);
    expect(receipt).toMatchObject({ effectId: idOf('r-1'), result: { delivered: true } });
    const lookup = await lookupEffect(ctx.journal.ledger, idOf('r-1'));
    expect(lookup.records.map(record => record.phase)).toEqual(['intent', 'reconciled', 'completed']);
    expect(lookup.records[2].verification).toMatchObject({ result: 'present', reason: 'marker-match', verifier: { kind: 'decision.review.continuation', version: '1.0.0' } });
    // The archived body is returned through the ledger, so a repeat never re-executes.
    expect(await ctx.journal.completedReceipt({ ...tenant, reviewId: 'r-1', effectId: idOf('r-1') }))
      .toEqual({ effectId: idOf('r-1'), continuationId: 'r-1-continuation', proposalVersion: 1, completedAtEpochMs: 7_000, result: { delivered: true } });
    const again = vi.fn(async () => ({ delivered: 'twice' }));
    expect(await executorFor(ctx, 'r-1', again)(idOf('r-1'), { kind: 'fixture', value: 'r-1' })).toEqual({ delivered: true });
    expect(again).not.toHaveBeenCalled();
  });

  it('REV-EFF-EXE-02 with no execution probe the effect is not marked completed until the review store holds its receipt', async () => {
    const ctx = await setup({ probe: false }); await approved(ctx, 'r-2');
    await ctx.service.resume(actor('executor', 'executor'), 'r-2', 'r-2-token', executorFor(ctx, 'r-2', async () => ({ delivered: true })));
    const lookup = await lookupEffect(ctx.journal.ledger, idOf('r-2'));
    expect(lookup.records.map(record => record.phase)).toEqual(['intent', 'reconciled']);
    expect(lookup.records[1].verification).toMatchObject({ result: 'unknown', reason: 'consistency-lag' });
    // The review store now holds the receipt: the verifier reports a state match.
    const settled = await ctx.journal.reconcileReceipt({ ...tenant, reviewId: 'r-2', effectId: idOf('r-2') });
    expect(settled.result).toBe('present');
    expect(settled.receipt).toMatchObject({ effectId: idOf('r-2'), continuationId: 'r-2-continuation', proposalVersion: 1,
      result: { effectLedger: { schema: 'aiwg.review-effect-reference/v1' } } });
    expect((await lookupEffect(ctx.journal.ledger, idOf('r-2'))).records.at(-1)?.verification).toMatchObject({ reason: 'state-match' });
  });

  it('REV-EFF-EXE-03 a pending intent reconciles: present recovers, absent and unknown never replay, idempotent targets may replay absent', async () => {
    const ctx = await setup(); await approved(ctx, 'r-3');
    // Acquire the continuation and crash inside the executor after the intent, before the effect.
    await ctx.service.resume(actor('executor', 'executor'), 'r-3', 'r-3-token', executorFor(ctx, 'r-3', async () => { throw new Error('crash'); })).catch(() => undefined);
    const action = { kind: 'fixture', value: 'r-3' };
    const effect = vi.fn(async (id: string) => { ctx.probe.performed.push(id); return { delivered: true }; });
    ctx.probe.setMode('unknown');
    await expect(executorFor(ctx, 'r-3', effect)(idOf('r-3'), action)).rejects.toThrow(new ReviewConflictError('Effect outcome remains unknown'));
    ctx.probe.setMode('absent');
    await expect(executorFor(ctx, 'r-3', effect)(idOf('r-3'), action)).rejects.toThrow(new ReviewConflictError('Effect outcome remains uncertain'));
    expect(effect).not.toHaveBeenCalled();
    ctx.probe.setMode('truthful');
    expect(await executorFor(ctx, 'r-3', effect, true)(idOf('r-3'), action)).toEqual({ delivered: true });
    expect(effect).toHaveBeenCalledTimes(1);
    // Completed now: present recovers without another effect.
    expect(await executorFor(ctx, 'r-3', effect)(idOf('r-3'), action)).toEqual({ delivered: true });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('REV-EFF-EXE-04 the production reconciler resumes a stale lease only on present', async () => {
    const ctx = await setup(); await approved(ctx, 'r-4');
    const effect = async (id: string) => { ctx.probe.performed.push(id); throw new Error('lost acknowledgement'); };
    await expect(ctx.service.resume(actor('executor', 'executor'), 'r-4', 'r-4-token', executorFor(ctx, 'r-4', effect))).rejects.toThrow(/lost/);
    ctx.advance(2_000);
    const reconcile = ledgerReviewReconciler({ journal: ctx.journal, scope: tenant, reviewId: 'r-4', continuationId: 'r-4-continuation', proposalVersion: 1 });
    const replay = vi.fn(async () => ({ replayed: true }));
    for (const mode of ['absent', 'unknown'] as const) {
      ctx.probe.setMode(mode);
      await expect(ctx.service.resume(actor('executor', 'executor'), 'r-4', 'r-4-token', replay, reconcile)).rejects.toThrow('Effect outcome remains unknown');
    }
    ctx.probe.setMode('truthful');
    const receipt = await ctx.service.resume(actor('executor', 'executor'), 'r-4', 'r-4-token', replay, reconcile);
    expect(receipt).toMatchObject({ effectId: idOf('r-4'), continuationId: 'r-4-continuation', proposalVersion: 1 });
    expect(replay).not.toHaveBeenCalled();
    expect(ctx.probe.performed).toEqual([idOf('r-4')]);
    expect(await reconcile(idOf('other'))).toBeNull();
  });
});

describe('auditedReviewReconciler verifier fallback', () => {
  const catalog: ReviewSessionAudit = {
    hydrate: async (workspaceId, previousSessionId) => ({ workspaceId, previousSessionId, coverage: 'covered' }),
    findAttempt: async query => ({ workspaceId: query.workspaceId, sessionId: query.previousSessionId, reviewId: query.reviewId, effectId: query.effectId }),
  };
  const empty = { completedReceipt: async () => null };
  const base = { workspaceId: '/workspace', previousSessionId: 'prior', reviewId: 'r-5', scope: tenant, catalog, ledger: empty };
  const receipt = { effectId: idOf('r-5'), continuationId: 'r-5-continuation', proposalVersion: 1, completedAtEpochMs: 1, result: { ok: true } };

  it('REV-EFF-REC-01 present returns the matching receipt; absent and unknown return null', async () => {
    const reconcileReceipt = vi.fn(async () => ({ result: 'present' as const, receipt }));
    expect(await auditedReviewReconciler({ ...base, verifier: { reconcileReceipt } })(idOf('r-5'))).toEqual(receipt);
    expect(reconcileReceipt).toHaveBeenCalledWith({ ...tenant, reviewId: 'r-5', effectId: idOf('r-5') });
    for (const result of ['absent', 'unknown'] as const) {
      expect(await auditedReviewReconciler({ ...base, verifier: { reconcileReceipt: async () => ({ result, receipt: null }) } })(idOf('r-5'))).toBeNull();
    }
    // Without the fallback the old behaviour holds.
    expect(await auditedReviewReconciler(base)(idOf('r-5'))).toBeNull();
    // The fallback is never consulted when coverage fails.
    const uncovered = vi.fn(async () => ({ result: 'present' as const, receipt }));
    expect(await auditedReviewReconciler({ ...base, verifier: { reconcileReceipt: uncovered },
      catalog: { ...catalog, hydrate: async (w, p) => ({ workspaceId: w, previousSessionId: p, coverage: 'partial' }) } })(idOf('r-5'))).toBeNull();
    expect(uncovered).not.toHaveBeenCalled();
  });

  it('REV-EFF-REC-02 a mismatched continuationId or proposalVersion is rejected', async () => {
    for (const bad of [{ ...receipt, continuationId: 'other' }, { ...receipt, proposalVersion: 2 }]) {
      const verifier = { reconcileReceipt: async () => ({ result: 'present' as const, receipt: bad }) };
      await expect(auditedReviewReconciler({ ...base, verifier, expected: { continuationId: 'r-5-continuation', proposalVersion: 1 } })(idOf('r-5')))
        .rejects.toThrow(new ReviewConflictError('Reconciliation receipt mismatch'));
    }
  });

  it('REV-EFF-REC-03 through resume, a verifier-recovered receipt for another continuation is a reconciliation mismatch', async () => {
    const ctx = await setup(); await approved(ctx, 'r-5');
    await ctx.service.resume(actor('executor', 'executor'), 'r-5', 'r-5-token', async () => { throw new Error('crash'); }).catch(() => undefined);
    ctx.advance(2_000);
    const verifier = { reconcileReceipt: async () => ({ result: 'present' as const, receipt: { ...receipt, continuationId: 'other' } }) };
    await expect(ctx.service.resume(actor('executor', 'executor'), 'r-5', 'r-5-token', async () => ({}), auditedReviewReconciler({ ...base, verifier })))
      .rejects.toThrow(new ReviewConflictError('Reconciliation receipt mismatch'));
    const good = { reconcileReceipt: async () => ({ result: 'present' as const, receipt }) };
    expect(await ctx.service.resume(actor('executor', 'executor'), 'r-5', 'r-5-token', async () => ({}), auditedReviewReconciler({ ...base, verifier: good }))).toEqual(receipt);
  });
});

describe('legacy HMAC shim and migration', () => {
  it('REV-EFF-SHIM-01 the deprecated journal still works with the executor and migrates to the ledger with the same receipts', async () => {
    const ctx = await setup();
    const legacyKey = new Uint8Array(32).fill(0x22);
    const legacy = new FileVerifiedReviewEffectLedger(join(ctx.dir, 'legacy'), legacyKey);
    const effect = vi.fn(async () => ({ delivered: 'legacy' }));
    const execute = journaledReviewExecutor({ ledger: legacy, scope: tenant, reviewId: 'r-6', continuationId: 'r-6-continuation',
      proposalVersion: 1, now: () => 1_234, executeEffect: effect });
    expect(await execute(idOf('r-6'), { kind: 'fixture' })).toEqual({ delivered: 'legacy' });
    expect(await execute(idOf('r-6'), { kind: 'fixture' })).toEqual({ delivered: 'legacy' });
    expect(effect).toHaveBeenCalledTimes(1);
    const other = { ...tenant, projectId: 'project-other' };
    await legacy.recordCompleted({ ...other, reviewId: 'r-x', effectId: idOf('r-x') },
      { effectId: idOf('r-x'), continuationId: 'r-x-continuation', proposalVersion: 1, completedAtEpochMs: 5, result: { other: true } });
    const listed = await legacy.listReceipts();
    expect(listed).toHaveLength(2);
    const query = { ...tenant, reviewId: 'r-6', effectId: idOf('r-6') };
    const before = await legacy.completedReceipt(query);
    expect(await ctx.journal.importLegacyReceipts(legacy)).toEqual({ imported: 1, skipped: 1 });
    expect(await ctx.journal.completedReceipt(query)).toEqual(before);
    const records = (await lookupEffect(ctx.journal.ledger, idOf('r-6'))).records;
    expect(records.map(record => record.phase)).toEqual(['intent', 'reconciled', 'completed']);
    expect(records[2].verification).toMatchObject({ result: 'present', reason: 'digest-match', verifier: { kind: 'decision.review.continuation', version: '0.2.0' } });
    // Idempotent: a second migration skips completed receipts.
    expect(await ctx.journal.importLegacyReceipts(legacy)).toEqual({ imported: 0, skipped: 2 });
    // The executor over the ledger now returns the migrated receipt without executing.
    expect(await executorFor(ctx, 'r-6', effect)(idOf('r-6'), { kind: 'fixture' })).toEqual({ delivered: 'legacy' });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('REV-EFF-SHIM-02 a tampered archived receipt fails closed', async () => {
    const ctx = await setup(); await approved(ctx, 'r-7');
    await ctx.service.resume(actor('executor', 'executor'), 'r-7', 'r-7-token', executorFor(ctx, 'r-7', async id => { ctx.probe.performed.push(id); return { delivered: true }; }));
    const { readdir, writeFile } = await import('node:fs/promises');
    const archive = join(ctx.journal.ledger.paths().root, 'receipts');
    const [name] = await readdir(archive);
    const value = JSON.parse(await readFile(join(archive, name), 'utf8'));
    value.receipt.result = { delivered: 'forged' };
    await writeFile(join(archive, name), JSON.stringify(value));
    await expect(ctx.journal.completedReceipt({ ...tenant, reviewId: 'r-7', effectId: idOf('r-7') })).rejects.toThrow(/Invalid executor ledger entry/);
  });
});

describe('ledger key independence', () => {
  it('REV-EFF-KEY-01 the ledger refuses a signing key derived from the review-store or session-index key', async () => {
    const sameAsStore = Buffer.from(testKeySeedHex('review'), 'hex');
    const ctx = await setup({ independentOf: [storeKey, sameAsStore] });
    await expect(ctx.journal.recordIntent(identity('r-8'), payloadDigest('action'))).rejects.toThrow(/independent of review-store and session-index keys/);
    const ok = await setup({ independentOf: [storeKey, new Uint8Array(32).fill(0x33)] });
    expect(await ok.journal.recordIntent(identity('r-8'), payloadDigest('action'))).toBe('recorded');
  });

  it('REV-EFF-KEY-02 the legacy journal refuses the review-store key', () => {
    expect(() => new FileVerifiedReviewEffectLedger('/unused', storeKey, { independentOf: [storeKey] })).toThrow(/independent/);
    expect(() => new FileVerifiedReviewEffectLedger('/unused', new Uint8Array(32).fill(0x44), { independentOf: [storeKey] })).not.toThrow();
  });
});

describe('decision.review.continuation verifier', () => {
  const request = (reviewId: string, overrides: Partial<Omit<EffectVerifierRequest, 'signal'>> = {}): Omit<EffectVerifierRequest, 'signal'> => ({
    effectId: idOf(reviewId), scope: { tenant: tenant.tenantId, project: tenant.projectId, subsystem: 'review' }, kind: 'decision.review.continuation',
    target: `review:${tenant.tenantId}/${tenant.projectId}/${reviewId}`, context: { reviewId, continuationId: `${reviewId}-continuation`, proposalVersion: 1 },
    payloadDigest: payloadDigest('action'), intentRecordedAt: '2026-09-25T00:00:00.000Z', expected: {}, ...overrides,
  });

  it('REV-EFF-VER-01 reads the review store and settles only what it can prove', async () => {
    const ctx = await setup({ probe: false }); await approved(ctx, 'r-9');
    const verifier = createBuiltinVerifierRegistry({ review: { store: ctx.store } }).get('decision.review.continuation')!;
    const run = async (req: Omit<EffectVerifierRequest, 'signal'>) => (await runVerifier(verifier, req)).observation;
    expect(await run(request('missing'))).toMatchObject({ result: 'absent', reason: 'complete-query-no-match' });
    expect(await run(request('r-9'))).toMatchObject({ result: 'absent', reason: 'complete-query-no-match' }); // approved, never dispatched
    expect(await run(request('r-9', { effectId: idOf('other') }))).toMatchObject({ result: 'unknown', reason: 'malformed-response' });
    expect(await run(request('r-9', { target: 'review:tenant-e/other/r-9' }))).toMatchObject({ result: 'unknown', reason: 'malformed-response' });
    await ctx.service.resume(actor('executor', 'executor'), 'r-9', 'r-9-token', async () => { throw new Error('crash'); }).catch(() => undefined);
    expect(await run(request('r-9'))).toMatchObject({ result: 'unknown', reason: 'consistency-lag' });
    ctx.advance(2_000);
    const receipt = { effectId: idOf('r-9'), continuationId: 'r-9-continuation', proposalVersion: 1, completedAtEpochMs: 9, result: { ok: true } };
    await ctx.service.resume(actor('executor', 'executor'), 'r-9', 'r-9-token', async () => ({}), async () => receipt);
    expect(await run(request('r-9'))).toMatchObject({ result: 'present', reason: 'state-match' });
    expect(await run(request('r-9', { expected: { digest: reviewDigest(receipt) } }))).toMatchObject({ result: 'present', reason: 'digest-match' });
    expect(await run(request('r-9', { expected: { digest: reviewDigest({ other: true }) } }))).toMatchObject({ result: 'unknown', reason: 'evidence-conflict' });
    const failing: Pick<ReviewStore, 'read'> = { read: async () => { throw new Error('io'); } };
    const broken = createBuiltinVerifierRegistry({ review: { store: failing } }).get('decision.review.continuation')!;
    expect((await runVerifier(broken, request('r-9'))).observation).toMatchObject({ result: 'unknown', reason: 'container-unreadable' });
  });
});

describe('reviews persisted before the effect ledger', () => {
  const legacyTenant = { tenantId: 'tenant-legacy', projectId: 'project-legacy' };
  const legacyKey = new Uint8Array(32).fill(0x5a);
  const fixtures = join(process.cwd(), 'test/fixtures/decision/review-effect-v1/store');

  async function legacySetup() {
    const dir = await directory();
    await cp(fixtures, join(dir, 'reviews'), { recursive: true });
    const store = new FileDecisionReviewStore(join(dir, 'reviews'), legacyKey);
    let clock = 20_000;
    const service = new DecisionReviewService(store, authorization, () => clock, { resumingLeaseMs: 1_000, pollIntervalMs: 5 });
    const probe = target();
    const journal = openReviewEffectLedger({ projectDir: dir, ...legacyTenant, writer: 'executor-a', keyProvider: staticKeyProvider(testKey('legacy')),
      store, execution: probe.execution, sink: memoryCheckpointSink() });
    return { store, service, probe, journal, advance: (ms: number) => { clock += ms; } };
  }
  const legacyId = (reviewId: string) => reviewDigest({ reviewId, continuationId: `${reviewId}-continuation`, proposalVersion: 1 });
  const executor = (scope = legacyTenant) => actor('executor', 'executor', scope);

  it('REV-EFF-LEGACY-01 persisted reviews still validate and keep their D13 effect identity', async () => {
    const ctx = await legacySetup();
    for (const id of ['legacy-completed', 'legacy-approved', 'legacy-resuming']) {
      const review = (await ctx.store.read(id, legacyTenant.tenantId, legacyTenant.projectId))!;
      expect(() => validateReview(review)).not.toThrow();
      expect(reviewEffectId({ ...legacyTenant, reviewId: id, continuationId: review.continuation.id, proposalVersion: 1 })).toBe(legacyId(id));
    }
    const completed = (await ctx.store.read('legacy-completed', legacyTenant.tenantId, legacyTenant.projectId))!;
    expect(completed.effectReceipt?.effectId).toBe(legacyId('legacy-completed'));
    expect(await ctx.service.resume(executor(), 'legacy-completed', 'legacy-completed-token', async () => { throw new Error('never'); }))
      .toEqual(completed.effectReceipt);
  });

  it('REV-EFF-LEGACY-02 a persisted approved review resumes through the ledger executor under its original effect ID', async () => {
    const ctx = await legacySetup();
    const effect = vi.fn(async (id: string) => { ctx.probe.performed.push(id); return { delivered: true }; });
    const receipt = await ctx.service.resume(executor(), 'legacy-approved', 'legacy-approved-token', journaledReviewExecutor({
      ledger: ctx.journal, scope: legacyTenant, reviewId: 'legacy-approved', continuationId: 'legacy-approved-continuation',
      proposalVersion: 1, now: () => 21_000, executeEffect: effect }));
    expect(receipt.effectId).toBe(legacyId('legacy-approved'));
    expect((await lookupEffect(ctx.journal.ledger, legacyId('legacy-approved'))).status).toBe('completed');
  });

  it('REV-EFF-LEGACY-03 a persisted stale resuming review reconciles through the verifier, recording its intent late', async () => {
    const ctx = await legacySetup();
    const review = (await ctx.store.read('legacy-resuming', legacyTenant.tenantId, legacyTenant.projectId))!;
    expect(review.status).toBe('resuming');
    const reconcile = ledgerReviewReconciler({ journal: ctx.journal, scope: legacyTenant, reviewId: 'legacy-resuming',
      continuationId: 'legacy-resuming-continuation', proposalVersion: 1, actionDigest: review.proposals[0].actionDigest });
    const replay = vi.fn(async () => ({}));
    // The pre-ledger crash left no intent; the effect never reached the target: uncertain, not replayed.
    await expect(ctx.service.resume(executor(), 'legacy-resuming', 'legacy-resuming-token', replay, reconcile)).rejects.toThrow('Effect outcome remains unknown');
    expect((await lookupEffect(ctx.journal.ledger, legacyId('legacy-resuming'))).records.map(record => record.phase)).toEqual(['intent', 'reconciled']);
    // The target shows the effect (it ran before the crash): the receipt is recovered.
    ctx.probe.performed.push(legacyId('legacy-resuming'));
    const receipt = await ctx.service.resume(executor(), 'legacy-resuming', 'legacy-resuming-token', replay, reconcile);
    expect(receipt).toMatchObject({ effectId: legacyId('legacy-resuming'), continuationId: 'legacy-resuming-continuation', proposalVersion: 1 });
    expect(replay).not.toHaveBeenCalled();
  });
});

describe('LedgerReviewEffectJournal construction', () => {
  it('REV-EFF-CTOR-01 requires the review subsystem', async () => {
    const ctx = await setup();
    const { openEffectLedger } = await import('../../../src/effects/index.js');
    const delivery = openEffectLedger({ projectDir: ctx.dir, scope: { tenant: 'tenant-e', project: 'project-e', subsystem: 'delivery' }, writer: 'w' });
    expect(() => new LedgerReviewEffectJournal(delivery)).toThrow(/review subsystem/);
  });
});
