import { emptyConfig, workerConfigDigest } from '../../src/config/aiwg-config.js';
import { DEFAULT_WORKER_SELECTION, loadProviderModelCapabilities, mergeWorkerSelection } from '../../src/models/provider-policy.js';
import type { WorkerPlanRequest, WorkerPlanSnapshot } from '../../src/models/resolver.js';
import type { WorkerModelObservation, WorkerSelectionPolicy } from '../../src/models/types.js';
import { fixtureJson } from '../conformance/mission-v1/worker-contract-fixtures.js';

/** Synthetic S1 snapshots only: never qualification of an installed provider. */
export function workerResolutionFixture() {
  const vectors = fixtureJson('shared-vectors.json');
  const observation: WorkerModelObservation = structuredClone(vectors.find((v: any) => v.id === 'observation-no-effort').value);
  observation.cliId = 'codex';
  observation.family = 'synthetic-family';
  observation.qualification = { status: 'qualified', roles: ['coding', 'reasoning', 'efficiency'], fixtureDigest: workerConfigDigest('synthetic-fixtures'), verifiedAt: observation.verifiedAt, evidenceRef: 'fixture:synthetic-only' };
  observation.effortSupport = 'explicit';
  observation.efforts = ['medium', 'high', 'ultra'].map(id => ({ id, selfDelegates: id === 'ultra' }));
  const adapter = structuredClone(vectors.find((v: any) => v.id === 'adapter-process-shape').value);
  adapter.qualification = { status: 'qualified', fixtureDigest: workerConfigDigest('synthetic-adapter'), verifiedAt: observation.verifiedAt, evidenceRef: 'fixture:synthetic-only' };
  adapter.capabilities.effort = 'explicit';
  adapter.capabilities.sandboxModes = ['read-only', 'workspace-write'];
  for (const control of Object.values(adapter.invocationProfiles['fixture-shell'].controls) as any[]) control.support = 'native';
  const registry = structuredClone(loadProviderModelCapabilities());
  registry.providers.codex.workerAdapter = adapter;
  const projectPolicy: WorkerSelectionPolicy = { roleGuidance: { coding: {
    groups: ['workers'], tier: 'standard', initialEffort: 'medium', effortLadder: ['medium', 'high'],
  } } };
  const merged = mergeWorkerSelection([
    { source: 'fixture:builtin', authority: 'builtin', digest: workerConfigDigest(null), policy: DEFAULT_WORKER_SELECTION },
    { source: 'fixture:project', authority: 'project', digest: workerConfigDigest(projectPolicy), policy: projectPolicy },
  ]);
  const snapshot: WorkerPlanSnapshot = {
    config: { ...emptyConfig(), parallelism: { worker_dispatch: true, max_parallel_subagents: 4,
      groups: { workers: { maxParallel: 2, members: [
        { id: 'primary', cli: 'codex', model: 'synthetic/a%b', roles: ['coding'], priority: 10 },
        { id: 'alternate', cli: 'codex', model: 'synthetic-alternate', roles: ['coding'], priority: 20 },
      ], fallback: ['alternate'] } } } },
    models: { defaults: { provider: 'codex', tier: 'standard', workerSelection: merged.policy },
      tiers: {} as any, providers: {}, agentRoleAssignments: {}, shorthand: {}, agentOverrides: {}, workerPolicyOrigins: merged.origins },
    modelDigests: { builtinModelsDigest: workerConfigDigest(null), userModelsDigest: workerConfigDigest(null), projectModelsDigest: workerConfigDigest(projectPolicy) },
    catalog: { version: '1.0.0', providers: {}, discovery: { source: 'native', fetchedAt: observation.fetchedAt, providers: {}, instances: {
      codex: { provider: 'codex', source: 'native', observedAt: observation.observedAt, runtimeVersion: '1.0.0',
        accountScope: 'local-account', accountBinding: 'synthetic', models: ['synthetic/a%b', 'synthetic-alternate'].map(id => ({
          id, apiModelId: id, llmProvider: 'vendor', reasoningEfforts: ['medium', 'high', 'ultra'], worker: structuredClone(observation),
        })) },
    } } },
    registry,
    installations: { codex: { cliVersion: '1.0.0', accountScope: 'synthetic', endpointFingerprint: 'fixture:loopback',
      profile: 'fixture-shell', identityEvidence: 'runtime-configured' } },
  };
  const request: WorkerPlanRequest = { taskClass: 'implementation', now: observation.observedAt,
    context: { estimator: 'synthetic-upper-bound-v1', briefTokens: 100, inputTokens: 200, toolOutputAllowance: 300, reservedOutput: 1000 } };
  return { snapshot, request, observation, projectPolicy };
}

/** Three required roles with no qualified observations (#3173). */
export function unqualifiedWorkerRolesFixture() {
  const f = workerResolutionFixture();
  const roles = ['efficiency', 'coding', 'reasoning'] as const;
  const group = f.snapshot.config.parallelism!.groups!.workers;
  group.requiredRoles = [...roles];
  group.members = roles.map(role => ({ id: role, cli: 'codex', model: 'synthetic/a%b', roles: [role] }));
  group.fallback = [];
  for (const role of roles) f.snapshot.models.defaults.workerSelection!.roleGuidance![role] =
    structuredClone(f.snapshot.models.defaults.workerSelection!.roleGuidance!.coding);
  for (const row of f.snapshot.catalog.discovery!.instances!.codex.models) {
    row.worker!.qualification.status = 'unqualified';
  }
  f.snapshot.installations = {};
  return f;
}
