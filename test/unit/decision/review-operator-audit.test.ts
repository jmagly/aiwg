import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlOperatorDecisionStore, toOpenTelemetryLog, verifyDecisionChain } from '../../../src/audit/operator-decision.js';
import {
  DecisionReviewService, FileDecisionReviewStore, ReviewIntegrityError, replayReviewOperatorAudit,
  reviewOperatorDecisionInput, type ReviewScope,
} from '../../../src/decision/review/index.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map(directory => rm(directory, { recursive: true, force: true }))));
const actor = (id: string): ReviewScope => ({ tenantId: 'tenant-a', projectId: 'project-a',
  actor: { id, roles: ['reviewer'], authorityContext: 'fixture-authentication/v1' } });
const digest = `sha256:${'a'.repeat(64)}` as const;
const correlation = { mission_id: 'mission-a', sandbox_session_id: 'session-a', trace_id: 'trace-a' };

it('HITL-AUDIT-RECOVERY blocks an effect until a failed operator audit append is repaired', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'review-operator-recover-')); dirs.push(directory);
  const audit = new JsonlOperatorDecisionStore(join(directory, 'audit.jsonl'));
  const append = audit.append.bind(audit);
  let failOnce = true;
  audit.append = async input => {
    if (failOnce) { failOnce = false; throw new Error('operator journal unavailable'); }
    return append(input);
  };
  const store = new FileDecisionReviewStore(join(directory, 'reviews'), new Uint8Array(32).fill(9));
  const authorization = { authorize: () => true, eligible: () => true, eligibleApproval: () => true, authorizeAction: () => true };
  const service = () => new DecisionReviewService(store, authorization, () => 1000, {
    operatorAudit: { store: audit, correlation: () => correlation, classification: 'confidential' },
  });
  await service().create(actor('requester'), {
    reviewId: 'review-a', sourceReceipt: { id: 'receipt', digest }, evidencePins: [], policyPins: [],
    reasonCodes: ['review'], riskTier: 'fixture', presentation: {}, action: { kind: 'fixture' },
    rationale: 'review', expiresAtEpochMs: 9000, continuationId: 'continue', resumeToken: 'token',
  });
  await expect(service().decide(actor('bob'), 'review-a', 'approve', 'approved'))
    .rejects.toThrow(/operator journal unavailable/);
  const stored = await store.read('review-a', 'tenant-a', 'project-a');
  expect(stored?.status).toBe('approved');
  expect(await audit.read()).toHaveLength(0);
  const execute = async () => ({ done: true });
  const receipt = await service().resume(actor('bob'), 'review-a', 'token', execute);
  expect(receipt.result).toEqual({ done: true });
  expect((await audit.read()).map(record => record.event_id)).toEqual([stored!.events.at(-1)!.operatorDecisionEventId]);
  await service().syncOperatorAudit(actor('auditor'), 'review-a');
  expect(await audit.read()).toHaveLength(1);
});

it('HITL-AUDIT-1567 replays approval, denial and escalation with the SAME event IDs into #1567 and mission logs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'review-operator-audit-')); dirs.push(directory);
  const reviewStore = () => new FileDecisionReviewStore(join(directory, 'reviews'), new Uint8Array(32).fill(8));
  const audit = new JsonlOperatorDecisionStore(join(directory, 'audit', 'operator.jsonl'));
  let allowAction = true;
  const authorization = { authorize: () => true, eligible: () => true, eligibleApproval: () => true, authorizeAction: () => allowAction };
  const service = () => new DecisionReviewService(reviewStore(), authorization, () => 2_000);
  const input = (reviewId: string) => ({ reviewId, sourceReceipt: { id: 'source', digest }, evidencePins: [],
    policyPins: [{ id: 'policy-a', version: '1', digest }], reasonCodes: ['review'], riskTier: 'fixture',
    presentation: {}, action: { kind: 'fixture' }, rationale: 'synthetic review', expiresAtEpochMs: 9_000,
    escalationAtEpochMs: 1_500, continuationId: `continuation-${reviewId}`, resumeToken: `token-${reviewId}` });
  await service().create(actor('requester'), input('approval'));
  await service().create(actor('requester'), input('denial'));
  await service().create(actor('requester'), input('escalation'));
  await service().decide(actor('bob'), 'approval', 'approve', 'approved synthetic action');
  await service().decide(actor('carol'), 'denial', 'reject', 'rejected synthetic action');
  await service().escalate(actor('operator'), 'escalation', 'policy deadline');
  allowAction = false;
  await expect(service().resume(actor('bob'), 'approval', 'token-approval', async () => 'must-not-run'))
    .rejects.toThrow(/Authorization is no longer valid/);
  const reviews = await Promise.all(['approval', 'denial', 'escalation'].map(id => reviewStore().read(id, 'tenant-a', 'project-a')));
  const records = [];
  for (const review of reviews) {
    expect(review).not.toBeNull();
    records.push(...await replayReviewOperatorAudit(review!, audit, correlation, 'confidential'));
  }
  expect(records.map(record => record.kind)).toEqual(['approval', 'denial', 'denial', 'escalation']);
  expect(verifyDecisionChain(await audit.read()).ok).toBe(true);
  expect(records.map(record => record.event_id)).toEqual(reviews.flatMap(review => review!.events
    .filter(event => ['approved', 'rejected', 'escalated', 'authorization-denied'].includes(event.type))
    .map(event => event.operatorDecisionEventId)));
  expect(records.every(record => record.correlation.mission_id === correlation.mission_id &&
    record.correlation.sandbox_session_id === correlation.sandbox_session_id)).toBe(true);
  expect(toOpenTelemetryLog(records[0]!).attributes).toContainEqual({ key: 'aiwg.mission.id', value: { stringValue: 'mission-a' } });
  // Restart and replay: no second audit identity and no duplicate record.
  for (const review of reviews) await replayReviewOperatorAudit(review!, new JsonlOperatorDecisionStore(join(directory, 'audit', 'operator.jsonl')), correlation, 'confidential');
  expect(await audit.read()).toHaveLength(4);
  const forged = structuredClone(reviews[0]!);
  forged.events.at(-1)!.operatorDecisionEventId = 'forged';
  expect(() => reviewOperatorDecisionInput(forged, forged.events.at(-1)!, correlation, 'confidential')).toThrow(ReviewIntegrityError);
  await expect(replayReviewOperatorAudit(reviews[0]!, audit, { ...correlation, mission_id: 'other' }, 'confidential'))
    .rejects.toThrow(/Conflicting/);
});
