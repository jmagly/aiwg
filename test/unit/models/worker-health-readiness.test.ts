import { describe, expect, it } from 'vitest';
import { diagnoseWorkerHealthReadiness, formatWorkerHealthReadinessFinding, workerHealthConfigurationFindings } from '../../../src/models/worker-health-readiness.js';
import { unqualifiedWorkerRolesFixture, workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { workerConfigDigest, validateParallelismConfig } from '../../../src/config/aiwg-config.js';
import { resolveWorkerPlan } from '../../../src/models/worker-plan.js';

// T-OG-12 / #2913 S1: synthetic offline inputs, no credentials, inference,
// spawned process, MC/admission store or fixture cleanup side effects.
const fixture = () => {
  const f = workerResolutionFixture();
  f.snapshot.config.parallelism!.groups!.workers.requiredRoles = ['coding'];
  return f;
};

type Fixture = ReturnType<typeof fixture>;
const paths = { configFile: '/project/.aiwg/aiwg.config', modelsFile: '/project/models.json',
  catalogFile: '/cache/model-catalog.v1.json' };
const workerMembers = ['workers/primary', 'workers/alternate'];

const hazards: Array<{ name: string; seed: (f: Fixture) => void; code: string; pointer?: string;
  configFile: string; configKey: string; members: string[]; nextAction: string }> = [
  { name: 'missing installation evidence', seed: f => { f.snapshot.installations = {}; },
    code: 'OG_ADAPTER_UNQUALIFIED', pointer: '/parallelism/groups/workers/members/primary',
    configFile: paths.configFile, configKey: '/parallelism/groups/workers/members/primary',
    members: ['workers/primary'], nextAction: 'qualify-installation-and-profile' },
  { name: 'unqualified required role', seed: f => { Object.assign(f, unqualifiedWorkerRolesFixture()); },
    code: 'OG_ADAPTER_UNQUALIFIED', pointer: '/parallelism/groups/workers/requiredRoles',
    configFile: paths.configFile, configKey: '/parallelism/groups/workers/requiredRoles',
    members: ['workers/efficiency'], nextAction: 'qualify-installation-and-profile' },
  { name: 'shared malformed catalog', seed: f => {
    Object.assign(f, unqualifiedWorkerRolesFixture());
    f.snapshot.catalog.discovery!.instances!.codex.models[0].worker!.observedAt = 'invalid';
  }, code: 'OG_ADAPTER_UNQUALIFIED', pointer: '/catalog/discovery', configFile: paths.catalogFile,
    configKey: '/discovery', members: ['workers/efficiency', 'workers/coding', 'workers/reasoning'],
    nextAction: 'qualify-installation-and-profile' },
  { name: 'optional role guidance has no covering members', seed: f => {
    f.snapshot.models.defaults.workerSelection!.roleGuidance!.reasoning = {
      ...f.snapshot.models.defaults.workerSelection!.roleGuidance!.coding };
  }, code: 'WORKER_ROLE_NOT_READY', configFile: paths.modelsFile,
    configKey: '/defaults/workerSelection/roleGuidance/reasoning', members: workerMembers,
    nextAction: 'qualify-role-route' },
  { name: 'stale observation', seed: f => {
    f.request.now = new Date(Date.parse(f.request.now) + 30 * 86400000).toISOString();
  }, code: 'OG_ADAPTER_UNQUALIFIED', pointer: '/worker/observedAt', configFile: paths.catalogFile,
    configKey: '/discovery/instances/codex/models/0/worker/observedAt', members: ['workers/primary'],
    nextAction: 'refresh-worker-catalog' },
  { name: 'denied ultra effort', seed: f => {
    const guidance = f.snapshot.models.defaults.workerSelection!.roleGuidance!.coding;
    guidance.initialEffort = 'ultra'; guidance.effortLadder = ['ultra'];
  }, code: 'OG_EFFORT_DENIED', configFile: paths.catalogFile,
    configKey: '/discovery/instances/codex/models/0/worker/efforts', members: ['workers/primary'],
    nextAction: 'select-qualified-effort' },
  { name: 'contributor model', seed: f => {
    const group = f.snapshot.config.parallelism!.groups!.workers;
    group.members[0].model = 'contributor'; group.members.splice(1); group.fallback = [];
    const row = f.snapshot.catalog.discovery!.instances!.codex.models[0];
    row.id = row.apiModelId = 'contributor';
  }, code: 'OG_MODEL_UNAPPROVED', pointer: '/defaults/workerSelection/guards/deniedModels',
    configFile: paths.modelsFile, configKey: '/defaults/workerSelection/guards/deniedModels',
    members: ['workers/primary'], nextAction: 'review-model-policy-and-freshness' },
  { name: 'unknown quota scope', seed: () => {}, code: 'WORKER_QUOTA_SCOPE_UNKNOWN',
    configFile: paths.configFile, configKey: '/parallelism/clis/codex/quotaScope', members: workerMembers,
    nextAction: 'configure-qualified-quota-scope' },
  { name: 'invalid cross-field health settings', seed: f => {
    f.snapshot.config.parallelism!.health = { checkSeconds: 100, startupSeconds: 1 };
  }, code: 'OG_CONFIG_REFERENCE', configFile: paths.configFile,
    configKey: '/parallelism/health/checkSeconds', members: workerMembers,
    nextAction: 'review-worker-configuration' },
  { name: 'unavailable required step cap', seed: f => {
    f.snapshot.config.parallelism!.health = { requireStepCap: true };
    f.snapshot.registry.providers.codex.workerAdapter!.invocationProfiles!['fixture-shell'].controls.stepCap.support = 'not-applicable';
  }, code: 'WORKER_STEP_CAP_NOT_READY', configFile: paths.configFile,
    configKey: '/parallelism/health/requireStepCap', members: ['workers/primary'],
    nextAction: 'qualify-step-enforcement' },
  { name: 'second group lacks qualified model', seed: f => {
    f.snapshot.config.parallelism!.groups!.reviewers = {
      maxParallel: 1, members: [{ id: 'review', cli: 'codex', model: 'missing-model', roles: ['reasoning'] }] };
    f.snapshot.models.defaults.workerSelection!.roleGuidance!.reasoning = {
      ...f.snapshot.models.defaults.workerSelection!.roleGuidance!.coding, groups: ['reviewers'] };
  }, code: 'WORKER_ROLE_NOT_READY', configFile: paths.modelsFile,
    configKey: '/defaults/workerSelection/roleGuidance/reasoning', members: ['reviewers/review'],
    nextAction: 'qualify-role-route' },
  { name: 'degraded health profile', seed: () => {}, code: 'WORKER_HEALTH_DEGRADED',
    configFile: paths.configFile, configKey: '/parallelism/clis/codex/invocationProfile',
    members: ['workers/primary'], nextAction: 'qualify-health-signals' },
];

describe('T-OG-12 offline worker health readiness (S1 mapping)', () => {
  it.each([false, true])('#3906 resolves qualified roles using the configured task classes (custom: %s)', custom => {
    const f = fixture();
    const roles = ['efficiency', 'coding', 'reasoning'] as const;
    const group = f.snapshot.config.parallelism!.groups!.workers;
    group.requiredRoles = [...roles];
    group.members[0].roles = [...roles];
    const policy = f.snapshot.models.defaults.workerSelection!;
    for (const role of roles) policy.roleGuidance![role] = structuredClone(policy.roleGuidance!.coding);
    if (custom) policy.taskClasses = { scan: 'efficiency', patch: 'coding', design: 'reasoning' };
    // The public doctor request has no task class; a caller's extra task must not leak between roles.
    const request = custom ? f.request : { now: f.request.now, context: f.request.context };
    const before = workerConfigDigest(f.snapshot);
    const report = diagnoseWorkerHealthReadiness(f.snapshot, request, paths);
    expect(report.ready).toBe(true);
    expect(report.findings.filter(row => row.code === 'WORKER_ROLE_NOT_READY')).toEqual([]);
    expect(report.findings.filter(row => row.code === 'WORKER_ROLE_ELIGIBLE').map(row => row.role).sort()).toEqual([...roles].sort());
    expect(workerConfigDigest(f.snapshot)).toBe(before);
  });

  it.each(['tier', 'pricing'] as const)('#3906 reports premium %s authority as pending operator confirmation', source => {
    const f = fixture();
    if (source === 'tier') f.snapshot.models.defaults.workerSelection!.roleGuidance!.coding.tier = 'premium';
    else for (const row of f.snapshot.catalog.discovery!.instances!.codex.models) row.worker!.pricing.costClass = 'premium';
    const before = workerConfigDigest(f.snapshot);
    const report = diagnoseWorkerHealthReadiness(f.snapshot, { now: f.request.now, context: f.request.context }, paths);
    expect(report.ready).toBe(true);
    expect(report.findings.filter(row => row.status === 'error')).toEqual([]);
    expect(report.findings).toContainEqual(expect.objectContaining({ role: 'coding', status: 'warn',
      code: 'WORKER_ROLE_PENDING_AUTHORIZATION', message: expect.stringContaining('--authorize-premium requires explicit operator confirmation'),
      nextAction: 'confirm-premium-with-operator' }));
    expect(report.thresholds).toHaveLength(1);
    expect(resolveWorkerPlan(f.snapshot, f.request).selected).toBeNull();
    expect(workerConfigDigest(f.snapshot)).toBe(before);
  });

  it.each(['qualification', 'installation', 'effort', 'step-cap', 'flagship'] as const)(
    '#3906 retains errors when premium authority is accompanied by a %s blocker', blocker => {
      const f = fixture();
      const guidance = f.snapshot.models.defaults.workerSelection!.roleGuidance!.coding;
      guidance.tier = 'premium';
      if (blocker === 'qualification') for (const row of f.snapshot.catalog.discovery!.instances!.codex.models) row.worker!.qualification.status = 'unqualified';
      if (blocker === 'installation') f.snapshot.installations = {};
      if (blocker === 'effort') { guidance.initialEffort = 'ultra'; guidance.effortLadder = ['ultra']; }
      if (blocker === 'step-cap') {
        f.snapshot.config.parallelism!.health = { requireStepCap: true };
        f.snapshot.registry.providers.codex.workerAdapter!.invocationProfiles!['fixture-shell'].controls.stepCap.support = 'not-applicable';
      }
      if (blocker === 'flagship') guidance.tier = 'flagship';
      const report = diagnoseWorkerHealthReadiness(f.snapshot, f.request, paths);
      expect(report.ready).toBe(false);
      expect(report.findings.filter(row => row.status === 'error')).not.toHaveLength(0);
      expect(report.findings.filter(row => row.code === 'WORKER_ROLE_PENDING_AUTHORIZATION')).toEqual([]);
    });

  it.each(hazards)('T-OG-12-health-14 reports full repair context for $name', hazard => {
    const f = fixture();
    // Make policy ownership explicit, as the real config loader does.
    hazard.seed(f);
    f.snapshot.models.workerPolicyOrigins = {};
    const report = diagnoseWorkerHealthReadiness(f.snapshot, f.request, paths);
    const errors = validateParallelismConfig(f.snapshot.config.parallelism);
    if (errors.length) {
      // Doctor uses the same builder before model/catalog loading is available.
      expect(workerHealthConfigurationFindings(f.snapshot.config.parallelism, errors, paths)).toEqual(report.findings);
    }
    const matching = report.findings.filter(row => row.code === hazard.code
      && (!hazard.pointer || row.pointer === hazard.pointer));
    expect(matching).toContainEqual(expect.objectContaining({ configFile: hazard.configFile,
      configKey: hazard.configKey, members: hazard.members, nextAction: hazard.nextAction }));
    // Every emitted hazard must retain an actionable owner and affected members.
    for (const finding of report.findings.filter(row => ['warn', 'error'].includes(row.status))) {
      expect(finding.configFile).toMatch(/^\//);
      expect(finding.configKey).toMatch(/^\//);
      expect(finding.members.length).toBeGreaterThan(0);
      expect(finding.nextAction).not.toBe('none');
      const text = formatWorkerHealthReadinessFinding(finding);
      expect(text).toContain(`config ${finding.configFile} key ${finding.configKey}`);
      expect(text).toContain(`members: ${finding.members.join(', ')}`);
      expect(text).toContain(`[next: ${finding.nextAction}]`);
    }
  });

  it.each(['user', 'project'] as const)('T-OG-12-health-15 retains the exact %s model-policy owner', authority => {
    const f = fixture();
    const guidance = f.snapshot.models.defaults.workerSelection!.roleGuidance!;
    guidance.reasoning = { ...guidance.coding };
    const pointer = '/defaults/workerSelection/roleGuidance/reasoning/groups';
    const owner = `/${authority}/models.json`;
    f.snapshot.models.workerPolicyOrigins = { [pointer]: [
      { source: '/builtin/models.json', authority: 'builtin', pointer,
        digest: workerConfigDigest('builtin'), contribution: ['workers'] },
      { source: '/user/models.json', authority: 'user', pointer,
        digest: workerConfigDigest('user'), contribution: ['workers'] },
      ...(authority === 'project' ? [{ source: owner, authority: 'project' as const, pointer,
        digest: workerConfigDigest('project'), contribution: ['workers'] }] : []),
    ] };
    const report = diagnoseWorkerHealthReadiness(f.snapshot, f.request, paths);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'WORKER_ROLE_NOT_READY',
      configFile: owner, configKey: '/defaults/workerSelection/roleGuidance/reasoning',
      members: workerMembers, nextAction: 'qualify-role-route' }));
  });

  it.each([
    { source: 'static' as const, file: '/package/agentic/code/providers/model-catalog.v1.json' },
    { source: 'cache' as const, file: paths.catalogFile },
  ])('T-OG-12-health-16 retains the $source catalog file owner', ({ source, file }) => {
    const f = fixture();
    f.snapshot.catalog.discovery!.source = source;
    f.request.now = new Date(Date.parse(f.request.now) + 30 * 86400000).toISOString();
    const report = diagnoseWorkerHealthReadiness(f.snapshot, f.request, { ...paths, catalogFile: file });
    const finding = report.findings.find(row => row.pointer === '/worker/observedAt')!;
    expect(finding).toMatchObject({ configFile: file,
      configKey: '/discovery/instances/codex/models/0/worker/observedAt',
      members: ['workers/primary'], nextAction: 'refresh-worker-catalog' });
    expect(formatWorkerHealthReadinessFinding(finding)).toContain(`config ${file} key ${finding.configKey}`);
  });

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
