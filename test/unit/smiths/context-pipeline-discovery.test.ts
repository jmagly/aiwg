/**
 * context-pipeline discovery tests.
 *
 * Covers `discoverSection` and `discoverDeployedArtifacts` against a temporary
 * filesystem fixture that mirrors the real per-provider deploy layout.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  discoverSection,
  discoverDeployedArtifacts,
  shouldEmitContextFiles,
  shouldEmitAiwgMd,
  shouldEmitAgentsMd,
  shouldEmitClaudeMdHook,
  AGENTS_MD_PROVIDERS,
  generateAiwgMd,
  ensureClaudeMdHook,
  CLAUDE_HOOK_START,
  CLAUDE_HOOK_END,
} from '../../../src/smiths/context-pipeline/index.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiwg-ctx-pipeline-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeMd(rel: string, frontmatter: Record<string, unknown>, body = '# heading\n'): Promise<void> {
  const abs = path.join(tmpDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const fmLines = ['---'];
  for (const [k, v] of Object.entries(frontmatter)) {
    if (Array.isArray(v)) {
      fmLines.push(`${k}: [${v.map((x) => JSON.stringify(x)).join(', ')}]`);
    } else if (typeof v === 'string') {
      fmLines.push(`${k}: "${v}"`);
    } else {
      fmLines.push(`${k}: ${v}`);
    }
  }
  fmLines.push('---', '');
  await fs.writeFile(abs, fmLines.join('\n') + body, 'utf8');
}

describe('discoverSection', () => {
  it('returns empty section when relativeDir is empty string', async () => {
    const r = await discoverSection('agents', tmpDir, '');
    expect(r.entries).toEqual([]);
    expect(r.type).toBe('agents');
  });

  it('returns empty section when directory does not exist', async () => {
    const r = await discoverSection('agents', tmpDir, '.codex/agents');
    expect(r.entries).toEqual([]);
  });

  it('discovers agent files with frontmatter metadata', async () => {
    await writeMd('.codex/agents/api-designer.md', {
      name: 'api-designer',
      description: 'Designs API contracts',
      tags: ['design', 'api'],
    });
    await writeMd('.codex/agents/security-architect.md', {
      name: 'security-architect',
      description: 'Threat modeling and release gates',
    });
    const r = await discoverSection('agents', tmpDir, '.codex/agents');
    expect(r.entries).toHaveLength(2);
    expect(r.entries[0].id).toBe('api-designer');
    expect(r.entries[0].description).toBe('Designs API contracts');
    expect(r.entries[0].tags).toEqual(['design', 'api']);
    expect(r.entries[0].path).toBe('.codex/agents/api-designer.md');
  });

  it('falls back to filename basename when frontmatter is absent', async () => {
    const dir = path.join(tmpDir, '.codex/agents');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'plain.md'), '# Plain\nno frontmatter\n', 'utf8');
    const r = await discoverSection('agents', tmpDir, '.codex/agents');
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].id).toBe('plain');
    expect(r.entries[0].description).toBe('(no description)');
  });

  it('discovers skill folders by SKILL.md presence', async () => {
    await writeMd('.codex/skills/foo/SKILL.md', {
      name: 'foo',
      description: 'A foo skill',
    });
    await writeMd('.codex/skills/bar/SKILL.md', {
      name: 'bar',
      description: 'A bar skill',
    });
    const r = await discoverSection('skills', tmpDir, '.codex/skills');
    expect(r.entries).toHaveLength(2);
    const ids = r.entries.map((e) => e.id).sort();
    expect(ids).toEqual(['bar', 'foo']);
    // Path format uses forward slashes (portable across providers/OS).
    expect(r.entries[0].path).toContain('/SKILL.md');
  });

  it('skips skill folders without SKILL.md', async () => {
    await fs.mkdir(path.join(tmpDir, '.codex/skills/incomplete'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.codex/skills/incomplete/README.md'), 'no SKILL.md here\n', 'utf8');
    const r = await discoverSection('skills', tmpDir, '.codex/skills');
    expect(r.entries).toEqual([]);
  });

  it('marks safety-critical artifacts', async () => {
    await writeMd('.codex/rules/human-authorization.md', {
      name: 'human-authorization',
      description: 'Operator approval before irreversible actions',
      'safety-critical': true,
    });
    const r = await discoverSection('rules', tmpDir, '.codex/rules');
    expect(r.entries[0].safetyCritical).toBe(true);
  });

  it('handles tags as a comma-string when frontmatter uses string syntax', async () => {
    await writeMd('.codex/agents/foo.md', {
      name: 'foo',
      description: 'A foo',
      tags: 'design, api, contracts',
    });
    const r = await discoverSection('agents', tmpDir, '.codex/agents');
    expect(r.entries[0].tags).toEqual(['design', 'api', 'contracts']);
  });

  it('emits paths with forward slashes for cross-platform AGENTS.md portability', async () => {
    await writeMd('.codex/agents/portable.md', { name: 'portable', description: 'A portable agent' });
    const r = await discoverSection('agents', tmpDir, '.codex/agents');
    // Forward-slash normalization is applied at emission time so AGENTS.md
    // is portable from a Linux deploy to a Windows reader (and vice versa).
    expect(r.entries[0].path).not.toContain('\\');
    expect(r.entries[0].path.split('/').length).toBeGreaterThanOrEqual(2);
  });
});

describe('discoverDeployedArtifacts', () => {
  it('returns the four canonical sections in agents/rules/skills/behaviors order, dropping empties', async () => {
    await writeMd('.codex/agents/api.md', { name: 'api', description: 'API agent' });
    await writeMd('.codex/skills/foo/SKILL.md', { name: 'foo', description: 'foo' });
    const sections = await discoverDeployedArtifacts(tmpDir, {
      agents: '.codex/agents',
      rules: '.codex/rules', // empty
      skills: '.codex/skills',
      behaviors: '.codex/behaviors', // empty
    });
    // Empty sections are dropped.
    expect(sections).toHaveLength(2);
    expect(sections[0].type).toBe('agents');
    expect(sections[1].type).toBe('skills');
  });

  it('returns empty array when nothing was deployed', async () => {
    const sections = await discoverDeployedArtifacts(tmpDir, {
      agents: '.codex/agents',
      rules: '.codex/rules',
      skills: '.codex/skills',
      behaviors: '.codex/behaviors',
    });
    expect(sections).toEqual([]);
  });
});

describe('provider policy', () => {
  it('emits AIWG.md/AGENTS.md for providers that need generated context bridges', () => {
    expect(shouldEmitContextFiles('antigravity')).toBe(true);
    expect(shouldEmitContextFiles('codex')).toBe(true);
    expect(shouldEmitContextFiles('copilot')).toBe(true);
    expect(shouldEmitContextFiles('cursor')).toBe(true);
    expect(shouldEmitContextFiles('windsurf')).toBe(true);
    expect(shouldEmitContextFiles('hermes')).toBe(true);
    expect(shouldEmitContextFiles('warp')).toBe(true);
    expect(shouldEmitContextFiles('factory')).toBe(true);
    expect(shouldEmitContextFiles('opencode')).toBe(true);
    expect(shouldEmitContextFiles('pi')).toBe(true);
    expect(shouldEmitContextFiles('grokbot')).toBe(true);
    expect(shouldEmitContextFiles('grok-build')).toBe(true);
    expect(shouldEmitContextFiles('muse')).toBe(true);
    expect(shouldEmitContextFiles('openhuman')).toBe(false);
    expect(AGENTS_MD_PROVIDERS.size).toBe(14);
  });

  // #1437: claude is no longer skipped — it gets AIWG.md emission + CLAUDE.md hook
  it('DOES emit context files for Claude (#1437) — AIWG.md + CLAUDE.md hook', () => {
    expect(shouldEmitContextFiles('claude')).toBe(true);
    expect(shouldEmitAiwgMd('claude')).toBe(true);
    expect(shouldEmitAgentsMd('claude')).toBe(false);
    expect(shouldEmitClaudeMdHook('claude')).toBe(true);
  });

  it('does NOT emit for OpenClaw (home-dir-only deployment)', () => {
    expect(shouldEmitContextFiles('openclaw')).toBe(false);
    expect(shouldEmitAiwgMd('openclaw')).toBe(false);
    expect(shouldEmitAgentsMd('openclaw')).toBe(false);
    expect(shouldEmitClaudeMdHook('openclaw')).toBe(false);
  });

  it('does NOT emit for OpenHuman (home-dir-only deployment)', () => {
    expect(shouldEmitContextFiles('openhuman')).toBe(false);
    expect(shouldEmitAiwgMd('openhuman')).toBe(false);
    expect(shouldEmitAgentsMd('openhuman')).toBe(false);
    expect(shouldEmitClaudeMdHook('openhuman')).toBe(false);
  });

  it('does NOT emit for generic', () => {
    expect(shouldEmitContextFiles('generic')).toBe(false);
    expect(shouldEmitAiwgMd('generic')).toBe(false);
    expect(shouldEmitAgentsMd('generic')).toBe(false);
    expect(shouldEmitClaudeMdHook('generic')).toBe(false);
  });

  it('granular gates: AGENTS_MD providers get AIWG.md AND AGENTS.md but NOT claude hook', () => {
    for (const p of ['codex', 'copilot', 'cursor', 'windsurf', 'hermes', 'warp', 'factory', 'opencode'] as const) {
      expect(shouldEmitAiwgMd(p)).toBe(true);
      expect(shouldEmitAgentsMd(p)).toBe(true);
      expect(shouldEmitClaudeMdHook(p)).toBe(false);
    }
  });
});

describe('ensureClaudeMdHook (#1437)', () => {
  it('creates CLAUDE.md with the hook block when CLAUDE.md is missing', async () => {
    const result = await ensureClaudeMdHook(tmpDir);
    expect(result.action).toBe('created');
    expect(result.claudeMdPath).toBe(path.join(tmpDir, 'CLAUDE.md'));
    const content = await fs.readFile(result.claudeMdPath, 'utf8');
    expect(content).toContain(CLAUDE_HOOK_START);
    expect(content).toContain(CLAUDE_HOOK_END);
    expect(content).toContain('@AIWG.md');
    expect(content).toContain('@.aiwg/aiwg.config');
    expect(content).toContain('Provider-native presentation/export: explicit-only');
    expect(content).toContain('Never substitute, relocate, or omit the canonical AIWG plan/review artifact');
  });

  it('compiles the resolved Claude Design destination policy into the managed block', async () => {
    await fs.mkdir(path.join(tmpDir, '.aiwg'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.aiwg', 'aiwg.config'), JSON.stringify({
      version: '1', providers: ['claude'], installed: {}, scripts: {},
      artifact_outputs: { canonical: 'aiwg', provider_native: 'disabled', destinations: { 'claude-code.design': { enabled: false, use_when: 'disabled' } } },
    }));
    const result = await ensureClaudeMdHook(tmpDir);
    const content = await fs.readFile(result.claudeMdPath, 'utf8');
    expect(content).toContain('Provider-native presentation/export: disabled');
    expect(content).toContain('Claude Design: disabled by project policy');
  });

  it('appends the hook block when CLAUDE.md exists without the markers', async () => {
    const original = '# My Project\n\nSome operator content.\n';
    await fs.writeFile(path.join(tmpDir, 'CLAUDE.md'), original, 'utf8');
    const result = await ensureClaudeMdHook(tmpDir);
    expect(result.action).toBe('inserted');
    const content = await fs.readFile(result.claudeMdPath, 'utf8');
    expect(content).toContain('# My Project');
    expect(content).toContain('Some operator content.');
    expect(content).toContain(CLAUDE_HOOK_START);
    expect(content).toContain(CLAUDE_HOOK_END);
    expect(content).toContain('@AIWG.md');
    expect(content).toContain('@.aiwg/aiwg.config');
    // Operator content appears before the block
    const operatorIdx = content.indexOf('Some operator content.');
    const blockIdx = content.indexOf(CLAUDE_HOOK_START);
    expect(operatorIdx).toBeLessThan(blockIdx);
  });

  it('migrates a generated provider bootstrap in place without duplicate includes (#1867)', async () => {
    const initialized = [
      '# Provider workspace bootstrap',
      '<!-- aiwg-managed -->',
      '<!-- AIWG:provider-bootstrap:start -->',
      '',
      '@WORKSPACE.md',
      '@AIWG.md',
      '',
      '<!-- AIWG:provider-bootstrap:end -->',
      '',
    ].join('\n');
    await fs.writeFile(path.join(tmpDir, 'CLAUDE.md'), initialized, 'utf8');

    const result = await ensureClaudeMdHook(tmpDir);
    const content = await fs.readFile(result.claudeMdPath, 'utf8');

    expect(result.action).toBe('updated');
    expect((content.match(/AIWG:claude-md-hook:start/g) ?? [])).toHaveLength(1);
    expect((content.match(/^@WORKSPACE\.md$/gm) ?? [])).toHaveLength(1);
    expect((content.match(/^@AIWG\.md$/gm) ?? [])).toHaveLength(1);
    expect((content.match(/^@\.aiwg\/aiwg\.config$/gm) ?? [])).toHaveLength(1);

    const once = content;
    expect((await ensureClaudeMdHook(tmpDir)).action).toBe('unchanged');
    expect(await fs.readFile(result.claudeMdPath, 'utf8')).toBe(once);
  });

  it('byte-preserves operator content surrounding a migrated bootstrap (#1867)', async () => {
    const before = '# Operator header\r\ncustom: true\r\n';
    const managed = [
      '<!-- AIWG:provider-bootstrap:start -->',
      '@WORKSPACE.md',
      '@AIWG.md',
      '<!-- AIWG:provider-bootstrap:end -->',
    ].join('\n');
    const after = '\r\n# Operator footer\r\nKeep this exactly.\r\n';
    await fs.writeFile(path.join(tmpDir, 'CLAUDE.md'), before + managed + after, 'utf8');

    const result = await ensureClaudeMdHook(tmpDir);
    const content = await fs.readFile(result.claudeMdPath, 'utf8');

    expect(result.action).toBe('updated');
    expect(content.startsWith(before)).toBe(true);
    expect(content.endsWith(after)).toBe(true);
  });

  it('refuses to append when legacy provider-bootstrap markers are malformed', async () => {
    const malformed = '# Operator content\n<!-- AIWG:provider-bootstrap:start -->\n@WORKSPACE.md\n';
    await fs.writeFile(path.join(tmpDir, 'CLAUDE.md'), malformed, 'utf8');

    const result = await ensureClaudeMdHook(tmpDir);

    expect(result.action).toBe('skipped');
    expect(result.warnings.join('\n')).toContain('malformed');
    expect(await fs.readFile(result.claudeMdPath, 'utf8')).toBe(malformed);
  });

  it('returns unchanged when the hook block is already canonical', async () => {
    await ensureClaudeMdHook(tmpDir); // first call creates
    const result2 = await ensureClaudeMdHook(tmpDir);
    expect(result2.action).toBe('unchanged');
  });

  it('preserves operator content outside the block when updating drifted content inside', async () => {
    // First create the block, then manually modify content inside
    await ensureClaudeMdHook(tmpDir);
    const initial = await fs.readFile(path.join(tmpDir, 'CLAUDE.md'), 'utf8');
    const operatorAdded = '# Operator Section\n\nThis is outside the block.\n\n' + initial + '\n# After Block\n\nMore operator content.\n';
    const drifted = operatorAdded.replace('@AIWG.md', '@AIWG.md\n@some-other-thing.md');
    await fs.writeFile(path.join(tmpDir, 'CLAUDE.md'), drifted, 'utf8');

    const result = await ensureClaudeMdHook(tmpDir);
    expect(result.action).toBe('updated');
    expect(result.warnings.length).toBeGreaterThan(0);

    const updated = await fs.readFile(result.claudeMdPath, 'utf8');
    // Operator content is preserved
    expect(updated).toContain('# Operator Section');
    expect(updated).toContain('This is outside the block.');
    expect(updated).toContain('# After Block');
    expect(updated).toContain('More operator content.');
    // Drift inside the block is replaced
    expect(updated).not.toContain('@some-other-thing.md');
  });

  it('with --force, backs up the file before replacing a drifted block', async () => {
    await ensureClaudeMdHook(tmpDir);
    const initial = await fs.readFile(path.join(tmpDir, 'CLAUDE.md'), 'utf8');
    const drifted = initial.replace('@AIWG.md', '@AIWG.md\n@operator-customization.md');
    await fs.writeFile(path.join(tmpDir, 'CLAUDE.md'), drifted, 'utf8');

    const result = await ensureClaudeMdHook(tmpDir, { force: true });
    expect(result.action).toBe('updated');
    expect(result.backupPath).toBeDefined();
    if (result.backupPath) {
      const backup = await fs.readFile(result.backupPath, 'utf8');
      expect(backup).toContain('@operator-customization.md');
    }
  });
});

describe('generateAiwgMd', () => {
  it('mirrors CLAUDE.md content with the AIWG signature inserted, stripping the @AIWG.md self-include (#1268)', async () => {
    const claudeMd = '# AIWG\n\n@AIWG.md\n\nSome project context here.\n';
    await fs.writeFile(path.join(tmpDir, 'CLAUDE.md'), claudeMd, 'utf8');
    const content = await generateAiwgMd(tmpDir);
    expect(content).toContain('# AIWG');
    expect(content).toContain('<!-- aiwg-managed -->');
    // #1268: AIWG.md IS the content that @AIWG.md would include, so the
    // directive must not survive into AIWG.md as a self-reference.
    expect(content).not.toMatch(/^\s*@AIWG\.md\s*$/m);
    expect(content).toContain('Some project context here.');
  });

  it('does not double-insert signature when CLAUDE.md already carries one', async () => {
    const claudeMd = '# AIWG\n<!-- aiwg-managed -->\nbody\n';
    await fs.writeFile(path.join(tmpDir, 'CLAUDE.md'), claudeMd, 'utf8');
    const content = await generateAiwgMd(tmpDir);
    const signatureCount = (content.match(/<!-- aiwg-managed -->/g) || []).length;
    expect(signatureCount).toBe(1);
  });

  it('falls back to a stub when CLAUDE.md is absent', async () => {
    const content = await generateAiwgMd(tmpDir);
    expect(content).toContain('# AIWG.md');
    expect(content).toContain('<!-- aiwg-managed -->');
    expect(content).toContain('CLAUDE.md was not found');
  });
});
