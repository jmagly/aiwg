// Exercise extracted CLI core generation with read-only existing dependencies.
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { expect } from 'vitest';
import { createExternalPluginProject, listFixtureEntries } from './cli-package-fixtures.js';
import { readCoreBody } from '../../src/rules/activation.mjs';

export async function assertOfflinePluginDelivery(extracted: string, scratch: string, baseEnv: NodeJS.ProcessEnv) {
  const canonical = path.resolve(import.meta.dirname, '../../agentic/code/addons/aiwg-utils/rules');
  for (const name of ['anti-laziness.md', 'anti-laziness.core.md']) {
    expect(await readFile(path.join(extracted, 'agentic/code/addons/aiwg-utils/rules', name), 'utf8'))
      .toBe(await readFile(path.join(canonical, name), 'utf8'));
  }
  const core = readCoreBody(path.join(canonical, 'anti-laziness.md'));
  const env = { ...baseEnv, HOME: scratch, USERPROFILE: scratch, AIWG_CONFIG: path.join(scratch, 'config'),
    XDG_CACHE_HOME: path.join(scratch, 'cache'), XDG_CONFIG_HOME: path.join(scratch, 'config'),
    XDG_DATA_HOME: path.join(scratch, 'data'), XDG_STATE_HOME: path.join(scratch, 'state') };
  for (const [provider, global] of [['claude', false], ['codex', false], ['claude', true]] as const) {
    const project = path.join(scratch, `core-${provider}-${global}`);
    await createExternalPluginProject(project);
    const deploy = () => spawnSync(process.execPath, [path.join(extracted, 'bin/aiwg.mjs'), 'use',
      'bt6-maintainer', '--provider', provider, ...(global ? ['--global'] : ['--scope', 'project']), '--target', project],
    { cwd: project, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = deploy();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const startup = await readFile(path.join(project, provider === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'), 'utf8');
      expect(startup.split(core)).toHaveLength(2);
      expect(startup.match(/AIWG:rule-core:start/g)).toHaveLength(1);
      const destination = global ? scratch : project;
      const rules = path.join(destination, `.${provider}/rules`);
      expect(await listFixtureEntries(rules)).toEqual(['bt6-fixture-rule.md']);
      expect(await readFile(path.join(rules, 'bt6-fixture-rule.md'), 'utf8')).toContain('# BT6 fixture rule');
      if (provider === 'codex') {
        expect(startup).toContain('`.codex/rules/RULES-INDEX.md`');
        expect(await readFile(path.join(rules, 'RULES-INDEX.md'), 'utf8')).toContain('# Rule kernel index');
        const hooks = JSON.parse(await readFile(path.join(project, '.codex/hooks.json'), 'utf8'));
        expect(hooks.hooks.UserPromptSubmit[0].hooks[0].command).not.toContain(project);
        const script = 'agentic/code/addons/aiwg-hooks/hooks/aiwg-prompt-discovery.cjs';
        expect(await readFile(path.join(project, '.codex/hooks/aiwg-prompt-discovery.cjs'), 'utf8'))
          .toBe(await readFile(path.join(extracted, script), 'utf8'));
      }
      if (global) await expect(readdir(path.join(project, '.claude/agents'))).rejects.toThrow();
    }
  }
}
