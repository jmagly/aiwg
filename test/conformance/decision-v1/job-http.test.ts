import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecisionJobHttpHandler } from '../../../src/decision/job-http.js';
import { createOfflineDecisionJobService } from '../../../src/decision/job-service.js';
import { ITEM_STATES, type DecisionJob } from '../../../src/decision/job-contract.js';
import { recount } from '../../../src/decision/job-runtime.js';
import { artifactDigest } from '../../../src/decision/validate.js';
import { jobPolicy } from './fixtures/job-policy.js';
const scope = { tenantId: 't', projectId: 'p', workspaceId: 'w', principalId: 'actor' };
const digest = `sha256:${'a'.repeat(64)}` as const;
const input = { protected: 'PII_HTTP_INPUT_2610' };
const outcome = { protected: 'PII_HTTP_RESULT_2610' };
function job(): Omit<DecisionJob, 'scope'> {
  const value: DecisionJob = { schemaVersion: 'decision-job/v1', id: 'jobA', scope, fingerprint: digest,
    state: 'validating', createdAtEpochMs: 10, expiresAtEpochMs: 100,
    budget: { maxAttempts: 2, maxTokens: 100, maxCostMicros: 1000, maxConcurrency: 1 },
    items: [{ id: 'item0', fingerprint: digest, subjectDigest: artifactDigest(input), definitionDigest: digest,
      bindingDigest: digest, state: 'queued', attempts: [] }],
    summary: Object.fromEntries(ITEM_STATES.map(state => [state, 0])) as DecisionJob['summary'] };
  recount(value);
  const { scope: _ignored, ...body } = value;
  return body;
}
describe('JOB opt-in authenticated HTTP boundary', () => {
  it('derives identity from host auth and isolates submit/list/cursor/poll/input/result/cancel/export/delete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'job-http-'));
    const erased = new Set<string>();
    const directory = join(root, 'data');
    const limits = { queued: 2, running: 2, retainedItems: 2, retainedBytes: 16000,
      tokens: 500, costMicros: 5000, calls: 4, jobs: 2 };
    const service = createOfflineDecisionJobService({ directory, handleKey: randomBytes(32),
      payloadKey: randomBytes(32), payloadMaxItemBytes: 1024, now: () => 20,
      quota: { project: limits, principal: limits }, lifecyclePolicy: jobPolicy(1000, 'sanitized'),
      polls: { windowMs: 100, perPrincipal: 50, perProject: 50, maxLanes: 4 },
      scheduler: { concurrency: 1, maxQueuedItems: 2 },
      externallyDeleted: async (_actor, id) => erased.has(id), authorizeExport: async () => true });
    expect(() => createDecisionJobHttpHandler({ enabled: false as true, service, authenticate: async () => scope,
      authorizeQueue: async () => true, authorizeResult: async () => true, deleteJob: async () => true,
      maxBodyBytes: 4096 })).toThrow('host');
    const handler = createDecisionJobHttpHandler({ enabled: true, service, maxBodyBytes: 4096,
      authenticate: async req => req.headers['x-fixture-principal'] === 'actor' ? scope :
        req.headers['x-fixture-principal'] === 'neighbor' ? { ...scope, principalId: 'neighbor' } : null,
      authorizeQueue: async () => true,
      authorizeResult: async () => true,
      deleteJob: async (actor, snapshot) => {
        await service.runtime.remove(actor, snapshot.job.id);
        erased.add(snapshot.job.id);
        await service.eraseJob(actor, snapshot.job.id);
        return true;
      } });
    const server = createServer((request, response) => { void handler(request, response); });
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('No local test port');
      const base = `http://127.0.0.1:${address.port}/decision/jobs`;
      const request = (path: string, principal = 'actor', init: RequestInit = {}) =>
        fetch(`${base}${path}`, { ...init, headers: { 'x-fixture-principal': principal,
          ...(init.body ? { 'content-type': 'application/json' } : {}) } });
      expect((await request('', '', { method: 'POST', body: JSON.stringify(job()) })).status).toBe(401);
      expect((await request('', 'actor', { method: 'POST', body: JSON.stringify({ ...job(), scope: { ...scope, principalId: 'neighbor' } }) })).status).toBe(400);
      expect((await request('', 'actor', { method: 'POST', body: 'x'.repeat(5000) })).status).toBe(413);
      const created = await request('', 'actor', { method: 'POST', body: JSON.stringify(job()) });
      expect(created.status).toBe(202);
      const { handle } = await created.json() as { handle: string };
      expect(handle).toMatch(/^dj1_/);
      expect((await request(`/${handle}`, 'neighbor')).status).toBe(404);
      expect((await request(`/${handle}/items/item0/input`, 'neighbor', { method: 'PUT', body: JSON.stringify(input) })).status).toBe(404);
      expect((await request(`/${handle}/queue`, 'actor', { method: 'POST' })).status).toBe(409);
      expect((await request(`/${handle}/items/item0/input`, 'actor', { method: 'PUT', body: JSON.stringify(input) })).status).toBe(204);
      expect((await request(`/${handle}/queue`, 'actor', { method: 'POST' })).status).toBe(202);
      const list = await request('?limit=1');
      expect(list.status).toBe(200);
      expect((await list.json() as { handles: string[] }).handles).toHaveLength(1);
      const items = await request(`/${handle}/items?offset=0&limit=1`);
      expect(items.status).toBe(200);
      expect((await items.json() as { items: Array<{ id: string; state: string }> }).items).toEqual([{ id: 'item0', state: 'queued' }]);
      const work = await service.scheduler.run([{ actor: scope, jobId: 'jobA', itemId: 'item0',
        executor: async () => ({ state: 'review', receiptDigest: digest, resultDigest: artifactDigest(outcome) }) }]);
      expect(work).toHaveLength(1);
      await service.payloads.put(scope, 'jobA', 'item0', 'result', outcome);
      const unauthorized = await request(`/${handle}/items/item0/result`, 'neighbor');
      expect(unauthorized.status).toBe(404);
      expect(await unauthorized.text()).not.toContain('PII_HTTP_RESULT_2610');
      const allowed = await request(`/${handle}/items/item0/result`);
      expect(allowed.status).toBe(200);
      expect((await allowed.json() as { result: typeof outcome }).result).toEqual(outcome);
      expect((await request(`/${handle}/export`)).status).toBe(200);
      expect((await request(`/${handle}/cancel`, 'neighbor', { method: 'POST' })).status).toBe(404);
      expect((await request(`/${handle}`, 'neighbor', { method: 'DELETE' })).status).toBe(404);
      expect((await request(`/${handle}`, 'actor', { method: 'DELETE' })).status).toBe(204);
      expect((await request(`/${handle}`)).status).toBe(404);
      expect((await request(`/${handle}/items/item0/result`)).status).toBe(404);
      const queuedJob = { ...job(), id: 'jobB' };
      const second = await request('', 'actor', { method: 'POST', body: JSON.stringify(queuedJob) });
      expect(second.status).toBe(202);
      const secondHandle = (await second.json() as { handle: string }).handle;
      expect((await request(`/${secondHandle}/items/item0/input`, 'actor', { method: 'PUT', body: JSON.stringify(input) })).status).toBe(204);
      expect((await request(`/${secondHandle}/queue`, 'actor', { method: 'POST' })).status).toBe(202);
      let started!: () => void; let release!: () => void;
      const began = new Promise<void>(resolve => { started = resolve; });
      const hold = new Promise<void>(resolve => { release = resolve; });
      const pending = service.worker.run(scope, 'jobB', 'item0', async () => {
        started(); await hold; return { state: 'succeeded', receiptDigest: digest, resultDigest: artifactDigest(outcome) };
      });
      await began;
      const canceled = await request(`/${secondHandle}/cancel`, 'actor', { method: 'POST' });
      expect(canceled.status).toBe(200);
      release();
      const reconciled = await pending;
      expect(reconciled.job.items[0]?.state).toBe('execution-unknown');
      expect((await request(`/${secondHandle}/items/item0/result`)).status).toBe(404);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);
});
