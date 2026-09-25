import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MUSE_XDG_SKILLS_SUBDIR,
  museXdgSkillsDirRemediation,
  resolveMuseXdgSkillsDir,
  resolveMuseXdgSkillsDirResult,
} from '../../../src/providers/muse-paths.js';

const HOME = path.join(path.sep, 'home', 'fixture');

describe('resolveMuseXdgSkillsDirResult (#234)', () => {
  it('resolves $XDG_CONFIG_HOME/muse/skills when set and absolute', () => {
    const resolution = resolveMuseXdgSkillsDirResult(
      { XDG_CONFIG_HOME: path.join(HOME, 'custom-config') },
      HOME,
    );
    expect(resolution).toEqual({
      ok: true,
      path: path.join(HOME, 'custom-config', 'muse', 'skills'),
      source: 'env',
    });
  });

  it('defaults to ~/.config/muse/skills when XDG_CONFIG_HOME is unset', () => {
    const resolution = resolveMuseXdgSkillsDirResult({}, HOME);
    expect(resolution).toEqual({
      ok: true,
      path: path.join(HOME, '.config', 'muse', 'skills'),
      source: 'default',
    });
  });

  it('expands a leading ~/ against the operator home', () => {
    const resolution = resolveMuseXdgSkillsDirResult(
      { XDG_CONFIG_HOME: '~/alt-config' },
      HOME,
    );
    expect(resolution).toEqual({
      ok: true,
      path: path.join(HOME, 'alt-config', 'muse', 'skills'),
      source: 'env',
    });
  });

  it('fails closed on relative XDG_CONFIG_HOME', () => {
    const resolution = resolveMuseXdgSkillsDirResult(
      { XDG_CONFIG_HOME: 'relative/config' },
      HOME,
    );
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.reason).toBe('not-absolute');
      expect(resolution.message).toMatch(/XDG_CONFIG_HOME/);
    }
    expect(resolveMuseXdgSkillsDir({ XDG_CONFIG_HOME: 'relative/config' }, HOME)).toBeNull();
  });

  it('fails closed on bare ~', () => {
    const resolution = resolveMuseXdgSkillsDirResult({ XDG_CONFIG_HOME: '~' }, HOME);
    expect(resolution.ok).toBe(false);
    expect(resolveMuseXdgSkillsDir({ XDG_CONFIG_HOME: '~' }, HOME)).toBeNull();
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
    expect(museXdgSkillsDirRemediation({ XDG_CONFIG_HOME: 'nope' }, HOME)).toMatch(
      /XDG_CONFIG_HOME/,
    );
  });
});
