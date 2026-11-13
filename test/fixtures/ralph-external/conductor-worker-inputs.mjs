// Synthetic resolver inputs for the optional conductor probe; never installed qualification.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { importImpl } from '../../../tools/_resolve-impl.mjs';

const fixtures = new Map();
export async function loadWorkerInputs({ cwd }) {
  if (fixtures.has(cwd)) return fixtures.get(cwd);
  const { emptyConfig, workerConfigDigest: digest } = await importImpl(import.meta.url, 'config/aiwg-config.js');
  const { DEFAULT_WORKER_SELECTION, loadProviderModelCapabilities, mergeWorkerSelection, WORKER_OPERATOR_APPROVAL } =
    await importImpl(import.meta.url, 'models/provider-policy.js');
  const { readLiveHostResources } = await importImpl(import.meta.url, 'config/host-resource-runtime.mjs');
  const vectors = JSON.parse(readFileSync(new URL('../../conformance/mission-v1/fixtures/worker-contracts/shared-vectors.json', import.meta.url), 'utf8'));
  const observation = structuredClone(vectors.find(v => v.id === 'observation-no-effort').value);
  const now = new Date().toISOString();
  Object.assign(observation, { cliId: 'codex', family: 'synthetic-family', observedAt: now, fetchedAt: now, verifiedAt: now,
    contextTokens: 200000, maxOutputTokens: 32000, effortSupport: 'explicit', efforts: [{ id: 'medium', selfDelegates: false }],
    qualification: { status: 'qualified', roles: ['coding'], fixtureDigest: digest('fixture'), verifiedAt: now, evidenceRef: 'fixture:synthetic-only' } });
  const adapter = structuredClone(vectors.find(v => v.id === 'adapter-process-shape').value);
  Object.assign(adapter, { id: 'codex', provider: 'codex',
    qualification: { status: 'qualified', fixtureDigest: digest('adapter'), verifiedAt: now, evidenceRef: WORKER_OPERATOR_APPROVAL } });
  adapter.capabilities.effort = 'explicit';
  adapter.capabilities.sandboxModes = ['read-only', 'workspace-write'];
  const profile = adapter.invocationProfiles['fixture-shell'];
  for (const control of Object.values(profile.controls)) control.support = 'native';
  profile.transport = 'shell';
  profile.envAllowlist = [];
  const registry = structuredClone(loadProviderModelCapabilities());
  registry.providers.codex.workerAdapter = adapter;
  const policy = { roleGuidance: { coding: { groups: ['workers'], tier: 'standard', initialEffort: 'medium', effortLadder: ['medium'] } } };
  const merged = mergeWorkerSelection([
    { source: 'fixture:builtin', authority: 'builtin', digest: digest(null), policy: DEFAULT_WORKER_SELECTION },
    { source: 'fixture:project', authority: 'project', digest: digest(policy), policy },
  ]);
  const config = { ...emptyConfig(['codex']), parallelism: { worker_dispatch: true, max_parallel_subagents: 1,
    groups: { workers: { maxParallel: 1, members: [{ id: 'primary', cli: 'codex', model: 'synthetic/probe', roles: ['coding'] }], fallback: [],
      execution: { launchMode: 'native-sandbox', sandbox: 'workspace-write', approval: 'never', network: 'deny', transport: 'shell' } } } } };
  const model = { id: 'synthetic/probe', apiModelId: 'synthetic/probe', llmProvider: 'vendor', reasoningEfforts: ['medium'], worker: observation };
  const boundary = { kind: 'os', identity: 'fixture:enforcing-boundary', digest: digest('boundary'), controls: ['sandbox'] };
  const snapshot = { config, registry,
    hostResources: readLiveHostResources({ workspace: cwd, readText: file => ({ '/proc/meminfo': 'MemAvailable: 33554432 kB\n',
      '/proc/loadavg': '1.0 0.5 0.2 1/100 42\n', '/proc/pressure/memory': 'some avg10=2.00 avg60=1.00 avg300=0.00 total=1\n' })[file],
      coreCount: () => 8, countWorkers: () => 0, statfs: () => ({ bavail: 32, bsize: 1024 ** 3 }) }),
    models: { defaults: { provider: 'codex', tier: 'standard', workerSelection: merged.policy }, tiers: {}, providers: {}, agentRoleAssignments: {},
      shorthand: {}, agentOverrides: {}, workerPolicyOrigins: merged.origins },
    modelDigests: { builtinModelsDigest: digest(null), userModelsDigest: digest(null), projectModelsDigest: digest(policy) },
    catalog: { version: '1.0.0', providers: {}, discovery: { source: 'native', fetchedAt: now, providers: {}, instances: {
      codex: { provider: 'codex', source: 'native', observedAt: now, runtimeVersion: '1.0.0', accountScope: 'local-account', accountBinding: 'synthetic', models: [model] } } } },
    installations: { codex: { cliVersion: '1.0.0', accountScope: 'synthetic', endpointFingerprint: 'fixture:loopback', profile: 'fixture-shell',
      identityEvidence: 'runtime-configured', boundary } } };
  const work = path.join(cwd, '.aiwg', 'working', 'worktrees', 'worker');
  const inputs = { snapshot, drivers: { codex: {
    qualification: { adapter, adapterId: 'codex', cliVersion: '1.0.0', boundary, installation: { workerWritableRoots: [work] } },
    extractFinal: text => { try { return JSON.parse(text).result; } catch { return null; } },
    buildInvocation: async input => ({ argv: [path.join(cwd, 'codex'), '--no-daemon', 'exec', '--ignore-user-config',
      '-m', input.selected.model, '-s', input.permissions.sandbox,
      '-c', `model_reasoning_effort=${JSON.stringify(input.selected.effort.value)}`, '-c', 'approval_policy="never"',
      '-C', input.cwd, '-o', input.finalPath, '--json', '-'],
      ...(process.env.AIWG_CONDUCTOR_PROBE_ARTIFACT === '1' ? { artifacts: [{ name: 'brief', content: 'synthetic private artifact',
        location: 'workspace-relative', prefix: '.agents/skills/aiwg-brief-', relativePath: `.agents/skills/aiwg-brief-${input.invocationId}/SKILL.md` }] } : {}), stdin: 'brief-text', envNames: [] }),
  } } };
  fixtures.set(cwd, inputs);
  return inputs;
}
