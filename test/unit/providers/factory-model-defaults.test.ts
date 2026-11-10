// Guard Factory deploy defaults against model aliases rejected by droid 1.0.
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadProviderModelCapabilities } from '../../../src/models/provider-policy.js';
import { loadProviderModelCatalog } from '../../../src/models/catalog-policy.js';
import { MODEL_WRAPPER_DEFINITIONS } from '../../../src/models/wrapper-definitions.js';
import { loadModelConfig } from '../../../tools/agents/providers/base.mjs';
import { deployAgents } from '../../../tools/agents/providers/factory.mjs';

const repo = resolve(import.meta.dirname, '../../..');
const models: Record<string, string> = {
  reasoning: 'claude-opus-5',
  coding: 'claude-sonnet-5',
  efficiency: 'claude-haiku-4-5-20251001',
};
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Factory droid 1.0 model defaults', () => {
  it('records the BYOK effort limitation at the direct worker effort declaration', () => {
    const adapter = loadProviderModelCapabilities().providers.factory.workerHealthAdapter!;
    const effort = adapter.invocationProfiles!['direct-shell'].controls.effort;
    expect(effort.support).toBe('unqualified');
    expect(effort.mapping).toContain('Not enforceable for BYOK custom models');
    expect(effort.mapping).toContain('reasoning_effort: none');
    expect(effort.evidence).toContain('not enforceable');
    expect(adapter.qualification.status).toBe('unqualified');
  });
  it('catalog roles use concrete droid IDs rather than tier aliases', () => {
    const roles = loadProviderModelCatalog().providers.factory.roles;
    for (const [role, model] of Object.entries(models)) {
      expect(roles[role].id).not.toMatch(/^(heavy|medium|light)$/);
      expect(roles[role].id).toBe(model);
    }
  });

  it.each(['catalog', 'shipped', 'fallback'])('%s defaults deploy concrete IDs for ordinary agents and model wrappers', async source => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-factory-models-'));
    roots.push(root);
    vi.stubEnv('HOME', root);
    vi.stubEnv('USERPROFILE', root);
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const modelsConfig = source === 'catalog' ? {} : loadModelConfig(source === 'shipped' ? repo : root);
    const files = MODEL_WRAPPER_DEFINITIONS.map(wrapper =>
      join(repo, 'agentic/code/addons/aiwg-utils/agents', `${wrapper.name}.md`));
    const ordinaryRoles: Record<string, string> = {};
    for (const [index, role] of Object.keys(models).entries()) {
      const name = `ordinary-${role}`;
      const file = join(root, `${name}.md`);
      await writeFile(file, `---\nname: ${name}\nmodel: ${['opus', 'sonnet', 'haiku'][index]}\ntools: Read\n---\nOffline fixture.\n`);
      files.push(file);
      ordinaryRoles[name] = role;
      if (source !== 'catalog') expect(modelsConfig.factory[role].model).toBe(models[role]);
    }
    deployAgents(files, root, { modelsConfig, quiet: true, force: true });
    const directory = join(root, '.factory/droids');
    const deployed = await readdir(directory);
    expect(deployed.filter(file => file.endsWith('.md'))).toHaveLength(files.length);
    for (const file of deployed.filter(file => file.endsWith('.md'))) {
      const text = await readFile(join(directory, file), 'utf8');
      expect(text).not.toMatch(/^model: (heavy|medium|light)$/m);
      const name = file.slice(0, -3);
      const role = ordinaryRoles[name] ?? MODEL_WRAPPER_DEFINITIONS.find(wrapper => wrapper.name === name)!.role;
      expect(text).toContain(`model: ${models[role]}\n`);
    }
  });

  it('keeps all three CLI model overrides for custom BYOK selectors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-factory-overrides-'));
    roots.push(root);
    execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), join(repo, 'tools/agents/deploy-agents.mjs'),
      '--provider', 'factory', '--mode', 'all', '--filter', 'aiwg-model-*',
      '--target', join(root, 'project'), '--skip-commands-migration', '--quiet',
      ...Object.keys(models).flatMap(role => [`--${role}-model`, `custom:${role}`]),
    ], { cwd: root, timeout: 60_000, stdio: 'pipe',
      env: { ...process.env, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config') } });
    for (const wrapper of MODEL_WRAPPER_DEFINITIONS) {
      const text = await readFile(join(root, 'project/.factory/droids', `${wrapper.name}.md`), 'utf8');
      expect(text).toContain(`model: custom:${wrapper.role}\n`);
    }
  });
});
