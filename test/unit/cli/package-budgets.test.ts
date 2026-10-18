import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { mkdtempSync } from '../../helpers/temp-dir.js';

const root = path.resolve(import.meta.dirname, '../../..');
const fixture = mkdtempSync(path.join(tmpdir(), 'aiwg-package-budgets-'));
// Exercise the real CLI exit status without packing the corpus in every case.
writeFileSync(path.join(fixture, 'npm'), `#!${process.execPath}
if (process.cwd() !== process.env.AIWG_TEST_NPM_CWD) process.exit(2);
process.stdout.write(process.env.AIWG_TEST_NPM_OUTPUT ?? 'invalid JSON');
process.exit(Number(process.env.AIWG_TEST_NPM_STATUS ?? 0));
`, { mode: 0o755 });

function run(script: string, overrides: Record<string, string> = {}, args: string[] = []) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^AIWG_(DIRECT_DEPS|TRANSITIVE_DEPS|PACK_.*)_BUDGET/.test(key)) delete env[key];
  }
  return spawnSync(process.execPath, [path.join(root, 'tools/cli', script), ...args], {
    // Verify the install check resolves its own package, independent of cwd.
    cwd: fixture,
    env: { ...env, AIWG_TEST_NPM_CWD: root, PATH: `${fixture}${path.delimiter}${env.PATH}`, ...overrides },
    encoding: 'utf8',
    timeout: 10_000,
  });
}

const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const directCount = Object.keys(manifest.dependencies).length;
const pack = { name: 'aiwg', version: 'test', size: 1024, unpackedSize: 2048, fileCount: 3 };
function install(overrides: Record<string, string> = {}, measurement: unknown = pack) {
  return run('check-install-size.mjs', {
    AIWG_TEST_NPM_OUTPUT: JSON.stringify([measurement]),
    AIWG_PACK_PACKED_BUDGET_KB: '1',
    AIWG_PACK_UNPACKED_BUDGET_KB: '2',
    AIWG_PACK_FILES_BUDGET: '3',
    ...overrides,
  });
}

describe('package budget CLI gates', () => {
  it('passes the reviewed default dependency budget', () => {
    expect(run('check-dep-budget.mjs').status).toBe(0);
  });

  it('allows the dependency boundary and fails one dependency over it', () => {
    expect(run('check-dep-budget.mjs', { AIWG_DIRECT_DEPS_BUDGET: String(directCount) }).status).toBe(0);
    const result = run('check-dep-budget.mjs', { AIWG_DIRECT_DEPS_BUDGET: String(directCount - 1) });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Direct runtime deps');
    expect(result.stdout).not.toContain('OK');
  });

  it.each([0, 1])('enforces transitive budgets even when npm ls exits %i', (status) => {
    const result = run('check-dep-budget.mjs', {
      AIWG_TEST_NPM_OUTPUT: JSON.stringify({ dependencies: { a: { dependencies: { b: {} } } } }),
      AIWG_TEST_NPM_STATUS: String(status),
      AIWG_TRANSITIVE_DEPS_BUDGET: '1',
    }, ['--all']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Transitive deps 2 exceeds budget of 1');
  });

  it('fails a requested transitive check when measurement fails', () => {
    const result = run('check-dep-budget.mjs', {}, ['--all']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unable to measure transitive dependencies');
  });

  it('allows all install boundaries, including npm files-array output', () => {
    expect(install().status).toBe(0);
    expect(install({}, { ...pack, files: [{}, {}, {}] }).status).toBe(0);
  });

  it.each([
    ['size', 1025, 'Packed size'],
    ['unpackedSize', 2049, 'Unpacked size'],
    ['fileCount', 4, 'File count'],
  ])('fails when %s alone exceeds its budget', (field, value, diagnostic) => {
    const result = install({}, { ...pack, [field]: value });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(diagnostic);
    expect(result.stdout).not.toContain('OK');
  });

  it.each(['size', 'unpackedSize', 'fileCount'])('rejects a missing %s measurement', (field) => {
    const measurement: Record<string, unknown> = { ...pack };
    delete measurement[field];
    const result = install({}, measurement);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unexpected npm pack output');
  });

  it('fails if npm pack fails or returns invalid JSON', () => {
    expect(install({ AIWG_TEST_NPM_STATUS: '1' }).status).toBe(1);
    expect(install({ AIWG_TEST_NPM_OUTPUT: 'invalid' }).status).toBe(1);
  });

  it('runs both budgets as a blocking packaging step after the release build', () => {
    const workflow = yaml.load(readFileSync(path.join(root, '.gitea/workflows/ci.yml'), 'utf8')) as any;
    const steps = workflow.jobs.packaging.steps;
    const gate = steps.findIndex((step: any) => step.run === 'npm run check:budgets');
    expect(gate).toBeGreaterThan(steps.findIndex((step: any) => step.run === 'npm run build'));
    expect(steps[gate]['continue-on-error']).toBeUndefined();
    expect(steps[gate].if).toBeUndefined();
    expect(manifest.scripts['check:budgets']).toBe('npm run check:install-size && npm run check:dep-budget');
  });
});
