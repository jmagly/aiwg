import { FileJobQuotaStore } from '../../../../src/decision/job-quota.ts';
const digest = `sha256:${'a'.repeat(64)}`;
const [directory, id] = process.argv.slice(2);
const scope = { tenantId: 't', projectId: 'p', workspaceId: 'w', principalId: 'actor' };
const limits = { queued: 1, running: 1, retainedItems: 1, retainedBytes: 10000,
  tokens: 100, costMicros: 1000, calls: 2, jobs: 1 };
const job = { schemaVersion: 'decision-job/v1', id, scope, fingerprint: digest, state: 'validating',
  createdAtEpochMs: 10, expiresAtEpochMs: 100, budget: { maxAttempts: 2, maxTokens: 100, maxCostMicros: 1000, maxConcurrency: 1 },
  items: [{ id: 'item0', fingerprint: digest, subjectDigest: digest, definitionDigest: digest, bindingDigest: digest,
    state: 'queued', attempts: [] }],
  summary: Object.fromEntries(['queued', 'running', 'succeeded', 'abstained', 'review', 'unsupported',
    'retryable-failed', 'permanent-failed', 'canceled', 'expired', 'execution-unknown'].map(state => [state, state === 'queued' ? 1 : 0])) };
try {
  await new FileJobQuotaStore(directory, { principal: limits, project: limits }).acquire(job);
  process.stdout.write('accepted\n');
} catch (error) {
  if (error.message === 'Job capacity unavailable') { process.stdout.write('denied\n'); process.exitCode = 2; }
  else throw error;
}
