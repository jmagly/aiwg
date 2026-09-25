/**
 * Muse writer tests (#226).
 *
 * Covers the .mjs path-helper twin semantics (must match
 * src/providers/muse-paths.ts), dry-run zero-write behavior, the
 * never-target-.cursor guard, operator-owned skill preservation, and the
 * --scope user landing path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MUSE_XDG_SKILLS_SUBDIR,
  resolveMuseXdgSkillsDir,
  resolveMuseXdgSkillsDirResult,
  museXdgSkillsDirRemediation,
} from '../../../tools/agents/providers/muse-paths.mjs';
import {
  name,
  aliases,
  paths,
  kernelSkillsPath,
  capabilities,
  getFileExtension,
  deploySkills,
  assertNotCursorTarget,
  assertMuseUserSkillsDir,
  createAgentsMd,
  postDeploy,
} from '../../../tools/agents/providers/muse.mjs';

const HOME = path.join(path.sep, 'home', 'fixture');

// ---------------------------------------------------------------------------
// XDG resolution semantics — must mirror src/providers/muse-paths.ts
// ---------------------------------------------------------------------------

describe('muse-paths.mjs XDG resolution (#226)', () => {
  it('defaults to ~/.config/muse/skills when XDG_CONFIG_HOME is unset', () => {
    const r = resolveMuseXdgSkillsDirResult({}, HOME);
    expect(r).toEqual({
      ok: true,
      path: path.join(HOME, '.config', MUSE_XDG_SKILLS_SUBDIR),
      source: 'default',
    });
    expect(resolveMuseXdgSkillsDir({}, HOME)).toBe(path.join(HOME, '.config', 'muse', 'skills'));
  });

  it('honors an absolute XDG_CONFIG_HOME', () => {
    expect(resolveMuseXdgSkillsDir({ XDG_CONFIG_HOME: '/x/cfg' }, HOME)).toBe(
      path.join('/x/cfg', 'muse', 'skills'),
    );
  });

  it('expands a leading ~/ against the operator home', () => {
    const r = resolveMuseXdgSkillsDirResult({ XDG_CONFIG_HOME: '~/alt-config' }, HOME);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(path.join(HOME, 'alt-config', 'muse', 'skills'));
  });

  it('fails closed on relative XDG_CONFIG_HOME', () => {
    const r = resolveMuseXdgSkillsDirResult({ XDG_CONFIG_HOME: 'relative/config' }, HOME);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('not-absolute');
      expect(r.message).toMatch(/XDG_CONFIG_HOME/);
    }
    expect(resolveMuseXdgSkillsDir({ XDG_CONFIG_HOME: 'relative/config' }, HOME)).toBeNull();
  });

  it('fails closed on bare ~', () => {
    expect(resolveMuseXdgSkillsDirResult({ XDG_CONFIG_HOME: '~' }, HOME).ok).toBe(false);
    expect(resolveMuseXdgSkillsDir({ XDG_CONFIG_HOME: '~' }, HOME)).toBeNull();
  });

  it('fails closed on NUL bytes and filesystem-root collapse', () => {
    expect(resolveMuseXdgSkillsDir({ XDG_CONFIG_HOME: '/x\0/cfg' }, HOME)).toBeNull();
    expect(resolveMuseXdgSkillsDir({ XDG_CONFIG_HOME: '/' }, HOME)).toBeNull();
  });

  it('never resolves into ~/.muse or ~/.agents/skills', () => {
    for (const env of [{}, { XDG_CONFIG_HOME: path.join(HOME, 'cfg') }]) {
      const resolved = resolveMuseXdgSkillsDir(env, HOME);
      expect(resolved).toBeTruthy();
      expect(resolved as string).not.toContain(`${path.sep}.muse`);
      expect(resolved as string).not.toContain(path.join('.agents', 'skills'));
      expect(resolved as string).toContain(MUSE_XDG_SKILLS_SUBDIR);
    }
  });

  it('remediation is empty when configured and actionable when not', () => {
    expect(museXdgSkillsDirRemediation({ XDG_CONFIG_HOME: path.join(HOME, 'cfg') }, HOME)).toBe('');
    expect(museXdgSkillsDirRemediation({ XDG_CONFIG_HOME: 'nope' }, HOME)).toMatch(/XDG_CONFIG_HOME/);
  });
});

// ---------------------------------------------------------------------------
// Writer module surface
// ---------------------------------------------------------------------------

describe('muse writer surface (#226)', () => {
  it('registers the muse identity with no aliases', () => {
    expect(name).toBe('muse');
    expect(aliases).toEqual([]);
  });

  it('uses the Muse-native project skills root and no other file surfaces', () => {
    expect(paths.skills).toBe('.agents/skills');
    expect(kernelSkillsPath).toBe('.agents/skills');
    expect(paths.agents).toBe('');
    expect(paths.commands).toBe('');
    expect(paths.rules).toBe('');
    expect(getFileExtension()).toBe('.md');
  });

  it('never names a .cursor path in its roots', () => {
    for (const value of [...Object.values(paths), kernelSkillsPath]) {
      expect(String(value)).not.toContain('.cursor');
    }
  });

  it('exposes skills capability without home-dir-only claims', () => {
    expect(capabilities.skills).toBe(true);
    expect(capabilities.rules).toBe(false);
  });

  it('assertNotCursorTarget throws on .cursor segments and passes through clean dirs', () => {
    expect(() => assertNotCursorTarget('/repo/.cursor/skills', 'skills')).toThrow(/\.cursor/);
    expect(() => assertNotCursorTarget('/repo/.cursor', 'skills')).toThrow(/\.cursor/);
    expect(assertNotCursorTarget('/repo/.agents/skills', 'skills')).toBe('/repo/.agents/skills');
  });
});

// ---------------------------------------------------------------------------
// Deploy behavior fixtures
// ---------------------------------------------------------------------------

let tmpRoot: string;
let fixtureSkills: string;
let kernelDir: string;
let standardDir: string;

function writeSkill(dir: string, skillName: string, body: string, kernel = false) {
  const skillDir = path.join(dir, skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  const frontmatter = kernel
    ? `---\nname: ${skillName}\ndescription: fixture\nkernel: true\n---\n`
    : `---\nname: ${skillName}\ndescription: fixture\n---\n`;
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `${frontmatter}\n${body}\n`, 'utf8');
  return skillDir;
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-writer-'));
  fixtureSkills = path.join(tmpRoot, 'src-skills');
  kernelDir = writeSkill(fixtureSkills, 'kernel-fixture', 'kernel body', true);
  standardDir = writeSkill(fixtureSkills, 'standard-fixture', 'standard body', false);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('muse deploySkills (#226)', () => {
  it('dry-run performs zero writes', () => {
    const target = path.join(tmpRoot, 'project');
    deploySkills([kernelDir, standardDir], target, { dryRun: true, quiet: true, provider: 'muse' });
    expect(fs.existsSync(target)).toBe(false);
    expect(walkFiles(tmpRoot).filter((f) => f.includes('.agents'))).toEqual([]);
  });

  it('dry-run performs zero writes at user scope too', () => {
    const xdg = path.join(tmpRoot, 'xdg');
    deploySkills([kernelDir], path.join(tmpRoot, 'project'), {
      dryRun: true,
      quiet: true,
      provider: 'muse',
      scope: 'user',
      env: { XDG_CONFIG_HOME: xdg },
      userHome: HOME,
    });
    expect(fs.existsSync(xdg)).toBe(false);
  });

  it('deploys kernel skills to <target>/.agents/skills/<id>/SKILL.md at project scope', () => {
    const target = path.join(tmpRoot, 'project');
    deploySkills([kernelDir, standardDir], target, { quiet: true, provider: 'muse' });
    const dest = path.join(target, '.agents', 'skills', 'kernel-fixture', 'SKILL.md');
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest, 'utf8')).toContain('kernel body');
    // Standard tier stays index-discovered by default (#1217): no project copy.
    expect(fs.existsSync(path.join(target, '.agents', 'skills', 'standard-fixture'))).toBe(false);
    expect(fs.existsSync(path.join(target, '.agents', '.aiwg', 'skills'))).toBe(false);
  });

  it('drops .aiwg-managed markers on deployed skills', () => {
    const target = path.join(tmpRoot, 'project');
    deploySkills([kernelDir], target, { quiet: true, provider: 'muse' });
    expect(
      fs.existsSync(path.join(target, '.agents', 'skills', 'kernel-fixture', '.aiwg-managed')),
    ).toBe(true);
  });

  it('--scope user lands skills under the resolved XDG muse skills dir', () => {
    const xdg = path.join(tmpRoot, 'xdg');
    const env = { XDG_CONFIG_HOME: xdg };
    deploySkills([kernelDir], path.join(tmpRoot, 'project'), {
      quiet: true,
      provider: 'muse',
      scope: 'user',
      env,
      userHome: HOME,
    });
    const dest = path.join(xdg, 'muse', 'skills', 'kernel-fixture', 'SKILL.md');
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest, 'utf8')).toContain('kernel body');
    // Project tree stays untouched on a user-scope call.
    expect(fs.existsSync(path.join(tmpRoot, 'project', '.agents'))).toBe(false);
  });

  it('--scope user fails closed with remediation on bad XDG metadata', () => {
    expect(() =>
      assertMuseUserSkillsDir({ XDG_CONFIG_HOME: 'relative/config' }, HOME),
    ).toThrow(/XDG_CONFIG_HOME/);
    expect(() =>
      deploySkills([kernelDir], path.join(tmpRoot, 'project'), {
        quiet: true,
        provider: 'muse',
        scope: 'user',
        env: { XDG_CONFIG_HOME: 'relative/config' },
        userHome: HOME,
      }),
    ).toThrow(/XDG_CONFIG_HOME/);
  });

  it('refuses to target a .cursor tree', () => {
    expect(() =>
      deploySkills([kernelDir], path.join(tmpRoot, '.cursor'), {
        quiet: true,
        provider: 'muse',
      }),
    ).toThrow(/\.cursor/);
    expect(() =>
      assertMuseUserSkillsDir({ XDG_CONFIG_HOME: path.join(tmpRoot, '.cursor') }, HOME),
    ).toThrow(/\.cursor/);
  });

  it('leaves operator-owned (unmanaged) skills byte-identical', () => {
    const target = path.join(tmpRoot, 'project');
    const skillsRoot = path.join(target, '.agents', 'skills');
    // Operator skill: no .aiwg-managed marker, no aiwg namespace.
    const operatorDir = path.join(skillsRoot, 'operator-owned');
    fs.mkdirSync(operatorDir, { recursive: true });
    const operatorContent = '---\nname: operator-owned\ndescription: mine\n---\n\noperator body\n';
    fs.writeFileSync(path.join(operatorDir, 'SKILL.md'), operatorContent, 'utf8');

    deploySkills([kernelDir], target, { quiet: true, provider: 'muse' });

    // Byte-identical: no marker injected, no rewrite.
    expect(fs.readFileSync(path.join(operatorDir, 'SKILL.md'), 'utf8')).toBe(operatorContent);
    expect(fs.existsSync(path.join(operatorDir, '.aiwg-managed'))).toBe(false);
    // AIWG's own skill still landed.
    expect(fs.existsSync(path.join(skillsRoot, 'kernel-fixture', 'SKILL.md'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Discover-first AGENTS.md bridge (#227)
// ---------------------------------------------------------------------------

describe('muse AGENTS.md bridge (#227)', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const MANAGED_BEGIN = '<!-- BEGIN AIWG-managed';
  const MANAGED_END = '<!-- END AIWG-managed -->';

  function agentsMd(target: string): string {
    return fs.readFileSync(path.join(target, 'AGENTS.md'), 'utf8');
  }

  it('dry-run performs zero writes', () => {
    const target = path.join(tmpRoot, 'project');
    fs.mkdirSync(target, { recursive: true });
    createAgentsMd(target, repoRoot, true);
    expect(fs.existsSync(path.join(target, 'AGENTS.md'))).toBe(false);
  });

  it('creates a discover-first bridge with trust-gated guidance', () => {
    const target = path.join(tmpRoot, 'project');
    fs.mkdirSync(target, { recursive: true });
    createAgentsMd(target, repoRoot, false);
    const content = agentsMd(target);
    expect(content).toContain(MANAGED_BEGIN);
    expect(content).toContain(MANAGED_END);
    expect(content).toContain('first-run trust prompt');
    expect(content).toContain('aiwg discover');
    expect(content).toContain('aiwg show');
    // No template tokens leak through.
    expect(content).not.toContain('{{');
    // No false surfaces: no CLAUDE.md shim (mentioned only as an exclusion),
    // no invented homes (named only as refusals), and the explicit
    // never-target-.cursor boundary.
    expect(content).toContain('No `CLAUDE.md` shim');
    expect(content).toContain('never invents `~/.muse`');
    expect(content).toContain('never writes foreign provider paths (no `.cursor/`)');
    // Muse-accurate reload guidance, never IDE-reload copy.
    expect(content).toContain('new Muse session');
    expect(content).not.toContain('Cursor');
  });

  it('is a no-op when the managed section is already current', () => {
    const target = path.join(tmpRoot, 'project');
    fs.mkdirSync(target, { recursive: true });
    createAgentsMd(target, repoRoot, false);
    const first = agentsMd(target);
    createAgentsMd(target, repoRoot, false);
    expect(agentsMd(target)).toBe(first);
  });

  it('preserves operator content outside markers and updates the managed section in place', () => {
    const target = path.join(tmpRoot, 'project');
    const operatorContent = '# Operator Notes\n\nDo not touch this file section.\n';
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'AGENTS.md'), operatorContent, 'utf8');

    createAgentsMd(target, repoRoot, false);
    const created = agentsMd(target);
    expect(created.startsWith(operatorContent)).toBe(true);
    expect(created).toContain(MANAGED_BEGIN);

    // Drift inside the managed section is repaired without touching operator content.
    const drifted = created.replace('first-run trust prompt', 'first-run trust promp');
    expect(drifted).not.toBe(created);
    fs.writeFileSync(path.join(target, 'AGENTS.md'), drifted, 'utf8');

    createAgentsMd(target, repoRoot, false);
    const refreshed = agentsMd(target);
    expect(refreshed).toBe(created);
    expect(refreshed.startsWith(operatorContent)).toBe(true);
  });

  it('postDeploy creates the bridge on a full deploy but not on skills-only', () => {
    const full = path.join(tmpRoot, 'full');
    fs.mkdirSync(full, { recursive: true });
    postDeploy(full, { quiet: true, srcRoot: repoRoot, dryRun: false });
    expect(fs.existsSync(path.join(full, 'AGENTS.md'))).toBe(true);

    const skillsOnly = path.join(tmpRoot, 'skills-only');
    postDeploy(skillsOnly, { quiet: true, srcRoot: repoRoot, dryRun: false, skillsOnly: true });
    expect(fs.existsSync(path.join(skillsOnly, 'AGENTS.md'))).toBe(false);
  });
});
