/**
 * SkillSmith Namespace Tests
 *
 * Tests for #697: namespaced deployment paths and idempotent slug computation.
 *
 * @implements #697
 * @source @src/smiths/skillsmith/platform-resolver.ts
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { homedir } from 'os';
import { PlatformSkillResolver } from '../../../src/smiths/skillsmith/platform-resolver.js';

const PROJECT = '/tmp/test-project';
const NS = 'aiwg';

describe('PlatformSkillResolver.computeCanonicalSlug', () => {
  it('prepends namespace when not already present', () => {
    expect(PlatformSkillResolver.computeCanonicalSlug('sync', NS)).toBe('aiwg-sync');
  });

  it('is idempotent — does not double-prefix aiwg-* names', () => {
    expect(PlatformSkillResolver.computeCanonicalSlug('aiwg-sync', NS)).toBe('aiwg-sync');
  });

  it('is idempotent for all existing aiwg-* skills', () => {
    const existing = ['aiwg-status', 'aiwg-guide', 'aiwg-refresh', 'aiwg-regenerate'];
    for (const name of existing) {
      expect(PlatformSkillResolver.computeCanonicalSlug(name, NS)).toBe(name);
    }
  });

  it('prefixes non-aiwg names', () => {
    expect(PlatformSkillResolver.computeCanonicalSlug('run', NS)).toBe('aiwg-run');
    expect(PlatformSkillResolver.computeCanonicalSlug('doctor', NS)).toBe('aiwg-doctor');
    expect(PlatformSkillResolver.computeCanonicalSlug('project-status', NS)).toBe('aiwg-project-status');
  });
});

describe('PlatformSkillResolver.getNamespacedSkillPath', () => {
  it('deploys under namespace subdir on Claude Code', () => {
    const p = PlatformSkillResolver.getNamespacedSkillPath('claude', PROJECT, 'sync', NS);
    expect(p).toBe(path.join(PROJECT, '.claude/skills/aiwg/aiwg-sync'));
  });

  it('deploys under namespace subdir on Cursor', () => {
    const p = PlatformSkillResolver.getNamespacedSkillPath('cursor', PROJECT, 'sync', NS);
    expect(p).toBe(path.join(PROJECT, '.cursor/skills/aiwg/aiwg-sync'));
  });

  it('deploys FLAT on Devin Desktop (1-level discovery limit)', () => {
    const p = PlatformSkillResolver.getNamespacedSkillPath('devin', PROJECT, 'sync', NS);
    // No namespace subdir — just slug under base
    expect(p).toBe(path.join(PROJECT, '.windsurf/skills/aiwg-sync'));
    expect(p).not.toContain('/aiwg/');
  });

  it('deploys under home-dir namespace subdir on Codex', () => {
    const p = PlatformSkillResolver.getNamespacedSkillPath('codex', PROJECT, 'sync', NS);
    expect(p).toBe(path.join(homedir(), '.codex/skills/aiwg/aiwg-sync'));
  });

  it('is idempotent for aiwg-* skill names on Claude Code', () => {
    const p = PlatformSkillResolver.getNamespacedSkillPath('claude', PROJECT, 'aiwg-sync', NS);
    expect(p).toBe(path.join(PROJECT, '.claude/skills/aiwg/aiwg-sync'));
    // Must not produce .../aiwg/aiwg-aiwg-sync
    expect(p).not.toContain('aiwg-aiwg-');
  });
});

describe('PlatformSkillResolver.getNamespacedSkillFilePath', () => {
  it('returns path to SKILL.md under namespaced directory', () => {
    const p = PlatformSkillResolver.getNamespacedSkillFilePath('claude', PROJECT, 'sync', NS);
    expect(p).toBe(path.join(PROJECT, '.claude/skills/aiwg/aiwg-sync/SKILL.md'));
  });
});
