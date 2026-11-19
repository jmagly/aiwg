// Check dashboard health mapping and Muse inventory boundaries.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { appendMuseDeployment, applyDeploymentHealth } from '../../../tools/cli/workspace-deployment-health.mjs';
const { probe } = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock('../../../src/cli/services/deployment-verification.js', () => ({ buildDeploymentStatusProbe: probe }));
let root;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'aiwg-dashboard-'));
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
});
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); probe.mockReset(); await fs.rm(root, { recursive: true, force: true }); });

it('keeps unconfigured provider inventory unchanged', async () => {
  const rows = [{ name: 'codex' }];
  expect(await appendMuseDeployment(root, rows)).toBe(rows);
});
it('shows an empty Muse deployment when configured, including installed-only records', async () => {
  for (const config of [{ providers: ['muse'] }, { installed: { utils: { deployedTo: { muse: {} } } } }]) {
    expect(await appendMuseDeployment(root, [], config)).toEqual([{ name: 'muse', path: '.muse', counts: {}, lastRefresh: null }]);
  }
});
it('reports unreadable Muse inventory rather than claiming an empty directory', async () => {
  vi.spyOn(fs, 'readdir').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
  await expect(appendMuseDeployment(root, [], { providers: ['muse'] })).rejects.toThrow('denied');
});
it('leaves registry health alone when the probe has no deployment', async () => {
  probe.mockResolvedValue({ status: 'not-configured' });
  const result = { health: { overall: 'healthy', issues: [] } };
  await applyDeploymentHealth(result, root, root);
  expect(result.health).toEqual({ overall: 'healthy', issues: [] });
});
it.each([
  ['healthy', 'warning', 'warning'], ['healthy', 'error', 'error'],
  ['error', 'warning', 'error'], ['unknown', 'healthy', 'healthy'],
])('merges registry %s and probe %s as %s', async (registry, health, expected) => {
  probe.mockResolvedValue({ status: 'degraded', checks: { health }, deployment_verification: { findings: [
    { provider: 'claude', severity: 'info', message: 'Reload' },
    { provider: 'claude', severity: 'advisory', message: 'Old rule', remediation: 'aiwg refresh' },
    { provider: 'codex', severity: 'blocking', message: 'Missing context' },
  ] } });
  const result = { health: { overall: registry, issues: [] } };
  await applyDeploymentHealth(result, root, root);
  expect(result.health.overall).toBe(expected);
  expect(result.health.issues).toEqual([
    { severity: 'warning', message: 'claude: Old rule', action: 'aiwg refresh' },
    { severity: 'error', message: 'codex: Missing context', action: undefined },
  ]);
});
