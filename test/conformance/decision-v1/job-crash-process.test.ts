import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ITEM_STATES, type DecisionJob } from '../../../src/decision/job-contract.js';
import { DecisionJobRuntime, recount } from '../../../src/decision/job-runtime.js';
import { FileJobStore } from '../../../src/decision/job-store.js';
import { OfflineJobWorker } from '../../../src/decision/job-worker.js';
const digest = `sha256:${'a'.repeat(64)}` as const;
const actor = { tenantId: 't', projectId: 'p', workspaceId: 'w', principalId: 'actor' };
function job(): DecisionJob {
  const value: DecisionJob = { schemaVersion: 'decision-job/v1', id: 'jobA', scope: actor, fingerprint: digest,
    state: 'validating', createdAtEpochMs: 10, expiresAtEpochMs: 100,
    budget: { maxAttempts: 2, maxTokens: 100, maxCostMicros: 1000, maxConcurrency: 1 },
    items: [{ id: 'item0', fingerprint: digest, subjectDigest: digest, definitionDigest: digest,
      bindingDigest: digest, state: 'queued', attempts: [] }],
    summary: Object.fromEntries(ITEM_STATES.map(state => [state, 0])) as DecisionJob['summary'] };
  recount(value); return value;
}
const script = fileURLToPath(new URL('./fixtures/job-crash-child.mjs', import.meta.url));
describe('JOB real cross-process crash fence', () => {
  it('kills a dispatched child and reconciles the journal without a second executor call', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'job-crash-process-'));
    const marker = join(directory, 'dispatched.marker');
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const runtime = new DecisionJobRuntime(new FileJobStore(directory), () => 20);
      const first = await runtime.submit(job(), actor);
      const queued = structuredClone(first.job); queued.state = 'queued';
      await runtime.advance(actor, 'jobA', first, queued);
      child = spawn(process.execPath, ['--import', 'tsx', script, directory, marker],
        { cwd: fileURLToPath(new URL('../../../', import.meta.url)), stdio: 'pipe' });
      let error = '';
      child.stderr?.on('data', data => { error += String(data); });
      const deadline = Date.now() + 15000;
      while (true) {
        try { await access(marker); break; }
        catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure; }
        if (child.exitCode !== null || Date.now() >= deadline) throw new Error(`Child did not reach dispatch fence: ${error.slice(0, 300)}`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const before = await new FileJobStore(directory).read(actor, 'jobA');
      expect(before?.job.items[0]?.attempts).toMatchObject([{ outcome: 'dispatched' }]);
      child.kill('SIGKILL');
      await new Promise<void>(resolve => child!.once('exit', () => resolve()));
      const restarted = new DecisionJobRuntime(new FileJobStore(directory), () => 20);
      const recovered = await restarted.reconcile(actor, 'jobA');
      expect(recovered?.job.items[0]?.state).toBe('execution-unknown');
      expect(recovered?.job.summary['execution-unknown']).toBe(1);
      let calls = 0;
      await expect(new OfflineJobWorker(restarted).run(actor, 'jobA', 'item0', async () => {
        calls++; return { state: 'succeeded', resultDigest: digest, receiptDigest: digest };
      })).rejects.toThrow();
      expect(calls).toBe(0);
      expect(await restarted.reconcile(actor, 'jobA')).toEqual(recovered);
    } finally {
      if (child && child.exitCode === null) child.kill('SIGKILL');
      await rm(directory, { recursive: true, force: true });
    }
  }, 25000);
});
