// Synthetic conductor ledgers with verifier-owned Mission v1 results.
import { assembleWorkerResult } from '../../src/mission-protocol/codecs.js';
import type { MissionLedger } from '../../src/serve/mission-conductor.js';
import { reviewArtifact, workerReviewFixture } from './worker-review.js';

export function reviewedResult(direct = true) {
  const fixture = workerReviewFixture(direct);
  fixture.verification.evidence = [reviewArtifact];
  return JSON.parse(assembleWorkerResult(fixture).bytes);
}

export function summaryLedger(kind: string): MissionLedger {
  const workerResult = reviewedResult();
  const cycleId = workerResult.taskId;
  const ledger: MissionLedger = {
    missionId: 'fixture-mission', goal: 'Synthetic work', completionCriterion: 'Checks pass',
    executionMode: 'executed', activityLog: [], totalCost: 0, runtimesUsed: ['codex'],
    checkpoint: { completed: [cycleId], failed: [], pending: [] },
    cycles: [{ cycleId, runtime: 'codex', primitive: 'exec', routed: true,
      reason: 'fixture worker returned', cost: 0, ...{ workerResult } }],
  };
  if (kind === 'completed') delete (ledger.cycles[0] as any).workerResult;
  if (kind === 'failed') ledger.checkpoint = { completed: [], failed: [cycleId], pending: [] };
  if (kind === 'unknown') delete ledger.executionMode;
  if (kind === 'unknown') delete (ledger.cycles[0] as any).workerResult;
  if (kind === 'routed') ledger.checkpoint = { completed: [], failed: [], pending: [cycleId] };
  if (kind === 'plan-only') ledger.executionMode = 'plan-only';
  if (kind === 'review-no-evidence') workerResult.verification.evidence = [];
  return ledger;
}
