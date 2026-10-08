import { mkdtempSync, mkdirSync, existsSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GROKBOT_SKILLS_DIR_ENV,
  resolveGrokbotSkillsDir,
  resolveGrokbotSkillsDirResult,
  isGrokbotUserScopeConfigured,
} from '../../../src/providers/grokbot-paths.js';
import { getProviderDefinition, normalizeProviderDefinitionId } from '../../../src/providers/provider-definitions.js';
import {
  deploy,
  deploySkills,
  resolveGrokbotSkillsDir as resolveFromWriter,
  createAgentsMd,
  paths as grokbotPaths,
} from '../../../tools/agents/providers/grokbot.mjs';

import { parseArgs } from '../../../tools/agents/deploy-agents.mjs';

const originalSkillsDir = process.env[GROKBOT_SKILLS_DIR_ENV];
const roots: string[] = [];
const repoRoot = resolve(__dirname, '../../..');

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalSkillsDir === undefined) delete process.env[GROKBOT_SKILLS_DIR_ENV];
  else process.env[GROKBOT_SKILLS_DIR_ENV] = originalSkillsDir;
  vi.restoreAllMocks();
});

describe('grokbot path resolver (fail-closed)', () => {
  it('returns null when AIWG_GROKBOT_SKILLS_DIR is unset', () => {
    delete process.env[GROKBOT_SKILLS_DIR_ENV];
    expect(resolveGrokbotSkillsDir()).toBeNull();
    expect(isGrokbotUserScopeConfigured()).toBe(false);
    const result = resolveGrokbotSkillsDirResult();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unset');
      expect(result.message).toContain(GROKBOT_SKILLS_DIR_ENV);
      expect(result.message).not.toContain('.cursor');
    }
  });

  it('accepts an absolute skills directory', () => {
    process.env[GROKBOT_SKILLS_DIR_ENV] = '/tmp/grokbot-skills-abs';
    expect(resolveGrokbotSkillsDir()).toBe('/tmp/grokbot-skills-abs');
    expect(isGrokbotUserScopeConfigured()).toBe(true);
  });

  it('expands ~/ prefix against the home directory', () => {
    process.env[GROKBOT_SKILLS_DIR_ENV] = '~/grokbot-skills-home';
    const resolved = resolveGrokbotSkillsDir();
    expect(resolved).toMatch(/grokbot-skills-home$/);
    expect(resolved?.startsWith('/')).toBe(true);
  });

  it('rejects relative paths and bare ~', () => {
    process.env[GROKBOT_SKILLS_DIR_ENV] = 'relative/skills';
    expect(resolveGrokbotSkillsDirResult().ok).toBe(false);
    process.env[GROKBOT_SKILLS_DIR_ENV] = '~';
    expect(resolveGrokbotSkillsDirResult().ok).toBe(false);
  });
});

describe('grokbot provider definition', () => {
  it('uses id grokbot with display name Grok Bot and no bare grok alias', () => {
    expect(normalizeProviderDefinitionId('grokbot')).toBe('grokbot');
    expect(normalizeProviderDefinitionId('grok')).toBeNull();
    const def = getProviderDefinition('grokbot');
    expect(def?.displayName).toBe('Grok Bot');
    expect(def?.status).toBe('stable');
    expect(def?.aliases).toEqual([]);
  });
});

describe('grokbot writer dry-run', () => {
  it('does not write and never targets .cursor', () => {
    const project = temporaryRoot('aiwg-grokbot-project-');
    delete process.env[GROKBOT_SKILLS_DIR_ENV];
    const count = deploySkills([], project, { dryRun: true, quiet: true, srcRoot: repoRoot });
    expect(count).toBe(0);
    expect(existsSync(join(project, '.cursor'))).toBe(false);
    expect(String(grokbotPaths.skills)).not.toContain('.cursor');
    expect(resolveFromWriter()).toBeNull();
  });

  it('creates discover-first AGENTS.md bridge without claiming auto-load', () => {
    const project = temporaryRoot('aiwg-grokbot-agents-');
    createAgentsMd(project, repoRoot, false);
    const agents = readFileSync(join(project, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('aiwg discover');
    expect(agents).toContain('aiwg show');
    expect(agents).toMatch(/does not claim\s+that Grok Bot auto-loads/i);
    expect(agents).not.toContain('.cursor');
    expect(agents).toContain('AIWG_GROKBOT_SKILLS_DIR');
  });

  it.each([{ userScope: true }, { scope: 'user' }])('deploys kernel skills and preserves operator skills with %j', (scopeOpts) => {
    const skillsRoot = temporaryRoot('aiwg-grokbot-skills-');
    const operatorDir = join(skillsRoot, 'operator-skill');
    mkdirSync(operatorDir, { recursive: true });
    writeFileSync(join(operatorDir, 'SKILL.md'), 'operator-owned\n');
    process.env[GROKBOT_SKILLS_DIR_ENV] = skillsRoot;

    const source = temporaryRoot('aiwg-grokbot-src-');
    const skillName = 'aiwg-status';
    const skillDir = join(source, skillName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: aiwg-status\ndescription: status\nkernel: true\n---\n\nStatus skill.\n',
    );

    const result = deploySkills([skillDir], temporaryRoot('aiwg-grokbot-target-'), {
      ...scopeOpts,
      dryRun: false,
      quiet: true,
      srcRoot: repoRoot,
      provider: 'grokbot',
      deployVersion: 'test',
      deploySource: 'fixture',
      copyStandardSkills: false,
    });
    expect(result).toEqual(expect.objectContaining({
      kernel: expect.any(Number),
      standardCopied: expect.any(Number),
    }));
    expect(readFileSync(join(skillsRoot, skillName, 'SKILL.md'), 'utf8')).toContain('Status skill.');
    expect(readFileSync(join(operatorDir, 'SKILL.md'), 'utf8')).toBe('operator-owned\n');
    expect(existsSync(join(skillsRoot, '.cursor'))).toBe(false);
  });
});

describe('grokbot scope isolation (#284)', () => {
  it.each([{}, { scope: 'project' }])('leaves the configured user root untouched with %j', async (scopeOpts) => {
    const sandbox = temporaryRoot('aiwg-grokbot-scope-');
    const project = join(sandbox, 'project');
    const skillsRoot = join(sandbox, 'user-skills');
    const source = join(sandbox, 'source');
    const skillDir = join(source, 'aiwg-status');
    for (const dir of [project, skillsRoot, skillDir]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: aiwg-status\ndescription: status\nkernel: true\n---\nStatus skill.\n');
    process.env[GROKBOT_SKILLS_DIR_ENV] = skillsRoot;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(deploySkills([skillDir], project, { ...scopeOpts, srcRoot: repoRoot, copyStandardSkills: true })).toBe(0);
    expect(readdirSync(project)).toEqual([]);
    await deploy({ ...scopeOpts, srcRoot: repoRoot, target: project, mode: 'all', deploySkills: true });

    expect(readdirSync(skillsRoot)).toEqual([]);
    expect(readdirSync(project)).toEqual(['AGENTS.md']);
    expect(readdirSync(sandbox).sort()).toEqual(['project', 'source', 'user-skills']);
    expect(readdirSync(source)).toEqual(['aiwg-status']);
    expect(readdirSync(skillDir)).toEqual(['SKILL.md']);
    expect(log.mock.calls.flat().join(' ')).toContain('project bridge only');
    expect(log.mock.calls.flat().join(' ')).not.toContain('re-read skills');
  });

  it.each([{ userScope: true }, { scope: 'user' }])('deploy populates the configured root with %j', async (scopeOpts) => {
    const project = temporaryRoot('aiwg-grokbot-project-');
    const skillsRoot = temporaryRoot('aiwg-grokbot-user-');
    process.env[GROKBOT_SKILLS_DIR_ENV] = skillsRoot;
    await deploy({ ...scopeOpts, srcRoot: repoRoot, target: project, mode: 'all', deploySkills: true, quiet: true });
    expect(existsSync(join(skillsRoot, 'aiwg-status', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(project, '.cursor'))).toBe(false);
  });

  it.each([{ userScope: true }, { scope: 'user' }])('fails closed without a user root with %j', async (scopeOpts) => {
    delete process.env[GROKBOT_SKILLS_DIR_ENV];
    const project = temporaryRoot('aiwg-grokbot-project-');
    expect(() => deploySkills([], project, { ...scopeOpts, quiet: true })).toThrow(GROKBOT_SKILLS_DIR_ENV);
    await expect(deploy({ ...scopeOpts, target: project, quiet: true })).rejects.toThrow(GROKBOT_SKILLS_DIR_ENV);
    expect(readdirSync(project)).toEqual([]);
  });

  it('retains the .cursor guard for user scope', () => {
    const sandbox = temporaryRoot('aiwg-grokbot-guard-');
    process.env[GROKBOT_SKILLS_DIR_ENV] = join(sandbox, '.cursor', 'skills');
    expect(() => deploySkills([], sandbox, { userScope: true, quiet: true })).toThrow('Refusing');
    expect(readdirSync(sandbox)).toEqual([]);
  });
});

describe('deploy-agents scope arguments', () => {
  it.each([['--scope', 'user'], ['--user']])('maps %j to userScope without adding scope', (...args) => {
    const opts = parseArgs(args);
    expect(opts.userScope).toBe(true);
    expect(opts).not.toHaveProperty('scope');
  });

  it.each([[], ['--scope', 'project']])('defaults to project scope for %j', (...args) => {
    expect(parseArgs(args).userScope).toBe(false);
  });

  it.each([['--scope'], ['--scope', 'invalid']])('rejects invalid scope %j', (...args) => {
    expect(() => parseArgs(args)).toThrow('--scope expected');
  });
});
