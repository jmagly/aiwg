import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { getVersionInfo } from '../../../src/channel/manager.mjs';

const repo = path.resolve(import.meta.dirname, '../../..');
const source = readFileSync(path.join(repo, 'bin/aiwg.mjs'), 'utf8');
const functions = source.slice(source.indexOf('function readPackageVersion('), source.indexOf('const FAST_HELP_TEXT'));
let root: string;
let launcher: string;
let runtime: string;
let config: string;

function write(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'aiwg-version-entry-'));
  launcher = path.join(root, 'launcher');
  runtime = path.join(root, 'runtime');
  config = path.join(root, 'config');
  write(path.join(launcher, 'package.json'), { name: 'aiwg', version: '2026.9.20' });
  write(path.join(runtime, 'package.json'), { name: 'aiwg', version: '2026.10.3' });
  write(path.join(config, 'channel.json'), { channel: 'edge', devMode: true, edgePath: runtime });
  vi.stubEnv('AIWG_CONFIG', config);
  vi.stubEnv('AIWG_CLI_DRY_RUN', '1');
  vi.stubEnv('AIWG_LAUNCHER_ROOT', launcher);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function fastVersion(args: string[]) {
  const lines: string[] = [];
  const handled = runInNewContext(`${functions}\nmaybeHandleFastVersion(args);`, {
    args, path, readFileSync, existsSync, packageRoot: launcher,
    os: { homedir: () => root }, process: { env: { AIWG_CONFIG: config } },
    console: { log: (line: string) => lines.push(line) },
  }, { timeout: 1000 });
  return { handled, output: lines.join('\n') };
}

describe('version launcher entrypoint', () => {
  it.each(['--version', '-version'])('%s labels launcher and effective runtime versions', flag => {
    const result = fastVersion([flag]);
    expect(result.handled).toBe(true);
    expect(result.output).toContain('[dev]');
    expect(result.output).toContain('launcher: 2026.9.20');
    expect(result.output).toContain('runtime: 2026.10.3');
    expect(result.output).toContain(`runtime path: ${runtime}`);
  });

  it('passes launcher identity to the runtime and leaves JSON to the handler', async () => {
    const env: Record<string, string> = { AIWG_LAUNCHER_ROOT: '/synthetic/previous-launcher' };
    const begin = source.indexOf('const packageRoot =');
    const end = source.indexOf('function readPackageVersion(', begin);
    runInNewContext(source.slice(begin, end), {
      process: { env }, path, __dirname: path.join(launcher, 'bin'),
    }, { timeout: 1000 });
    expect(env.AIWG_LAUNCHER_ROOT).toBe(launcher);
    expect(fastVersion(['--version', '--json']).handled).toBe(false);
    expect(await getVersionInfo()).toMatchObject({
      launcherVersion: '2026.9.20', runtimeVersion: '2026.10.3', runtimePath: runtime,
    });
  });

  it.each([
    { args: ['index', 'refresh'], credential: false, readOnly: false, calls: 0, phase: 'notifier:skip (index refresh)' },
    { args: ['mcp', 'profile', 'login'], credential: true, readOnly: false, calls: 0, phase: 'notifier:skip (credential-handling command)' },
    { args: ['version'], credential: false, readOnly: false, calls: 1, phase: 'notifier:bootstrap-complete' },
    { args: ['rules', 'inventory'], credential: false, readOnly: true, calls: 0, phase: 'notifier:skip (read-only report)' },
  ])('dispatches notifier for $args without launcher identity bindings', async ({ args, credential, readOnly, calls, phase }) => {
    const notifier = vi.fn();
    const trace = vi.fn();
    const begin = source.indexOf('const cliArgs = process.argv.slice(2);');
    const end = source.indexOf('if (maybeHandleFastVersion(cliArgs))', begin);
    await runInNewContext(`(async () => { ${source.slice(begin, end)} })()`, {
      process: { argv: ['node', 'aiwg', ...args] }, trace, readOnlyReport: readOnly,
      isCredentialHandlingCommand: () => credential,
      runUpdateNotifierBootstrap: notifier,
    }, { timeout: 1000 });
    expect(notifier).toHaveBeenCalledTimes(calls);
    expect(trace).toHaveBeenCalledExactlyOnceWith(phase);
  });

  it.each([
    { args: ['marketplace', 'search', 'design', '--plugins'], expected: true },
    { args: ['market', 'search', 'design', '--plugins', '--json'], expected: true },
    { args: ['marketplace', 'search', 'design'], expected: false },
    { args: ['memory', 'audit'], expected: true },
    { args: ['memory', 'plan', '--out', 'plan.json'], expected: true },
    { args: ['memory', 'apply', '--plan', 'plan.json', '--preview'], expected: true },
    { args: ['memory', 'restore', '--plan', 'plan.json', '--preview'], expected: true },
    { args: ['memory', 'apply', '--plan', 'plan.json', '--yes'], expected: false },
    { args: ['memory', 'audit', '--json', '--write'], expected: true },
    { args: ['memory', 'cost'], expected: true },
    { args: ['memory', 'cost', '--demote', 'synthetic'], expected: true },
    { args: ['memory', '--help'], expected: true },
    { args: ['help', 'memory'], expected: true },
    { args: ['memory', 'put', 'page.md'], expected: false },
    { args: ['memory', 'project', 'reindex'], expected: false },
  ])('preserves launcher no-write handling for $args', ({ args, expected }) => {
    const start = source.indexOf('function isReadOnlyReport(');
    const end = source.indexOf('const readOnlyReport =', start);
    expect(runInNewContext(`${source.slice(start, end)}; isReadOnlyReport(args)`, { args }, { timeout: 1000 })).toBe(expected);
  });

  it('keeps stable output compact when a stale edge path is configured', () => {
    write(path.join(config, 'channel.json'), { channel: 'stable', devMode: false, edgePath: runtime });
    const result = fastVersion(['--version']);
    expect(result.output).toContain('2026.9.20  [stable]');
    expect(result.output).not.toContain('2026.10.3');
    expect(result.output).not.toContain('runtime:');
  });

  it('honors canonical installation mode over legacy dev mode', () => {
    write(path.join(config, 'installation.json'), { runMode: 'normal', channel: 'stable', edgePath: runtime });
    const result = fastVersion(['--version']);
    expect(result.output).toContain('[stable]');
    expect(result.output).not.toContain('runtime:');
  });

  it('reports an unreadable runtime package as unknown', () => {
    rmSync(path.join(runtime, 'package.json'));
    const result = fastVersion(['--version']);
    expect(result.output).toContain('runtime: (unknown)');
    expect(result.output).toContain(runtime);
  });

  it.each([{ args: [] }, { args: ['--json'] }])('legacy version script reports runtime identity with args $args', async ({ args }) => {
    const lines: string[] = [];
    const script = readFileSync(path.join(repo, 'tools/cli/version.mjs'), 'utf8');
    await runInNewContext(`(async () => { ${script.slice(script.indexOf('const args ='))} })()`, {
      getVersionInfo, process: { argv: ['node', 'version.mjs', ...args] },
      console: { log: (line: string) => lines.push(line) },
    }, { timeout: 1000 });
    const output = lines.join('\n');
    if (args.includes('--json')) {
      expect(JSON.parse(output)).toMatchObject({ launcherVersion: '2026.9.20', runtimeVersion: '2026.10.3', runtimePath: runtime });
    } else {
      expect(output).toContain('launcher: 2026.9.20');
      expect(output).toContain('runtime: 2026.10.3');
      expect(output).toContain(`runtime path: ${runtime}`);
    }
  });
});
