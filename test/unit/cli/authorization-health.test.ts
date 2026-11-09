// Checks grant health, status probes and doctor presentation with a temporary project and keyring.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { effectSession, openLedger } from '../../../src/effects/host.js';
import { recordAuthorizationGrant } from '../../../src/effects/authorization-store.js';
import { authorizationHealth, AUTHORIZATION_EXPIRING_SOON_MS } from '../../../src/policy/authorization-operations.js';
import { readAuthorizationHealth, checkAuthorizationHealth } from '../../../tools/cli/authorization-health.mjs';
import { grantFixture } from '../../fixtures/effects/build-grant-fixtures.js';
let dir: string;
const now = Date.parse('2026-11-09T12:00:00Z');
beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('AIWG_EFFECT_LEDGER_TEST_KEY', 'a'.repeat(64));
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
  dir = await mkdtemp(join(tmpdir(), 'aiwg-grant-health-'));
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
const ledger = async () => openLedger(await effectSession(dir, 'custom'));
it('counts active and expiring grants at the inclusive seven-day boundary, excluding expired/revoked/future grants', async () => {
  const l = await ledger();
  for (const [id, expiry] of [['soon', now + AUTHORIZATION_EXPIRING_SOON_MS], ['later', now + AUTHORIZATION_EXPIRING_SOON_MS + 1], ['expired', now]]) {
    await recordAuthorizationGrant(l, { ...grantFixture(), grantId: String(id), expiresAt: new Date(Number(expiry)).toISOString() });
  }
  await recordAuthorizationGrant(l, { ...grantFixture(), grantId: 'indefinite', expiresAt: 'until-revoked' });
  await recordAuthorizationGrant(l, { ...grantFixture(), grantId: 'future', createdAt: new Date(now + 1).toISOString(), expiresAt: 'until-revoked' });
  await recordAuthorizationGrant(l, { ...grantFixture(), grantId: 'removal', revokes: 'later', expiresAt: 'until-revoked',
    revocation: { state: 'revoked', revokedAt: new Date(now).toISOString(), decisionEventId: `sha256:${'a'.repeat(64)}` } });
  expect(await authorizationHealth(dir, now)).toMatchObject({ active: 2, expiringSoon: 1, unverifiable: 0, index: 'current' });
  const check = vi.fn(); await checkAuthorizationHealth(dir, check);
  expect(check).toHaveBeenCalledWith('authorization-grants', expect.any(String), expect.stringContaining('expiring-soon'));
});
it('reports index drift, missing and substituted indexes without repairing them', async () => {
  const l = await ledger(); await recordAuthorizationGrant(l, { ...grantFixture(), expiresAt: 'until-revoked' });
  const path = join(l.paths().root, 'authorization-index.json');
  await writeFile(path, '{}'); expect((await authorizationHealth(dir)).index).toBe('drift');
  expect(await readFile(path, 'utf8')).toBe('{}');
  await unlink(path); expect((await authorizationHealth(dir)).index).toBe('missing');
  const outside = join(dir, 'outside'); await writeFile(outside, 'unchanged'); await symlink(outside, path);
  expect((await authorizationHealth(dir)).index).toBe('drift'); expect(await readFile(outside, 'utf8')).toBe('unchanged');
});
it('reports unverifiable signed grants and unknown counts for unreadable records, failing closed', async () => {
  const l = await ledger(); await recordAuthorizationGrant(l, { ...grantFixture(), expiresAt: 'until-revoked' });
  const path = join(l.paths().segments, 'cli.jsonl'); const line = JSON.parse((await readFile(path, 'utf8')).trim());
  line.recordHash = `sha256:${'0'.repeat(64)}`; await writeFile(path, `${JSON.stringify(line)}\n`);
  expect(await authorizationHealth(dir)).toMatchObject({ active: 0, expiringSoon: 0, unverifiable: 1, failures: expect.any(Array) });
  const check = vi.fn(); await checkAuthorizationHealth(dir, check);
  expect(check).toHaveBeenCalledWith('authorization-grants', 'warn', expect.stringContaining('1 unverifiable'));
  await writeFile(path, 'not-json\n'); expect((await readAuthorizationHealth(dir)).unverifiable).toBeNull();
});
it('includes authorization health in the existing status probe and reports empty ledgers without creating storage', async () => {
  expect(await authorizationHealth(dir)).toMatchObject({ active: 0, expiringSoon: 0, unverifiable: 0, index: 'absent' });
  const result = execFileSync(process.execPath, ['tools/cli/workspace-status.mjs', '--probe', '--json', dir], {
    cwd: process.cwd(), env: { ...process.env, HOME: dir, AIWG_RESOLVE_IMPL_FROM: 'dist' }, encoding: 'utf8', timeout: 30_000,
  });
  expect(JSON.parse(result).authorization).toMatchObject({ active: 0, expiringSoon: 0, unverifiable: 0, index: 'absent' });
});
