import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ITEM_STATES, type DecisionJob } from '../../../src/decision/job-contract.js';
import { FileJobPayloadStore } from '../../../src/decision/job-payload-store.js';
import { DecisionJobRuntime, recount } from '../../../src/decision/job-runtime.js';
import { FileJobStore } from '../../../src/decision/job-store.js';
import { OfflineJobWorker } from '../../../src/decision/job-worker.js';
import { artifactDigest } from '../../../src/decision/validate.js';
const scope = { tenantId: 't', projectId: 'p', workspaceId: 'w', principalId: 'actor' };
const digest = `sha256:${'a'.repeat(64)}` as const;
const input = { protected: 'PII_CANARY_2610' };
const result = { decision: 'PII_RESULT_CANARY_2610' };
function fixture(id: string): DecisionJob {
  const value: DecisionJob = { schemaVersion: 'decision-job/v1', id, scope, fingerprint: digest,
    state: 'validating', createdAtEpochMs: 10, expiresAtEpochMs: 100,
    items: [{ id: 'item0', fingerprint: digest, subjectDigest: artifactDigest(input), definitionDigest: digest,
      bindingDigest: digest, state: 'queued', attempts: [] }],
    summary: Object.fromEntries(ITEM_STATES.map(state => [state, 0])) as DecisionJob['summary'],
    budget: { maxAttempts: 2, maxTokens: 100, maxCostMicros: 1000, maxConcurrency: 1 } };
  recount(value); return value;
}
describe('JOB protected input and validated result persistence', () => {
  it('encrypts scoped values, fences results behind receipts, and blocks restored backups with independent D10 authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'job-protected-'));
    try {
      const journal = new FileJobStore(join(root, 'jobs'));
      let erased = false;
      const payloads = new FileJobPayloadStore(join(root, 'payloads'), randomBytes(32), journal,
        async () => erased, { itemBytes: 1024, principalBytes: 2048, projectBytes: 2048 }, () => 20);
      const runtime = new DecisionJobRuntime(journal, () => 20);
      const initial = await runtime.submit(fixture('jobA'), scope);
      await payloads.put(scope, 'jobA', 'item0', 'input', input);
      await payloads.put(scope, 'jobA', 'item0', 'input', input);
      expect(await payloads.get(scope, 'jobA', 'item0', 'input')).toEqual(input);
      await expect(payloads.put(scope, 'jobA', 'item0', 'input', { protected: 'changed' })).rejects.toThrow('pin');
      await expect(payloads.get({ ...scope, projectId: 'other' }, 'jobA', 'item0', 'input')).rejects.toThrow('unavailable');
      await expect(payloads.put(scope, 'jobA', 'item0', 'result', result)).rejects.toThrow('unavailable');
      const queued = structuredClone(initial.job); queued.state = 'queued';
      await runtime.advance(scope, 'jobA', initial, queued);
      await new OfflineJobWorker(runtime).run(scope, 'jobA', 'item0', async () => ({
        state: 'review', resultDigest: artifactDigest(result), receiptDigest: digest }));
      await payloads.put(scope, 'jobA', 'item0', 'result', result);
      expect(await payloads.get(scope, 'jobA', 'item0', 'result')).toEqual(result);
      const names = (await readdir(join(root, 'payloads'))).filter(name => name.endsWith('.json'));
      expect(names).toHaveLength(2);
      const text = (await Promise.all(names.map(name => readFile(join(root, 'payloads', name), 'utf8')))).join('\n');
      expect(text).not.toMatch(/PII_CANARY_2610|PII_RESULT_CANARY_2610|actor|item0/);
      for (const name of names) expect((await stat(join(root, 'payloads', name))).mode & 0o777).toBe(0o600);
      const inputFile = (await Promise.all(names.map(async name => ({ name,
        digest: (JSON.parse(await readFile(join(root, 'payloads', name), 'utf8')) as { digest: string }).digest }))))
        .find(entry => entry.digest === artifactDigest(input))!.name;
      const backup = join(root, 'backup'); await copyFile(join(root, 'payloads', inputFile), backup);
      const altered = JSON.parse(await readFile(join(root, 'payloads', inputFile), 'utf8')) as Record<string, unknown>;
      altered.project = 'a'.repeat(64);
      await writeFile(join(root, 'payloads', inputFile), JSON.stringify(altered));
      await expect(payloads.get(scope, 'jobA', 'item0', 'input')).rejects.toThrow('integrity');
      await copyFile(backup, join(root, 'payloads', inputFile));
      expect(await runtime.remove(scope, 'jobA')).toBe(true);
      erased = true;
      await payloads.purgeDeleted(scope, 'jobA');
      expect((await readdir(join(root, 'payloads'))).filter(name => name.endsWith('.json'))).toHaveLength(0);
      for (const name of (await readdir(join(root, 'payloads'))).filter(name => name.endsWith('.deleted')))
        await rm(join(root, 'payloads', name));
      await copyFile(backup, join(root, 'payloads', inputFile));
      await expect(payloads.get(scope, 'jobA', 'item0', 'input')).rejects.toThrow('unavailable');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('reserves retained value bytes per principal/project and fails closed on altered quota metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'job-protected-limit-'));
    try {
      const journal = new FileJobStore(join(root, 'jobs'));
      const size = Buffer.byteLength(JSON.stringify(input));
      const payloads = new FileJobPayloadStore(join(root, 'payloads'), randomBytes(32), journal,
        async () => false, { itemBytes: size, principalBytes: size + 1, projectBytes: size + 1 }, () => 20);
      const runtime = new DecisionJobRuntime(journal, () => 20);
      await runtime.submit(fixture('jobA'), scope); await runtime.submit(fixture('jobB'), scope);
      await payloads.put(scope, 'jobA', 'item0', 'input', input);
      await expect(payloads.put(scope, 'jobB', 'item0', 'input', input)).rejects.toThrow('limit');
      const [name] = (await readdir(join(root, 'payloads'))).filter(name => name.endsWith('.json'));
      const envelope = JSON.parse(await readFile(join(root, 'payloads', name!), 'utf8')) as Record<string, unknown>;
      envelope.principal = '0'.repeat(64);
      await writeFile(join(root, 'payloads', name!), JSON.stringify(envelope));
      await expect(payloads.put(scope, 'jobB', 'item0', 'input', input)).rejects.toThrow('integrity');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
