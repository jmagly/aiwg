/**
 * Guards the npm-package install-ability defect found in review of #3062:
 * every shipped executable file under `tools/`, `bin/`, or `dist/src/`
 * that imports something outside the packed set must resolve it through
 * `tools/_resolve-impl.mjs`'s `importImpl` (which falls back to
 * `dist/src/` when installed), not a literal relative path into `src/` —
 * the installed package does not ship `src/` at all (see `files` in
 * package.json).
 *
 * Uses the real `npm pack --dry-run --json` manifest (shared, cached once
 * per run via the `basePackageManifest` global-setup fixture — see
 * test/helpers/base-package-setup.mjs) so this checks the actual packed
 * file list, not an assumption about what `files` includes.
 *
 * @integration
 * @implements #3062 finding 1
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { checkPackedRelativeImports } from '../helpers/packed-relative-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');

describe('shipped tools/**, bin/**, and dist/src/** relative imports resolve (#3062 finding 1)', () => {
  it('ships daemon Docker dependencies and excludes checkout-only scripts (#3077)', () => {
    const files = inject('basePackageManifest').files.map((file) => file.path);
    expect(files).toContain('tools/docker/container-manager.mjs');
    expect(files).toContain('tools/docker/Dockerfile.daemon');
    const checkoutOnly = /^(?:tools\/decision\/(?:comparative-replay.*\.ts|d17-.*\.mjs|d29-study\.mjs|heldout-study\.mjs|studies\/.*)|tools\/experiments\/.*|tools\/cockpit\/qualify-desktop-issuer\.mjs|tools\/providers\/omp-(?:mcp-)?conformance\.mjs|tools\/testing\/(?:audit-conformance-inventory|run-conformance-example|verify-coverage-enforcement)\.mjs)$/;
    expect(files.filter(file => checkoutOnly.test(file))).toEqual([]);
  });

  it('every relative import resolves to a packed file without exceptions', () => {
    const packed = inject('basePackageManifest');
    const packedFiles = packed.files.map((file) => file.path);

    const violations = checkPackedRelativeImports({ root: ROOT, packedFiles });

    expect(
      violations,
      `Unresolvable relative import(s) in a shipped tools/**, bin/**, or dist/src/** file — these ` +
        `will throw ERR_MODULE_NOT_FOUND once installed from npm (src/ is not shipped; use ` +
        `importImpl(import.meta.url, '<path>') from tools/_resolve-impl.mjs instead of a literal ` +
        `relative path into src/):\n${JSON.stringify(violations, null, 2)}`,
    ).toEqual([]);
  });

  it('no shipped file has an unresolved import into src/process/bounded-child-process.mjs (#3062)', () => {
    const packed = inject('basePackageManifest');
    const packedFiles = packed.files.map((file) => file.path);

    const violations = checkPackedRelativeImports({ root: ROOT, packedFiles });
    const boundedProcessViolations = violations.filter(
      (violation) => violation.resolvedRel === 'src/process/bounded-child-process.mjs',
    );

    expect(boundedProcessViolations).toEqual([]);
  });
});

describe('installed user entry points load their shipped implementations (#3077)', () => {
  let scratch: string;
  let installed: string;
  let consumer: string;
  let env: NodeJS.ProcessEnv;

  function run(entry: string, args: string[], expectedStatus = 0) {
    const result = spawnSync(process.execPath, [path.join(installed, entry), ...args], {
      cwd: consumer, env, encoding: 'utf8', timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr + result.stdout).toBe(expectedStatus);
    expect(result.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|Could not resolve/);
    return result;
  }

  beforeAll(() => {
    scratch = mkdtempSync(path.join(tmpdir(), 'aiwg-import-smoke-'));
    installed = path.join(scratch, 'installed');
    consumer = path.join(scratch, 'consumer');
    mkdirSync(installed);
    mkdirSync(consumer);
    // Only package files, with third-party dependencies shared read-only.
    // Ignore lifecycle scripts: this test checks the current build, offline.
    const pack = spawnSync('npm', ['pack', '--offline', '--ignore-scripts', '--json',
      '--cache', path.join(scratch, 'cache'), '--pack-destination', scratch], {
      cwd: ROOT, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
    });
    expect(pack.status, pack.stderr).toBe(0);
    const tarball = path.join(scratch, JSON.parse(pack.stdout)[0].filename);
    const unpack = spawnSync('tar', ['-xzf', tarball, '-C', installed, '--strip-components=1'], {
      encoding: 'utf8', timeout: 30_000,
    });
    expect(unpack.status, unpack.stderr).toBe(0);
    symlinkSync(path.join(ROOT, 'node_modules'), path.join(installed, 'node_modules'), 'dir');
    expect(existsSync(path.join(installed, 'src'))).toBe(false);
    env = {
      PATH: process.env.PATH, HOME: scratch, AIWG_CONFIG: path.join(scratch, 'config'),
      XDG_CONFIG_HOME: path.join(scratch, 'config'), NO_UPDATE_NOTIFIER: '1',
      AIWG_RESOLVE_IMPL_FROM: 'dist', AIWG_USER_REGISTRY_PATH: path.join(scratch, 'registry.json'),
    };
  }, 180_000);

  afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

  it('loads CLI/daemon help and the compiled OMP removal branch', () => {
    expect(run('bin/aiwg.mjs', ['--help']).stdout).toContain('Usage:');
    expect(run('tools/daemon/index.mjs', ['--help']).stdout).toContain('daemon');
    expect(run('bin/aiwg.mjs', ['mcp', '--help', '--provider', 'omp']).stdout).toContain('omp');
    expect(run('bin/aiwg.mjs', ['remove', 'omp', '--provider', 'omp', '--dry-run']).stdout)
      .toContain('Would remove 0 unchanged OMP-owned files');
  });

  it('loads the Docker manager before reporting an unavailable Docker binary', () => {
    // An empty PATH guarantees this probe cannot start a real container.
    const previousPath = env.PATH;
    env.PATH = path.join(scratch, 'no-binaries');
    try {
      const result = run('tools/daemon/index.mjs', ['start', '--docker'], 1);
      expect(result.stderr).toContain('Docker is not available.');
      expect(result.stderr).not.toContain('Failed to start Docker container');
    } finally { env.PATH = previousPath; }
  });

  it('applies a legacy mission migration using the installed codec', () => {
    const state = path.join(consumer, '.aiwg', 'missions');
    mkdirSync(state, { recursive: true });
    const mission = path.join(state, 'legacy.mission.json');
    writeFileSync(mission, JSON.stringify({ id: 'legacy', objective: 'Offline fixture', status: 'running' }));
    run('bin/aiwg.mjs', ['mission', 'migrate', '--apply', '--target', 'mission.aiwg.io/v1', '--id', 'smoke']);
    expect(JSON.parse(readFileSync(mission, 'utf8')).apiVersion).toBe('mission.aiwg.io/v1');
  });
});

describe('checkPackedRelativeImports — proves the guard actually catches a violation', () => {
  it('flags a shipped tools/**/*.mjs file with a literal relative import into an unshipped src/ path', () => {
    const packedFiles = ['tools/example/broken.mjs'];
    const violations = checkPackedRelativeImports({
      root: ROOT,
      packedFiles,
      readFile: () => "import { boundedExecSync } from '../../src/process/bounded-child-process.mjs';\nboundedExecSync('x', 'quick');\n",
    });

    expect(violations).toEqual([
      {
        file: 'tools/example/broken.mjs',
        spec: '../../src/process/bounded-child-process.mjs',
        resolvedRel: 'src/process/bounded-child-process.mjs',
        lazy: false,
      },
    ]);
  });

  it('does not flag a bare (non-relative) module specifier', () => {
    const packedFiles = ['tools/example/ok.mjs'];
    const violations = checkPackedRelativeImports({
      root: ROOT,
      packedFiles,
      readFile: () => "import fs from 'node:fs';\nimport chalk from 'chalk';\n",
    });

    expect(violations).toEqual([]);
  });

  it('does not flag a relative import that does resolve within the packed set', () => {
    const packedFiles = ['tools/example/ok.mjs', 'tools/_resolve-impl.mjs'];
    const violations = checkPackedRelativeImports({
      root: ROOT,
      packedFiles,
      readFile: (absolutePath: string) =>
        absolutePath.endsWith('tools/example/ok.mjs')
          ? "import { importImpl } from '../_resolve-impl.mjs';\nimportImpl;\n"
          : "export function importImpl() {}\n",
    });

    expect(violations).toEqual([]);
  });

  it('flags an unresolved top-level (eager) dynamic import() the same way as a static import', () => {
    const packedFiles = ['tools/example/broken-dynamic.mjs'];
    const violations = checkPackedRelativeImports({
      root: ROOT,
      packedFiles,
      readFile: () => "const { boundedExecSync } = await import('../../src/process/bounded-child-process.mjs');\nboundedExecSync('x', 'quick');\n",
    });

    expect(violations).toEqual([
      {
        file: 'tools/example/broken-dynamic.mjs',
        spec: '../../src/process/bounded-child-process.mjs',
        resolvedRel: 'src/process/bounded-child-process.mjs',
        lazy: false,
      },
    ]);
  });

  it('flags an unresolved import() nested in a function as lazy, distinct from the same import at top level', () => {
    const packedFiles = ['tools/example/broken-lazy.mjs'];
    const violations = checkPackedRelativeImports({
      root: ROOT,
      packedFiles,
      readFile: () => [
        'export async function getHelper() {',
        "  const { boundedExecSync } = await import('../../src/process/bounded-child-process.mjs');",
        '  return boundedExecSync;',
        '}',
      ].join('\n'),
    });

    expect(violations).toEqual([
      {
        file: 'tools/example/broken-lazy.mjs',
        spec: '../../src/process/bounded-child-process.mjs',
        resolvedRel: 'src/process/bounded-child-process.mjs',
        lazy: true,
      },
    ]);
  });

  it('flags an unresolved import in a shipped .ts tool file, not just .mjs (#3062 B/C finding 2)', () => {
    const packedFiles = ['tools/example/broken.ts'];
    const violations = checkPackedRelativeImports({
      root: ROOT,
      packedFiles,
      readFile: () => "import { boundedExecSync } from '../../src/process/bounded-child-process.mjs';\nboundedExecSync('x', 'quick');\n",
    });

    expect(violations).toEqual([
      {
        file: 'tools/example/broken.ts',
        spec: '../../src/process/bounded-child-process.mjs',
        resolvedRel: 'src/process/bounded-child-process.mjs',
        lazy: false,
      },
    ]);
  });

  it('does not flag an unexecutable .d.ts declaration file', () => {
    const packedFiles = ['tools/example/types.d.ts'];
    const violations = checkPackedRelativeImports({
      root: ROOT,
      packedFiles,
      readFile: () => "import type { Thing } from '../../src/process/not-shipped.js';\n",
    });

    expect(violations).toEqual([]);
  });

  it('flags an unresolved import in a built dist/src/**/*.js file (#3062 B/C finding 2)', () => {
    const packedFiles = ['dist/src/cli/handlers/example.js'];
    const violations = checkPackedRelativeImports({
      root: ROOT,
      packedFiles,
      readFile: () => "import { thing } from '../../../../tools/not-shipped.mjs';\nthing();\n",
    });

    expect(violations).toEqual([
      {
        file: 'dist/src/cli/handlers/example.js',
        spec: '../../../../tools/not-shipped.mjs',
        resolvedRel: 'tools/not-shipped.mjs',
        lazy: false,
      },
    ]);
  });
});
