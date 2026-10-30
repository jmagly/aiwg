// Mission Control control operations, extracted from the shared handler.
import type { HandlerContext, HandlerResult } from './types.js';
import * as ui from '../ui.js';

import { createMcAdmissionScheduler } from './mc-admission.js';
import { type Mission } from './mc-types.js';
import { readSession, writeSession, appendLog, mutateSession, mutationFlags, mutationFailure, findActiveSession } from './mc-session.js';
import { hasFlag, getPositionalArgs } from './mc-args.js';
import { readAdmissionConfig } from './mc-worker.js';

export async function managedControlScheduler(ctx: HandlerContext, missions: Mission[]) {
  const projectRoot = ctx.cwd || process.cwd();
  const cfg = await readAdmissionConfig(projectRoot);
  if (!cfg?.parallelism?.worker_dispatch || cfg.parallelism.worker_mode !== 'managed') return undefined;
  const scheduler = await createMcAdmissionScheduler(projectRoot, cfg);
  const snapshot = scheduler.snapshot();
  for (const mission of missions) {
    if (!mission.admissionRequestId) continue;
    const record = snapshot.records[mission.admissionRequestId];
    if (!record || !mission.admissionGeneration || record.leaseGeneration !== mission.admissionGeneration) {
      throw new Error('stale managed Mission checkpoint generation');
    }
  }
  return scheduler;
}

export function managedControlFailure(error: unknown): HandlerResult {
  const message = error instanceof Error ? error.message : String(error);
  ui.error(message);
  return { exitCode: 1, message };
}

export async function cancelManagedMission(
  ctx: HandlerContext, scheduler: Awaited<ReturnType<typeof createMcAdmissionScheduler>>, mission: Mission,
): Promise<void> {
  if (!mission.admissionRequestId) return;
  const cancelled = scheduler.cancel(mission.admissionRequestId, mission.admissionGeneration);
  mission.admissionState = cancelled.state;
  mission.admissionLeaseExpiresAt = undefined;
  if (cancelled.state !== 'uncertain' || !mission.ralphLoopId || !mission.admissionExecution) return;
  try {
    const { cancelManagedRalph } = await import('./ralph-launcher.js');
    await cancelManagedRalph(ctx.frameworkRoot, ctx.cwd || process.cwd(), mission.ralphLoopId, {
      requestId: mission.admissionRequestId, generation: mission.admissionGeneration!, execution: mission.admissionExecution,
    });
  } catch {
    // Reservation is already uncertain; unavailable signalling cannot release it.
  }
}

export async function mcAbort(ctx: HandlerContext): Promise<HandlerResult> {
  const positional = getPositionalArgs(ctx.args);
  const sessionId = positional[0];
  const missionId = positional[1];

  if (!sessionId || !missionId) {
    ui.error('Usage: aiwg mc abort <session-id> <mission-id>');
    return { exitCode: 1 };
  }

  let managedScheduler: Awaited<ReturnType<typeof managedControlScheduler>>;
  try {
    const selected = await readSession(sessionId);
    managedScheduler = await managedControlScheduler(ctx, selected?.missions.filter(mission => mission.id === missionId) ?? []);
  } catch (error) { return managedControlFailure(error); }
  const flags = mutationFlags(ctx.args);
  const result = await mutateSession(sessionId, 'cancel', missionId, flags.expectedUpdatedAt, flags.requestId, session => {
    const mission = session.missions.find(m => m.id === missionId);
    if (!mission) return 'target_not_found';
    if (mission.status === 'done' || mission.status === 'failed' || mission.status === 'aborted') return 'invalid_state';
    mission.status = 'aborted';
    mission.completedAt = new Date().toISOString();
    return undefined;
  });
  if (!result.ok) return mutationFailure(result);

  if (!result.replayed) {
    const mission = result.session.missions.find(candidate => candidate.id === missionId);
    if (mission?.admissionRequestId) {
      try {
        if (managedScheduler) {
          await cancelManagedMission(ctx, managedScheduler, mission);
          await writeSession(result.session);
        } else {
          const projectRoot = ctx.cwd || process.cwd();
          const cfg = await readAdmissionConfig(projectRoot);
          const scheduler = await createMcAdmissionScheduler(projectRoot, cfg);
          scheduler.cancel(mission.admissionRequestId);
        }
      } catch (error) {
        if (managedScheduler) return managedControlFailure(error);
        // Legacy leases keep their existing best-effort cancellation behavior.
      }
    }
  }

  ui.success(`${result.replayed ? 'Replayed' : 'Aborted'} mission: ${missionId}`);
  return { exitCode: 0, message: JSON.stringify({ ok: true, replayed: result.replayed, updated_at: result.session.updatedAt }) };
}

export async function mcPause(ctx: HandlerContext): Promise<HandlerResult> {
  const positional = getPositionalArgs(ctx.args);
  const sessionId = positional[0];

  const selected = await findActiveSession(sessionId);
  if (!selected) {
    ui.error('No active session to pause.');
    return { exitCode: 1 };
  }
  let managedScheduler: Awaited<ReturnType<typeof managedControlScheduler>>;
  try { managedScheduler = await managedControlScheduler(ctx, selected.missions.filter(mission => mission.status === 'running')); }
  catch (error) { return managedControlFailure(error); }
  const flags = mutationFlags(ctx.args);
  const result = await mutateSession(selected.id, 'pause', selected.id, flags.expectedUpdatedAt, flags.requestId, session => {
    if (session.state !== 'active') return 'invalid_state';
    session.state = 'paused';
    for (const mission of session.missions) if (mission.status === 'running') mission.status = 'paused';
    return undefined;
  });
  if (!result.ok) return mutationFailure(result);

  if (!result.replayed && managedScheduler) {
    for (const mission of result.session.missions) {
      if (mission.status === 'paused') await cancelManagedMission(ctx, managedScheduler, mission);
    }
    await writeSession(result.session);
  }

  ui.success(`${result.replayed ? 'Replayed pause for' : 'Paused'} session: ${selected.id}`);
  return { exitCode: 0, message: JSON.stringify({ ok: true, replayed: result.replayed, updated_at: result.session.updatedAt }) };
}

export async function mcResume(ctx: HandlerContext): Promise<HandlerResult> {
  const positional = getPositionalArgs(ctx.args);
  const sessionId = positional[0];

  const selected = await findActiveSession(sessionId);
  if (!selected || selected.state !== 'paused') {
    ui.error('No paused session to resume.');
    return { exitCode: 1 };
  }
  try {
    const cfg = await readAdmissionConfig(ctx.cwd || process.cwd());
    if (cfg?.parallelism?.worker_dispatch && cfg.parallelism.worker_mode === 'managed') {
      const scheduler = await createMcAdmissionScheduler(ctx.cwd || process.cwd(), cfg);
      const snapshot = scheduler.snapshot();
      for (const mission of selected.missions.filter(candidate => candidate.status === 'paused')) {
        if (!mission.admissionRequestId) continue;
        const record = snapshot.records[mission.admissionRequestId];
        if (!record || record.leaseGeneration !== mission.admissionGeneration || record.state !== 'admitted') {
          throw new Error('managed resume requires current admission and reconciliation of uncertain work');
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.error(message);
    return { exitCode: 1, message };
  }
  const flags = mutationFlags(ctx.args);
  const result = await mutateSession(selected.id, 'resume', selected.id, flags.expectedUpdatedAt, flags.requestId, session => {
    if (session.state !== 'paused') return 'invalid_state';
    session.state = 'active';
    for (const mission of session.missions) if (mission.status === 'paused') mission.status = 'running';
    return undefined;
  });
  if (!result.ok) return mutationFailure(result);

  ui.success(`${result.replayed ? 'Replayed resume for' : 'Resumed'} session: ${selected.id}`);
  return { exitCode: 0, message: JSON.stringify({ ok: true, replayed: result.replayed, updated_at: result.session.updatedAt }) };
}

export async function mcStop(ctx: HandlerContext): Promise<HandlerResult> {
  const positional = getPositionalArgs(ctx.args);
  const sessionId = positional[0];
  const drain = hasFlag(ctx.args, '--drain');

  const session = await findActiveSession(sessionId);
  if (!session) {
    ui.error('No active session to stop.');
    return { exitCode: 1 };
  }

  let managedScheduler: Awaited<ReturnType<typeof managedControlScheduler>>;
  try {
    managedScheduler = await managedControlScheduler(ctx, session.missions.filter(mission =>
      mission.status === 'queued' || (!drain && (mission.status === 'running' || mission.status === 'paused'))));
  } catch (error) { return managedControlFailure(error); }

  if (drain) {
    // Mark queued missions as aborted, let running finish
    for (const m of session.missions) {
      if (m.status === 'queued') {
        m.status = 'aborted';
        m.completedAt = new Date().toISOString();
      }
    }
    ui.info('Draining: queued missions cancelled, running missions will complete.');
  } else {
    // Abort all non-completed missions
    for (const m of session.missions) {
      if (m.status === 'running' || m.status === 'queued' || m.status === 'paused') {
        m.status = 'aborted';
        m.completedAt = new Date().toISOString();
      }
    }
  }

  if (managedScheduler) {
    for (const mission of session.missions) {
      if (mission.status === 'aborted') await cancelManagedMission(ctx, managedScheduler, mission);
    }
  }
  session.state = 'stopped';
  await writeSession(session);
  await appendLog(session.id, { event: 'session_stopped', drain });

  ui.success(`Stopped session: ${session.id}`);
  return { exitCode: 0 };
}
