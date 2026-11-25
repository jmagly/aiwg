#!/usr/bin/env node
// Changed-code coverage gate for orchestration: thresholds apply to changed
// executable added/modified lines only, never whole files or repo-wide.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Pure config/resolver/admission validators first; a file matching both lists
// is a validator. CLI handlers and test/tooling files are out of scope.
export const VALIDATOR_PREFIXES = [
  'src/models/', 'src/config/', 'src/mission-protocol/', 'src/serve/shared-host-',
];
export const ADAPTER_PREFIXES = ['tools/ralph-external/', 'src/serve/', 'src/mcp/'];
export const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.mjs', '.js', '.cjs']);
export const VALIDATOR_THRESHOLDS = { statements: 90, branches: 85 };
export const ADAPTER_THRESHOLDS = { branches: 80 };
// Unit suites own validator/admission arithmetic and adapter/recovery behavior;
// conformance timing runs in its own lane and is out of this gate.
export const FOCUSED_TESTS = [
  'test/unit/serve/**/*.test.ts',
  'test/unit/models/**/*.test.ts',
  'test/unit/cli/doctor-factory-worker.test.ts',
  'test/unit/cli/handlers/models.test.ts',
  'test/unit/config/**/*.test.ts',
  'test/unit/mission-protocol/**/*.test.ts',
  'test/unit/mcp/**/*.test.ts',
  'test/unit/ralph-external/**/*.test.ts',
  'test/unit/ralph-external/**/*.test.mjs',
];
export const REPORT_PARENT = 'test-results/orchestration-changed-coverage';

export function classifyChangedFile(file) {
  const normalized = String(file).replace(/\\/g, '/').replace(/^\.\//, '');
  // Declarations have no executable lines; V8 cannot parse them as JavaScript.
  if (/\.d\.[cm]?ts$/.test(normalized)) return null;
  if (normalized.split('/').includes('..')) return null;
  if (![...SOURCE_EXTENSIONS].some(extension => normalized.endsWith(extension))) return null;
  if (/(^|\/)(test|tests|__tests__)\//.test(normalized)
    || /(^|\/)[^/]*\.(test|spec)\.[^/]+$/.test(normalized)) return null;
  if (VALIDATOR_PREFIXES.some(prefix => normalized.startsWith(prefix))) return 'validators';
  if (ADAPTER_PREFIXES.some(prefix => normalized.startsWith(prefix))) return 'adapters-recovery';
  return null;
}

export function splitChangedFiles(files) {
  const buckets = { validators: [], 'adapters-recovery': [], outOfScope: [] };
  for (const file of [...new Set(files)].sort()) {
    buckets[classifyChangedFile(file) ?? 'outOfScope'].push(file);
  }
  return buckets;
}

export function gitLines(args, cwd = root) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout ?? '').split('\n').map(line => line.trim()).filter(Boolean);
}

export function resolveMergeBase(runGit = gitLines, env = process.env) {
  if (env.ORCHESTRATION_COVERAGE_BASE?.trim()) return env.ORCHESTRATION_COVERAGE_BASE.trim();
  const head = runGit(['rev-parse', 'HEAD'])?.[0];
  for (const ref of ['origin/main', 'main', 'master']) {
    const base = runGit(['merge-base', 'HEAD', ref])?.[0];
    // On main itself the merge base is HEAD, which would diff to nothing.
    if (base && base !== head) return base;
  }
  // Post-merge CI on main: the change under test is HEAD against its first parent.
  return runGit(['rev-parse', '--verify', 'HEAD^1'])?.[0] ?? null;
}

export function listChangedFiles(base, runGit = gitLines) {
  const tracked = runGit(['diff', '--name-only', '--no-renames', base]);
  if (tracked === null) throw new Error(`cannot list changes against ${base}`);
  const untracked = runGit(['ls-files', '--others', '--exclude-standard']) ?? [];
  return [...new Set([...tracked, ...untracked].map(line => String(line).trim()).filter(Boolean))].sort();
}

export function bucketConfig(bucket, files) {
  return {
    thresholds: bucket === 'validators' ? VALIDATOR_THRESHOLDS : ADAPTER_THRESHOLDS,
    include: files,
    reportsDirectory: `${REPORT_PARENT}/${bucket}`,
  };
}

// Git hunk coordinates describe the new side; zero-length ranges are deletions.
export function parseChangedRanges(diff) {
  return String(diff).split('\n').flatMap(line => {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) return [];
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    return count ? [{ start, end: start + count - 1 }] : [];
  });
}

export function changedRanges(base, file, runGit = gitLines) {
  const diff = runGit(['diff', '--unified=0', '--no-renames', base, '--', file]);
  if (diff === null) throw new Error(`cannot diff ${file} against ${base}`);
  // Untracked files have no git diff. Newly tracked files have /dev/null headers.
  if (diff.includes('--- /dev/null') || (!diff.length
    && runGit(['cat-file', '-e', `${base}:${file}`]) === null)) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const count = source.split('\n').length - Number(source.endsWith('\n'));
    return count ? [{ start: 1, end: count }] : [];
  }
  return parseChangedRanges(diff.join('\n'));
}

function intersectingLines(location, ranges) {
  if (!location?.start || !location?.end) return [];
  const end = location.end.line - Number(location.end.column === 0
    && location.end.line > location.start.line);
  return ranges.flatMap(range => {
    const start = Math.max(range.start, location.start.line);
    const stop = Math.min(range.end, end);
    return Array.from({ length: Math.max(0, stop - start + 1) }, (_, i) => start + i);
  });
}

export function changedCoverage(coverage, ranges, thresholds) {
  const uncovered = new Set();
  const metrics = { statements: { covered: 0, total: 0 }, branches: { covered: 0, total: 0 } };
  const count = (metric, location, hits) => {
    const lines = intersectingLines(location, ranges);
    if (!lines.length) return;
    metrics[metric].total++;
    if (hits > 0) metrics[metric].covered++;
    else lines.forEach(line => uncovered.add(line));
  };
  for (const [id, location] of Object.entries(coverage.statementMap)) {
    count('statements', location, coverage.s[id]);
  }
  for (const [id, branch] of Object.entries(coverage.branchMap)) {
    // A changed decision owns every outcome, including Istanbul's implicit else
    // outcomes whose individual locations can be empty objects.
    for (const hits of coverage.b[id]) count('branches', branch.loc, hits);
  }
  for (const metric of Object.values(metrics)) {
    metric.percent = metric.total ? metric.covered / metric.total * 100 : 100;
  }
  return { ...metrics, passes: Object.entries(thresholds).every(([key, threshold]) =>
    metrics[key].percent >= threshold), uncoveredLines: [...uncovered].sort((a, b) => a - b) };
}

export function checkCoverageReport(report, files, rangesByFile, thresholds) {
  let failed = false;
  for (const file of files) {
    const ranges = rangesByFile.get(file);
    const coverage = report[path.join(root, file)] ?? report[file];
    if (ranges.length && !coverage) {
      console.error(`orchestration-changed-coverage: ${file}: missing coverage data`);
      failed = true;
      continue;
    }
    const result = changedCoverage(coverage ?? { statementMap: {}, s: {}, branchMap: {}, b: {} }, ranges, thresholds);
    const format = metric => `${metric.covered}/${metric.total} (${metric.percent.toFixed(2)}%)`;
    console.log(`orchestration-changed-coverage: ${file}: changed statements ${format(result.statements)}, branches ${format(result.branches)}: ${result.passes ? 'PASS' : 'FAIL'}`);
    if (!result.passes) {
      console.error(`orchestration-changed-coverage: ${file}: uncovered changed lines: ${result.uncoveredLines.join(', ')}`);
      failed = true;
    }
  }
  return Number(failed);
}

function runVitestBucket(bucket, files, rangesByFile) {
  const { thresholds, reportsDirectory } = bucketConfig(bucket, files);
  fs.mkdirSync(path.join(root, REPORT_PARENT), { recursive: true });
  const configPath = path.join(root, REPORT_PARENT, `${bucket}.config.mjs`);
  const reportPath = path.join(root, reportsDirectory, 'coverage-final.json');
  const casesPath = path.join(root, REPORT_PARENT, `${bucket}.tests.json`);
  for (const file of [reportPath, casesPath]) fs.rmSync(file, { force: true });
  fs.writeFileSync(configPath, `import base from ${JSON.stringify('../../config/vitest.config.js')};
export default { ...base, test: { ...base.test, include: ${JSON.stringify(FOCUSED_TESTS)},
  reporters: ['default', 'json'], outputFile: { json: ${JSON.stringify(casesPath)} },
  coverage: { enabled: true, provider: 'v8', include: ${JSON.stringify(files)},
    exclude: ['test/**'], reporter: ['text', 'json-summary', 'json'],
    reportsDirectory: ${JSON.stringify(reportsDirectory)} } } };
`);
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', configPath], {
    cwd: root, encoding: 'utf8', timeout: 600_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024,
  });
  for (const [stream, text] of [['stdout', result.stdout], ['stderr', result.stderr]]) {
    if (text) process[stream].write(text);
  }
  let failed = Number(Boolean(result.error || result.signal || result.status !== 0));
  try {
    const cases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
    if (!(cases.numTotalTests > 0 && cases.numPassedTests + cases.numFailedTests > 0)) {
      throw new Error('no executed test cases; coverage cannot pass without cases');
    }
    failed |= checkCoverageReport(JSON.parse(fs.readFileSync(reportPath, 'utf8')), files, rangesByFile, thresholds);
  } catch (error) {
    console.error(`orchestration-changed-coverage: ${bucket}: ${error.message}`);
    failed = 1;
  }
  console.log(`orchestration-changed-coverage: ${bucket} bucket ${failed ? 'failed' : 'passed'} (${files.length} changed files)`);
  return failed;
}

export function runGate({ base, runGit = gitLines, env = process.env } = {}) {
  const baseline = base ?? resolveMergeBase(runGit, env);
  if (!baseline) {
    // CI must never pass this gate vacuously (a shallow clone has no parent to diff against).
    if (env.CI) {
      console.error('orchestration-changed-coverage: no baseline ref available in CI; fetch at least the parent commit');
      return 1;
    }
    console.log('orchestration-changed-coverage: no baseline ref available; skipping changed-file gate');
    return 0;
  }
  let buckets;
  try { buckets = splitChangedFiles(listChangedFiles(baseline, runGit)); }
  catch (error) { console.error(`orchestration-changed-coverage: ${error.message}`); return 1; }
  const { validators, 'adapters-recovery': adapters, outOfScope } = buckets;
  console.log(`orchestration-changed-coverage: base ${baseline}, ${validators.length} validator, ${adapters.length} adapter/recovery, ${outOfScope.length} out-of-scope changed files`);
  if (!validators.length && !adapters.length) {
    console.log('orchestration-changed-coverage: no changed files in scope; skipped (0 executed cases)');
    return 0;
  }
  try {
    const ranges = new Map([...validators, ...adapters].map(file => [file, changedRanges(baseline, file, runGit)]));
    let failed = 0;
    for (const [bucket, files] of [['validators', validators], ['adapters-recovery', adapters]]) {
      if (!files.length) continue;
      if (files.every(file => !ranges.get(file).length)) {
        failed |= checkCoverageReport({}, files, ranges, bucketConfig(bucket, files).thresholds);
      } else failed |= runVitestBucket(bucket, files, ranges);
    }
    return failed;
  } catch (error) {
    console.error(`orchestration-changed-coverage: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const flag = process.argv.indexOf('--base');
  process.exitCode = runGate(flag >= 0 ? { base: process.argv[flag + 1] } : {});
}
