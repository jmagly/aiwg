// Run optional Ralph group cycles through the existing resolver and admission owner.
import { constants } from 'node:fs';
import { open, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { importImpl } from '../../_resolve-impl.mjs';
import { sampleWorkerIdentity } from '../process-monitor.mjs';
import { managedAttemptBindings } from './managed-worker-attempt.mjs';
import { changedBindings, persistCycleAttempt } from './session-attempt.mjs';

async function readBrief(filename, inspect) {
  await inspect(filename, 'file');
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 262144) throw new Error('Invalid Ralph group brief');
    const bytes = Buffer.alloc(262145);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 262144) throw new Error('Ralph group brief exceeds bound');
    return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
  } finally { await handle.close(); }
}

export function groupCycleAllowance(state, intent, invocation, previousRequestId) {
  const budget = state.config.budgetLimits ?? {};
  const limits = {
    maxAttempts: Math.min(intent.limits.maxAttempts, state.maxIterations),
    maxTokens: Math.min(intent.limits.tokens, budget.total_tokens ?? Infinity),
    maxCostUsd: intent.limits.costUsd === null ? budget.spend_usd
      : Math.min(intent.limits.costUsd, budget.spend_usd ?? Infinity),
    timeoutSeconds: Math.min(intent.limits.wallSeconds, (budget.wall_clock_minutes ?? Infinity) * 60),
  };
  const original = state.groupAllowance ??= { runId: intent.parent.id, taskId: intent.taskId, limits,
    // Include time spent before first admission in the original parent deadline.
    deadlineAt: new Date(Date.parse(state.startTime) + limits.timeoutSeconds * 1000).toISOString() };
  if (original.runId !== intent.parent.id || original.taskId !== intent.taskId) throw new Error('Ralph group allowance identity changed');
  const timeoutSeconds = Math.min(limits.timeoutSeconds, original.limits.timeoutSeconds,
    (Date.parse(original.deadlineAt) - Date.now()) / 1000);
  if (timeoutSeconds <= 0) throw new Error('Ralph group original deadline elapsed');
  // The scheduler keeps the first startedAt/deadline. Do not pass remaining
  // duration on later attempts: that would subtract elapsed time twice.
  original.admissionTimeoutSeconds ??= timeoutSeconds;
  return { runId: original.runId, taskId: original.taskId,
    runBudgets: { ...limits, timeoutSeconds: original.admissionTimeoutSeconds },
    taskBudgets: { ...limits, timeoutSeconds: original.admissionTimeoutSeconds },
    ...(previousRequestId ? { previousRequestId, purpose: 'quality' } : { purpose: 'initial' }),
    reservation: { tokens: invocation.limits.tokens, costUsd: invocation.limits.costUsd } };
}

export async function prepareGroupCycle(owner, state, options) {
  const { loadWorkerInputs } = await importImpl(import.meta.url, 'cli/handlers/models.js');
  const { resolveWorkerInvocation, inspectWorkerPath } = await importImpl(import.meta.url, 'serve/worker-invocation.js');
  const { assertValidWorkerPayload } = await importImpl(import.meta.url, 'mission-protocol/codecs.js');
  const { qualificationDigest } = await importImpl(import.meta.url, 'models/qualification-digest.mjs');
  const { createMcAdmissionScheduler } = await importImpl(import.meta.url, 'cli/handlers/mc.js');
  const { loadLauncherRegistry, saveLauncherRegistry } = await importImpl(import.meta.url, 'cli/handlers/ralph-launcher.js');
  const request = structuredClone(state.config.groupWorker);
  const loadInputs = () => loadWorkerInputs({ cwd: owner.projectRoot, args: [], rawArgs: [],
    frameworkRoot: fileURLToPath(new URL('../../../', import.meta.url)) });
  const inputs = await loadInputs();
  const brief = await readBrief(request.brief, inspectWorkerPath);
  assertValidWorkerPayload('workerBrief', brief);
  const intent = request.managedIntent;
  assertValidWorkerPayload('workerSelectionIntent', intent);
  if (intent.parent.kind !== 'ralph' || intent.parent.id !== state.loopId || intent.objective !== state.objective
    || qualificationDigest(intent) !== brief.intentDigest || qualificationDigest(brief.intent) !== brief.intentDigest) {
    throw new Error('Ralph group task authority differs from its parent');
  }
  const previous = state.currentAttempt;
  const attemptId = randomUUID();
  const requestId = `${state.loopId}.${attemptId}`;
  intent.requestId = requestId;
  const ownerBudget = state.config.budgetLimits ?? {};
  intent.limits.tokens = Math.min(intent.limits.tokens, ownerBudget.total_tokens ?? Infinity);
  intent.limits.maxAttempts = Math.min(intent.limits.maxAttempts, state.maxIterations);
  intent.limits.wallSeconds = Math.min(intent.limits.wallSeconds, (ownerBudget.wall_clock_minutes ?? Infinity) * 60);
  if (ownerBudget.spend_usd !== undefined) intent.limits.costUsd = Math.min(intent.limits.costUsd ?? Infinity, ownerBudget.spend_usd);
  brief.intent = intent; brief.intentDigest = qualificationDigest(intent);
  brief.invocationId = attemptId;
  brief.lease = { authorityRef: inputs.snapshot.config.parallelism.admission?.authorityRef ?? 'project', generation: 1, reservationId: requestId };
  brief.output.resultPath = join(dirname(brief.output.resultPath), `${attemptId}.final.json`);
  request.final_output = brief.output.resultPath;
  request.brief = join(dirname(request.brief), `${attemptId}.brief.json`);
  await inspectWorkerPath(request.brief, 'output');
  await writeFile(request.brief, JSON.stringify(brief), { mode: 0o600, flag: 'wx' });
  const plan = await resolveWorkerInvocation(inputs.snapshot, request, inputs.drivers);
  const { workerRoutingRecord } = await importImpl(import.meta.url, 'models/worker-routing-record.js');
  if (plan.selected) await writeFile(join(options.outputDir, 'routing.json'), JSON.stringify(workerRoutingRecord('ralph', intent.taskId, plan, inputs.snapshot, state.config.workerTier, request.authority)) + '\n');
  const bindings = managedAttemptBindings(plan);
  const original = previous?.originalBindings ?? bindings;
  const attempt = { attemptId, previousAttemptId: previous?.attemptId ?? null, requestId,
    kind: 'fresh', reason: 'one-shot-profile', bindings, originalBindings: original,
    changes: changedBindings(original, bindings), status: 'prepared' };
  persistCycleAttempt(owner, state, options.outputDir, attempt);
  if (!inputs.snapshot.config.parallelism?.worker_dispatch || plan.mode !== 'managed'
    || !plan.invocation || plan.status !== 'eligible' || plan.invocation.readiness !== 'launchable'
    || plan.invocation.transport !== 'shell') {
    attempt.status = 'blocked'; attempt.diagnostics = plan.diagnostics;
    persistCycleAttempt(owner, state, options.outputDir, attempt);
    throw new Error('Ralph group request requires a current launchable shell invocation');
  }
  const loopId = process.env.RALPH_LOOP_ID ?? state.loopId;
  const registry = loadLauncherRegistry(owner.projectRoot);
  const inherited = registry.loops[loopId]?.managedAdmission;
  if (inherited && inherited.requestId !== previous?.requestId) {
    throw new Error('Ralph group cannot replace an inherited parent reservation; use its existing worker owner');
  }
  const scheduler = await createMcAdmissionScheduler(owner.projectRoot, inputs.snapshot.config);
  const selected = plan.selected;
  let admission = scheduler.submit({ requestId, orchestratorId: intent.parent.id,
    environment: process.env.AIWG_ENVIRONMENT ?? 'default', provider: selected.inferenceProvider, runtimeKind: 'host',
    priority: 10, submittedAt: new Date().toISOString(),
    queueTimeoutMs: (inputs.snapshot.config.parallelism.admission?.queueTimeoutSeconds ?? 300) * 1000,
    metadata: { invocationId: attemptId }, managed: { kind: 'external', group: selected.group,
      member: selected.member, cli: selected.cli, model: selected.modelKey,
      quotaScope: inputs.snapshot.config.parallelism.clis[selected.cli].quotaScope },
    allowance: groupCycleAllowance(state, intent, plan.invocation, previous?.requestId) });
  attempt.admission = { requestId, generation: admission.leaseGeneration };
  attempt.admissionState = admission.state;
  persistCycleAttempt(owner, state, options.outputDir, attempt);
  // Poll the same queued reservation; neither admission nor a nested retry
  // may mint another task identity or restart the parent deadline.
  while (admission.state === 'queued' && !owner.aborted) {
    await new Promise(resolve => setTimeout(resolve, 250));
    admission = scheduler.reconcileNow().records[requestId];
  }
  if (owner.aborted) admission = scheduler.cancel(requestId, admission.leaseGeneration);
  attempt.admissionState = admission.state;
  persistCycleAttempt(owner, state, options.outputDir, attempt);
  if (admission.state !== 'admitted') throw new Error(`Ralph group admission ${admission.state}: ${admission.reason}`);
  const invocationPath = join(options.outputDir, 'worker-plan.json');
  const runDir = join(options.outputDir, 'worker-run');
  await writeFile(invocationPath, JSON.stringify(plan), { mode: 0o600, flag: 'wx' });
  registry.loops[loopId] = { ...registry.loops[loopId], loopId, pid: process.pid, objective: state.objective,
    completionCriteria: state.completionCriteria, status: 'running', startedAt: state.startTime,
    lastUpdate: new Date().toISOString(), iteration: state.currentIteration, maxIterations: state.maxIterations,
    outputFile: options.stdoutPath, managedAdmission: attempt.admission, managedWorker: { invocationPath, runDir } };
  saveLauncherRegistry(owner.projectRoot, registry);
  scheduler.claimLaunch(requestId, admission.leaseGeneration);
  const identity = sampleWorkerIdentity(process.pid);
  if (!identity?.bootId || !identity.startTicks) throw new Error('Ralph group supervisor birth identity unavailable');
  const execution = { pid: process.pid, startedAt: `${identity.bootId}:${identity.startTicks}:${identity.uid}` };
  scheduler.bindExecution(requestId, admission.leaseGeneration, execution);
  return { ...options, projectRoot: owner.projectRoot, invocationPath, runDir, managedAdmission: attempt.admission, loopId, attempt,
    inputs, loadInputs, scheduler, execution, invocation: plan.invocation };
}

export async function launchGroupCycle(owner, state, options) {
  const { scheduler, managedAdmission: admission, execution } = options;
  options.cycleDeadlineAtMs = Math.min(Date.parse(state.groupAllowance.deadlineAt), Date.now() + options.timeoutMs);
  const leaseMs = (options.inputs.snapshot.config.parallelism.admission?.leaseSeconds ?? 60) * 1000;
  const timer = setInterval(() => {
    try {
      if (scheduler.renew(admission.requestId, admission.generation).state !== 'admitted') owner.sessionLauncher.workerStop?.();
    } catch { owner.sessionLauncher.workerStop?.(); }
  }, Math.max(1, Math.floor(leaseMs / 3)));
  const deadlineTimer = setTimeout(() => owner.sessionLauncher.workerStop?.(), Math.max(0, options.cycleDeadlineAtMs - Date.now()));
  try {
    const result = await owner.sessionLauncher.launchWorker(options);
    const usage = { quality: 'unknown', inputTokens: null, outputTokens: null, cacheTokens: null, reasoningTokens: null,
      costUsd: null, reservedTokens: options.invocation.limits.tokens, reservedUsd: options.invocation.limits.costUsd };
    const settled = scheduler.settle(admission.requestId, admission.generation, result.health ?? null, usage, undefined, execution);
    options.attempt.status = settled.state;
    persistCycleAttempt(owner, state, options.outputDir, options.attempt);
    await copyFile(options.invocation.stdoutPath, options.stdoutPath);
    await copyFile(options.invocation.stderrPath, options.stderrPath);
    return { ...result, attempt: options.attempt, stdoutPath: options.stdoutPath, stderrPath: options.stderrPath };
  } finally { clearInterval(timer); clearTimeout(deadlineTimer); }
}
