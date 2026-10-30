// Read-only classification of conductor checkpoints and existing verifier results.
import { validateWorkerPayload } from '../mission-protocol/codecs.js';
import { hasIndependentWorkerAcceptance } from '../mission-protocol/worker-review-gate.js';
import type { WorkerArtifact } from '../mission-protocol/types.js';
import type { CycleResult, MissionLedger } from './mission-conductor.js';

export type MissionWorkStatus = 'accepted' | 'completed' | 'failed' | 'unknown';
export interface MissionCycleSummary {
  cycleId: string;
  status: MissionWorkStatus;
  reason: string;
  evidence: WorkerArtifact[];
}
export interface MissionWorkSummary {
  missionId: string;
  counts: Record<MissionWorkStatus, number>;
  cycles: MissionCycleSummary[];
}

function classify(ledger: MissionLedger, cycle: CycleResult): MissionCycleSummary {
  const entry = (status: MissionWorkStatus, reason: string, evidence: WorkerArtifact[] = []): MissionCycleSummary =>
    ({ cycleId: cycle.cycleId, status, reason, evidence: structuredClone(evidence) });
  if (ledger.checkpoint.failed.includes(cycle.cycleId)) return entry('failed', 'Conductor recorded failure');
  if (ledger.executionMode === 'plan-only' || !cycle.routed
    || !ledger.checkpoint.completed.includes(cycle.cycleId)
    || ledger.checkpoint.pending.includes(cycle.cycleId)) {
    return entry('unknown', 'No completed execution measurement');
  }
  const result = cycle.workerResult;
  if (result !== undefined) {
    const definition = result && typeof result === 'object' && 'mode' in result && result.mode === 'direct'
      ? 'workerDirectResult' : 'workerResult';
    if (!validateWorkerPayload(definition, result).valid || result.taskId !== cycle.cycleId) {
      return entry('unknown', 'Invalid or unbound worker measurement');
    }
    if (result.execution.status === 'failed') return entry('failed', 'Adapter recorded worker failure');
    if (result.execution.status !== 'completed') return entry('unknown', 'Worker execution is not complete');
    // The result codec already requires confirmed, successful terminal execution
    // and completed worker claims for an accepted verifier verdict.
    if (Date.parse(result.execution.endedAt!) >= Date.parse(result.execution.startedAt)
      && hasIndependentWorkerAcceptance(result.verification)) {
      return entry('accepted', 'Independent review accepted with evidence', result.verification.evidence);
    }
  } else if (ledger.executionMode !== 'executed') {
    return entry('unknown', 'Legacy checkpoint lacks an execution measurement');
  }
  return entry('completed', 'Worker finished; independent acceptance with evidence is unavailable');
}

/** Project existing observations only; no scoring, file reads, sync or writes. */
export function summarizeMissionLedger(ledger: MissionLedger): MissionWorkSummary {
  const counts = { accepted: 0, completed: 0, failed: 0, unknown: 0 };
  const cycles = ledger.cycles.map(cycle => classify(ledger, cycle));
  const measured = new Set(cycles.map(cycle => cycle.cycleId));
  const checkpointIds = new Set([
    ...ledger.checkpoint.completed, ...ledger.checkpoint.failed, ...ledger.checkpoint.pending,
  ]);
  for (const cycleId of checkpointIds) {
    if (!measured.has(cycleId)) cycles.push({ cycleId, status: 'unknown',
      reason: 'Checkpoint has no retained cycle measurement', evidence: [] });
  }
  for (const cycle of cycles) counts[cycle.status]++;
  return { missionId: ledger.missionId, counts, cycles };
}
