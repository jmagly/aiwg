// Factory onboarding must name offline blockers without invoking a model or reading credentials.
import { access, chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { doctorWorkerCliFixture } from '../../helpers/doctor-worker-cli.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

type State = 'missing-droid' | 'no-model' | 'disabled-model' | 'no-observation' | 'wrong-version' | 'wrong-account';
async function fixture(state: State) {
  const f = await doctorWorkerCliFixture();
  roots.push(f.root);
  const binary = path.join(f.root, 'fake-bin/droid');
  await copyFile(new URL('../../fixtures/providers/factory/qualification-cli.mjs', import.meta.url), binary);
  await chmod(binary, 0o755);
  if (state === 'missing-droid') await rm(binary);
  const configFile = path.join(f.project, '.aiwg/aiwg.config');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.providers = ['factory'];
  config.parallelism.clis = { factory: { adapter: 'providers:factory', executable: binary,
    accountScope: 'synthetic-account', quotaScope: 'synthetic-quota' } };
  config.parallelism.groups.workers.members[0].cli = 'factory';
  if (state === 'missing-droid' || state === 'no-model') config.parallelism.groups = {};
  if (state === 'disabled-model') config.parallelism.groups.workers.members[0].enabled = false;
  if (state === 'wrong-version' || state === 'wrong-account') {
    await mkdir(path.join(f.root, '.cache/aiwg'), { recursive: true });
    await writeFile(path.join(f.root, '.cache/aiwg/model-catalog.v1.json'), JSON.stringify({ discovery: {
      instances: { factory: { models: [{ id: 'synthetic-model', apiModelId: 'synthetic-model', llmProvider: 'synthetic',
        worker: { runtimeVersion: state === 'wrong-version' ? '0.238.0' : '1.0.0',
          accountScope: state === 'wrong-account' ? 'other-account' : 'synthetic-account' } }] } },
    } }));
  }
  await writeFile(configFile, JSON.stringify(config));
  await writeFile(path.join(f.project, 'models.json'), '{}');
  return f;
}

it.each([true, false])('names missing droid through the public qualification CLI (JSON: %s)', async json => {
  const f = await fixture('missing-droid');
  const result = await f.run(['doctor', '--probe-workers', '--qualify', '--cli', 'factory', '--yes', ...(json ? ['--json'] : [])]);
  expect(result.code, result.stdout + result.stderr).toBe(1);
  expect(result.stdout).toContain('is not installed');
  expect(result.stdout).toContain('droid');
  if (json) expect(JSON.parse(result.stdout).qualification.results).toContainEqual(expect.objectContaining({
    cli: 'factory', status: 'failed', code: 'WORKER_DIRECT_NOT_INSTALLED',
    message: expect.stringContaining('is not installed'),
  }));
  await expect(access(path.join(f.config, 'worker-installations.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['no-model', 'disabled-model', 'no-observation', 'wrong-version', 'wrong-account'] as const)('names Factory plan/BYOK prerequisite before confirmation: %s', async state => {
  const f = await fixture(state);
  const result = await f.run(['doctor', '--probe-workers', '--qualify', '--cli', 'factory', '--json']);
  expect(result.code, result.stdout + result.stderr).toBe(1);
  const report = JSON.parse(result.stdout);
  expect(report.workers).toEqual([expect.objectContaining({ cli: 'factory', installed: true, inRange: true })]);
  expect(report.qualification).toMatchObject({ status: 'failed', results: [{ cli: 'factory', status: 'failed',
    message: expect.stringContaining('Factory plan or BYOK') }] });
  expect(report.qualification.results[0].message).toContain(['no-model', 'disabled-model'].includes(state)
    ? 'No Factory worker model is configured' : 'No exact current Factory model observations');
  expect(report.qualification.results[0].message).toContain('not checked offline');
  expect(await readFile(path.join(f.root, 'fake-bin/calls.jsonl'), 'utf8')).toBe('["--version"]\n');
  await expect(access(path.join(f.config, 'worker-installations.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('accepts Factory through the existing project CLI configuration command', async () => {
  const f = await fixture('no-model');
  const file = path.join(f.project, '.aiwg/aiwg.config');
  const config = JSON.parse(await readFile(file, 'utf8'));
  const installation = config.parallelism.clis.factory;
  delete config.parallelism.clis.factory;
  await writeFile(file, JSON.stringify(config));
  const result = await f.run(['config', 'set', '--project', 'parallelism.clis.factory', JSON.stringify(installation)]);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(await readFile(file, 'utf8')).parallelism.clis.factory).toMatchObject(installation);
});

it('reports an absent CLI as an install blocker only when --cli targets it', async () => {
  const f = await fixture('missing-droid');
  const result = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
  const report = JSON.parse(result.stdout);
  expect(report.qualification.results).not.toContainEqual(expect.objectContaining({ code: 'WORKER_DIRECT_NOT_INSTALLED' }));
  await expect(access(path.join(f.config, 'worker-installations.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
