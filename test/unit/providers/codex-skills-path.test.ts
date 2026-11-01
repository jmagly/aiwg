/**
 * Codex Skill Path Regression Tests
 *
 * Guards the #766 duplicate-slash-command regression: the codex provider must
 * deploy kernel skills to the single cross-provider `.agents/skills/` path that
 * codex-rs scans, NOT to the legacy `~/.codex/skills/` home dir. Writing both
 * made codex-rs (which scans both) list every kernel skill twice
 * (e.g. `/aiwg-regenerate` appeared twice in the slash-command menu).
 *
 * @issue #766
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { recordManagedCopy } from '../../helpers/managed-copy-fixture.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const REPO_ROOT = path.resolve(__dirname, '../../..');

async function importCodexProvider() {
  const modPath = path.join(REPO_ROOT, 'tools/agents/providers/codex.mjs');
  return import(/* @vite-ignore */ modPath);
}

describe('Codex skill deployment path (#766 regression)', () => {
  it('exports kernelSkillsPath as the cross-provider .agents/skills/ (not legacy ~/.codex/skills/)', async () => {
    const mod = await importCodexProvider();
    expect(mod.kernelSkillsPath).toBe('.agents/skills/');
    // Must be project-relative, never the legacy absolute home dir.
    expect(path.isAbsolute(mod.kernelSkillsPath)).toBe(false);
    expect(mod.kernelSkillsPath).not.toContain('.codex/skills');
  });
});

describe('pruneLegacyCodexSkills (#766 self-heal)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-codex-legacy-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeSkill(name: string, managed: boolean): string {
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\n---\nbody\n`);
    if (managed || name === 'aiwg-mcp') recordManagedCopy(path.join(dir, 'SKILL.md'));
    if (managed) fs.writeFileSync(path.join(dir, '.aiwg-managed'), 'true\n');
    return dir;
  }

  it('removes only AIWG-managed skill dirs and preserves user-authored ones', async () => {
    const { pruneLegacyCodexSkills } = await importCodexProvider();
    const managed = makeSkill('aiwg-regenerate', true);
    const userOwned = makeSkill('my-custom-skill', false);

    const pruned = pruneLegacyCodexSkills({ dryRun: false }, tmpDir);

    expect(pruned).toBe(1);
    expect(fs.existsSync(managed)).toBe(false); // managed pruned
    expect(fs.existsSync(userOwned)).toBe(true); // user skill untouched
  });

  it('removes the exact pre-marker aiwg-mcp legacy skill with malformed frontmatter', async () => {
    const { pruneLegacyCodexSkills } = await importCodexProvider();
    const malformedLegacy = makeSkill('aiwg-mcp', false);
    const similarlyNamedUserSkill = makeSkill('aiwg-mcp-custom', false);

    const pruned = pruneLegacyCodexSkills({ dryRun: false }, tmpDir);

    expect(pruned).toBe(1);
    expect(fs.existsSync(malformedLegacy)).toBe(false);
    expect(fs.existsSync(similarlyNamedUserSkill)).toBe(true);
  });

  it('dry-run reports but removes nothing', async () => {
    const { pruneLegacyCodexSkills } = await importCodexProvider();
    const managed = makeSkill('aiwg-doctor', true);

    const pruned = pruneLegacyCodexSkills({ dryRun: true }, tmpDir);

    expect(pruned).toBe(1);
    expect(fs.existsSync(managed)).toBe(true); // nothing deleted in dry-run
  });

  it('removes the legacy dir entirely when AIWG owned everything in it', async () => {
    const { pruneLegacyCodexSkills } = await importCodexProvider();
    makeSkill('use', true);
    makeSkill('steward', true);

    pruneLegacyCodexSkills({ dryRun: false }, tmpDir);

    expect(fs.existsSync(tmpDir)).toBe(false); // empty legacy dir cleaned up
  });

  it('is a no-op when the legacy dir does not exist', async () => {
    const { pruneLegacyCodexSkills } = await importCodexProvider();
    const absent = path.join(tmpDir, 'does-not-exist');
    expect(() => pruneLegacyCodexSkills({ dryRun: false }, absent)).not.toThrow();
    expect(pruneLegacyCodexSkills({ dryRun: false }, absent)).toBe(0);
  });
});
