import { describe, expect, it } from 'vitest';
import { assertJobTransition, DecisionJobContractError, ITEM_STATES, validateDecisionJob, type DecisionJob, type ItemState } from '../../../src/decision/job-contract.js';
const digest = `sha256:${'a'.repeat(64)}` as const;
function fixture(state: ItemState = 'queued'): DecisionJob {
  return { schemaVersion: 'decision-job/v1', id: 'jobA', scope: { tenantId: 't', projectId: 'p', workspaceId: 'w', principalId: 'actor' },
    fingerprint: digest, state: 'queued', items: [{ id: 'itemA', fingerprint: digest, subjectDigest: digest,
      definitionDigest: digest, bindingDigest: digest, state, attempts: [] }],
    summary: Object.fromEntries(ITEM_STATES.map(name => [name, name === state ? 1 : 0])) as DecisionJob['summary'],
    createdAtEpochMs: 100, expiresAtEpochMs: 1000,
    budget: { maxAttempts: 3, maxTokens: 1000, maxCostMicros: 10000, maxConcurrency: 1 } };
}
describe('JOB offline contract (dispatch disabled)', () => {
  it('JOB-001 validates versioned identity, isolated scope, budgets and exact counts', () => {
    const job = fixture(); expect(() => validateDecisionJob(job)).not.toThrow();
    job.summary.queued = 0;
    expect(() => validateDecisionJob(job)).toThrow(DecisionJobContractError);
  });
  it('JOB-002 rejects duplicate item IDs and unexplained success', () => {
    const job = fixture(); job.items.push({ ...job.items[0]! }); job.summary.queued = 2;
    expect(() => validateDecisionJob(job)).toThrow(DecisionJobContractError);
    const success = fixture('succeeded');
    expect(() => validateDecisionJob(success)).toThrow(DecisionJobContractError);
  });
  it('JOB-003 forbids state skipping and pin, fingerprint, scope and attempt-history mutation', () => {
    const before = fixture(); const after = fixture(); after.state = 'running'; after.items[0]!.state = 'running';
    after.summary.queued = 0; after.summary.running = 1;
    expect(() => assertJobTransition(before, after)).not.toThrow();
    after.items[0]!.definitionDigest = `sha256:${'b'.repeat(64)}`;
    expect(() => assertJobTransition(before, after)).toThrow(DecisionJobContractError);
    after.items[0]!.definitionDigest = digest; after.scope.projectId = 'other';
    expect(() => assertJobTransition(before, after)).toThrow(DecisionJobContractError);
    after.scope.projectId = 'p'; after.state = 'completed';
    expect(() => assertJobTransition(before, after)).toThrow(DecisionJobContractError);
  });
  it('JOB-004 keeps terminal attempt history immutable', () => {
    const before = fixture('execution-unknown'); before.state = 'failed';
    before.items[0]!.attempts = [{ id: 'attemptA', requestDigest: digest, outcome: 'execution-unknown' }];
    const after = structuredClone(before); after.state = 'failed';
    after.items[0]!.attempts.push({ id: 'attemptB', requestDigest: digest, outcome: 'dispatched' });
    expect(() => assertJobTransition(before, after)).toThrow(DecisionJobContractError);
  });
  it('JOB-004 does not report in-flight uncertainty as clean cancellation', () => {
    const job = fixture('execution-unknown'); job.state = 'canceled';
    job.items[0]!.attempts = [{ id: 'attemptA', requestDigest: digest, outcome: 'execution-unknown' }];
    expect(() => validateDecisionJob(job)).toThrow(DecisionJobContractError);
  });
  it('JOB-006 prevents an unstarted item from fabricating dispatch attempts', () => {
    const before = fixture(); const after = fixture(); after.state = 'running'; after.items[0]!.state = 'running';
    after.summary.queued = 0; after.summary.running = 1;
    after.items[0]!.attempts.push({ id: 'first', requestDigest: digest, outcome: 'dispatched' },
      { id: 'forged', requestDigest: digest, outcome: 'dispatched' });
    expect(() => assertJobTransition(before, after)).toThrow(DecisionJobContractError);
  });
  it('JOB-005 rejects unbounded, unexpected and model-authored fields', () => {
    const job = fixture(); job.budget.maxConcurrency = 0;
    expect(() => validateDecisionJob(job)).toThrow(DecisionJobContractError);
    const injected = { ...fixture(), providerAsyncEndpoint: 'execute-action' };
    expect(() => validateDecisionJob(injected)).toThrow(DecisionJobContractError);
  });
});
