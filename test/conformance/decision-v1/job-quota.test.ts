import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ITEM_STATES, type DecisionJob } from '../../../src/decision/job-contract.js';
import { DecisionJobRuntime, recount } from '../../../src/decision/job-runtime.js';
import { FileJobQuotaStore, recoverStaleJobQuotaLock, type JobQuotaLimits } from '../../../src/decision/job-quota.js';
const scope = { tenantId: 't', projectId: 'p', workspaceId: 'w', principalId: 'actor' };
const digest = `sha256:${'a'.repeat(64)}` as const;
const limits: JobQuotaLimits = { queued: 1, running: 1, retainedItems: 1, retainedBytes: 10000,
  tokens: 100, costMicros: 1000, calls: 2, jobs: 1 };
function job(id: string, actor = scope): DecisionJob {
  const value: DecisionJob = { schemaVersion: 'decision-job/v1', id, scope: actor, fingerprint: digest, state: 'validating',
    createdAtEpochMs: 10, expiresAtEpochMs: 100, budget: { maxAttempts: 2, maxTokens: 100, maxCostMicros: 1000, maxConcurrency: 1 },
    items: [{ id: 'item0', fingerprint: digest, subjectDigest: digest, definitionDigest: digest, bindingDigest: digest,
      state: 'queued', attempts: [] }],
    summary: Object.fromEntries(ITEM_STATES.map(state => [state, 0])) as DecisionJob['summary'] };
  recount(value); return value;
}
const child = fileURLToPath(new URL('./fixtures/job-quota-child.mjs', import.meta.url));
function fork(directory: string, id: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ['--import', 'tsx', child, directory, id],
      { cwd: fileURLToPath(new URL('../../../', import.meta.url)) });
    let output = ''; process.stdout.on('data', chunk => { output += String(chunk); });
    process.stderr.on('data', chunk => { output += String(chunk); });
    process.on('error', reject); process.on('close', code => resolve({ code, output }));
  });
}
describe('JOB transactional local-filesystem quotas', () => {
  it('recovers a dead-owner lock only after explicit host authorization; never steals a live lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'job-quota-recovery-'));
    try {
      const store = new FileJobQuotaStore(dir, { principal: limits, project: limits });
      const lock = join(dir, '.quota-lock');
      await mkdir(lock);
      const live = `${process.pid}:${randomUUID()}`;
      await writeFile(join(lock, 'owner'), `${live}\n`, { mode: 0o600 });
      let approvals = 0;
      expect(await recoverStaleJobQuotaLock(dir, async () => { approvals++; return true; })).toBe(false);
      expect(approvals).toBe(0);
      const dead = `99999999:${randomUUID()}`;
      await writeFile(join(lock, 'owner'), `${dead}\n`);
      expect(await recoverStaleJobQuotaLock(dir, async () => false)).toBe(false);
      expect(await recoverStaleJobQuotaLock(dir, async owner => { approvals++; expect(owner.token).toBe(dead); return true; })).toBe(true);
      expect(await store.acquire(job('recovered'))).toMatchObject({ owner: true });
      expect(await recoverStaleJobQuotaLock(dir, async () => true)).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('recovers a quota lock after its real owner process is killed without running unapproved work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'job-quota-killed-owner-'));
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { mkdir, writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { randomUUID } from 'node:crypto';
      const dir = process.argv[1];
      await mkdir(join(dir, '.quota-lock'), { mode: 0o700 });
      await writeFile(join(dir, '.quota-lock', 'owner'), process.pid + ':' + randomUUID() + '\\n', { mode: 0o600 });
      process.stdout.write('locked\\n');
      setInterval(() => {}, 1000);
    `, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      // AC5 exemption (#2604): wait for a real child process to publish its lock before
      // SIGKILL. The event comes from another process, so fake timers cannot stand in for
      // it; the wall-clock timer only bounds a hung child and never decides the outcome.
      await Promise.race([once(child.stdout!, 'data'), new Promise((_, reject) => setTimeout(() => reject(new Error('child lock timeout')), 3000))]);
      expect(child.kill('SIGKILL')).toBe(true);
      await once(child, 'exit');
      let approvals = 0;
      expect(await recoverStaleJobQuotaLock(dir, async owner => { approvals++; expect(owner.pid).toBe(child.pid); return true; })).toBe(true);
      expect(approvals).toBe(1);
      const store = new FileJobQuotaStore(dir, { principal: limits, project: limits });
      expect((await store.acquire(job('after-crash'))).owner).toBe(true);
    } finally { if (child.exitCode === null) child.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); }
  });
  it('serializes two real processes against the same project budget without accepting both', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'job-quota-forks-'));
    try {
      const [a, b] = await Promise.all([fork(dir, 'job-a'), fork(dir, 'job-b')]);
      expect([a.code, b.code].sort()).toEqual([0, 2]);
      expect([a.output.trim(), b.output.trim()].sort()).toEqual(['accepted', 'denied']);
      expect((await readdir(dir)).filter(name => name.endsWith('.r1.json'))).toHaveLength(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 20000);
  it('enforces per-project and principal capacity on transitions and releases after deletion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'job-quota-policy-'));
    try {
      const policy = { principal: limits, project: { ...limits, jobs: 2, retainedItems: 2, queued: 2,
        running: 2, retainedBytes: 20000, tokens: 200, costMicros: 2000, calls: 4 } };
      const first = new DecisionJobRuntime(new FileJobQuotaStore(dir, policy), () => 20);
      const other = new DecisionJobRuntime(new FileJobQuotaStore(dir, policy), () => 20);
      await first.submit(job('a'), scope);
      await expect(other.submit(job('b'), scope)).rejects.toThrow('capacity');
      const neighbor = { ...scope, principalId: 'neighbor' };
      await other.submit(job('b', neighbor), neighbor);
      await expect(first.submit(job('c', { ...scope, principalId: 'third' }), { ...scope, principalId: 'third' })).rejects.toThrow('capacity');
      const snapshot = (await first.poll(scope, 'a'))!;
      const running = structuredClone(snapshot.job); running.state = 'running';
      running.items[0]!.state = 'running';
      running.items[0]!.attempts.push({ id: randomUUID(), requestDigest: digest, outcome: 'dispatched' }); recount(running);
      const constrained = new DecisionJobRuntime(new FileJobQuotaStore(dir, {
        principal: { ...limits, running: 0 }, project: policy.project,
      }), () => 20);
      // Start from an admitted queued state; a stricter running quota must reject dispatch.
      const queued = structuredClone(snapshot.job); queued.state = 'queued';
      const admitted = await first.advance(scope, 'a', snapshot, queued);
      await expect(constrained.advance(scope, 'a', admitted, running)).rejects.toThrow('capacity');
      expect((await first.poll(scope, 'a'))?.revision).toBe(2);
      expect(await first.remove(scope, 'a')).toBe(true);
      await other.submit(job('c'), scope);
      expect((await readdir(dir)).filter(name => name.endsWith('.r1.json'))).toHaveLength(3);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
