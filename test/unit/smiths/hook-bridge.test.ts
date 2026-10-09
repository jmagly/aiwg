/**
 * Hook bridge tests (PUW-018 / #1119).
 *
 * Covers env-var substitution, exit-code mapping, and per-provider
 * translator emission. The actual loader integration is provider-side
 * and outside this test suite.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(() => actual.tmpdir()) };
});
import {
  substituteEnvVars,
  generateShimBash,
  EXIT_CODE_MAP,
  renderCodexHookToml,
  injectCodexHookBlock,
  translateForCodex,
  translateForCopilot,
  translateForFactory,
  translateForHermes,
  bridgeAll,
  AIWG_ENV_VARS,
  NATIVE_ENV_VAR_MAP,
  TRANSLATORS,
  type HookSource,
} from '../../../src/smiths/hook-bridge/index.js';

let tmpDir: string;
let homeOverride: string;

const SAMPLE_HOOK: HookSource = {
  id: 'no-attribution',
  description: 'Forbids AI tool attribution in commits and PRs',
  events: ['PreToolUse'],
  command: '$AIWG_PROJECT_DIR/scripts/check-no-attribution.sh',
  args: ['--strict'],
  safetyCritical: true,
};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiwg-hook-bridge-'));
  homeOverride = await fs.mkdtemp(path.join(os.tmpdir(), 'aiwg-hook-bridge-home-'));
  vi.stubEnv('HOME', homeOverride);
  vi.stubEnv('USERPROFILE', homeOverride);
  vi.stubEnv('CODEX_HOME', path.join(homeOverride, '.codex'));
  vi.mocked(os.homedir).mockReturnValue(homeOverride);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(homeOverride, { recursive: true, force: true });
});

describe('substituteEnvVars', () => {
  it('replaces $AIWG_PROJECT_DIR with $CODEX_WORKSPACE for codex', () => {
    const out = substituteEnvVars('$AIWG_PROJECT_DIR/scan.sh', 'codex');
    expect(out).toBe('$CODEX_WORKSPACE/scan.sh');
  });

  it('replaces $AIWG_PROJECT_DIR with $FACTORY_PROJECT_DIR for factory', () => {
    const out = substituteEnvVars('$AIWG_PROJECT_DIR/scan.sh', 'factory');
    expect(out).toBe('$FACTORY_PROJECT_DIR/scan.sh');
  });

  it('replaces $AIWG_PROJECT_DIR with $GITHUB_WORKSPACE for copilot', () => {
    const out = substituteEnvVars('$AIWG_PROJECT_DIR/scan.sh', 'copilot');
    expect(out).toBe('$GITHUB_WORKSPACE/scan.sh');
  });

  it('preserves canonical when provider has no native equivalent', () => {
    const out = substituteEnvVars('$AIWG_HOOK_EVENT pre_tool', 'codex');
    expect(out).toBe('$AIWG_HOOK_EVENT pre_tool');
  });

  it('handles ${VAR} syntax', () => {
    const out = substituteEnvVars('${AIWG_PROJECT_DIR}/scan.sh', 'codex');
    expect(out).toBe('$CODEX_WORKSPACE/scan.sh');
  });

  it('is a no-op for unknown providers', () => {
    const out = substituteEnvVars('$AIWG_PROJECT_DIR/scan.sh', 'unknown');
    expect(out).toBe('$AIWG_PROJECT_DIR/scan.sh');
  });
});

describe('EXIT_CODE_MAP', () => {
  it('exposes per-provider canonical 0/1 mapping for at least the four bridge providers', () => {
    expect(EXIT_CODE_MAP.codex.allow).toBe(0);
    expect(EXIT_CODE_MAP.codex.block).toBe(1);
    expect(EXIT_CODE_MAP.copilot.allow).toBe(0);
    expect(EXIT_CODE_MAP.factory.allow).toBe(0);
    expect(EXIT_CODE_MAP.hermes.allow).toBe(0);
  });
});

describe('generateShimBash', () => {
  it('emits a bash shim with the right shebang and AIWG env exports', () => {
    const shim = generateShimBash('factory', SAMPLE_HOOK.command, SAMPLE_HOOK.args);
    expect(shim).toMatch(/^#!\/usr\/bin\/env bash/);
    expect(shim).toContain('export AIWG_PROJECT_DIR');
    expect(shim).toContain('$FACTORY_PROJECT_DIR/scripts/check-no-attribution.sh');
    expect(shim).toContain('"--strict"');
  });
});

describe('renderCodexHookToml', () => {
  it('renders TOML hook entries with AIWG provenance', () => {
    const toml = renderCodexHookToml(SAMPLE_HOOK);
    expect(toml).toContain('[[hooks.before_tool]]');
    expect(toml).toContain('command = "$CODEX_WORKSPACE/scripts/check-no-attribution.sh"');
    expect(toml).toContain('args = ["--strict"]');
    expect(toml).toContain('_aiwg_managed = true');
    expect(toml).toContain('_aiwg_id = "no-attribution"');
    expect(toml).toContain('safety-critical');
  });

  it('skips events with no Codex mapping', () => {
    const toml = renderCodexHookToml({
      ...SAMPLE_HOOK,
      events: ['UserPromptSubmit'],
    });
    expect(toml).toContain('[[hooks.before_prompt]]');
  });
});

describe('injectCodexHookBlock', () => {
  it('appends a fresh block to operator content', () => {
    const r = injectCodexHookBlock('# operator config\nkey = "value"\n', '[[hooks.x]]\ncommand = "x"');
    expect(r).toContain('# operator config');
    expect(r).toContain('# >>> AIWG-managed hooks');
    expect(r).toContain('# <<< AIWG-managed hooks');
  });

  it('replaces an existing AIWG block', () => {
    // Note: the SPILLOVER_START marker includes a parenthetical
    // ("(do not edit between markers)"); use the same exact string here.
    const original = [
      '# operator',
      '# >>> AIWG-managed hooks (do not edit between markers)',
      'stale-spillover',
      '# <<< AIWG-managed hooks',
      'footer',
      '',
    ].join('\n');
    const r = injectCodexHookBlock(original, 'new content');
    expect(r).toContain('new content');
    expect(r).toContain('footer');
    expect(r).toContain('# operator');
    expect(r).not.toContain('stale-spillover');
  });
});

describe('translateForCodex', () => {
  it('writes config.toml with AIWG hook block', async () => {
    const r = await translateForCodex(SAMPLE_HOOK, { projectPath: tmpDir });
    expect(r.skipped).toBe(false);
    expect(r.emittedPaths.length).toBeGreaterThan(0);
    expect(r.emittedPaths[0]).toBe(path.join(homeOverride, '.codex/config.toml'));
    const content = await fs.readFile(r.emittedPaths[0], 'utf8');
    expect(content).toContain('[[hooks.before_tool]]');
  });

  it('honors degradeOn list', async () => {
    const r = await translateForCodex(
      { ...SAMPLE_HOOK, degradeOn: ['codex'] },
      { projectPath: tmpDir },
    );
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toContain('degrade-on');
  });

  it('dry-run does not write', async () => {
    const r = await translateForCodex(SAMPLE_HOOK, { projectPath: tmpDir, dryRun: true });
    expect(r.skipped).toBe(false);
    expect(r.emittedPaths[0]).toContain('(dry-run)');
  });

  it('backs up pre-existing config that has no AIWG signature', async () => {
    const codexDir = path.join(homeOverride, '.codex');
    const configPath = path.join(codexDir, 'config.toml');
    const original = '# fake operator content for test\n';
    await fs.mkdir(codexDir, { recursive: true });
    await fs.writeFile(configPath, original, 'utf8');
    const r = await translateForCodex(SAMPLE_HOOK, { projectPath: tmpDir });
    expect(r.warnings.some((w) => w.includes('Backed up'))).toBe(true);
    const backups = (await fs.readdir(codexDir)).filter(entry => entry.startsWith('config.toml.bak.'));
    expect(backups).toHaveLength(1);
    expect(await fs.readFile(path.join(codexDir, backups[0]), 'utf8')).toBe(original);
    expect(await fs.readFile(configPath, 'utf8')).toContain(original);
  });

  it('honors CODEX_HOME without writing the default home config', async () => {
    const codexDir = path.join(tmpDir, 'custom-codex-home');
    vi.stubEnv('CODEX_HOME', codexDir);
    const r = await translateForCodex(SAMPLE_HOOK, { projectPath: tmpDir });
    expect(r.emittedPaths).toEqual([path.join(codexDir, 'config.toml')]);
    expect(await fs.readdir(homeOverride)).toEqual([]);
  });
});

describe('translateForFactory', () => {
  it('writes a shell script under .factory/hooks/', async () => {
    const r = await translateForFactory(SAMPLE_HOOK, { projectPath: tmpDir });
    expect(r.skipped).toBe(false);
    const scriptPath = path.join(tmpDir, '.factory', 'hooks', 'no-attribution.sh');
    expect(r.emittedPaths).toContain(scriptPath);
    const content = await fs.readFile(scriptPath, 'utf8');
    expect(content).toContain('$FACTORY_PROJECT_DIR/scripts/check-no-attribution.sh');
  });
});

describe('translateForCopilot', () => {
  it('writes a JSON workflow file under .github/hooks/', async () => {
    const r = await translateForCopilot(SAMPLE_HOOK, { projectPath: tmpDir });
    expect(r.skipped).toBe(false);
    const filePath = path.join(tmpDir, '.github', 'hooks', 'no-attribution.json');
    expect(r.emittedPaths).toContain(filePath);
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(parsed._aiwg_managed).toBe(true);
    expect(parsed.events).toContain('pre_tool_use');
    expect(parsed.command).toContain('$GITHUB_WORKSPACE');
    expect(parsed.safety_critical).toBe(true);
  });
});

describe('translateForHermes', () => {
  it('writes a Python plugin under ~/.hermes/plugins/', async () => {
    const r = await translateForHermes(SAMPLE_HOOK, { projectPath: tmpDir });
    expect(r.skipped).toBe(false);
    expect(r.emittedPaths.length).toBeGreaterThan(0);
    const pluginPath = r.emittedPaths[0];
    expect(pluginPath).toBe(path.join(homeOverride, '.hermes/plugins/no-attribution.py'));
    const content = await fs.readFile(pluginPath, 'utf8');
    expect(content).toContain('from hermes.plugin import register_hook');
    expect(content).toContain('AIWG_ID = "no-attribution"');
    expect(content).toContain('SAFETY_CRITICAL = True');
  });
});

describe('bridgeAll', () => {
  it('translates one source across all 4 providers', async () => {
    const results = await bridgeAll(
      [SAMPLE_HOOK],
      ['codex', 'copilot', 'factory', 'hermes'],
      { projectPath: tmpDir },
    );
    expect(results).toHaveLength(4);
    expect(results.every((r) => !r.skipped)).toBe(true);
  });

  it('reports unknown provider gracefully', async () => {
    const results = await bridgeAll([SAMPLE_HOOK], ['nonexistent'], { projectPath: tmpDir });
    expect(results[0].skipped).toBe(true);
    expect(results[0].skipReason).toContain('no translator registered');
  });

  it('resolves provider aliases through ProviderDefinition hookBridge metadata', async () => {
    const results = await bridgeAll([SAMPLE_HOOK], ['openai'], { projectPath: tmpDir, dryRun: true });
    expect(results).toHaveLength(1);
    expect(results[0].skipped).toBe(false);
    expect(results[0].provider).toBe('codex');
  });

  it('skips providers whose ProviderDefinition declares no hook bridge adapter', async () => {
    const results = await bridgeAll([SAMPLE_HOOK], ['windsurf'], { projectPath: tmpDir });
    expect(results[0].skipped).toBe(true);
    expect(results[0].skipReason).toContain('no translator registered');
  });
});

describe('TRANSLATORS registry + AIWG_ENV_VARS exports', () => {
  it('exposes the bridge providers', () => {
    expect(Object.keys(TRANSLATORS).sort()).toEqual(['codex', 'copilot', 'factory', 'grok-build', 'hermes']);
  });

  it('exposes canonical env-var constants', () => {
    expect(AIWG_ENV_VARS.PROJECT_DIR).toBe('$AIWG_PROJECT_DIR');
    expect(NATIVE_ENV_VAR_MAP.codex.PROJECT_DIR).toBe('$CODEX_WORKSPACE');
  });
});
