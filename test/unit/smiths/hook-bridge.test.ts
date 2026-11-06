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
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';
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
  loadHookSources,
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

describe('loadHookSources', () => {
  it('loads the full Codex event set, deadline and install-root script path', async () => {
    const directory = path.join(tmpDir, 'agentic/code/addons/aiwg-hooks/canonical');
    await fs.mkdir(directory, { recursive: true });
    const events = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStart', 'SessionEnd',
      'PermissionRequest', 'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop', 'Stop'];
    await fs.writeFile(path.join(directory, 'fixture.json'), JSON.stringify({
      id: 'fixture', command: 'node', events, timeout: 2, args: ['$AIWG_ROOT/hook.cjs'],
    }));
    const loaded = await loadHookSources(tmpDir);
    expect(loaded.errors).toEqual([]);
    expect(loaded.sources).toHaveLength(1);
    expect(loaded.sources[0]).toMatchObject({ events, timeout: 2, args: [path.join(tmpDir, 'hook.cjs')] });
  });
});

describe('renderCodexHookToml', () => {
  it('renders the verified matcher group and typed command schema', () => {
    const toml = renderCodexHookToml({ ...SAMPLE_HOOK, timeout: 2 });
    const parsed = getStaticTOMLValue(parseTOML(toml)) as any;
    expect(parsed.hooks.PreToolUse).toEqual([{ hooks: [{
      type: 'command', command: '$CODEX_WORKSPACE/scripts/check-no-attribution.sh "--strict"',
      timeout: 2, _aiwg_managed: true, _aiwg_id: 'no-attribution',
    }] }]);
    expect(toml).toContain('safety-critical');
    expect(toml).not.toContain('args =');
  });

  it.each(['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStart', 'SessionEnd',
    'PermissionRequest', 'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop', 'Stop'] as const)
  ('renders the %s config key (runtime IDs use snake_case)', event => {
    const parsed = getStaticTOMLValue(parseTOML(renderCodexHookToml({ ...SAMPLE_HOOK, events: [event] }))) as any;
    expect(Object.keys(parsed.hooks)).toEqual([event]);
  });

  it('quotes arguments without evaluating shell command substitutions', () => {
    const toml = renderCodexHookToml({ ...SAMPLE_HOOK, args: ['two words', '$(danger)', '`danger`', 'a"b'] });
    const parsed = getStaticTOMLValue(parseTOML(toml)) as any;
    expect(parsed.hooks.PreToolUse[0].hooks[0].command)
      .toBe('$CODEX_WORKSPACE/scripts/check-no-attribution.sh "two words" "\\$(danger)" "\\`danger\\`" "a\\"b"');
  });
});

describe('injectCodexHookBlock', () => {
  const start = '# >>> AIWG-managed hooks (do not edit between markers)';
  const end = '# <<< AIWG-managed hooks';
  it('appends a fresh block while preserving operator content byte for byte', () => {
    const original = '# operator config\nkey = "value"\n\n';
    expect(injectCodexHookBlock(original, 'new content')).toBe(original + '\n' + start + '\nnew content\n' + end + '\n');
  });

  it('replaces only the lines inside its markers and remains idempotent', () => {
    const before = '# operator\n';
    const after = '\n\n# footer\n[desktop]\nvalue = true\n';
    const result = injectCodexHookBlock(before + start + '\nstale-spillover\n' + end + after, 'new content');
    expect(result).toBe(before + start + '\nnew content\n' + end + after);
    expect(injectCodexHookBlock(result, 'new content')).toBe(result);
  });

  it('does not treat marker text inside operator strings as a managed block', () => {
    const original = `description = "${start}"\nfooter = "${end}"\n`;
    const result = injectCodexHookBlock(original, 'new content');
    expect(result.startsWith(original)).toBe(true);
    expect(result).toContain(`\n${start}\nnew content\n${end}\n`);
  });

  it('repairs the titan layout by moving the end marker before user tables', () => {
    const before = 'model = "example"\n\n';
    const user = '# desktop preferences\n[desktop]\nnotifications = false\n\n[marketplaces.local]\nsource = "local"\n\n[plugins."example@local"]\nenabled = true\n';
    const old = '[[hooks.before_tool]]\ncommand = "old"\n_aiwg_managed = true\n_aiwg_id = "old"\n';
    const result = injectCodexHookBlock(before + start + '\n' + old + user + end + '\n# tail\n', 'new content');
    expect(result).toBe(before + start + '\nnew content\n' + end + '\n' + user + '\n# tail\n');
    expect(injectCodexHookBlock(result, 'new content')).toBe(result);
  });
});

describe('translateForCodex', () => {
  it('writes project hooks.json with typed commands and no global config writes', async () => {
    const r = await translateForCodex(SAMPLE_HOOK, { projectPath: tmpDir });
    expect(r.skipped).toBe(false);
    expect(r.emittedPaths).toEqual([path.join(tmpDir, '.codex/hooks.json')]);
    const parsed = JSON.parse(await fs.readFile(r.emittedPaths[0], 'utf8'));
    expect(parsed.hooks.PreToolUse[0].hooks[0]).toMatchObject({ type: 'command', _aiwg_id: SAMPLE_HOOK.id });
    expect(await fs.readdir(homeOverride)).toEqual([]);
  });

  it('honors degradeOn list', async () => {
    const r = await translateForCodex({ ...SAMPLE_HOOK, degradeOn: ['codex'] }, { projectPath: tmpDir });
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toContain('degrade-on');
  });

  it('dry-run does not write', async () => {
    const r = await translateForCodex(SAMPLE_HOOK, { projectPath: tmpDir, dryRun: true });
    expect(r.skipped).toBe(false);
    expect(r.emittedPaths[0]).toContain('(dry-run)');
    expect(await fs.readdir(tmpDir)).toEqual([]);
  });

  it('backs up pre-existing project config and preserves operator and other managed hooks', async () => {
    const directory = path.join(tmpDir, '.codex');
    await fs.mkdir(directory);
    const configPath = path.join(directory, 'hooks.json');
    const operator = { type: 'command', command: 'echo operator' };
    const original = JSON.stringify({ description: 'operator settings', hooks: { PreToolUse: [{ matcher: 'Shell', hooks: [operator] }] } });
    await fs.writeFile(configPath, original);
    const r = await translateForCodex(SAMPLE_HOOK, { projectPath: tmpDir });
    expect(r.warnings.some(w => w.includes('Backed up'))).toBe(true);
    const backups = (await fs.readdir(directory)).filter(entry => entry.startsWith('hooks.json.bak.'));
    expect(backups).toHaveLength(1);
    expect(await fs.readFile(path.join(directory, backups[0]), 'utf8')).toBe(original);
    const second = { ...SAMPLE_HOOK, id: 'second', events: ['Stop'] as const };
    await translateForCodex({ ...second, events: [...second.events] }, { projectPath: tmpDir });
    const once = await fs.readFile(configPath, 'utf8');
    await translateForCodex({ ...second, events: [...second.events] }, { projectPath: tmpDir });
    expect(await fs.readFile(configPath, 'utf8')).toBe(once);
    const parsed = JSON.parse(once);
    expect(parsed.description).toBe('operator settings');
    expect(parsed.hooks.PreToolUse).toHaveLength(2);
    expect(parsed.hooks.PreToolUse[0]).toEqual({ matcher: 'Shell', hooks: [operator] });
    expect(parsed.hooks.Stop[0].hooks[0]._aiwg_id).toBe('second');
  });

  it('keeps custom CODEX_HOME content untouched', async () => {
    const directory = path.join(homeOverride, '.codex');
    await fs.mkdir(directory);
    const configPath = path.join(directory, 'config.toml');
    const original = '# operator settings\n[desktop]\nkey = true\n';
    await fs.writeFile(configPath, original);
    await translateForCodex(SAMPLE_HOOK, { projectPath: tmpDir });
    expect(await fs.readFile(configPath, 'utf8')).toBe(original);
    expect(await fs.readdir(directory)).toEqual(['config.toml']);
  });

  it('refuses a project directory symlink instead of writing outside the project', async () => {
    await fs.symlink(homeOverride, path.join(tmpDir, '.codex'));
    await expect(translateForCodex(SAMPLE_HOOK, { projectPath: tmpDir })).rejects.toThrow('symlinked Codex');
    expect(await fs.readdir(homeOverride)).toEqual([]);
  });

  it('refuses malformed hooks without overwriting them', async () => {
    const directory = path.join(tmpDir, '.codex');
    await fs.mkdir(directory);
    const configPath = path.join(directory, 'hooks.json');
    const original = '{"hooks":{"PreToolUse":"invalid"}}';
    await fs.writeFile(configPath, original);
    await expect(translateForCodex(SAMPLE_HOOK, { projectPath: tmpDir })).rejects.toThrow('Invalid Codex matcher');
    expect(await fs.readFile(configPath, 'utf8')).toBe(original);
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
