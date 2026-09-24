import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DecisionReviewService, FileDecisionReviewStore, PinnedReviewAuthorization, ReviewAccessError, ReviewConflictError,
  type LiveReviewAuthority, type PinnedReviewPolicy, type ReviewScope,
} from '../../../src/decision/review/index.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const policy: PinnedReviewPolicy = {
  id: 'policy-review', version: '1', tenantId: 'tenant-a', projectId: 'project-a',
  requesterRoles: ['requester'], reviewerRoles: ['reviewer'], executorRoles: ['executor'],
  auditorRoles: ['auditor'], operatorRoles: ['operator'], minimumQuorumByRisk: { high: 2, low: 1 }, retentionWindowMsByRisk: { high: 30_000, low: 30_000 },
  separateRequesterReviewer: true, separateEditorReviewer: true, separateReviewerExecutor: true,
};
const roles = new Map([['alice', ['requester', 'reviewer']], ['bob', ['reviewer']], ['carol', ['reviewer']],
  ['erin', ['executor']], ['audit', ['auditor']], ['ops', ['operator']], ['mallory', ['reviewer']]]);
const scope = (id: string, projectId = 'project-a'): ReviewScope => ({ tenantId: 'tenant-a', projectId,
  actor: { id, roles: ['stale-role-from-client'], authorityContext: 'identity/v1' } });
async function fixture(quorum = 2) {
  const directory = await mkdtemp(join(tmpdir(), 'review-authority-')); directories.push(directory);
  const currentRoles = new Map([...roles].map(([id, assigned]) => [id, [...assigned]]));
  const compromised = new Set<string>(); const conflicts = new Map<string, string[]>();
  let principal = 'alice'; let policyDigest: `sha256:${string}` | null = null;
  let actionAllowed = true;
  const authority: LiveReviewAuthority = {
    authenticate: async candidate => candidate.actor.id === principal && candidate.actor.authorityContext === 'identity/v1',
    resolve: async (_tenant, _project, id) => currentRoles.has(id)
      ? { roles: currentRoles.get(id)!, active: true, compromised: compromised.has(id), conflictsWith: conflicts.get(id) ?? [], authorityContext: 'identity/v1' }
      : null,
    currentPolicyDigest: async () => policyDigest,
  };
  const authorization = new PinnedReviewAuthorization(policy, authority, async () => actionAllowed);
  policyDigest = authorization.policyDigest;
  let now = 1000;
  const store = new FileDecisionReviewStore(directory, new Uint8Array(32).fill(5));
  const service = () => new DecisionReviewService(store, authorization, () => now);
  const digest = `sha256:${'a'.repeat(64)}` as const;
  const create = async (riskTier = 'high', requiredQuorum = quorum, retentionUntilEpochMs = 31_000) => service().create(scope('alice'), {
    reviewId: 'review-a', sourceReceipt: { id: 'receipt-a', digest }, evidencePins: [],
    policyPins: [{ id: policy.id, version: policy.version, digest: authorization.policyDigest }],
    reasonCodes: ['uncertain'], riskTier, presentation: { summary: 'synthetic' },
    action: { kind: 'fixture' }, rationale: 'review required', expiresAtEpochMs: 20_000, retentionUntilEpochMs,
    continuationId: 'continuation-a', resumeToken: 'synthetic-resume-token', quorum: requiredQuorum,
  });
  const act = async <T>(id: string, fn: () => Promise<T>): Promise<T> => { principal = id; return fn(); };
  return { create, act, service, store, currentRoles, compromised, conflicts,
    revokePolicy: () => { policyDigest = null; }, setActionAllowed: (allowed: boolean) => { actionAllowed = allowed; },
    setTime: (value: number) => { now = value; }, directory };
}

describe('pinned, authenticated review authorization', () => {
  it('HITL-POLICY rejects inadequate quorum, scope substitution, and stolen caller identity before mutation', async () => {
    const h = await fixture();
    await expect(h.create('high', 1)).rejects.toBeInstanceOf(ReviewAccessError);
    await expect(h.create('high', 2, 21_000)).rejects.toBeInstanceOf(ReviewAccessError);
    expect(await h.store.read('review-a', 'tenant-a', 'project-a')).toBeNull();
    await h.create();
    await expect(h.service().read(scope('mallory', 'other'), 'review-a')).resolves.toBeNull();
    await expect(h.service().resume(scope('erin'), 'review-a', 'synthetic-resume-token', async () => 'no'))
      .rejects.toBeInstanceOf(ReviewAccessError);
    expect(await h.act('audit', () => h.service().list(scope('audit')))).toHaveLength(1);
    expect(await h.act('mallory', () => h.service().list(scope('mallory', 'other')))).toEqual([]);
  });

  it('HITL-QUORUM denies self-approval, COI, conflicting decisions and a revoked approver after restart', async () => {
    const h = await fixture(); await h.create();
    await expect(h.act('alice', () => h.service().decide(scope('alice'), 'review-a', 'approve', 'self')))
      .rejects.toBeInstanceOf(ReviewAccessError);
    h.conflicts.set('mallory', ['alice']);
    await expect(h.act('mallory', () => h.service().decide(scope('mallory'), 'review-a', 'approve', 'conflict')))
      .rejects.toBeInstanceOf(ReviewAccessError);
    await h.act('bob', () => h.service().decide(scope('bob'), 'review-a', 'approve', 'one'));
    await expect(h.act('bob', () => h.service().decide(scope('bob'), 'review-a', 'reject', 'conflicting')))
      .rejects.toBeInstanceOf(ReviewConflictError);
    await h.act('carol', () => h.service().decide(scope('carol'), 'review-a', 'approve', 'two'));
    h.compromised.add('bob');
    const execute = vi.fn(async () => 'effect');
    await expect(h.act('erin', () => h.service().resume(scope('erin'), 'review-a', 'synthetic-resume-token', execute)))
      .rejects.toBeInstanceOf(ReviewAccessError);
    expect(execute).not.toHaveBeenCalled();
    const recorded = await h.store.read('review-a', 'tenant-a', 'project-a');
    expect(recorded?.events.at(-1)?.type).toBe('authorization-denied');
    expect(recorded?.decisions.map(decision => decision.reviewer.id)).toEqual(['bob', 'carol']);
    expect((await h.act('ops', () => h.service().cancel(scope('ops'), 'review-a', 'compromised approver'))).status).toBe('canceled');
    expect((await h.store.read('review-a', 'tenant-a', 'project-a'))?.events.at(-1)?.type).toBe('canceled');
  });

  it('HITL-PURGE authorizes idempotent post-retention retry without disclosing foreign scope', async () => {
    const h = await fixture(1); await h.create('low', 1);
    await h.act('ops', () => h.service().delete(scope('ops'), 'review-a', 'retention'));
    h.setTime(31_000);
    const first = await h.act('ops', () => h.service().purge(scope('ops'), 'review-a'));
    expect(await h.act('ops', () => h.service().purge(scope('ops'), 'review-a'))).toEqual(first);
    await expect(h.act('ops', () => h.service().purge(scope('ops', 'other'), 'review-a')))
      .rejects.toBeInstanceOf(ReviewAccessError);
  });

  it('HITL-SEPARATION denies an executor who authored the approval but permits an independent executor', async () => {
    const h = await fixture(1); await h.create('low', 1);
    await h.act('bob', () => h.service().decide(scope('bob'), 'review-a', 'approve', 'yes'));
    h.currentRoles.set('bob', ['reviewer', 'executor']);
    const execute = vi.fn(async () => 'effect');
    await expect(h.act('bob', () => h.service().resume(scope('bob'), 'review-a', 'synthetic-resume-token', execute)))
      .rejects.toBeInstanceOf(ReviewAccessError);
    expect(execute).not.toHaveBeenCalled();
    const receipt = await h.act('erin', () => h.service().resume(scope('erin'), 'review-a', 'synthetic-resume-token', execute));
    expect(receipt.result).toBe('effect');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('HITL-REVALIDATE rejects policy replacement or revoked action authorization without erasing approval', async () => {
    const h = await fixture(1); await h.create('low', 1);
    await h.act('bob', () => h.service().decide(scope('bob'), 'review-a', 'approve', 'yes'));
    const execute = vi.fn(async () => 'effect');
    h.setActionAllowed(false);
    await expect(h.act('erin', () => h.service().resume(scope('erin'), 'review-a', 'synthetic-resume-token', execute)))
      .rejects.toBeInstanceOf(ReviewAccessError);
    h.setActionAllowed(true); h.revokePolicy();
    await expect(h.act('erin', () => h.service().resume(scope('erin'), 'review-a', 'synthetic-resume-token', execute)))
      .rejects.toBeInstanceOf(ReviewAccessError);
    expect(execute).not.toHaveBeenCalled();
    expect((await h.store.read('review-a', 'tenant-a', 'project-a'))?.decisions).toHaveLength(1);
  });
});
