/**
 * Namespace Adapter Tests
 *
 * Tests for #704: per-platform namespace deployment adapters.
 *
 * @implements #704
 * @source @src/smiths/skillsmith/namespace-adapter.ts
 */

import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import {
  computePrefixedSlug,
  resolveSkillsRoot,
  mutateFrontmatter,
  getAdapter,
  getDeploymentPlans,
  NAMESPACE_ADAPTERS,
} from '../../../src/smiths/skillsmith/namespace-adapter.js';

const PROJECT = '/tmp/test-project';
const NS = 'aiwg';

const SAMPLE_SKILL_MD = `---
name: sync
description: Sync AIWG installation to latest version
version: 1.0.0
---

## Instructions

Run this skill to sync AIWG.
`;

// ============================================
// computePrefixedSlug
// ============================================

describe('computePrefixedSlug', () => {
  it('prepends namespace to bare skill name', () => {
    expect(computePrefixedSlug('sync', NS)).toBe('aiwg-sync');
    expect(computePrefixedSlug('doctor', NS)).toBe('aiwg-doctor');
    expect(computePrefixedSlug('project-status', NS)).toBe('aiwg-project-status');
  });

  it('is idempotent when name already has namespace prefix', () => {
    expect(computePrefixedSlug('aiwg-sync', NS)).toBe('aiwg-sync');
    expect(computePrefixedSlug('aiwg-doctor', NS)).toBe('aiwg-doctor');
  });

  it('does not double-prefix', () => {
    const result = computePrefixedSlug('aiwg-sync', NS);
    expect(result).not.toContain('aiwg-aiwg-');
  });
});

// ============================================
// resolveSkillsRoot
// ============================================

describe('resolveSkillsRoot', () => {
  it('resolves project-relative path for project platforms', () => {
    const adapter = getAdapter('claude');
    const root = resolveSkillsRoot(adapter, PROJECT);
    expect(root).toBe(path.join(PROJECT, '.claude/skills'));
  });

  it('resolves home-dir path for Codex', () => {
    const adapter = getAdapter('codex');
    const root = resolveSkillsRoot(adapter, PROJECT);
    expect(root).toBe(path.join(os.homedir(), '.codex/skills'));
    expect(root).not.toContain(PROJECT);
  });

  it('resolves home-dir path for OpenClaw', () => {
    const adapter = getAdapter('openclaw');
    const root = resolveSkillsRoot(adapter, PROJECT);
    expect(root).toBe(path.join(os.homedir(), '.openclaw/skills'));
  });

  it('resolves home-dir path for Hermes', () => {
    const adapter = getAdapter('hermes');
    const root = resolveSkillsRoot(adapter, PROJECT);
    expect(root).toBe(path.join(os.homedir(), '.hermes/skills'));
  });
});

// ============================================
// mutateFrontmatter
// ============================================

describe('mutateFrontmatter', () => {
  it('injects namespace field when not present', () => {
    const adapter = getAdapter('claude');
    const result = mutateFrontmatter(SAMPLE_SKILL_MD, adapter, NS);
    expect(result).toMatch(/^namespace: aiwg$/m);
  });

  it('does not duplicate namespace field when already present', () => {
    const adapter = getAdapter('claude');
    const withNS = `---\nnamespace: aiwg\nname: sync\n---\n\nBody`;
    const result = mutateFrontmatter(withNS, adapter, NS);
    const matches = [...result.matchAll(/^namespace:/gm)];
    expect(matches).toHaveLength(1);
  });

  it('returns content unchanged when no mutations configured (claude)', () => {
    const adapter = getAdapter('claude');
    // Claude has no truncation or append configured, only namespace injection
    const withNS = `---\nnamespace: aiwg\nname: sync\ndescription: A skill\n---\n\nBody`;
    const result = mutateFrontmatter(withNS, adapter, NS);
    expect(result).toBe(withNS);
  });

  it('truncates name to maxNameLength for Codex', () => {
    const adapter = getAdapter('codex');
    expect(adapter.maxNameLength).toBe(100);
    const longName = 'a'.repeat(150);
    const content = `---\nname: ${longName}\ndescription: Short desc\n---\n\nBody`;
    const result = mutateFrontmatter(content, adapter, NS);
    const nameMatch = result.match(/^name:\s*(.+)$/m);
    expect(nameMatch?.[1]).toHaveLength(100);
  });

  it('truncates description to maxDescriptionLength for Codex', () => {
    const adapter = getAdapter('codex');
    expect(adapter.maxDescriptionLength).toBe(500);
    const longDesc = 'b'.repeat(600);
    const content = `---\nname: skill\ndescription: ${longDesc}\n---\n\nBody`;
    const result = mutateFrontmatter(content, adapter, NS);
    const descMatch = result.match(/^description:\s*(.+)$/m);
    expect(descMatch?.[1]).toHaveLength(500);
  });

  it('appends Factory suffix to description', () => {
    const adapter = getAdapter('factory');
    expect(adapter.appendToDescription).toBe('Use when relevant to the task.');
    const content = `---\nname: skill\ndescription: Sync AIWG\n---\n\nBody`;
    const result = mutateFrontmatter(content, adapter, NS);
    expect(result).toContain('Sync AIWG Use when relevant to the task.');
  });

  it('does not append Factory suffix if already present', () => {
    const adapter = getAdapter('factory');
    const content = `---\nname: skill\ndescription: Sync AIWG Use when relevant to the task.\n---\n\nBody`;
    const result = mutateFrontmatter(content, adapter, NS);
    const descMatch = result.match(/^description:\s*(.+)$/m);
    // Should not double-append
    expect(descMatch?.[1]).toBe('Sync AIWG Use when relevant to the task.');
  });

  it('returns content unchanged when no YAML frontmatter present', () => {
    const adapter = getAdapter('claude');
    const noFM = 'Just body content without frontmatter.';
    expect(mutateFrontmatter(noFM, adapter, NS)).toBe(noFM);
  });
});

// ============================================
// getAdapter
// ============================================

describe('getAdapter', () => {
  it('returns adapter for all defined platforms', () => {
    const platforms = ['claude', 'cursor', 'codex', 'opencode', 'openclaw',
                       'factory', 'warp', 'devin', 'copilot', 'hermes'];
    for (const p of platforms) {
      const adapter = getAdapter(p);
      expect(adapter).toBeDefined();
      expect(adapter.platform).toBe(p);
    }
  });

  it('falls back to generic for unknown platform', () => {
    const adapter = getAdapter('unknown-platform');
    expect(adapter.platform).toBe('generic');
    expect(adapter.deploymentGroup).toBe('deep-recursion');
  });
});

// ============================================
// Adapter Group Configuration
// ============================================

describe('NAMESPACE_ADAPTERS group assignments', () => {
  // Per ADR source-confirmed matrix (#695 cycle #2):
  // Devin keeps flat deployment until native recursive discovery is confirmed.
  const groupA = ['claude', 'cursor', 'codex', 'opencode', 'openclaw', 'factory', 'warp', 'copilot'];
  const groupB = ['devin'];
  const groupC: string[] = [];
  const groupD = ['hermes'];

  for (const p of groupA) {
    it(`${p}: deep-recursion, subdirLayout=true`, () => {
      const a = NAMESPACE_ADAPTERS[p as keyof typeof NAMESPACE_ADAPTERS];
      expect(a.deploymentGroup).toBe('deep-recursion');
      expect(a.subdirLayout).toBe(true);
    });
  }

  for (const p of groupB) {
    it(`${p}: one-level, subdirLayout=false`, () => {
      const a = NAMESPACE_ADAPTERS[p as keyof typeof NAMESPACE_ADAPTERS];
      expect(a.deploymentGroup).toBe('one-level');
      expect(a.subdirLayout).toBe(false);
    });
  }

  for (const p of groupC) {
    it(`${p}: unknown, subdirLayout=false`, () => {
      const a = NAMESPACE_ADAPTERS[p as keyof typeof NAMESPACE_ADAPTERS];
      expect(a.deploymentGroup).toBe('unknown');
      expect(a.subdirLayout).toBe(false);
    });
  }

  for (const p of groupD) {
    it(`${p}: mcp-skip`, () => {
      const a = NAMESPACE_ADAPTERS[p as keyof typeof NAMESPACE_ADAPTERS];
      expect(a.deploymentGroup).toBe('mcp-skip');
    });
  }

  it('Codex has home-dir pathType', () => {
    expect(NAMESPACE_ADAPTERS.codex.pathType).toBe('home-dir');
  });

  it('OpenClaw has home-dir pathType', () => {
    expect(NAMESPACE_ADAPTERS.openclaw.pathType).toBe('home-dir');
  });

  it('Hermes has home-dir pathType', () => {
    expect(NAMESPACE_ADAPTERS.hermes.pathType).toBe('home-dir');
  });

  it('all project platforms have project pathType', () => {
    const projectPlatforms = ['claude', 'cursor', 'opencode', 'factory', 'warp', 'devin', 'copilot'];
    for (const p of projectPlatforms) {
      expect(NAMESPACE_ADAPTERS[p as keyof typeof NAMESPACE_ADAPTERS].pathType).toBe('project');
    }
  });
});

// ============================================
// getDeploymentPlans — Group A (deep recursion)
// ============================================

describe('getDeploymentPlans — Group A (deep recursion)', () => {
  it('Claude Code: returns 2 plans (canonical subdir + universal slug)', () => {
    const result = getDeploymentPlans('claude', PROJECT, 'sync', SAMPLE_SKILL_MD, NS);
    expect(result.skip).toBe(false);
    expect(result.plans).toHaveLength(2);
    const paths = result.plans.map(p => p.targetPath);
    // Canonical subdir
    expect(paths.some(p => p.includes(`/.claude/skills/aiwg/aiwg-sync/SKILL.md`))).toBe(true);
    // Universal slug
    expect(paths.some(p => p.includes(`/.claude/skills/aiwg-sync/SKILL.md`))).toBe(true);
  });

  it('Cursor: returns 2 plans', () => {
    const result = getDeploymentPlans('cursor', PROJECT, 'sync', SAMPLE_SKILL_MD, NS);
    expect(result.plans).toHaveLength(2);
  });

  it('OpenCode: returns 2 plans with .opencode/skill base', () => {
    const result = getDeploymentPlans('opencode', PROJECT, 'sync', SAMPLE_SKILL_MD, NS);
    expect(result.plans).toHaveLength(2);
    expect(result.plans[0].targetPath).toContain('.opencode/skill');
  });

  it('Codex: returns 2 plans under home dir', () => {
    const result = getDeploymentPlans('codex', PROJECT, 'sync', SAMPLE_SKILL_MD, NS);
    expect(result.plans).toHaveLength(2);
    const home = os.homedir();
    for (const plan of result.plans) {
      expect(plan.targetPath.startsWith(home)).toBe(true);
      expect(plan.targetPath).not.toContain(PROJECT);
    }
  });

  it('plan labels distinguish canonical vs universal', () => {
    const result = getDeploymentPlans('claude', PROJECT, 'sync', SAMPLE_SKILL_MD, NS);
    const labels = result.plans.map(p => p.label);
    expect(labels.some(l => l.includes('canonical'))).toBe(true);
    expect(labels.some(l => l.includes('universal'))).toBe(true);
  });

  it('slug idempotency: aiwg-sync does not become aiwg-aiwg-sync', () => {
    const result = getDeploymentPlans('claude', PROJECT, 'aiwg-sync', SAMPLE_SKILL_MD, NS);
    for (const plan of result.plans) {
      expect(plan.targetPath).not.toContain('aiwg-aiwg-');
    }
  });
});

// ============================================
// getDeploymentPlans — Group A (promoted: Factory, Warp, Copilot)
// ============================================

describe('getDeploymentPlans — Group A (promoted platforms)', () => {
  it('Factory: returns 2 plans with description suffix injected', () => {
    const result = getDeploymentPlans('factory', PROJECT, 'sync', SAMPLE_SKILL_MD, NS);
    expect(result.plans).toHaveLength(2);
    for (const plan of result.plans) {
      expect(plan.content).toContain('Use when relevant to the task.');
    }
  });

  it('Warp: returns 2 plans (deep recursion confirmed)', () => {
    const result = getDeploymentPlans('warp', PROJECT, 'sync', SAMPLE_SKILL_MD, NS);
    expect(result.plans).toHaveLength(2);
    const paths = result.plans.map(p => p.targetPath);
    expect(paths.some(p => p.includes('/aiwg/aiwg-sync/'))).toBe(true);
    expect(paths.some(p => p.includes('.warp/skills/aiwg-sync/SKILL.md'))).toBe(true);
  });

  it('Copilot: returns 2 plans (deep recursion confirmed)', () => {
    const result = getDeploymentPlans('copilot', PROJECT, 'sync', SAMPLE_SKILL_MD, NS);
    expect(result.skip).toBe(false);
    expect(result.plans).toHaveLength(2);
    const paths = result.plans.map(p => p.targetPath);
    expect(paths.some(p => p.includes('.github/skills/aiwg/aiwg-sync/'))).toBe(true);
    expect(paths.some(p => p.includes('.github/skills/aiwg-sync/'))).toBe(true);
  });
});

// ============================================
// getDeploymentPlans — Group B (one-level: Devin Desktop only)
// ============================================

describe('getDeploymentPlans — Group B (one-level)', () => {
  it('Devin Desktop: keeps one flat native plan until recursive discovery is confirmed', () => {
    const result = getDeploymentPlans('devin', PROJECT, 'sync', SAMPLE_SKILL_MD, NS);
    expect(result.skip).toBe(false);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].targetPath).toBe(path.join(PROJECT, '.devin/skills/aiwg-sync/SKILL.md'));
    // Must NOT contain namespace subdir
    expect(result.plans[0].targetPath).not.toContain('/aiwg/aiwg-sync/');
  });
});

// ============================================
// getDeploymentPlans — Group D (mcp-skip)
// ============================================

describe('getDeploymentPlans — Group D (mcp-skip)', () => {
  it('Hermes: returns skip=true, no plans, guidance message', () => {
    const result = getDeploymentPlans('hermes', PROJECT, 'sync', SAMPLE_SKILL_MD, NS);
    expect(result.skip).toBe(true);
    expect(result.plans).toHaveLength(0);
    expect(result.skipMessage).toBeDefined();
    expect(result.skipMessage).toContain('hermes-quickstart.md');
  });
});

// ============================================
// Namespace injection in all plans
// ============================================

describe('namespace frontmatter injection', () => {
  it('all plans include namespace: aiwg in content', () => {
    for (const platform of ['claude', 'cursor', 'devin', 'copilot', 'factory'] as const) {
      const result = getDeploymentPlans(platform, PROJECT, 'sync', SAMPLE_SKILL_MD, NS);
      for (const plan of result.plans) {
        expect(plan.content).toMatch(/^namespace: aiwg$/m);
      }
    }
  });
});
