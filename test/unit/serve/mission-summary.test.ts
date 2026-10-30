import { describe, expect, it } from 'vitest';
import * as conductor from '../../../src/serve/mission-conductor.js';
import { reviewedResult, summaryLedger } from '../../fixtures/mission-summary.js';
import type { ExecutorRegistration } from '../../../src/serve/executor-registry.js';

describe('Mission ledger summary', () => {
  it.each([
    ['accepted', 'accepted'], ['completed', 'completed'], ['failed', 'failed'],
    ['unknown', 'unknown'], ['routed', 'unknown'], ['plan-only', 'unknown'],
    ['review-no-evidence', 'completed'],
  ])('%s ledger reports %s without changing its input', (kind, status) => {
    const ledger = summaryLedger(kind);
    const before = structuredClone(ledger);
    const summary = (conductor as any).summarizeMissionLedger(ledger);
    expect(summary.cycles[0].status).toBe(status);
    expect(summary.counts[status]).toBe(1);
    expect(Object.values(summary.counts).reduce((a: number, b: any) => a + b, 0)).toBe(1);
    expect(ledger).toEqual(before);
  });

  it.each([true, false])('accepts a bound existing result on a legacy ledger (direct=%s)', direct => {
    const ledger = summaryLedger('accepted');
    delete ledger.executionMode;
    ledger.cycles[0].workerResult = reviewedResult(direct);
    ledger.cycles[0].cycleId = ledger.cycles[0].workerResult!.taskId;
    ledger.checkpoint.completed = [ledger.cycles[0].cycleId];
    const summary = conductor.summarizeMissionLedger(ledger);
    expect(summary.cycles[0].status).toBe('accepted');
    summary.cycles[0].evidence[0].ref = 'fixture:changed';
    expect(ledger.cycles[0].workerResult!.verification.evidence[0].ref).not.toBe('fixture:changed');
  });

  it.each(['unrouted', 'pending', 'no checkpoint', 'no mode', 'bad result', 'null result', 'wrong task',
    'adapter failed', 'adapter running', 'adapter cancelled', 'uncertain stop', 'failure', 'no end',
    'backward time', 'exit failure', 'no claims', 'incomplete claims', 'no review', 'rejected', 'bad evidence'])
  ('keeps contradictory or incomplete measurements honest: %s', change => {
    const ledger = summaryLedger('accepted');
    const result = ledger.cycles[0].workerResult!;
    let status = 'completed';
    switch (change) {
      case 'unrouted': ledger.cycles[0].routed = false; status = 'unknown'; break;
      case 'pending': ledger.checkpoint.pending = [ledger.cycles[0].cycleId]; status = 'unknown'; break;
      case 'no checkpoint': ledger.checkpoint.completed = []; status = 'unknown'; break;
      case 'no mode': delete ledger.executionMode; delete ledger.cycles[0].workerResult; status = 'unknown'; break;
      case 'bad result': (ledger.cycles[0] as any).workerResult = {}; status = 'unknown'; break;
      case 'null result': (ledger.cycles[0] as any).workerResult = null; status = 'unknown'; break;
      case 'wrong task': result.taskId = 'different-task'; status = 'unknown'; break;
      case 'adapter failed':
        result.verification.status = 'pending'; delete result.verification.roundsToClean;
        result.execution.status = 'failed'; status = 'failed'; break;
      case 'adapter running': (result.execution as any).status = 'running'; status = 'unknown'; break;
      case 'adapter cancelled':
        result.verification.status = 'pending'; delete result.verification.roundsToClean;
        result.execution.status = 'cancelled'; status = 'unknown'; break;
      case 'uncertain stop': result.execution.termination = 'uncertain'; status = 'unknown'; break;
      case 'failure': result.execution.failure = { code: 'fixture', message: 'Fixture failure', retryable: false }; status = 'unknown'; break;
      case 'no end': result.execution.endedAt = null; status = 'unknown'; break;
      case 'backward time': result.execution.endedAt = '2000-01-01T00:00:00Z'; break;
      case 'exit failure': result.execution.exitCode = 1; status = 'unknown'; break;
      case 'no claims': result.worker = null; status = 'unknown'; break;
      case 'incomplete claims': result.worker!.status = 'incomplete'; status = 'unknown'; break;
      case 'no review': delete result.verification.reviewRounds; delete result.verification.roundsToClean; break;
      case 'rejected': result.verification.status = 'rejected'; delete result.verification.roundsToClean; break;
      case 'bad evidence': result.verification.evidence[0].digest = 'bad-digest'; status = 'unknown'; break;
    }
    expect(conductor.summarizeMissionLedger(ledger).cycles[0].status).toBe(status);
  });

  it('does not infer success from output, score, cost or a file-effect reason', () => {
    const ledger = summaryLedger('routed');
    ledger.cycles[0].output = 'success';
    ledger.cycles[0].cost = 5;
    ledger.cycles[0].reason = 'file effect completed; worker replay skipped';
    ledger.bestOutput = { cycleId: ledger.cycles[0].cycleId, runtime: 'codex', output: 'success', score: 100 };
    expect(conductor.summarizeMissionLedger(ledger).counts).toEqual({ accepted: 0, completed: 0, failed: 0, unknown: 1 });
  });

  it('returns zero counts for an empty ledger', () => {
    const ledger = summaryLedger('accepted'); ledger.cycles = [];
    ledger.checkpoint = { completed: [], failed: [], pending: [] };
    expect(conductor.summarizeMissionLedger(ledger)).toEqual({ missionId: ledger.missionId,
      counts: { accepted: 0, completed: 0, failed: 0, unknown: 0 }, cycles: [] });
  });

  it('includes checkpoint-only cycles once as unknown when measurements are absent', () => {
    const ledger = summaryLedger('completed');
    ledger.checkpoint.completed.push('missing-completed');
    ledger.checkpoint.failed.push('missing-failed');
    ledger.checkpoint.pending.push('missing-pending', 'missing-completed');
    const before = structuredClone(ledger);
    const summary = conductor.summarizeMissionLedger(ledger);
    expect(summary.counts).toEqual({ accepted: 0, completed: 1, failed: 0, unknown: 3 });
    expect(summary.cycles.slice(1).map(cycle => cycle.status)).toEqual(['unknown', 'unknown', 'unknown']);
    expect(ledger).toEqual(before);
  });

  it('retains a detached verifier result through execution and resume', async () => {
    const workerResult = reviewedResult();
    const pool = [{ executorId: 'fixture-executor', name: 'fixture', connected: true,
      capabilities: ['runtime:codex'], currentMissions: new Set() }] as ExecutorRegistration[];
    const plan = { missionId: 'fixture', goal: 'Synthetic', completionCriterion: 'Measured',
      cycles: [{ id: workerResult.taskId, runtime: 'codex', prompt: 'Synthetic' }] };
    const runner = new conductor.MissionConductor({ runWorker: () => ({ workerResult }) });
    const ledger = await runner.conduct(plan, pool);
    expect(conductor.summarizeMissionLedger(ledger).counts.accepted).toBe(1);
    workerResult.verification.evidence = [];
    expect(conductor.summarizeMissionLedger(ledger).counts.accepted).toBe(1);
    const resumed = await runner.conduct(plan, pool, ledger);
    expect(conductor.summarizeMissionLedger(resumed).counts.accepted).toBe(1);
  });
});
