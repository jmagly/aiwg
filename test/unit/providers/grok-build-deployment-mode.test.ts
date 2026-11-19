// Exercise Grok native agent selection through the existing deployment entry point.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../../tools/agents/deploy-agents.mjs';
import { bundleProviderCopyArgs } from '../../../src/cli/handlers/bundle-deployment-mode.js';

let root: string;
let source: string;
let target: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aiwg-grok-mode-'));
  source = join(root, 'source'); target = join(root, 'project');
  mkdirSync(join(source, 'agents'), { recursive: true });
  mkdirSync(target);
  writeFileSync(join(source, 'agents/fixture-role.md'),
    '---\nname: fixture-role\ndescription: Synthetic coding role\nmodel: sonnet\n---\n\nPreserve the complete role prompt.\n');
  for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
    vi.stubEnv(key, join(root, 'home', key));
  }
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe('Grok native agent deployment modes', () => {
  it.each([
    { flags: bundleProviderCopyArgs([]), agents: false },
    { flags: ['--copy-all'], agents: true },
    { flags: ['--discovery-only'], agents: false },
    { flags: ['--kernel-only'], agents: false },
    { flags: ['--discovery-only', '--kernel-only'], agents: false },
    { flags: ['--discovery-only', '--skills-only'], agents: false },
    { flags: ['--discovery-only', '--commands-only'], agents: false },
    { flags: ['--discovery-only', '--rules-only'], agents: false },
  ])('retains explicit scope for $flags', async ({ flags, agents }) => {
    expect(await main(['--source', source, '--target', target, '--provider', 'grok-build',
      '--mode', 'all', '--no-context-files', '--skip-commands-migration', '--quiet', ...flags])).toBe(0);
    const file = join(target, '.grok/agents/fixture-role.md');
    expect(existsSync(file)).toBe(agents);
    if (agents) {
      const content = readFileSync(file, 'utf8');
      expect(content).toContain('AIWG model role: coding');
      expect(content).toContain('Preserve the complete role prompt.');
      expect(content.split('---')[1]).not.toContain('model:');
    }
  });

  it('keeps discovery-only deployment unchanged for other providers', async () => {
    expect(await main(['--source', source, '--target', target, '--provider', 'claude',
      '--discovery-only', '--no-context-files', '--skip-commands-migration', '--quiet'])).toBe(0);
    expect(existsSync(join(target, '.claude/agents/fixture-role.md'))).toBe(false);
  });
});
