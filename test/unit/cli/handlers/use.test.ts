/**
 * Unit tests for use.ts — addon discovery and disallow list logic
 *
 * Tests the three exported utility functions:
 *   - getAllAddons()  — discovers addon dirs, applies disallow list
 *   - getAllExtensions() — discovers deployable extension dirs
 *   - isValidAddon() — validates a name against fs + disallow list
 *   - addonPath()    — constructs source path, handles ring alias
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import {
  getAllAddons,
  getAllExtensions,
  isValidAddon,
  addonPath,
  resolveRequiredAddonActivationOrder,
  extensionPath,
  USE_ALL_DISALLOW,
  useHandler,
  nextStepsFor,
  deployOpenHumanHarnessAgents,
  parseOpenHumanHarnessAgentSelector,
  resolveOpenHumanHarnessAgentSelectors,
} from '../../../../src/cli/handlers/use.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createFakeAddonTree(root: string, addonNames: string[]) {
  const addonsDir = path.join(root, 'agentic', 'code', 'addons');
  await mkdir(addonsDir, { recursive: true });
  for (const name of addonNames) {
    await mkdir(path.join(addonsDir, name), { recursive: true });
  }
  return addonsDir;
}

async function createFakeExtensionTree(root: string, extensionNames: string[]) {
  const extensionsDir = path.join(root, 'agentic', 'code', 'extensions');
  await mkdir(extensionsDir, { recursive: true });
  for (const name of extensionNames) {
    const dir = path.join(extensionsDir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ id: name }));
  }
  return extensionsDir;
}

// ---------------------------------------------------------------------------
// USE_ALL_DISALLOW
// ---------------------------------------------------------------------------

describe('USE_ALL_DISALLOW', () => {
  it('contains aiwg-dev', () => {
    expect(USE_ALL_DISALLOW.has('aiwg-dev')).toBe(true);
  });

  it('does not contain any standard addon', () => {
    const standardAddons = ['aiwg-utils', 'ralph', 'rlm', 'daemon', 'ring-methodology', 'voice-framework'];
    for (const addon of standardAddons) {
      expect(USE_ALL_DISALLOW.has(addon)).toBe(false);
    }
  });
});

describe('nextStepsFor()', () => {
  it('keeps default aiwg use success guidance platform-first and steward-first', () => {
    const steps = nextStepsFor('sdlc');
    const output = steps.join('\n');

    expect(output).toContain('Open platform');
    expect(output).toContain('Ask the steward');
    expect(output).toContain('/aiwg-regenerate');
    expect(output).toContain('aiwg doctor');
    expect(output).toContain('docs/agentic-install-runbook.md');
    expect(output).not.toContain('aiwg discover');
    expect(output).not.toContain('aiwg sdlc-accelerate');
  });

  it('keeps provider-specific handoffs out of agent-oriented CLI commands', () => {
    const output = nextStepsFor('sdlc', 'codex').join('\n');

    expect(output).toContain('Open Codex');
    expect(output).toContain('Ask the steward');
    expect(output).toContain('$aiwg-regenerate');
    expect(output).not.toContain('/aiwg-regenerate');
    expect(output).not.toContain('aiwg discover');
    expect(output).not.toContain('aiwg sdlc-accelerate');
  });

  it('uses Codex skill syntax for framework fallbacks and its openai alias', () => {
    expect(nextStepsFor('marketing', 'codex').join('\n')).toContain('$aiwg-regenerate');
    expect(nextStepsFor('sdlc', 'openai').join('\n')).toContain('$aiwg-regenerate');
  });
});

// ---------------------------------------------------------------------------
// addonPath()
// ---------------------------------------------------------------------------

describe('addonPath()', () => {
  it('constructs path from framework root and addon name', () => {
    const result = addonPath('/some/root', 'agent-loop');
    expect(result).toBe('/some/root/agentic/code/addons/agent-loop');
  });

  it('maps ralph legacy alias to agent-loop folder', () => {
    const result = addonPath('/some/root', 'ralph');
    expect(result).toBe('/some/root/agentic/code/addons/agent-loop');
  });

  it('maps ring alias to ring-methodology folder', () => {
    const result = addonPath('/some/root', 'ring');
    expect(result).toBe('/some/root/agentic/code/addons/ring-methodology');
  });

  it('passes through all other names unchanged', () => {
    const names = ['aiwg-utils', 'rlm', 'daemon', 'voice-framework', 'auto-memory'];
    for (const name of names) {
      expect(addonPath('/root', name)).toBe(`/root/agentic/code/addons/${name}`);
    }
  });
});

describe('resolveRequiredAddonActivationOrder()', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `aiwg-addon-deps-${Date.now()}-${Math.random()}`);
    await mkdir(path.join(tmpDir, 'agentic/code/addons'), { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(tmpDir)) await rm(tmpDir, { recursive: true, force: true });
  });

  async function addon(id: string, required: string[] = []): Promise<void> {
    const dir = path.join(tmpDir, 'agentic/code/addons', id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
      id,
      dependencies: { required },
    }));
  }

  it('returns transitive dependencies once in dependency-first order', async () => {
    await addon('aiwg-utils');
    await addon('semantic-memory', ['aiwg-utils']);
    await addon('llm-wiki', ['semantic-memory']);
    await addon('line-memory');
    await addon('compound-memory', ['line-memory', 'llm-wiki']);

    await expect(resolveRequiredAddonActivationOrder(tmpDir, 'compound-memory'))
      .resolves.toEqual(['line-memory', 'aiwg-utils', 'semantic-memory', 'llm-wiki', 'compound-memory']);
  });

  it('rejects missing dependencies and dependency cycles before deployment', async () => {
    await addon('missing-root', ['not-installed']);
    await expect(resolveRequiredAddonActivationOrder(tmpDir, 'missing-root'))
      .rejects.toThrow("requires unavailable addon 'not-installed'");

    await addon('cycle-a', ['cycle-b']);
    await addon('cycle-b', ['cycle-a']);
    await expect(resolveRequiredAddonActivationOrder(tmpDir, 'cycle-a'))
      .rejects.toThrow('cycle-a -> cycle-b -> cycle-a');
  });

  it('rejects malformed required dependency declarations', async () => {
    const dir = path.join(tmpDir, 'agentic/code/addons', 'malformed');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
      id: 'malformed', dependencies: { required: 'line-memory' },
    }));

    await expect(resolveRequiredAddonActivationOrder(tmpDir, 'malformed'))
      .rejects.toThrow('invalid dependencies.required');
  });
});

describe('extensionPath()', () => {
  it('constructs path from framework root and extension name', () => {
    const result = extensionPath('/some/root', 'repo-maintainer');
    expect(result).toBe('/some/root/agentic/code/extensions/repo-maintainer');
  });
});

// ---------------------------------------------------------------------------
// getAllAddons()
// ---------------------------------------------------------------------------

describe('getAllAddons()', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `aiwg-use-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(tmpDir)) await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns all addon directory names', async () => {
    await createFakeAddonTree(tmpDir, ['aiwg-utils', 'ralph', 'rlm']);
    const addons = await getAllAddons(tmpDir);
    expect(addons).toContain('aiwg-utils');
    expect(addons).toContain('ralph');
    expect(addons).toContain('rlm');
  });

  it('excludes aiwg-dev from results', async () => {
    await createFakeAddonTree(tmpDir, ['aiwg-utils', 'ralph', 'aiwg-dev', 'daemon']);
    const addons = await getAllAddons(tmpDir);
    expect(addons).not.toContain('aiwg-dev');
  });

  it('excludes all entries in USE_ALL_DISALLOW', async () => {
    const all = ['aiwg-utils', 'ralph', ...USE_ALL_DISALLOW];
    await createFakeAddonTree(tmpDir, all);
    const addons = await getAllAddons(tmpDir);
    for (const disallowed of USE_ALL_DISALLOW) {
      expect(addons).not.toContain(disallowed);
    }
  });

  it('excludes addons whose manifest sets explicitInstall or devOnly (#2641)', async () => {
    const addonsDir = await createFakeAddonTree(tmpDir, ['aiwg-utils', 'opt-in', 'contributor', 'plain']);
    await writeFile(path.join(addonsDir, 'opt-in', 'manifest.json'), JSON.stringify({ explicitInstall: true, autoInstall: false }));
    await writeFile(path.join(addonsDir, 'contributor', 'manifest.json'), JSON.stringify({ devOnly: true }));
    await writeFile(path.join(addonsDir, 'plain', 'manifest.json'), JSON.stringify({ autoInstall: false }));
    await writeFile(path.join(addonsDir, 'aiwg-utils', 'manifest.json'), '{ not json');
    const addons = await getAllAddons(tmpDir);
    expect(addons.sort()).toEqual(['aiwg-utils', 'plain']);
  });

  it('keeps deploying autoInstall:false addons from the real tree except explicit-install ones (#2641)', async () => {
    const root = path.resolve(import.meta.dirname, '../../../..');
    const addons = await getAllAddons(root);
    expect(addons).not.toContain('decision-engine');
    expect(addons).not.toContain('aiwg-dev');
    // Both declare autoInstall:false and must stay part of `aiwg use all`.
    expect(addons).toEqual(expect.arrayContaining(['composition-engine', 'testing-quality']));
  });

  it('returns an empty array when no addons exist', async () => {
    await mkdir(path.join(tmpDir, 'agentic', 'code', 'addons'), { recursive: true });
    const addons = await getAllAddons(tmpDir);
    expect(addons).toEqual([]);
  });

  it('only returns directories, not files', async () => {
    const addonsDir = path.join(tmpDir, 'agentic', 'code', 'addons');
    await createFakeAddonTree(tmpDir, ['aiwg-utils']);
    // Add a stray file in the addons dir
    await (await import('fs/promises')).writeFile(path.join(addonsDir, 'README.md'), '# hi');
    const addons = await getAllAddons(tmpDir);
    expect(addons).not.toContain('README.md');
    expect(addons).toContain('aiwg-utils');
  });

  it('correctly discovers all addons from the real agentic tree', async () => {
    // Use the actual repo root — validates against real source
    const repoRoot = path.resolve(__dirname, '../../../..');
    const addons = await getAllAddons(repoRoot);

    // Known addons that must be present
    expect(addons).toContain('aiwg-utils');
    expect(addons).toContain('agent-loop');
    expect(addons).toContain('rlm');
    expect(addons).toContain('daemon');
    expect(addons).toContain('voice-framework');

    // aiwg-dev must be excluded
    expect(addons).not.toContain('aiwg-dev');

    // Must find more than the old hardcoded 4
    expect(addons.length).toBeGreaterThan(4);
  });
});

describe('getAllExtensions()', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `aiwg-use-ext-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(tmpDir)) await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns deployable extension directories that have a manifest', async () => {
    await createFakeExtensionTree(tmpDir, ['sys', 'repo-maintainer']);
    const extensions = await getAllExtensions(tmpDir);
    expect(extensions).toContain('sys');
    expect(extensions).toContain('repo-maintainer');
  });

  it('skips extension directories without a manifest', async () => {
    const extensionsDir = await createFakeExtensionTree(tmpDir, ['repo-maintainer']);
    await mkdir(path.join(extensionsDir, 'scratch'), { recursive: true });

    const extensions = await getAllExtensions(tmpDir);
    expect(extensions).toContain('repo-maintainer');
    expect(extensions).not.toContain('scratch');
  });

  it('discovers repo-maintainer from the real agentic tree', async () => {
    const repoRoot = path.resolve(__dirname, '../../../..');
    const extensions = await getAllExtensions(repoRoot);
    expect(extensions).toContain('repo-maintainer');
  });
});

// ---------------------------------------------------------------------------
// isValidAddon()
// ---------------------------------------------------------------------------

describe('isValidAddon()', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `aiwg-valid-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(tmpDir)) await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns true for an existing addon directory', async () => {
    await createFakeAddonTree(tmpDir, ['agent-loop']);
    expect(await isValidAddon(tmpDir, 'agent-loop')).toBe(true);
  });

  it('resolves ralph alias to agent-loop', async () => {
    await createFakeAddonTree(tmpDir, ['agent-loop']);
    expect(await isValidAddon(tmpDir, 'ralph')).toBe(true);
  });

  it('returns false for a non-existent addon', async () => {
    await mkdir(path.join(tmpDir, 'agentic', 'code', 'addons'), { recursive: true });
    expect(await isValidAddon(tmpDir, 'does-not-exist')).toBe(false);
  });

  it('returns true for aiwg-dev — explicit installs are allowed', async () => {
    await createFakeAddonTree(tmpDir, ['aiwg-dev']);
    expect(await isValidAddon(tmpDir, 'aiwg-dev')).toBe(true);
  });

  it('returns true for real addons in the actual repo including aiwg-dev', async () => {
    const repoRoot = path.resolve(__dirname, '../../../..');
    expect(await isValidAddon(repoRoot, 'agent-loop')).toBe(true);
    expect(await isValidAddon(repoRoot, 'ralph')).toBe(true); // legacy alias
    expect(await isValidAddon(repoRoot, 'aiwg-utils')).toBe(true);
    expect(await isValidAddon(repoRoot, 'rlm')).toBe(true);
    expect(await isValidAddon(repoRoot, 'daemon')).toBe(true);
    // aiwg-dev is excluded from `use all` but can be installed explicitly
    expect(await isValidAddon(repoRoot, 'aiwg-dev')).toBe(true);
  });
});

describe('use cockpit', () => {
  let tmpDir: string;
  let oldHome: string | undefined;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `aiwg-use-cockpit-test-${Date.now()}`);
    oldHome = process.env.AIWG_COCKPIT_HOME;
    process.env.AIWG_COCKPIT_HOME = path.join(tmpDir, 'cockpit-home');
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'aiwg', version: '2026.6.1' })
    );
  });

  afterEach(async () => {
    if (oldHome === undefined) delete process.env.AIWG_COCKPIT_HOME;
    else process.env.AIWG_COCKPIT_HOME = oldHome;
    if (existsSync(tmpDir)) await rm(tmpDir, { recursive: true, force: true });
  });

  it('routes to the opt-in cockpit acquisition path', async () => {
    const result = await useHandler.execute({
      args: ['cockpit', '--dry-run'],
      rawArgs: ['use', 'cockpit', '--dry-run'],
      cwd: tmpDir,
      frameworkRoot: tmpDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('@aiwg/cockpit@2026.6.1');
    expect(result.message).toContain('Run without --dry-run');
  });
});

describe('OpenHuman native harness stubs (#1559)', () => {
  let tmpDir: string;
  let oldHome: string | undefined;
  let oldOpenHumanHome: string | undefined;

  async function writeAgent(root: string, slug: string, content: string) {
    const agentsDir = path.join(root, 'agentic', 'code', 'frameworks', 'sdlc-complete', 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(path.join(agentsDir, `${slug}.md`), content, 'utf-8');
  }

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `aiwg-openhuman-harness-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    oldHome = process.env.HOME;
    oldOpenHumanHome = process.env.OPENHUMAN_HOME;
    process.env.HOME = path.join(tmpDir, 'home');
    process.env.OPENHUMAN_HOME = path.join(tmpDir, 'openhuman-home');
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldOpenHumanHome === undefined) delete process.env.OPENHUMAN_HOME;
    else process.env.OPENHUMAN_HOME = oldOpenHumanHome;
    if (existsSync(tmpDir)) await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses --harness-agents selectors and keeps no-selector default empty', () => {
    expect(parseOpenHumanHarnessAgentSelector(['--provider', 'openhuman'])).toEqual([]);
    expect(parseOpenHumanHarnessAgentSelector(['--harness-agents=test-engineer, security-auditor'])).toEqual([
      'test-engineer',
      'security-auditor',
    ]);
    expect(parseOpenHumanHarnessAgentSelector(['--harness-agents', 'TestEngineer,test-engineer.md'])).toEqual([
      'test-engineer',
    ]);
  });

  it('keeps native harness emission opt-in unless explicitly selected', () => {
    const defaults = resolveOpenHumanHarnessAgentSelectors(['--provider', 'openhuman']);
    expect(defaults).toEqual([]);
    expect(resolveOpenHumanHarnessAgentSelectors(['--provider', 'openhuman', '--no-harness-agents'])).toEqual([]);
    expect(resolveOpenHumanHarnessAgentSelectors(['--harness-agents=security-auditor'])).toEqual(['security-auditor']);
  });

  it('emits project-scope TOML plus a frontmatter-stripped prompt file', async () => {
    await writeAgent(tmpDir, 'test-engineer', `---
name: Test Engineer
description: Creates comprehensive test suites
model: sonnet
---
# Test Engineer

Write tests.
`);

    const target = path.join(tmpDir, 'project');
    const result = await deployOpenHumanHarnessAgents({
      frameworkRoot: tmpDir,
      target,
      selectors: ['test-engineer'],
      scope: 'project',
    });

    expect(result.emitted).toBe(1);
    const toml = await readFile(path.join(target, 'agents', 'aiwg_test_engineer.toml'), 'utf-8');
    expect(toml).toContain('id = "aiwg_test_engineer"');
    expect(toml).toContain('when_to_use = "Creates comprehensive test suites"');
    expect(toml).toContain('display_name = "Test Engineer"');
    expect(toml).toContain('[system_prompt]');
    expect(toml).toContain('file = "aiwg/test_engineer.md"');
    expect(toml).not.toMatch(/^subagents\s*=/m);

    const prompt = await readFile(path.join(target, 'agent', 'prompts', 'aiwg', 'test_engineer.md'), 'utf-8');
    expect(prompt).toBe('# Test Engineer\n\nWrite tests.\n');
    expect(prompt).not.toMatch(/^---$/m);
  });

  it('emits user-scope rich TOML with an inline prompt and no project prompt file', async () => {
    await writeAgent(tmpDir, 'security-auditor', `---
description: Reviews code for security issues
---
Audit the code.
`);

    const target = path.join(tmpDir, 'project');
    const result = await deployOpenHumanHarnessAgents({
      frameworkRoot: tmpDir,
      target,
      selectors: ['security-auditor'],
      scope: 'user',
    });

    expect(result.emitted).toBe(1);
    const toml = await readFile(path.join(process.env.OPENHUMAN_HOME!, 'agents', 'aiwg_security_auditor.toml'), 'utf-8');
    expect(toml).toContain('id = "aiwg_security_auditor"');
    expect(toml).toContain('when_to_use = "Reviews code for security issues"');
    expect(toml).toContain('agent_tier = "worker"');
    expect(toml).toContain('iteration_policy = "extended"');
    expect(toml).toContain('sandbox_mode = "none"');
    expect(toml).toContain('tokenjuice_compression = "light"');
    expect(toml).toContain("inline = '''Audit the code.'''");
    expect(toml).toContain('[model]');
    expect(toml).toContain('hint = "coding"');
    expect(toml).not.toMatch(/^subagents\s*=/m);
    expect(existsSync(path.join(target, 'agent', 'prompts', 'aiwg', 'security_auditor.md'))).toBe(false);
  });

  it('is idempotent for repeated project-scope emission', async () => {
    await writeAgent(tmpDir, 'test-engineer', `---
description: Creates tests
---
Write tests.
`);
    const target = path.join(tmpDir, 'project');

    await deployOpenHumanHarnessAgents({ frameworkRoot: tmpDir, target, selectors: ['test-engineer'], scope: 'project' });
    const firstToml = await readFile(path.join(target, 'agents', 'aiwg_test_engineer.toml'), 'utf-8');
    const firstPrompt = await readFile(path.join(target, 'agent', 'prompts', 'aiwg', 'test_engineer.md'), 'utf-8');
    await deployOpenHumanHarnessAgents({ frameworkRoot: tmpDir, target, selectors: ['test-engineer'], scope: 'project' });

    expect(await readFile(path.join(target, 'agents', 'aiwg_test_engineer.toml'), 'utf-8')).toBe(firstToml);
    expect(await readFile(path.join(target, 'agent', 'prompts', 'aiwg', 'test_engineer.md'), 'utf-8')).toBe(firstPrompt);
  });

  it('fails when the selected AIWG agent is unknown', async () => {
    await expect(deployOpenHumanHarnessAgents({
      frameworkRoot: tmpDir,
      target: path.join(tmpDir, 'project'),
      selectors: ['missing-agent'],
      scope: 'project',
    })).rejects.toThrow("Unknown AIWG agent 'missing-agent'");
  });
});
