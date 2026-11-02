import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { writeExecutableSync } from '../../helpers/write-executable.js';

const load = (file: string) => parse(readFileSync(file, 'utf8'));
const workflow = load('.gitea/workflows/build-plugins.yml');
const jobs = workflow.jobs;
const shards = jobs['test-shards'];
const lane = shards.steps.find((step: { name: string }) => step.name === 'Run default test shard');
const gate = jobs.validate.steps[0];

describe('required plugin tag validation', () => {
  it('retains packaging and manifest gates on tag pushes', () => {
    expect(workflow.on.push.tags).toEqual(['v*']);
    const steps = jobs.build.steps;
    expect(steps.map((step: { name: string }) => step.name)).toEqual([
      'Checkout code', 'Install dependencies', 'Package plugins',
      'Validate plugin manifests', 'Validate marketplace.json',
      'Verify .aiwg/ excluded from plugins', 'Build summary',
    ]);
    for (const step of steps) {
      expect(step['continue-on-error']).toBeUndefined();
      expect(step.if).toBeUndefined();
    }
    expect(steps[2].run).toContain('npm run package-plugins:clean');
    expect(steps[2].run).toContain('npm run package-plugins');
    for (const step of steps.slice(3, 6)) expect(step.run).toContain('exit 1');
  });

  it('runs only two bounded native shards with all prerequisite gates', () => {
    expect(shards.strategy).toEqual({ 'fail-fast': false, matrix: { shard: [1, 2] } });
    expect(shards.needs).toBe('build');
    expect(shards['timeout-minutes']).toBe(40);
    expect(lane.run).toBe('node tools/ci/run-with-hang-report.mjs --timeout 20m -- npm test -- --shard=${{ matrix.shard }}/2 --maxWorkers=4');
    expect(lane.env).toEqual({
      AIWG_PERF_BUDGET_VERSION_MS: '300', AIWG_PERF_BUDGET_HELP_MS: '750', AIWG_PERF_SAMPLE_COUNT: '7',
    });
    const commands = shards.steps.map((step: { run?: string }) => step.run ?? '');
    expect(commands).toEqual(expect.arrayContaining([
      'npm ci', 'npm run typecheck', 'npm run build:cli', 'node tools/testing/check-native-shards.mjs 2',
    ]));
    expect(commands.find((run: string) => run.includes('better-sqlite3@12.8.0'))).toContain("require('better-sqlite3')");
    expect(commands.indexOf('npm run typecheck')).toBeLessThan(commands.indexOf(lane.run));
    expect(commands.indexOf('npm run build:cli')).toBeLessThan(commands.indexOf(lane.run));
    expect(commands.indexOf('node tools/testing/check-native-shards.mjs 2')).toBeLessThan(commands.indexOf(lane.run));
    const scripts = load('package.json').scripts;
    expect(scripts.test).toBe('node tools/testing/run-default-lane.mjs');
    expect(scripts['test:deployment']).toBe('node tools/testing/run-default-lane.mjs --config config/vitest.deployment.config.js');
    const source = load('.gitea/workflows/ci.yml').jobs['test-shards'];
    expect(source.steps.map((step: { run?: string }) => step.run)).toContain('node tools/testing/check-native-shards.mjs 4');
    expect(jobs.validate.needs).toEqual(['build', 'test-shards', 'deployment']);
    expect(jobs.validate.if).toBe('always()');
    expect(shards.if).toBeUndefined();
    expect(jobs.deployment.if).toBeUndefined();
    expect(jobs.deployment.name).toBe('Provider deployment integration (shard ${{ matrix.shard }}/2)');
    expect(jobs.deployment.strategy).toEqual({ 'fail-fast': false, matrix: { shard: [1, 2] } });
    expect(jobs.deployment.env).toEqual({ AIWG_DEPLOYMENT_SHARD: '${{ matrix.shard }}' });
    for (const job of [shards, jobs.deployment, jobs.validate]) {
      expect(job['continue-on-error']).toBeUndefined();
      for (const step of job.steps) {
        expect(step['continue-on-error']).toBeUndefined();
        expect(step.if).toBeUndefined();
      }
    }
  });

  it.each([0, 1, 2])('propagates failed shard %i through the tag workflow success gate', failedShard => {
    const directory = mkdtempSync(path.join(tmpdir(), 'aiwg-plugin-contract-'));
    try {
      // Exercise the workflow shell and watchdog; substitute only the expensive
      // npm child with a synthetic assertion failure for one matrix member.
      writeExecutableSync(path.join(directory, 'npm'), `#!${process.execPath}\nprocess.exit(process.argv.includes('--shard=' + process.env.FAILED_SHARD + '/2') ? 7 : 0);\n`);
      const statuses = shards.strategy.matrix.shard.map((index: number) => {
        const command = lane.run.replaceAll('${{ matrix.shard }}', String(index));
        const result = spawnSync('/bin/sh', ['-eu', '-c', command], {
          encoding: 'utf8', timeout: 5000,
          env: { ...process.env, PATH: directory + path.delimiter + process.env.PATH, FAILED_SHARD: String(failedShard) },
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(index === failedShard ? 7 : 0);
        return result.status;
      });
      const command = gate.run
        .replaceAll('${{ needs.build.result }}', 'success')
        .replaceAll('${{ needs.test-shards.result }}', statuses.every((status: number) => status === 0) ? 'success' : 'failure')
        .replaceAll('${{ needs.deployment.result }}', 'success');
      const result = spawnSync('/bin/sh', ['-eu', '-c', command], { encoding: 'utf8', timeout: 5000 });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(failedShard === 0 ? 0 : 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['failure', 'cancelled', 'skipped'])('rejects %s deployment even when both shards pass', status => {
    const command = gate.run
      .replaceAll('${{ needs.build.result }}', 'success')
      .replaceAll('${{ needs.test-shards.result }}', 'success')
      .replaceAll('${{ needs.deployment.result }}', status);
    expect(spawnSync('/bin/sh', ['-eu', '-c', command], { timeout: 5000 }).status).toBe(1);
  });
});
