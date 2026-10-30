// Exercise nested runner ownership with inert source trees and real gate reports.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const checker = pathToFileURL(path.join(repo, 'tools/testing/check-test-registration.mjs')).href;
const roots = [];
const vitestSource = "import { it } from 'vitest'; throw new Error('MUST_NOT_EXECUTE'); it('fixture', () => {});";
const nodeSource = "const { test } = require('node:test'); throw new Error('MUST_NOT_EXECUTE'); test('fixture', () => {});";
const extensionSource = "import * as assert from 'node:assert'; suite('extension', () => { test('works', () => assert.ok(true)); });";

function project({ files = {}, lanes = [], unavailable = {}, unavailableFiles = {}, ci = 'npm test', packages = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-nested-registration-'));
  roots.push(root);
  const entries = {
    'package.json': JSON.stringify({ type: 'module', scripts: { test: 'vitest run --config config/vitest.config.js' } }),
    'config/vitest.config.js': "export default { test: { include: ['test/control.test.ts'] } };",
    'config/test-lanes.mjs': `export const nodeFiles = []; export const packageRunnerLanes = ${JSON.stringify(lanes)}; export const unavailableLanes = ${JSON.stringify(unavailable)}; export const unavailableTestFiles = ${JSON.stringify(unavailableFiles)};`,
    '.gitea/workflows/ci.yml': JSON.stringify({ jobs: { tests: { steps: [{ run: ci }] } } }),
    'test/control.test.ts': vitestSource,
    ...Object.fromEntries(Object.entries(packages).map(([dir, pkg]) => [`${dir}/package.json`, JSON.stringify(pkg)])),
    ...files,
  };
  for (const [name, body] of Object.entries(entries)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), body);
  }
  return root;
}

function run(root) {
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval',
    `import { runRegistrationGate } from ${JSON.stringify(checker)}; await runRegistrationGate(${JSON.stringify(root)});`],
  { cwd: root, encoding: 'utf8', timeout: 15_000 });
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  const report = JSON.parse(fs.readFileSync(path.join(root, 'test-results/test-registration.json'), 'utf8'));
  return { child, report };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('nested runner ownership', () => {
  it.each([
    ['packages/widget/test/deep/probe.cjs', nodeSource, 'node'],
    ['apps/shell/web/src/inline.ts', 'if (import.meta.vitest) { const { it } = import.meta.vitest; it("inline", () => {}); }', 'vitest'],
    ['vscode-extension/test/suite/extension.test.ts', extensionSource, 'mocha'],
    ['agentic/code/addons/example/test/probe.cjs', nodeSource, 'node'],
  ])('rejects uncovered source %s with its missing runner lane', (file, body, runner) => {
    const { child, report } = run(project({ files: { [file]: body } }));
    expect(child.status).toBe(1);
    expect(report.errors).toContain(`${file}: unassigned test file; missing ${runner} lane`);
    expect(report.files).toContainEqual({ file, runner, lanes: [] });
  });

  it.each(['test/fixtures/python/test_probe.py', 'packages/python/tests/probe_test.py'])('requires ownership or a reason for %s', file => {
    const files = { [file]: "raise RuntimeError('MUST_NOT_EXECUTE')\ndef test_probe():\n    assert True\n" };
    const missing = run(project({ files }));
    expect(missing.child.status).toBe(1);
    expect(missing.report.errors).toContainEqual(expect.stringContaining(`${file}: unassigned test file`));
    expect(missing.report.files).toContainEqual({ file, runner: 'pytest', lanes: [] });
    const reason = 'No pytest job provisions this fixture in CI.';
    const reasoned = run(project({ files, unavailableFiles: { [file]: reason } }));
    expect(reasoned.child.status).toBe(0);
    expect(reasoned.report.errors).toEqual([]);
    expect(reasoned.report.files).toContainEqual({ file, runner: 'pytest', lanes: [], unavailableReason: reason });
  });

  it.each([undefined, '', '  ', 42])('rejects an invalid unavailable test reason %s', reason => {
    const file = 'test/fixtures/python/test_probe.py';
    const { child, report } = run(project({ files: { [file]: 'def test_probe(): pass' }, unavailableFiles: { [file]: reason } }));
    expect(child.status).toBe(1);
    expect(report.errors).toContainEqual(expect.stringContaining(`${file}: unassigned test file`));
    if (reason !== undefined) expect(report.errors).toContain(`Unavailable test requires a reason: ${file}`);
  });

  it('rejects stale unavailable test entries', () => {
    const { child, report } = run(project({ unavailableFiles: { 'test/gone_test.py': 'Removed fixture.' } }));
    expect(child.status).toBe(1);
    expect(report.errors).toContain('Unavailable test entry references undiscovered file: test/gone_test.py');
  });

  it.each([false, true])('accepts a CI-owned pytest package lane and rejects a redundant file disposition (%s)', redundant => {
    const file = 'packages/python/tests/probe_test.py';
    const { child, report } = run(project({
      files: { [file]: 'def test_probe(): pass' },
      packages: { 'packages/python': { name: 'python', scripts: { test: 'python3 -m pytest tests' } } },
      lanes: [{ id: 'python', runner: 'pytest', package: 'packages/python', script: 'test', files: ['tests/*_test.py'] }],
      ci: 'npm test && npm --prefix packages/python test',
      unavailableFiles: redundant ? { [file]: 'Stale reason.' } : {},
    }));
    expect(child.status).toBe(redundant ? 1 : 0);
    expect(report.errors).toEqual(redundant ? [`Assigned test is listed as unavailable; remove it: ${file}`] : []);
    expect(report.files).toContainEqual(expect.objectContaining({ file, runner: 'pytest', lanes: [{ id: 'python', live: false }] }));
  });

  const webLane = { id: 'widget-web', runner: 'vitest', package: 'apps/widget/web', script: 'test', files: ['src/**/*.test.ts'] };
  const webPackages = {
    'apps/widget': { name: '@fixture/widget', scripts: { 'test:web': 'npm --prefix web test' } },
    'apps/widget/web': { name: '@fixture/web', scripts: { test: 'vitest run' } },
  };

  it('records covered nested tests through recursive package-script reachability', () => {
    const file = 'apps/widget/web/src/covered.test.ts';
    const { child, report } = run(project({ lanes: [webLane], packages: webPackages,
      ci: 'npm test && npm --prefix apps/widget run test:web', files: { [file]: vitestSource } }));
    expect(child.status).toBe(0);
    expect(report.errors).toEqual([]);
    expect(report.files).toContainEqual({ file, runner: 'vitest', lanes: [{ id: 'widget-web', live: false }] });
  });

  it('rejects a CI-reachable package lane listed as unavailable', () => {
    const { child, report } = run(project({ lanes: [webLane], packages: webPackages,
      ci: 'npm test && npm --prefix apps/widget run test:web',
      unavailable: { 'widget-web': 'Stale unavailable reason.' },
      files: { 'apps/widget/web/src/covered.test.ts': vitestSource } }));
    expect(child.status).toBe(1);
    expect(report.errors).toEqual(['CI-owned package lane is listed as unavailable; remove it: widget-web']);
  });

  it('requires a reason even when an unavailable root lane is named live', () => {
    const config = 'config/vitest.account-live.config.js';
    const { child, report } = run(project({ files: {
      [config]: "export default { test: { include: ['test/account.test.ts'] } };",
      'test/account.test.ts': vitestSource,
    } }));
    expect(child.status).toBe(1);
    expect(report.errors).toContain(`Unavailable lane requires a reason in config/test-lanes.mjs: ${config}`);
  });

  it('reports the explicit reason for an unavailable extension lane', () => {
    const file = 'vscode-extension/test/suite/extension.test.ts';
    const lane = { id: 'extension-host', runner: 'mocha', package: 'vscode-extension', script: 'test', files: ['test/**/*.test.ts'] };
    const reason = 'Requires Electron and xvfb; unavailable on the default CI image.';
    const { child, report } = run(project({ lanes: [lane], unavailable: { 'extension-host': reason },
      packages: { 'vscode-extension': { name: 'extension', scripts: { test: 'node test/runTests.js' } } },
      files: { [file]: extensionSource } }));
    expect(child.status).toBe(0);
    expect(report.errors).toEqual([]);
    expect(report.files).toContainEqual({ file, runner: 'mocha', lanes: [{ id: 'extension-host', live: true }] });
    expect(report.unavailableLanes).toContainEqual({ id: 'extension-host', reason, files: [file] });
  });

  it.each([undefined, '', '  ', 42])('rejects an unavailable extension lane reason %s', reason => {
    const lane = { id: 'extension-host', runner: 'mocha', package: 'vscode-extension', script: 'test', files: ['test/**/*.test.ts'] };
    const { child, report } = run(project({ lanes: [lane], unavailable: { 'extension-host': reason },
      packages: { 'vscode-extension': { name: 'extension', scripts: { test: 'node test/runTests.js' } } },
      files: { 'vscode-extension/test/suite/extension.test.ts': extensionSource } }));
    expect(child.status).toBe(1);
    expect(report.errors).toContain('Unavailable lane requires a reason in config/test-lanes.mjs: extension-host');
  });

  it('does not let a CI-owned package script cover files outside its declared lane', () => {
    const file = 'apps/widget/web/other/uncovered.test.ts';
    const { child, report } = run(project({ lanes: [webLane], packages: webPackages,
      ci: 'npm test && npm --prefix apps/widget run test:web',
      files: { [file]: vitestSource, 'apps/widget/web/src/covered.test.ts': vitestSource } }));
    expect(child.status).toBe(1);
    expect(report.errors).toContain(`${file}: unassigned test file; missing vitest lane`);
  });
});
