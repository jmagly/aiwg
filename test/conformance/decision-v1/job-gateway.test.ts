import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ITEM_STATES, type DecisionJob } from '../../../src/decision/job-contract.js';
import { DecisionJobGateway } from '../../../src/decision/job-gateway.js';
import { DecisionJobRuntime, recount } from '../../../src/decision/job-runtime.js';
import { FileJobStore } from '../../../src/decision/job-store.js';
const scope = { tenantId: 't', projectId: 'p', workspaceId: 'w', principalId: 'actor' };
const digest = `sha256:${'a'.repeat(64)}` as const;
function fixture(): DecisionJob {
  const job: DecisionJob = { schemaVersion: 'decision-job/v1', id: 'predictable-id', scope, fingerprint: digest,
    state: 'validating', createdAtEpochMs: 10, expiresAtEpochMs: 100,
    budget: { maxAttempts: 2, maxTokens: 100, maxCostMicros: 1000, maxConcurrency: 1 },
    items: [{ id: 'item0', fingerprint: digest, subjectDigest: digest, definitionDigest: digest,
      bindingDigest: digest, state: 'queued', attempts: [] }],
    summary: Object.fromEntries(ITEM_STATES.map(state => [state, 0])) as DecisionJob['summary'] };
  recount(job); return job;
}
describe('JOB object gateway', () => {
  it('binds opaque randomized handles to authenticated scope, pinned identity, expiry and durable record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'decision-gateway-'));
    try {
      const secret = randomBytes(32); let now = 20;
      const runtime = new DecisionJobRuntime(new FileJobStore(dir), () => now);
      const gateway = new DecisionJobGateway(runtime, secret, () => now);
      const { handle } = await gateway.submit(scope, fixture());
      expect(handle).toMatch(/^dj1_/);
      expect(handle).not.toContain('predictable-id');
      const duplicate = await gateway.submit(scope, fixture());
      expect(duplicate.handle).not.toBe(handle);
      expect(duplicate.snapshot.revision).toBe(1);
      const fresh = new DecisionJobGateway(new DecisionJobRuntime(new FileJobStore(dir), () => now), secret, () => now);
      expect((await fresh.poll(scope, handle))?.job.id).toBe('predictable-id');
      expect((await fresh.items(scope, handle))?.map(item => item.id)).toEqual(['item0']);
      for (const alien of [{ ...scope, projectId: 'other' }, { ...scope, principalId: 'other' },
        { ...scope, workspaceId: 'other' }, { ...scope, tenantId: 'other' }]) {
        expect(await fresh.poll(alien, handle)).toBeNull();
        expect(await fresh.items(alien, handle)).toBeNull();
        expect(await fresh.cancel(alien, handle)).toBeNull();
        expect(await fresh.retry(alien, handle, 'item0')).toBeNull();
        expect(await fresh.remove(alien, handle)).toBe(false);
      }
      const tamperAt = 20;
      expect(await fresh.poll(scope, handle.slice(0, tamperAt) + (handle[tamperAt] === 'A' ? 'B' : 'A') + handle.slice(tamperAt + 1))).toBeNull();
      expect(await fresh.poll(scope, 'predictable-id')).toBeNull();
      expect(await new DecisionJobGateway(runtime, randomBytes(32), () => now).poll(scope, handle)).toBeNull();
      expect((await runtime.poll(scope, 'predictable-id'))?.revision).toBe(1);
      const changed = fixture(); changed.fingerprint = `sha256:${'b'.repeat(64)}`;
      await expect(gateway.submit(scope, changed)).rejects.toThrow();
      now = 100;
      expect(await fresh.poll(scope, handle)).toBeNull();
      expect(await fresh.remove(scope, handle)).toBe(false);
      now = 20;
      expect(await fresh.remove(scope, handle)).toBe(true);
      expect(await fresh.poll(scope, handle)).toBeNull();
      expect(await fresh.cancel(scope, handle)).toBeNull();
      await expect(fresh.submit(scope, fixture())).rejects.toThrow('Job unavailable');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('requires a strong injected host key, not a model-supplied value', () => {
    expect(() => new DecisionJobGateway(new DecisionJobRuntime(new FileJobStore('/unused')), Buffer.alloc(16))).toThrow('key');
  });
});
