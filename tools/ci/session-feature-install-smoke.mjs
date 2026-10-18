#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'aiwg-session-feature-smoke-'));
const prefix = path.join(tempRoot, 'prefix');
const workspace = path.join(tempRoot, 'workspace');
const home = path.join(tempRoot, 'home');
const featuresRoot = path.join(tempRoot, 'features');
const npmrc = path.join(tempRoot, 'npmrc');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

mkdirSync(workspace, { recursive: true });
mkdirSync(home, { recursive: true });
writeFileSync(npmrc, 'ignore-scripts=false\n', { mode: 0o600 });

const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    !key.toLowerCase().startsWith('npm_config_') && key !== 'AIWG_ROOT'),
);
const env = {
  ...cleanEnv,
  HOME: home,
  USERPROFILE: home,
  XDG_CACHE_HOME: path.join(home, '.cache'),
  XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local', 'share'),
  AIWG_FEATURES_HOME: featuresRoot,
  AIWG_LOG_LEVEL: 'silent',
  NO_UPDATE_NOTIFIER: '1',
  NPM_CONFIG_CACHE: path.join(tempRoot, 'npm-cache'),
  NPM_CONFIG_USERCONFIG: npmrc,
};

try {
  const pack = run(npmCommand, [
    'pack', '--ignore-scripts', '--json', '--pack-destination', tempRoot,
  ], { cwd: root });
  const packed = parsePackJson(pack.stdout);
  const tarball = path.join(tempRoot, packed[0].filename);

  run(npmCommand, [
    'install', '--global', '--prefix', prefix, '--omit=optional',
    '--no-audit', '--no-fund', tarball,
  ]);

  const installRoot = process.platform === 'win32'
    ? path.join(prefix, 'node_modules', 'aiwg')
    : path.join(prefix, 'lib', 'node_modules', 'aiwg');
  const cli = process.platform === 'win32'
    ? path.join(prefix, 'aiwg.cmd')
    : path.join(prefix, 'bin', 'aiwg');
  env.AIWG_BIN = cli;

  if (!existsSync(cli)) fail(`packed CLI was not installed at ${cli}`);
  if (existsSync(path.join(installRoot, 'node_modules', 'better-sqlite3'))) {
    fail('clean base install unexpectedly included the optional better-sqlite3 peer');
  }

  const unavailable = run(cli, [
    'sessions', 'list', '--workspace', workspace, '--json',
  ], { cwd: workspace, allowFailure: true });
  const unavailablePayload = JSON.parse(unavailable.stdout);
  if (unavailable.status === 0
    || unavailablePayload?.error?.code !== 'CATALOG_UNAVAILABLE'
    || !unavailablePayload?.error?.message?.includes('aiwg features install sqlite')) {
    fail('clean session command did not return actionable CATALOG_UNAVAILABLE guidance', unavailable);
  }

  run(cli, ['features', 'install', 'sqlite'], { cwd: workspace });

  const featureInfo = run(cli, ['features', 'info', 'sqlite', '--json'], { cwd: workspace });
  const featurePayload = JSON.parse(featureInfo.stdout);
  if (featurePayload?.available !== true
    || featurePayload?.packages?.[0]?.name !== 'better-sqlite3'
    || featurePayload?.packages?.[0]?.loadable !== true) {
    fail('SQLite feature installer did not verify the native module load', featureInfo);
  }

  const featureRequire = createRequire(path.join(featuresRoot, 'package.json'));
  featureRequire('better-sqlite3');

  const listed = run(cli, [
    'sessions', 'list', '--workspace', workspace, '--json',
  ], { cwd: workspace });
  const listedPayload = JSON.parse(listed.stdout);
  if (listedPayload?.status !== 'ok'
    || !Array.isArray(listedPayload?.data?.items)
    || listedPayload.data.items.length !== 0) {
    fail('installed SQLite feature did not support an empty session catalog', listed);
  }

  console.log(JSON.stringify({
    gate: 'session-feature-install',
    package: readPackageVersion(installRoot),
    feature: 'sqlite',
    module: 'better-sqlite3',
    nativeLoad: 'pass',
    emptyCatalogCommand: 'sessions list',
    status: 'pass',
  }, null, 2));
} finally {
  if (process.env.AIWG_KEEP_SESSION_FEATURE_SMOKE !== '1') {
    rmSync(tempRoot, { recursive: true, force: true });
  } else {
    console.error(`Preserved smoke-test workspace: ${tempRoot}`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? tempRoot,
    env,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
    killSignal: 'SIGKILL',
  });
  if (result.error || (!options.allowFailure && result.status !== 0)) {
    fail(`command failed: ${command} ${args.join(' ')}`, result);
  }
  return result;
}

function parsePackJson(output) {
  try {
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed) || !parsed[0]?.filename) throw new Error('missing filename');
    return parsed;
  } catch (error) {
    fail(`could not parse npm pack output: ${error.message}`, { stdout: output });
  }
}

function readPackageVersion(installRoot) {
  return JSON.parse(readFileSync(path.join(installRoot, 'package.json'), 'utf8')).version;
}

function fail(message, result = {}) {
  const diagnostics = [result.stdout, result.stderr].filter(Boolean).join('\n');
  throw new Error(diagnostics ? `${message}\n${diagnostics}` : message);
}
