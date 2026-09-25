import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDecisionJobHttpHandler } from '../../../src/decision/job-http.js';
import { createOfflineDecisionJobService } from '../../../src/decision/job-service.js';
import { ITEM_STATES, type DecisionJob } from '../../../src/decision/job-contract.js';
import { recount } from '../../../src/decision/job-runtime.js';
import { artifactDigest } from '../../../src/decision/validate.js';
import {
  DecisionReviewService, FileDecisionReviewStore, PinnedReviewAuthorization,
  type LiveReviewAuthority, type PinnedReviewPolicy, type ReviewScope,
} from '../../../src/decision/review/index.js';
import { jobPolicy } from './fixtures/job-policy.js';

// M05 (#2606/#2610/#2614): object-level authorization and non-enumerability.
// Absent and unauthorized objects must be indistinguishable in status, body and headers.
const owner = { tenantId: 't', projectId: 'p', workspaceId: 'w', principalId: 'owner' };
const principals: Record<string, typeof owner> = {
  owner, neighbor: { ...owner, principalId: 'neighbor' }, foreign: { ...owner, projectId: 'q' },
};
const digest = `sha256:${'a'.repeat(64)}` as const;
const input = { protected: 'M05_INPUT_CANARY' };
const outcome = { protected: 'M05_RESULT_CANARY' };
const absentHandle = () => `dj1_${randomBytes(60).toString('base64url')}`;
function job(id: string, items = ['item0']): Omit<DecisionJob, 'scope'> {
  const value: DecisionJob = { schemaVersion: 'decision-job/v1', id, scope: owner, fingerprint: digest,
    state: 'validating', createdAtEpochMs: 10, expiresAtEpochMs: 100,
    budget: { maxAttempts: 2, maxTokens: 100, maxCostMicros: 1000, maxConcurrency: 1 },
    items: items.map(item => ({ id: item, fingerprint: digest, subjectDigest: artifactDigest(input), definitionDigest: digest,
      bindingDigest: digest, state: 'queued' as const, attempts: [] })),
    summary: Object.fromEntries(ITEM_STATES.map(state => [state, 0])) as DecisionJob['summary'] };
  recount(value);
  const { scope: _ignored, ...body } = value;
  return body;
}
interface Observed { status: number; body: string; type: string | null; cache: string | null }
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'm05-enum-'));
  const limits = { queued: 8, running: 8, retainedItems: 8, retainedBytes: 64000,
    tokens: 5000, costMicros: 50000, calls: 16, jobs: 4 };
  const service = createOfflineDecisionJobService({ directory: join(root, 'data'), handleKey: randomBytes(32),
    payloadKey: randomBytes(32), payloadMaxItemBytes: 1024, now: () => 20,
    quota: { project: { ...limits, jobs: 16, retainedItems: 32, retainedBytes: 256000 }, principal: limits },
    lifecyclePolicy: jobPolicy(1000, 'sanitized'),
    polls: { windowMs: 100, perPrincipal: 1000, perProject: 1000, maxLanes: 8 },
    scheduler: { concurrency: 1, maxQueuedItems: 4 },
    externallyDeleted: async () => false, authorizeExport: async () => true });
  const handler = createDecisionJobHttpHandler({ enabled: true, service, maxBodyBytes: 4096,
    authenticate: async req => principals[String(req.headers['x-fixture-principal'])] ?? null,
    authorizeQueue: async () => true, authorizeResult: async () => true,
    deleteJob: async (actor, snapshot) => service.runtime.remove(actor, snapshot.job.id) });
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No local test port');
  const base = `http://127.0.0.1:${address.port}/decision/jobs`;
  const call = async (principal: string, method: string, path: string, body?: unknown): Promise<Observed> => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'x-fixture-principal': principal,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.text(),
      type: response.headers.get('content-type'), cache: response.headers.get('cache-control') };
  };
  const submit = async (principal: string, id: string, items?: string[]): Promise<string> => {
    const created = await call(principal, 'POST', '', job(id, items));
    expect(created.status).toBe(202);
    return (JSON.parse(created.body) as { handle: string }).handle;
  };
  return { service, call, submit };
}
const unavailable = { status: 404, body: '{"error":"unavailable"}', type: 'application/json; charset=utf-8', cache: 'no-store' };

describe('M05 object-level authorization and non-enumerability', () => {
  it('M05-ENUM-JOB-01 foreign read/cancel/queue/export/delete/retry is indistinguishable from an absent job', async () => {
    const h = await harness();
    const handle = await h.submit('owner', 'jobA');
    expect((await h.call('owner', 'PUT', `/${handle}/items/item0/input`, input)).status).toBe(204);
    const before = await h.call('owner', 'GET', `/${handle}`);
    const operations: Array<[string, string]> = [['GET', ''], ['DELETE', ''], ['POST', '/cancel'], ['POST', '/queue'],
      ['GET', '/export'], ['GET', '/items'], ['POST', '/retry/item0']];
    for (const principal of ['neighbor', 'foreign']) {
      for (const [method, suffix] of operations) {
        const real = await h.call(principal, method, `/${handle}${suffix}`);
        const absent = await h.call(principal, method, `/${absentHandle()}${suffix}`);
        expect(real, `${principal} ${method} ${suffix}`).toEqual(unavailable);
        expect(absent).toEqual(real);
      }
    }
    for (const [method, suffix] of operations)
      expect(await h.call('owner', method, `/${absentHandle()}${suffix}`)).toEqual(unavailable);
    expect(await h.call('owner', 'GET', `/${handle}`)).toEqual(before);
    expect((await h.service.runtime.poll(owner, 'jobA'))?.revision).toBe(1);
  });

  it('M05-ENUM-JOB-02 list and cursors leak no foreign handles, IDs, or counts', async () => {
    const h = await harness();
    const empty = { neighbor: await h.call('neighbor', 'GET', ''), foreign: await h.call('foreign', 'GET', '') };
    for (const observed of Object.values(empty)) {
      expect(observed.status).toBe(200);
      expect(JSON.parse(observed.body)).toEqual({ handles: [], next: null });
    }
    const handles = [await h.submit('owner', 'jobA'), await h.submit('owner', 'jobB')];
    expect(await h.call('neighbor', 'GET', '')).toEqual(empty.neighbor);
    expect(await h.call('foreign', 'GET', '?limit=1')).toEqual(empty.foreign);
    const page = await h.call('owner', 'GET', '?limit=1');
    const parsed = JSON.parse(page.body) as { handles: string[]; next: string };
    expect(parsed.handles).toHaveLength(1);
    expect(parsed.next).toMatch(/^dc1_/);
    expect(page.body).not.toMatch(/jobA|jobB|owner/);
    for (const handle of handles) expect(handle).not.toMatch(/jobA|jobB|owner/);
    for (const principal of ['neighbor', 'foreign']) {
      const stolen = await h.call(principal, 'GET', `?cursor=${parsed.next}`);
      const forged = await h.call(principal, 'GET', `?cursor=dc1_${randomBytes(60).toString('base64url')}`);
      expect(stolen).toEqual(unavailable);
      expect(forged).toEqual(stolen);
    }
    // Same caller ID in another scope is a distinct object: no collision oracle, no effect on the owner.
    await h.submit('neighbor', 'jobA');
    await h.submit('foreign', 'jobA');
    expect((await h.service.runtime.poll(owner, 'jobA'))?.revision).toBe(1);
    expect(JSON.parse((await h.call('neighbor', 'GET', '')).body).handles).toHaveLength(1);
    expect(JSON.parse((await h.call('owner', 'GET', '')).body).handles).toHaveLength(2);
  });

  it('M05-ENUM-ITEM-01 foreign item result/input/retry probes match absent items and absent jobs', async () => {
    const h = await harness();
    const handle = await h.submit('owner', 'jobA', ['item0', 'item1']);
    for (const item of ['item0', 'item1'])
      expect((await h.call('owner', 'PUT', `/${handle}/items/${item}/input`, input)).status).toBe(204);
    expect((await h.call('owner', 'POST', `/${handle}/queue`)).status).toBe(202);
    await h.service.scheduler.run([{ actor: owner, jobId: 'jobA', itemId: 'item0',
      executor: async () => ({ state: 'succeeded', receiptDigest: digest, resultDigest: artifactDigest(outcome) }) }]);
    await h.service.payloads.put(owner, 'jobA', 'item0', 'result', outcome);
    expect((await h.call('owner', 'GET', `/${handle}/items/item0/result`)).status).toBe(200);
    const probes: Array<[string, string, unknown?]> = [
      ['GET', '/items/item0/result'], ['GET', '/items/missing/result'], ['GET', '/items/item1/result'],
      ['PUT', '/items/item0/input', input], ['PUT', '/items/missing/input', input],
      ['POST', '/retry/item0'], ['POST', '/retry/missing'], ['GET', '/items?offset=0&limit=1'], ['GET', '/items?offset=1&limit=1'],
    ];
    for (const principal of ['neighbor', 'foreign']) {
      for (const [method, suffix, body] of probes) {
        const real = await h.call(principal, method, `/${handle}${suffix}`, body);
        expect(real, `${principal} ${method} ${suffix}`).toEqual(unavailable);
        expect(await h.call(principal, method, `/${absentHandle()}${suffix}`, body)).toEqual(real);
        expect(real.body).not.toMatch(/M05_|item0|item1|succeeded/);
      }
    }
    // The owner cannot distinguish a missing item from a missing job either.
    expect(await h.call('owner', 'GET', `/${handle}/items/missing/result`)).toEqual(unavailable);
    expect(await h.call('owner', 'GET', `/${handle}/items/item1/result`)).toEqual(unavailable);
    expect(await h.call('owner', 'GET', `/${absentHandle()}/items/item0/result`)).toEqual(unavailable);
    expect(await h.call('owner', 'PUT', `/${handle}/items/missing/input`, input)).toEqual(unavailable);
  });

  it('M05-ENUM-ITEM-02 service-level item and payload access denies foreign scope exactly like absence', async () => {
    const h = await harness();
    const handle = await h.submit('owner', 'jobA');
    await h.service.payloads.put(owner, 'jobA', 'item0', 'input', input);
    for (const actor of [principals.neighbor!, principals.foreign!]) {
      expect(await h.service.runtime.items(actor, 'jobA')).toBeNull();
      expect(await h.service.runtime.items(actor, 'absent')).toBeNull();
      expect(await h.service.gateway.items(actor, handle)).toBeNull();
      expect(await h.service.gateway.retry(actor, handle, 'item0')).toBeNull();
      const real = await h.service.payloads.get(actor, 'jobA', 'item0', 'input').catch((error: Error) => error.message);
      const missing = await h.service.payloads.get(actor, 'absent', 'item0', 'input').catch((error: Error) => error.message);
      expect(real).toBe('Job unavailable');
      expect(missing).toBe(real);
      await expect(h.service.payloads.put(actor, 'jobA', 'item0', 'input', input)).rejects.toThrow('Job unavailable');
    }
    expect(await h.service.payloads.get(owner, 'jobA', 'item0', 'input')).toEqual(input);
  });
});

const policy: PinnedReviewPolicy = {
  id: 'policy-review', version: '1', tenantId: 'tenant-a', projectId: 'project-a',
  requesterRoles: ['requester'], reviewerRoles: ['reviewer'], executorRoles: ['executor'],
  auditorRoles: ['auditor'], operatorRoles: ['operator'], minimumQuorumByRisk: { low: 1 }, retentionWindowMsByRisk: { low: 30_000 },
  separateRequesterReviewer: true, separateEditorReviewer: true, separateReviewerExecutor: true,
};
const roles = new Map([['alice', ['requester']], ['bob', ['reviewer']], ['audit', ['auditor']], ['ops', ['operator']],
  ['mallory', ['requester', 'reviewer', 'executor', 'auditor', 'operator']],
  ['retired', ['reviewer', 'executor', 'auditor', 'operator']]]);
const reviewScope = (id: string, projectId = 'project-a'): ReviewScope => ({ tenantId: 'tenant-a', projectId,
  actor: { id, roles: ['stale-role-from-client'], authorityContext: 'identity/v1' } });
async function reviews(options: { directory?: string; projectId?: string; inactive?: string[] } = {}) {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), 'm05-review-'));
  if (!options.directory) cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const projectId = options.projectId ?? 'project-a';
  const projectPolicy = { ...policy, projectId };
  let principal = 'alice'; let policyDigest: `sha256:${string}` | null = null; let now = 1000;
  const authority: LiveReviewAuthority = {
    authenticate: async candidate => candidate.actor.id === principal && candidate.actor.authorityContext === 'identity/v1',
    resolve: async (_tenant, _project, id) => roles.has(id)
      ? { roles: roles.get(id)!, active: !options.inactive?.includes(id), compromised: false, conflictsWith: [], authorityContext: 'identity/v1' } : null,
    currentPolicyDigest: async () => policyDigest,
  };
  const authorization = new PinnedReviewAuthorization(projectPolicy, authority, async () => true);
  policyDigest = authorization.policyDigest;
  const store = new FileDecisionReviewStore(directory, new Uint8Array(32).fill(7));
  const service = new DecisionReviewService(store, authorization, () => now);
  const create = (reviewId: string) => service.create(reviewScope('alice', projectId), {
    reviewId, sourceReceipt: { id: 'receipt-a', digest }, evidencePins: [],
    policyPins: [{ id: projectPolicy.id, version: projectPolicy.version, digest: authorization.policyDigest }],
    reasonCodes: ['uncertain'], riskTier: 'low', presentation: { summary: 'synthetic' },
    action: { kind: 'fixture' }, rationale: 'review required', expiresAtEpochMs: 20_000, retentionUntilEpochMs: 31_000,
    continuationId: `continuation-${reviewId}`, resumeToken: 'synthetic-resume-token', quorum: 1,
  });
  const act = async <T>(id: string, fn: () => Promise<T>): Promise<T> => { principal = id; return fn(); };
  return { service, store, directory, projectId, create, act, setTime: (value: number) => { now = value; } };
}
const outcomeOf = (promise: Promise<unknown>) => promise.then(
  value => ({ ok: true, value }), (error: Error) => ({ ok: false, name: error.constructor.name, message: error.message }));
/** Every object-level review operation, bound to one caller scope. */
const reviewProbes = (service: DecisionReviewService, scope: ReviewScope): Array<[string, (id: string) => Promise<unknown>]> => [
  ['read', id => service.read(scope, id)], ['export', id => service.export(scope, id)],
  ['claim', id => service.claim(scope, id, 'probe')], ['decide', id => service.decide(scope, id, 'approve', 'probe')],
  ['cancel', id => service.cancel(scope, id, 'probe')], ['escalate', id => service.escalate(scope, id, 'probe')],
  ['edit', id => service.edit(scope, id, { kind: 'other' }, 'probe', 'fresh-token')],
  ['legal-hold', id => service.setLegalHold(scope, id, true, 'probe')], ['delete', id => service.delete(scope, id, 'probe')],
  ['tombstone', id => service.tombstone(scope, id, 'probe')], ['audit-sync', id => service.syncOperatorAudit(scope, id)],
  ['resume', id => service.resume(scope, id, 'synthetic-resume-token', async () => 'effect')],
  ['expire', id => service.expireDue(scope, id)], ['purge', id => service.purge(scope, id)],
];

describe('M05 review non-enumerability', () => {
  it('M05-ENUM-REVIEW-01 foreign-project read/list/export/mutations match a nonexistent review', async () => {
    const h = await reviews();
    const foreign = reviewScope('mallory', 'other');
    const emptyList = await h.act('mallory', () => h.service.list(foreign));
    await h.act('alice', () => h.create('review-a'));
    expect(await h.act('audit', () => h.service.read(reviewScope('audit'), 'review-a'))).not.toBeNull();
    expect(await h.act('mallory', () => h.service.list(foreign))).toEqual(emptyList);
    expect(emptyList).toEqual([]);
    const probes: Array<(id: string) => Promise<unknown>> = [
      id => h.service.read(foreign, id), id => h.service.export(foreign, id),
      id => h.service.claim(foreign, id, 'probe'), id => h.service.decide(foreign, id, 'approve', 'probe'),
      id => h.service.cancel(foreign, id, 'probe'), id => h.service.escalate(foreign, id, 'probe'),
      id => h.service.edit(foreign, id, { kind: 'other' }, 'probe', 'fresh-token'),
      id => h.service.setLegalHold(foreign, id, true, 'probe'), id => h.service.delete(foreign, id, 'probe'),
      id => h.service.tombstone(foreign, id, 'probe'), id => h.service.syncOperatorAudit(foreign, id),
      id => h.service.resume(foreign, id, 'synthetic-resume-token', async () => 'effect'),
      id => h.service.purge(foreign, id),
    ];
    for (const probe of probes) {
      const real = await h.act('mallory', () => outcomeOf(probe('review-a')));
      const absent = await h.act('mallory', () => outcomeOf(probe('review-absent')));
      expect(absent).toEqual(real);
      expect(real).toMatchObject(real.ok ? { value: null } : { name: 'ReviewAccessError' });
      expect(JSON.stringify(real)).not.toMatch(/synthetic|review-a/);
    }
    const stored = await h.store.read('review-a', 'tenant-a', 'project-a');
    expect(stored?.revision).toBe(1);
    expect(stored?.status).toBe('pending');
  });

  it('M05-ENUM-REVIEW-02 tombstoned reviews read and list like absent reviews, and foreign purge discloses nothing', async () => {
    const h = await reviews();
    await h.act('alice', () => h.create('review-a'));
    await h.act('ops', () => h.service.tombstone(reviewScope('ops'), 'review-a', 'retention'));
    expect(await h.act('audit', () => h.service.read(reviewScope('audit'), 'review-a'))).toBeNull();
    expect(await h.act('audit', () => h.service.read(reviewScope('audit'), 'review-absent'))).toBeNull();
    expect(await h.act('audit', () => h.service.list(reviewScope('audit')))).toEqual([]);
    h.setTime(31_000);
    const foreign = reviewScope('ops', 'other');
    const real = await h.act('ops', () => outcomeOf(h.service.purge(foreign, 'review-a')));
    const absent = await h.act('ops', () => outcomeOf(h.service.purge(foreign, 'review-absent')));
    expect(real).toMatchObject({ ok: false, name: 'ReviewAccessError' });
    expect(absent).toEqual(real);
    expect((await h.store.read('review-a', 'tenant-a', 'project-a'))?.status).toBe('tombstoned');
  });

  // #2674 regression: the store was keyed by review ID alone, so reusing an ID in another
  // project collided ('Review ID already exists') and listing parsed every scope's files.
  it('M05-ENUM-REVIEW-03 the same review ID in two projects is two isolated objects with no collision oracle', async () => {
    const a = await reviews();
    const b = await reviews({ directory: a.directory, projectId: 'project-b' });
    expect(a.store.scopeDirectory('tenant-a', 'project-a')).not.toBe(b.store.scopeDirectory('tenant-a', 'project-b'));
    const created = await a.act('alice', () => a.create('shared-id'));
    expect(created.projectId).toBe('project-a');
    // Creating the same ID in another project succeeds instead of disclosing the first object.
    const reused = await b.act('alice', () => b.create('shared-id'));
    expect(reused).toMatchObject({ reviewId: 'shared-id', projectId: 'project-b', revision: 1 });
    // A second create in the same project is still a conflict, so the check above is not vacuous.
    await expect(a.act('alice', () => a.create('shared-id'))).rejects.toThrow('Review ID already exists');
    expect((await a.act('audit', () => a.service.read(reviewScope('audit', 'project-a'), 'shared-id')))?.projectId).toBe('project-a');
    expect((await b.act('audit', () => b.service.read(reviewScope('audit', 'project-b'), 'shared-id')))?.projectId).toBe('project-b');
    // A mutation in one project leaves the other project's object untouched.
    expect((await b.act('bob', () => b.service.claim(reviewScope('bob', 'project-b'), 'shared-id', 'claim'))).revision).toBe(2);
    await b.act('ops', () => b.service.tombstone(reviewScope('ops', 'project-b'), 'shared-id', 'retention'));
    const untouched = await a.store.read('shared-id', 'tenant-a', 'project-a');
    expect(untouched).toMatchObject({ projectId: 'project-a', revision: 1, status: 'pending' });
    expect(await a.act('audit', () => a.service.read(reviewScope('audit', 'project-a'), 'shared-id'))).not.toBeNull();
    // Each scope lists only its own object.
    expect((await a.store.list('tenant-a', 'project-a')).map(item => [item.projectId, item.status])).toEqual([['project-a', 'pending']]);
    expect((await b.store.list('tenant-a', 'project-b')).map(item => [item.projectId, item.status])).toEqual([['project-b', 'tombstoned']]);
    expect(await a.store.list('tenant-a', 'project-c')).toEqual([]);
    expect((await a.act('audit', () => a.service.list(reviewScope('audit', 'project-a')))).map(item => item.projectId)).toEqual(['project-a']);
    // A third project probing the reused ID sees exactly what it sees for an absent ID.
    const c = await reviews({ directory: a.directory, projectId: 'project-c' });
    for (const [name, probe] of reviewProbes(c.service, reviewScope('mallory', 'project-c'))) {
      const real = await c.act('mallory', () => outcomeOf(probe('shared-id')));
      expect(await c.act('mallory', () => outcomeOf(probe('absent-id'))), name).toEqual(real);
      expect(JSON.stringify(real), name).not.toMatch(/project-a|project-b|synthetic/);
    }
    expect(await a.store.read('shared-id', 'tenant-a', 'project-a')).toEqual(untouched);
  });

  // #2674 regression: an existing review denied to a same-project caller raised
  // 'Review access denied' while an absent one raised 'Review not found'.
  it('M05-ENUM-REVIEW-04 same-project callers without authority get the absent-review outcome for every operation', async () => {
    const h = await reviews({ inactive: ['retired'] });
    const before = { alice: await h.act('alice', () => h.service.list(reviewScope('alice'))) };
    await h.act('alice', () => h.create('review-a'));
    const stored = await h.store.read('review-a', 'tenant-a', 'project-a');
    // alice is the requester (no reviewer/auditor/operator role), 'nobody' is unknown to
    // the identity authority, and 'retired' holds every role but is inactive.
    for (const principal of ['alice', 'nobody', 'retired']) {
      const scope = reviewScope(principal);
      expect(await h.act(principal, () => h.service.list(scope)), principal).toEqual([]);
      for (const [name, probe] of reviewProbes(h.service, scope)) {
        const real = await h.act(principal, () => outcomeOf(probe('review-a')));
        const absent = await h.act(principal, () => outcomeOf(probe('review-absent')));
        expect(real, `${principal} ${name}`).toEqual(absent);
        expect(real, `${principal} ${name}`).toEqual(real.ok ? { ok: true, value: null }
          : { ok: false, name: 'ReviewAccessError', message: 'Review not found' });
        expect(JSON.stringify(real)).not.toMatch(/access denied|synthetic|review-a/i);
      }
    }
    expect(before.alice).toEqual([]);
    // No denied probe changed the review: same revision, same single creation event.
    expect(await h.store.read('review-a', 'tenant-a', 'project-a')).toEqual(stored);
    expect(stored).toMatchObject({ revision: 1, status: 'pending' });
    // The authorized reviewer still sees it, so the denials above are not an absent object.
    expect(await h.act('audit', () => h.service.read(reviewScope('audit'), 'review-a'))).not.toBeNull();
  });
});
