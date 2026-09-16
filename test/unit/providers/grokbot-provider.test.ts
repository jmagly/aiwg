import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  GROKBOT_SKILLS_DIR_ENV,
  resolveGrokbotSkillsDir,
  resolveGrokbotSkillsDirResult,
  isGrokbotUserScopeConfigured,
} from '../../../src/providers/grokbot-paths.js';
import { getProviderDefinition, normalizeProviderDefinitionId } from '../../../src/providers/provider-definitions.js';
import {
  deploySkills,
  resolveGrokbotSkillsDir as resolveFromWriter,
  createAgentsMd,
  paths as grokbotPaths,
} from '../../../tools/agents/providers/grokbot.mjs';

const roots: string[] = [];
const repoRoot = resolve(__dirname, '../../..');

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env[GROKBOT_SKILLS_DIR_ENV];
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
    expect(def?.status).toBe('experimental');
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

  it('deploys kernel skills to configured root and preserves operator-owned skills', () => {
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
      '---\nname: aiwg-status\ndescription: status\n---\n\nStatus skill.\n',
    );

    const result = deploySkills([skillDir], temporaryRoot('aiwg-grokbot-target-'), {
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
    expect(readFileSync(join(operatorDir, 'SKILL.md'), 'utf8')).toBe('operator-owned\n');
    expect(existsSync(join(skillsRoot, '.cursor'))).toBe(false);
  });
});
