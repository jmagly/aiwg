import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// A tiny source exercises every provider writer on each merge. The exhaustive
// corpus, location and repair matrices run in test:release-slow.
const providers = [
  ['claude', '.claude/.aiwg/skills'],
  ['codex', '.agents/skills'],
  ['copilot', '.github/.aiwg/skills'],
  ['cursor', '.cursor/.aiwg/skills'],
  ['factory', '.factory/.aiwg/skills'],
  ['opencode', '.opencode/.aiwg/skill'],
  ['warp', '.warp/.aiwg/skills'],
  ['windsurf', '.windsurf/.aiwg/skills'],
  ['grokbot', 'home/configured-grokbot-skills/.aiwg/skills'],
  ['hermes', 'home/.hermes/skills/.aiwg'],
  ['openclaw', 'home/.openclaw/.aiwg/skills'],
  ['openhuman', 'home/.openhuman/.aiwg/skills'],
  ['pi', '.pi/.aiwg/skills'],
  ['muse', '.agents/.aiwg/skills'],
  ['omp', '.agents/skills'],
  ['antigravity', '.agents/.aiwg/skills'],
  ['grok-build', '.grok/.aiwg/skills'],
] as const;

function fixture(provider: string) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), `aiwg-provider-smoke-${provider}-`));
  temporary.push(scratch);
  const project = path.join(scratch, 'project');
  const home = path.join(project, 'home');
  const bundle = path.join(project, '.aiwg/extensions/deploy-smoke');
  const skill = path.join(bundle, 'skills/deploy-smoke/SKILL.md');
  mkdirSync(path.dirname(skill), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(skill, '---\nname: deploy-smoke\ndescription: Synthetic provider deployment smoke skill\nplatforms: [all]\n---\n\nRun the synthetic smoke check.\n');
  writeFileSync(path.join(bundle, 'manifest.json'), JSON.stringify({
    id: 'deploy-smoke', name: 'Deployment smoke', type: 'extension', version: '1.0.0',
    description: 'Synthetic provider deployment fixture', manifestVersion: '1',
    platforms: { generic: 'full' }, keywords: ['test'],
    deployment: { pathTemplate: '.{platform}/skills/{id}' },
  }));
  for (const [directory, name, body] of [
    ['agents', 'deploy-smoke.md', '---\nname: deploy-smoke\ndescription: Synthetic provider smoke agent\nmodel: sonnet\ntools: Read\n---\n\nRun the synthetic agent check.\n'],
    ['rules', 'deploy-smoke.md', '---\nname: deploy-smoke\nactivation: kernel\n---\n\nRun the synthetic rule check.\n'],
  ]) {
    mkdirSync(path.join(bundle, directory), { recursive: true });
    writeFileSync(path.join(bundle, directory, name), body);
  }
  writeFileSync(path.join(project, '.aiwg/aiwg.config'), JSON.stringify({ providers: [provider] }));
  const env = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home, AIWG_ROOT: ROOT,
    AIWG_CONFIG: path.join(home, '.config/aiwg'),
    AIWG_FRAMEWORK_INDEX_CACHE: process.env.AIWG_FRAMEWORK_INDEX_CACHE,
    AIWG_FRAMEWORK_INDEX_CACHE_SOURCE: process.env.AIWG_FRAMEWORK_INDEX_CACHE_SOURCE,
    AIWG_PROJECT_MEMORY_HOME: path.join(scratch, 'memory'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_CACHE_HOME: path.join(home, '.cache'), HERMES_HOME: path.join(home, '.hermes'),
    AIWG_GROKBOT_SKILLS_DIR: path.join(home, 'configured-grokbot-skills'),
    PI_CODING_AGENT_DIR: path.join(home, '.omp'),
    CI: '1', NO_COLOR: '1', NO_UPDATE_NOTIFIER: '1',
  };
  return { project, bundle, env };
}

function hasBody(directory: string, body: string): boolean {
  return readdirSync(directory, { withFileTypes: true }).some(entry =>
    entry.isFile() && readFileSync(path.join(directory, entry.name), 'utf8').includes(body));
}

function assertSkill(project: string, skills: string): void {
  const skill = path.join(project, skills, 'deploy-smoke/SKILL.md');
  expect(existsSync(skill), skill).toBe(true);
  expect(readFileSync(skill, 'utf8')).toContain('Run the synthetic smoke check.');
}

describe('provider deployment smoke', () => {
  it.each(providers)('%s deploys a synthetic skill to its provider path', (provider, skills) => {
    const { project, bundle, env } = fixture(provider);
    const result = spawnSync(process.execPath, [path.join(ROOT, 'tools/agents/deploy-agents.mjs'),
      '--provider', provider, '--source', bundle, '--target', project, '--deploy-skills', '--skills-only',
      '--copy-all', '--no-context-files', '--skip-commands-migration', '--quiet', '--deploy-version', '1.0.0',
      ...(['hermes', 'grokbot'].includes(provider) ? ['--scope', 'user'] : []),
    ], { cwd: project, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    assertSkill(project, skills);
  }, 75_000);

  it.each(providers.filter(([provider]) => ['claude', 'codex', 'factory', 'cursor', 'opencode'].includes(provider)))(
    'public aiwg use deploys core paths for %s', (provider, skills) => {
      const { project, env } = fixture(provider);
      // OpenCode's agent writer consumes the framework layout; its tiny
      // external-bundle path deploys skills but does not collect direct agents.
      const framework = provider === 'opencode';
      const result = spawnSync(process.execPath, [path.join(ROOT, 'bin/aiwg.mjs'), 'use', framework ? 'sdlc' : 'deploy-smoke',
        '--provider', provider, '--no-hooks', '--no-context-files', '--quiet',
        ...(framework ? ['--no-utils', '--no-project-local'] : []),
      ], { cwd: project, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      if (framework) {
        expect(readFileSync(path.join(project, '.opencode/skill/sdlc-quickref/SKILL.md'), 'utf8')).toContain('name: sdlc-quickref');
        expect(readFileSync(path.join(project, '.opencode/agent/architecture-designer.md'), 'utf8')).toContain('You are an Architecture Designer');
        expect(readFileSync(path.join(project, '.opencode/rule/RULES-INDEX.md'), 'utf8')).toContain('# Rule kernel index');
        return;
      }
      const native = `.${provider}`;
      assertSkill(project, provider === 'codex' ? skills : `${native}/skills`);
      const agentDir = path.join(project, native, provider === 'factory' ? 'droids' : 'agents');
      expect(hasBody(agentDir, 'Run the synthetic agent check.'), agentDir).toBe(true);
      const ruleDir = path.join(project, native, 'rules');
      expect(hasBody(ruleDir, 'Run the synthetic rule check.'), ruleDir).toBe(true);
    }, 75_000,
  );
});
