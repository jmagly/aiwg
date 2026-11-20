// Public offline qualification and refresh exercise only a fake Cursor executable.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { doctorWorkerCliFixture } from '../../helpers/doctor-worker-cli.js';
import { writeExecutable } from '../../helpers/write-executable.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(model = 'gpt-5.3-codex-high', failed = false, limits = true, version = '2026.11.13-eacade1') {
  const f = await doctorWorkerCliFixture();
  roots.push(f.root);
  const binary = path.join(f.root, 'fake-bin/cursor-agent');
  const calls = path.join(f.root, 'cursor-calls.jsonl');
  // Keep public JSON output within the shared CLI fixture's buffer. The parser
  // suite covers the entire capture; these exact first rows cover dispatch.
  const capture = (await readFile(new URL('../../fixtures/providers/cursor/list-models.txt', import.meta.url), 'utf8'))
    .split('\n').slice(0, 14).join('\n');
  await writeExecutable(binary, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv.slice(2).join(' ') === '--version') console.log(${JSON.stringify(version)});
else if (process.argv.slice(2).join(' ') === '--list-models') {
  if (${failed}) { console.error('Not logged in; token=synthetic-secret'); process.exit(1); }
  console.log(${JSON.stringify(capture)});
} else process.exit(90);
`);
  const configFile = path.join(f.project, '.aiwg/aiwg.config');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.providers = ['cursor'];
  config.parallelism.clis = { cursor: { adapter: 'providers:cursor', executable: binary,
    accountScope: 'synthetic-account', quotaScope: 'synthetic-quota',
    ...(limits ? { modelLimits: { [model]: { contextTokens: 200000, maxOutputTokens: 16000 } } } : {}) } };
  config.parallelism.groups.workers.members[0] = { id: 'primary', cli: 'cursor', model, roles: ['coding'] };
  await writeFile(configFile, JSON.stringify(config));
  await writeFile(path.join(f.project, 'models.json'), JSON.stringify({ defaults: { workerSelection: {
    roleGuidance: { coding: { groups: ['workers'], tier: 'standard', initialEffort: 'high', effortLadder: ['high'] } },
    guards: { denySelfDelegation: false }, dataPolicy: { allowUnknown: true },
  } } }));
  return { ...f, calls };
}

it('caches listed Cursor observations, approves the exact configured model, and resolves a launchable route', async () => {
  const f = await fixture();
  const refresh = await f.run(['models', 'refresh', '--provider', 'cursor', '--json']);
  expect(refresh.code, refresh.stdout + refresh.stderr).toBe(0);
  const cache = JSON.parse(await readFile(path.join(f.root, '.cache/aiwg/model-catalog.v1.json'), 'utf8'));
  expect(cache.discovery.providers.cursor.models).toContainEqual(expect.objectContaining({
    id: 'gpt-5.3-codex-high', apiModelId: 'gpt-5.3-codex-high', llmProvider: 'cursor',
    worker: expect.objectContaining({ runtimeVersion: '2026.11.13-eacade1', accountScope: 'synthetic-account', contextTokens: 200000, maxOutputTokens: 16000 }),
  }));
  expect(cache.discovery.instances['cursor:synthetic-account']).toBeDefined();
  const result = await f.run(['doctor', '--probe-workers', '--qualify', '--cli', 'cursor', '--yes', '--json']);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  const report = JSON.parse(result.stdout).qualification;
  expect(report).toMatchObject({ status: 'recorded', results: [{ cli: 'cursor', status: 'qualified',
    models: ['gpt-5.3-codex-high'], invocationChecks: [{ effort: 'high', status: 'passed' }] }] });
  expect(report.results[0].warning).toBeUndefined();
  const resolved = await f.resolve();
  expect(resolved.code, resolved.stdout + resolved.stderr).toBe(0);
  const invocation = JSON.parse(resolved.stdout).invocation;
  expect(invocation).toMatchObject({ readiness: 'launchable', selected: { model: 'gpt-5.3-codex-high' } });
  expect(invocation.argv[invocation.argv.indexOf('--model') + 1]).toBe('gpt-5.3-codex-high');
  const calls = (await readFile(f.calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(calls.every(args => ['--version', '--list-models'].includes(args.join(' ')))).toBe(true);
  expect(calls.filter(args => args[0] === '--list-models')).toHaveLength(2);
  const configFile = path.join(f.project, '.aiwg/aiwg.config');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.parallelism.clis.cursor.modelLimits['gpt-5.3-codex-high'].contextTokens = 100000;
  await writeFile(configFile, JSON.stringify(config));
  const changed = await f.resolve();
  expect(changed.code, changed.stdout + changed.stderr).not.toBe(0);
  delete config.parallelism.clis.cursor.modelLimits;
  await writeFile(configFile, JSON.stringify(config));
  const removed = await f.resolve();
  expect(removed.code, removed.stdout + removed.stderr).not.toBe(0);
});

it.each(['2026.11.17-f532c45', '2026.11.19-f005e9d', '2026.11.19-0001234'])(
  '#4306 qualifies and resolves a newer Cursor build: %s', async version => {
    const f = await fixture(undefined, false, true, version);
    const result = await f.run(['doctor', '--probe-workers', '--qualify', '--cli', 'cursor', '--yes', '--json']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.workers[0]).toMatchObject({ version, ready: true, inRange: true });
    expect(payload.workers[0].warning).toContain('newer than tested');
    expect(payload.workers[0].warning).toContain('aiwg doctor --probe-workers --qualify --cli cursor --yes');
    expect(payload.qualification).toMatchObject({ status: 'recorded', results: [{ cli: 'cursor', status: 'qualified' }] });
    const resolved = await f.resolve();
    expect(resolved.code, resolved.stdout + resolved.stderr).toBe(0);
    expect(JSON.parse(resolved.stdout).invocation).toMatchObject({ readiness: 'launchable' });
  });

it.each(['absent-model', 'auto', 'failed-list'] as const)('does not approve %s even with a matching older cached row', async state => {
  const model = state === 'failed-list' ? 'gpt-5.3-codex-high' : state;
  const f = await fixture(model, state === 'failed-list');
  await mkdir(path.join(f.root, '.cache/aiwg'), { recursive: true });
  await writeFile(path.join(f.root, '.cache/aiwg/model-catalog.v1.json'), JSON.stringify({ discovery: { providers: {
    cursor: { models: [{ id: model, apiModelId: model, llmProvider: 'cursor',
      worker: { availability: 'accessible', runtimeVersion: '2026.11.13-eacade1', accountScope: 'synthetic-account' } }] },
  } } }));
  const result = await f.run(['doctor', '--probe-workers', '--qualify', '--cli', 'cursor', '--yes', '--json']);
  const report = JSON.parse(result.stdout).qualification;
  expect(report).toMatchObject({ status: 'partial', results: [{ cli: 'cursor', models: [],
    warning: expect.stringContaining(`No exact current model observations for ${model}`) }] });
  const receipts = await readFile(path.join(f.config, 'worker-installations.json'), 'utf8');
  expect(receipts).not.toContain('synthetic-secret');
  expect(JSON.stringify(report)).not.toContain('synthetic-secret');
  const store = JSON.parse(receipts);
  expect(store.registrations.find(record => record.cli === 'cursor').modelObservations.models).toEqual([]);
});

it('refuses resolution when a listed and approved selector lacks context limits and names the operator key', async () => {
  const f = await fixture('gpt-5.3-codex-high', false, false);
  const qualified = await f.run(['doctor', '--probe-workers', '--qualify', '--cli', 'cursor', '--yes', '--json']);
  expect(qualified.code, qualified.stdout + qualified.stderr).toBe(0);
  expect(JSON.parse(qualified.stdout).qualification.results[0].models).toEqual(['gpt-5.3-codex-high']);
  const resolved = await f.resolve();
  expect(resolved.code).not.toBe(0);
  expect(resolved.stdout + resolved.stderr).toContain('parallelism.clis.cursor.modelLimits');
  expect(resolved.stdout + resolved.stderr).toContain('gpt-5.3-codex-high');
  expect(resolved.stdout + resolved.stderr).toContain('contextTokens');
});
