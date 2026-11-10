import fs, { readFileSync } from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import base from '../../../config/vitest.config.js';
import deployment, { deploymentLaneFiles } from '../../../config/vitest.deployment.config.js';
import packaging from '../../../config/vitest.packaging.config.js';
import releaseSlow from '../../../config/vitest.release-slow.config.js';
import uatConfig from '../../../config/vitest.uat.config.js';
import { deploymentFiles, deploymentShards, packagingFiles, releaseSlowFiles } from '../../../config/test-lanes.mjs';
import { bundleReconciliationSource } from '../../helpers/bundle-reconciliation-source.js';

const root = path.resolve(import.meta.dirname, '../../..');

describe('required provider deployment lane', () => {
  it('runs exhaustive deployment matrices only in the serial release lane', () => {
    expect(releaseSlowFiles).toHaveLength(12);
    expect(releaseSlowFiles).toContain('test/integration/flue-cloudflare-e2e.test.ts');
    expect(releaseSlowFiles).toContain('test/integration/flue-package-consumer.test.ts');
    expect(releaseSlowFiles).toContain('test/integration/flue-node-e2e.test.ts');
    expect(releaseSlowFiles).toContain('test/integration/flue-mcp-http.test.ts');
    expect(releaseSlowFiles).toContain('test/integration/flue-remote-package-consumer.test.ts');
    expect(releaseSlowFiles).toContain('test/integration/ownership-matrix-deployment.test.ts');
    expect(releaseSlow.test.include).toEqual(releaseSlowFiles);
    expect(releaseSlow.test).toMatchObject({ pool: 'forks', maxWorkers: 1, fileParallelism: false });
    for (const file of releaseSlowFiles) {
      expect(base.test.exclude).toContain(file);
      expect(deploymentFiles).not.toContain(file);
    }
    for (const name of ['project-local-deploy', 'use-b2-contract', 'use-b3-plumbing', 'omp-provider', 'model-worker-provider-matrix', 'provider-smoke-deployment']) {
      const file = `test/integration/${name}.test.ts`;
      expect(base.test.exclude).not.toContain(file);
      expect(releaseSlowFiles).not.toContain(file);
    }
  });

  it('owns exactly the full-corpus deployment files and runs them serially', () => {
    // The guided-setup walkthrough (#3449 A6) applies a real `aiwg use`
    // deployment against the shared reviewed cache, so it runs in this lane.
    expect(deploymentFiles).toEqual([
      'test/integration/flue-deployment.test.ts',
      'test/integration/use-all-deployment.test.ts',
      'test/integration/hermes-deployment.test.ts',
      'test/integration/guided-setup-walkthrough.test.ts',
      'test/integration/remove-deployment.test.ts',
      'test/integration/bundle-reconciliation-cli.test.ts',
      'test/integration/bundle-reconciliation-codex-cli.test.ts',
      'test/integration/refresh-managed-deployment.test.ts',
      'test/integration/harness-bootstrap-audit.test.ts',
    ]);
    expect(deployment.test.include).toEqual(deploymentFiles);
    expect(deployment.test).toMatchObject({
      pool: 'forks', maxWorkers: 1, minWorkers: 1,
      fileParallelism: false, isolate: true,
    });
    for (const file of deploymentFiles) expect(base.test.exclude).toContain(file);
    expect(deployment.test.globalSetup).toEqual([
      './test/helpers/default-home-setup.mjs',
      './test/helpers/prebuilt-relations-setup.mjs',
      './test/helpers/deployment-cache-setup.mjs',
    ]);
  });

  it('splits the lane into two serial shards that run every deployment file exactly once', () => {
    expect(deploymentShards).toHaveLength(2);
    const sharded = deploymentShards.flat();
    expect(new Set(sharded).size).toBe(sharded.length);
    expect([...sharded].sort()).toEqual([...deploymentFiles].sort());
    for (const shard of deploymentShards) expect(shard.length).toBeGreaterThan(0);
    expect(deploymentLaneFiles(undefined)).toEqual(deploymentFiles);
    expect(deploymentLaneFiles('')).toEqual(deploymentFiles);
    expect(deploymentLaneFiles('1')).toEqual(deploymentShards[0]);
    expect(deploymentLaneFiles('2')).toEqual(deploymentShards[1]);
    for (const invalid of ['0', '3', 'x', '1.5']) {
      expect(() => deploymentLaneFiles(invalid)).toThrow(/AIWG_DEPLOYMENT_SHARD must be 1-2/);
    }
  });

  it('keeps the expensive provider reconciliation suites on different shards (#4063)', () => {
    const files = ['bundle-reconciliation-cli', 'bundle-reconciliation-codex-cli']
      .map(name => `test/integration/${name}.test.ts`);
    const shards = files.map(file => deploymentShards.findIndex(shard => shard.includes(file)));
    expect(shards.every(index => index >= 0)).toBe(true);
    expect(new Set(shards).size).toBe(2);
  });

  it.each([false, true])('isolates unrelated doctor probes from reconciliation (full corpus: %s)', fullCorpus => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-reconciliation-fixture-'));
    let fixture: string | undefined;
    try {
      for (const dir of ['agentic/code/addons/ordinary', 'agentic/code/extensions/last', 'tools/cli']) {
        fs.mkdirSync(path.join(source, dir), { recursive: true });
      }
      const manifest = 'agentic/code/addons/ordinary/manifest.json';
      fs.writeFileSync(path.join(source, manifest), '{"id":"ordinary"}\n');
      fs.writeFileSync(path.join(source, 'agentic/code/extensions/last/manifest.json'), '{}');
      fs.writeFileSync(path.join(source, 'package.json'), '{"name":"aiwg"}');
      const doctor = 'tools/cli/doctor.mjs';
      const original = 'throw new Error("unrelated discovery probe executed");\n';
      fs.writeFileSync(path.join(source, doctor), original);
      fixture = bundleReconciliationSource(source, fullCorpus);
      expect(fs.readFileSync(path.join(source, doctor), 'utf8')).toBe(original);
      expect(execFileSync(process.execPath, [path.join(fixture, doctor)], {
        encoding: 'utf8', timeout: 10_000,
      })).toContain('Reconciliation fixture: doctor covered separately');
      expect(JSON.parse(fs.readFileSync(path.join(fixture, manifest), 'utf8')).explicitInstall)
        .toBe(fullCorpus ? undefined : true);
    } finally {
      if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
      fs.rmSync(source, { recursive: true, force: true });
    }
  });

  it('is a required canonical build prerequisite', () => {
    const workflow = parseYaml(readFileSync(path.join(root, '.gitea/workflows/ci.yml'), 'utf8'));
    const job = workflow.jobs.deployment;
    expect(job.name).toBe('Provider deployment integration (shard ${{ matrix.shard }}/2)');
    expect(job.strategy).toEqual({ 'fail-fast': false, matrix: { shard: [1, 2] } });
    expect(job.env).toEqual({ AIWG_DEPLOYMENT_SHARD: '${{ matrix.shard }}' });
    expect(job['timeout-minutes']).toBe(40);
    const commands = job.steps.map((step: { run?: string }) => step.run ?? '');
    expect(commands).toContain('npm run build:cli');
    expect(commands).toContain('node tools/ci/run-with-hang-report.mjs --timeout 30m -- npm run test:deployment');
    expect(workflow.jobs.build.needs).toContain('deployment');

    const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
    expect(scripts['test:deployment']).toBe(
      'node tools/testing/run-default-lane.mjs --config config/vitest.deployment.config.js',
    );
  });

  it('runs default tests in four required native Vitest shards with bounded workers', () => {
    const workflow = parseYaml(readFileSync(path.join(root, '.gitea/workflows/ci.yml'), 'utf8'));
    const job = workflow.jobs['test-shards'];
    expect(job.name).toBe('Default tests (shard ${{ matrix.shard }}/4)');
    expect(job.strategy).toEqual({
      'fail-fast': false,
      matrix: { shard: [1, 2, 3, 4] },
    });
    expect(job['timeout-minutes']).toBe(30);

    const steps = job.steps as Array<{
      name?: string;
      run?: string;
      if?: string;
      env?: Record<string, string>;
      'continue-on-error'?: boolean;
    }>;
    const command = 'node tools/ci/run-with-hang-report.mjs --timeout 20m -- npm test -- --shard=${{ matrix.shard }}/4 --maxWorkers=4';
    const shard = steps.find(step => step.name === 'Run default test shard');
    expect(shard).toMatchObject({
      run: command,
      env: {
        AIWG_PERF_BUDGET_VERSION_MS: '300',
        AIWG_PERF_BUDGET_HELP_MS: '750',
        AIWG_PERF_SAMPLE_COUNT: '7',
      },
    });
    expect(shard?.if).toBeUndefined();
    expect(shard?.['continue-on-error']).toBeUndefined();
    expect(steps.map(step => step.run ?? '')).toEqual(expect.arrayContaining([
      'npm ci',
      'npm run typecheck',
      'npm run build:cli',
      'npm run features:sqlite',
      'node tools/ci/runner-headroom.mjs .',
      command,
    ]));

    const preflightSandbox = workflow.jobs.test.steps.find(
      (step: { name?: string }) => step.name === 'Require bundle provider sandbox suite where bwrap is available (#2846)',
    );
    const shardSandbox = steps.find(step => step.name === preflightSandbox.name);
    expect(shardSandbox?.if).toBe(preflightSandbox.if);
    expect(shardSandbox?.run).toBe(preflightSandbox.run);
    expect(workflow.jobs.build.needs).toEqual(expect.arrayContaining(['test', 'test-shards']));
  });

  it('runs every packaging file in four required native shards without widening its budget', () => {
    expect(packaging.test.include).toEqual(packagingFiles);
    for (const file of packagingFiles) expect(base.test.exclude).toContain(file);

    const workflow = parseYaml(readFileSync(path.join(root, '.gitea/workflows/ci.yml'), 'utf8'));
    const job = workflow.jobs.packaging;
    expect(job.name).toBe('Package lifecycle (shard ${{ matrix.shard }}/4)');
    expect(job['timeout-minutes']).toBe(10);
    expect(job.strategy).toEqual({
      'fail-fast': false,
      matrix: { shard: [1, 2, 3, 4] },
    });
    const steps = job.steps as Array<{ name?: string; run?: string; if?: string; 'continue-on-error'?: boolean }>;
    expect(steps.map(step => step.run ?? '')).toEqual(expect.arrayContaining([
      'npm ci',
      'npm run build',
      'npm run check:budgets',
      'npm run test:packaging -- --shard=${{ matrix.shard }}/4',
    ]));
    const run = steps.find(step => step.name === 'Run isolated packaging lifecycle tests');
    expect(run?.if).toBeUndefined();
    expect(run?.['continue-on-error']).toBeUndefined();
    expect(workflow.jobs.build.needs).toContain('packaging');
  });

  it('keeps preflight, UAT and serve single and mandatory', () => {
    const workflow = parseYaml(readFileSync(path.join(root, '.gitea/workflows/ci.yml'), 'utf8'));
    const job = workflow.jobs.test;
    const steps = job.steps as Array<{ name?: string; run?: string; if?: string; 'continue-on-error'?: boolean }>;
    const uat = steps.findIndex(step => step.name === 'Run UAT');
    const serve = steps.findIndex(step => step.run === 'npm run test:integration:serve');
    expect(steps.some(step => step.name === 'Run tests')).toBe(false);
    expect(uat).toBeGreaterThan(0);
    expect(steps[uat].run).toBe('node tools/ci/run-with-hang-report.mjs --timeout 3m -- npm run uat');
    expect(serve).toBeGreaterThan(uat);
    for (const step of [steps[uat], steps[serve]]) {
      expect(step.if).toBeUndefined();
      expect(step['continue-on-error']).toBeUndefined();
    }
    expect(job['timeout-minutes']).toBe(35);
    const allSteps = Object.values(workflow.jobs)
      .flatMap((candidate: any) => candidate.steps ?? []) as Array<{ run?: string }>;
    expect(allSteps.filter(step => step.run === 'node tools/ci/run-with-hang-report.mjs --timeout 3m -- npm run uat')).toHaveLength(1);
    expect(allSteps.filter(step => step.run === 'npm run test:integration:serve')).toHaveLength(1);
    expect(base.test.exclude).toContain('test/uat/**');
    expect(uatConfig.test.include.length).toBeGreaterThan(0);
    expect(uatConfig.test.include.every((file: string) => file.startsWith('test/uat/'))).toBe(true);
    const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
    expect(scripts.uat).toBe('vitest run --config config/vitest.uat.config.js');
    expect(scripts['test:ci']).toBe('npm test && vitest run --config config/vitest.uat.config.js');
  });
});
