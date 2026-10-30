// Exercise first-use selection across the real rule projector's additive passes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { emptyConfig, readAiwgConfig, writeAiwgConfig } from '../../../../src/config/aiwg-config.js';

const state = vi.hoisted(() => ({ source: '', failSource: '', calls: [] as string[][] }));
vi.mock('../../../../src/channel/manager.mjs', () => ({
  getVersionInfo: async () => ({ version: '1.0.0', devMode: true }),
}));
// Model wrappers are independent of the rule-selection transaction under test.
vi.mock('../../../../src/models/wrapper-deployment.js', () => ({
  verifyModelWrapperDeployment: async () => ({ supported: false, valid: true }),
}));
vi.mock('../../../../src/models/model-discovery.js', () => ({
  resolveDynamicModelCatalog: async () => ({ providers: {} }),
}));
vi.mock('../../../../src/cli/handlers/script-runner.js', () => ({
  createScriptRunner: () => ({
    run: async (script: string, args: string[]) => {
      expect(script).toBe('tools/agents/deploy-agents.mjs');
      state.calls.push([...args]);
      if (state.failSource && args.includes(path.join(state.source, state.failSource))) {
        return { exitCode: 1, message: 'Synthetic additive deployment failure' };
      }
      const sourceArgs = args.includes('--source') ? [] : ['--source', state.source];
      try {
        // @ts-expect-error Deployment tooling has no TypeScript declaration.
        const { main } = await import('../../../../tools/agents/deploy-agents.mjs');
        return { exitCode: await main([...args, ...sourceArgs]) };
      } catch (error) {
        return { exitCode: 1, message: String(error) };
      }
    },
  }),
}));

let scratch: string, project: string;
beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'aiwg-first-rule-selection-'));
  project = path.join(scratch, 'project');
  state.source = path.join(scratch, 'source');
  state.failSource = '';
  state.calls = [];
  mkdirSync(project);
  cpSync(path.resolve(import.meta.dirname, '../../../fixtures/cli/use-rule-selection'), state.source, { recursive: true });
  const home = path.join(scratch, 'home');
  mkdirSync(home);
  for (const key of ['HOME', 'USERPROFILE']) vi.stubEnv(key, home);
  for (const key of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'AIWG_CONFIG']) {
    vi.stubEnv(key, path.join(home, key));
  }
  for (const key of ['AIWG_ROOT', 'AIWG_HOME', 'AIWG_USER_REGISTRY_PATH', 'AIWG_ARTIFACTS_PATH']) vi.stubEnv(key, undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

async function deploy(bundle: string, options: string[] = []) {
  const { UseHandler } = await import('../../../../src/cli/handlers/use.js');
  const args = [bundle, '--provider', 'claude', '--target', project, '--json',
    '--no-context-files', '--no-attribution', '--no-project-local', '--skip-conflicts', ...options];
  return new UseHandler().execute({ args, rawArgs: ['use', ...args], cwd: project, frameworkRoot: state.source });
}

function snapshot() {
  const rules = path.join(project, '.claude/rules');
  const receipt = JSON.parse(readFileSync(path.join(rules, '.aiwg-manifest.json'), 'utf8'));
  return {
    sources: receipt.ruleSources.map((file: string) => path.relative(state.source, file)).sort(),
    files: Object.fromEntries(readdirSync(rules).filter(file => file.endsWith('.md')).sort()
      .map(file => [file, readFileSync(path.join(rules, file), 'utf8')])),
  };
}

describe('first framework rule selection (#3786)', () => {
  it.each([
    ['sdlc', []], ['sdlc-complete', []], ['all', []], ['all', ['--copy-all']],
  ] as const)('keeps %s %j rules and RULES-INDEX identical on first use and redeploy', async (bundle, options) => {
    const first = await deploy(bundle, [...options]);
    expect(first.exitCode, first.message).toBe(0);
    const before = snapshot();
    expect(before.sources.length).toBeGreaterThan(0);
    if (bundle !== 'all' || options.length) {
      expect(before.sources).toContain('agentic/code/frameworks/sdlc-complete/rules/token-security.md');
      expect(before.files['token-security.md']).toContain('Synthetic token security contract.');
      expect(before.files['RULES-INDEX.md']).toContain('sdlc-summary');
    }
    if (options.length) expect(before.files['RULES-INDEX.md']).toContain('marketing-summary');
    const second = await deploy(bundle, [...options]);
    expect(second.exitCode, second.message).toBe(0);
    expect(snapshot()).toEqual(before);
  }, 90_000);

  it('preserves an existing framework while adding and redeploying another', async () => {
    const config = emptyConfig(['claude']);
    config.installed.marketing = { version: '1.0.0', source: 'bundled', installedAt: '2026-01-01T00:00:00Z', deployedTo: {} };
    await writeAiwgConfig(project, config);
    const first = await deploy('sdlc');
    expect(first.exitCode, first.message).toBe(0);
    const before = snapshot();
    expect(before.files['RULES-INDEX.md']).toContain('marketing-summary');
    expect(before.files['token-security.md']).toContain('Synthetic token security contract.');
    const second = await deploy('sdlc');
    expect(second.exitCode, second.message).toBe(0);
    expect(snapshot()).toEqual(before);
    expect((await readAiwgConfig(project))!.installed.marketing).toEqual(config.installed.marketing);
  }, 90_000);

  it.each([false, true])('records no installation after a failed additive pass (existing config: %s)', async existing => {
    if (existing) await writeAiwgConfig(project, emptyConfig(['claude']));
    state.failSource = 'agentic/code/extensions/extra-extension';
    const result = await deploy('sdlc');
    expect(result.exitCode, result.message).not.toBe(0);
    expect(result.message).toContain('Synthetic additive deployment failure');
    expect(state.calls.some(args => args.includes(path.join(state.source, state.failSource)))).toBe(true);
    expect((await readAiwgConfig(project))!.installed).toEqual({});
    expect(existsSync(path.join(project, '.claude/rules'))).toBe(true);
  }, 90_000);
});
