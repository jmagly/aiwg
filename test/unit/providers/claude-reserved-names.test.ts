// Claude names must avoid built-ins while retaining other providers' steward identity.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yaml from 'js-yaml';
import { deployCommands, deploySkills } from '../../../tools/agents/providers/claude.mjs';
import { deploySkillDir } from '../../../tools/agents/providers/base-skill-copy.mjs';
import { extractTriggers } from '../../../src/artifacts/index-builder.js';
import { findShowMatches } from '../../../src/artifacts/query-engine-matching.js';
import { recordManagedCopy } from '../../helpers/managed-copy-fixture.js';
import { CLAUDE_BUILTINS, CLAUDE_RESERVED_FOLDERS, CLAUDE_UNVERIFIED_LOCAL_COMMANDS, migrateClaudeReservedSkills, migrateClaudeSteward } from '../../../tools/agents/providers/claude-skill-names.mjs';
import { captureDeploymentOutputs, recordDeploymentOutputs } from '../../../src/providers/deployment-ownership.mjs';

const source = path.resolve('agentic/code/addons/aiwg-utils/skills/steward');
const renamed = 'aiwg-steward-routing';
let root: string;
let target: string;
const opts = () => ({ provider: 'claude', srcRoot: root, replacedSkillCopies: new Set<string>() });
function write(file: string, body: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}
function legacy(base: string, managed = true, name = 'steward') {
  const dir = path.join(base, '.claude/skills', name);
  write(path.join(dir, 'SKILL.md'), `---\nname: ${name}\nnamespace: aiwg\n---\nOperator guidance\n`);
  write(path.join(dir, 'assets/local.bin'), Buffer.from([0, 255, 128, 1]));
  if (managed) write(path.join(dir, '.aiwg-managed'), 'aiwg\n');
  return dir;
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-4380-'));
  target = path.join(root, 'project');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

describe('Claude reserved skill names (#4380)', () => {
  it('blocks bundled skills and reserves PR folders while leaving local commands unverified', () => {
    expect([...CLAUDE_RESERVED_FOLDERS]).toEqual(['steward', 'babysit']);
    expect(CLAUDE_BUILTINS.has('schedule')).toBe(true);
    expect(CLAUDE_BUILTINS.has('run')).toBe(true);
    for (const name of CLAUDE_UNVERIFIED_LOCAL_COMMANDS) expect(CLAUDE_BUILTINS.has(name)).toBe(false);
  });

  it.each(['schedule', 'run'])('deploys %s under its Claude name, including refresh cleanup', async name => {
    const addon = path.join(root, 'agentic/code/addons/fixture');
    const dir = path.join(addon, 'skills', name);
    write(path.join(dir, 'SKILL.md'), `---\nnamespace: aiwg\nname: ${name}\nkernel: true\n---\nFixture\n`);
    fs.mkdirSync(path.join(root, 'agentic/code/frameworks'), { recursive: true });
    vi.stubEnv('AIWG_ROOT', root);
    const { deploy } = await import('../../../tools/agents/providers/claude.mjs');
    for (let refresh = 0; refresh < 2; refresh++) {
      await deploy({ ...opts(), target, mode: 'all', skillsOnly: true, deploySkills: true,
        contextFiles: false, attribution: false, hooks: false, quiet: true });
      expect(fs.existsSync(path.join(target, '.claude/skills', name))).toBe(false);
      expect(fs.readFileSync(path.join(target, '.claude/skills', `aiwg-${name}`, 'SKILL.md'), 'utf8'))
        .toMatch(new RegExp(`^name: aiwg-${name}$`, 'm'));
    }
    deploySkillDir(dir, path.join(target, 'codex-skills'), { ...opts(), provider: 'codex' });
    expect(fs.readFileSync(path.join(target, 'codex-skills', name, 'SKILL.md'), 'utf8'))
      .toMatch(new RegExp(`^name: ${name}$`, 'm'));
  });

  it.each(['schedule', 'run'])('renames the real standard %s skill with copy-all enabled', name => {
    const dir = path.resolve('agentic/code/addons/aiwg-utils/skills', name);
    deploySkills([dir], target, { ...opts(), copyStandardSkills: true });
    const standard = path.join(target, '.claude/.aiwg/skills');
    expect(fs.existsSync(path.join(standard, name))).toBe(false);
    expect(fs.readFileSync(path.join(standard, `aiwg-${name}`, 'SKILL.md'), 'utf8'))
      .toMatch(new RegExp(`^name: aiwg-${name}$`, 'm'));
  });

  it.each(['schedule', 'run'])('preserves an unmanaged legacy standard %s folder and its resources', name => {
    const standard = path.join(target, '.claude/.aiwg/skills');
    const previous = `---\nnamespace: aiwg\nname: ${name}\n---\nOperator edits\n`;
    write(path.join(standard, name, 'SKILL.md'), previous);
    write(path.join(standard, name, 'local.txt'), 'Operator resource\n');
    const dir = path.resolve('agentic/code/addons/aiwg-utils/skills', name);
    deploySkills([dir], target, { ...opts(), copyStandardSkills: true });
    expect(fs.readFileSync(path.join(standard, name, 'SKILL.md'), 'utf8')).toBe(previous);
    expect(fs.readFileSync(path.join(standard, name, 'local.txt'), 'utf8')).toBe('Operator resource\n');
    expect(fs.existsSync(path.join(standard, `aiwg-${name}`, 'SKILL.md'))).toBe(true);
  });

  it.each([...CLAUDE_UNVERIFIED_LOCAL_COMMANDS])('leaves unverified local command %s unchanged', name => {
    const dir = path.join(root, 'skills', name);
    write(path.join(dir, 'SKILL.md'), `---\nname: ${name}\nkernel: true\n---\nFixture\n`);
    deploySkills([dir], target, opts());
    expect(fs.readFileSync(path.join(target, '.claude/skills', name, 'SKILL.md'), 'utf8'))
      .toMatch(new RegExp(`^name: ${name}$`, 'm'));
    const file = path.join(root, 'commands', `${name}.md`);
    write(file, `---\nname: ${name}\n---\nCommand\n`);
    deployCommands([file], target, opts());
    expect(fs.existsSync(path.join(target, '.claude/commands', `${name}.md`))).toBe(true);
  });

  it.each(['project', 'home'])('full deploy and refresh retire both managed %s folders', async scope => {
    const base = scope === 'home' ? path.join(root, 'home') : target;
    const addon = path.join(root, 'agentic/code/addons/fixture');
    write(path.join(addon, 'skills/steward/SKILL.md'), fs.readFileSync(path.join(source, 'SKILL.md')));
    fs.mkdirSync(path.join(root, 'agentic/code/frameworks'), { recursive: true });
    vi.stubEnv('AIWG_ROOT', root);
    const { deploy } = await import('../../../tools/agents/providers/claude.mjs');
    const deployAll = () => deploy({ ...opts(), target: base, mode: 'all', deploySkills: true,
      contextFiles: false, attribution: false, hooks: false, quiet: true });
    await deployAll();
    for (const name of CLAUDE_RESERVED_FOLDERS) expect(fs.existsSync(path.join(base, '.claude/skills', name))).toBe(false);
    const originals = [...CLAUDE_RESERVED_FOLDERS].map(name => {
      const old = legacy(base, true, name);
      return fs.readFileSync(path.join(old, 'SKILL.md'));
    });
    for (let refresh = 0; refresh < 2; refresh++) {
      await deployAll();
      for (const name of CLAUDE_RESERVED_FOLDERS) expect(fs.existsSync(path.join(base, '.claude/skills', name))).toBe(false);
    }
    expect(fs.readFileSync(path.join(base, '.claude/skills', renamed, '.aiwg-backup-steward/SKILL.md.original'))).toEqual(originals[0]);
    const archive = path.join(base, '.claude/.aiwg-reserved-skill-backups/babysit');
    expect(fs.readFileSync(path.join(archive, 'SKILL.md.original'))).toEqual(originals[1]);
    expect(fs.readFileSync(path.join(archive, 'assets/local.bin'))).toEqual(Buffer.from([0, 255, 128, 1]));
  });

  it.each(['steward', 'babysit'])('full deploy preserves unmanaged %s and reports PR Steward reader', async name => {
    const old = legacy(target, false, name);
    const original = fs.readFileSync(path.join(old, 'SKILL.md'));
    const notice = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const addon = path.join(root, 'agentic/code/addons/fixture');
    write(path.join(addon, 'skills/steward/SKILL.md'), fs.readFileSync(path.join(source, 'SKILL.md')));
    fs.mkdirSync(path.join(root, 'agentic/code/frameworks'), { recursive: true });
    vi.stubEnv('AIWG_ROOT', root);
    const { deploy } = await import('../../../tools/agents/providers/claude.mjs');
    await deploy({ ...opts(), target, mode: 'all', deploySkills: true, contextFiles: false,
      attribution: false, hooks: false, quiet: true });
    expect(fs.readFileSync(path.join(old, 'SKILL.md'))).toEqual(original);
    expect(fs.readFileSync(path.join(old, 'assets/local.bin'))).toEqual(Buffer.from([0, 255, 128, 1]));
    expect(notice).toHaveBeenCalledWith(expect.stringMatching(/Claude Code's built-in \/steward \(PR Steward\) reads .*SKILL\.md; unmanaged guidance left untouched/));
  });

  it('resolves a safe alias instead of deploying a reserved folder', () => {
    const dir = path.join(root, 'source/skills/babysit');
    write(path.join(dir, 'SKILL.md'), '---\nname: babysit\naliases: [steward, aiwg-safe]\nkernel: true\n---\nTest\n');
    deploySkills([dir], target, opts());
    for (const name of CLAUDE_RESERVED_FOLDERS) expect(fs.existsSync(path.join(target, '.claude/skills', name))).toBe(false);
    expect(fs.readFileSync(path.join(target, '.claude/skills/aiwg-safe/SKILL.md'), 'utf8')).toMatch(/^name: aiwg-safe$/m);
  });

  it('does not treat inherited object properties as configured Claude aliases', () => {
    const dir = path.join(root, 'skills/constructor');
    write(path.join(dir, 'SKILL.md'), '---\nname: help\n---\nFixture\n');
    expect(() => deploySkills([dir], target, opts())).toThrow(/Claude Code built-in \/help/);
  });

  it('archives repeated babysit copies without overwriting old backups and respects dry-run', () => {
    const old = legacy(target, true, 'babysit');
    const options = opts();
    migrateClaudeReservedSkills(path.dirname(old), { ...options, dryRun: true });
    expect(fs.existsSync(old)).toBe(true);
    for (let index = 0; index < 2; index++) {
      legacy(target, true, 'babysit');
      migrateClaudeReservedSkills(path.dirname(old), options);
      const archive = path.join(target, '.claude/.aiwg-reserved-skill-backups', index ? 'babysit-1' : 'babysit');
      expect(fs.readFileSync(path.join(archive, 'SKILL.md.original'), 'utf8')).toContain('Operator guidance');
      expect(fs.existsSync(old)).toBe(false);
    }
  });

  it('deploys the declared steward alias as both directory and native name', () => {
    deploySkills([source], target, opts());
    expect(fs.existsSync(path.join(target, '.claude/skills/steward'))).toBe(false);
    const deployed = fs.readFileSync(path.join(target, '.claude/skills', renamed, 'SKILL.md'), 'utf8');
    expect(deployed).toMatch(/^name: aiwg-steward-routing$/m);
  });

  it('retains the renamed native skill through the full provider cleanup pass', async () => {
    const addon = path.join(root, 'agentic/code/addons/fixture');
    write(path.join(addon, 'skills/steward/SKILL.md'), fs.readFileSync(path.join(source, 'SKILL.md')));
    fs.mkdirSync(path.join(root, 'agentic/code/frameworks'), { recursive: true });
    vi.stubEnv('AIWG_ROOT', root);
    const { deploy } = await import('../../../tools/agents/providers/claude.mjs');
    await deploy({ ...opts(), target, mode: 'all', skillsOnly: true,
      deploySkills: true, contextFiles: false, attribution: false, hooks: false, quiet: true });
    await deploy({ ...opts(), target, mode: 'all', commandsOnly: true,
      deploySkills: false, contextFiles: false, attribution: false, hooks: false, quiet: true });
    expect(fs.readFileSync(path.join(target, '.claude/skills', renamed, 'SKILL.md'), 'utf8')).toMatch(/^name: aiwg-steward-routing$/m);
    expect(fs.existsSync(path.join(target, '.claude/skills/steward'))).toBe(false);
  });

  it.each(['project', 'home'])('moves a managed %s copy and preserves all original bytes', scope => {
    const base = scope === 'home' ? path.join(root, 'home') : target;
    const old = legacy(base);
    const original = fs.readFileSync(path.join(old, 'SKILL.md'));
    deploySkills([source], base, opts());
    const next = path.join(base, '.claude/skills', renamed);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.readFileSync(path.join(next, 'assets/local.bin'))).toEqual(Buffer.from([0, 255, 128, 1]));
    expect(fs.readFileSync(path.join(next, '.aiwg-backup-steward/SKILL.md.original'))).toEqual(original);
    expect(fs.readFileSync(path.join(next, 'SKILL.md'), 'utf8')).toMatch(/^name: aiwg-steward-routing$/m);
  });

  it('preserves an unmanaged legacy directory even with namespace: aiwg', () => {
    const old = legacy(target, false);
    const original = fs.readFileSync(path.join(old, 'SKILL.md'));
    deploySkills([source], target, opts());
    expect(fs.readFileSync(path.join(old, 'SKILL.md'))).toEqual(original);
  });

  it('merges into an existing managed replacement without losing conflicting assets', () => {
    deploySkills([source], target, opts());
    const next = path.join(target, '.claude/skills', renamed);
    write(path.join(next, 'assets/local.bin'), 'new');
    legacy(target);
    deploySkills([source], target, opts());
    expect(fs.readFileSync(path.join(next, 'assets/local.bin'), 'utf8')).toBe('new');
    expect(fs.readFileSync(path.join(next, '.aiwg-backup-steward/assets/local.bin'))).toEqual(Buffer.from([0, 255, 128, 1]));
    expect(fs.existsSync(path.join(target, '.claude/skills/steward'))).toBe(false);
  });

  it.each([false, true])('retains receipt integrity and operator edits (edited=%s)', edited => {
    const old = legacy(target);
    const file = path.join(old, 'SKILL.md');
    recordManagedCopy(file);
    if (edited) fs.appendFileSync(file, 'Local modification\n');
    const original = fs.readFileSync(file);
    deploySkills([source], target, opts());
    const next = path.join(target, '.claude/skills', renamed);
    const deployed = fs.readFileSync(path.join(next, 'SKILL.md'), 'utf8');
    expect(deployed).toMatch(/^name: aiwg-steward-routing$/m);
    expect(deployed.includes('Local modification')).toBe(edited);
    expect(fs.readFileSync(path.join(next, '.aiwg-backup-steward/SKILL.md.original'))).toEqual(original);
    const receipt = JSON.parse(fs.readFileSync(path.join(next, '.aiwg-manifest.json'), 'utf8'));
    const { createHash } = require('node:crypto');
    const digest = `sha256:${createHash('sha256').update(deployed).digest('hex')}`;
    expect(receipt.managed['SKILL.md'].hash === digest).toBe(!edited);
  });

  it('archives nested skill files without overwriting existing original-suffix files', () => {
    const old = legacy(target);
    write(path.join(old, 'SKILL.md.original'), 'Existing archive');
    write(path.join(old, 'nested/SKILL.md'), 'Nested original');
    migrateClaudeSteward(path.dirname(old), opts());
    const backup = path.join(target, '.claude/skills', renamed, '.aiwg-backup-steward');
    expect(fs.readFileSync(path.join(backup, 'SKILL.md.original'), 'utf8')).toBe('Existing archive');
    expect(fs.readFileSync(path.join(backup, 'SKILL.md.original.original'), 'utf8')).toContain('Operator guidance');
    expect(fs.readFileSync(path.join(backup, 'nested/SKILL.md.original'), 'utf8')).toBe('Nested original');
    expect(fs.existsSync(path.join(backup, 'SKILL.md'))).toBe(false);
  });

  it('preserves an existing migration backup and archives the conflicting reserved folder', () => {
    deploySkills([source], target, opts());
    legacy(target);
    const next = path.join(target, '.claude/skills', renamed);
    write(path.join(next, '.aiwg-backup-steward/keep.txt'), 'Keep');
    expect(() => deploySkills([source], target, opts())).toThrow(/already exists/);
    expect(fs.readFileSync(path.join(next, '.aiwg-backup-steward/keep.txt'), 'utf8')).toBe('Keep');
    expect(fs.existsSync(path.join(target, '.claude/skills/steward'))).toBe(false);
    expect(fs.readFileSync(path.join(target, '.claude/.aiwg-reserved-skill-backups/steward/SKILL.md.original'), 'utf8')).toContain('Operator guidance');
  });

  it.each([false, true])('preserves resources and archives on subsequent refreshes (receipt=%s)', recorded => {
    const old = legacy(target);
    if (recorded) {
      recordManagedCopy(path.join(old, 'SKILL.md'));
      const file = path.join(old, '.aiwg-manifest.json');
      const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
      const { createHash } = require('node:crypto');
      receipt.managed['assets/local.bin'] = { source: 'bundled', hash:
        `sha256:${createHash('sha256').update(fs.readFileSync(path.join(old, 'assets/local.bin'))).digest('hex')}` };
      write(file, JSON.stringify(receipt));
    }
    const original = fs.readFileSync(path.join(old, 'SKILL.md'));
    const options = { ...opts(), frameworkSlug: 'aiwg-utils' };
    const before = captureDeploymentOutputs([target]);
    deploySkills([source], target, options);
    recordDeploymentOutputs(before, [target], options);
    deploySkills([source], target, opts());
    const next = path.join(target, '.claude/skills', renamed);
    expect(fs.readFileSync(path.join(next, 'assets/local.bin'))).toEqual(Buffer.from([0, 255, 128, 1]));
    expect(fs.readFileSync(path.join(next, '.aiwg-backup-steward/SKILL.md.original'))).toEqual(original);
  });

  it('does not mutate either scope on dry-run', () => {
    const old = legacy(target);
    deploySkills([source], target, { ...opts(), dryRun: true });
    expect(fs.existsSync(old)).toBe(true);
    expect(fs.existsSync(path.join(target, '.claude/skills', renamed))).toBe(false);
  });

  it('preserves an unmanaged replacement and archives the conflicting reserved folder', () => {
    const old = legacy(target);
    const next = path.join(target, '.claude/skills', renamed);
    write(path.join(next, 'SKILL.md'), 'Operator replacement');
    expect(() => deploySkills([source], target, opts())).toThrow(/unmanaged.*aiwg-steward-routing/i);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.readFileSync(path.join(target, '.claude/.aiwg-reserved-skill-backups/steward/SKILL.md.original'), 'utf8')).toContain('Operator guidance');
    expect(fs.readFileSync(path.join(next, 'SKILL.md'), 'utf8')).toBe('Operator replacement');
  });

  it.each(['steward', 'babysit', 'help', 'doctor'])('rejects a reserved skill %s before writing', name => {
    const dir = path.join(root, 'source/skills', name);
    write(path.join(dir, 'SKILL.md'), `---\nname: ${name}\nkernel: true\n---\nTest\n`);
    expect(() => deploySkills([dir], target, opts())).toThrow(/Claude.*built-in.*rename/i);
    expect(fs.existsSync(path.join(target, '.claude'))).toBe(false);
  });

  it('checks the native name even when the directory is safe', () => {
    const dir = path.join(root, 'source/skills/safe');
    write(path.join(dir, 'SKILL.md'), '---\nname: steward\nkernel: true\n---\nTest\n');
    expect(() => deploySkills([dir], target, opts())).toThrow(/Claude.*built-in.*rename/i);
  });

  it('preserves unrelated native names and skips other-platform reserved skills', () => {
    const safe = path.join(root, 'source/skills/safe');
    const foreign = path.join(root, 'source/skills/help');
    write(path.join(safe, 'SKILL.md'), '---\nname: Custom Display Name\nkernel: true\n---\nTest\n');
    write(path.join(foreign, 'SKILL.md'), '---\nname: help\nplatforms: [codex]\nkernel: true\n---\nTest\n');
    deploySkills([safe, foreign], target, opts());
    expect(fs.readFileSync(path.join(target, '.claude/skills/safe/SKILL.md'), 'utf8')).toMatch(/^name: Custom Display Name$/m);
    expect(fs.existsSync(path.join(target, '.claude/skills/help'))).toBe(false);
  });

  it('migrates an existing HOME copy after project deployment succeeds', () => {
    const home = path.join(root, 'home');
    const old = legacy(home);
    const babysit = legacy(home, true, 'babysit');
    const addon = path.join(root, 'addon');
    write(path.join(addon, 'skills/steward/SKILL.md'), fs.readFileSync(path.join(source, 'SKILL.md')));
    execFileSync(process.execPath, ['tools/agents/deploy-agents.mjs', '--source', addon,
      '--target', target, '--provider', 'claude', '--skills-only', '--no-context-files'], {
      cwd: path.resolve('.'), encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') },
    });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(babysit)).toBe(false);
    const next = path.join(home, '.claude/skills', renamed);
    expect(fs.readFileSync(path.join(next, 'SKILL.md'), 'utf8')).toMatch(/^name: aiwg-steward-routing$/m);
    expect(fs.readFileSync(path.join(next, '.aiwg-backup-steward/assets/local.bin'))).toEqual(Buffer.from([0, 255, 128, 1]));
  }, 65_000);

  it('finalizes the existing HOME migration only after promotion', async () => {
    const home = path.join(root, 'final-home');
    const old = legacy(home);
    const operator = legacy(target, false);
    const original = fs.readFileSync(path.join(operator, 'SKILL.md'));
    const notice = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_CONFIG_HOME', path.join(home, '.config'));
    const addon = path.join(root, 'addon');
    write(path.join(addon, 'skills/steward/SKILL.md'), fs.readFileSync(path.join(source, 'SKILL.md')));
    const { main } = await import('../../../tools/agents/deploy-agents.mjs');
    expect(await main(['--source', addon, '--target', target, '--provider', 'codex',
      '--skills-only', '--no-context-files', '--quiet'], { finalizeOnly: true })).toBe(0);
    expect(fs.existsSync(old)).toBe(true);
    expect(await main(['--source', addon, '--target', target, '--provider', 'claude',
      '--skills-only', '--no-context-files', '--quiet'], { finalizeOnly: true })).toBe(0);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.readFileSync(path.join(operator, 'SKILL.md'))).toEqual(original);
    expect(notice).toHaveBeenCalledWith(expect.stringContaining(`PR Steward) reads ${path.join(operator, 'SKILL.md')}`));
  });

  it.each(['steward', 'babysit', 'help', 'doctor', 'schedule', 'run'])('rejects a reserved command %s', name => {
    const file = path.join(root, 'commands', `${name}.md`);
    write(file, `---\nname: ${name}\n---\nCommand\n`);
    expect(() => deployCommands([file], target, opts())).toThrow(/Claude.*built-in.*rename/i);
    expect(fs.existsSync(path.join(target, '.claude/commands', `${name}.md`))).toBe(false);
  });

  it('rejects a reserved command frontmatter name behind a safe filename', () => {
    const file = path.join(root, 'commands/safe.md');
    write(file, '---\nname: steward\n---\nCommand\n');
    expect(() => deployCommands([file], target, opts())).toThrow(/Claude.*built-in.*rename/i);
  });

  it.each(['codex', 'cursor', 'factory', 'hermes', 'muse', 'opencode', 'warp', 'devin'])('keeps %s skill names unchanged', provider => {
    deploySkillDir(source, path.join(target, 'skills'), { ...opts(), provider });
    expect(fs.readFileSync(path.join(target, 'skills/steward/SKILL.md'), 'utf8')).toMatch(/^name: steward$/m);
    expect(fs.existsSync(path.join(target, 'skills', renamed))).toBe(false);
  });

  it('keeps the shared source identity valid and declares the Claude discovery alias', () => {
    const content = fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8');
    const metadata = yaml.load(content.split('---')[1]) as Record<string, unknown>;
    expect(metadata.name).toBe(path.basename(source));
    expect(extractTriggers(content, metadata)).toContain(renamed);
    const entry = { type: 'skill', name: metadata.name, path: `${source}/SKILL.md` };
    expect(findShowMatches([entry as never], ['skill'], 'steward')).toHaveLength(1);
  });
});
