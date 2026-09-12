/**
 * The trace hook and viewer must write and read traces under the configured
 * artifact root, not the repository-local control plane.
 *
 * Traces are payload. Hardcoding `.aiwg/traces` wrote into the control plane on
 * every SubagentStop, so a reconciled split-root workspace regressed to
 * divergent-payload the next time any agent ran.
 *
 * @issue #2517
 * @source @agentic/code/addons/aiwg-hooks/hooks/aiwg-trace.cjs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const SOURCES = [
  'agentic/code/addons/aiwg-hooks/hooks/aiwg-trace.cjs',
  'agentic/code/plugins/hooks/hooks/aiwg-trace.cjs',
  'agentic/code/addons/aiwg-hooks/scripts/trace-viewer.mjs',
  'agentic/code/plugins/hooks/scripts/trace-viewer.mjs',
] as const;

const REPO_ROOT = resolve(__dirname, '../../..');

/** Extract and evaluate the inlined resolver from a source file. */
function loadResolver(relativePath: string): (projectDir: string) => string {
  const source = readFileSync(join(REPO_ROOT, relativePath), 'utf8');
  const match = source.match(/function resolveArtifactRoot\(projectDir\)[\s\S]*?\n}\n/);
  if (!match) throw new Error(`no inlined resolveArtifactRoot in ${relativePath}`);
  const expand = source.match(/function expandArtifactPath\([\s\S]*?\n}\n/);
  const body = `${match[0]}\n${expand ? expand[0] : ''}\nreturn resolveArtifactRoot(projectDir);`;
  // eslint-disable-next-line no-new-func
  const factory = new Function('fs', 'path', 'require', 'process', 'homedir', 'projectDir', body);
  return (projectDir: string) => factory(
    require('node:fs'), require('node:path'), require, process, homedir, projectDir,
  ) as string;
}

let projectDir: string;
let external: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR'];

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'aiwg-trace-root-'));
  external = join(projectDir, 'external', '.aiwg');
  mkdirSync(external, { recursive: true });
  for (const key of ENV_KEYS) { savedEnv[key] = process.env[key]; delete process.env[key]; }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key]!;
  }
  rmSync(projectDir, { recursive: true, force: true });
});

describe.each(SOURCES)('artifact-root resolution in %s (#2517)', (relativePath) => {
  it('follows the .aiwg-location pointer instead of the local control plane', () => {
    writeFileSync(join(projectDir, '.aiwg-location'), 'external/.aiwg\n');
    const resolved = loadResolver(relativePath)(projectDir);
    expect(resolve(resolved)).toBe(resolve(external));
    expect(resolve(resolved)).not.toBe(resolve(projectDir, '.aiwg'));
  });

  it('honors the artifact-path environment aliases ahead of the pointer', () => {
    writeFileSync(join(projectDir, '.aiwg-location'), 'external/.aiwg\n');
    const override = join(projectDir, 'override', '.aiwg');
    mkdirSync(override, { recursive: true });
    process.env.AIWG_ARTIFACTS_PATH = override;
    expect(resolve(loadResolver(relativePath)(projectDir))).toBe(resolve(override));
  });

  it('parses an export-style pointer with quotes', () => {
    writeFileSync(
      join(projectDir, '.aiwg-location'),
      '# comment\nexport AIWG_ARTIFACTS_PATH="external/.aiwg"\n',
    );
    expect(resolve(loadResolver(relativePath)(projectDir))).toBe(resolve(external));
  });

  it('falls back to the repository-local .aiwg when nothing is configured', () => {
    expect(resolve(loadResolver(relativePath)(projectDir))).toBe(resolve(projectDir, '.aiwg'));
  });
});

describe('plugin mirrors stay byte-identical to the addon sources (#2517)', () => {
  it.each([
    ['hooks/aiwg-trace.cjs', 'agentic/code/addons/aiwg-hooks/hooks/aiwg-trace.cjs', 'agentic/code/plugins/hooks/hooks/aiwg-trace.cjs'],
    ['scripts/trace-viewer.mjs', 'agentic/code/addons/aiwg-hooks/scripts/trace-viewer.mjs', 'agentic/code/plugins/hooks/scripts/trace-viewer.mjs'],
  ])('%s', (_label, addon, plugin) => {
    expect(readFileSync(join(REPO_ROOT, plugin), 'utf8'))
      .toBe(readFileSync(join(REPO_ROOT, addon), 'utf8'));
  });
});
