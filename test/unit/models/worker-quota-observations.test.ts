import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveWorkerPlan } from '../../../src/models/resolver.js';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { completeShellWorkerCapture } from '../../../tools/ralph-external/lib/worker-shell-capture.mjs';
import { loadWorkerQuotaObservations, workerQuotaExhaustion, parseWorkerQuotaFailure, recordWorkerQuotaFailure } from '../../../src/models/worker-quota-observations.mjs';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'aiwg-quota-')); roots.push(root);
  const cwd = path.join(root, 'project'); await mkdir(cwd);
  vi.stubEnv('AIWG_CONFIG', path.join(root, 'config'));
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
  const f = workerResolutionFixture();
  f.snapshot.config.parallelism!.clis = {
    codex: { adapter: 'providers:codex', accountScope: 'synthetic', quotaScope: 'limited-account' },
    other: { adapter: 'providers:codex', accountScope: 'synthetic', quotaScope: 'other-account' },
  };
  f.snapshot.installations.other = structuredClone(f.snapshot.installations.codex);
  const discovery = structuredClone(f.snapshot.catalog.discovery!.instances!.codex);
  discovery.models.forEach(row => { row.worker!.cliId = 'other'; });
  f.snapshot.catalog.discovery!.instances!.other = discovery;
  f.snapshot.config.parallelism!.groups!.workers.members[1].cli = 'other';
  const event = await readFile(path.resolve('test/fixtures/worker-quota/codex-usage-limit.jsonl'), 'utf8');
  const stdout = path.join(root, 'stdout'); const stderr = path.join(root, 'stderr');
  await writeFile(stdout, event); await writeFile(stderr, '');
  const binding = { invocation: { cwd, selected: { cli: 'codex' } },
    quotaScope: 'limited-account', paths: { stdout, stderr } };
  return { ...f, root, cwd, binding, event };
}

describe('recorded worker quota exhaustion (#4375)', () => {
  it('records a terminal Codex failure, excludes its quota scope with reset reason, and falls back', async () => {
    const f = await fixture();
    expect(resolveWorkerPlan(f.snapshot, { ...f.request, role: 'coding' }).selected?.member).toBe('primary');
    expect(await completeShellWorkerCapture(f.binding, 1)).toBe(1);
    f.snapshot.quotaObservations = await loadWorkerQuotaObservations(f.cwd);
    const beforeReset = { ...f.request, role: 'coding' };
    const plan = resolveWorkerPlan(f.snapshot, beforeReset);
    expect(plan.selected?.member).toBe('alternate');
    expect(plan.exclusions.flatMap(e => e.diagnostics)).toContainEqual(expect.objectContaining({
      code: 'OG_HOST_CAPACITY', message: expect.stringContaining('2026-11-29T10:56:00'),
    }));
    expect(plan.exclusions.flatMap(e => e.diagnostics).some(d => d.message.includes('limited-account'))).toBe(true);
    // Same account through another installation must also be excluded.
    f.snapshot.config.parallelism!.clis!.other.quotaScope = 'limited-account';
    expect(resolveWorkerPlan(f.snapshot, beforeReset).status).toBe('blocked');
    // Quota expiry is independent of catalog freshness.
    const resetAt = f.snapshot.quotaObservations[0].resetAt!;
    expect(workerQuotaExhaustion(f.snapshot.quotaObservations, 'limited-account', Date.parse(resetAt))).toBeNull();
  });
});

describe('quota event parsing and persistence boundaries', () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  it.each([
    ['', null],
    ['null', null],
    ['{}', null],
    [JSON.stringify({ type: 'result', is_error: false, result: 'Quota exceeded' }), null],
    ['ordinary progress', null],
    [JSON.stringify({ type: 'item.completed', message: "You've hit your usage limit" }), null],
    [JSON.stringify({ type: 'error', message: 'Temporary network error' }), null],
    [JSON.stringify({ type: 'error', message: "You've hit your usage limit" }), { resetAt: null }],
    [JSON.stringify({ type: 'turn.failed', error: { message: 'Quota exceeded', reset_at: '2026-11-29T10:56:00Z' } }), { resetAt: '2026-11-29T10:56:00.000Z' }],
    [JSON.stringify({ type: 'error', error: 'Usage limit reached', resetAt: '2026-11-29T10:56:00Z' }), { resetAt: '2026-11-29T10:56:00.000Z' }],
    [JSON.stringify({ type: 'result', is_error: true, result: 'Quota exhausted', retry_after_seconds: 60 }), { resetAt: '2026-11-23T12:01:00.000Z' }],
    [JSON.stringify({ type: 'error', message: 'insufficient_quota', retry_after: 30 }), { resetAt: '2026-11-23T12:00:30.000Z' }],
    [JSON.stringify({ type: 'error', message: 'Quota exceeded', reset_at: 'invalid', retry_after: -1 }), { resetAt: null }],
    [JSON.stringify({ type: 'error', message: 'Quota exceeded', reset_at: 15 }), { resetAt: null }],
    ["You've hit your usage limit. Please try again at Nov 29th, 2026 10:56 AM UTC.", { resetAt: '2026-11-29T10:56:00.000Z' }],
  ])('parses only terminal exhaustion: %s', (output, expected) => {
    expect(parseWorkerQuotaFailure(output, now)).toEqual(expected);
  });

  it('uses a reset from turn.failed when the preceding error has no reset', () => {
    const output = [JSON.stringify({ type: 'error', message: "You've hit your usage limit" }),
      JSON.stringify({ type: 'turn.failed', error: { message: 'Quota exceeded', reset_at: '2026-11-29T10:56:00Z' } })].join('\n');
    expect(parseWorkerQuotaFailure(output, now)).toEqual({ resetAt: '2026-11-29T10:56:00.000Z' });
  });

  it('does not treat unstructured successful output as a quota failure', () => {
    expect(parseWorkerQuotaFailure("You've hit your usage limit", now, false)).toBeNull();
    expect(workerQuotaExhaustion(undefined, 'scope', now)).toBeNull();
    expect(workerQuotaExhaustion([{ cli: 'codex', quotaScope: 'scope', observedAt: new Date(now).toISOString(), resetAt: null }], 'scope', now)).toBeTruthy();
  });

  it('restores eligibility at reset and preserves configured quota caps', async () => {
    const f = await fixture();
    const reset = Date.parse(f.request.now) + 1000;
    f.snapshot.quotaObservations = [{ cli: 'codex', quotaScope: 'limited-account', observedAt: f.request.now, resetAt: new Date(reset).toISOString() }];
    expect(resolveWorkerPlan(f.snapshot, { ...f.request, role: 'coding' }).selected?.member).toBe('alternate');
    expect(resolveWorkerPlan(f.snapshot, { ...f.request, role: 'coding', now: new Date(reset).toISOString() }).selected?.member).toBe('primary');
    f.snapshot.config.parallelism!.admission = { quotaCaps: { 'limited-account': 1 } };
    expect(resolveWorkerPlan(f.snapshot, { ...f.request, role: 'coding', now: new Date(reset).toISOString() }).selected).toMatchObject({ member: 'primary', effectiveMaxParallel: 1 });
  });

  it('chooses another eligible group when the exhausted group has no remaining member', async () => {
    const f = await fixture();
    const groups = f.snapshot.config.parallelism!.groups!;
    groups.backup = { ...structuredClone(groups.workers), members: [groups.workers.members[1]], fallback: [] };
    groups.workers.members = [groups.workers.members[0]];
    groups.workers.fallback = [];
    f.snapshot.models.defaults.workerSelection!.roleGuidance!.coding.groups = ['workers', 'backup'];
    await completeShellWorkerCapture(f.binding, 1);
    f.snapshot.quotaObservations = await loadWorkerQuotaObservations(f.cwd);
    expect(resolveWorkerPlan(f.snapshot, { ...f.request, role: 'coding' }).selected?.group).toBe('backup');
  });

  it('does not create a store for ordinary failures or an unbound quota', async () => {
    const f = await fixture();
    expect(await loadWorkerQuotaObservations(f.cwd)).toEqual([]);
    expect(await recordWorkerQuotaFailure({ cwd: f.cwd, cli: 'codex', quotaScope: 'q', output: 'ordinary failure', exitCode: 1 })).toBe(false);
    expect(await recordWorkerQuotaFailure({ cwd: f.cwd, cli: 'codex', output: f.event, exitCode: 1 })).toBe(false);
    await expect(readFile(path.join(f.root, 'config/worker-installations.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes scopes, retains approvals, never shortens a reset, and prunes expired observations', async () => {
    const f = await fixture();
    const input = { cwd: f.cwd, cli: 'codex', quotaScope: 'q', output: f.event, exitCode: 1, now };
    const later = JSON.stringify({ type: 'error', message: 'Quota exceeded', resetAt: '2026-12-01T00:00:00Z' });
    await Promise.all([recordWorkerQuotaFailure(input), recordWorkerQuotaFailure({ ...input, quotaScope: 'other', output: later })]);
    await recordWorkerQuotaFailure({ ...input, output: later });
    await recordWorkerQuotaFailure(input);
    expect((await loadWorkerQuotaObservations(f.cwd)).find(q => q.quotaScope === 'q')?.resetAt).toBe('2026-12-01T00:00:00.000Z');
    await recordWorkerQuotaFailure({ ...input, output: JSON.stringify({ type: 'error', message: 'Quota exceeded' }) });
    await recordWorkerQuotaFailure(input);
    expect((await loadWorkerQuotaObservations(f.cwd)).find(q => q.quotaScope === 'q')?.resetAt).toBeNull();
    await recordWorkerQuotaFailure({ ...input, quotaScope: 'new', now: Date.parse('2026-12-02T00:00:00Z') });
    expect((await loadWorkerQuotaObservations(f.cwd)).map(q => q.quotaScope)).toEqual(['q', 'new']);
    const stored = JSON.parse(await readFile(path.join(f.root, 'config/worker-installations.json'), 'utf8'));
    expect(stored.registrations).toEqual([]);
  });

  it.each([{}, [null], [{ quotaScope: 1 }], [{ quotaScope: '' }], [{ quotaScope: 'q' }], [{ quotaScope: 'q', cli: 'c', observedAt: 'invalid', resetAt: null }],
    [{ quotaScope: 'q', cli: 'c', observedAt: '2026-11-23T00:00:00Z', resetAt: 'invalid' }]])('rejects malformed stored observations', async quotaObservations => {
    const f = await fixture();
    await mkdir(path.join(f.root, 'config'), { mode: 0o700 });
    await writeFile(path.join(f.root, 'config/worker-installations.json'), JSON.stringify({ version: 1, registrations: [], quotaObservations }), { mode: 0o600 });
    await expect(loadWorkerQuotaObservations(f.cwd)).rejects.toThrow('Invalid worker quota observations');
  });

  it('refuses to grow beyond the bounded observation store', async () => {
    const f = await fixture();
    await mkdir(path.join(f.root, 'config'), { mode: 0o700 });
    const quotaObservations = Array.from({ length: 128 }, (_, index) => ({ cli: 'c', quotaScope: `q${index}`, observedAt: '2026-11-23T00:00:00Z', resetAt: null }));
    await writeFile(path.join(f.root, 'config/worker-installations.json'), JSON.stringify({ version: 1, registrations: [], quotaObservations }), { mode: 0o600 });
    await expect(recordWorkerQuotaFailure({ cwd: f.cwd, cli: 'c', quotaScope: 'new', output: f.event, exitCode: 1, now })).rejects.toThrow('store is full');
  });
});
