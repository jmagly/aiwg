// Mission Control status operations, extracted from the shared handler.
import type { HandlerContext, HandlerResult } from './types.js';
import * as ui from '../ui.js';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { validateWorkerPayload } from '../../mission-protocol/codecs.js';
import { type WorkerHealthSummary } from '../../mission-protocol/types.js';

import { createMcAdmissionScheduler } from './mc-admission.js';
import { type MissionStatus, type Session } from './mc-types.js';
import { writeSession, listSessions, findActiveSession } from './mc-session.js';
import { hasFlag, getPositionalArgs } from './mc-args.js';
import { readAdmissionConfig, readManagedWorkerState } from './mc-worker.js';

/**
 * Sync mission statuses from their backing ralph loop state files (#1439).
 *
 * Each mission launched by `mc run` carries a `ralphLoopId`. The ralph loop
 * writes its own session-state.json with a `status` field
 * (running|completed|failed|paused|aborted). This helper polls those files
 * and reflects the truth back into the mc session.json so `mc status` and
 * `mc watch` show actual progress without manual intervention.
 *
 * Sync is best-effort — a missing or unreadable ralph state file leaves the
 * mission status unchanged (typically 'running' until the ralph process
 * actually writes state).
 */
export async function syncMissionsFromRalph(session: Session, projectRoot: string): Promise<boolean> {
  let mutated = false;
  const cfg = await readAdmissionConfig(projectRoot);
  const scheduler = await createMcAdmissionScheduler(projectRoot, cfg);
  const managed = cfg?.parallelism?.worker_dispatch && cfg.parallelism.worker_mode === 'managed';
  for (const mission of session.missions) {
    const wasRunning = mission.status === 'running';
    if (!wasRunning && !(managed && mission.managedWorker && mission.admissionState === 'uncertain')) continue;
    if (!mission.ralphLoopId) continue;
    const ralphStatePath = join(
      projectRoot,
      '.aiwg',
      'ralph-external',
      'loops',
      mission.ralphLoopId,
      'session-state.json',
    );
    if (managed) {
      const current = mission.admissionRequestId ? scheduler.snapshot().records[mission.admissionRequestId] : undefined;
      if (!current || !mission.admissionGeneration || current.leaseGeneration !== mission.admissionGeneration) continue;
    }
    try {
      const state = managed && mission.managedWorker
        ? await readManagedWorkerState(mission, scheduler)
        : JSON.parse(await fs.readFile(ralphStatePath, 'utf-8'));
      const ralphStatus = String(state.status || '').toLowerCase();
      if (managed && mission.admissionRequestId && state.health !== undefined) {
        if (!validateWorkerPayload('workerHealthSummary', state.health).valid) throw new Error('invalid Ralph worker health');
        const observed = scheduler.observeHealth(mission.admissionRequestId, mission.admissionGeneration!, state.health as WorkerHealthSummary);
        mission.admissionState = observed.state;
        mutated = true;
      }
      // Map ralph status → mc mission status
      let nextStatus: MissionStatus | null = null;
      if (ralphStatus === 'completed') nextStatus = 'done';
      else if (ralphStatus === 'failed' || ralphStatus === 'crashed') nextStatus = 'failed';
      else if (ralphStatus === 'aborted') nextStatus = 'aborted';
      else if (ralphStatus === 'paused') nextStatus = 'paused';
      if (!wasRunning) nextStatus = null;
      // 'running' stays running

      // Reflect iteration count if available
      const iter = typeof state.iteration === 'number' ? state.iteration : (typeof state.currentIteration === 'number' ? state.currentIteration : null);
      if (iter !== null && iter !== mission.loop) {
        mission.loop = iter;
        mutated = true;
      }

      // mission.status is narrowed to 'running' by the early-continue above,
      // and nextStatus is one of {done, failed, aborted, paused}. So the
      // transition is always real when nextStatus is set — no equality
      // check needed.
      if (nextStatus) {
        mission.status = nextStatus;
        mission.completedAt = new Date().toISOString();
        if (nextStatus === 'failed' && typeof state.error === 'string') {
          mission.error = state.error;
        }
        mutated = true;
        if (mission.admissionRequestId) {
          if (managed) {
            if (!mission.managedWorker) {
              if (state.health) scheduler.acceptFinal(mission.admissionRequestId, mission.admissionGeneration!, state.health as WorkerHealthSummary);
            }
            if (mission.admissionState !== 'settled') mission.admissionState = scheduler.stop(mission.admissionRequestId, mission.admissionGeneration!, 'observer-loss').state;
          }
          else {
            try { scheduler.release(mission.admissionRequestId); } catch { /* already expired or released */ }
            mission.admissionState = 'released';
          }
          mission.admissionLeaseExpiresAt = undefined;
        }
      } else if (mission.admissionRequestId) {
        try {
          const renewed = managed
            ? scheduler.renew(mission.admissionRequestId, mission.admissionGeneration)
            : scheduler.renew(mission.admissionRequestId);
          mission.admissionState = renewed.state;
          mission.admissionLeaseExpiresAt = renewed.leaseExpiresAt;
          mutated = true;
        } catch {
          // An expired lease is reconciled on the next run; status remains best-effort.
        }
      }
    } catch {
      if (managed && mission.admissionRequestId) {
        mission.admissionState = scheduler.disconnect(mission.admissionRequestId, mission.admissionGeneration!).state;
        mission.admissionLeaseExpiresAt = undefined;
        mutated = true;
      }
      // Missing supervision preserves the last task status and all artifacts.
    }
  }
  if (mutated) {
    session.updatedAt = new Date().toISOString();
    await writeSession(session);
  }
  return mutated;
}

export async function mcStatus(ctx: HandlerContext): Promise<HandlerResult> {
  const positional = getPositionalArgs(ctx.args);
  const sessionId = positional[0];
  const json = hasFlag(ctx.args, '--json');

  const session = await findActiveSession(sessionId);
  if (!session) {
    if (json) {
      console.log(JSON.stringify({ error: 'no_active_session' }));
    } else {
      ui.error(sessionId ? `Session not found: ${sessionId}` : 'No active session.');
    }
    return { exitCode: 1 };
  }

  // #1439: Sync mission statuses from ralph loop state files BEFORE display
  // so 'mc status' reflects the true state of any in-flight ralph processes
  // (otherwise missions launched by 'mc run' stay 'running' in mc.session.json
  // even after the ralph loop has completed).
  await syncMissionsFromRalph(session, ctx.cwd || process.cwd());

  if (json) {
    console.log(JSON.stringify(session, null, 2));
    return { exitCode: 0 };
  }

  const statusIcons: Record<MissionStatus, string> = {
    done: '✓',
    running: '⏳',
    queued: '⏺',
    failed: '✗',
    aborted: '⊘',
    paused: '⏸',
  };

  ui.blank();
  console.log(`  ${ui.brandMark()} ${ui.bold('MISSION CONTROL')} — ${ui.accent(session.name)}  [${session.id}]`);
  ui.rule(60);

  // Header
  // #1441: ui.dim() returns void (it prints) — wrapping in console.log emitted
  // a literal "undefined" between the header and the separator. Use dimText()
  // (returns a string) for inline styling.
  const header = `  ${'#'.padEnd(4)} ${'Mission'.padEnd(32)} ${'Mode'.padEnd(6)} ${'Status'.padEnd(12)} ${'Loop'.padEnd(8)} ${'Started'.padEnd(8)}`;
  console.log(ui.dimText(header));
  ui.rule(68);

  for (let i = 0; i < session.missions.length; i++) {
    const m = session.missions[i];
    const icon = statusIcons[m.status] || '?';
    const num = String(i + 1).padEnd(4);
    const obj = m.objective.length > 30 ? m.objective.slice(0, 27) + '...' : m.objective.padEnd(32);
    const modeTag = m.mode === 'pty-orchestrator' ? 'PTY'.padEnd(6) : '—'.padEnd(6);
    const status = `${icon} ${m.status.toUpperCase()}`.padEnd(12);
    const loop = m.status === 'queued' ? '—'.padEnd(8) : `${m.loop}/${m.maxIterations}`.padEnd(8);
    const started = m.startedAt ? new Date(m.startedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
    console.log(`  ${num} ${obj} ${modeTag} ${status} ${loop} ${started}`);
    // Show last action for PTY-orchestrated missions
    if (m.mode === 'pty-orchestrator' && m.lastAction && m.status === 'running') {
      console.log(ui.dimText(`       └─ Last: ${m.lastAction}`));
    }
  }

  ui.rule(68);

  const counts = {
    done: session.missions.filter(m => m.status === 'done').length,
    running: session.missions.filter(m => m.status === 'running').length,
    queued: session.missions.filter(m => m.status === 'queued').length,
    failed: session.missions.filter(m => m.status === 'failed').length,
  };

  console.log(`  ${session.missions.length} missions  |  ${counts.done} done  |  ${counts.running} running  |  ${counts.queued} queued  |  ${counts.failed} failed`);

  // #1361: Show project parallelism cap when one is configured.
  try {
    const { readAiwgConfig, resolveParallelism } = await import('../../config/aiwg-config.js');
    const cfg = await readAiwgConfig(ctx.cwd || process.cwd());
    if (cfg) {
      const resolved = resolveParallelism(cfg.parallelism, cfg.providers[0]);
      const active = counts.running + counts.queued;
      const cap = resolved.max_parallel_mc_missions;
      const overCap = active > cap ? ` ${ui.dim(`(${active - cap} over cap — queued)`)}` : '';
      console.log(`  Parallelism cap: ${active}/${cap} active${overCap}`);
    }
  } catch {
    // Non-fatal
  }

  ui.blank();

  return { exitCode: 0 };
}

export async function mcList(ctx: HandlerContext): Promise<HandlerResult> {
  const json = hasFlag(ctx.args, '--json');
  const sessions = await listSessions();

  if (json) {
    console.log(JSON.stringify(sessions.map(s => ({
      id: s.id,
      name: s.name,
      state: s.state,
      missions: s.missions.length,
      created: s.createdAt,
      updated: s.updatedAt,
    })), null, 2));
    return { exitCode: 0 };
  }

  if (sessions.length === 0) {
    ui.info('No Mission Control sessions. Run `aiwg mc start` to create one.');
    return { exitCode: 0 };
  }

  ui.blank();
  console.log(`  ${ui.brandMark()} ${ui.bold('Mission Control Sessions')}`);
  ui.rule();

  for (const s of sessions) {
    const stateIcon = s.state === 'active' ? '●' : s.state === 'paused' ? '⏸' : '○';
    const missionCount = s.missions.length;
    const done = s.missions.filter(m => m.status === 'done').length;
    console.log(`  ${stateIcon} ${s.id}  ${ui.accent(s.name)}  (${done}/${missionCount} done)  [${s.state}]`);
  }

  ui.blank();
  return { exitCode: 0 };
}

export async function mcWatch(ctx: HandlerContext): Promise<HandlerResult> {
  const positional = getPositionalArgs(ctx.args);
  const sessionId = positional[0];

  const session = await findActiveSession(sessionId);
  if (!session) {
    ui.error('No active session to watch.');
    return { exitCode: 1 };
  }

  // For non-interactive contexts, show status once with a note
  // Real streaming would use fs.watch on the session file
  ui.info(`Watch mode: polling session ${session.id}`);
  ui.info('Press Ctrl+C to stop watching.');
  ui.blank();

  // Show current status
  ctx.args = [session.id];
  return mcStatus(ctx);
}
