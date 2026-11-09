// Covers operator discovery and revocation using only a temporary signed project ledger.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorizationCli } from '../../../src/config/authorization-cli.js';
import { effectSession, openLedger } from '../../../src/effects/host.js';
import { recordAuthorizationGrant } from '../../../src/effects/authorization-store.js';
import { grantFixture } from '../../fixtures/effects/build-grant-fixtures.js';
let dir: string;
let output: ReturnType<typeof vi.spyOn>;
const printed = () => JSON.parse(String(output.mock.calls.at(-1)![0]));
const run = (...args: string[]) => authorizationCli([...args, '--json'], dir);
beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('AIWG_EFFECT_LEDGER_TEST_KEY', 'a'.repeat(64));
  dir = await mkdtemp(join(tmpdir(), 'aiwg-grant-operations-'));
  output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const grant = grantFixture(); grant.scope.targets.push(`workspace:${dir}`);
  grant.constraints.conditions = []; grant.expiresAt = 'until-revoked';
  await recordAuthorizationGrant(openLedger(await effectSession(dir, 'custom')), grant);
  await writeFile(join(dir, 'action.json'), JSON.stringify({ category: 'tracker.write', repo: 'example/repo',
    target: 'tracker:local', verb: 'create', environment: 'development', resources: ['issues/new'], reversible: true, impact: 'low' }));
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
it('lists, shows and searches signed grants with deterministic field reasons', async () => {
  await run('list', '--active', '--target', dir); expect(printed().grants).toHaveLength(1);
  await run('show', 'grant-issue-filing'); expect(printed().grant.grantId).toBe('grant-issue-filing');
  await run('search', 'create issues development');
  expect(printed().matches[0]).toMatchObject({ grant: { grantId: 'grant-issue-filing' }, score: expect.any(Number),
    reasons: expect.arrayContaining([expect.objectContaining({ field: 'verbs', token: 'create' })]) });
  await run('search', 'absent-query'); expect(printed().matches).toEqual([]);
  await expect(run('show', 'unknown')).rejects.toThrow('Unknown authorization grant');
  await expect(run('list', '--active', '--expired')).rejects.toThrow();
});
it('explains without receipts or uses, shows differences and safety, and revocation escalates the next check', async () => {
  const ledger = openLedger(await effectSession(dir, 'custom'));
  const file = join(ledger.paths().segments, 'cli.jsonl'); const before = await readFile(file, 'utf8');
  await run('explain', '--action-file', join(dir, 'action.json'));
  expect(printed()).toMatchObject({ decision: 'auto-authorized', matchingGrant: { grant: { grantId: 'grant-issue-filing' } }, safetyClassForcesEscalation: false });
  expect(await readFile(file, 'utf8')).toBe(before);
  await writeFile(join(dir, 'different.json'), JSON.stringify({ category: 'tracker.write', repo: 'example/repo',
    target: 'tracker:other', verb: 'create', environment: 'production', resources: ['issues/new'], reversible: true, impact: 'low' }));
  await run('explain', '--action-file', join(dir, 'different.json'));
  expect(printed()).toMatchObject({ safetyClassForcesEscalation: true, nearestGrant: { fields: expect.arrayContaining(['target', 'environment']) } });
  await run('revoke', 'grant-issue-filing'); expect(printed().revokes).toBe('grant-issue-filing');
  await run('check', '--action-file', join(dir, 'action.json')); expect(printed().decision).toBe('escalate');
  await run('list', '--active'); expect(printed().grants).toEqual([]);
  await run('list', '--revoked'); expect(printed().grants.length).toBeGreaterThan(0);
  expect(await readdir(ledger.paths().segments)).toEqual(['cli.jsonl']);
});
it('filters expired history, ranks deterministically, deduplicates query tokens and rejects incomplete options', async () => {
  const expired = { ...grantFixture(), grantId: 'aaa-expired' };
  await recordAuthorizationGrant(openLedger(await effectSession(dir, 'custom')), expired);
  await run('list', '--expired'); expect(printed().grants.map((e: any) => e.grant.grantId)).toEqual(['aaa-expired']);
  await run('list'); expect(printed().grants).toHaveLength(2);
  await run('search', 'issues ISSUES');
  expect(printed().matches.map((e: any) => [e.grant.grantId, e.score])).toEqual([['aaa-expired', 1], ['grant-issue-filing', 1]]);
  await run('search', '???'); expect(printed().matches).toEqual([]);
  for (const args of [['show'], ['search'], ['search', '   '], ['search', 'x'.repeat(4097)], ['explain'],
    ['list', '--json', '--json'], ['revoke', 'grant-issue-filing', '--profile', 'x'], ['list', '--target']]) {
    await expect(authorizationCli(args, dir)).rejects.toThrow();
  }
});
it('fails closed on damaged history and never repairs the index during explanation', async () => {
  const l = openLedger(await effectSession(dir, 'custom')); const path = join(l.paths().segments, 'cli.jsonl');
  const line = JSON.parse((await readFile(path, 'utf8')).trim()); line.recordHash = `sha256:${'0'.repeat(64)}`;
  await writeFile(path, `${JSON.stringify(line)}\n`);
  for (const args of [['list'], ['search', 'issues'], ['revoke', 'grant-issue-filing']]) await expect(run(...args)).rejects.toThrow();
  await run('explain', '--action-file', join(dir, 'action.json'));
  expect(printed()).toMatchObject({ decision: 'escalate', reason: 'authorization-ledger-invalid', matchingGrant: null });
});
it('makes repeated revocation idempotent and invalidates an already-issued receipt', async () => {
  await run('check', '--action-file', join(dir, 'action.json')); const receipt = printed().receipt;
  await run('revoke', 'grant-issue-filing');
  await run('revoke', 'grant-issue-filing'); expect(printed()).toMatchObject({ alreadyRevoked: true });
  await run('check', '--action-file', join(dir, 'action.json'), '--receipt-file', receipt.file, '--effect-id', receipt.effectId);
  expect(printed().decision).toBe('escalate');
});
it('revokes future-created grants without waiting for them to become active', async () => {
  const future = { ...grantFixture(), grantId: 'pending', createdAt: new Date(Date.now() + 86400_000).toISOString(), expiresAt: 'until-revoked' };
  await recordAuthorizationGrant(openLedger(await effectSession(dir, 'custom')), future);
  await run('list', '--active'); expect(printed().grants.map((e: any) => e.grant.grantId)).not.toContain('pending');
  await run('revoke', 'pending'); expect(printed().revokes).toBe('pending');
  await run('show', 'pending'); expect(printed().status).toBe('revoked');
});
