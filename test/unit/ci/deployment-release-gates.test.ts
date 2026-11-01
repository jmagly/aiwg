import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '../../..');
const load = (file: string) => parse(readFileSync(resolve(root, file), 'utf8'));
const command = 'node tools/ci/run-with-hang-report.mjs --timeout 18m -- npm run test:deployment';

describe('required provider deployment release gates', () => {
  it('blocks retained RC creation and therefore stable publication when deployment validation fails', () => {
    const job = load('.github/workflows/release-candidate.yml').jobs.validate;
    const steps = job.steps;
    const idx = (name: string) => steps.findIndex((step: { name: string }) => step.name === name);
    const lane = idx('Run release validation profile');
    expect(lane).toBeGreaterThan(idx('Install mandatory SQLite session test backend'));
    expect(lane).toBeLessThan(idx('Pack and smoke-test exact npm surfaces'));
    expect(steps[lane].run).toContain('release-candidate.mjs validate');
    expect(steps[lane].run).toContain('--profile');
    const profile = steps[idx('Resolve validation profile')];
    expect(profile.run).toContain("PROFILE='routine-release-v1'");
    expect(profile.run).toContain('quarterly-full-v1');
    expect(steps[lane]['continue-on-error']).toBeUndefined();
    expect(steps[lane].if).toBeUndefined();
    expect(job['timeout-minutes']).toBeGreaterThanOrEqual(18);
  });
  it('retains the same required lane in plugin tag validation', () => {
    const jobs = load('.gitea/workflows/build-plugins.yml').jobs;
    const job = jobs.deployment;
    const steps = job.steps;
    const lane = steps.findIndex((step: { name: string }) => step.name === 'Run provider deployment integration lane');
    expect(lane).toBeGreaterThan(steps.findIndex((step: { run?: string }) => step.run === 'npm run build:cli'));
    expect(steps[lane]).toMatchObject({ run: command });
    expect(steps[lane]['continue-on-error']).toBeUndefined();
    expect(steps[lane].if).toBeUndefined();
    expect(job['timeout-minutes']).toBe(25);
    expect(job.needs).toBe('build');
    expect(jobs.validate.needs).toContain('deployment');
  });
  it('requires the release-only lane before stable packages are packed or published', () => {
    const steps = load('.github/workflows/npm-publish.yml').jobs['publish-to-npmjs-org'].steps;
    const index = (name: string) => steps.findIndex((step: { name: string }) => step.name === name);
    const gate = index('Require slow release infrastructure tests');
    expect(gate).toBeGreaterThan(index('Validate and build stable release'));
    expect(gate).toBeLessThan(index('Pack and smoke-test exact npm surfaces'));
    expect(gate).toBeLessThan(index('Publish smoke-tested stable tarballs to npmjs.org'));
    expect(steps[gate].run).toBe('node tools/ci/run-with-hang-report.mjs --timeout 30m -- npm run test:release-slow');
    expect(steps[gate].if).toBe("${{ steps.recovery.outputs.recovered != 'true' }}");
    expect(steps[gate]['continue-on-error']).toBeUndefined();
  });
  it('offers a manual-only release lane after building the CLI', () => {
    const workflow = load('.gitea/workflows/release-slow.yml');
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    const job = workflow.jobs['release-slow'];
    const gate = job.steps.findIndex((step: { name: string }) => step.name === 'Run release infrastructure lane');
    expect(gate).toBeGreaterThan(job.steps.findIndex((step: { run: string }) => step.run === 'npm run build:cli'));
    expect(job.steps[gate].run).toContain('--timeout 30m -- npm run test:release-slow');
    expect(job.steps[gate].if).toBeUndefined();
    expect(job.steps[gate]['continue-on-error']).toBeUndefined();
    expect(job['timeout-minutes']).toBeGreaterThan(30);
  });
  it.each([
    ['.gitea/workflows/release-slow.yml', 'release-slow', 'Run release infrastructure lane'],
    ['.github/workflows/release-candidate.yml', 'validate', 'Run release validation profile'],
    ['.github/workflows/release-comparison.yml', 'validate', 'Run quarterly full validation'],
    ['.github/workflows/npm-publish.yml', 'publish-to-npmjs-org', 'Require slow release infrastructure tests'],
  ])('provisions both locked Flue examples before the release lane in %s', (file, job, gateName) => {
    const steps = load(file).jobs[job].steps;
    const node = steps.findIndex((step: { run?: string }) => step.run === 'npm ci --prefix examples/flue-node');
    const cloudflare = steps.findIndex((step: { run?: string }) =>
      step.run === 'npm ci --prefix examples/flue-cloudflare --no-audit --no-fund');
    const gate = steps.findIndex((step: { name?: string }) => step.name === gateName);
    expect(node).toBeGreaterThanOrEqual(0);
    expect(cloudflare).toBe(node + 1);
    expect(gate).toBeGreaterThan(cloudflare);
    expect(steps[cloudflare].if).toBe(steps[node].if);
    expect(steps[cloudflare]['continue-on-error']).toBeUndefined();
  });
  it('locks the hosted Linux x64 workerd binary required by Wrangler', () => {
    const { packages } = JSON.parse(readFileSync(resolve(root, 'examples/flue-cloudflare/package-lock.json'), 'utf8'));
    const binary = packages['node_modules/@cloudflare/workerd-linux-64'];
    expect(binary.version).toBe(packages['node_modules/workerd'].optionalDependencies['@cloudflare/workerd-linux-64']);
    expect(binary).toMatchObject({ os: ['linux'], cpu: ['x64'], optional: true });
    expect(binary.resolved).toContain(`/workerd-linux-64-${binary.version}.tgz`);
    expect(binary.integrity).toMatch(/^sha512-/);
  });
  it('requires slow release coverage in the existing routine RC deployment script', () => {
    const { scripts } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    expect(scripts['test:release:routine-deployment']).toBe('npm run test:release-slow && vitest run --config config/vitest.config.js --maxWorkers=1 --fileParallelism=false test/integration/use-self-verification.test.ts');
  });
  it('requires release tests before the tag helper opens signing keys or writes refs', () => {
    const source = readFileSync(resolve(root, 'tools/release/cut-tag.sh'), 'utf8');
    const gate = source.indexOf('\nnode tools/ci/run-with-hang-report.mjs --timeout 30m -- npm run test:release-slow');
    expect(gate).toBeGreaterThan(source.indexOf('\nnpm run build:cli'));
    for (const example of ['flue-node', 'flue-cloudflare']) {
      const provision = `if [ -f examples/${example}/package-lock.json ]; then\n  npm ci --prefix examples/${example} --no-audit --no-fund\nfi`;
      expect(source).toContain(provision);
      expect(gate).toBeGreaterThan(source.indexOf(provision));
    }
    expect(gate).toBeLessThan(source.indexOf('\nif [ "$AIWG_RELEASE_SIGN_FROM_VAULT" = "1" ]'));
    expect(gate).toBeLessThan(source.indexOf('\ngit "${GIT_TAG_GPG_OPTS[@]}" tag -s'));
    expect(source).toContain('set -euo pipefail');
  });
});
