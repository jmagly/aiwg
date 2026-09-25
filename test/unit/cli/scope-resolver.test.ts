/**
 * Tests for the --scope user|project resolver (PUW-027 / #1128).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import {
  detectScope,
  userScopeConfigPath,
  resolveScopePaths,
  USER_SCOPE_PATHS,
  mirrorSkillsToUserScope,
  mirrorToUserScope,
  mirrorSkillDirsToUserScope,
  rejectOpenClawProjectScope,
  hermesHome,
} from '../../../src/cli/scope-resolver.js';

describe('detectScope', () => {
  it('defaults to project when --scope absent', () => {
    expect(detectScope([])).toBe('project');
    expect(detectScope(['--provider', 'codex'])).toBe('project');
  });

  it('parses --scope user', () => {
    expect(detectScope(['--scope', 'user'])).toBe('user');
  });

  it('parses --scope project explicit', () => {
    expect(detectScope(['--scope', 'project'])).toBe('project');
  });

  it('rejects unknown scope value', () => {
    expect(() => detectScope(['--scope', 'shared'])).toThrow(/expected 'user' or 'project'/);
  });

  it('rejects missing scope value', () => {
    expect(() => detectScope(['--scope'])).toThrow(/expected 'user' or 'project'/);
  });

  it('rejects duplicate --scope flags', () => {
    expect(() => detectScope(['--scope', 'user', '--scope', 'project'])).toThrow(/more than once/);
  });
});

describe('userScopeConfigPath', () => {
  it('returns ~/.aiwg/aiwg.config', () => {
    expect(userScopeConfigPath()).toBe(path.join(homedir(), '.aiwg', 'aiwg.config'));
  });
});

describe('resolveScopePaths', () => {
  const projectPaths = {
    agents: '.codex/agents',
    skills: '.codex/skills',
    commands: '.codex/commands',
    rules: '.codex/rules',
    behaviors: '.codex/rules',
  };

  it('returns project paths for scope=project', () => {
    const r = resolveScopePaths('codex', 'project', projectPaths);
    expect(r).toEqual(projectPaths);
  });

  it('returns user-scope absolute paths for scope=user (codex)', () => {
    const r = resolveScopePaths('codex', 'user', projectPaths);
    expect(r.skills).toBe(path.join(homedir(), '.agents', 'skills'));
    expect(r.commands).toBe(path.join(homedir(), '.codex', 'prompts'));
  });

  it('returns user-scope absolute paths for scope=user (claude)', () => {
    const r = resolveScopePaths('claude', 'user', projectPaths);
    expect(r.agents).toBe(path.join(homedir(), '.claude', 'agents'));
    expect(r.skills).toBe(path.join(homedir(), '.claude', 'skills'));
    expect(r.commands).toBe(path.join(homedir(), '.claude', 'commands'));
    expect(r.rules).toBe(path.join(homedir(), '.claude', 'rules'));
  });

  it('returns user-scope OpenHuman paths without inventing global agents or commands', () => {
    const r = resolveScopePaths('openhuman', 'user', projectPaths);
    expect(r.agents).toBe('');
    expect(r.skills).toBe(path.join(homedir(), '.openhuman', 'skills'));
    expect(r.commands).toBe('');
    expect(r.rules).toBe(path.join(homedir(), '.openhuman', '.aiwg', 'rules'));
    expect(r.behaviors).toBe('');
  });

  it('falls back to project paths for unknown provider', () => {
    const r = resolveScopePaths('nonexistent', 'user', projectPaths);
    expect(r).toEqual(projectPaths);
  });
});

describe('mirrorSkillsToUserScope', () => {
  let tmpRoot: string;
  let projectSkillsDir: string;

  // USER_SCOPE_PATHS captures homedir at module-load time; we don't mutate
  // HOME here (it leaked between describe blocks before this fix). The
  // mirror function dynamically calls path.join with USER_SCOPE_PATHS, so
  // it uses the same captured homedir. Tests assert structural shape
  // rather than absolute path values.

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiwg-scope-mirror-'));
    projectSkillsDir = path.join(tmpRoot, 'project', '.codex', 'skills');
    await fs.mkdir(projectSkillsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('returns count 0 for unknown provider', async () => {
    const r = await mirrorSkillsToUserScope('nonexistent', projectSkillsDir);
    expect(r.count).toBe(0);
  });

  it('returns count 0 when project skills dir is empty', async () => {
    const r = await mirrorSkillsToUserScope('codex', projectSkillsDir);
    expect(r.count).toBe(0);
  });

  it('returns count 0 when project skills dir does not exist', async () => {
    const r = await mirrorSkillsToUserScope('codex', path.join(tmpRoot, 'nonexistent'));
    expect(r.count).toBe(0);
  });

  it('emits a non-empty target dir for codex', async () => {
    const r = await mirrorSkillsToUserScope('codex', projectSkillsDir);
    expect(r.targetDir).toContain('agents/skills');
  });
});

describe('mirrorToUserScope (#1156)', () => {
  let tmpRoot: string;
  let projectAgentsDir: string;
  let projectSkillsDir: string;
  let projectCommandsDir: string;
  let projectRulesDir: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiwg-scope-mirror-full-'));
    projectAgentsDir = path.join(tmpRoot, 'project', '.claude', 'agents');
    projectSkillsDir = path.join(tmpRoot, 'project', '.claude', 'skills');
    projectCommandsDir = path.join(tmpRoot, 'project', '.claude', 'commands');
    projectRulesDir = path.join(tmpRoot, 'project', '.claude', 'rules');
    await fs.mkdir(projectAgentsDir, { recursive: true });
    await fs.mkdir(projectSkillsDir, { recursive: true });
    await fs.mkdir(projectCommandsDir, { recursive: true });
    await fs.mkdir(projectRulesDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('returns zero counts for unknown provider', async () => {
    const r = await mirrorToUserScope('nonexistent', {
      agents: projectAgentsDir,
      skills: projectSkillsDir,
      commands: projectCommandsDir,
      rules: projectRulesDir,
      behaviors: '',
    });
    expect(r.agents.count).toBe(0);
    expect(r.skills.count).toBe(0);
    expect(r.commands.count).toBe(0);
    expect(r.rules.count).toBe(0);
  });

  it('returns zero counts when project artifact dirs are empty', async () => {
    const r = await mirrorToUserScope('claude', {
      agents: projectAgentsDir,
      skills: projectSkillsDir,
      commands: projectCommandsDir,
      rules: projectRulesDir,
      behaviors: '',
    });
    expect(r.agents.count).toBe(0);
    expect(r.skills.count).toBe(0);
    expect(r.commands.count).toBe(0);
    expect(r.rules.count).toBe(0);
  });

  it('refuses Grok Build user-scope symlink escapes before mirroring', async () => {
    const skill = path.join(projectSkillsDir, 'aiwg-test');
    await fs.mkdir(skill);
    await fs.writeFile(path.join(skill, 'SKILL.md'), '# managed\n');
    await fs.writeFile(path.join(skill, '.aiwg-managed'), 'aiwg\n');
    const outside = path.join(tmpRoot, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'operator.txt'), 'keep\n');
    const grokHome = path.join(tmpRoot, 'user', '.grok');
    await fs.mkdir(grokHome, { recursive: true });
    const userSkills = path.join(grokHome, 'skills');
    const priorHome = process.env.GROK_HOME;
    process.env.GROK_HOME = grokHome;
    const paths = { agents: projectAgentsDir, skills: projectSkillsDir, commands: '', rules: '', behaviors: '' };
    try {
      await fs.symlink(outside, userSkills, 'dir');
      await expect(mirrorToUserScope('grok-build', paths)).rejects.toThrow(/unsafe Grok Build user mirror root/);
      await fs.rm(userSkills);
      await fs.mkdir(userSkills);
      await fs.symlink(outside, path.join(userSkills, 'aiwg-test'), 'dir');
      await expect(mirrorToUserScope('grok-build', paths)).rejects.toThrow(/unsafe Grok Build user mirror target/);
      expect(await fs.readFile(path.join(outside, 'operator.txt'), 'utf8')).toBe('keep\n');
      await expect(fs.access(path.join(outside, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (priorHome === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = priorHome;
    }
  });

  it('emits non-empty target dirs for claude', async () => {
    const r = await mirrorToUserScope('claude', {
      agents: projectAgentsDir,
      skills: projectSkillsDir,
      commands: projectCommandsDir,
      rules: projectRulesDir,
      behaviors: '',
    });
    expect(r.agents.targetDir).toContain('.claude/agents');
    expect(r.skills.targetDir).toContain('.claude/skills');
    expect(r.commands.targetDir).toContain('.claude/commands');
    expect(r.rules.targetDir).toContain('.claude/rules');
  });

  // #1156 Cycle 3 — mirror returns entry names so the registry can record
  // exactly what was deployed, enabling precise remove later.
  it('returns entry names for each artifact type that was actually mirrored', async () => {
    // Populate a couple of source directories so the mirror has real content.
    await fs.mkdir(path.join(projectSkillsDir, 'skill-foo'), { recursive: true });
    await fs.writeFile(path.join(projectSkillsDir, 'skill-foo', 'SKILL.md'), '# foo', 'utf-8');
    await fs.mkdir(path.join(projectSkillsDir, 'skill-bar'), { recursive: true });
    await fs.writeFile(path.join(projectSkillsDir, 'skill-bar', 'SKILL.md'), '# bar', 'utf-8');
    await fs.writeFile(path.join(projectCommandsDir, 'cmd-baz.md'), '# baz', 'utf-8');

    const originalUserPaths = { ...USER_SCOPE_PATHS.claude };
    Object.assign(USER_SCOPE_PATHS.claude, {
      agents: path.join(tmpRoot, 'user', 'agents'),
      skills: path.join(tmpRoot, 'user', 'skills'),
      commands: path.join(tmpRoot, 'user', 'commands'),
      rules: path.join(tmpRoot, 'user', 'rules'),
    });
    const r = await mirrorToUserScope('claude', {
      agents: projectAgentsDir,
      skills: projectSkillsDir,
      commands: projectCommandsDir,
      rules: projectRulesDir,
      behaviors: '',
    });
    Object.assign(USER_SCOPE_PATHS.claude, originalUserPaths);

    expect(r.skills.entries.sort()).toEqual(['skill-bar', 'skill-foo']);
    expect(r.skills.count).toBe(2);
    expect(r.commands.entries).toEqual(['cmd-baz.md']);
    expect(r.commands.count).toBe(1);
    expect(r.agents.entries).toEqual([]);
    expect(r.rules.entries).toEqual([]);
  });
});

describe('mirrorSkillDirsToUserScope', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiwg-scope-kernel-mirror-'));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('makes kernel skills available when the standard skill mirror is empty', async () => {
    const standard = path.join(tmpRoot, 'project', '.claude', '.aiwg', 'skills');
    const kernel = path.join(tmpRoot, 'project', '.claude', 'skills');
    const target = path.join(tmpRoot, 'home', '.claude', 'skills');
    await fs.mkdir(standard, { recursive: true });
    await fs.mkdir(path.join(kernel, 'aiwg-status'), { recursive: true });
    await fs.writeFile(path.join(kernel, 'aiwg-status', 'SKILL.md'), '# status\n', 'utf-8');

    const result = await mirrorSkillDirsToUserScope([standard, kernel], target);

    expect(result).toEqual({
      count: 1,
      targetDir: target,
      entries: ['aiwg-status'],
    });
    expect(await fs.readFile(path.join(target, 'aiwg-status', 'SKILL.md'), 'utf-8')).toBe('# status\n');
  });

  it('merges standard and kernel skills and counts duplicate names once', async () => {
    const standard = path.join(tmpRoot, 'standard');
    const kernel = path.join(tmpRoot, 'kernel');
    const target = path.join(tmpRoot, 'user-skills');
    await fs.mkdir(path.join(standard, 'shared'), { recursive: true });
    await fs.mkdir(path.join(standard, 'standard-only'), { recursive: true });
    await fs.mkdir(path.join(kernel, 'shared'), { recursive: true });
    await fs.mkdir(path.join(kernel, 'kernel-only'), { recursive: true });
    await fs.writeFile(path.join(standard, 'shared', 'SKILL.md'), 'standard\n', 'utf-8');
    await fs.writeFile(path.join(kernel, 'shared', 'SKILL.md'), 'kernel\n', 'utf-8');

    const result = await mirrorSkillDirsToUserScope([standard, kernel], target);

    expect(result.count).toBe(3);
    expect(result.entries.sort()).toEqual(['kernel-only', 'shared', 'standard-only']);
    expect(await fs.readFile(path.join(target, 'shared', 'SKILL.md'), 'utf-8')).toBe('kernel\n');
  });

  it('inventories providers whose kernel source is already the user target', async () => {
    const target = path.join(tmpRoot, 'home', '.hermes', 'skills');
    await fs.mkdir(path.join(target, 'aiwg-status'), { recursive: true });
    await fs.writeFile(path.join(target, 'aiwg-status', 'SKILL.md'), '---\n# aiwg:managed v1 bundled\n---\n', 'utf8');

    const result = await mirrorSkillDirsToUserScope([target], target);

    expect(result.count).toBe(1);
    expect(result.entries).toEqual(['aiwg-status']);
  });
});

describe('rejectOpenClawProjectScope (#1156)', () => {
  it('throws on --scope project + openclaw', () => {
    expect(() => rejectOpenClawProjectScope('openclaw', 'project')).toThrow(
      /OpenClaw is exclusively user-scope/,
    );
  });

  it('is a no-op for openclaw + scope user', () => {
    expect(() => rejectOpenClawProjectScope('openclaw', 'user')).not.toThrow();
  });

  it('is a no-op for non-openclaw providers regardless of scope', () => {
    expect(() => rejectOpenClawProjectScope('claude', 'project')).not.toThrow();
    expect(() => rejectOpenClawProjectScope('claude', 'user')).not.toThrow();
    expect(() => rejectOpenClawProjectScope('codex', 'project')).not.toThrow();
  });

  it('throws on --scope project + openhuman', () => {
    expect(() => rejectOpenClawProjectScope('openhuman', 'project')).toThrow(
      /OpenHuman is exclusively user-scope/,
    );
  });

  it('is a no-op for openhuman + scope user', () => {
    expect(() => rejectOpenClawProjectScope('openhuman', 'user')).not.toThrow();
  });
});

describe('USER_SCOPE_PATHS coverage', () => {
  it('covers all 14 supported providers', () => {
    const expected = ['claude', 'codex', 'pi', 'copilot', 'cursor', 'opencode', 'warp', 'windsurf', 'hermes', 'openclaw', 'openhuman', 'factory', 'grokbot', 'muse'];
    for (const p of expected) {
      expect(USER_SCOPE_PATHS[p], `${p} should have user-scope paths`).toBeDefined();
    }
  });

  it('resolves muse user skills to the documented XDG root (#226)', () => {
    const saved = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    expect(USER_SCOPE_PATHS.muse).toEqual({
      agents: '',
      skills: path.join(homedir(), '.config', 'muse', 'skills'),
      commands: '',
      rules: '',
      behaviors: '',
    });
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  });

  it('fails muse user skills closed on bad XDG metadata (#226)', () => {
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = 'relative/config';
    expect(USER_SCOPE_PATHS.muse.skills).toBe('');
    process.env.XDG_CONFIG_HOME = path.join(path.sep, 'tmp', 'muse-xdg');
    expect(USER_SCOPE_PATHS.muse.skills).toBe(
      path.join(path.sep, 'tmp', 'muse-xdg', 'muse', 'skills'),
    );
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  });

  it('routes Pi user resources through the default agent directory without duplicate skill roots', () => {
    const root = path.join(homedir(), '.pi', 'agent');
    expect(USER_SCOPE_PATHS.pi).toEqual({
      agents: '',
      skills: path.join(root, 'skills'),
      commands: path.join(root, 'prompts'),
      rules: '',
      behaviors: path.join(root, 'extensions'),
    });
  });

  it('honors PI_CODING_AGENT_DIR for every Pi user resource', async () => {
    const saved = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = '/tmp/pi-user-scope';
    vi.resetModules();
    const fresh = await import('../../../src/cli/scope-resolver.js');
    expect(fresh.USER_SCOPE_PATHS.pi.skills).toBe('/tmp/pi-user-scope/skills');
    expect(fresh.USER_SCOPE_PATHS.pi.commands).toBe('/tmp/pi-user-scope/prompts');
    expect(fresh.USER_SCOPE_PATHS.pi.behaviors).toBe('/tmp/pi-user-scope/extensions');
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
    vi.resetModules();
  });

  it('uses ~/.agents/skills/ as cross-provider canonical target for the 4 bridge providers', () => {
    // #1164 — Factory was previously included here but its docs explicitly
    // call out ~/.factory/skills/ as the user-scope path. We deploy there
    // instead. Factory may also scan ~/.agents/skills/ — if confirmed by
    // primary source, add it back to the cross-provider mirror set.
    const crossAgentPath = path.join(homedir(), '.agents', 'skills');
    expect(USER_SCOPE_PATHS.codex.skills).toBe(crossAgentPath);
    expect(USER_SCOPE_PATHS.copilot.skills).toBe(crossAgentPath);
    expect(USER_SCOPE_PATHS.warp.skills).toBe(crossAgentPath);
    expect(USER_SCOPE_PATHS.opencode.skills).toBe(crossAgentPath);
    expect(USER_SCOPE_PATHS.factory.skills).toBe(path.join(homedir(), '.factory', 'skills'));
  });

  // #1161 — OpenCode user-scope discovery roots at ~/.config/opencode/, not
  // ~/.opencode/. Subdirs are plural per OpenCode docs convention.
  it('places opencode user-scope agents and commands under ~/.config/opencode/ (plural)', () => {
    expect(USER_SCOPE_PATHS.opencode.agents).toBe(path.join(homedir(), '.config', 'opencode', 'agents'));
    expect(USER_SCOPE_PATHS.opencode.commands).toBe(path.join(homedir(), '.config', 'opencode', 'commands'));
  });
});

// #2119 — HERMES_HOME resolution for the hermes provider home.
describe('hermesHome (#2119 HERMES_HOME)', () => {
  const saved = process.env.HERMES_HOME;

  afterEach(() => {
    if (saved === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = saved;
  });

  it('falls back to $HOME/.hermes without HERMES_HOME (posix)', () => {
    delete process.env.HERMES_HOME;
    expect(hermesHome()).toBe(path.join(homedir(), '.hermes'));
  });

  it('honors HERMES_HOME absolute path', () => {
    process.env.HERMES_HOME = '/tmp/hermes-home-x';
    expect(hermesHome()).toBe('/tmp/hermes-home-x');
  });

  it('preserves a leading tilde like upstream Path(env)', () => {
    process.env.HERMES_HOME = '~/custom-role';
    expect(hermesHome()).toBe('~/custom-role');
  });

  it('preserves a relative path like upstream Path(env)', () => {
    process.env.HERMES_HOME = '.profiles/coder';
    expect(hermesHome()).toBe('.profiles/coder');
  });

  it('ignores blank / whitespace-only values', () => {
    process.env.HERMES_HOME = '   ';
    expect(hermesHome()).toBe(path.join(homedir(), '.hermes'));
  });

  it('resolves the user-scope skills path from HERMES_HOME at module load', async () => {
    process.env.HERMES_HOME = '/tmp/hermes-user-scope';
    vi.resetModules();
    const fresh = await import('../../../src/cli/scope-resolver.js');
    expect(fresh.USER_SCOPE_PATHS.hermes.skills).toBe('/tmp/hermes-user-scope/skills');
  });
});

describe('grokbot USER_SCOPE_PATHS fail-closed (#205/#207)', () => {
  const saved = process.env.AIWG_GROKBOT_SKILLS_DIR;

  afterEach(() => {
    if (saved === undefined) delete process.env.AIWG_GROKBOT_SKILLS_DIR;
    else process.env.AIWG_GROKBOT_SKILLS_DIR = saved;
  });

  it('keeps skills empty when AIWG_GROKBOT_SKILLS_DIR is unset', async () => {
    delete process.env.AIWG_GROKBOT_SKILLS_DIR;
    vi.resetModules();
    const fresh = await import('../../../src/cli/scope-resolver.js');
    expect(fresh.USER_SCOPE_PATHS.grokbot.skills).toBe('');
  });

  it('uses the absolute AIWG_GROKBOT_SKILLS_DIR override', async () => {
    process.env.AIWG_GROKBOT_SKILLS_DIR = '/tmp/grokbot-user-scope';
    vi.resetModules();
    const fresh = await import('../../../src/cli/scope-resolver.js');
    expect(fresh.USER_SCOPE_PATHS.grokbot.skills).toBe('/tmp/grokbot-user-scope');
  });
});
