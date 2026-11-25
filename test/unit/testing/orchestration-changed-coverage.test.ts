import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ADAPTER_THRESHOLDS, bucketConfig, classifyChangedFile, listChangedFiles,
  resolveMergeBase, runGate, splitChangedFiles, VALIDATOR_THRESHOLDS,
  changedCoverage, changedRanges, parseChangedRanges,
} from '../../../tools/testing/orchestration-changed-coverage.mjs';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

// Exercise the entry point with synthetic Git diffs and coverage-final.json.
function syntheticGate(diff: string[], hits: number[], options: {
  branchHits?: number[]; newFile?: boolean; untracked?: boolean; omitReport?: boolean;
  totalCases?: number; executedCases?: number; omitCases?: boolean; outOfScope?: boolean;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'diff-coverage-')); directories.push(dir);
  for (const folder of ['tools/testing', 'config', 'src/config', 'node_modules/vitest']) {
    mkdirSync(join(dir, folder), { recursive: true });
  }
  const helper = join(dir, 'tools/testing/orchestration-changed-coverage.mjs');
  copyFileSync(fileURLToPath(new URL('../../../tools/testing/orchestration-changed-coverage.mjs', import.meta.url)), helper);
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(join(dir, 'config/vitest.config.js'), 'export default { test: {} };');
  writeFileSync(join(dir, 'src/config/example.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  const location = (line: number) => ({ start: { line, column: 0 }, end: { line, column: 12 } });
  const coverage = {
    statementMap: Object.fromEntries(hits.map((_, i) => [i, location(i + 1)])),
    s: Object.fromEntries(hits.map((hit, i) => [i, hit])),
    branchMap: Object.fromEntries((options.branchHits ?? []).map((_, i) => [i, { loc: location(i + 1), locations: [location(i + 1)] }])),
    b: Object.fromEntries((options.branchHits ?? []).map((hit, i) => [i, [hit]])),
  };
  writeFileSync(join(dir, 'node_modules/vitest/vitest.mjs'), `
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { pathToFileURL } from 'node:url';
    const { default: config } = await import(pathToFileURL(process.argv[process.argv.indexOf('--config') + 1]));
    mkdirSync(config.test.coverage.reportsDirectory, { recursive: true });
    if (!${Boolean(options.omitCases)}) writeFileSync(config.test.outputFile.json, JSON.stringify({
      numTotalTests: ${options.totalCases ?? 1}, numPassedTests: ${options.executedCases ?? 1}, numFailedTests: 0
    }));
    if (!${Boolean(options.omitReport)}) writeFileSync(config.test.coverage.reportsDirectory + '/coverage-final.json',
      JSON.stringify({ 'src/config/example.ts': ${JSON.stringify(coverage)} }));
  `);
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { runGate } = await import(process.argv[1]);
    process.exitCode = runGate({ base: 'base', runGit: args => {
      if (args.includes('--unified=0')) return ${JSON.stringify(diff)};
      if (args[0] === 'cat-file') return ${options.newFile || options.untracked ? 'null' : '[]'};
      if (args[0] === 'ls-files') return ${options.untracked ? "['src/config/example.ts']" : '[]'};
      return ${options.outOfScope ? "['README.md']" : options.untracked ? '[]' : "['src/config/example.ts']"};
    } });
  `, pathToFileURL(helper).href], { cwd: dir, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
}

describe('T-OG-05/06 orchestration changed-code coverage helper', () => {
  it('classifies validators, adapters/recovery and out-of-scope files', () => {
    for (const file of ['src/models/resolver.ts', 'src/config/aiwg-config.ts',
      'src/mission-protocol/codecs.ts', 'src/serve/shared-host-scheduler.ts',
      'src/serve/shared-host-admission-checks.ts']) expect(classifyChangedFile(file)).toBe('validators');
    for (const file of ['tools/ralph-external/session-launcher.mjs',
      'src/serve/fleet-mission-conductor.ts', 'src/mcp/stdio-lifecycle.ts']) {
      expect(classifyChangedFile(file)).toBe('adapters-recovery');
    }
    for (const file of ['test/unit/serve/shared-host-scheduler.test.ts', 'test/fixtures/ralph-stub-cli.mjs',
      'docs/contracts/shared-host-admission.v1.md', 'src/cli/handlers/models.ts',
      'tools/testing/orchestration-changed-coverage.mjs', 'test/conformance/orchestration-v1/packs.json',
      '../outside/repo.ts']) expect(classifyChangedFile(file)).toBeNull();
  });

  it('excludes declaration-only types while keeping every runtime extension in scope', () => {
    for (const extension of ['d.ts', 'd.mts', 'd.cts']) expect(classifyChangedFile(`src/config/resources.${extension}`)).toBeNull();
    for (const extension of ['ts', 'mts', 'mjs', 'js', 'cjs']) expect(classifyChangedFile(`src/config/resources.${extension}`)).toBe('validators');
    expect(VALIDATOR_THRESHOLDS).toEqual({ statements: 90, branches: 85 });
  });

  it('prefers validators when a file matches both scopes', () => {
    expect(classifyChangedFile('src/serve/shared-host-starvation.ts')).toBe('validators');
  });

  it('splits, dedupes and sorts changed files by bucket', () => {
    expect(splitChangedFiles(['src/mcp/a.ts', 'src/models/b.ts', 'src/models/b.ts', 'README.md'])).toEqual({
      validators: ['src/models/b.ts'],
      'adapters-recovery': ['src/mcp/a.ts'],
      outOfScope: ['README.md'],
    });
  });

  it('resolves the merge base from the environment, refs, or parent commit', () => {
    const calls: string[][] = [];
    const runGit = (args: string[]) => {
      calls.push(args);
      if (args[0] === 'merge-base') return args[2] === 'main' ? ['abc123'] : null;
      return ['parent1'];
    };
    expect(resolveMergeBase(runGit, {})).toBe('abc123');
    expect(resolveMergeBase(runGit, { ORCHESTRATION_COVERAGE_BASE: ' custom ' })).toBe('custom');
    expect(calls.some(args => args[0] === 'merge-base')).toBe(true);
    expect(resolveMergeBase(() => null, {})).toBeNull();
  });

  it('diffs main against its first parent when the merge base is HEAD itself', () => {
    const runGit = (args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ['head1'];
      if (args[0] === 'merge-base') return ['head1'];
      if (args.includes('HEAD^1')) return ['parent1'];
      return null;
    };
    expect(resolveMergeBase(runGit, {})).toBe('parent1');
  });

  it('fails closed in CI when no baseline resolves, and skips locally', () => {
    expect(runGate({ runGit: () => null, env: { CI: 'true' } })).toBe(1);
    expect(runGate({ runGit: () => null, env: {} })).toBe(0);
  });

  it('unions tracked and untracked changes without blanks', () => {
    const runGit = (args: string[]) => {
      if (args[0] === 'diff') return ['src/models/a.ts', '', 'src/models/b.ts'];
      return ['src/models/b.ts', 'tools/ralph-external/new.mjs'];
    };
    expect(listChangedFiles('base', runGit)).toEqual(
      ['src/models/a.ts', 'src/models/b.ts', 'tools/ralph-external/new.mjs']);
  });

  it('selects the reviewed thresholds and report directory per bucket', () => {
    expect(bucketConfig('validators', ['src/models/a.ts'])).toEqual({
      thresholds: VALIDATOR_THRESHOLDS, include: ['src/models/a.ts'],
      reportsDirectory: 'test-results/orchestration-changed-coverage/validators',
    });
    expect(VALIDATOR_THRESHOLDS).toEqual({ statements: 90, branches: 85 });
    expect(ADAPTER_THRESHOLDS).toEqual({ branches: 80 });
    expect(bucketConfig('adapters-recovery', ['src/mcp/a.ts']).thresholds).toBe(ADAPTER_THRESHOLDS);
  });

  it('generates coverage configs excluding test/** even when fixture paths match the source include', () => {
    const dir = mkdtempSync(join(tmpdir(), 'changed-coverage-config-')); directories.push(dir);
    for (const folder of ['tools/testing', 'config', 'node_modules/vitest']) {
      mkdirSync(join(dir, folder), { recursive: true });
    }
    const helper = join(dir, 'tools/testing/orchestration-changed-coverage.mjs');
    copyFileSync(fileURLToPath(new URL('../../../tools/testing/orchestration-changed-coverage.mjs', import.meta.url)), helper);
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    writeFileSync(join(dir, 'config/vitest.config.js'), 'export default { test: {} };');
    // A fake local runner reads the actual generated module; no nested Vitest process.
    writeFileSync(join(dir, 'node_modules/vitest/vitest.mjs'), `
      import { pathToFileURL } from 'node:url';
      const { default: config } = await import(pathToFileURL(process.argv[process.argv.indexOf('--config') + 1]));
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(config.test.coverage.reportsDirectory, { recursive: true });
      writeFileSync(config.test.outputFile.json, JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0 }));
      writeFileSync(config.test.coverage.reportsDirectory + '/coverage-final.json', JSON.stringify(
        Object.fromEntries(config.test.coverage.include.map(file => [file, {
          statementMap: { 0: { start: { line: 2, column: 0 }, end: { line: 2, column: 12 } } },
          s: { 0: 1 }, branchMap: {}, b: {}
        }]))));
      console.log('CONFIG=' + JSON.stringify(config.test.coverage));
      console.log('SUITES=' + JSON.stringify(config.test.include));
    `);
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { runGate } = await import(process.argv[1]);
      process.exitCode = runGate({ base: 'synthetic-base', runGit: args => {
        if (args.includes('--unified=0')) return ['@@ -2 +2 @@'];
        return ['src/config/worker-context.ts', 'tools/ralph-external/lib/worker-context.mjs'];
      } });
    `, pathToFileURL(helper).href], { cwd: dir, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
    expect(result.status, result.stderr).toBe(0);
    const configs = result.stdout.split('\n').filter(line => line.startsWith('CONFIG='))
      .map(line => JSON.parse(line.slice('CONFIG='.length)));
    expect(configs).toHaveLength(2);
    expect(configs.map(config => config.include)).toEqual([
      ['src/config/worker-context.ts'], ['tools/ralph-external/lib/worker-context.mjs'],
    ]);
    for (const config of configs) {
      expect(config.exclude).toEqual(['test/**']);
      expect(config.reporter).toEqual(['text', 'json-summary', 'json']);
      expect(config.thresholds).toBeUndefined();
    }
    const suites = result.stdout.split('\n').filter(line => line.startsWith('SUITES='))
      .map(line => JSON.parse(line.slice('SUITES='.length)));
    for (const include of suites) {
      expect(include).toContain('test/unit/ralph-external/**/*.test.mjs');
      expect(include).toContain('test/unit/cli/doctor-factory-worker.test.ts');
      expect(include).toContain('test/unit/cli/handlers/models.test.ts');
    }
  });

  it('passes covered changed lines while unchanged statements and branch arms are uncovered', () => {
    const result = syntheticGate(['@@ -1 +1 @@'], [1, 0, 0], { branchHits: [1, 0, 0] });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('changed statements 1/1 (100.00%), branches 1/1 (100.00%): PASS');
  });

  it('fails a changed uncovered statement and names its changed line', () => {
    const result = syntheticGate(['@@ -2 +2 @@'], [1, 0, 1]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/config/example.ts: uncovered changed lines: 2');
  });

  it('fails a changed uncovered branch independently of statement coverage', () => {
    const result = syntheticGate(['@@ -2 +2 @@'], [1, 1, 1], { branchHits: [1, 0, 1] });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('changed statements 1/1 (100.00%), branches 0/1 (0.00%): FAIL');
    expect(result.stderr).toContain('uncovered changed lines: 2');
  });

  it('counts all executable lines in a new file, including untracked files', () => {
    for (const untracked of [false, true]) {
      const result = syntheticGate(untracked ? [] : ['--- /dev/null', '@@ -0,0 +1,3 @@'],
        [1, 0, 1], { newFile: true, untracked });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('changed statements 2/3 (66.67%)');
      expect(result.stderr).toContain('uncovered changed lines: 2');
    }
  });

  it('passes deletion-only changes without running coverage', () => {
    const result = syntheticGate(['@@ -2,2 +1,0 @@'], [], { omitReport: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('changed statements 0/0 (100.00%), branches 0/0 (100.00%): PASS');
  });

  it('passes changes with no executable statements or branches', () => {
    const result = syntheticGate(['@@ -1 +1 @@'], []);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('changed statements 0/0 (100.00%), branches 0/0 (100.00%): PASS');
  });

  it.each([
    { totalCases: 0, executedCases: 0 },
    { totalCases: 3, executedCases: 0 },
  ])('rejects a successful runner with zero executed cases (%j)', options => {
    const result = syntheticGate(['@@ -1 +1 @@'], [1], options);
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no executed test cases');
    expect(result.stdout).not.toContain(': PASS');
  });

  it('requires a fresh executed-case report even with covered changed code', () => {
    const result = syntheticGate(['@@ -1 +1 @@'], [1], { omitCases: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('validators.tests.json');
  });

  it('reports no in-scope changes as skipped without claiming cases passed', () => {
    const result = syntheticGate([], [], { outOfScope: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('skipped (0 executed cases)');
    expect(result.stdout).not.toMatch(/\bpass(?:es|ed)?\b/i);
  });

  it.each([
    ['@@ -8 +2,2 @@', [1, 1, 0], '1/2 (50.00%)', 3],
    ['@@ -8 +2 @@', [0, 1, 0], '1/1 (100.00%)', null],
  ])('measures exactly the inclusive new-side boundary of %s', (hunk, hits, metric, missed) => {
    const result = syntheticGate([hunk], hits);
    expect(result.status, result.stderr).toBe(missed ? 1 : 0);
    expect(result.stdout).toContain(`changed statements ${metric}`);
    if (missed) expect(result.stderr).toContain(`uncovered changed lines: ${missed}`);
  });

  it('fails closed when the coverage reporter does not produce its report', () => {
    const result = syntheticGate(['@@ -1 +1 @@'], [1], { omitReport: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('coverage-final.json');
  });

  it('parses multiple hunks using only new-side added and modified ranges', () => {
    expect(parseChangedRanges('@@ -1 +1,2 @@\n+added\n@@ -5,2 +6,0 @@\n@@ -9 +10 @@ suffix'))
      .toEqual([{ start: 1, end: 2 }, { start: 10, end: 10 }]);
  });

  it('intersects multiline spans, respects exclusive end lines, and applies exact thresholds', () => {
    const statementMap = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i, {
      start: { line: 1, column: 0 }, end: { line: 4, column: 0 },
    }]));
    const coverage = { statementMap, s: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i, i])),
      branchMap: {}, b: {} };
    expect(changedCoverage(coverage, [{ start: 3, end: 3 }], VALIDATOR_THRESHOLDS))
      .toMatchObject({ statements: { covered: 9, total: 10, percent: 90 }, passes: true });
    expect(changedCoverage(coverage, [{ start: 4, end: 4 }], VALIDATOR_THRESHOLDS))
      .toMatchObject({ statements: { total: 0 }, passes: true });
  });

  it('counts all outcomes of a changed branch, including implicit else locations', () => {
    const location = { start: { line: 2, column: 0 }, end: { line: 3, column: 12 } };
    const result = changedCoverage({ statementMap: {}, s: {},
      branchMap: { 0: { loc: location, locations: [location, { start: {}, end: {} }] } }, b: { 0: [1, 0] },
    }, [{ start: 2, end: 2 }], ADAPTER_THRESHOLDS);
    expect(result).toMatchObject({ branches: { covered: 1, total: 2, percent: 50 },
      passes: false, uncoveredLines: [2] });
  });

  it('fails closed for an invalid explicit baseline', () => {
    expect(runGate({ base: 'missing', runGit: () => null, env: { CI: 'true' } })).toBe(1);
  });

  it('lists real working-tree changes from a disposable git repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'changed-coverage-helper-')); directories.push(dir);
    const git = (args: string[]) => {
      const result = spawnSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test',
        '-c', 'init.defaultBranch=main', ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      return result;
    };
    git(['init', '-q']);
    mkdirSync(join(dir, 'src/config'), { recursive: true });
    writeFileSync(join(dir, 'src/config/original.ts'), 'first\nsecond\nthird\n');
    writeFileSync(join(dir, 'tracked.txt'), 'base\n');
    git(['add', '.']);
    // Snapshot the index as a baseline tree without creating a commit.
    const base = git(['write-tree']).stdout.trim();
    const runGit = (args: string[]) => {
      const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
      if (result.status !== 0) return null;
      return String(result.stdout ?? '').split('\n').map(line => line.trim()).filter(Boolean);
    };
    writeFileSync(join(dir, 'tracked.txt'), 'changed\n');
    writeFileSync(join(dir, 'added.ts'), 'export const added = 1;\n');
    expect(listChangedFiles(base, runGit)).toEqual(['added.ts', 'tracked.txt']);
    // Root-independent diff measurement: modified files own only their new-side hunk.
    writeFileSync(join(dir, 'src/config/original.ts'), 'first\nchanged\nthird\n');
    expect(changedRanges(base, 'src/config/original.ts', runGit)).toEqual([{ start: 2, end: 2 }]);
    renameSync(join(dir, 'src/config/original.ts'), join(dir, 'src/config/renamed.ts'));
    // Stage a rename to exercise Git's rename heuristics; --no-renames must expose
    // the destination as a whole new file, even when only one line differs.
    git(['add', '-A']);
    expect(listChangedFiles(base, runGit)).toEqual([
      'added.ts', 'src/config/original.ts', 'src/config/renamed.ts', 'tracked.txt',
    ]);
    const diff = runGit(['diff', '--unified=0', '--no-renames', base, '--', 'src/config/renamed.ts'])!;
    expect(diff).toContain('--- /dev/null');
    // Use the real diff through the synthetic entrypoint (its new-file fallback
    // reads its own disposable source tree, never the repository source).
    const result = syntheticGate(diff, [1, 0, 1], { newFile: true });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('changed statements 2/3 (66.67%)');
    expect(result.stderr).toContain('uncovered changed lines: 2');
  });
});
