/**
 * Non-verbose `aiwg use` names the deploy failure reason (#3728).
 *
 * When a project-local bundle fails deployment (e.g. a rule whose summary
 * exceeds 240 characters), the deployer's stderr is captured rather than
 * inherited. The failure output must still name the file, the field and the
 * limit instead of a bare exit code.
 *
 * Note: dry-run mode silences all console output by design, so this exercises
 * a real (non-dry-run) invocation with a failing deploy script runner.
 *
 * @issue #3728
 * @source @src/cli/handlers/use.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PROJECT_LOCAL_SEARCH_PATHS_ENV } from '../../../../src/extensions/project-local-paths.js';
import { scaffoldProjectLocalBundle } from '../../../../src/extensions/project-local-scaffold.js';

const ARTIFACT_ENV_KEYS = [
  'AIWG_ARTIFACTS_PATH',
  'AIWG_PROJECT_ARTIFACTS_PATH',
  'AIWG_PROJECT_AIWG_DIR',
  PROJECT_LOCAL_SEARCH_PATHS_ENV,
] as const;

let originalEnv: Partial<Record<typeof ARTIFACT_ENV_KEYS[number], string | undefined>> = {};

const state = vi.hoisted(() => ({
  frameworkRoot: '',
  run: vi.fn().mockResolvedValue({ exitCode: 0 }),
}));

vi.mock('../../../../src/channel/manager.mjs', () => ({
  getFrameworkRoot: vi.fn(async () => state.frameworkRoot),
  getVersionInfo: vi.fn(async () => ({ version: 'test', channel: 'test' })),
}));

vi.mock('../../../../src/cli/handlers/script-runner.js', () => ({
  createScriptRunner: vi.fn(() => ({ run: state.run })),
}));

import { useHandler } from '../../../../src/cli/handlers/use.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'aiwg-use-deploy-reason-'));
}

/** Minimal project-local addon shipping exactly one rule. */
function writeAddonWithRule(projectDir: string, id: string): void {
  const dir = join(projectDir, '.aiwg', 'addons', id);
  mkdirSync(join(dir, 'rules'), { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      id,
      type: 'addon',
      name: id,
      version: '1.0.0',
      description: 'Project-local addon shipping one rule.',
      manifestVersion: '1',
      platforms: { claude: 'full' },
      keywords: ['test'],
      deployment: { pathTemplate: '.{platform}/rules/{id}.md' },
      addonConfig: { entry: { rules: 'rules/' } },
    }, null, 2),
  );
  writeFileSync(join(dir, 'rules', 'r1.md'), '---\nactivation: summary\nsummary: ok\n---\n\nBody.\n');
}

describe('aiwg use project-local deploy failure reason (#3728)', () => {
  let projectDir: string;
  let frameworkRoot: string;

  beforeEach(() => {
    originalEnv = {};
    for (const key of ARTIFACT_ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    projectDir = tmp();
    frameworkRoot = tmp();
    state.frameworkRoot = frameworkRoot;
    state.run.mockReset();
    state.run.mockResolvedValue({ exitCode: 0 });
  });

  afterEach(() => {
    for (const key of ARTIFACT_ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(frameworkRoot, { recursive: true, force: true });
  });

  it.each([
    ['{"id":"broken-addon","unexpected":true}', 'unexpected'],
    ['{', 'JSON parse'],
  ])('names manifest validation errors instead of Unknown target (#4085): %s', async (manifest, field) => {
    const dir = join(projectDir, '.aiwg', 'addons', 'broken-addon');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), manifest);
    const args = ['broken-addon', '--provider', 'claude', '--dry-run'];
    const result = await useHandler.execute({ cwd: projectDir, frameworkRoot, rawArgs: ['use', ...args], args });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("Project-local bundle 'broken-addon' failed manifest validation");
    expect(result.message).toContain('addons/broken-addon/manifest.json');
    expect(result.message).toContain(field);
    expect(result.message).not.toContain('Unknown target');
    expect(state.run).not.toHaveBeenCalled();
  });

  it('keeps Unknown target for an absent name despite another invalid bundle (#4085)', async () => {
    const dir = join(projectDir, '.aiwg', 'addons', 'broken-addon');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), '{');
    const args = ['absent', '--provider', 'claude', '--dry-run'];
    const result = await useHandler.execute({ cwd: projectDir, frameworkRoot, rawArgs: ['use', ...args], args });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("Unknown target 'absent'");
    expect(result.message).not.toContain('broken-addon');
  });

  it('matches a rejected manifest by its declared id when its directory has another name (#4085)', async () => {
    const dir = join(projectDir, '.aiwg', 'addons', 'custom-directory');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), '{"id":"broken-addon","unexpected":true}');
    const args = ['broken-addon', '--provider', 'claude', '--dry-run'];
    const result = await useHandler.execute({ cwd: projectDir, frameworkRoot, rawArgs: ['use', ...args], args });
    expect(result.message).toContain("Project-local bundle 'broken-addon' failed manifest validation");
    expect(result.message).toContain('custom-directory/manifest.json');
    expect(result.message).toContain('unexpected');
  });

  it.each(['relocated', 'additional'] as const)('names rejected manifests under %s artifact roots (#4085)', async location => {
    const root = join(projectDir, 'private-bundles');
    if (location === 'relocated') writeFileSync(join(projectDir, '.aiwg-location'), 'private-bundles\n');
    else process.env[PROJECT_LOCAL_SEARCH_PATHS_ENV] = root;
    const dir = join(root, 'addons', 'broken-addon');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), '{');
    const args = ['broken-addon', '--provider', 'claude', '--dry-run'];
    const result = await useHandler.execute({ cwd: projectDir, frameworkRoot, rawArgs: ['use', ...args], args });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("Project-local bundle 'broken-addon' failed manifest validation");
    expect(result.message).toContain(join(dir, 'manifest.json'));
    expect(result.message).toContain('JSON parse');
    expect(state.run).not.toHaveBeenCalled();
  });

  it('resolves an unedited addon agent starter for deployment (#4085)', async () => {
    const bundle = await scaffoldProjectLocalBundle({ type: 'addon', name: 'ux-studio', starter: 'agent', projectDir });
    const args = ['ux-studio', '--provider', 'claude', '--dry-run'];
    const result = await useHandler.execute({ cwd: projectDir, frameworkRoot, rawArgs: ['use', ...args], args });
    expect(result.exitCode, result.message).toBe(0);
    expect(state.run).toHaveBeenCalledWith('tools/agents/deploy-agents.mjs',
      expect.arrayContaining(['--source', bundle.bundlePath]), expect.any(Object));
  });

  it('prints the deployer reason with file, field and limit in non-verbose output', async () => {
    writeAddonWithRule(projectDir, 'repro-addon');
    const reason =
      `Deployment failed: ${join(projectDir, '.aiwg', 'addons', 'repro-addon', 'rules', 'r1.md')}: ` +
      'summary is 299 characters; the limit is 240 characters (single line).';
    state.run.mockResolvedValue({ exitCode: 1, message: reason });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});

    const args = ['repro-addon', '--provider', 'claude', '--target', projectDir];
    const result = await useHandler.execute({
      cwd: projectDir,
      frameworkRoot,
      rawArgs: ['use', ...args],
      args,
    });

    try {
      expect(result.exitCode).toBe(1);
      const text = output.mock.calls.flat().join('\n');
      expect(text).toContain("Failed to deploy project-local bundle 'repro-addon' (exit 1)");
      expect(text).toContain('r1.md');
      expect(text).toContain('summary');
      expect(text).toContain('240');
    } finally {
      output.mockRestore();
    }
  });
});
