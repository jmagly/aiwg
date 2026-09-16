#!/usr/bin/env node

import {
  existsSync, mkdirSync, readFileSync, rmSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const root = resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
const resultsRoot = resolve(root, 'test-results');
const adapterFiles = [
  ...[
    'claude', 'codex', 'copilot', 'cursor', 'factory', 'generic', 'hermes',
    'grokbot', 'openclaw', 'opencode', 'openhuman', 'warp', 'windsurf',
  ].map((provider) => `test/unit/sessions/${provider}-adapter.test.ts`),
];
const crossProviderFiles = [
  'test/unit/sessions/repository-importer.test.ts',
  'test/unit/sessions/import-lease.test.ts',
  'test/unit/sessions/workspace-discovery.test.ts',
  'test/unit/sessions/origin-timeline.test.ts',
  'test/unit/sessions/provider-conformance.test.ts',
  'test/unit/sessions/regression-corpus.test.ts',
  'test/unit/cli/handlers/sessions.test.ts',
  'test/integration/sessions-regression-cli.test.ts',
];

try {
  require('better-sqlite3');
} catch {
  console.error('SQLite CI preflight failed: better-sqlite3 could not be loaded.');
  process.exit(1);
}

const sanitizer = spawnSync(process.execPath, [
  resolve(root, 'tools/ci/session-fixture-sanitize.mjs'),
], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'inherit', 'inherit'],
});
if (sanitizer.error || sanitizer.status !== 0) {
  console.error('SQLite CI gate failed session regression corpus sanitization.');
  process.exit(sanitizer.status || 1);
}

const vitest = resolve(root, 'node_modules/vitest/vitest.mjs');
mkdirSync(resultsRoot, { recursive: true });
const groups = [
  runGroup('adapter', adapterFiles),
  runGroup('cross-provider', crossProviderFiles),
];

console.log(JSON.stringify({
  gate: 'session-sqlite',
  backend: 'better-sqlite3',
  corpusSanitization: 'pass',
  groups: Object.fromEntries(groups.map((group) => [group.id, {
    report: group.report,
    requiredFiles: group.requiredFiles,
    testSuites: group.testSuites,
    tests: group.tests,
    passed: group.passed,
    skipped: group.skipped,
  }])),
  requiredFiles: groups.reduce((sum, group) => sum + group.requiredFiles, 0),
  testSuites: groups.reduce((sum, group) => sum + group.testSuites, 0),
  tests: groups.reduce((sum, group) => sum + group.tests, 0),
  passed: groups.reduce((sum, group) => sum + group.passed, 0),
  skipped: groups.reduce((sum, group) => sum + group.skipped, 0),
}, null, 2));

function runGroup(id, requiredFiles) {
  const reportPath = resolve(resultsRoot, `session-sqlite-${id}.json`);
  rmSync(reportPath, { force: true });
  const result = spawnSync(process.execPath, [
    vitest,
    'run',
    '--config',
    'config/vitest.config.js',
    '--reporter=json',
    '--outputFile',
    reportPath,
    ...requiredFiles,
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  if (result.error || !existsSync(reportPath)) {
    console.error(`${id} SQLite gate failed before a complete report was produced.`);
    process.exit(result.status || 1);
  }

  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const results = new Map(report.testResults.map((entry) => [
    entry.name.replace(`${root}/`, ''),
    entry,
  ]));
  const missing = requiredFiles.filter((file) => !results.has(file));
  const skipped = report.testResults.flatMap((entry) =>
    entry.assertionResults
      .filter((assertion) => assertion.status === 'pending' || assertion.status === 'disabled')
      .map((assertion) => `${entry.name.replace(`${root}/`, '')}: ${assertion.fullName}`));
  const failed = report.testResults.flatMap((entry) =>
    entry.assertionResults
      .filter((assertion) => assertion.status === 'failed')
      .map((assertion) => `${entry.name.replace(`${root}/`, '')}: ${assertion.fullName}`));

  if (missing.length || skipped.length || failed.length || result.status !== 0) {
    if (missing.length) console.error(`${id} SQLite suites missing: ${missing.join(', ')}`);
    if (skipped.length) console.error(`${id} SQLite tests skipped:\n${skipped.join('\n')}`);
    if (failed.length) console.error(`${id} SQLite tests failed:\n${failed.join('\n')}`);
    process.exit(1);
  }

  return {
    id,
    report: `test-results/session-sqlite-${id}.json`,
    requiredFiles: requiredFiles.length,
    testSuites: report.numTotalTestSuites,
    tests: report.numTotalTests,
    passed: report.numPassedTests,
    skipped: report.numPendingTests,
  };
}
