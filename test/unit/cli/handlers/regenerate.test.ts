/**
 * Unit tests for aiwg regenerate context hook emission.
 *
 * These guard the provider-facing hook files that agents load at session
 * startup: root AIWG.md, AGENTS.md, normalized .aiwg/AIWG.md, and provider
 * twins.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HandlerContext } from '../../../../src/cli/handlers/types.js';

vi.mock('../../../../src/cli/ui.js', () => ({
  blank: vi.fn(),
  rule: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  dim: vi.fn(),
  dimText: vi.fn((s: string) => s),
  bold: vi.fn((s: string) => s),
  brandMark: vi.fn(() => '◆'),
}));

function makeTmpDir(): string {
  const dir = join(tmpdir(), `aiwg-regenerate-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeCtx(tmpDir: string, args: string[] = []): HandlerContext {
  return {
    args,
    rawArgs: ['regenerate', ...args],
    cwd: tmpDir,
    frameworkRoot: tmpDir,
  };
}

function writeConfig(
  tmpDir: string,
  providers: string[] = ['codex'],
  externalLinks?: Record<string, Record<string, string>>,
): void {
  mkdirSync(join(tmpDir, '.aiwg'), { recursive: true });
  writeFileSync(join(tmpDir, '.aiwg', 'aiwg.config'), JSON.stringify({
    version: '1',
    providers,
    installed: {
      sdlc: {
        version: '2026.5.7',
        source: 'bundled',
        installedAt: '2026-05-15T00:00:00.000Z',
        deployedTo: Object.fromEntries(
          providers.map((provider) => [provider, { agents: 1, commands: 0, skills: 1, rules: 1 }]),
        ),
      },
    },
    scripts: {},
    ...(externalLinks ? { externalLinks } : {}),
  }, null, 2));
}

describe('regenerateHandler', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('regenerates root and normalized context hooks for codex', async () => {
    const { regenerateHandler } = await import('../../../../src/cli/handlers/regenerate.js');
    writeConfig(tmpDir, ['codex']);

    const result = await regenerateHandler.execute(makeCtx(tmpDir, ['--provider', 'codex']));
    expect(result.exitCode).toBe(0);

    for (const rel of ['AIWG.md', '.aiwg/AIWG.md']) {
      const content = readFileSync(join(tmpDir, rel), 'utf8');
      expect(content).toContain('## Context Finalization');
      expect(content).toContain('aiwg discover');
      expect(content).toContain('aiwg show');
      expect(content).toContain('sdlc');
    }
    const adapter = readFileSync(join(tmpDir, 'AGENTS.md'), 'utf8');
    expect(adapter.indexOf('WORKSPACE.md')).toBeLessThan(adapter.indexOf('AIWG.md'));
    expect(adapter).not.toContain('## Context Finalization');
  });

  it('exposes validated external links in provider-facing context without fetching them', async () => {
    const { regenerateHandler } = await import('../../../../src/cli/handlers/regenerate.js');
    writeConfig(tmpDir, ['codex'], {
      anonymous_vulnerability_submission: {
        label: 'Anonymous vulnerability submission',
        url: 'https://forms.gle/QvKoijJMtEhLG7nf8',
        description: 'Use this form to submit vulnerability reports anonymously.',
        category: 'security',
      },
    });

    const result = await regenerateHandler.execute(makeCtx(tmpDir, ['--provider', 'codex']));
    expect(result.exitCode).toBe(0);
    const repeated = await regenerateHandler.execute(makeCtx(tmpDir, ['--provider', 'codex']));
    expect(repeated.exitCode).toBe(0);
    for (const rel of ['AIWG.md', '.aiwg/AIWG.md']) {
      const content = readFileSync(join(tmpDir, rel), 'utf8');
      expect(content).toContain('## Project External Links');
      expect(content).toContain('Anonymous vulnerability submission');
      expect(content).toContain('https://forms.gle/QvKoijJMtEhLG7nf8');
      expect(content).toContain('Treat them as links only');
      expect(content.match(/<!-- aiwg-external-links:start -->/g)).toHaveLength(1);
    }
    expect(readFileSync(join(tmpDir, 'AGENTS.md'), 'utf8')).not.toContain('Anonymous vulnerability submission');

    const config = JSON.parse(readFileSync(join(tmpDir, '.aiwg', 'aiwg.config'), 'utf8'));
    expect(config.externalLinks.anonymous_vulnerability_submission.category).toBe('security');
    expect(config.installed.sdlc.version).toBe('2026.5.7');
  });

  it('auto-detects Codex runtime before Claude env or files in mixed workspaces', async () => {
    const { regenerateHandler } = await import('../../../../src/cli/handlers/regenerate.js');
    writeConfig(tmpDir, ['claude', 'codex']);
    mkdirSync(join(tmpDir, '.codex', 'agents'), { recursive: true });
    writeFileSync(join(tmpDir, 'CLAUDE.md'), '# Team Claude Notes\n\nPreserve this file.\n');
    vi.stubEnv('CODEX_HOME', join(tmpDir, '.codex-home'));
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-anthropic-key');

    const result = await regenerateHandler.execute(makeCtx(tmpDir, ['--workspace']));
    expect(result.exitCode).toBe(0);

    expect(existsSync(join(tmpDir, 'AGENTS.md'))).toBe(true);
    expect(readFileSync(join(tmpDir, 'AGENTS.md'), 'utf8')).toContain('WORKSPACE.md');
    expect(readFileSync(join(tmpDir, 'CLAUDE.md'), 'utf8')).toBe('# Team Claude Notes\n\nPreserve this file.\n');
  });

  it('regenerates the muse AGENTS.md bridge deterministically with trust-gated guidance (#227)', async () => {
    const { regenerateHandler } = await import('../../../../src/cli/handlers/regenerate.js');
    writeConfig(tmpDir, ['muse']);

    const first = await regenerateHandler.execute(makeCtx(tmpDir, ['--provider', 'muse']));
    expect(first.exitCode).toBe(0);

    const agentsMd = join(tmpDir, 'AGENTS.md');
    const firstContent = readFileSync(agentsMd, 'utf8');
    expect(firstContent).toContain('first-run trust prompt');
    expect(firstContent).toContain('this AGENTS.md first');
    expect(firstContent).toContain('`aiwg discover "<intent>"`');
    expect(firstContent).toContain('`aiwg show <type> <name>`');
    expect(firstContent).not.toContain('Cursor');
    expect(firstContent).not.toContain('CLAUDE.md');

    // Second run is byte-identical: no timestamps or randomness in generated sections.
    const second = await regenerateHandler.execute(makeCtx(tmpDir, ['--provider', 'muse']));
    expect(second.exitCode).toBe(0);
    expect(readFileSync(agentsMd, 'utf8')).toBe(firstContent);
  });

  it('regenerates Copilot instructions as a provider-facing twin', async () => {
    const { regenerateHandler } = await import('../../../../src/cli/handlers/regenerate.js');
    writeConfig(tmpDir, ['copilot']);

    const result = await regenerateHandler.execute(makeCtx(tmpDir, ['--provider', 'copilot']));
    expect(result.exitCode).toBe(0);

    const copilotPath = join(tmpDir, '.github', 'copilot-instructions.md');
    expect(existsSync(copilotPath)).toBe(true);
    const content = readFileSync(copilotPath, 'utf8');
    expect(content.indexOf('@WORKSPACE.md')).toBeLessThan(content.indexOf('@AIWG.md'));
    expect(content).not.toContain('## Context Finalization');
  });

  it('dry-run reports normalized and provider twin targets without writing', async () => {
    const { regenerateHandler } = await import('../../../../src/cli/handlers/regenerate.js');
    writeConfig(tmpDir, ['copilot']);

    const result = await regenerateHandler.execute(makeCtx(tmpDir, ['--provider', 'copilot', '--dry-run']));
    expect(result.exitCode).toBe(0);

    expect(existsSync(join(tmpDir, 'AIWG.md'))).toBe(false);
    expect(existsSync(join(tmpDir, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(tmpDir, '.aiwg', 'AIWG.md'))).toBe(false);
    expect(existsSync(join(tmpDir, '.github', 'copilot-instructions.md'))).toBe(false);
  });

  it('executes the legacy full-injection branch without creating WORKSPACE.md', async () => {
    const { regenerateHandler } = await import('../../../../src/cli/handlers/regenerate.js');
    writeConfig(tmpDir, ['codex']);

    const result = await regenerateHandler.execute(makeCtx(tmpDir, ['--provider', 'codex', '--full-inject']));
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(tmpDir, 'WORKSPACE.md'))).toBe(false);
    const adapter = readFileSync(join(tmpDir, 'AGENTS.md'), 'utf8');
    expect(adapter).toContain('<!-- BEGIN AIWG -->');
    expect(adapter).toContain('<!-- END AIWG -->');
    expect(adapter).not.toContain('@WORKSPACE.md');
    expect(existsSync(join(tmpDir, '.aiwg', 'AIWG.md'))).toBe(true);
  });

  it('legacy dry-run is non-mutating', async () => {
    const { regenerateHandler } = await import('../../../../src/cli/handlers/regenerate.js');
    writeConfig(tmpDir, ['codex']);
    const result = await regenerateHandler.execute(makeCtx(tmpDir, ['--provider', 'codex', '--legacy', '--dry-run']));
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(tmpDir, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(tmpDir, '.aiwg', 'AIWG.md'))).toBe(false);
  });

  it('legacy mode honors granular AIWG and adapter skips', async () => {
    const { regenerateHandler } = await import('../../../../src/cli/handlers/regenerate.js');
    writeConfig(tmpDir, ['codex']);
    const result = await regenerateHandler.execute(makeCtx(tmpDir, [
      '--provider', 'codex', '--legacy', '--no-aiwg-md', '--no-agents-md',
    ]));
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(tmpDir, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(tmpDir, '.aiwg', 'AIWG.md'))).toBe(false);
  });

  it('previews existing-project extraction without writes and requires explicit apply', async () => {
    const { regenerateHandler } = await import('../../../../src/cli/handlers/regenerate.js');
    writeConfig(tmpDir, ['codex']);
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({
      name: 'existing-fixture', scripts: { build: 'tsc', test: 'vitest' },
    }));
    writeFileSync(join(tmpDir, 'README.md'), '# Fixture\n\nAn established fixture project for regeneration tests.\n');
    writeFileSync(join(tmpDir, 'AGENTS.override.md'), 'Always run fixture tests.\n');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await regenerateHandler.execute(makeCtx(tmpDir, ['--provider', 'codex', '--existing-project']));

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(tmpDir, 'WORKSPACE.md'))).toBe(false);
    expect(existsSync(join(tmpDir, '.aiwg', 'context-migrations'))).toBe(false);
    const output = consoleSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('canonical existing-project extraction');
    expect(output).toContain('Re-run with --apply');
    consoleSpy.mockRestore();
  });

  it('applies existing-project extraction as one rollback-capable transaction', async () => {
    const { regenerateHandler } = await import('../../../../src/cli/handlers/regenerate.js');
    writeConfig(tmpDir, ['codex']);
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'existing-fixture' }));
    writeFileSync(join(tmpDir, 'README.md'), '# Fixture\n\nAn established fixture project for transactional regeneration.\n');
    writeFileSync(join(tmpDir, 'AGENTS.override.md'), 'Always run fixture tests.\n');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await regenerateHandler.execute(makeCtx(tmpDir, [
      '--provider', 'codex', '--existing-project', '--apply',
    ]));

    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(tmpDir, 'WORKSPACE.md'), 'utf8')).toContain('## Existing Project Snapshot');
    expect(readFileSync(join(tmpDir, 'AGENTS.override.md'), 'utf8')).toContain('WORKSPACE.md');
    const output = consoleSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('Transaction:');
    expect(output).toContain('aiwg workspace-context rollback');
    consoleSpy.mockRestore();
  });

  it('keeps inferred adoption read-only until an explicit apply', async () => {
    const { regenerateHandler } = await import('../../../../src/cli/handlers/regenerate.js');
    writeConfig(tmpDir, ['codex']);
    writeFileSync(join(tmpDir, 'Gemfile'), "source 'https://rubygems.org'\ngem 'rails'\n");
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const preview = await regenerateHandler.execute(makeCtx(tmpDir, ['--provider', 'codex']));
    expect(preview.exitCode).toBe(0);
    expect(existsSync(join(tmpDir, 'WORKSPACE.md'))).toBe(false);
    let output = consoleSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('Selected: inferred');
    expect(output).toContain('existing-project');
    expect(output).toContain('Re-run with --apply');

    consoleSpy.mockClear();
    const applied = await regenerateHandler.execute(makeCtx(tmpDir, ['--provider', 'codex', '--apply']));
    expect(applied.exitCode).toBe(0);
    expect(readFileSync(join(tmpDir, 'WORKSPACE.md'), 'utf8')).toContain('Gemfile');
    output = consoleSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('Transaction:');
    expect(output).toContain('aiwg workspace-context rollback');
    consoleSpy.mockRestore();
  });

  it.each(['--force', '--no-aiwg-md', '--no-agents-md', '--no-workspace-md'])(
    'rejects %s when inference selects existing-project adoption',
    async (control) => {
      const { regenerateHandler } = await import('../../../../src/cli/handlers/regenerate.js');
      writeConfig(tmpDir, ['codex']);
      writeFileSync(join(tmpDir, 'Gemfile'), "source 'https://rubygems.org'\n");

      const result = await regenerateHandler.execute(makeCtx(tmpDir, ['--provider', 'codex', control]));
      expect(result.exitCode).toBe(2);
      expect(result.message).toMatch(/complete transaction/);
      expect(existsSync(join(tmpDir, 'WORKSPACE.md'))).toBe(false);
    },
  );

  it('leaves a fresh project unchanged in existing-project mode', async () => {
    const { regenerateHandler } = await import('../../../../src/cli/handlers/regenerate.js');
    writeConfig(tmpDir, ['codex']);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await regenerateHandler.execute(makeCtx(tmpDir, [
      '--provider', 'codex', '--existing-project', '--apply',
    ]));

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(tmpDir, 'WORKSPACE.md'))).toBe(false);
    expect(consoleSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain('No stable existing-project signals');
    consoleSpy.mockRestore();
  });

  it('rejects unknown options instead of silently ignoring them', async () => {
    const { regenerateHandler } = await import('../../../../src/cli/handlers/regenerate.js');
    writeConfig(tmpDir, ['codex']);
    const result = await regenerateHandler.execute(makeCtx(tmpDir, ['--provider', 'codex', '--not-a-mode']));
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/Unknown regenerate option/);
  });

  it('rejects conflicting regenerate branches', async () => {
    const { regenerateHandler } = await import('../../../../src/cli/handlers/regenerate.js');
    writeConfig(tmpDir, ['codex']);
    const result = await regenerateHandler.execute(makeCtx(tmpDir, ['--workspace', '--full-inject']));
    expect(result.exitCode).toBe(2);
  });

  it.each([
    ['--existing-project', '--workspace'],
    ['--existing-project', '--full-inject'],
    ['--existing-project', '--dry-run', '--apply'],
    ['--workspace', '--apply'],
    ['--existing-project', '--force'],
    ['--existing-project', '--no-aiwg-md'],
  ])('rejects invalid branch/control combination %s %s', async (...flags) => {
    const { regenerateHandler } = await import('../../../../src/cli/handlers/regenerate.js');
    writeConfig(tmpDir, ['codex']);
    const result = await regenerateHandler.execute(makeCtx(tmpDir, flags));
    expect(result.exitCode).toBe(2);
  });
});
