import { describe, expect, it } from 'vitest';
import { diagnoseWorkerHealthReadiness } from '../../../src/models/worker-health-readiness.js';
import { unqualifiedWorkerRolesFixture, workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { workerConfigDigest } from '../../../src/config/aiwg-config.js';

// T-OG-12 / #2913 S1: synthetic offline inputs, no credentials, inference,
// spawned process, MC/admission store or fixture cleanup side effects.
const fixture = () => {
  const f = workerResolutionFixture();
  f.snapshot.config.parallelism!.groups!.workers.requiredRoles = ['coding'];
  return f;
};

describe('T-OG-12 offline worker health readiness (S1 mapping)', () => {
  it('T-OG-12-health-01 keeps legacy disabled projects unchanged', () => {
    const f = fixture();
    f.snapshot.config.parallelism!.worker_dispatch = false;
    expect(diagnoseWorkerHealthReadiness(f.snapshot, f.request)).toMatchObject({ enabled: false,
      ready: true, contextDigest: null, thresholds: [], findings: [{ code: 'WORKER_HEALTH_DISABLED' }] });
  });

  it('T-OG-12-health-02 diagnoses direct fresh inputs without MC/admission and does not mutate them', () => {
    const f = fixture();
    const before = workerConfigDigest(f.snapshot);
    const report = diagnoseWorkerHealthReadiness(f.snapshot, f.request);
    expect(report.ready).toBe(true);
    expect(report.findings.map(row => row.code)).toContain('WORKER_ROLE_ELIGIBLE');
    expect(report.findings.map(row => row.code)).toContain('WORKER_HEALTH_DEGRADED');
    expect(report.thresholds[0].health).toMatchObject({ startupSeconds: 60, checkSeconds: 15,
      quietSeconds: 90, stallSeconds: 300, hardTimeoutSeconds: 1800, maxSteps: 100 });
    expect(workerConfigDigest(f.snapshot)).toBe(before);
  });

  it('T-OG-12-health-03 blocks required onboarding when installation evidence is unavailable', () => {
    const f = fixture();
    f.snapshot.installations = {};
    const report = diagnoseWorkerHealthReadiness(f.snapshot, f.request);
    expect(report.ready).toBe(false);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'WORKER_ROLE_NOT_READY', status: 'error',
      nextAction: 'qualify-role-route' }));
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'OG_ADAPTER_UNQUALIFIED',
      nextAction: 'qualify-installation-and-profile' }));
  });

  it('#3173 reports each unqualified required role once in text-facing and JSON findings', () => {
    const f = unqualifiedWorkerRolesFixture();
    const report = diagnoseWorkerHealthReadiness(f.snapshot, f.request);
    const json = JSON.parse(JSON.stringify(report));
    expect(json.ready).toBe(false);
    const gaps = json.findings.filter((row: any) => row.code === 'OG_ADAPTER_UNQUALIFIED');
    expect(gaps).toHaveLength(3);
    for (const role of ['efficiency', 'coding', 'reasoning']) {
      expect(gaps.filter((row: any) => row.role === role)).toEqual([
        expect.objectContaining({ roles: [role], pointer: '/parallelism/groups/workers/requiredRoles',
          message: `No qualified route covers ${role}. Run aiwg doctor --probe-workers --qualify.` }),
      ]);
    }
    expect(json.findings.filter((row: any) => row.code === 'WORKER_ROLE_NOT_READY')).toHaveLength(3);
  });

  it('#3173 groups a shared catalog failure once with all affected roles', () => {
    const f = unqualifiedWorkerRolesFixture();
    f.snapshot.catalog.discovery!.instances!.codex.models[0].worker!.observedAt = 'invalid';
    const report = diagnoseWorkerHealthReadiness(f.snapshot, f.request);
    const failures = report.findings.filter(row => row.pointer === '/catalog/discovery');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ role: null, roles: ['coding', 'efficiency', 'reasoning'] });
  });

  it('T-OG-12-health-04 keeps optional role gaps request-scoped', () => {
    const f = fixture();
    f.snapshot.models.defaults.workerSelection!.roleGuidance!.reasoning = {
      ...f.snapshot.models.defaults.workerSelection!.roleGuidance!.coding,
    };
    const report = diagnoseWorkerHealthReadiness(f.snapshot, f.request);
    expect(report.ready).toBe(true);
    expect(report.findings).toContainEqual(expect.objectContaining({ role: 'reasoning', status: 'warn',
      code: 'WORKER_ROLE_NOT_READY' }));
  });

  it('T-OG-12-health-05 reports stale defaults with an actionable policy finding', () => {
    const f = fixture();
    f.request.now = new Date(Date.parse(f.request.now) + 30 * 86400000).toISOString();
    const report = diagnoseWorkerHealthReadiness(f.snapshot, f.request);
    expect(report.ready).toBe(false);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'OG_ADAPTER_UNQUALIFIED',
      nextAction: 'refresh-worker-catalog' }));
  });

  it('T-OG-12-health-06 denied ultra cannot be made ready by tuning health', () => {
    const f = fixture();
    const guidance = f.snapshot.models.defaults.workerSelection!.roleGuidance!.coding;
    guidance.initialEffort = 'ultra';
    guidance.effortLadder = ['ultra'];
    const report = diagnoseWorkerHealthReadiness(f.snapshot, f.request);
    expect(report.ready).toBe(false);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'OG_EFFORT_DENIED',
      nextAction: 'select-qualified-effort' }));
    expect(report.thresholds).toEqual([]);
  });

  it('T-OG-12-health-07 rejects contributor routes using the shared policy owner', () => {
    const f = fixture();
    for (const member of f.snapshot.config.parallelism!.groups!.workers.members) member.model = 'contributor';
    f.snapshot.config.parallelism!.groups!.workers.members.splice(1);
    f.snapshot.config.parallelism!.groups!.workers.fallback = [];
    const row = f.snapshot.catalog.discovery!.instances!.codex.models[0];
    row.id = row.apiModelId = 'contributor';
    const report = diagnoseWorkerHealthReadiness(f.snapshot, f.request);
    expect(report.ready).toBe(false);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'OG_MODEL_UNAPPROVED' }));
  });

  it('T-OG-12-health-08 discloses unknown quota scope without inventing account capacity', () => {
    const f = fixture();
    expect(diagnoseWorkerHealthReadiness(f.snapshot, f.request).findings).toContainEqual(
      expect.objectContaining({ code: 'WORKER_QUOTA_SCOPE_UNKNOWN', nextAction: 'configure-qualified-quota-scope' }));
  });

  it('T-OG-12-health-09 fingerprints the supplied context and retains bounded parent limits', () => {
    const f = fixture();
    f.snapshot.constraints = { ceilings: { wallSeconds: 7 } };
    const first = diagnoseWorkerHealthReadiness(f.snapshot, f.request);
    const second = diagnoseWorkerHealthReadiness(f.snapshot, f.request);
    expect(first).toEqual(second);
    expect(first.contextDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.thresholds[0].health.hardTimeoutSeconds).toBe(7);
    f.request.context.briefTokens += 1;
    expect(diagnoseWorkerHealthReadiness(f.snapshot, f.request).contextDigest).not.toBe(first.contextDigest);
  });

  it('T-OG-12-health-10 validates cross-field health settings offline', () => {
    const f = fixture();
    f.snapshot.config.parallelism!.health = { checkSeconds: 100, startupSeconds: 1 };
    const report = diagnoseWorkerHealthReadiness(f.snapshot, f.request);
    expect(report.ready).toBe(false);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'OG_CONFIG_REFERENCE', status: 'error' }));
  });

  it('T-OG-12-health-11 exposes unavailable required step enforcement', () => {
    const f = fixture();
    f.snapshot.config.parallelism!.health = { requireStepCap: true };
    f.snapshot.registry.providers.codex.workerAdapter!.invocationProfiles!['fixture-shell'].controls.stepCap.support = 'not-applicable';
    const report = diagnoseWorkerHealthReadiness(f.snapshot, f.request);
    expect(report.ready).toBe(false);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'WORKER_STEP_CAP_NOT_READY',
      nextAction: 'qualify-step-enforcement' }));
  });

  it('T-OG-12-health-12 keeps managed runtime findings separate from the S1 checkpoint', () => {
    const f = fixture();
    f.snapshot.config.parallelism!.worker_mode = 'managed';
    expect(diagnoseWorkerHealthReadiness(f.snapshot, f.request)).toMatchObject({ ready: true,
      thresholds: [], findings: [{ code: 'WORKER_HEALTH_MANAGED_DEFERRED', status: 'info' }] });
  });

  it('T-OG-12-health-13 diagnoses a seeded second group without hiding a healthy route', () => {
    const f = fixture();
    f.snapshot.config.parallelism!.groups!.reviewers = {
      maxParallel: 1, members: [{ id: 'review', cli: 'codex', model: 'missing-model', roles: ['reasoning'] }],
    };
    f.snapshot.models.defaults.workerSelection!.roleGuidance!.reasoning = {
      ...f.snapshot.models.defaults.workerSelection!.roleGuidance!.coding, groups: ['reviewers'],
    };
    const report = diagnoseWorkerHealthReadiness(f.snapshot, f.request);
    expect(report.ready).toBe(true);
    expect(report.findings).toContainEqual(expect.objectContaining({ role: 'coding', code: 'WORKER_ROLE_ELIGIBLE' }));
    expect(report.findings).toContainEqual(expect.objectContaining({ role: 'reasoning', code: 'WORKER_ROLE_NOT_READY' }));
  });
});
