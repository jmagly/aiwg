#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import coverageConfig from '../../config/vitest.testing-quality-coverage.config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const parent = path.join(root, 'test-results/coverage-enforcement');
fs.mkdirSync(parent, { recursive: true });
const dir = fs.mkdtempSync(path.join(parent, 'run-'));
const source = path.join(dir, 'arithmetic.mjs');
const test = path.join(dir, 'arithmetic.test.mjs');
const baseline = 'export function add(a, b) {\n  return a + b;\n}\n';
const uncovered = '\nexport function deliberatelyUncovered(value) {\n' + Array.from({ length: 20 }, (_, i) => `  value += ${i};`).join('\n') + '\n  return value;\n}\n';
fs.writeFileSync(test, "import { it, expect } from 'vitest';\nimport { add } from './arithmetic.mjs';\nit('adds two independent operands', () => expect(add(4, 7)).toBe(11));\n");
const receipts = [];
const digest = value => createHash('sha256').update(value).digest('hex');
function run(phase) {
  const config = path.join(dir, `${phase}.config.mjs`);
  const results = path.join(dir, `${phase}.results.json`);
  const output = path.join(dir, phase);
  fs.writeFileSync(config, 'export default ' + JSON.stringify({
    root, test: {
      include: [path.relative(root, test)], reporters: ['json'], outputFile: results,
      coverage: {
        enabled: true, provider: 'v8', include: [path.relative(root, source)],
        exclude: [], reporter: ['json-summary'], reportsDirectory: output,
        thresholds: coverageConfig.test.coverage.thresholds,
      },
    },
  }) + ';\n');
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config], {
    cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    killSignal: 'SIGKILL',
  });
  fs.writeFileSync(path.join(dir, `${phase}.stdout.log`), result.stdout ?? '');
  fs.writeFileSync(path.join(dir, `${phase}.stderr.log`), result.stderr ?? '');
  if (result.error || result.signal) throw new Error(`${phase}: runner setup/timeout failure: ${result.error ?? result.signal}`);
  const reportText = fs.readFileSync(results, 'utf8');
  const report = JSON.parse(reportText);
  const summaryText = fs.readFileSync(path.join(output, 'coverage-summary.json'), 'utf8');
  const summary = JSON.parse(summaryText).total;
  if (report.numTotalTests !== 1 || report.numPassedTests !== 1 || report.numFailedTests !== 0 || report.numPendingTests !== 0) throw new Error(`${phase}: expected exactly one passing behavioral test`);
  if (!summary?.lines?.total) throw new Error(`${phase}: missing/nonpositive source denominator`);
  receipts.push({ phase, exitCode: result.status, sourceHash: digest(fs.readFileSync(source)), testHash: digest(fs.readFileSync(test)), reportHash: digest(reportText), coverageHash: digest(summaryText), coverage: summary });
  if (phase === 'uncovered') {
    if (result.status === 0 || !/Coverage for .* does not meet.*threshold/i.test(result.stderr + result.stdout)) throw new Error('Deliberately uncovered source did not fail the configured threshold for the intended reason');
  } else if (result.status !== 0) throw new Error(`${phase}: fully covered baseline failed`);
}
try {
  fs.writeFileSync(source, baseline);
  run('baseline');
  fs.writeFileSync(source, baseline + uncovered);
  run('uncovered');
} finally {
  fs.writeFileSync(source, baseline);
}
run('restored');
fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify({ scope: 'Synthetic source denominator using the actual scoped coverage thresholds; not a production mutation score', thresholds: coverageConfig.test.coverage.thresholds, receipts }, null, 2) + '\n');
console.log(`Coverage enforcement proved: passing baseline, uncovered-source rejection, restored pass (${path.relative(root, dir)})`);
