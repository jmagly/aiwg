import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workerActivationDigests, workerConfigDigest } from '../../src/config/aiwg-config.js';
import { assertValidWorkerPayload } from '../../src/mission-protocol/codecs.js';
import { WORKER_BASELINE_FEATURES, type WorkerArtifact, type WorkerBrief, type WorkerDispatch, type WorkerSelectionIntent, type WorkerTuple } from '../../src/mission-protocol/types.js';
import { resolveWorkerPlan } from '../../src/models/resolver.js';
import { resolveWorkerInvocation, type WorkerInvocationDriver } from '../../src/serve/worker-invocation.js';
import { workerResolutionFixture } from './worker-resolution.js';
import { workerInputSchema } from './ralph-worker-protocol.mjs';

/** Offline managed task with real artifact bytes and a nonspawning renderer. */
export async function managedMcWorkerFixture(root: string, options: {
  sessionId?: string; missionId?: string; objective?: string; now?: string; parentKind?: 'mission' | 'flow' | 'ralph'; transport?: 'shell' | 'mcp';
} = {}) {
  const f = workerResolutionFixture();
  const now = options.now ?? f.request.now;
  const sessionId = options.sessionId ?? 'mc-synthetic';
  const missionId = options.missionId ?? 'm-synthetic';
  const objective = options.objective ?? 'synthetic';
  const refresh = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['observedAt', 'fetchedAt', 'verifiedAt', 'qualifiedAt', 'collectedAt'].includes(key) && typeof child === 'string') {
        (value as Record<string, unknown>)[key] = now;
      } else refresh(child);
    }
  };
  refresh(f.snapshot);
  f.request.now = now;
  f.snapshot.models.defaults.workerSelection!.dataClasses = { public: {} };
  const cfg = f.snapshot.config;
  const transport = options.transport ?? 'shell';
  if (transport === 'mcp') cfg.parallelism!.groups!.workers.execution = { transport };
  cfg.providers = ['codex'];
  Object.assign(cfg.parallelism!, { worker_mode: 'managed', max_parallel_subagents: 1,
    clis: { codex: { adapter: 'providers:codex', accountScope: 'synthetic', quotaScope: 'synthetic-quota' } },
    admission: { maxQueued: 4, queueTimeoutSeconds: 60 } });
  for (const row of f.snapshot.catalog.discovery!.instances!.codex.models) row.worker!.contextTokens = 32768;
  cfg.parallelism!.activation = { revision: 1, ...workerActivationDigests(cfg), ...f.snapshot.modelDigests,
    snapshotRef: 'fixture:managed-activation' };
  await mkdir(join(root, '.aiwg'), { recursive: true });
  await writeFile(join(root, '.aiwg/aiwg.config'), JSON.stringify(cfg));
  const paths = { workdir: join(root, 'work'), brief: join(root, 'work', 'brief.json'),
    intent: join(root, 'work', 'intent.json'), decision: join(root, 'work', 'decision.json'),
    dispatch: join(root, 'dispatch.json'), final: join(root, 'work', 'final.json'), runDir: join(root, 'run') };
  await mkdir(paths.workdir, { recursive: true });
  const adapter = f.snapshot.registry.providers.codex.workerAdapter!;
  const profile = adapter.invocationProfiles!['fixture-shell'];
  const inputSchema = structuredClone(workerInputSchema);
  const outputSchema = { type: 'object' };
  const schemaDigest = (schema: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(schema)).digest('hex')}`;
  if (transport === 'mcp') {
    profile.transport = transport;
    profile.mcp = { serverRef: 'fixture-server', tool: 'fixture-worker', inputSchemaDigest: schemaDigest(inputSchema),
      outputSchemaDigest: schemaDigest(outputSchema), sessionIsolation: 'per-call', cancel: 'uncertain' };
    f.snapshot.installations.codex.mcp = profile.mcp;
  }
  const boundary = { kind: 'os' as const, identity: 'fixture:boundary', digest: workerConfigDigest('boundary'), controls: ['sandbox'] };
  f.snapshot.installations.codex.boundary = boundary;
  const driver: WorkerInvocationDriver = {
    qualification: { adapter, adapterId: adapter.id, cliVersion: '1.0.0', boundary,
      ...(transport === 'mcp' ? { mcp: profile.mcp, mcpSchemas: { input: inputSchema, output: outputSchema } } : {}) },
    buildInvocation: async input => transport === 'shell' ? { argv: ['/synthetic/worker', '--model', input.selected.model,
      '--final-output', input.finalPath], stdin: 'closed', envNames: [] } : { mcp: {
        serverRef: profile.mcp!.serverRef, tool: profile.mcp!.tool, inputSchemaDigest: profile.mcp!.inputSchemaDigest,
        outputSchemaDigest: profile.mcp!.outputSchemaDigest, sessionIsolation: profile.mcp!.sessionIsolation,
        arguments: { invocationId: `${missionId}-invocation`, workspace: input.cwd,
          selection: { provider: input.selected.inferenceProvider, model: input.selected.model, effort: input.selected.effort.value },
          brief: input.brief }, timeoutSeconds: input.limits.wallSeconds,
      } },
    ...(transport === 'mcp' ? { mcpRegistry: { get: async name => ({ name, type: 'stdio' as const, command: 'fixture-only' }) },
      mcpProfile: { servers: ['fixture-server'] } } : {}),
  };
  const drivers = { codex: driver };
  const request = { role: 'coding' as const, task: 'implementation', group: 'workers',
    brief: paths.brief, workdir: paths.workdir, final_output: paths.final };
  const initial = resolveWorkerPlan(f.snapshot, { ...f.request, role: 'coding', taskClass: 'implementation', group: 'workers' });
  if (!initial.selected) throw new Error(`Synthetic worker selection failed: ${JSON.stringify(initial.diagnostics)}`);
  const tuple = initial.selected;
  const selected: WorkerTuple = { group: tuple.group, member: tuple.member, cli: tuple.cli, model: tuple.model,
    inferenceProvider: tuple.inferenceProvider, family: tuple.family,
    effort: { support: tuple.effort === null ? 'not-applicable' : 'explicit', value: tuple.effort }, profileRef: tuple.profile,
    qualificationDigest: adapter.invocationProfiles![tuple.profile].installationQualification?.scopeDigest ?? adapter.qualification.fixtureDigest! };
  const intent: WorkerSelectionIntent = { version: 1, taskId: missionId, requestId: `${sessionId}.${missionId}`,
    parent: { kind: options.parentKind ?? 'mission', id: sessionId }, objective, taskClass: 'implementation', role: 'coding',
    inputs: [], ownership: [], requiredTools: [], dataClass: 'public', group: 'workers',
    pins: { member: selected.member, model: selected.model, effort: selected.effort }, allowFallback: false,
    limits: { tokens: 50000, costUsd: null, wallSeconds: 900, maxAttempts: 2 },
    acceptance: [{ id: 'synthetic-check', criterion: 'independent checks pass', checkRef: 'fixture:independent-check' }],
    verification: { runnerRef: 'fixture:independent-check', independentReview: 'required', differentFamily: 'prefer' } };
  const artifact = async (filename: string, value: unknown): Promise<WorkerArtifact> => {
    const bytes = JSON.stringify(value);
    await writeFile(filename, bytes);
    return { ref: filename, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
  };
  const decision = await artifact(paths.decision, initial.choice);
  const brief: WorkerBrief = { version: 1, invocationId: `${missionId}-invocation`, intent,
    intentDigest: workerConfigDigest(intent), decision, policyDigest: workerConfigDigest([initial.digests.configDigest, initial.digests.resolvedModelsDigest]),
    catalogDigest: initial.digests.catalogDigest, selected,
    lease: { authorityRef: 'project', generation: 1, reservationId: intent.requestId },
    workspace: { path: paths.workdir, baseRevision: null }, authorizationRefs: [], delegationAllowance: 0,
    output: { schemaRef: 'https://aiwg.io/schemas/mission.aiwg.io/v1#/$defs/workerClaims', resultPath: paths.final } };
  const dispatch: WorkerDispatch = { version: 1, requiredFeatures: [...WORKER_BASELINE_FEATURES, 'worker-health.v1'],
    taskId: intent.taskId, requestId: intent.requestId, invocationId: brief.invocationId, state: 'queued',
    intent: await artifact(paths.intent, intent), brief: await artifact(paths.brief, brief), result: null, previousRecord: null };
  for (const [definition, value] of [['workerSelectionIntent', intent], ['workerBrief', brief], ['workerDispatch', dispatch]] as const) {
    assertValidWorkerPayload(definition, value);
  }
  await writeFile(paths.dispatch, JSON.stringify(dispatch));
  const managedRequest = { ...request, managedIntent: intent };
  const plan = await resolveWorkerInvocation(f.snapshot, managedRequest, drivers, now);
  if (!plan.invocation) throw new Error(`Synthetic managed resolution failed: ${JSON.stringify({ diagnostics: plan.diagnostics, exclusions: plan.exclusions })}`);
  return { ...f, cfg, drivers, request: managedRequest, now, intent, brief, dispatch, plan, paths };
}
