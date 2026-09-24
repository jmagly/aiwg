import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileDecisionLifecycleStore } from '../../../src/decision/file-lifecycle-store.js';
import { DECISION_LIFECYCLE_SURFACES, DECISION_LIFECYCLE_VERSION, eraseDecisionSubject,
  mayRestoreDecisionReference, placeDecisionLifecycleHold, releaseDecisionLifecycleHold,
  type DecisionLifecyclePolicy } from '../../../src/decision/lifecycle.js';
import { ITEM_STATES, type DecisionJob } from '../../../src/decision/job-contract.js';
import { DecisionJobRuntime, recount } from '../../../src/decision/job-runtime.js';
import { FileJobStore } from '../../../src/decision/job-store.js';
const digest = `sha256:${'a'.repeat(64)}` as const;
const scope = { tenantId: 't', projectId: 'p', workspaceId: 'w', principalId: 'actor' };
const policy = (): DecisionLifecyclePolicy => ({ version: DECISION_LIFECYCLE_VERSION,
  surfaces: Object.fromEntries(DECISION_LIFECYCLE_SURFACES.map(surface => [surface, {
    classification: 'restricted', accessScopes: ['case-worker'], retentionMs: 100, export: 'denied',
    deletion: 'erase', backup: 'expire-with-primary',
  }])) as DecisionLifecyclePolicy['surfaces'] });
function job(): DecisionJob {
  const value: DecisionJob = { schemaVersion: 'decision-job/v1', id: 'jobA', scope, fingerprint: digest,
    state: 'validating', createdAtEpochMs: 10, expiresAtEpochMs: 100,
    items: [{ id: 'itemA', fingerprint: digest, subjectDigest: digest, bindingDigest: digest,
      definitionDigest: digest, state: 'queued', attempts: [] }],
    summary: Object.fromEntries(ITEM_STATES.map(state => [state, 0])) as DecisionJob['summary'],
    budget: { maxAttempts: 2, maxTokens: 100, maxCostMicros: 1000, maxConcurrency: 1 } };
  recount(value); return value;
}
describe('JOB D10 lifecycle integration', () => {
  it('holds, tombstones and purges content; an independent lifecycle ledger blocks backup resurrection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'job-lifecycle-'));
    try {
      const jobs = join(root, 'jobs'); const backup = join(root, 'backup');
      let lifecycle!: FileDecisionLifecycleStore;
      const record = new FileJobStore(jobs, async (_actor, id) =>
        (await lifecycle.tombstones('case7')).some(t => t.reference.surface === 'job' && t.reference.opaqueId === id));
      lifecycle = new FileDecisionLifecycleStore(join(root, 'lifecycle'), { job: id => record.purgeDeleted(scope, id) });
      await lifecycle.register('case7', { surface: 'job', opaqueId: 'jobA' });
      const runtime = new DecisionJobRuntime(record, () => 20);
      await runtime.submit(job(), scope);
      const hold = { subject: 'case7', reason: 'review', scope: ['job' as const], expiresAt: 300, authorizedBy: 'operator' };
      await placeDecisionLifecycleHold(hold, async () => true, lifecycle, 20);
      await runtime.setLegalHold(scope, 'jobA', true);
      await expect(runtime.remove(scope, 'jobA')).rejects.toThrow();
      await expect(eraseDecisionSubject('case7', policy(), lifecycle, 30)).rejects.toThrow(/hold/);
      await releaseDecisionLifecycleHold(hold, 'operator', 'approved', async () => true, lifecycle, 31);
      await runtime.setLegalHold(scope, 'jobA', false);
      expect(await runtime.remove(scope, 'jobA')).toBe(true);
      const before = (await readdir(jobs)).filter(name => name.endsWith('.json'));
      await mkdir(backup);
      for (const name of before) await copyFile(join(jobs, name), join(backup, name));
      const tombstones = await eraseDecisionSubject('case7', policy(), lifecycle, 40);
      expect(tombstones).toHaveLength(1);
      expect((await readdir(jobs)).filter(name => name.endsWith('.json'))).toHaveLength(0);
      expect(mayRestoreDecisionReference({ surface: 'job', opaqueId: 'jobA' }, 10, 41, policy(), tombstones)).toBe(false);
      // Restore a pre-erasure backup even after losing the local marker. The independent
      // lifecycle authority must still prevent polling and ID reuse.
      for (const name of (await readdir(jobs)).filter(name => name.endsWith('.deleted'))) await rm(join(jobs, name));
      for (const name of before) await copyFile(join(backup, name), join(jobs, name));
      const restarted = new FileJobStore(jobs, async (_actor, id) =>
        (await lifecycle.tombstones('case7')).some(t => t.reference.surface === 'job' && t.reference.opaqueId === id));
      expect(await restarted.read(scope, 'jobA')).toBeNull();
      await expect(restarted.acquire(job())).rejects.toThrow('Job tombstoned');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
