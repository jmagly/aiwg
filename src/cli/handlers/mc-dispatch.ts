// Mission Control dispatch operations, extracted from the shared handler.
import type { HandlerContext, HandlerResult } from './types.js';
import * as ui from '../ui.js';

import { isAbsolute, relative } from 'node:path';

import { createHash } from 'node:crypto';
import { assertMissionWorkerHandoff } from '../../mission-protocol/codecs.js';
import { type WorkerDispatch } from '../../mission-protocol/types.js';

import { type MissionMode, type Mission, type Session } from './mc-types.js';
import { genId, writeSession, appendLog, mutateSession, mutationFlags, mutationFailure, findActiveSession } from './mc-session.js';
import { parseFlag, parseNumberFlag, getPositionalArgs } from './mc-args.js';

import { readAdmissionConfig, mcWorkerSupport, readWorkerJson, resolveMcWorker } from './mc-worker.js';
import { managedControlFailure } from './mc-control.js';

// ── Subcommand handlers ──────────────────────────────────────

export async function mcStart(ctx: HandlerContext): Promise<HandlerResult> {
  const name = parseFlag(ctx.args, '--name') || `Mission ${new Date().toISOString().slice(0, 10)}`;
  const maxMissions = parseInt(parseFlag(ctx.args, '--max-missions') || '10', 10);

  const session: Session = {
    id: genId('mc'),
    name,
    state: 'active',
    maxMissions,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    missions: [],
  };

  await writeSession(session);
  await appendLog(session.id, { event: 'session_started', name, maxMissions });

  ui.blank();
  console.log(`  ${ui.brandMark()} ${ui.bold('Mission Control')} — ${ui.accent(name)}`);
  ui.rule();
  ui.success(`Session started: ${session.id}`);
  ui.info(`Max missions: ${maxMissions}`);
  // #1439: the lifecycle is start → dispatch → run → status. State this
  // up-front so users don't get stuck wondering why missions never execute.
  ui.info(`Next: \`aiwg mc dispatch ${session.id} "<objective>" --completion "<criteria>"\``);
  ui.info(`Then: \`aiwg mc run ${session.id}\` to drain the queue (missions stay 'queued' until you do).`);
  ui.blank();

  return { exitCode: 0, message: session.id };
}

export async function mcDispatch(ctx: HandlerContext): Promise<HandlerResult> {
  const positional = getPositionalArgs(ctx.args);
  const sessionId = positional[0];
  const objective = positional.slice(1).join(' ') || parseFlag(ctx.args, '--objective');
  const completion = parseFlag(ctx.args, '--completion');
  const priority = parseFlag(ctx.args, '--priority') || 'normal';
  const invalidFlags: string[] = [];
  const maxIterations = parseNumberFlag(ctx.args, '--max-iterations', invalidFlags, true) ?? 10;
  const maxTotalTokens = parseNumberFlag(ctx.args, '--max-total-tokens', invalidFlags, true);
  const maxOutputTokens = parseNumberFlag(ctx.args, '--max-output-tokens', invalidFlags, true);
  const maxToolCalls = parseNumberFlag(ctx.args, '--max-tool-calls', invalidFlags, true);
  const maxTotalCost = parseNumberFlag(ctx.args, '--max-total-cost', invalidFlags);
  const maxWallClockMinutes = parseNumberFlag(ctx.args, '--max-wall-clock-minutes', invalidFlags);
  const explorationQuota = parseNumberFlag(ctx.args, '--exploration-quota', invalidFlags, true);
  const budgetStopPolicyRaw = parseFlag(ctx.args, '--budget-stop-policy');
  let budgetStopPolicy: 'completion-wins' | 'budget-wins' | undefined;
  if (budgetStopPolicyRaw !== undefined) {
    if (budgetStopPolicyRaw === 'completion-wins' || budgetStopPolicyRaw === 'budget-wins') {
      budgetStopPolicy = budgetStopPolicyRaw;
    } else {
      invalidFlags.push(`--budget-stop-policy (got '${budgetStopPolicyRaw}', expected completion-wins|budget-wins)`);
    }
  }
  const modeRaw = parseFlag(ctx.args, '--mode') || 'direct';
  const mode: MissionMode = modeRaw === 'pty-orchestrator' ? 'pty-orchestrator' : 'direct';
  const targetAgent = parseFlag(ctx.args, '--target-agent');

  if (!objective) {
    // #1438: keep this in sync with subcommandUsage.dispatch above so 'mc
    // dispatch' with bad args and 'mc dispatch --help' agree on flags.
    ui.error('Usage: aiwg mc dispatch <session-id> "<objective>" [--completion "<criteria>"] [--max-iterations N] [--priority <level>] [--mode pty-orchestrator] [--target-agent <agent-id>]');
    return { exitCode: 1 };
  }

  if (invalidFlags.length > 0) {
    ui.error(`Invalid numeric flag value(s): ${invalidFlags.join(', ')}. Budget/quota flags require positive numbers. Mission not dispatched.`);
    return { exitCode: 1 };
  }

  if (mode === 'pty-orchestrator' && !targetAgent) {
    ui.error('--mode pty-orchestrator requires --target-agent <agent-id>');
    return { exitCode: 1 };
  }

  const selected = await findActiveSession(sessionId);
  if (!selected) {
    ui.error(sessionId ? `Session not found: ${sessionId}` : 'No active session. Run `aiwg mc start` first.');
    return { exitCode: 1 };
  }

  // mission-dispatch accepts only the frozen objective envelope. Worker
  // bindings can arrive through its existing session, so inspect that payload.
  try {
    const cfg = await readAdmissionConfig(ctx.cwd || process.cwd());
    const support = cfg?.parallelism?.worker_dispatch && cfg.parallelism.worker_mode === 'managed' ? mcWorkerSupport() : undefined;
    assertMissionWorkerHandoff(selected, 'mc-cli', support);
    for (const mission of selected.missions) assertMissionWorkerHandoff(mission, 'mc-cli', support);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.error(message);
    return { exitCode: 1, message };
  }

  // #1361: Check project-level parallelism cap. Active missions = running or
  // queued; if at cap, warn but still queue (FIFO behavior — the mission goes
  // into the session as 'queued' and will run when a slot frees up).
  let capWarning: string | undefined;
  try {
    const { readAiwgConfig, resolveParallelism } = await import('../../config/aiwg-config.js');
    const cfg = await readAiwgConfig(ctx.cwd || process.cwd());
    if (cfg) {
      const resolved = resolveParallelism(cfg.parallelism, cfg.providers[0]);
      const activeCount = selected.missions.filter(
        m => m.status === 'running' || m.status === 'queued' || m.status === 'paused',
      ).length;
      if (activeCount >= resolved.max_parallel_mc_missions) {
        capWarning = `Active missions (${activeCount}) at or above project parallelism cap (${resolved.max_parallel_mc_missions}). Mission will queue; bump via 'aiwg config set --project parallelism.max_parallel_mc_missions N'.`;
      }
    }
  } catch {
    // Non-fatal — config read failure doesn't block dispatch
  }

  const flags = mutationFlags(ctx.args);
  const mission: Mission = {
    id: flags.requestId
      ? `m-${createHash('sha256').update(flags.requestId).digest('hex').slice(0, 16)}`
      : genId('m'),
    objective,
    completion,
    status: 'queued',
    loop: 0,
    maxIterations,
    maxTotalTokens,
    maxOutputTokens,
    maxToolCalls,
    maxTotalCost,
    maxWallClockMinutes,
    explorationQuota,
    budgetStopPolicy,
    priority,
    mode,
    targetAgent: targetAgent || undefined,
  };

  const dispatchPath = parseFlag(ctx.args, '--worker-dispatch');
  if (dispatchPath) {
    try {
      const cfg = await readAdmissionConfig(ctx.cwd || process.cwd());
      if (!cfg?.parallelism?.worker_dispatch || cfg.parallelism.worker_mode !== 'managed' || mode !== 'direct') {
        throw new Error('OG_CONTRACT_UNSUPPORTED: worker dispatch requires the managed MC caller');
      }
      if (!isAbsolute(dispatchPath) || relative(ctx.cwd, dispatchPath).startsWith('..')) throw new Error('Worker dispatch path must be inside the project');
      const dispatch = await readWorkerJson(dispatchPath) as WorkerDispatch;
      mission.extensions = { 'aiwg.worker-dispatch': dispatch };
      assertMissionWorkerHandoff(mission, 'mc-cli', mcWorkerSupport());
      await resolveMcWorker(ctx, selected, mission);
    } catch (error) { return managedControlFailure(error); }
  }

  const result = await mutateSession(selected.id, 'dispatch', mission.id, flags.expectedUpdatedAt, flags.requestId, session => {
    if (session.state !== 'active') return 'invalid_state';
    if (session.missions.length >= session.maxMissions) return 'capacity';
    session.missions.push(mission);
    return undefined;
  });
  if (!result.ok) return mutationFailure(result);
  if (!result.replayed) {
    await appendLog(selected.id, {
      event: 'mission_dispatched',
      missionId: mission.id,
      objective,
      priority,
      mode,
      targetAgent,
      requestId: flags.requestId ?? null,
      lfdBudgets: {
        maxTotalTokens,
        maxOutputTokens,
        maxToolCalls,
        maxTotalCost,
        maxWallClockMinutes,
        explorationQuota,
      },
    });
  }

  if (capWarning) ui.warn(capWarning);
  ui.success(`${result.replayed ? 'Replayed dispatch for' : 'Dispatched mission'} ${mission.id}: ${objective}`);
  const modeLabel = mode === 'pty-orchestrator' ? ` | Mode: PTY orchestrator → ${targetAgent}` : '';
  ui.info(`Priority: ${priority} | Max iterations: ${maxIterations}${modeLabel}`);
  const lfdLimits = [
    maxTotalTokens ? `total tokens ${maxTotalTokens}` : null,
    maxOutputTokens ? `output tokens ${maxOutputTokens}` : null,
    maxToolCalls ? `tool calls ${maxToolCalls}` : null,
    maxTotalCost ? `total cost $${maxTotalCost}` : null,
    maxWallClockMinutes ? `wall clock ${maxWallClockMinutes}m` : null,
    explorationQuota ? `exploration quota ${explorationQuota}` : null,
  ].filter(Boolean);
  if (lfdLimits.length > 0) {
    ui.info(`LFD limits: ${lfdLimits.join(' | ')}`);
  }

  // #1439: dispatch alone does NOT execute the mission. Surface the next step
  // so the user knows the queue won't drain on its own.
  ui.info(`Next: run \`aiwg mc run ${selected.id}\` to launch queued missions as ralph loops.`);

  return { exitCode: 0, message: mission.id };
}
