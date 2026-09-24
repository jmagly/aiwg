import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ITEM_STATES, type DecisionJob } from '../../../src/decision/job-contract.js';
import { createOfflineDecisionJobService } from '../../../src/decision/job-service.js';
import { FileDecisionLifecycleStore } from '../../../src/decision/file-lifecycle-store.js';
import { DECISION_LIFECYCLE_SURFACES, DECISION_LIFECYCLE_VERSION, eraseDecisionSubject,
  mayRestoreDecisionReference, placeDecisionLifecycleHold, releaseDecisionLifecycleHold,
  type DecisionLifecyclePolicy } from '../../../src/decision/lifecycle.js';
import { recount } from '../../../src/decision/job-runtime.js';
import { artifactDigest } from '../../../src/decision/validate.js';
import { canonicalJson } from '../../../src/security/artifact-trust.js';
import type { JobQuotaLimits } from '../../../src/decision/job-quota.js';
const digest = `sha256:${'a'.repeat(64)}` as const;
const input = { privateValue: 'CANARY_INPUT_2610' };
const resultValue = { privateValue: 'CANARY_RESULT_2610' };
const scope = { tenantId: 't', projectId: 'p', workspaceId: 'w', principalId: 'actor' };
const limits: JobQuotaLimits = { queued: 2, running: 2, retainedItems: 2, retainedBytes: 10000,
  tokens: 1000, costMicros: 10000, calls: 4, jobs: 1 };
function fixture(): DecisionJob {
  const job: DecisionJob = { schemaVersion: 'decision-job/v1', id: 'jobA', scope, fingerprint: digest,
    state: 'validating', createdAtEpochMs: 10, expiresAtEpochMs: 100,
    budget: { maxAttempts: 2, maxTokens: 100, maxCostMicros: 1000, maxConcurrency: 1 },
    items: [{ id: 'item0', fingerprint: digest, subjectDigest: artifactDigest(input), definitionDigest: digest,
      bindingDigest: digest, state: 'queued', attempts: [] }],
    summary: Object.fromEntries(ITEM_STATES.map(state => [state, 0])) as DecisionJob['summary'] };
  recount(job); return job;
}
describe('JOB offline host assembly', () => {
  it('joins real D10 hold, erase, and backup-restore policy to encrypted job content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'job-service-d10-'));
    try {
      const directory = join(root, 'data');
      const handleKey = randomBytes(32); const payloadKey = randomBytes(32);
      let lifecycle!: FileDecisionLifecycleStore;
      const config = { directory, handleKey, payloadKey, payloadMaxItemBytes: 512, now: () => 20,
        quota: { principal: limits, project: limits },
        polls: { windowMs: 100, perPrincipal: 20, perProject: 20, maxLanes: 2 },
        scheduler: { concurrency: 1, maxQueuedItems: 2 },
        externallyDeleted: async (_actor: typeof scope, id: string) =>
          (await lifecycle.tombstones('case7')).some(value => value.reference.surface === 'job' && value.reference.opaqueId === id),
        authorizeExport: async () => false };
      const service = createOfflineDecisionJobService(config);
      lifecycle = new FileDecisionLifecycleStore(join(root, 'lifecycle'), { job: id => service.eraseJob(scope, id) });
      const policy: DecisionLifecyclePolicy = { version: DECISION_LIFECYCLE_VERSION,
        surfaces: Object.fromEntries(DECISION_LIFECYCLE_SURFACES.map(surface => [surface, {
          classification: 'restricted', accessScopes: ['case-worker'], retentionMs: 100,
          export: 'denied', deletion: 'erase', backup: 'expire-with-primary',
        }])) as DecisionLifecyclePolicy['surfaces'] };
      await lifecycle.register('case7', { surface: 'job', opaqueId: 'jobA' });
      const { handle } = await service.gateway.submit(scope, fixture());
      await service.payloads.put(scope, 'jobA', 'item0', 'input', input);
      const hold = { subject: 'case7', reason: 'review', scope: ['job' as const], expiresAt: 90, authorizedBy: 'operator' };
      await placeDecisionLifecycleHold(hold, async () => true, lifecycle, 20);
      await service.runtime.setLegalHold(scope, 'jobA', true);
      await expect(service.gateway.remove(scope, handle)).rejects.toThrow('hold');
      await expect(eraseDecisionSubject('case7', policy, lifecycle, 30)).rejects.toThrow('hold');
      await releaseDecisionLifecycleHold(hold, 'operator', 'approved', async () => true, lifecycle, 31);
      await service.runtime.setLegalHold(scope, 'jobA', false);
      expect(await service.gateway.remove(scope, handle)).toBe(true);
      const backup = join(root, 'backup'); await mkdir(backup);
      const names = (await readdir(directory)).filter(name => /^[a-f0-9]{64}(\.r[0-9]+|\.[a-f0-9]{64})\.json$/.test(name));
      for (const name of names) await copyFile(join(directory, name), join(backup, name));
      const tombstones = await eraseDecisionSubject('case7', policy, lifecycle, 40);
      expect(tombstones).toHaveLength(1);
      expect(mayRestoreDecisionReference({ surface: 'job', opaqueId: 'jobA' }, 10, 41, policy, tombstones)).toBe(false);
      expect((await readdir(directory)).filter(name => names.includes(name))).toHaveLength(0);
      for (const name of (await readdir(directory)).filter(name => name.endsWith('.deleted'))) await rm(join(directory, name));
      for (const name of names) await copyFile(join(backup, name), join(directory, name));
      const restarted = createOfflineDecisionJobService(config);
      expect(await restarted.gateway.poll(scope, handle)).toBeNull();
      await expect(restarted.payloads.get(scope, 'jobA', 'item0', 'input')).rejects.toThrow('unavailable');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('counts protected payloads and journal metadata in one transactional retained-byte ceiling', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'job-service-byte-cap-'));
    try {
      const valueBytes = Buffer.byteLength(canonicalJson(input));
      const metadataBytes = Buffer.byteLength(canonicalJson(fixture()));
      const cap = 2 * metadataBytes + valueBytes - 1;
      const byteLimits = { ...limits, jobs: 2, queued: 2, retainedItems: 2,
        tokens: 2000, costMicros: 20000, calls: 8, retainedBytes: cap };
      const service = createOfflineDecisionJobService({ directory, handleKey: randomBytes(32),
        payloadKey: randomBytes(32), payloadMaxItemBytes: valueBytes,
        quota: { principal: byteLimits, project: byteLimits },
        polls: { windowMs: 100, perPrincipal: 5, perProject: 5, maxLanes: 2 },
        scheduler: { concurrency: 1, maxQueuedItems: 2 },
        externallyDeleted: async () => false, authorizeExport: async () => false, now: () => 20 });
      await service.gateway.submit(scope, fixture());
      await service.payloads.put(scope, 'jobA', 'item0', 'input', input);
      const second = fixture(); second.id = 'jobB';
      await expect(service.gateway.submit(scope, second)).rejects.toThrow('capacity');
      expect(await service.runtime.poll(scope, 'jobB')).toBeNull();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('wires trusted D10, quotas, polling, object handles, worker, scheduler and telemetry through restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'job-service-'));
    try {
      const handleKey = randomBytes(32); const payloadKey = randomBytes(32);
      const erased = new Set<string>(); const spans: string[] = [];
      const config = { directory, handleKey, payloadKey, payloadMaxItemBytes: 512, now: () => 20,
        quota: { principal: limits, project: limits },
        polls: { windowMs: 100, perPrincipal: 10, perProject: 10, maxLanes: 4 },
        scheduler: { concurrency: 1, maxQueuedItems: 2 },
        externallyDeleted: async (_scope: typeof scope, id: string) => erased.has(id),
        authorizeExport: async (_actor: typeof scope) => false,
        telemetry: { emit(span: { attributes: Record<string, unknown> }) { spans.push(String(span.attributes['aiwg.job.status'])); } },
      };
      const service = createOfflineDecisionJobService(config);
      const { handle, snapshot } = await service.gateway.submit(scope, fixture());
      await service.payloads.put(scope, 'jobA', 'item0', 'input', input);
      expect(await service.payloads.get(scope, 'jobA', 'item0', 'input')).toEqual(input);
      const queued = structuredClone(snapshot.job); queued.state = 'queued';
      await service.runtime.advance(scope, 'jobA', snapshot, queued);
      let calls = 0;
      const result = await service.scheduler.run([{ actor: scope, jobId: 'jobA', itemId: 'item0',
        executor: async () => { calls++; return { state: 'succeeded', resultDigest: artifactDigest(resultValue), receiptDigest: digest }; } }]);
      expect(result).toHaveLength(1); expect(calls).toBe(1);
      await service.payloads.put(scope, 'jobA', 'item0', 'result', resultValue);
      expect(await service.payloads.get(scope, 'jobA', 'item0', 'result')).toEqual(resultValue);
      expect((await service.gateway.poll(scope, handle))?.job.summary.succeeded).toBe(1);
      expect(await service.gateway.export(scope, handle)).toBeNull();
      expect((await service.gateway.list(scope))?.handles).toHaveLength(1);
      const restarted = createOfflineDecisionJobService(config);
      expect((await restarted.gateway.poll(scope, handle))?.job.state).toBe('completed');
      expect(await restarted.gateway.poll({ ...scope, projectId: 'other' }, handle)).toBeNull();
      await expect(restarted.eraseJob(scope, 'jobA')).rejects.toThrow('tombstone');
      expect(await restarted.gateway.remove(scope, handle)).toBe(true);
      erased.add('jobA');
      await restarted.eraseJob(scope, 'jobA');
      await restarted.eraseJob(scope, 'jobA');
      expect((await readdir(directory)).filter(name => /^[a-f0-9]{64}(\.r[0-9]+|\.[a-f0-9]{64})\.json$/.test(name))).toHaveLength(0);
      expect(await restarted.gateway.poll(scope, handle)).toBeNull();
      await expect(restarted.payloads.get(scope, 'jobA', 'item0', 'result')).rejects.toThrow('unavailable');
      await expect(restarted.gateway.submit(scope, fixture())).rejects.toThrow();
      expect(spans).toEqual(['validating', 'queued', 'running', 'completed', 'completed']);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
