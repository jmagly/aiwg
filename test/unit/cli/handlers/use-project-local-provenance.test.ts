/**
 * Managed-marker provenance for project-local bundle deploys.
 *
 * A project-local bundle is not part of the packaged framework corpus, so its
 * deployed artifacts must not be stamped `bundled`. When they were, refresh's
 * stale-artifact prune — whose desired set is the packaged corpus — deleted
 * every project-local agent in the same run that re-deployed it.
 *
 * @issue #2502
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
  return mkdtempSync(join(tmpdir(), 'aiwg-use-provenance-'));
}

/** Minimal project-local extension shipping exactly one agent. */
function writeExtensionWithAgent(projectDir: string, id: string, version: string): void {
  const dir = join(projectDir, '.aiwg', 'extensions', id);
  mkdirSync(join(dir, 'agents'), { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      id,
      type: 'extension',
      name: id,
      version,
      description: 'Project-local extension shipping one agent.',
      manifestVersion: '1',
      platforms: { claude: 'full' },
      keywords: ['test'],
      deployment: { pathTemplate: '.{platform}/skills/{id}.md' },
    }, null, 2),
  );
  writeFileSync(
    join(dir, 'agents', `${id}-agent.md`),
    `---\nname: ${id}-agent\ndescription: Agent shipped by a project-local bundle.\nmodel: claude-sonnet-4-6\ntools: Read\n---\n\n# Agent\n`,
  );
}

/** Deploy args for the invocation whose --source is the given bundle path. */
function argsForSource(sourcePath: string): string[] | undefined {
  const call = state.run.mock.calls.find(
    ([script, args]) =>
      script === 'tools/agents/deploy-agents.mjs'
      && Array.isArray(args)
      && args[args.indexOf('--source') + 1] === sourcePath,
  );
  return call?.[1] as string[] | undefined;
}

describe('aiwg use project-local managed-marker provenance (#2502)', () => {
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

  it('stamps project-local artifacts with a non-bundled source and the manifest version', async () => {
    writeExtensionWithAgent(projectDir, 'repro-ext', '1.2.3');

    const args = ['sdlc', '--provider', 'claude', '--target', projectDir, '--dry-run', '--no-utils'];
    const result = await useHandler.execute({
      cwd: projectDir,
      frameworkRoot,
      rawArgs: ['use', ...args],
      args,
    });

    expect(result.exitCode).toBe(0);
    const bundleArgs = argsForSource(join(projectDir, '.aiwg', 'extensions', 'repro-ext'));
    expect(bundleArgs).toBeDefined();
    expect(bundleArgs).toEqual(expect.arrayContaining(['--deploy-source', 'project-local']));
    expect(bundleArgs).toEqual(expect.arrayContaining(['--deploy-version', '1.2.3']));
    // The marker source is what refresh's prune gate keys on; `bundled` here is
    // what caused the artifact to be deleted as stale.
    expect(bundleArgs![bundleArgs!.indexOf('--deploy-source') + 1]).not.toBe('bundled');
  });

  it('falls back to unknown only when the manifest omits a version', async () => {
    const dir = join(projectDir, '.aiwg', 'extensions', 'no-version-ext');
    mkdirSync(join(dir, 'agents'), { recursive: true });
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'no-version-ext',
        type: 'extension',
        name: 'no-version-ext',
        description: 'Project-local extension without a version.',
        manifestVersion: '1',
        platforms: { claude: 'full' },
        keywords: ['test'],
        deployment: { pathTemplate: '.{platform}/skills/{id}.md' },
      }, null, 2),
    );
    writeFileSync(
      join(dir, 'agents', 'no-version-agent.md'),
      '---\nname: no-version-agent\ndescription: Agent.\nmodel: claude-sonnet-4-6\ntools: Read\n---\n\n# Agent\n',
    );

    const args = ['sdlc', '--provider', 'claude', '--target', projectDir, '--dry-run', '--no-utils'];
    await useHandler.execute({ cwd: projectDir, frameworkRoot, rawArgs: ['use', ...args], args });

    const bundleArgs = argsForSource(dir);
    if (bundleArgs) {
      expect(bundleArgs[bundleArgs.indexOf('--deploy-source') + 1]).toBe('project-local');
      expect(bundleArgs[bundleArgs.indexOf('--deploy-version') + 1]).toBe('unknown');
    }
  });
});
