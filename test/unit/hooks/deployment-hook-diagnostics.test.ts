// Claude hook advisories must not change other providers' readiness.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { emptyConfig, writeAiwgConfig } from '../../../src/config/aiwg-config.js';
import { generate } from '../../../src/smiths/context-pipeline/index.js';
import { verifyProviderDeployment } from '../../../src/cli/services/deployment-verification.js';
import { installAiwgHooks } from '../../../src/extensions/claude-hooks-installer.js';

const frameworkRoot = path.resolve(import.meta.dirname, '../../..');
const providers = ['claude', 'muse', 'codex'] as const;
let root: string, home: string, projectRoot: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiwg-hook-provider-'));
  home = path.join(root, 'home');
  projectRoot = path.join(root, 'project');
  await fs.mkdir(projectRoot);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  await writeAiwgConfig(projectRoot, emptyConfig([...providers]));
  for (const provider of providers) {
    await generate({ provider, projectPath: projectRoot, sections: [], force: true });
    const skill = path.join(projectRoot, provider === 'codex' ? '.agents' : `.${provider}`, 'skills/fixture');
    await fs.mkdir(skill, { recursive: true });
    await fs.writeFile(path.join(skill, 'SKILL.md'), '# Fixture\n');
  }
  await installAiwgHooks({ frameworkRoot, projectPath: projectRoot, scope: 'project' });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

async function verify(provider: typeof providers[number]) {
  return verifyProviderDeployment({ projectRoot, frameworkRoot, provider, scope: 'project',
    requestedBundles: [], reportMissingReceipt: false });
}

it.each(providers.flatMap(provider => ['node legacy.cjs', 'node .claude/hooks/aiwg-prompt-discovery.cjs']
  .map(command => ({ provider, command }))))('scopes old Claude hook warnings for $provider ($command) (#4315)', async ({ provider, command }) => {
  const baseline = await verify(provider);
  expect(baseline.outcome).toBe(provider === 'codex' ? 'ready' : 'ready-restart-required');
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  await fs.writeFile(path.join(home, '.claude/settings.json'), JSON.stringify({ hooks: {
    UserPromptSubmit: [{ hooks: [{ type: 'command', _aiwg_managed: true,
      _aiwg_id: 'aiwg-prompt-discovery', command }] }],
  } }));
  const result = await verify(provider);
  const duplicate = result.findings.filter(item => item.id === 'context-diagnostic:duplicate-prompt-hook');
  if (provider === 'claude') {
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0]).toMatchObject({ provider: 'claude', severity: 'advisory' });
    expect(result.outcome).toBe('degraded');
  } else {
    expect(duplicate).toEqual([]);
    expect(result.findings).toEqual(baseline.findings);
    expect(result.outcome).toBe(baseline.outcome);
  }
});

it('keeps all providers ready with a current deferring Claude user hook (#4324)', async () => {
  await installAiwgHooks({ frameworkRoot, projectPath: home, scope: 'user' });
  for (const provider of providers) {
    const result = await verify(provider);
    expect(result.findings.filter(item => item.id === 'context-diagnostic:duplicate-prompt-hook')).toEqual([]);
    expect(result.outcome).toBe(provider === 'codex' ? 'ready' : 'ready-restart-required');
  }
});
