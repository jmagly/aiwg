import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ITEM_STATES, type DecisionJob } from '../../../src/decision/job-contract.js';
import { createOfflineDecisionJobService } from '../../../src/decision/job-service.js';
import { recount } from '../../../src/decision/job-runtime.js';
import type { JobQuotaLimits } from '../../../src/decision/job-quota.js';
const digest = `sha256:${'a'.repeat(64)}` as const;
const scope = { tenantId: 't', projectId: 'p', workspaceId: 'w', principalId: 'actor' };
const limits: JobQuotaLimits = { queued: 2, running: 2, retainedItems: 2, retainedBytes: 10000,
  tokens: 1000, costMicros: 10000, calls: 4, jobs: 1 };
function fixture(): DecisionJob {
  const job: DecisionJob = { schemaVersion: 'decision-job/v1', id: 'jobA', scope, fingerprint: digest,
    state: 'validating', createdAtEpochMs: 10, expiresAtEpochMs: 100,
    budget: { maxAttempts: 2, maxTokens: 100, maxCostMicros: 1000, maxConcurrency: 1 },
    items: [{ id: 'item0', fingerprint: digest, subjectDigest: digest, definitionDigest: digest,
      bindingDigest: digest, state: 'queued', attempts: [] }],
    summary: Object.fromEntries(ITEM_STATES.map(state => [state, 0])) as DecisionJob['summary'] };
  recount(job); return job;
}
describe('JOB offline host assembly', () => {
  it('wires trusted D10, quotas, polling, object handles, worker, scheduler and telemetry through restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'job-service-'));
    try {
      const handleKey = randomBytes(32);
      const erased = new Set<string>(); const spans: string[] = [];
      const config = { directory, handleKey, now: () => 20,
        quota: { principal: limits, project: limits },
        polls: { windowMs: 100, perPrincipal: 10, perProject: 10, maxLanes: 4 },
        scheduler: { concurrency: 1, maxQueuedItems: 2 },
        externallyDeleted: async (_scope: typeof scope, id: string) => erased.has(id),
        authorizeExport: async (_actor: typeof scope) => false,
        telemetry: { emit(span: { attributes: Record<string, unknown> }) { spans.push(String(span.attributes['aiwg.job.status'])); } },
      };
      const service = createOfflineDecisionJobService(config);
      const { handle, snapshot } = await service.gateway.submit(scope, fixture());
      const queued = structuredClone(snapshot.job); queued.state = 'queued';
      await service.runtime.advance(scope, 'jobA', snapshot, queued);
      let calls = 0;
      const result = await service.scheduler.run([{ actor: scope, jobId: 'jobA', itemId: 'item0',
        executor: async () => { calls++; return { state: 'succeeded', resultDigest: digest, receiptDigest: digest }; } }]);
      expect(result).toHaveLength(1); expect(calls).toBe(1);
      expect((await service.gateway.poll(scope, handle))?.job.summary.succeeded).toBe(1);
      expect(await service.gateway.export(scope, handle)).toBeNull();
      expect((await service.gateway.list(scope))?.handles).toHaveLength(1);
      const restarted = createOfflineDecisionJobService(config);
      expect((await restarted.gateway.poll(scope, handle))?.job.state).toBe('completed');
      expect(await restarted.gateway.poll({ ...scope, projectId: 'other' }, handle)).toBeNull();
      erased.add('jobA');
      expect(await restarted.gateway.poll(scope, handle)).toBeNull();
      await expect(restarted.gateway.submit(scope, fixture())).rejects.toThrow();
      expect(spans).toEqual(['validating', 'queued', 'running', 'completed']);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
