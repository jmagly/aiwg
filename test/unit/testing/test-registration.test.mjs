import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const checker = pathToFileURL(path.join(repo, 'tools/testing/check-test-registration.mjs')).href;
const roots = [];
const rootTopic = 'test/unit/testing/fixtures/example.test.ts';
const frameworkTopic = 'agentic/code/frameworks/example/test/unit/testing/fixtures/example.test.ts';
const baseline = 'test/unit/control.test.ts';
const vitestSource = "import { it } from 'vitest'; throw new Error('SOURCE_MUST_NOT_EXECUTE'); it('source-only fixture', () => {});\n";
const nodeSource = "import { test } from 'node:test'; throw new Error('SOURCE_MUST_NOT_EXECUTE'); test('source-only fixture', () => {});\n";

function project({ files = {}, include = ['test/unit/**/*.test.ts', 'agentic/code/frameworks/*/test/unit/**/*.test.ts'], nodeFiles = [], scripts, ci = 'npm run test', withBaseline = true, packages = {}, optIns = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-registration-gate-'));
  roots.push(root);
  const entries = {
    'package.json': JSON.stringify({ type: 'module', scripts: scripts ?? { test: 'vitest run --config config/vitest.config.js' } }),
    '.gitea/workflows/ci.yml': JSON.stringify({ jobs: { test: { steps: [{ run: ci }] } } }),
    'config/test-lanes.mjs': `export const nodeFiles = ${JSON.stringify(nodeFiles)};\nexport const optInPackageTests = ${JSON.stringify(optIns)};\n`,
    ...Object.fromEntries(Object.entries(packages).map(([dir, pkg]) => [`${dir}/package.json`, JSON.stringify(pkg)])),
    'config/vitest.config.js': `export default ${JSON.stringify({ test: { include, exclude: [] } })};\n`,
    ...(withBaseline ? { [baseline]: vitestSource } : {}),
    ...files,
  };
  for (const [name, body] of Object.entries(entries)) {
    const destination = path.join(root, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, body);
  }
  return root;
}

function run(root) {
  const script = `import { runRegistrationGate } from ${JSON.stringify(checker)}; await runRegistrationGate(${JSON.stringify(root)});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: root, encoding: 'utf8', timeout: 15_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  // An import/startup failure cannot satisfy a negative test: require a real
  // completed gate report before checking its exit and exact diagnostics.
  const report = JSON.parse(fs.readFileSync(path.join(root, 'test-results/test-registration.json'), 'utf8'));
  return { child, report };
}

function copyChecker(root) {
  const destination = path.join(root, 'tools/testing/check-test-registration.mjs');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(fileURLToPath(checker), destination);
  for (const name of ['check-script-lanes.mjs', 'workflow-commands.mjs', 'package-runner-ownership.mjs']) {
    fs.copyFileSync(path.join(repo, 'tools/testing', name), path.join(root, 'tools/testing', name));
  }
  expect(fs.readFileSync(destination)).toEqual(fs.readFileSync(fileURLToPath(checker)));
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  return destination;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('test runner registration gate', () => {
  it.each([['root', rootTopic], ['framework', frameworkTopic]])('includes %s unit suites with a fixtures topic directory', (_kind, file) => {
    const { child, report } = run(project({ files: { [file]: vitestSource } }));
    expect(child.status).toBe(0);
    expect(report.errors).toEqual([]);
    expect(report.totalFiles).toBe(2);
    expect(report.files).toContainEqual({ file, runner: 'vitest', lanes: [{ id: 'config/vitest.config.js', live: false }] });
  });

  it('keeps both real TestDataFactory suites in the repository report', () => {
    const script = `import { inspectTestRegistration } from ${JSON.stringify(checker)}; console.log(JSON.stringify(await inspectTestRegistration(${JSON.stringify(repo)})));`;
    const report = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: repo, encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
    }));
    for (const file of [
      'test/unit/testing/fixtures/test-data-factory.test.ts',
      'agentic/code/frameworks/sdlc-complete/test/unit/testing/fixtures/test-data-factory.test.ts',
    ]) {
      expect(report.files).toContainEqual({ file, runner: 'vitest', lanes: [{ id: 'config/vitest.config.js', live: false }] });
    }
    expect(report.units).toBe('Source files and imported APIs, not registered or executed cases');
  });

  it('assigns full-corpus provider deployments only to the required deployment lane', () => {
    const script = `import { inspectTestRegistration } from ${JSON.stringify(checker)}; console.log(JSON.stringify(await inspectTestRegistration(${JSON.stringify(repo)})));`;
    const report = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: repo, encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
    }));
    expect(report.errors).toEqual([]);
    for (const file of [
      'test/integration/use-all-deployment.test.ts',
      'test/integration/hermes-deployment.test.ts',
    ]) {
      expect(report.files.find(row => row.file === file)).toEqual({
        file,
        runner: 'vitest',
        lanes: [{ id: 'config/vitest.deployment.config.js', live: false }],
      });
    }
  });

  it('excludes only owned root and framework input-fixture trees', () => {
    const { child, report } = run(project({ files: {
      'test/fixtures/scenario/invalid.test.ts': 'deliberately invalid source',
      'agentic/code/frameworks/example/test/fixtures/scenario/invalid.test.ts': 'deliberately invalid source',
    } }));
    expect(child.status).toBe(0);
    expect(report.errors).toEqual([]);
    expect(report.files).toEqual([{ file: baseline, runner: 'vitest', lanes: [{ id: 'config/vitest.config.js', live: false }] }]);
    expect(report.totalFiles).toBe(1);
  });

  it.each([['root', rootTopic], ['framework', frameworkTopic]])('rejects a wrong-runner %s fixtures-topic suite', (_kind, file) => {
    const { child, report } = run(project({ files: { [file]: nodeSource } }));
    expect(child.status).toBe(1);
    expect(report.errors).toEqual([`${file}: node handed to vitest in config/vitest.config.js`]);
    expect(child.stderr).toContain(report.errors[0]);
    expect(report.files.find(row => row.file === file)?.runner).toBe('node');
  });

  it.each([['root', rootTopic], ['framework', frameworkTopic]])('rejects an unassigned %s fixtures-topic suite', (_kind, file) => {
    const { child, report } = run(project({ include: [baseline], files: { [file]: vitestSource } }));
    expect(child.status).toBe(1);
    expect(report.errors).toEqual([`${file}: unassigned test file`]);
    expect(report.files).toContainEqual({ file, runner: 'vitest', lanes: [] });
  });

  it('rejects unknown APIs even when a Vitest glob selects the file', () => {
    const file = 'test/unit/unknown.test.ts';
    const { child, report } = run(project({ files: { [file]: "export const notATest = true;\n" } }));
    expect(child.status).toBe(1);
    expect(report.errors).toEqual([
      `${file}: unknown test API; declare an explicit owning runner`,
      `${file}: unknown handed to vitest in config/vitest.config.js`,
    ]);
  });

  it.each([
    ['tool', 'tools/example/contract.test.mjs', nodeSource],
    ['addon', 'agentic/code/addons/example/test/contract.test.mjs', nodeSource],
    ['unsuffixed tool', 'tools/example/check.mjs', nodeSource],
    ['inline', 'src/example.ts', "if (import.meta.vitest) { const { it } = import.meta.vitest; it('inline', () => {}); }\n"],
  ])('rejects an unassigned %s suite outside the original census', (_kind, file, body) => {
    const { child, report } = run(project({ files: { [file]: body } }));
    expect(child.status).toBe(1);
    expect(report.errors).toEqual([`${file}: unassigned test file${_kind === 'addon' ? '; missing node lane' : ''}`]);
    expect(report.files.find(row => row.file === file)?.lanes).toEqual([]);
  });

  it('accepts a tool and addon only when their Node lane reaches CI', () => {
    const files = ['tools/eval/test/yaml.test.mjs', 'agentic/code/addons/example/test/bridge.test.mjs'];
    const { child, report } = run(project({
      nodeFiles: files, ci: `npm run test && node --test ${files.join(' ')}`,
      files: Object.fromEntries(files.map(file => [file, nodeSource])),
    }));
    expect(child.status).toBe(0);
    expect(report.errors).toEqual([]);
    for (const file of files) expect(report.files).toContainEqual({ file, runner: 'node', lanes: [{ id: 'node', live: false }] });
  });

  it('requires includeSource to own inline Vitest while ignoring source strings and templates', () => {
    const file = 'src/arithmetic.ts';
    const { child, report } = run(project({ files: {
      [file]: "if (import.meta.vitest) { const { it } = import.meta.vitest; it('inline', () => {}); }\n",
      'src/generator.ts': 'export const template = "import.meta.vitest";\n',
      'agentic/code/addons/example/templates/oracle.example.test.mjs': nodeSource,
      'config/vitest.config.js': `export default ${JSON.stringify({ test: { include: [baseline], includeSource: [file] } })};`,
    } }));
    expect(child.status).toBe(0);
    expect(report.errors).toEqual([]);
    expect(report.files.map(row => row.file)).toEqual([file, baseline]);
    expect(report.files[0].lanes).toEqual([{ id: 'config/vitest.config.js', live: false }]);
  });

  it.each(['deployment', 'wasm'])('rejects duplicate default/%s ownership using discovered files', lane => {
    const config = `config/vitest.${lane}.config.js`;
    const { child, report } = run(project({
      ci: `npm run test && vitest run --config ${config}`,
      files: { [config]: `export default ${JSON.stringify({ test: { include: [baseline] } })};` },
    }));
    expect(child.status).toBe(1);
    expect(report.errors).toEqual([`${baseline}: test has multiple owning lanes`]);
    expect(report.files[0].lanes.map(owner => owner.id)).toEqual(['config/vitest.config.js', config]);
  });

  it.each(['deployment', 'wasm', 'uat-live'])('rejects a configured %s lane discovering zero files', lane => {
    const config = `config/vitest.${lane}.config.js`;
    const { child, report } = run(project({
      ci: `npm run test && vitest run --config ${config}`,
      files: { [config]: `export default ${JSON.stringify({ test: { include: ['test/missing/**/*.test.ts'] } })};` },
    }));
    expect(child.status).toBe(1);
    expect(report.totalFiles).toBe(1);
    expect(report.errors).toEqual([`${config}: lane discovers zero files`]);
    expect(child.stderr.trim()).toBe(report.errors[0]);
  });

  it('rejects a reachable Node lane discovering zero files', () => {
    const pattern = 'tools/missing/*.test.mjs';
    const { child, report } = run(project({ nodeFiles: [pattern], ci: `npm run test && node --test ${pattern}` }));
    expect(child.status).toBe(1);
    expect(report.totalFiles).toBe(1);
    expect(report.errors).toEqual(['node: lane discovers zero files']);
  });

  it('rejects an empty test population', () => {
    const { child, report } = run(project({ withBaseline: false }));
    expect(child.status).toBe(1);
    expect(report.totalFiles).toBe(0);
    expect(report.files).toEqual([]);
    expect(report.errors).toEqual(['config/vitest.config.js: lane discovers zero files', 'No candidate test files found']);
  });

  it('rejects offline config absent from canonical CI', () => {
    const { child, report } = run(project({ ci: 'node --version' }));
    expect(child.status).toBe(1);
    expect(report.errors).toEqual(['Offline lane is not reachable from canonical CI: config/vitest.config.js']);
  });

  it('expands nested npm scripts and rejects a missing referenced script', () => {
    const { child, report } = run(project({ scripts: {
      test: 'npm run inner', inner: 'vitest run --config config/vitest.config.js && npm run missing',
    } }));
    expect(child.status).toBe(1);
    expect(report.errors).toEqual(['Canonical CI references missing npm script missing']);
  });

  it('rejects an unclassified Node CLI pattern in canonical CI', () => {
    const { child, report } = run(project({ ci: 'npm run test && node --test unexpected/*.test.mjs' }));
    expect(child.status).toBe(1);
    expect(report.errors).toEqual(['Unclassified Node CLI argument/pattern in canonical CI: unexpected/*.test.mjs']);
  });

  it('rejects a declared Node ownership pattern absent from canonical CI', () => {
    const { child, report } = run(project({ nodeFiles: ['test/unit/ralph/*.test.mjs'] }));
    expect(child.status).toBe(1);
    expect(report.errors).toEqual(['node: lane discovers zero files', 'Node ownership pattern is absent from canonical CI: test/unit/ralph/*.test.mjs']);
  });

  it('preserves Node runner and legacy file-harness ownership', () => {
    const { child, report } = run(project({
      nodeFiles: ['tools/ralph-external/*.test.mjs', 'test/unit/ralph/*.test.mjs'],
      ci: 'npm run test && node --test tools/ralph-external/*.test.mjs test/unit/ralph/*.test.mjs',
      files: {
        'tools/ralph-external/legacy.test.mjs': "import assert from 'node:assert/strict'; assert.equal(1, 1);\n",
        'test/unit/ralph/native.test.mjs': nodeSource,
      },
    }));
    expect(child.status).toBe(0);
    expect(report.errors).toEqual([]);
    expect(report.files).toEqual([
      { file: baseline, runner: 'vitest', lanes: [{ id: 'config/vitest.config.js', live: false }] },
      { file: 'test/unit/ralph/native.test.mjs', runner: 'node', lanes: [{ id: 'node', live: false }] },
      { file: 'tools/ralph-external/legacy.test.mjs', runner: 'node-file-harness', lanes: [{ id: 'node', live: false }] },
    ]);
  });

  it.each([['passing', 'npm run test', 0], ['failing', 'node --version', 1]])('runs the %s direct CLI against its module root instead of cwd', (_kind, ci, status) => {
    const root = project({ ci });
    const other = project({ files: { 'test/unit/decoy.test.ts': vitestSource } });
    const copy = copyChecker(root);
    const child = spawnSync(process.execPath, [copy], { cwd: other, encoding: 'utf8', timeout: 15_000 });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status).toBe(status);
    const output = path.join(root, 'test-results/test-registration.json');
    expect(fs.existsSync(output), 'direct CLI must create its module-root report').toBe(true);
    expect(fs.existsSync(path.join(other, 'test-results/test-registration.json')), 'cwd decoy must remain untouched').toBe(false);
    const report = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(report.totalFiles).toBe(1);
    expect(report.files).toEqual([{ file: baseline, runner: 'vitest', lanes: [{ id: 'config/vitest.config.js', live: false }] }]);
    expect(report.errors).toEqual(status === 0 ? [] : ['Offline lane is not reachable from canonical CI: config/vitest.config.js']);
    if (status === 0) {
      expect(child.stdout.trim()).toBe(`Runner ownership: 1 source files assigned; report ${path.join('test-results', 'test-registration.json')}`);
      expect(child.stderr).toBe('');
    } else {
      expect(child.stdout).toBe('');
      expect(child.stderr.trim()).toBe(report.errors[0]);
    }
  });

  it('imports from an ordinary script without automatic writes and inspects the default module root', () => {
    const root = project();
    const other = project({ files: { 'test/unit/decoy.test.ts': vitestSource } });
    const copy = copyChecker(root);
    const driver = path.join(other, 'import-driver.mjs');
    fs.writeFileSync(driver, `const { inspectTestRegistration } = await import(${JSON.stringify(pathToFileURL(copy).href)}); console.log(JSON.stringify(await inspectTestRegistration()));\n`);
    const child = spawnSync(process.execPath, [driver], { cwd: other, encoding: 'utf8', timeout: 15_000 });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status).toBe(0);
    expect(child.stderr).toBe('');
    expect(child.stdout).not.toContain('Runner ownership:');
    expect(fs.existsSync(path.join(root, 'test-results/test-registration.json')), 'ordinary import and inspect must not write a gate report').toBe(false);
    expect(fs.existsSync(path.join(other, 'test-results/test-registration.json'))).toBe(false);
    const report = JSON.parse(child.stdout);
    expect(report.totalFiles).toBe(1);
    expect(report.errors).toEqual([]);
    expect(report.files).toEqual([{ file: baseline, runner: 'vitest', lanes: [{ id: 'config/vitest.config.js', live: false }] }]);
  });

  it.each([['jobs', {}], ['steps', { jobs: { test: {} } }]])('fails closed with a completed report when workflow %s are absent', (_kind, workflow) => {
    const root = project({ files: { '.gitea/workflows/ci.yml': JSON.stringify(workflow) } });
    const { child, report } = run(root);
    expect(child.status).toBe(1);
    expect(report.totalFiles).toBe(1);
    expect(report.files).toEqual([{ file: baseline, runner: 'vitest', lanes: [{ id: 'config/vitest.config.js', live: false }] }]);
    expect(report.errors).toEqual(['Offline lane is not reachable from canonical CI: config/vitest.config.js']);
    expect(child.stderr.trim()).toBe(report.errors[0]);
  });
  it.each(['valid', 'unreachable', 'missing-script', 'duplicate'])('enforces explicit release ownership (%s)', mode => {
    const releaseConfig = 'config/vitest.release-slow.config.js';
    const file = 'test/integration/release.test.ts';
    const { child, report } = run(project({
      scripts: {
        test: 'vitest run --config config/vitest.config.js',
        ...(mode === 'missing-script' ? {} : { 'test:release-slow': `vitest run --config ${releaseConfig}` }),
      },
      files: {
        'config/test-lanes.mjs': `export const nodeFiles = []; export const releaseLaneWorkflows = ${JSON.stringify({ [releaseConfig]: '.gitea/workflows/release-slow.yml' })}; export const scriptLaneExemptions = ${JSON.stringify(mode === 'missing-script' ? [] : [{ script: 'test:release-slow', owner: 'release-maintainers', kind: 'release-only', reason: 'Manual release matrix.' }])};`,
        [releaseConfig]: `export default ${JSON.stringify({ test: { include: [file] } })};`,
        '.gitea/workflows/release-slow.yml': JSON.stringify({ jobs: { release: { steps: [{ run: mode === 'unreachable' ? 'node --version' : 'npm run test:release-slow' }] } } }),
        ...(mode === 'duplicate' ? { 'config/vitest.config.js': `export default ${JSON.stringify({ test: { include: [baseline, file] } })};` } : {}),
        [file]: vitestSource,
      },
    }));
    expect(child.status).toBe(mode === 'valid' ? 0 : 1);
    expect(report.errors).toEqual(mode === 'valid' ? []
      : mode === 'duplicate' ? [`${file}: release test has multiple owning lanes`]
        : mode === 'missing-script' ? ['Release workflow references missing npm script test:release-slow', `Release lane is not reachable from its workflow: ${releaseConfig}`]
          : [`Release lane is not reachable from its workflow: ${releaseConfig}`]);
    if (mode === 'valid') expect(report.files.find(row => row.file === file).lanes).toEqual([{ id: releaseConfig, live: false }]);
  });


  it('enforces unwired and stale script exemptions through the registration CLI', () => {
    const root = project({ scripts: { test: 'vitest run --config config/vitest.config.js', 'lint:unwired': 'node lint.mjs' } });
    const unwiredResult = run(root);
    expect(unwiredResult.child.status).toBe(1);
    expect(unwiredResult.report.errors).toEqual(['Script has no main CI lane or exemption: lint:unwired']);
    const stale = project({ files: {
      'config/test-lanes.mjs': `export const nodeFiles = []; export const scriptLaneExemptions = [{ script: 'lint:gone', owner: 'testing-maintainers', kind: 'manual', reason: 'Deleted script.' }];`,
    } });
    const staleResult = run(stale);
    expect(staleResult.child.status).toBe(1);
    expect(staleResult.report.errors).toEqual(['Stale script exemption: lint:gone']);
  });
  it('rejects a workspace package test script invoked by no CI job', () => {
    const { child, report } = run(project({
      packages: { 'apps/widget': { name: '@scope/widget', scripts: { test: 'node --test test/*.test.mjs' } } },
    }));
    expect(child.status).toBe(1);
    expect(report.errors).toEqual(['Workspace package test has no invoking CI job: @scope/widget test']);
    expect(child.stderr).toContain(report.errors[0]);
  });

  it('accepts a workspace package test script invoked by a CI job', () => {
    const { child, report } = run(project({
      ci: 'npm run test && npm --prefix apps/widget run test',
      packages: { 'apps/widget': { name: '@scope/widget', scripts: { test: 'node --test test/*.test.mjs', 'test:web': 'vitest run' } } },
    }));
    // Only `test` is CI-invoked; `test:web` stays unowned without an opt-in.
    expect(child.status).toBe(1);
    expect(report.errors).toEqual(['Workspace package test has no invoking CI job: @scope/widget test:web']);
  });

  it('accepts a reasoned opt-in alongside a CI-owned workspace package script', () => {
    const { child, report } = run(project({
      ci: 'npm run test && npm --prefix apps/widget run test',
      packages: { 'apps/widget': { name: '@scope/widget', scripts: { test: 'node --test test/*.test.mjs', 'test:web': 'vitest run' } } },
      optIns: [{ package: '@scope/widget', script: 'test:web', reason: 'Manual browser-only lane; no headless runner in CI.' }],
    }));
    expect(child.status).toBe(0);
    expect(report.errors).toEqual([]);
  });

  it.each([
    ['reasonless', { reason: '  ' }, 'Opt-in package test has no reason: @scope/widget test'],
    ['unknown package', { package: '@scope/gone', script: 'test', reason: 'Stale entry.' }, 'Opt-in package test references unknown package: @scope/gone test'],
    ['missing script', { package: '@scope/widget', script: 'test:gone', reason: 'Stale entry.' }, 'Opt-in package test references missing script: @scope/widget test:gone'],
    ['redundant', { package: '@scope/widget', script: 'test', reason: 'Stale entry.' }, 'Opt-in package test is owned by CI; remove it: @scope/widget test'],
  ])('rejects a %s opt-in package test entry', (_kind, optIn, error) => {
    const { child, report } = run(project({
      ci: 'npm run test && npm --prefix apps/widget run test',
      packages: { 'apps/widget': { name: '@scope/widget', scripts: { test: 'node --test test/*.test.mjs' } } },
      optIns: [{ package: '@scope/widget', script: 'test', reason: 'Stale entry.', ...optIn }],
    }));
    expect(child.status).toBe(1);
    expect(report.errors).toContain(error);
  });

});
