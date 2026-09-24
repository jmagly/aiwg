import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acquireDirectoryLock } from '../../src/artifacts/prebuilt-build-lock.js';

// Clean-install evidence for the decision-engine addon (#2641): pack the
// repository, install the tarball into an empty project with npm offline, deploy
// the addon from the installed package, and run the deployed dispatcher on the
// shipped fixture request. Requires `npm run build` (the packaging lane builds first).
const ROOT = path.resolve(import.meta.dirname, '../..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const SKILL = path.join('.claude', '.aiwg', 'skills', 'decision-evaluate');
const EXAMPLES = path.join('node_modules', 'aiwg', 'agentic', 'code', 'addons', 'decision-engine', 'examples');

let tempRoot = '';
let consumer = '';
let installRoot = '';
let home = '';

function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeout?: number }): SpawnSyncReturns<string> {
  return spawnSync(command, args, {
    cwd: options.cwd, env: options.env, encoding: 'utf8',
    timeout: options.timeout ?? 180_000, maxBuffer: 64 * 1024 * 1024,
  });
}

function ok(result: SpawnSyncReturns<string>): SpawnSyncReturns<string> {
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, [result.stderr, result.stdout].join('\n')).toBe(0);
  return result;
}

// No AIWG_ROOT, npm config, provider credentials or PATH: the deployed script
// must find the runtime from the project install alone.
function isolatedEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    NO_UPDATE_NOTIFIER: '1', AIWG_LOG_LEVEL: 'silent', ...extra,
  };
}

function aiwg(args: string[], cwd = consumer): SpawnSyncReturns<string> {
  return run(process.execPath, [path.join(installRoot, 'bin', 'aiwg.mjs'), ...args], {
    cwd, env: isolatedEnv({ PATH: process.env.PATH }), timeout: 300_000,
  });
}

function dispatch(script: string, request: string, cwd: string, extra: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
  return run(process.execPath, [script, '--request', request], { cwd, env: isolatedEnv(extra), timeout: 120_000 });
}

describe('decision-engine clean install from the packed tarball', () => {
  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'aiwg-decision-clean-install-'));
    home = path.join(tempRoot, 'home');
    consumer = path.join(tempRoot, 'consumer');
    await mkdir(home, { recursive: true });
    await mkdir(consumer, { recursive: true });
    await writeFile(path.join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');

    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !key.toLowerCase().startsWith('npm_config_') && key !== 'AIWG_ROOT' && key !== 'NODE_OPTIONS'));
    const cache = run(NPM, ['config', 'get', 'cache'], { cwd: ROOT, env: cleanEnv, timeout: 30_000 });
    expect(cache.status, cache.stderr).toBe(0);

    const releasePackLock = await acquireDirectoryLock(path.join(ROOT, 'prebuilt', 'fortemi-core', '.framework-build.lock'));
    let pack: SpawnSyncReturns<string>;
    try {
      pack = run(NPM, ['pack', '--ignore-scripts', '--json', '--pack-destination', tempRoot], { cwd: ROOT, env: cleanEnv, timeout: 120_000 });
    } finally {
      await releasePackLock();
    }
    ok(pack);
    const tarball = path.join(tempRoot, (JSON.parse(pack.stdout) as Array<{ filename: string }>)[0]!.filename);

    // Offline: the repository install already populated npm's cache.
    ok(run(NPM, [
      'install', '--offline', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund',
      '--package-lock=false', '--cache', cache.stdout.trim(), tarball,
    ], { cwd: consumer, env: { ...cleanEnv, HOME: home, NPM_CONFIG_OFFLINE: 'true' }, timeout: 300_000 }));
    installRoot = path.join(consumer, 'node_modules', 'aiwg');
  }, 600_000);

  afterAll(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  it('ships the addon examples, runtime locator and compiled runtime', () => {
    for (const relative of [
      'dist/src/decision/index.js',
      'agentic/code/addons/decision-engine/manifest.json',
      'agentic/code/addons/decision-engine/skills/decision-evaluate/scripts/runtime-root.mjs',
      'agentic/code/addons/decision-engine/examples/dispatcher-request-llm.json',
      'agentic/code/addons/decision-engine/examples/fixture-llm-adapter.mjs',
      'agentic/code/addons/decision-engine/examples/binding-jev.json',
      'tools/decision/jev-live-smoke.mjs',
    ]) expect(existsSync(path.join(installRoot, relative)), relative).toBe(true);
  });

  it('deploys the addon by name and runs the deployed dispatcher on the fixture request', async () => {
    ok(aiwg(['use', 'decision-engine', '--provider', 'claude']));
    const script = path.join(consumer, SKILL, 'scripts', 'decision-evaluate.mjs');
    expect(existsSync(script)).toBe(true);
    expect(existsSync(path.join(consumer, SKILL, 'scripts', 'runtime-root.mjs'))).toBe(true);

    const request = path.join(consumer, EXAMPLES, 'dispatcher-request-llm.json');
    const disabled = dispatch(script, request, consumer);
    expect(disabled.status).toBe(2);
    expect(disabled.stderr).toContain('AIWG_DECISION_ENABLED=1');

    const result = ok(dispatch(script, request, consumer, { AIWG_DECISION_ENABLED: '1' }));
    const outcome = JSON.parse(result.stdout);
    expect(outcome.kind).toBe('RulesetResult');
    expect(outcome.spec.status).toBe('completed');
    expect(outcome.spec.ruleset.id).toBe('example-triage');
  }, 600_000);

  it('resolves the runtime through AIWG_ROOT when the script is outside any install', async () => {
    const detached = path.join(tempRoot, 'detached');
    await cp(path.join(consumer, SKILL), detached, { recursive: true });
    const script = path.join(detached, 'scripts', 'decision-evaluate.mjs');
    const request = path.join(consumer, EXAMPLES, 'dispatcher-request-llm.json');

    const missing = dispatch(script, request, tempRoot, { AIWG_DECISION_ENABLED: '1' });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('Cannot locate the aiwg decision runtime');

    const rooted = ok(dispatch(script, request, tempRoot, { AIWG_DECISION_ENABLED: '1', AIWG_ROOT: installRoot }));
    expect(JSON.parse(rooted.stdout).spec.status).toBe('completed');
  }, 120_000);

  it('keeps the addon out of bulk deploys', async () => {
    const bulk = path.join(tempRoot, 'bulk');
    await mkdir(bulk, { recursive: true });
    ok(aiwg(['use', 'all', '--copy-all', '--provider', 'claude', '--target', bulk], consumer));
    expect(existsSync(path.join(bulk, SKILL))).toBe(false);
    const manifest = JSON.parse(await readFile(path.join(installRoot, 'agentic/code/addons/decision-engine/manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ autoInstall: false, explicitInstall: true });
    // Other autoInstall:false addons (testing-quality here) are still deployed.
    expect(existsSync(path.join(bulk, '.claude', '.aiwg', 'skills', 'flaky-detect', 'SKILL.md'))).toBe(true);
  }, 600_000);
});
