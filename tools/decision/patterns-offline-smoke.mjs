#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'aiwg-decision-pattern-smoke-'));
const consumerRoot = path.join(tempRoot, 'consumer');
const npmCache = path.join(tempRoot, 'npm-cache');
const npmrc = path.join(tempRoot, 'npmrc');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const sourceCacheResult = spawnSync(npmCommand, ['config', 'get', 'cache'], {
  cwd: root, env: process.env, encoding: 'utf8', timeout: 30_000,
});
if (sourceCacheResult.error || sourceCacheResult.status !== 0 || !sourceCacheResult.stdout.trim()) {
  throw new Error(`could not resolve the populated npm cache\n${sourceCacheResult.stderr || ''}`);
}
const sourceNpmCache = sourceCacheResult.stdout.trim();

mkdirSync(consumerRoot, { recursive: true });
writeFileSync(path.join(consumerRoot, 'package.json'), '{"private":true,"type":"module"}\n');
writeFileSync(npmrc, 'audit=false\nfund=false\nignore-scripts=true\noffline=true\n', { mode: 0o600 });

const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => {
  const normalized = key.toLowerCase();
  return !normalized.startsWith('npm_config_')
    && !/(?:api[_-]?key|credential|password|secret|token|authorization|auth[_-]?key)/i.test(key)
    && key !== 'AIWG_ROOT'
    && key !== 'NODE_OPTIONS';
}));
const commandEnvironment = {
  ...cleanEnvironment,
  HOME: path.join(tempRoot, 'home'),
  USERPROFILE: path.join(tempRoot, 'home'),
  NPM_CONFIG_CACHE: npmCache,
  NPM_CONFIG_USERCONFIG: npmrc,
  NPM_CONFIG_OFFLINE: 'true',
  NO_UPDATE_NOTIFIER: '1',
};

try {
  const pack = run(npmCommand, [
    'pack', '--ignore-scripts', '--json', '--pack-destination', tempRoot,
  ], { cwd: root, env: commandEnvironment });
  const packed = parsePackJson(pack.stdout);
  const tarball = path.join(tempRoot, packed[0].filename);

  // The repository install populated npm's normal cache. Copying that cache into
  // the isolated smoke root would make the result machine-specific, so install
  // from the tarball with the normal cache while npm's offline mode forbids all
  // registry access.
  const installEnvironment = {
    ...commandEnvironment,
    NPM_CONFIG_CACHE: sourceNpmCache,
  };
  run(npmCommand, [
    'install', '--offline', '--ignore-scripts', '--omit=optional', '--no-audit',
    '--no-fund', '--package-lock=false', tarball,
  ], { cwd: consumerRoot, env: installEnvironment, timeout: 300_000 });

  const installRoot = path.join(consumerRoot, 'node_modules', 'aiwg');
  const requiredPaths = [
    'package.json',
    'dist/src/decision/index.js',
    'dist/src/decision/index.d.ts',
    'dist/src/decision/patterns/index.js',
    'dist/src/decision/patterns/index.d.ts',
    'docs/decision/pattern-playground.md',
    'docs/decision/operations/README.md',
    'docs/decision/operations/closure-manifest.v1.json',
  ];
  for (const relativePath of requiredPaths) {
    if (!existsSync(path.join(installRoot, relativePath))) {
      fail(`packed install is missing ${relativePath}`);
    }
  }

  const manifest = JSON.parse(readFileSync(path.join(installRoot, 'package.json'), 'utf8'));
  if (manifest.exports?.['./decision']?.import !== './dist/src/decision/index.js') {
    fail('packed package does not export aiwg/decision from the expected installed path');
  }
  const closure = JSON.parse(readFileSync(path.join(
    installRoot, 'docs', 'decision', 'operations', 'closure-manifest.v1.json',
  ), 'utf8'));
  if (closure.gates?.offlinePackageSmoke !== 'npm run smoke:decision:patterns:offline') {
    fail('packed closure manifest does not reference the offline package smoke command');
  }
  const runbookDocument = readFileSync(path.join(installRoot, closure.runbookDocument), 'utf8');
  for (const runbook of closure.runbooks ?? []) {
    if (!runbookDocument.includes(runbook)) fail(`packed runbook document is missing ${runbook}`);
  }
  const operationalGateModule = await import(pathToFileURL(path.join(
    installRoot, 'tools', 'decision', 'pattern-operational-gate.mjs',
  )).href);
  const operationalGate = operationalGateModule.runPatternOperationalGateFromRoot(installRoot);
  if (operationalGate.status !== 'pass' || operationalGate.markdown?.status !== 'pass') {
    fail('packed operational drill or Markdown gate did not pass');
  }

  const probePath = path.join(consumerRoot, 'offline-pattern-probe.mjs');
  writeFileSync(probePath, probeSource(), { mode: 0o600 });
  const probe = run(process.execPath, [probePath], {
    cwd: consumerRoot,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      HOME: commandEnvironment.HOME,
      USERPROFILE: commandEnvironment.USERPROFILE,
      AIWG_PATTERN_INSTALL_ROOT: installRoot,
      AIWG_PATTERN_TEMP_ROOT: path.join(tempRoot, 'fixture-state'),
    },
    timeout: 120_000,
  });
  const evidence = JSON.parse(probe.stdout);
  if (evidence.status !== 'pass' || evidence.networkAttempts !== 0 || evidence.credentialVariables !== 0) {
    fail('offline installed-package probe returned invalid evidence', probe);
  }

  // The discoverable entry point is the decision-engine `decision-playground` skill.
  // Run it from the installed package with every network primitive disabled.
  const playgroundScript = path.join(installRoot, 'agentic', 'code', 'addons', 'decision-engine', 'skills', 'decision-playground', 'scripts', 'decision-playground.mjs');
  if (!existsSync(playgroundScript)) fail('packed install is missing the decision-playground entry point');
  const guardPath = path.join(consumerRoot, 'network-guard.mjs');
  writeFileSync(guardPath, networkGuardSource(), { mode: 0o600 });
  const entryEnvironment = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: commandEnvironment.HOME, USERPROFILE: commandEnvironment.USERPROFILE };
  const listed = JSON.parse(run(process.execPath, ['--import', pathToFileURL(guardPath).href, playgroundScript, 'list'], { cwd: consumerRoot, env: entryEnvironment, timeout: 120_000 }).stdout);
  const ranAll = JSON.parse(run(process.execPath, ['--import', pathToFileURL(guardPath).href, playgroundScript, 'run-all'], { cwd: consumerRoot, env: entryEnvironment, timeout: 300_000 }).stdout);
  if (listed.length !== evidence.patterns || ranAll.failed !== 0 || ranAll.fixtures !== evidence.fixtures
    || ranAll.results.some(result => result.fixture && result.evaluator !== 'evaluateDecisionRuleset' && result.evaluator !== 'rejected-before-dispatch')) {
    fail('installed decision-playground entry point returned invalid evidence');
  }
  evidence.entryPoint = { skill: 'decision-playground', listed: listed.length, fixtures: ranAll.fixtures, failed: ranAll.failed };
  console.log(JSON.stringify({
    gate: 'decision-patterns-offline-package',
    package: manifest.version,
    installRoot: '<temporary>/consumer/node_modules/aiwg',
    npmOffline: true,
    operationalGate,
    ...evidence,
  }, null, 2));
} finally {
  if (process.env.AIWG_KEEP_DECISION_PATTERN_SMOKE !== '1') {
    rmSync(tempRoot, { recursive: true, force: true });
  } else {
    console.error(`Preserved smoke-test workspace: ${tempRoot}`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? tempRoot,
    env: options.env ?? commandEnvironment,
    encoding: 'utf8',
    timeout: options.timeout ?? 180_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
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

function fail(message, result = {}) {
  const diagnostics = [result.stdout, result.stderr].filter(Boolean).join('\n');
  throw new Error(diagnostics ? `${message}\n${diagnostics}` : message);
}

function networkGuardSource() {
  return String.raw`
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
const rejectNetwork = () => { throw new Error('decision playground smoke forbids network access'); };
net.connect = rejectNetwork;
net.createConnection = rejectNetwork;
tls.connect = rejectNetwork;
http.request = rejectNetwork;
http.get = rejectNetwork;
https.request = rejectNetwork;
https.get = rejectNetwork;
dns.lookup = rejectNetwork;
dns.resolve = rejectNetwork;
dns.promises.lookup = rejectNetwork;
dns.promises.resolve = rejectNetwork;
dgram.createSocket = rejectNetwork;
http2.connect = rejectNetwork;
globalThis.fetch = rejectNetwork;
`;
}

function probeSource() {
  return String.raw`
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

let networkAttempts = 0;
const rejectNetwork = () => {
  networkAttempts += 1;
  throw new Error('decision pattern smoke forbids network access');
};
net.connect = rejectNetwork;
net.createConnection = rejectNetwork;
tls.connect = rejectNetwork;
http.request = rejectNetwork;
http.get = rejectNetwork;
https.request = rejectNetwork;
https.get = rejectNetwork;
dns.lookup = rejectNetwork;
dns.resolve = rejectNetwork;
dns.promises.lookup = rejectNetwork;
dns.promises.resolve = rejectNetwork;
dgram.createSocket = rejectNetwork;
http2.connect = rejectNetwork;
globalThis.fetch = rejectNetwork;

const installRoot = process.env.AIWG_PATTERN_INSTALL_ROOT;
const fixtureRoot = process.env.AIWG_PATTERN_TEMP_ROOT;
assert.ok(installRoot && fixtureRoot);
const require = createRequire(import.meta.url);
const entry = require.resolve('aiwg/decision');
assert.equal(entry, path.join(installRoot, 'dist', 'src', 'decision', 'index.js'));
const api = await import(pathToFileURL(entry).href);
const listed = api.listDecisionPatterns();
assert.equal(listed.length, api.decisionPatternPacks.length);
assert.ok(listed.length > 0);

let fixtures = 0;
let runtimeFixtures = 0;
let artifacts = 0;
for (const pack of api.decisionPatternPacks) {
  assert.deepEqual(api.validateDecisionPattern(pack), []);
  const installedPack = api.getDecisionPatternPack(pack.id);
  assert.equal(installedPack.version, pack.version);
  for (const advertised of Object.values(installedPack.artifacts)) {
    for (const reference of Array.isArray(advertised) ? advertised : [advertised]) {
      const resolved = api.resolveDecisionPatternArtifact(reference);
      assert.equal(resolved.patternId, pack.id);
      assert.equal(resolved.patternVersion, pack.version);
      artifacts += 1;
    }
  }
  if (pack.status === 'unavailable') {
    await assert.rejects(() => api.runOfflineDecisionPattern(pack.id), /unavailable/);
    continue;
  }
  assert.ok(pack.fixtures.length > 0, pack.id + ' has no offline fixture');
  for (const fixture of pack.fixtures) {
    const receipt = await api.runOfflineDecisionPattern(pack.id, fixture.id);
    assert.equal(receipt.executionMode, 'offline-recorded');
    assert.equal(receipt.evidenceOrigin, 'sanitized-recorded-fixture');
    assert.equal(receipt.actualModel, null);
    assert.equal(receipt.runtime.evaluator, 'evaluateDecisionRuleset');
    assert.equal(receipt.runtime.transport, 'recorded-replay');
    if (receipt.result) {
      // Every dispatched fixture wraps the production RulesetResult.
      assert.equal(receipt.result.kind, 'RulesetResult');
      assert.ok(receipt.runtime.transportCalls > 0, pack.id + '/' + fixture.id + ' made no recorded transport call');
      runtimeFixtures += 1;
    } else {
      assert.equal(receipt.runtime.transportCalls, 0);
    }
    assert.equal(receipt.action.status, 'unexecuted');
    assert.equal(receipt.route, fixture.expected.route);
    assert.equal(receipt.reason, fixture.expected.reason);
    fixtures += 1;
  }
}

await mkdir(fixtureRoot, { recursive: true });
try {
  const durable = await api.runOfflineDurableReviewFixture(fixtureRoot);
  assert.equal(durable.networkAllowed, false);
  assert.equal(durable.credentialRequired, false);
  assert.equal(durable.executorCalls, 1);
  assert.equal(durable.duplicateResumeReturnedReceipt, true);
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

const credentialVariables = Object.keys(process.env).filter(key =>
  /(?:api[_-]?key|credential|password|secret|token|authorization|auth[_-]?key)/i.test(key),
).length;
assert.equal(credentialVariables, 0);
assert.equal(networkAttempts, 0);
process.stdout.write(JSON.stringify({
  status: 'pass',
  entry: 'node_modules/aiwg/dist/src/decision/index.js',
  patterns: listed.length,
  fixtures,
  runtimeFixtures,
  artifacts,
  durableReview: 'pass',
  networkAttempts,
  credentialVariables,
}));
`;
}
