// Regression coverage for dashboard inventory and shared deployment freshness (#4316–#4319).
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildWorkspaceStatus } from '../../../tools/cli/workspace-status.mjs';
import { buildDeploymentStatusProbe, verifyConfiguredDeployments } from '../../../src/cli/services/deployment-verification.js';
import { checkManagedDeployment } from '../../../src/cli/handlers/refresh-managed-deployment.js';

const runtime = path.resolve('.');
let root: string;
async function write(file: string, value: unknown) {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, typeof value === 'string' ? value : JSON.stringify(value));
}
async function configure(providers = ['claude', 'muse', 'codex'], version = '2026.11.4') {
  await write('.aiwg/aiwg.config', { version: '1', providers, installed: {
    utils: { version, source: 'bundled', deployedTo: Object.fromEntries(providers.map(p => [p, {}])) },
  } });
  await write('.aiwg/frameworks/registry.json', { frameworks: { utils: { health: 'healthy' } } });
}
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aiwg-status-health-'));
  for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) {
    vi.stubEnv(key, path.join(root, 'home'));
  }
  vi.stubEnv('AIWG_ROOT', runtime);
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
  vi.stubEnv('AIWG_NO_UPDATE_CHECK', '1');
  vi.stubEnv('NO_UPDATE_NOTIFIER', '1');
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it('excludes hidden manifests from every flat deployment count (#4317)', async () => {
  await configure();
  for (const provider of ['claude', 'codex']) {
    for (const kind of ['agents', 'commands', 'rules']) {
      await write(`.${provider}/${kind}/one.md`, '# one');
      await write(`.${provider}/${kind}/.aiwg-manifest.json`, {});
    }
  }
  const dashboard = await buildWorkspaceStatus(root);
  expect(dashboard.providerDeployments.find(p => p.name === 'claude-code')?.counts)
    .toEqual({ agents: 1, commands: 1, rules: 1 });
  expect(dashboard.providerDeployments.find(p => p.name === 'codex')?.counts.agents).toBe(1);
});

it('shows configured Muse with shared kernel skills, rules and hooks (#4318)', async () => {
  await configure();
  await write('.agents/skills/one/SKILL.md', '# one');
  await write('.agents/skills/.aiwg-manifest.json', {});
  await write('.muse/rules/one.md', '# rule');
  await write('.muse/hooks/aiwg-prompt-discovery.cjs', '// hook');
  expect((await buildWorkspaceStatus(root)).providerDeployments).toContainEqual(expect.objectContaining({
    name: 'muse', path: '.muse', counts: { skills: 1, rules: 1, hooks: 1 },
  }));
});

it('cannot report healthy when the deployment probe is degraded or needs repair (#4316)', async () => {
  await configure(['codex']);
  await write('.codex/rules/old.md', '<!-- aiwg:managed v2026.11.4 bundled -->\n');
  const probe = await buildDeploymentStatusProbe(root, runtime);
  expect(['degraded', 'needs-repair']).toContain(probe.status);
  const dashboard = await buildWorkspaceStatus(root);
  expect(dashboard.health.overall).toBe((probe.checks as { health: string }).health);
  expect(dashboard.health.issues.length).toBeGreaterThan(0);
});

it('probe names the same old rules, script and registration as refresh (#4319)', async () => {
  await configure(['claude', 'codex']);
  await write('.claude/rules/old.md', '<!-- aiwg:managed v2026.11.4 bundled -->\n');
  await write('.claude/hooks/aiwg-prompt-discovery.cjs', '// old runtime\n');
  await write('.claude/settings.json', { hooks: { UserPromptSubmit: [{ hooks: [{
    type: 'command', command: 'node old-aiwg-prompt-discovery.cjs', _aiwg_id: 'aiwg-prompt-discovery',
  }] }] } });
  await write('.codex/commands/old.md', '# aiwg:managed v2026.11.4 bundled\n# old command\n');
  const stale = await checkManagedDeployment({ projectRoot: root, frameworkRoot: runtime, provider: 'claude', quiet: true });
  const probe = await buildDeploymentStatusProbe(root, runtime);
  const result = probe.deployment_verification as { findings: Array<{ message: string; remediation?: string; severity: string }> };
  for (const item of stale) {
    expect(result.findings).toContainEqual(expect.objectContaining({
      severity: 'advisory', message: expect.stringContaining(item.file), remediation: expect.stringContaining('aiwg refresh'),
    }));
  }
  expect(result.findings).toContainEqual(expect.objectContaining({ message: expect.stringContaining('utils (v2026.11.4') }));
  expect(result.findings).toContainEqual(expect.objectContaining({ message: expect.stringContaining('Stale codex deployment') }));
  expect((probe.verification as { action: string }).action).not.toBe('AIWG deployment is verified on disk.');
});

it('plain doctor reports deployment staleness with refresh remediation (#4319)', async () => {
  await configure(['claude']);
  await write('.claude/rules/old.md', '<!-- aiwg:managed v2026.11.4 bundled -->\n');
  const output = execFileSync(process.execPath, [path.join(runtime, 'bin/aiwg.mjs'), 'doctor'], {
    cwd: root, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, AIWG_RESOLVE_IMPL_FROM: 'dist', AIWG_CONFIG: path.join(root, 'config') },
  });
  expect(output).toContain('Stale deployment: outdated .claude/rules/old.md');
  expect(output).toContain('aiwg refresh');
}, 65_000);

it('checks freshness in the default project scope used by doctor (#4319)', async () => {
  await configure(['claude']);
  const result = await verifyConfiguredDeployments(root, {}, runtime);
  expect(result.scope).toBe('project');
  expect(result.findings).toContainEqual(expect.objectContaining({ id: 'deployment-stale-bundle:utils' }));
});
