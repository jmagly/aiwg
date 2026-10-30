// Mission Control worker operations, extracted from the shared handler.
import type { HandlerContext } from './types.js';

import { constants as fsConstants, promises as fs } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { assertValidWorkerPayload, workerConsumerSupport } from '../../mission-protocol/codecs.js';
import { WORKER_BASELINE_FEATURES, type WorkerArtifact, type WorkerBrief, type WorkerDispatch, type WorkerResult, type WorkerSelectionIntent, type WorkerUsage } from '../../mission-protocol/types.js';
import type { AiwgConfig } from '../../config/aiwg-config.js';
import { createMcAdmissionScheduler } from './mc-admission.js';
import { type Mission, type Session } from './mc-types.js';

/** Managed callers fail closed on invalid configuration; legacy reads keep their
 * historical best-effort behavior. No activation is installed by a caller. */
export async function readAdmissionConfig(projectRoot: string): Promise<AiwgConfig | null> {
  const { readAiwgConfig, readAiwgConfigCandidate } = await import('../../config/aiwg-config.js');
  try {
    return await readAiwgConfig(projectRoot);
  } catch (error) {
    const candidate = await readAiwgConfigCandidate(projectRoot);
    if (candidate?.parallelism?.worker_mode === 'managed') throw error;
    return null;
  }
}

export const mcWorkerSupport = () => workerConsumerSupport([...WORKER_BASELINE_FEATURES, 'worker-health.v1']);

export function workerDispatch(mission: Mission): WorkerDispatch | undefined {
  const bindings = new Set<WorkerDispatch>();
  const seen = new Set<object>();
  function visit(value: unknown): void {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (record['aiwg.worker-dispatch']) bindings.add(record['aiwg.worker-dispatch'] as WorkerDispatch);
    visit(record.extensions);
    visit(record.metadata);
    for (const [key, child] of Object.entries(record)) if (key.startsWith('aiwg.source.')) visit(child);
  }
  visit(mission);
  if (bindings.size > 1) throw new Error('Managed task contains multiple dispatch bindings');
  return [...bindings][0];
}

export async function readWorkerArtifact<T>(artifact: WorkerArtifact, projectRoot: string): Promise<T> {
  const filename = artifact.ref.startsWith('file:') ? fileURLToPath(artifact.ref) : artifact.ref;
  const inside = relative(projectRoot, filename);
  if (!isAbsolute(filename) || inside.startsWith('..') || isAbsolute(inside)) throw new Error('Managed worker artifacts must be inside the project');
  const bytes = await readWorkerBytes(filename);
  if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== artifact.digest) throw new Error('Managed worker artifact digest changed');
  return JSON.parse(bytes.toString('utf8')) as T;
}

export async function readWorkerBytes(filename: string): Promise<Buffer> {
  const { inspectWorkerPath } = await import('../../serve/worker-invocation.js');
  if (!await inspectWorkerPath(filename, 'file')) throw Object.assign(new Error('Managed worker artifact is missing'), { code: 'ENOENT' });
  const handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1048576) throw new Error('Invalid managed worker artifact');
    const bytes = Buffer.alloc(1048577);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 1048576) throw new Error('Managed worker artifact exceeds its size bound');
    return bytes.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

export async function readWorkerJson(filename: string) {
  return JSON.parse((await readWorkerBytes(filename)).toString('utf8'));
}

export async function resolveMcWorker(ctx: HandlerContext, session: Pick<Session, 'id'>, mission: Mission, parentKind: 'mission' | 'flow' = 'mission') {
  const dispatch = workerDispatch(mission);
  if (!dispatch) return undefined;
  const projectRoot = ctx.cwd || process.cwd();
  const intent = await readWorkerArtifact<WorkerSelectionIntent>(dispatch.intent, projectRoot);
  assertValidWorkerPayload('workerSelectionIntent', intent);
  if (!dispatch.brief) throw new Error('Managed worker requires a prepared brief');
  const brief = await readWorkerArtifact<WorkerBrief>(dispatch.brief, projectRoot);
  assertValidWorkerPayload('workerBrief', brief);
  const { workerConfigDigest } = await import('../../config/aiwg-config.js');
  if (intent.parent.kind !== parentKind || intent.parent.id !== session.id || intent.objective !== mission.objective
    || intent.taskId !== dispatch.taskId || intent.requestId !== dispatch.requestId
    || brief.invocationId !== dispatch.invocationId || workerConfigDigest(brief.intent) !== workerConfigDigest(intent)
    || brief.intentDigest !== workerConfigDigest(intent)) throw new Error('Managed worker task authority differs from its parent');
  const { loadWorkerInputs } = await import('./models.js');
  const { resolveWorkerInvocation } = await import('../../serve/worker-invocation.js');
  const inputs = await loadWorkerInputs(ctx);
  const plan = await resolveWorkerInvocation(inputs.snapshot, { role: intent.role, task: intent.taskClass, group: intent.group,
    brief: dispatch.brief.ref.startsWith('file:') ? fileURLToPath(dispatch.brief.ref) : dispatch.brief.ref,
    workdir: brief.workspace.path, final_output: brief.output.resultPath, managedIntent: intent }, inputs.drivers);
  if (!plan.invocation || plan.status !== 'eligible' || plan.invocation.readiness !== 'launchable') {
    throw new Error(`Managed worker is ineligible: ${plan.diagnostics.map(item => item.message).join('; ')}`);
  }
  if (parentKind === 'mission' && plan.invocation.transport !== 'shell') throw new Error('Managed Ralph capture requires a qualified shell transport');
  return { dispatch, intent, brief, plan };
}

/** Flow adapters use the same eligibility, project authority and allowance owner. */
export async function createMcFlowAdapter(ctx: HandlerContext, bindings: {
  prepareNode(request: { runId: string; node: { id: string } }): Promise<{ objective: string; dispatch: WorkerDispatch }>;
  invokeNode(request: unknown, context: unknown): Promise<unknown>;
}) {
  const cfg = await readAdmissionConfig(ctx.cwd);
  if (!cfg?.parallelism?.worker_dispatch || cfg.parallelism.worker_mode !== 'managed') {
    throw new Error('OG_CONTRACT_UNSUPPORTED: Flow shared dispatch requires managed mode');
  }
  const scheduler = await createMcAdmissionScheduler(ctx.cwd, cfg);
  const { managedAllowanceFromOwner } = await import('../../serve/shared-host-scheduler.js');
  const { createManagedCompositionAdapter } = await import(join(ctx.frameworkRoot, 'agentic/code/addons/composition-engine/lib/runtime.mjs'));
  return createManagedCompositionAdapter({ scheduler, allowanceFromOwner: managedAllowanceFromOwner,
    invokeNode: bindings.invokeNode,
    prepareNode: async (request: { runId: string; node: { id: string } }) => {
      const binding = await bindings.prepareNode(request);
      const worker = await resolveMcWorker(ctx, { id: request.runId }, {
        id: request.node.id, objective: binding.objective, status: 'queued', loop: 0,
        maxIterations: 1, priority: 'normal', mode: 'direct', extensions: { 'aiwg.worker-dispatch': binding.dispatch },
      }, 'flow');
      if (!worker || worker.intent.taskId !== request.node.id) throw new Error('Flow task authority differs from node identity');
      const selected = worker.plan.selected!;
      return { invocation: worker.plan.invocation, plan: worker.plan, brief: worker.brief,
        admission: { requestId: worker.dispatch.requestId, orchestratorId: request.runId,
          environment: process.env.AIWG_ENVIRONMENT ?? 'default', provider: selected.inferenceProvider, runtimeKind: 'host',
          priority: 10, submittedAt: new Date().toISOString(), queueTimeoutMs: (cfg.parallelism!.admission?.queueTimeoutSeconds ?? 300) * 1000,
          preemptible: false, metadata: { nodeId: request.node.id, invocationId: worker.dispatch.invocationId },
          managed: { kind: 'external', group: selected.group, member: selected.member, cli: selected.cli,
            model: selected.modelKey, quotaScope: cfg.parallelism!.clis![selected.cli].quotaScope },
          allowance: { runId: request.runId, taskId: request.node.id,
            taskBudgets: { maxAttempts: worker.intent.limits.maxAttempts, maxTokens: worker.intent.limits.tokens,
              maxCostUsd: worker.intent.limits.costUsd ?? undefined, timeoutSeconds: worker.intent.limits.wallSeconds },
            reservation: { tokens: worker.plan.invocation!.limits.tokens, costUsd: worker.plan.invocation!.limits.costUsd } },
        } };
    },
  });
}

/** Capture completion is evidence for the parent, never an independent gate. */
export async function readManagedWorkerState(mission: Mission, scheduler: Awaited<ReturnType<typeof createMcAdmissionScheduler>>) {
  const binding = mission.managedWorker!;
  const observation = await readWorkerJson(join(binding.runDir, 'health.json'));
  assertValidWorkerPayload('workerHealthSummary', observation.health);
  const dispatch = workerDispatch(mission)!;
  if (observation.invocationId !== dispatch.invocationId || observation.health.observerGeneration !== mission.admissionGeneration) {
    throw new Error('Stale managed worker observation');
  }
  let exit;
  try { exit = await readWorkerJson(join(binding.runDir, 'exit.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!exit) return { status: 'running', health: observation.health };
  if (exit.invocationId !== dispatch.invocationId || exit.managedAdmission?.requestId !== mission.admissionRequestId
    || exit.managedAdmission?.generation !== mission.admissionGeneration) throw new Error('Stale managed worker exit evidence');
  const record = scheduler.snapshot().records[mission.admissionRequestId!]!;
  const usage: WorkerUsage = { inputTokens: null, outputTokens: null, cacheTokens: null, reasoningTokens: null,
    costUsd: null, quality: 'unknown', reservedTokens: record.accounting!.reservation.tokens!,
    reservedUsd: record.accounting!.reservation.costUsd };
  const plan = await readWorkerJson(binding.invocationPath);
  const succeeded = exit.exitCode === 0 && !exit.errorCode && !exit.timedOut && !exit.cancelled;
  const result: WorkerResult = { version: 1, taskId: dispatch.taskId, invocationId: dispatch.invocationId,
    briefDigest: plan.invocation.briefDigest, worker: null,
    execution: { status: succeeded ? 'completed' : 'failed', exitCode: exit.exitCode,
      requested: plan.invocation.selected, observedModel: null, observedFamily: null, observedEffort: null,
      identityEvidence: [], identityQuality: 'unavailable', startedAt: mission.startedAt!, endedAt: exit.endedAt,
      termination: exit.termination, usage, failure: null, health: observation.health },
    verification: { status: 'pending', verifierId: null, runnerRef: null, artifactDigest: null, evidence: [], findings: [] } };
  try {
    const claims = await readWorkerJson(plan.invocation.finalPath);
    assertValidWorkerPayload('workerClaims', claims);
    result.worker = claims;
  } catch { /* Invalid or absent claims remain separate from execution evidence. */ }
  assertValidWorkerPayload('workerResult', result);
  // Use the checkpoint's own directory; request IDs need not contain a session ID.
  const destination = `${binding.invocationPath}.result.json`;
  const bytes = JSON.stringify(result);
  await fs.writeFile(destination, bytes, { mode: 0o600 });
  dispatch.result = { ref: pathToFileURL(destination).href, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
  scheduler.acceptFinal(mission.admissionRequestId!, mission.admissionGeneration!, observation.health, usage);
  // A surviving or unobservable outer supervisor cannot prove its own stop.
  let supervisorGone = false;
  try { process.kill(mission.admissionExecution!.pid, 0); }
  catch (error) { supervisorGone = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  if (supervisorGone && exit.termination === 'confirmed' && exit.descendants === 'stopped') {
    const settled = scheduler.settle(mission.admissionRequestId!, mission.admissionGeneration!, observation.health, usage, undefined, mission.admissionExecution);
    mission.admissionState = settled.state;
  }
  dispatch.state = mission.admissionState === 'settled' ? succeeded ? 'completed' : 'failed' : 'uncertain';
  // Verification and original completion criteria remain with the parent.
  return { status: succeeded && result.worker?.status === 'completed' ? 'paused' : 'failed', health: observation.health };
}
