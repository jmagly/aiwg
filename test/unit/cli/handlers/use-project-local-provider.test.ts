/**
 * Unit tests for project-local provider bundle resolution in aiwg use.
 *
 * @source @src/cli/handlers/use.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PROJECT_LOCAL_SEARCH_PATHS_ENV } from '../../../../src/extensions/project-local-paths.js';

const ARTIFACT_ENV_KEYS = [
  'AIWG_ARTIFACTS_PATH',
  'AIWG_PROJECT_ARTIFACTS_PATH',
  'AIWG_PROJECT_AIWG_DIR',
  PROJECT_LOCAL_SEARCH_PATHS_ENV,
  'AIWG_GROKBOT_SKILLS_DIR',
] as const;

let originalEnv: Partial<Record<typeof ARTIFACT_ENV_KEYS[number], string | undefined>> = {};

const state = vi.hoisted(() => ({
  frameworkRoot: '',
  run: vi.fn().mockResolvedValue({ exitCode: 0 }),
  prepare: vi.fn(),
  finalize: vi.fn().mockResolvedValue(undefined),
  commit: vi.fn().mockResolvedValue({}),
  dispose: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../src/channel/manager.mjs', () => ({
  getFrameworkRoot: vi.fn(async () => state.frameworkRoot),
  getVersionInfo: vi.fn(async () => ({ version: 'test', channel: 'test' })),
}));

vi.mock('../../../../src/cli/handlers/script-runner.js', () => ({
  createScriptRunner: vi.fn(() => ({
    run: state.run,
  })),
}));

vi.mock('../../../../src/cli/services/provider-prepare-coordinator.js', () => ({
  prepareProviderDeployments: state.prepare,
  finalizePreparedProvider: state.finalize,
}));

import { useHandler } from '../../../../src/cli/handlers/use.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'aiwg-use-provider-'));
}

function writeProviderBundle(projectDir: string, id: string, extendsProvider: string): void {
  const dir = join(projectDir, '.aiwg', 'providers', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      id,
      type: 'provider',
      name: id,
      version: '1.0.0',
      description: 'Custom provider for tests',
      manifestVersion: '1',
      platforms: { claude: 'full' },
      keywords: ['test'],
      deployment: { pathTemplate: '.{platform}/skills/{id}.md' },
      providerConfig: { extends: extendsProvider, displayName: id },
    }, null, 2),
  );
}

describe('aiwg use project-local provider bundles (#1717)', () => {
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
    state.commit.mockReset();
    state.commit.mockResolvedValue({});
    state.dispose.mockReset();
    state.dispose.mockResolvedValue(undefined);
    state.prepare.mockReset();
    state.prepare.mockResolvedValue({ run: (work: () => Promise<unknown>) => work(), commit: state.commit, dispose: state.dispose });
    state.finalize.mockReset();
    state.finalize.mockResolvedValue(undefined);
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

  it('resolves a custom provider id to its providerConfig.extends deploy adapter', async () => {
    writeProviderBundle(projectDir, 'my-provider', 'claude');

    const result = await useHandler.execute({
      cwd: projectDir,
      frameworkRoot,
      rawArgs: ['use', 'sdlc', '--provider', 'my-provider', '--target', projectDir, '--dry-run', '--no-utils', '--no-project-local'],
      args: ['sdlc', '--provider', 'my-provider', '--target', projectDir, '--dry-run', '--no-utils', '--no-project-local'],
    });

    expect(result.exitCode).toBe(0);
    expect(state.run).toHaveBeenCalledWith(
      'tools/agents/deploy-agents.mjs',
      expect.arrayContaining(['--provider', 'claude']),
      expect.objectContaining({ capture: true, stdoutFd: expect.any(Number) }),
    );
    expect(state.run.mock.calls[0][1]).not.toContain('my-provider');
  });

  it.each(['devin', 'devin-desktop', 'windsurf'])('resolves %s to the same Windsurf deploy adapter', async (selector) => {
    const args = ['sdlc', '--provider', selector, '--target', projectDir, '--dry-run', '--no-utils', '--no-project-local'];
    const result = await useHandler.execute({ cwd: projectDir, frameworkRoot, rawArgs: ['use', ...args], args });

    expect(result.exitCode).toBe(0);
    expect(state.run).toHaveBeenCalledWith('tools/agents/deploy-agents.mjs', expect.arrayContaining(['--provider', 'windsurf']), expect.objectContaining({ capture: true, stdoutFd: expect.any(Number) }));
    if (selector !== 'windsurf') expect(state.run.mock.calls[0][1]).not.toContain(selector);
  });

  it.each([
    { framework: 'all', flags: ['--scope', 'user'] },
    { framework: 'all', flags: ['--user'] },
    { framework: 'agent-loop', flags: ['--scope', 'user'] },
    { framework: 'agent-loop', flags: ['--user'] },
  ])('forwards user scope to every Grokbot deploy for $framework $flags', async ({ framework, flags }) => {
    process.env.AIWG_GROKBOT_SKILLS_DIR = join(projectDir, 'user-skills');
    for (const [kind, id] of [['addons', 'agent-loop'], ['extensions', 'test-extension']]) {
      const dir = join(frameworkRoot, 'agentic', 'code', kind, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id, type: 'addon', name: id, version: '1.0.0' }));
    }
    const args = [framework, '--provider', 'grokbot', '--target', projectDir, '--dry-run', '--no-project-local', ...flags];
    const result = await useHandler.execute({ cwd: projectDir, frameworkRoot, rawArgs: ['use', ...args], args });
    expect(result.exitCode).toBe(0);
    const calls = state.run.mock.calls.filter(([script]) => script === 'tools/agents/deploy-agents.mjs');
    expect(calls.length).toBeGreaterThanOrEqual(framework === 'all' ? 2 : 1);
    if (framework === 'all') {
      expect(calls.some(([, args]) => args.includes(join(frameworkRoot, 'agentic/code/extensions/test-extension')))).toBe(false);
    }
    for (const [, deployArgs] of calls) {
      expect(deployArgs[deployArgs.indexOf('--scope') + 1]).toBe('user');
    }
  });

  it('rejects Devin CLI without conflating it with Devin Desktop', async () => {
    const result = await useHandler.execute({
      cwd: projectDir,
      frameworkRoot,
      rawArgs: ['use', 'sdlc', '--provider', 'devin-cli', '--target', projectDir, '--dry-run', '--no-utils', '--no-project-local'],
      args: ['sdlc', '--provider', 'devin-cli', '--target', projectDir, '--dry-run', '--no-utils', '--no-project-local'],
    });

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('Unsupported provider: devin-cli');
    expect(result.message).toContain('Use --provider devin for Devin Desktop');
    expect(state.run).not.toHaveBeenCalled();
  });

  it('does not treat a provider bundle name as a deployable target', async () => {
    writeProviderBundle(projectDir, 'my-provider', 'claude');

    const result = await useHandler.execute({
      cwd: projectDir,
      frameworkRoot,
      rawArgs: ['use', 'my-provider', '--target', projectDir, '--dry-run'],
      args: ['my-provider', '--target', projectDir, '--dry-run'],
    });

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('selected with --provider');
    expect(result.message).toContain('aiwg use sdlc --provider my-provider');
    expect(state.run).not.toHaveBeenCalled();
  });

  it('prepares two built-in providers concurrently and finalizes them in commit order', async () => {
    mkdirSync(join(projectDir, '.aiwg'), { recursive: true });
    writeFileSync(join(projectDir, '.aiwg', 'aiwg.config'), JSON.stringify({
      version: '1', providers: ['cursor', 'claude'], installed: {}, scripts: {},
    }));
    const args = ['sdlc', '--target', projectDir, '--no-utils', '--no-project-local', '--skip-conflicts', '--no-context-files'];
    const result = await useHandler.execute({ cwd: projectDir, frameworkRoot, rawArgs: ['use', ...args], args });

    expect(result.message).not.toContain('Concurrent provider preparation failed');
    expect(state.prepare).toHaveBeenCalledTimes(1);
    const jobs = state.prepare.mock.calls[0][1];
    expect(jobs.map((job: { provider: string }) => job.provider)).toEqual(['cursor', 'claude']);
    expect(state.commit.mock.calls.map(([order]) => order)).toEqual([0, 1]);
    expect(state.dispose).toHaveBeenCalledTimes(1);
    expect(state.finalize).toHaveBeenCalledTimes(2);
    expect(state.finalize.mock.calls.map(([, deployArgs]) => deployArgs[deployArgs.indexOf('--provider') + 1])).toEqual(['cursor', 'claude']);
  });

  it('retains serial fallback for user-scope and dry-run multi-provider deployment', async () => {
    mkdirSync(join(projectDir, '.aiwg'), { recursive: true });
    writeFileSync(join(projectDir, '.aiwg', 'aiwg.config'), JSON.stringify({
      version: '1', providers: ['cursor', 'claude'], installed: {}, scripts: {},
    }));
    const args = ['sdlc', '--target', projectDir, '--scope', 'user', '--dry-run', '--no-utils', '--no-project-local', '--skip-conflicts', '--no-context-files'];
    const result = await useHandler.execute({ cwd: projectDir, frameworkRoot, rawArgs: ['use', ...args], args });

    expect(result.exitCode).toBe(0);
    expect(state.prepare).not.toHaveBeenCalled();
    const calls = state.run.mock.calls.filter(([script]) => script === 'tools/agents/deploy-agents.mjs');
    expect(calls.map(([, deployArgs]) => deployArgs[deployArgs.indexOf('--provider') + 1])).toEqual(['cursor', 'claude']);
  });

  it('retains serial fallback when a multi-provider selection includes a project-local adapter', async () => {
    writeProviderBundle(projectDir, 'my-provider', 'claude');
    writeFileSync(join(projectDir, '.aiwg', 'aiwg.config'), JSON.stringify({
      version: '1', providers: ['my-provider', 'cursor'], installed: {}, scripts: {},
    }));
    const args = ['sdlc', '--target', projectDir, '--dry-run', '--no-utils', '--no-project-local', '--skip-conflicts', '--no-context-files'];
    const result = await useHandler.execute({ cwd: projectDir, frameworkRoot, rawArgs: ['use', ...args], args });

    expect(result.exitCode).toBe(0);
    expect(state.prepare).not.toHaveBeenCalled();
    const calls = state.run.mock.calls.filter(([script]) => script === 'tools/agents/deploy-agents.mjs');
    expect(calls.map(([, deployArgs]) => deployArgs[deployArgs.indexOf('--provider') + 1])).toEqual(['claude', 'cursor']);
  });

  it('retains serial fallback for a built-in without a transferable transaction', async () => {
    mkdirSync(join(projectDir, '.aiwg'), { recursive: true });
    writeFileSync(join(projectDir, '.aiwg', 'aiwg.config'), JSON.stringify({
      version: '1', providers: ['factory', 'cursor'], installed: {}, scripts: {},
    }));
    const args = ['sdlc', '--target', projectDir, '--dry-run', '--no-utils', '--no-project-local', '--skip-conflicts', '--no-context-files'];
    const result = await useHandler.execute({ cwd: projectDir, frameworkRoot, rawArgs: ['use', ...args], args });

    expect(result.exitCode).toBe(0);
    expect(state.prepare).not.toHaveBeenCalled();
    const calls = state.run.mock.calls.filter(([script]) => script === 'tools/agents/deploy-agents.mjs');
    expect(calls.map(([, deployArgs]) => deployArgs[deployArgs.indexOf('--provider') + 1])).toEqual(['factory', 'cursor']);
  });

  it('rejects a caller-supplied prepared-provider bypass capability', async () => {
    const args = ['sdlc', '--provider', 'cursor', '--target', projectDir, '--aiwg-provider-main-prepared', 'forged'];
    const result = await useHandler.execute({ cwd: projectDir, frameworkRoot, rawArgs: ['use', ...args], args });
    expect(result).toMatchObject({ exitCode: 2, message: expect.stringMatching(/Unknown option.*--aiwg-provider-main-prepared.*aiwg use --help/) });
    expect(state.run).not.toHaveBeenCalled();
  });
});
