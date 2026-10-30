// Mission Control run operations, extracted from the shared handler.
import type { HandlerContext, HandlerResult } from './types.js';
import * as ui from '../ui.js';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { assertMissionWorkerHandoff } from '../../mission-protocol/codecs.js';

import type { AiwgConfig } from '../../config/aiwg-config.js';
import { createMcAdmissionScheduler } from './mc-admission.js';
import { type Mission } from './mc-types.js';
import { SESSIONS_DIR, writeSession, appendLog, findActiveSession } from './mc-session.js';
import { hasFlag, getPositionalArgs } from './mc-args.js';
import { readAdmissionConfig, mcWorkerSupport, workerDispatch, resolveMcWorker } from './mc-worker.js';

import { managedControlFailure, cancelManagedMission } from './mc-control.js';

/**
 * Drain queued missions in a session by launching each as a ralph loop (#1439).
 *
 * Before this command existed, missions sat in `queued` status forever because
 * no supervisor process drained the queue. `mc run` is the explicit supervisor
 * step: for every queued direct-mode mission, spawn a detached ralph process
 * via launchExternalRalph(), record the resulting loopId + pid on the mission,
 * and flip the mission to `running`.
 *
 * Status sync back from ralph to mc happens lazily via syncMissionsFromRalph()
 * called from `mc status` and `mc watch` — no separate daemon needed.
 *
 * Limitations of cycle 1:
 * - pty-orchestrator missions are skipped with a warning (separate codepath)
 * - missions launch sequentially (each call to launchExternalRalph spawns a
 *   detached process, so they DO run in parallel after launch — the loop here
 *   is just for orderly dispatch, not for parallel scheduling)
 */
/**
 * Per-iteration cache-creation floor for a headless claude session (sonnet
 * baseline; opus is ~$3.90).
 */
export const SONNET_CACHE_USD = 1.60;

/** Estimate at or above which `mc run` warns and refuses in non-TTY contexts. */
export const COST_WARNING_THRESHOLD_USD = 5.0;

/**
 * Providers whose headless stream reports spend, so a declared `--max-total-cost`
 * ceiling can actually fire mid-loop.
 *
 * Only `claude` emits cost on its stream-json events, which is what
 * `SessionLauncher._extractUsageStats` reads. Adapters without stream-json
 * (codex, factory, opencode, deepseek) emit no usage events at all — #1766
 * recorded that a spend ceiling on those is inert and never fires. Adapters that
 * do stream JSON but have not been observed carrying cost fields (omp, pi) stay
 * out of this set deliberately: assuming an observability we have not seen would
 * weaken the gate in exactly the case where the operator has least protection.
 */
export const COST_REPORTING_PROVIDERS: ReadonlySet<string> = new Set(['claude']);

export interface MissionRunCostEstimate {
  /** Estimated cumulative spend, in USD, used for the warning threshold. */
  estimateUsd: number;
  /** Uncapped iteration floor, for comparison against `estimateUsd`. */
  iterationFloorUsd: number;
  /** Sum of every declared `maxTotalCost`, whether or not it can fire. */
  declaredCeilingUsd: number;
  /** Missions whose declared ceiling was applied to the estimate. */
  cappedMissions: number;
  /** Missions declaring a ceiling that cannot fire on this provider. */
  inertCeilingMissions: number;
  /** Whether the target provider reports spend. */
  spendObservable: boolean;
}

/**
 * Estimate cumulative spend for a set of queued missions (#2522).
 *
 * The floor for each mission is `maxIterations × SONNET_CACHE_USD`. A declared
 * `maxTotalCost` bounds that floor **only** when the target provider reports
 * spend — on a provider that reports none, the ceiling is inert (#1766), so
 * subtracting it would make the warning weaker precisely where the operator has
 * no enforced protection. Those ceilings are counted and surfaced instead.
 */
export function estimateMissionRunCost(
  missions: ReadonlyArray<Pick<Mission, 'maxIterations' | 'maxTotalCost'>>,
  provider: string,
): MissionRunCostEstimate {
  const spendObservable = COST_REPORTING_PROVIDERS.has(provider);
  let estimateUsd = 0;
  let iterationFloorUsd = 0;
  let declaredCeilingUsd = 0;
  let cappedMissions = 0;
  let inertCeilingMissions = 0;

  for (const mission of missions) {
    const floor = mission.maxIterations * SONNET_CACHE_USD;
    iterationFloorUsd += floor;
    const ceiling = typeof mission.maxTotalCost === 'number' && Number.isFinite(mission.maxTotalCost)
      ? mission.maxTotalCost
      : undefined;
    if (ceiling === undefined) {
      estimateUsd += floor;
      continue;
    }
    declaredCeilingUsd += ceiling;
    if (spendObservable) {
      cappedMissions += 1;
      estimateUsd += Math.min(floor, ceiling);
    } else {
      inertCeilingMissions += 1;
      estimateUsd += floor;
    }
  }

  return {
    estimateUsd,
    iterationFloorUsd,
    declaredCeilingUsd,
    cappedMissions,
    inertCeilingMissions,
    spendObservable,
  };
}

export async function mcRun(ctx: HandlerContext): Promise<HandlerResult> {
  const positional = getPositionalArgs(ctx.args);
  const sessionId = positional[0];
  const acceptCost = hasFlag(ctx.args, '--accept-cost');

  const session = await findActiveSession(sessionId);
  if (!session) {
    ui.error(sessionId ? `Session not found: ${sessionId}` : 'No active session. Run `aiwg mc start` first.');
    return { exitCode: 1 };
  }

  const queued = session.missions.filter((m) => m.status === 'queued');
  let cfg: AiwgConfig | null;
  try {
    cfg = await readAdmissionConfig(ctx.cwd || process.cwd());
    const support = cfg?.parallelism?.worker_dispatch && cfg.parallelism.worker_mode === 'managed' ? mcWorkerSupport() : undefined;
    assertMissionWorkerHandoff(session, 'mc-cli', support);
    for (const mission of queued) assertMissionWorkerHandoff(mission, 'mc-cli', support);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.error(message);
    return { exitCode: 1, message };
  }
  if (queued.length === 0) {
    ui.info(`No queued missions in session ${session.id}. Run \`aiwg mc dispatch ${session.id} "<objective>"\` to add one.`);
    return { exitCode: 0 };
  }

  // #1450 P0: cost warning gate, with declared ceilings honored (#2522).
  //
  // Each headless claude session pays a ~$1.60 cache-creation cost on iteration
  // 1 before any user-meaningful work (sonnet baseline; opus is ~$3.90). Across
  // N missions × M iterations the floor compounds quickly. Warn before launch
  // and refuse in non-TTY contexts unless --accept-cost is set.
  const eligible = queued.filter(m => m.mode !== 'pty-orchestrator' && !!m.completion);

  const projectRoot = ctx.cwd || process.cwd();
  const frameworkRoot = ctx.frameworkRoot;
  let scheduler: Awaited<ReturnType<typeof createMcAdmissionScheduler>>;
  try {
    scheduler = await createMcAdmissionScheduler(projectRoot, cfg);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.error(message);
    return { exitCode: 1, message };
  }
  const provider = cfg?.providers[0] ?? 'unknown';

  const estimate = estimateMissionRunCost(eligible, provider);

  if (estimate.estimateUsd >= COST_WARNING_THRESHOLD_USD && !acceptCost) {
    ui.blank();
    ui.warn(`Cost estimate: ~$${estimate.estimateUsd.toFixed(2)} (${eligible.length} missions × iteration floors × ~$${SONNET_CACHE_USD.toFixed(2)} cache cost per claude headless iter).`);
    if (estimate.cappedMissions > 0) {
      ui.warn(`Declared ceilings: $${estimate.declaredCeilingUsd.toFixed(2)} across ${estimate.cappedMissions} mission(s) — counted toward the estimate because ${provider} reports spend.`);
    }
    if (estimate.inertCeilingMissions > 0) {
      ui.warn(`${estimate.inertCeilingMissions} mission(s) declare --max-total-cost totalling $${estimate.declaredCeilingUsd.toFixed(2)}, but ${provider} does not report spend — those ceilings cannot fire and are NOT subtracted from this estimate (#1766).`);
    }
    ui.warn('Actual spend may be lower if missions complete early, higher if model is opus or context grows.');
    if (!process.stdout.isTTY) {
      ui.error('Refusing to launch in non-interactive context. Re-run with `--accept-cost` to proceed.');
      return { exitCode: 1 };
    }
    // TTY path: surface the warning and continue. A future revision should
    // prompt y/N here; for now the warning is informational and the operator
    // can Ctrl+C before launches actually begin.
    ui.info('Continuing (TTY). Use Ctrl+C to abort within the next 2 seconds.');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  ui.blank();
  console.log(`  ${ui.brandMark()} ${ui.bold('Mission Control')} — running ${queued.length} queued mission(s) in ${ui.accent(session.id)}`);
  ui.rule();

  // Lazy import — ralph-launcher pulls in node:child_process and other heavy
  // deps we don't want to pay for on every mc subcommand.
  const { launchExternalRalph } = await import('./ralph-launcher.js');

  let launched = 0;
  let skipped = 0;
  let failed = 0;
  const managed = cfg?.parallelism?.worker_dispatch && cfg.parallelism.worker_mode === 'managed';
  const allowanceOwner = managed ? await import('../../serve/shared-host-scheduler.js') : null;

  // Qualify every worker before admission; one parent retains completion gates.
  const workers = new Map<string, Awaited<ReturnType<typeof resolveMcWorker>>>();
  try {
    for (const mission of queued) if (workerDispatch(mission)) workers.set(mission.id, await resolveMcWorker(ctx, session, mission));
  } catch (error) { return managedControlFailure(error); }

  for (const mission of queued) {
    const worker = workers.get(mission.id);
    if (mission.mode === 'pty-orchestrator') {
      ui.warn(`Mission ${mission.id} mode=pty-orchestrator is not yet wired to mc run; skipping. Use 'aiwg ralph' directly for PTY-orchestrator workflows.`);
      skipped += 1;
      continue;
    }

    if (!mission.completion) {
      ui.warn(`Mission ${mission.id} has no --completion criteria; ralph requires one. Skipping. Re-dispatch with --completion "<criteria>" to include this mission.`);
      skipped += 1;
      continue;
    }

    const admissionRequestId = mission.admissionState === 'released'
      ? `${session.id}.${mission.id}.${Date.now().toString(36)}`
      : mission.admissionRequestId ?? worker?.dispatch.requestId ?? `${session.id}.${mission.id}`;
    const admissionSubmittedAt = mission.admissionState === 'released'
      ? new Date().toISOString()
      : mission.admissionSubmittedAt ?? new Date().toISOString();
    const admission = scheduler.submit({
      requestId: admissionRequestId,
      orchestratorId: session.id,
      environment: process.env.AIWG_ENVIRONMENT ?? 'default',
      provider: worker?.plan.invocation?.selected.inferenceProvider ?? provider,
      runtimeKind: 'host',
      priority: mission.priority === 'critical' ? 100 : mission.priority === 'high' ? 50 : mission.priority === 'low' ? 0 : 10,
      submittedAt: admissionSubmittedAt,
      queueTimeoutMs: managed ? (cfg?.parallelism?.admission?.queueTimeoutSeconds ?? 300) * 1000 : 24 * 60 * 60_000,
      preemptible: false,
      metadata: { missionId: mission.id, ...(worker ? { invocationId: worker.dispatch.invocationId } : {}) },
      ...(managed ? { managed: worker ? { kind: 'external' as const, group: worker.plan.selected!.group,
        member: worker.plan.selected!.member, cli: worker.plan.selected!.cli, model: worker.plan.selected!.modelKey,
        quotaScope: cfg!.parallelism!.clis![worker.plan.selected!.cli].quotaScope } : { kind: 'native' as const },
        allowance: worker ? { runId: session.id, taskId: worker.intent.taskId,
          taskBudgets: { maxAttempts: Math.min(worker.intent.limits.maxAttempts, mission.maxIterations),
            maxTokens: Math.min(worker.intent.limits.tokens, mission.maxTotalTokens ?? Infinity),
            maxCostUsd: worker.intent.limits.costUsd === null ? mission.maxTotalCost
              : Math.min(worker.intent.limits.costUsd, mission.maxTotalCost ?? Infinity),
            timeoutSeconds: Math.min(worker.intent.limits.wallSeconds, (mission.maxWallClockMinutes ?? Infinity) * 60) },
          reservation: { tokens: worker.plan.invocation!.limits.tokens, costUsd: worker.plan.invocation!.limits.costUsd },
        } : allowanceOwner!.managedAllowanceFromOwner(session.id, mission.id, {
          kind: 'ralph', maxIterations: mission.maxIterations, maxTotalTokens: mission.maxTotalTokens,
          maxTotalCost: mission.maxTotalCost, maxWallClockMinutes: mission.maxWallClockMinutes,
        }),
      } : {}),
    });
    mission.admissionRequestId = admissionRequestId;
    mission.admissionSubmittedAt = admissionSubmittedAt;
    mission.admissionState = admission.state;
    mission.admissionLeaseExpiresAt = admission.leaseExpiresAt;
    if (managed) mission.admissionGeneration = admission.leaseGeneration;
    await writeSession(session);
    if (admission.state !== 'admitted') {
      await appendLog(session.id, {
        event: 'mission_admission_queued',
        missionId: mission.id,
        admissionRequestId,
        reason: admission.reason,
      });
      ui.info(`Queued ${mission.id}: ${admission.reason}`);
      skipped += 1;
      continue;
    }

    try {
      let maxWallClockMinutes = mission.maxWallClockMinutes;
      if (managed) {
        const scopes = scheduler.snapshot().allowances!;
        const deadlines = [scopes[admission.accounting!.runKey]!.deadlineAt, scopes[admission.accounting!.taskKey]!.deadlineAt]
          .filter((value): value is string => value !== undefined).map(Date.parse);
        const remainingMs = Math.min(...deadlines) - Date.now();
        if (remainingMs <= 0) throw new Error('cumulative allowance deadline elapsed before launch');
        maxWallClockMinutes = deadlines.length ? remainingMs / 60_000 : undefined;
      }
      if (worker) {
        if (worker.brief.lease.generation !== mission.admissionGeneration || worker.brief.lease.reservationId !== admissionRequestId
          || worker.brief.lease.authorityRef !== 'project') throw new Error('Managed brief lease differs from current admission');
        const invocationPath = join(projectRoot, SESSIONS_DIR, session.id, `${mission.id}.invocation.json`);
        const runDir = join(projectRoot, SESSIONS_DIR, session.id, `${mission.id}.run`);
        await fs.writeFile(invocationPath, JSON.stringify(worker.plan), { mode: 0o600 });
        mission.managedWorker = { invocationPath, runDir };
      }
      if (managed) {
        scheduler.claimLaunch(admissionRequestId, mission.admissionGeneration!);
        mission.admissionLaunchClaimed = true;
        await writeSession(session);
      }
      const result = await launchExternalRalph(frameworkRoot, projectRoot, {
        objective: mission.objective,
        completionCriteria: mission.completion,
        maxIterations: managed ? admission.accounting!.attemptCount : mission.maxIterations,
        maxTotalTokens: managed ? admission.accounting!.reservation.tokens ?? undefined : mission.maxTotalTokens,
        maxOutputTokens: mission.maxOutputTokens,
        maxToolCalls: mission.maxToolCalls,
        maxTotalCost: managed ? admission.accounting!.reservation.costUsd ?? undefined : mission.maxTotalCost,
        maxWallClockMinutes,
        explorationQuota: mission.explorationQuota,
        budgetStopPolicy: mission.budgetStopPolicy,
        // Defaults for cycle 1; advanced options can be added per-mission later.
        verbose: false,
        ...(managed ? { managedAdmission: { requestId: admissionRequestId, generation: mission.admissionGeneration! } } : {}),
        ...(worker ? { managedWorker: mission.managedWorker } : {}),
      });

      if (managed) {
        if (!result.execution || result.execution.pid !== result.pid) throw new Error('managed launch requires its OS process birth identity');
        scheduler.bindExecution(admissionRequestId, mission.admissionGeneration!, result.execution);
        mission.admissionExecution = result.execution;
        mission.ralphLoopId = result.loopId;
        mission.ralphPid = result.pid;
        const current = scheduler.renew(admissionRequestId, mission.admissionGeneration);
        if (current.state !== 'admitted') {
          await cancelManagedMission(ctx, scheduler, mission);
          throw new Error('managed launch lost admission during execution checkpoint; reconcile uncertain work');
        }
      }
      mission.status = 'running';
      if (worker) worker.dispatch.state = 'running';
      mission.startedAt = new Date().toISOString();
      mission.ralphLoopId = result.loopId;
      mission.ralphPid = result.pid;
      await writeSession(session);
      await appendLog(session.id, {
        event: 'mission_started',
        missionId: mission.id,
        loopId: result.loopId,
        pid: result.pid,
      });

      ui.success(`Started ${mission.id} → ralph loop ${result.loopId} (PID ${result.pid})`);
      launched += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      mission.status = 'failed';
      mission.error = msg;
      mission.completedAt = new Date().toISOString();
      if (managed) mission.admissionState = scheduler.stop(admissionRequestId, mission.admissionGeneration!, 'observer-loss').state;
      else {
        scheduler.release(admissionRequestId);
        mission.admissionState = 'released';
      }
      mission.admissionLeaseExpiresAt = undefined;
      await writeSession(session);
      await appendLog(session.id, {
        event: 'mission_launch_failed',
        missionId: mission.id,
        error: msg,
      });
      ui.error(`Failed to start ${mission.id}: ${msg}`);
      failed += 1;
    }
  }

  ui.blank();
  ui.info(`Launched: ${launched} | Skipped: ${skipped} | Failed: ${failed}`);
  if (launched > 0) {
    ui.info(`Monitor: \`aiwg mc status ${session.id}\` or \`aiwg mc watch ${session.id}\``);
  }

  return { exitCode: failed > 0 && launched === 0 ? 1 : 0 };
}
