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

it.each([true, false])('discovers BYOK settings before qualification and never retains literal keys (refresh: %s)', async refresh => {
  const f = await fixture('no-observation');
  const model = 'custom:AIWG-OpenRouter-Qwen-3.8-27B';
  const file = path.join(f.project, '.aiwg/aiwg.config');
  const config = JSON.parse(await readFile(file, 'utf8'));
  config.parallelism.groups.workers.members[0].model = model;
  await writeFile(file, JSON.stringify(config));
  await writeFile(path.join(f.project, 'models.json'), JSON.stringify({ defaults: { workerSelection: {
    roleGuidance: { coding: { groups: ['workers'], tier: 'standard', initialEffort: null,
      effortLadder: [], allowNotApplicableEffort: true } },
    guards: { denySelfDelegation: false }, dataPolicy: { allowUnknown: true },
  } } }));
  await mkdir(path.join(f.root, '.factory'));
  const literal = 'synthetic-literal-factory-key-never-retain';
  await writeFile(path.join(f.root, '.factory/settings.json'), JSON.stringify({ customModels: [{
    model: 'qwen/qwen3.8-27b', displayName: 'AIWG OpenRouter Qwen 3.8 27B',
    baseUrl: 'https://openrouter.ai/api/v1', provider: 'generic-chat-completion-api',
    maxOutputTokens: 8192, maxContextLimit: 131072, apiKey: literal, api_key: literal,
  }] }));
  const refreshed = refresh ? await f.run(['models', 'refresh', '--provider', 'factory', '--json'])
    : { code: 0, stdout: '', stderr: '' };
  expect(refreshed.code, refreshed.stdout + refreshed.stderr).toBe(0);
  const cache = refresh ? await readFile(path.join(f.root, '.cache/aiwg/model-catalog.v1.json'), 'utf8') : '';
  if (refresh) expect(JSON.parse(cache).discovery.providers.factory.models).toContainEqual(expect.objectContaining({
    id: model, apiModelId: model, llmProvider: 'openrouter', worker: expect.objectContaining({
      runtimeVersion: '1.0.0', accountScope: 'synthetic-account', effortSupport: 'not-applicable', contextTokens: 131072,
    }),
  }));
  const result = await f.run(['doctor', '--probe-workers', '--qualify', '--cli', 'factory', '--yes', '--json']);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).qualification).toMatchObject({ status: 'recorded', results: [{
    cli: 'factory', status: 'qualified', models: [model], invocationChecks: [{ effort: null, status: 'passed' }],
  }] });
  const receipts = await readFile(path.join(f.config, 'worker-installations.json'), 'utf8');
  for (const output of [refreshed.stdout, refreshed.stderr, cache, result.stdout, result.stderr, receipts]) {
    expect(output).not.toContain(literal);
    expect(output).not.toMatch(/"(?:apiKey|api_key)"\s*:/);
  }
  const calls = (await readFile(path.join(f.root, 'fake-bin/calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(calls.every(args => args.join(' ') === '--version')).toBe(true);
  const resolved = await f.resolve();
  expect(resolved.code, resolved.stdout + resolved.stderr).toBe(0);
  expect(JSON.parse(resolved.stdout).invocation).toMatchObject({ readiness: 'launchable',
    selected: { model, effort: { support: 'not-applicable', value: null } } });
  expect(resolved.stdout + resolved.stderr).not.toContain(literal);
  await rm(path.join(f.root, '.factory/settings.json'));
  const removed = await f.run(['doctor', '--probe-workers', '--qualify', '--cli', 'factory', '--yes', '--json']);
  expect(removed.code).toBe(1);
  expect(JSON.parse(removed.stdout).qualification.results[0].message).toContain('No exact current Factory model observations');
  expect(JSON.parse(removed.stdout).qualification.results[0].message).toContain('~/.factory/settings.json');
});

it('reports an absent CLI as an install blocker only when --cli targets it', async () => {
  const f = await fixture('missing-droid');
  const result = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
  const report = JSON.parse(result.stdout);
  expect(report.qualification.results).not.toContainEqual(expect.objectContaining({ code: 'WORKER_DIRECT_NOT_INSTALLED' }));
  await expect(access(path.join(f.config, 'worker-installations.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
