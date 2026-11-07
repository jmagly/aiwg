// Exercises refresh/regenerate writes and offline doctor/status in an ACL'd synthetic workspace.
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

// Refresh's command/deployment boundaries stay fake; config and context filesystem writers stay real.
vi.mock('../../../src/cli/handlers/script-runner.js', () => ({
  createScriptRunner: () => ({ run: async () => ({ exitCode: 0 }) }),
}));
vi.mock('../../../src/cli/handlers/use.js', () => ({ createUseHandler: () => ({ execute: async () => ({ exitCode: 0 }) }) }));
vi.mock('../../../src/packages/registry.js', () => ({ refreshAllPackages: async () => [] }));
vi.mock('../../../src/artifacts/framework-capabilities.js', () => ({ refreshFrameworkCapabilities: async () => undefined }));

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-shared-lifecycle-')); roots.push(root);
  await chmod(root, 0o2770);
  try { execFileSync('setfacl', ['-m', 'd:u::rwx,d:g::rwx,d:m::rwx,d:o::---', root], { timeout: 2000, stdio: 'pipe' }); }
  catch { return null; }
  vi.stubEnv('AIWG_ARTIFACTS_PATH', join(root, '.aiwg'));
  vi.stubEnv('AIWG_CONFIG', join(root, 'user-config'));
  return root;
}

it('refresh and regenerate preserve the shared config and leave inherited masks usable', async ctx => {
  const root = await workspace(); if (!root) { ctx.skip(); return; }
  await mkdir(join(root, '.aiwg'));
  await writeFile(join(root, '.aiwg', 'aiwg.config'), JSON.stringify({ version: '1', providers: ['codex'], installed: {}, scripts: {} }));
  const { refreshHandler } = await import('../../../src/cli/handlers/refresh.js');
  const { regenerateHandler } = await import('../../../src/cli/handlers/regenerate.js');
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  const context = { args: ['--skip-update', '--provider', 'codex', '--quiet'], rawArgs: ['refresh'], cwd: root,
    frameworkRoot: resolve(import.meta.dirname, '../../..') };
  expect((await refreshHandler.execute(context)).exitCode).toBe(0);
  expect(JSON.parse(await readFile(join(root, '.aiwg', 'aiwg.config'), 'utf8')).parallelism).toBeDefined();
  expect((await regenerateHandler.execute({ ...context, args: ['--workspace', '--provider', 'codex'], rawArgs: ['regenerate'] })).exitCode).toBe(0);
  const check = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await check(file);
      else if (entry.isFile()) {
        const acl = execFileSync('getfacl', ['-cp', file], { timeout: 2000, encoding: 'utf8' });
        expect(acl, file).not.toContain('mask::---');
      }
    }
  };
  await check(join(root, '.aiwg'));
  expect((await stat(join(root, '.aiwg', 'aiwg.config'))).mode & 0o777).toBe(0o660);
});

it('doctor and status report shared journals and doctor explicitly repairs a collapsed baseline', async ctx => {
  const root = await workspace(); if (!root) { ctx.skip(); return; }
  await mkdir(join(root, '.aiwg', 'decision'), { recursive: true });
  await writeFile(join(root, '.aiwg', 'aiwg.config'), JSON.stringify({ version: '1', providers: ['codex'], installed: {}, scripts: {} }));
  const ledger = join(root, '.aiwg', 'decision', 'ledger.jsonl');
  const baseline = join(root, '.aiwg', 'context-memory-firewall-baseline.json');
  await writeFile(ledger, '', { mode: 0o660 });
  await writeFile(baseline, '{}', { mode: 0o600 });
  const { collectDecisionOffloadReport, formatDecisionOffloadReport } = await import('../../../tools/cli/decision-offload-report.mjs');
  const { buildWorkspaceStatus, buildVerificationProbe } = await import('../../../tools/cli/workspace-status.mjs');
  const report = await collectDecisionOffloadReport(root);
  expect(report.permissions.journals).toContainEqual({ path: ledger, state: 'shared' });
  expect(formatDecisionOffloadReport(report).join('\n')).toContain('aiwg doctor --decision-offload --fix');
  expect((await buildWorkspaceStatus(root)).decisionOffload.permissions).toEqual(report.permissions);
  expect((await buildVerificationProbe(root)).workspace.decisionOffload.permissions).toEqual(report.permissions);
  const cli = resolve(import.meta.dirname, '../../../bin/aiwg.mjs');
  const env = { ...process.env, HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'xdg'), AIWG_NO_UPDATE_CHECK: '1' };
  delete env.JEV_API_KEY; delete env.AIWG_DECISION_JEV_API_KEY;
  const result = JSON.parse(execFileSync(process.execPath, [cli, 'doctor', '--decision-offload', '--fix', '--json'], {
    cwd: root, env, encoding: 'utf8', timeout: 30_000,
  }));
  expect(result.decisionOffload.permissions.findings).toContainEqual(expect.objectContaining({ path: baseline, repaired: true }));
  expect((await stat(baseline)).mode & 0o777).toBe(0o660);
});
