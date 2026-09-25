import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DECISION_LIFECYCLE_SURFACES, DECISION_LIFECYCLE_VERSION, eraseDecisionSubject,
  type DecisionLifecycleHold, type DecisionLifecyclePolicy, type DecisionLifecycleRule,
  type DecisionLifecycleStore, type DecisionLifecycleTombstone,
} from '../../../src/decision/lifecycle.js';
import {
  DecisionReviewService, FileDecisionReviewStore, PinnedReviewAuthorization, ReviewAccessError, ReviewConflictError,
  type DecisionReview, type LiveReviewAuthority, type PinnedReviewPolicy, type ReviewScope, type ReviewSensitiveViewSource,
  type ReviewStore,
} from '../../../src/decision/review/index.js';

// #2606 AC10 (access-audited, retention-bounded sensitive view) and AC17 (D10 lifecycle binding).
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const basePolicy: PinnedReviewPolicy = {
  id: 'policy-review', version: '1', tenantId: 'tenant-a', projectId: 'project-a',
  requesterRoles: ['requester'], reviewerRoles: ['reviewer'], executorRoles: ['executor'],
  auditorRoles: ['auditor'], operatorRoles: ['operator'], minimumQuorumByRisk: { low: 1 }, retentionWindowMsByRisk: { low: 30_000 },
  separateRequesterReviewer: true, separateEditorReviewer: true, separateReviewerExecutor: true,
};
const roles = new Map([['alice', ['requester']], ['bob', ['reviewer']], ['erin', ['executor']],
  ['audit', ['auditor']], ['ops', ['operator']]]);
const scope = (id: string, projectId = 'project-a'): ReviewScope => ({ tenantId: 'tenant-a', projectId,
  actor: { id, roles: ['stale-role-from-client'], authorityContext: 'identity/v1' } });
const digest = `sha256:${'a'.repeat(64)}` as const;
const CANARY = 'SENSITIVE_VIEW_CANARY_2606';
function lifecyclePolicy(review: Partial<DecisionLifecycleRule> = {}): DecisionLifecyclePolicy {
  const rule: DecisionLifecycleRule = { classification: 'restricted', accessScopes: ['case-worker'], retentionMs: 30_000,
    export: 'sanitized', deletion: 'erase', backup: 'expire-with-primary' };
  return { version: DECISION_LIFECYCLE_VERSION, surfaces: Object.fromEntries(DECISION_LIFECYCLE_SURFACES.map(surface =>
    [surface, surface === 'review' ? { ...rule, ...review } : rule])) as DecisionLifecyclePolicy['surfaces'] };
}

async function fixture(options: { sensitiveViewRoles?: string[]; lifecycle?: DecisionLifecyclePolicy;
  wrapStore?: (store: ReviewStore) => ReviewStore } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'review-sensitive-')); directories.push(directory);
  const policy = { ...basePolicy, ...(options.sensitiveViewRoles ? { sensitiveViewRoles: options.sensitiveViewRoles } : {}) };
  let principal = 'alice'; let policyDigest: `sha256:${string}` | null = null;
  const authority: LiveReviewAuthority = {
    authenticate: async candidate => candidate.actor.id === principal,
    resolve: async (_tenant, _project, id) => roles.has(id)
      ? { roles: roles.get(id)!, active: true, compromised: false, conflictsWith: [], authorityContext: 'identity/v1' } : null,
    currentPolicyDigest: async () => policyDigest,
  };
  const authorization = new PinnedReviewAuthorization(policy, authority, async () => true);
  policyDigest = authorization.policyDigest;
  let now = 1000;
  const fileStore = new FileDecisionReviewStore(directory, new Uint8Array(32).fill(9));
  const store = options.wrapStore ? options.wrapStore(fileStore) : fileStore;
  const service = new DecisionReviewService(store, authorization, () => now,
    options.lifecycle ? { lifecycle: { policy: options.lifecycle } } : {});
  const create = (reviewId = 'review-a', retentionUntilEpochMs: number | undefined = 31_000) => service.create(scope('alice'), {
    reviewId, sourceReceipt: { id: 'receipt-a', digest }, evidencePins: [{ id: 'evidence-a', version: '1', digest }],
    policyPins: [{ id: policy.id, version: policy.version, digest: authorization.policyDigest }],
    reasonCodes: ['uncertain'], riskTier: 'low', presentation: { summary: 'synthetic projection' },
    action: { kind: 'fixture' }, rationale: 'review required', expiresAtEpochMs: 20_000,
    ...(retentionUntilEpochMs === undefined ? {} : { retentionUntilEpochMs }),
    continuationId: `continuation-${reviewId}`, resumeToken: 'synthetic-resume-token',
  });
  const act = async <T>(id: string, fn: () => Promise<T>): Promise<T> => { principal = id; return fn(); };
  const reads: Array<{ reviewId: string; auditedFirst: boolean }> = [];
  const source: ReviewSensitiveViewSource = {
    read: async reference => {
      const stored = await fileStore.read(reference.reviewId, reference.tenantId, reference.projectId);
      reads.push({ reviewId: reference.reviewId, auditedFirst: stored?.events.at(-1)?.type === 'sensitive-view-accessed' });
      return { evidence: CANARY, receipt: reference.sourceReceipt.id };
    },
  };
  const outcome = (promise: Promise<unknown>) => promise.then(
    value => ({ ok: true, value }), (error: Error) => ({ ok: false, name: error.constructor.name, message: error.message }));
  return { service, fileStore, create, act, source, reads, outcome, directory,
    setTime: (value: number) => { now = value; } };
}

async function storedText(directory: string): Promise<string> {
  const chunks: string[] = [];
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) chunks.push(await readFile(join(entry.parentPath, entry.name), 'utf8'));
  }
  return chunks.join('\n');
}

describe('HITL sensitive view (AC10)', () => {
  it('HITL-SENSITIVE-01 is disabled unless the pinned policy grants a role, and denial matches absence', async () => {
    const h = await fixture();
    await h.act('alice', () => h.create());
    const request = { purpose: 'incident investigation', ttlMs: 5000 };
    const real = await h.act('audit', () => h.outcome(h.service.openSensitiveView(scope('audit'), 'review-a', request, h.source)));
    const absent = await h.act('audit', () => h.outcome(h.service.openSensitiveView(scope('audit'), 'review-absent', request, h.source)));
    expect(real).toEqual({ ok: false, name: 'ReviewAccessError', message: 'Review not found' });
    expect(absent).toEqual(real);
    expect(h.reads).toEqual([]);
    expect((await h.fileStore.read('review-a', 'tenant-a', 'project-a'))?.revision).toBe(1);
  });

  it('HITL-SENSITIVE-02 audits the access durably before reading, bounds it by retention and never persists content', async () => {
    const h = await fixture({ sensitiveViewRoles: ['auditor'] });
    await h.act('alice', () => h.create());
    h.setTime(28_000);
    const view = await h.act('audit', () => h.service.openSensitiveView(scope('audit'), 'review-a',
      { purpose: 'incident investigation', ttlMs: 60_000 }, h.source));
    expect(view).toMatchObject({ reviewId: 'review-a', purpose: 'incident investigation', grantedAtEpochMs: 28_000,
      expiresAtEpochMs: 31_000, auditEventSequence: 2, content: { evidence: CANARY } });
    expect(h.reads).toEqual([{ reviewId: 'review-a', auditedFirst: true }]);
    const stored = (await h.fileStore.read('review-a', 'tenant-a', 'project-a'))!;
    expect(stored.status).toBe('pending');
    expect(stored.events.at(-1)).toMatchObject({ type: 'sensitive-view-accessed', rationale: 'incident investigation',
      actor: { id: 'audit' }, data: { viewExpiresAtEpochMs: 31_000 } });
    expect(await storedText(h.directory)).not.toContain(CANARY);
    // Other roles, other projects and absent reviews are indistinguishable.
    for (const [actor, project, id] of [['bob', 'project-a', 'review-a'], ['audit', 'other', 'review-a'], ['audit', 'project-a', 'missing']] as const) {
      expect(await h.act(actor, () => h.outcome(h.service.openSensitiveView(scope(actor, project), id,
        { purpose: 'probe', ttlMs: 10 }, h.source)))).toEqual({ ok: false, name: 'ReviewAccessError', message: 'Review not found' });
    }
    // At the retention deadline the view is unavailable and the source is not read.
    h.setTime(31_000);
    await expect(h.act('audit', () => h.service.openSensitiveView(scope('audit'), 'review-a',
      { purpose: 'late', ttlMs: 10 }, h.source))).rejects.toThrow('Review not found');
    expect(h.reads).toHaveLength(1);
  });

  it('HITL-SENSITIVE-03 refuses tombstoned reviews, unpinned retention, restricted purposes and unaudited reads', async () => {
    const h = await fixture({ sensitiveViewRoles: ['auditor'] });
    await h.act('alice', () => h.create('review-a'));
    await h.act('alice', () => h.create('review-unpinned', undefined));
    await expect(h.act('audit', () => h.service.openSensitiveView(scope('audit'), 'review-a',
      { purpose: 'vault://synthetic/locator', ttlMs: 10 }, h.source))).rejects.toThrow('Restricted review payload');
    await expect(h.act('audit', () => h.service.openSensitiveView(scope('audit'), 'review-a',
      { purpose: ' ', ttlMs: 10 }, h.source))).rejects.toBeInstanceOf(ReviewConflictError);
    await h.act('ops', () => h.service.tombstone(scope('ops'), 'review-a', 'retention'));
    await expect(h.act('audit', () => h.service.openSensitiveView(scope('audit'), 'review-a',
      { purpose: 'after tombstone', ttlMs: 10 }, h.source))).rejects.toThrow('Review not found');
    expect(h.reads).toEqual([]);

    // A failed audit append means no read.
    let failWrites = false;
    const g = await fixture({ sensitiveViewRoles: ['auditor'], wrapStore: store => ({
      read: (...args) => store.read(...args), create: review => store.create(review), list: (...args) => store.list(...args),
      compareAndSwap: async (...args) => { if (failWrites) throw new Error('synthetic journal failure'); return store.compareAndSwap(...args); },
    }) });
    await g.act('alice', () => g.create());
    failWrites = true;
    await expect(g.act('audit', () => g.service.openSensitiveView(scope('audit'), 'review-a',
      { purpose: 'audit failure', ttlMs: 10 }, g.source))).rejects.toThrow('synthetic journal failure');
    expect(g.reads).toEqual([]);
  });
});

describe('HITL D10 lifecycle binding (AC17)', () => {
  it('HITL-D10-01 caps retention by the D10 review rule and hides reviews past it', async () => {
    const h = await fixture({ lifecycle: lifecyclePolicy({ retentionMs: 30_000 }) });
    await expect(h.act('alice', () => h.create('review-long', 40_000))).rejects.toThrow('D10 review lifecycle rule');
    // Without a pin the D10 rule is the deadline (created at 1000, retention 30000).
    const created = await h.act('alice', () => h.create('review-a', undefined));
    expect(created.retentionUntilEpochMs).toBe(31_000);
    expect(await h.act('audit', () => h.service.read(scope('audit'), 'review-a'))).not.toBeNull();
    expect(await h.act('audit', () => h.service.export(scope('audit'), 'review-a'))).not.toBeNull();
    h.setTime(31_000);
    expect(await h.act('audit', () => h.service.read(scope('audit'), 'review-a'))).toBeNull();
    expect(await h.act('audit', () => h.service.list(scope('audit')))).toEqual([]);
    expect(await h.act('audit', () => h.service.export(scope('audit'), 'review-a'))).toBeNull();

    const denied = await fixture({ lifecycle: lifecyclePolicy({ export: 'denied' }) });
    await denied.act('alice', () => denied.create());
    expect(await denied.act('audit', () => denied.service.read(scope('audit'), 'review-a'))).not.toBeNull();
    expect(await denied.act('audit', () => denied.service.export(scope('audit'), 'review-a'))).toBeNull();
    await expect(denied.service.lifecycleReferences(scope('ops'), 'receipt-a')).resolves.toBeDefined();
    const unbound = await fixture();
    await expect(unbound.act('ops', () => unbound.service.lifecycleReferences(scope('ops'), 'receipt-a')))
      .rejects.toThrow('no D10 lifecycle binding');
  });

  function lifecycleStore(h: Awaited<ReturnType<typeof fixture>>, holds: DecisionLifecycleHold[] = []) {
    const tombstones: DecisionLifecycleTombstone[] = [];
    const store: DecisionLifecycleStore = {
      links: subject => h.act('ops', () => h.service.lifecycleReferences(scope('ops'), subject)),
      erase: async reference => { await h.act('ops', () => h.service.eraseLifecycleReference(scope('ops'), reference)); },
      tombstone: async value => { tombstones.push(value); },
      holds: async () => holds,
      recordHold: async () => {}, releaseHold: async () => {},
    };
    return { store, tombstones };
  }
  async function approved(h: Awaited<ReturnType<typeof fixture>>) {
    await h.act('alice', () => h.create());
    await h.act('bob', () => h.service.decide(scope('bob'), 'review-a', 'approve', 'approve'));
  }

  it('HITL-D10-02 eraseDecisionSubject cascades through review references and an erased approval never executes', async () => {
    const policy = lifecyclePolicy();
    const h = await fixture({ lifecycle: policy });
    await approved(h);
    const { store, tombstones } = lifecycleStore(h);
    const references = await store.links('receipt-a');
    expect(references).toEqual([h.service.lifecycleReference({ tenantId: 'tenant-a', projectId: 'project-a', reviewId: 'review-a' })]);
    expect(JSON.stringify(references)).not.toContain('review-a');
    await eraseDecisionSubject('receipt-a', policy, store, 2000);
    expect(tombstones).toHaveLength(1);
    expect(await h.fileStore.read('review-a', 'tenant-a', 'project-a')).toBeNull();
    let effects = 0;
    await expect(h.act('erin', () => h.service.resume(scope('erin'), 'review-a', 'synthetic-resume-token',
      async () => { effects += 1; return 'effect'; }))).rejects.toThrow('Review not found');
    expect(effects).toBe(0);
    // An already erased reference is idempotent for an operator and hidden from others.
    await expect(h.act('ops', () => h.service.eraseLifecycleReference(scope('ops'), references[0]!))).resolves.toBe(false);
    await expect(h.act('bob', () => h.service.eraseLifecycleReference(scope('bob'), references[0]!))).rejects.toBeInstanceOf(ReviewAccessError);
  });

  it('HITL-D10-03 tombstone-only rules, D10 holds and review legal holds all keep the approval unexecutable or intact', async () => {
    const tombstoneOnly = lifecyclePolicy({ deletion: 'tombstone' });
    const t = await fixture({ lifecycle: tombstoneOnly });
    await approved(t);
    await eraseDecisionSubject('receipt-a', tombstoneOnly, lifecycleStore(t).store, 2000);
    expect((await t.fileStore.read('review-a', 'tenant-a', 'project-a'))?.status).toBe('tombstoned');
    let effects = 0;
    await expect(t.act('erin', () => t.service.resume(scope('erin'), 'review-a', 'synthetic-resume-token',
      async () => { effects += 1; return 'effect'; }))).rejects.toBeInstanceOf(ReviewConflictError);
    expect(effects).toBe(0);

    const policy = lifecyclePolicy();
    const held = await fixture({ lifecycle: policy });
    await approved(held);
    const hold: DecisionLifecycleHold = { subject: 'receipt-a', reason: 'litigation', scope: ['review'], expiresAt: 10_000, authorizedBy: 'counsel' };
    await expect(eraseDecisionSubject('receipt-a', policy, lifecycleStore(held, [hold]).store, 2000)).rejects.toThrow('denied by hold');
    expect((await held.fileStore.read('review-a', 'tenant-a', 'project-a'))?.status).toBe('approved');

    const legal = await fixture({ lifecycle: policy });
    await approved(legal);
    await legal.act('ops', () => legal.service.setLegalHold(scope('ops'), 'review-a', true, 'hold'));
    await expect(eraseDecisionSubject('receipt-a', policy, lifecycleStore(legal).store, 2000)).rejects.toThrow('erasure failed');
    const kept = (await legal.fileStore.read('review-a', 'tenant-a', 'project-a')) as DecisionReview;
    expect(kept.status).toBe('approved');
    expect(kept.lifecycle?.legalHold).toBe(true);
  });
});
