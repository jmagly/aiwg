import { createHash, createPrivateKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DecisionReviewService, FileDecisionReviewStore, openReviewEffectLedger, reviewDigest,
  type ReviewAuthorization, type ReviewScope,
} from '../../../../src/decision/review/index.js';
import { memoryCheckpointSink, staticKeyProvider, type EffectVerifierObservation, type EffectVerifierRequest } from '../../../../src/effects/index.js';

// Shared by the D13 effect-ledger crash matrix (#2721) and its child process.
export const REVIEW_ID = 'effect-crash-review';
export const TOKEN = 'effect-crash-token';
export const CONTINUATION = 'effect-crash-continuation';
export const tenant = { tenantId: 'tenant-c', projectId: 'project-c' };
export const ACTION = { kind: 'fixture', value: 'guarded' };
const storeKey = new Uint8Array(32).fill(5);
const digest = `sha256:${'e'.repeat(64)}` as const;
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ledgerSeed = createHash('sha256').update('aiwg-review-effect-crash-test-key').digest();

export const effectId = reviewDigest({ reviewId: REVIEW_ID, continuationId: CONTINUATION, proposalVersion: 1 });
export const actionDigest = reviewDigest(ACTION);

export const authorization: ReviewAuthorization = {
  authorize: (scope, operation) => operation === 'create' ? scope.actor.roles.includes('requester') : !scope.actor.roles.includes('requester'),
  eligible: scope => scope.actor.roles.includes('reviewer') || scope.actor.roles.includes('executor'),
  eligibleApproval: (_scope, _review, _proposal, decision) => decision.reviewer.roles.includes('reviewer'),
  authorizeAction: () => true,
};
export const actor = (id: string, role: 'requester' | 'reviewer' | 'executor'): ReviewScope =>
  ({ ...tenant, actor: { id, roles: [role], authorityContext: 'effect-crash-fixture/v1' } });

export const paths = (directory: string) => ({ store: join(directory, 'reviews'), effects: join(directory, 'target.log') });
export const openStore = (directory: string) => new FileDecisionReviewStore(paths(directory).store, storeKey);
export const openService = (directory: string, now: () => number) =>
  new DecisionReviewService(openStore(directory), authorization, now, { resumingLeaseMs: 1_000, pollIntervalMs: 5 });

/** Lines the external target received; each carries the effect ID it was sent with. */
export async function targetLines(directory: string): Promise<string[]> {
  try { return (await readFile(paths(directory).effects, 'utf8')).split('\n').filter(Boolean); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

export type ProbeMode = 'truthful' | 'absent' | 'unknown';
/** The host execution probe: looks for the effect ID at the target, or is forced to a result. */
export const probe = (directory: string, mode: ProbeMode) => async (request: EffectVerifierRequest): Promise<EffectVerifierObservation> => {
  if (mode === 'unknown') return { result: 'unknown', reason: 'network-error', complete: false };
  const found = (await targetLines(directory)).includes(request.effectId);
  if (mode === 'absent' || !found) return { result: 'absent', reason: 'complete-query-no-match', complete: true, evidence: { found: false } };
  return { result: 'present', reason: 'marker-match', complete: true, evidence: { found: true } };
};

export function openJournal(directory: string, mode: ProbeMode = 'truthful') {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, ledgerSeed]), format: 'der', type: 'pkcs8' });
  return openReviewEffectLedger({
    projectDir: directory, ...tenant, writer: 'review-executor', keyProvider: staticKeyProvider(key),
    store: openStore(directory), execution: probe(directory, mode), sink: memoryCheckpointSink(), independentOf: [storeKey],
  });
}

export function createInput() {
  return {
    reviewId: REVIEW_ID, sourceReceipt: { id: 'effect-crash-receipt', digest }, evidencePins: [{ id: 'evidence', version: '1', digest }],
    policyPins: [{ id: 'policy', version: '1', digest }], reasonCodes: ['effect-crash-fixture'], riskTier: 'low',
    presentation: { summary: 'synthetic effect ledger crash review' }, action: ACTION,
    rationale: 'review required', expiresAtEpochMs: 1_000_000, continuationId: CONTINUATION, resumeToken: TOKEN,
  };
}
