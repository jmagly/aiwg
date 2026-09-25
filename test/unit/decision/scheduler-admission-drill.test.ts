import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AdmissionError,
  DecisionAdmissionRegistry,
  type AdmissionLease,
  type AdmissionProfileChangeRecord,
  type AdmissionRequest,
  type DecisionAdmissionLimits,
  type DecisionSchedulerPolicy,
} from '../../../src/decision/index.js';

const RUNBOOK = 'docs/decision/operations/admission.md';

interface DrillStep { step: string; pass: boolean; evidence: Record<string, unknown> }

/** DRILL-ADMISSION-STORM-v1: executes RUN-JEV-ADMISSION-v1 against a real registry with an injected clock. */
async function runAdmissionStormDrill(): Promise<{ id: string; runbook: string; steps: DrillStep[] }> {
  let now = 1_000;
  const clock = (): number => now;
  const registry = new DecisionAdmissionRegistry();
  const audit: AdmissionProfileChangeRecord[] = [];
  registry.onProfileChange(record => audit.push(record));
  const breaker = { failureThreshold: 2, openMs: 1_000, halfOpenMaxCalls: 1 };
  const profile = (profileVersion: string, workspace: Partial<DecisionAdmissionLimits>): DecisionSchedulerPolicy => ({
    enabled: true, profileVersion,
    workspace: { id: 'drill-workspace', limits: { concurrency: 2, maxQueueLength: 2, maxQueueWaitMs: 60_000, ...workspace } },
    principal: { id: 'drill-principal', limits: { concurrency: 4, maxQueueLength: 8, maxQueueWaitMs: 60_000 } },
    providers: { jev: { concurrency: 4, circuitBreaker: breaker } },
  });
  const request = (signal = new AbortController().signal): AdmissionRequest => ({
    budgetId: `drill-${Math.random()}`, principalId: 'drill-principal', workspaceId: 'drill-workspace', providerId: 'jev',
    estimate: {}, deadlineEpochMs: now + 600_000, signal,
  });
  const settle = async (): Promise<void> => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); };
  const steps: DrillStep[] = [];
  const controller = registry.register(profile('storm-v1', {}), clock);
  const initialDigest = audit[0]!.digest;

  for (let failure = 0; failure < breaker.failureThreshold; failure += 1) (await controller.acquire(request())).release({ success: false });
  const opened = controller.breakerTransitions();
  steps.push({ step: 'provider-failures', pass: opened.length === 1 && opened[0]!.to === 'open', evidence: { transitions: opened.length } });

  now += breaker.openMs;
  const cancel = new AbortController();
  const held = await controller.acquire(request());
  const queued = [controller.acquire(request(cancel.signal)), controller.acquire(request(cancel.signal))];
  queued.forEach(pending => pending.catch(() => undefined));
  await settle();
  const shed = await controller.acquire(request()).catch(error => error as AdmissionError);
  const hint = shed instanceof AdmissionError ? shed.evidence.retryAfterMs : undefined;
  steps.push({ step: 'load-shed', pass: shed instanceof AdmissionError && shed.evidence.reason === 'queue-full' && shed.retryable
    && hint !== undefined && hint >= 1 && hint <= 30_000, evidence: { reason: shed instanceof AdmissionError ? shed.evidence.reason : null } });
  cancel.abort();
  held.release({ success: true });
  await settle();

  registry.register(profile('storm-v2', { concurrency: 1, maxQueueLength: 1 }), clock);
  const leases: AdmissionLease[] = [];
  const waiting = new AbortController();
  for (let index = 0; index < 2; index += 1) {
    const pending = controller.acquire(request(waiting.signal)).then(lease => { leases.push(lease); });
    pending.catch(() => undefined);
  }
  await settle();
  steps.push({ step: 'approved-profile-change', pass: audit.at(-1)?.kind === 'change' && leases.length === 1
    && audit.at(-1)?.previousProfileVersion === 'storm-v1', evidence: { kind: audit.at(-1)?.kind, admitted: leases.length } });
  waiting.abort();
  leases.forEach(lease => lease.release({ success: true }));
  await settle();

  const history = controller.breakerTransitions();
  steps.push({ step: 'evidence-retained', pass: history.length >= 3 && history[0]!.to === 'open'
    && history.at(-1)!.to === 'closed', evidence: { transitions: history.map(entry => `${entry.from}->${entry.to}`) } });

  registry.register(profile('storm-v1', {}), clock);
  const rollback = audit.at(-1)!;
  steps.push({ step: 'previous-profile-restored', pass: rollback.kind === 'rollback' && rollback.profileVersion === 'storm-v1'
    && rollback.digest === initialDigest, evidence: { kind: rollback.kind, digestMatches: rollback.digest === initialDigest } });

  const canary = await Promise.all([controller.acquire(request()), controller.acquire(request())]);
  steps.push({ step: 'capacity-restored', pass: controller.snapshot().active === 2, evidence: { active: controller.snapshot().active } });
  canary.forEach(lease => lease.release({ success: true }));
  return { id: 'DRILL-ADMISSION-STORM-v1', runbook: 'RUN-JEV-ADMISSION-v1', steps };
}

describe('RUN-JEV-ADMISSION-v1 tabletop drill (CNC-ADMIT-DRILL-001)', () => {
  it('sheds load, audits the approved profile change, and restores the previous revision', async () => {
    const report = await runAdmissionStormDrill();
    expect(report.steps.filter(step => !step.pass)).toEqual([]);
    expect(report.steps.map(step => step.step)).toEqual(['provider-failures', 'load-shed', 'approved-profile-change',
      'evidence-retained', 'previous-profile-restored', 'capacity-restored']);
    const runbook = readFileSync(RUNBOOK, 'utf8');
    expect(runbook).toContain('`RUN-JEV-ADMISSION-v1`');
    expect(runbook).toContain('`DRILL-ADMISSION-STORM-v1`');
    for (const step of report.steps) expect(runbook).toContain(`| ${step.step} |`);
    expect(readFileSync('docs/decision/operations/README.md', 'utf8')).toContain('`RUN-JEV-ADMISSION-v1`');
    expect(JSON.stringify(report)).not.toMatch(/drill-principal|drill-workspace/);
  });
});
