/** Offline S1 health readiness projection; never launch authority or a probe. */
import { validateParallelismConfig, resolveWorkerGroupInstallation, workerConfigDigest } from '../config/aiwg-config.js';
import { assertWorkerHealthQualification } from './provider-policy.js';
import { resolveWorkerPlan, type WorkerPlanSnapshot, type WorkerPlanRequest } from './resolver.js';
import { resolveWorkerEffectiveHealth } from '../serve/worker-invocation.js';
import type { WorkerEffectiveHealth } from '../mission-protocol/types.js';

export interface WorkerHealthReadinessFinding {
  code: string;
  status: 'ok' | 'info' | 'warn' | 'error';
  pointer: string;
  message: string;
  nextAction: string;
  role: string | null;
  /** Roles affected by a shared diagnostic, emitted once with role=null. */
  roles?: string[];
}

export interface WorkerHealthReadinessReport {
  enabled: boolean;
  /** Required configured roles only; optional roles are checked when requested. */
  ready: boolean;
  contextDigest: string | null;
  findings: WorkerHealthReadinessFinding[];
  thresholds: Array<{ role: string; group: string; member: string; health: WorkerEffectiveHealth }>;
}

const repairAction = (code: string, pointer: string): string => {
  if (pointer === '/worker/observedAt') return 'refresh-worker-catalog';
  if (code === 'OG_EFFORT_DENIED') return 'select-qualified-effort';
  if (code === 'OG_MODEL_UNAPPROVED') return 'review-model-policy-and-freshness';
  if (code === 'OG_PIN_MISMATCH') return 'review-exact-wrapper-pin';
  if (code === 'OG_BUDGET_UNMEASURABLE') return 'qualify-budget-enforcement';
  if (code === 'OG_ADAPTER_UNQUALIFIED') return 'qualify-installation-and-profile';
  return 'review-worker-configuration';
};

export function diagnoseWorkerHealthReadiness(snapshot: WorkerPlanSnapshot,
  request: Pick<WorkerPlanRequest, 'now' | 'context'>): WorkerHealthReadinessReport {
  const p = snapshot.config.parallelism;
  const report: WorkerHealthReadinessReport = { enabled: p?.worker_dispatch === true,
    ready: true, contextDigest: null, findings: [], thresholds: [] };
  const add = (finding: WorkerHealthReadinessFinding): void => { report.findings.push(finding); };
  if (!report.enabled) {
    add({ code: 'WORKER_HEALTH_DISABLED', status: 'info', pointer: '/parallelism/worker_dispatch',
      message: 'Group dispatch is disabled; legacy execution has no worker health readiness requirement.',
      nextAction: 'none', role: null });
    return report;
  }
  report.contextDigest = workerConfigDigest({ context: request.context, modelDigests: snapshot.modelDigests });
  const errors = validateParallelismConfig(p);
  if (errors.length) {
    report.ready = false;
    for (const message of errors) add({ code: 'OG_CONFIG_REFERENCE', status: 'error',
      pointer: '/parallelism', message, nextAction: 'review-worker-configuration', role: null });
    return report;
  }
  if (p?.worker_mode === 'managed') {
    add({ code: 'WORKER_HEALTH_MANAGED_DEFERRED', status: 'info', pointer: '/parallelism/worker_mode',
      message: 'Managed admission and health enforcement are deferred to S2+; this check covers direct readiness.',
      nextAction: 'use-direct-checkpoint', role: null });
    return report;
  }
  const enabledGroups = Object.values(p?.groups ?? {});
  const required = new Set(enabledGroups.flatMap(group => group.requiredRoles ?? []));
  const roles = new Set([...Object.keys(snapshot.models.defaults.workerSelection?.roleGuidance ?? {}), ...required]);
  if (!roles.size) {
    report.ready = false;
    add({ code: 'OG_CONFIG_REFERENCE', status: 'error', pointer: '/defaults/workerSelection/roleGuidance',
      message: 'No worker role guidance is configured; onboarding cannot offer a qualified route.',
      nextAction: 'configure-role-guidance', role: null });
  }
  const installations = new Set(enabledGroups.flatMap(group => group.members.filter(member => member.enabled !== false).map(member => member.cli)));
  for (const cli of installations) {
    if (!p?.clis?.[cli]?.quotaScope) add({ code: 'WORKER_QUOTA_SCOPE_UNKNOWN', status: 'warn', role: null,
      pointer: `/parallelism/clis/${cli}/quotaScope`,
      message: 'No explicit quota/account correlation scope; shared aliases cannot establish independent upstream capacity.',
      nextAction: 'configure-qualified-quota-scope' });
  }
  const sharedDiagnostics = new Map<string, WorkerHealthReadinessFinding>();
  for (const role of roles) {
    const plan = resolveWorkerPlan(snapshot, { ...request, role: role as WorkerPlanRequest['role'] });
    const isRequired = required.has(role as 'efficiency' | 'coding' | 'reasoning');
    const diagnostics = [...plan.diagnostics, ...plan.exclusions.flatMap(item => item.diagnostics)];
    const seen = new Set<string>();
    for (const diagnostic of diagnostics) {
      if (diagnostic.roles && !diagnostic.roles.includes(role)) continue;
      const key = JSON.stringify([diagnostic.code, diagnostic.pointer, diagnostic.message, diagnostic.blocking, diagnostic.origins]);
      if (seen.has(key)) continue;
      seen.add(key);
      const finding: WorkerHealthReadinessFinding = { ...diagnostic,
        status: diagnostic.blocking === false ? 'info' : 'warn', role,
        nextAction: repairAction(diagnostic.code, diagnostic.pointer) };
      const shared = sharedDiagnostics.get(key);
      if (shared) {
        shared.roles = [...new Set([...(shared.roles ?? [shared.role!]), role])];
        shared.role = null;
      } else {
        sharedDiagnostics.set(key, finding);
        add(finding);
      }
    }
    if (!plan.selected) {
      if (isRequired) report.ready = false;
      add({ code: 'WORKER_ROLE_NOT_READY', status: isRequired ? 'error' : 'warn', role,
        pointer: `/defaults/workerSelection/roleGuidance/${role}`,
        message: `${isRequired ? 'Required' : 'Optional'} role has no qualified route; request-time launch remains blocked.`,
        nextAction: 'qualify-role-route' });
      continue;
    }
    const tuple = plan.selected;
    try {
      const { adapter } = resolveWorkerGroupInstallation(p!, tuple.cli, snapshot.registry);
      const profile = adapter.invocationProfiles![tuple.profile];
      const binding = snapshot.installations[tuple.cli];
      const model = snapshot.catalog.discovery?.instances?.[tuple.cli]?.models.find(row => row.id === tuple.model || row.apiModelId === tuple.model);
      assertWorkerHealthQualification(profile, { profileRef: tuple.profile, cliVersion: binding.cliVersion,
        accountScope: binding.accountScope, inferenceProvider: tuple.inferenceProvider, model: model?.apiModelId ?? tuple.model, effort: tuple.effort });
      const nativeSteps = profile.controls.stepCap?.support === 'native';
      if (p?.health?.requireStepCap && !nativeSteps) {
        if (isRequired) report.ready = false;
        add({ code: 'WORKER_STEP_CAP_NOT_READY', status: isRequired ? 'error' : 'warn', role,
          pointer: '/parallelism/health/requireStepCap',
          message: 'Required step cap lacks native enforcement or qualified runtime pre-step admission evidence.',
          nextAction: 'qualify-step-enforcement' });
        continue;
      }
      // External admission needs runtime gate evidence; a config declaration alone cannot prove it.
      const health = resolveWorkerEffectiveHealth(p?.health, { role, effort: tuple.effort,
        modelKey: tuple.modelKey, profileRef: tuple.profile, wallSeconds: plan.ceilings.wallSeconds ?? 1800,
        stepEnforcement: nativeSteps ? 'native' : 'unavailable' });
      report.thresholds.push({ role, group: tuple.group, member: tuple.member, health });
      if (!profile.health || profile.health.handshake !== 'semantic' || profile.health.coverage !== 'full') {
        add({ code: 'WORKER_HEALTH_DEGRADED', status: 'warn', role,
          pointer: `/parallelism/clis/${tuple.cli}/invocationProfile`,
          message: 'Profile has degraded or unobserved health coverage; progress and stop evidence may be unavailable.',
          nextAction: 'qualify-health-signals' });
      }
      add({ code: 'WORKER_ROLE_ELIGIBLE', status: 'ok', role,
        pointer: `/defaults/workerSelection/roleGuidance/${role}`,
        message: 'Policy route is eligible; launch still requires current installation and task qualification.',
        nextAction: 'resolve-current-task' });
    } catch {
      if (isRequired) report.ready = false;
      add({ code: 'WORKER_HEALTH_UNQUALIFIED', status: isRequired ? 'error' : 'warn', role,
        pointer: `/parallelism/clis/${tuple.cli}/invocationProfile`,
        message: 'Health profile scope or effective settings are invalid; requalify the exact version/account/model/effort.',
        nextAction: 'qualify-health-signals' });
    }
  }
  return report;
}
