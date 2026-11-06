/** Offline S1 health readiness projection; never launch authority or a probe. */
import { homedir } from 'node:os';
import { collectLocalOnlyPaths } from './conductor-data-policy.mjs';
import { isAbsolute, join, resolve } from 'node:path';
import { resolveParallelism, validateParallelismConfig, resolveWorkerGroupInstallation, workerConfigDigest, type ParallelismConfig } from '../config/aiwg-config.js';
import { assertWorkerHealthQualification } from './provider-policy.js';
import { resolveWorkerPlan, type WorkerPlanSnapshot, type WorkerPlanRequest } from './resolver.js';
import { resolveWorkerEffectiveHealth } from '../serve/worker-invocation.js';
import type { WorkerEffectiveHealth } from '../mission-protocol/types.js';

export interface WorkerHealthReadinessFinding {
  code: string;
  status: 'ok' | 'info' | 'warn' | 'error';
  pointer: string;
  configFile: string;
  configKey: string;
  members: string[];
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

export interface WorkerHealthReadinessPaths {
  configFile?: string;
  modelsFile?: string;
  catalogFile?: string;
}

/** Preserve the same repair context in human-readable doctor output and JSON. */
export function formatWorkerHealthReadinessFinding(finding: WorkerHealthReadinessFinding): string {
  return `${finding.code}: ${finding.message} (config ${finding.configFile} key ${finding.configKey}; members: ${finding.members.join(', ') || 'none'}) [next: ${finding.nextAction}]`;
}

/** Build offline configuration repair findings before model/catalog loading is possible. */
export function workerHealthConfigurationFindings(parallelism: ParallelismConfig | undefined,
  errors: string[], paths: Pick<WorkerHealthReadinessPaths, 'configFile'> = {}): WorkerHealthReadinessFinding[] {
  return errors.map<WorkerHealthReadinessFinding>(message => {
    const pointer = message.match(/^OG_CONFIG_REFERENCE (\/[^:]*):/)?.[1] ?? '/parallelism';
    const parts = pointer.split('/');
    const members = Object.entries(parallelism?.groups ?? {}).flatMap(([group, value]) =>
      (Array.isArray(value?.members) ? value.members : []).filter((member, index) => {
        if (!member || typeof member.id !== 'string') return false;
        if (parts[2] === 'groups') return group === parts[3]
          && (parts[4] !== 'members' || member.id === parts[5] || String(index) === parts[5]);
        return parts[2] !== 'clis' || member.cli === parts[3];
      }).map(member => `${group}/${member.id}`));
    return { code: 'OG_CONFIG_REFERENCE', status: 'error', pointer,
      configFile: paths.configFile ?? resolve('.aiwg/aiwg.config'), configKey: pointer,
      members, message, nextAction: 'review-worker-configuration', role: null };
  });
}

type FindingInput = Omit<WorkerHealthReadinessFinding, 'configFile' | 'configKey' | 'members'>;

export function diagnoseWorkerHealthReadiness(snapshot: WorkerPlanSnapshot,
  request: Pick<WorkerPlanRequest, 'now' | 'context'>, paths: WorkerHealthReadinessPaths = {}): WorkerHealthReadinessReport {
  let p = snapshot.config.parallelism;
  const report: WorkerHealthReadinessReport = { enabled: p?.worker_dispatch === true,
    ready: true, contextDigest: null, findings: [], thresholds: [] };
  const configFile = paths.configFile ?? resolve('.aiwg/aiwg.config');
  const modelsFile = paths.modelsFile ?? resolve('models.json');
  const catalogFile = paths.catalogFile ?? join(homedir(), '.cache/aiwg/model-catalog.v1.json');
  const errors = validateParallelismConfig(p);
  if (!errors.length && p?.worker_dispatch) p = resolveParallelism(p, snapshot.config.providers[0]);
  const allMembers = Object.entries(p?.groups ?? {}).flatMap(([group, value]) =>
    (value.members ?? []).map(member => ({ group, member, label: `${group}/${member.id}` })));
  const membersFor = (pointer: string, role: string | null): string[] => {
    const parts = pointer.split('/');
    const groups = role ? snapshot.models.defaults.workerSelection?.roleGuidance?.[role as 'coding' | 'reasoning' | 'efficiency']?.groups : undefined;
    return allMembers.filter(row => {
      if (parts[1] === 'parallelism' && parts[2] === 'groups') return row.group === parts[3]
        && (parts[4] !== 'members' || row.member.id === parts[5])
        && (parts[4] !== 'requiredRoles' || !role || row.member.roles.includes(role as 'coding' | 'reasoning' | 'efficiency'));
      if (parts[1] === 'parallelism' && parts[2] === 'clis') return row.member.cli === parts[3];
      return !groups || groups.includes(row.group);
    }).map(row => row.label);
  };
  const contextualize = (finding: FindingInput, members: string[]): WorkerHealthReadinessFinding => {
    let file = configFile;
    let key = finding.pointer;
    if (key.startsWith('/defaults/') || key.startsWith('/agentOverrides')) {
      const origins = Object.entries(snapshot.models.workerPolicyOrigins ?? {})
        .filter(([pointer]) => pointer === key || pointer.startsWith(`${key}/`))
        .flatMap(([, values]) => values).filter(origin => isAbsolute(origin.source))
        .sort((a, b) => ['builtin', 'user', 'project'].indexOf(a.authority)
          - ['builtin', 'user', 'project'].indexOf(b.authority));
      file = origins.at(-1)?.source ?? modelsFile;
    } else if (key.startsWith('/catalog/')) {
      file = catalogFile;
      key = key.slice('/catalog'.length);
    } else if (key === '/worker' || key.startsWith('/worker/')) {
      file = catalogFile;
      const affected = allMembers.find(row => row.label === members[0]);
      const cli = affected?.member.cli;
      const index = cli ? snapshot.catalog.discovery?.instances?.[cli]?.models.findIndex(row =>
        row.id === affected!.member.model || row.apiModelId === affected!.member.model) : undefined;
      if (cli && index !== undefined && index >= 0) key = `/discovery/instances/${cli}/models/${index}${key}`;
    }
    return { ...finding, configFile: file, configKey: key, members: [...new Set(members)] };
  };
  const add = (finding: FindingInput, members = membersFor(finding.pointer, finding.role)): void => {
    report.findings.push(contextualize(finding, members));
  };
  const localOnlyPaths = collectLocalOnlyPaths(snapshot.models.defaults.workerSelection, p);
  if (localOnlyPaths.length) add({ code: 'CONDUCTOR_LOCAL_ONLY_PATHS', status: 'info',
    pointer: '/defaults/workerSelection/dataPolicy/localOnlyPaths', role: null,
    message: `Declared local-only conductor inputs: ${localOnlyPaths.join(', ')}. Deploy provider guards before opening task inputs; shell coverage is limited.`,
    nextAction: 'deploy-provider-data-guards' });
  if (!report.enabled) {
    add({ code: 'WORKER_HEALTH_DISABLED', status: 'info', pointer: '/parallelism/worker_dispatch',
      message: 'Group dispatch is disabled; legacy execution has no worker health readiness requirement.',
      nextAction: 'none', role: null });
    return report;
  }
  report.contextDigest = workerConfigDigest({ context: request.context, modelDigests: snapshot.modelDigests });
  if (errors.length) {
    report.ready = false;
    report.findings.push(...workerHealthConfigurationFindings(p, errors, { configFile }));
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
  const installations = new Set(enabledGroups.flatMap(group => (group.members ?? []).filter(member => member.enabled !== false).map(member => member.cli)));
  for (const cli of installations) {
    if (!p?.clis?.[cli]?.quotaScope) add({ code: 'WORKER_QUOTA_SCOPE_UNKNOWN', status: 'warn', role: null,
      pointer: `/parallelism/clis/${cli}/quotaScope`,
      message: 'No explicit quota/account correlation scope; shared aliases cannot establish independent upstream capacity.',
      nextAction: 'configure-qualified-quota-scope' });
  }
  const sharedDiagnostics = new Map<string, WorkerHealthReadinessFinding>();
  for (const role of roles) {
    const roleRequest = { now: request.now, context: request.context, role,
      taskClass: Object.entries(snapshot.models.defaults.workerSelection?.taskClasses ?? {})
        .find(([, taskRole]) => taskRole === role)?.[0] };
    let plan = resolveWorkerPlan(snapshot, roleRequest);
    let pendingAuthorization = false;
    if (!plan.selected && plan.exclusions.some(item => item.diagnostics.some(diagnostic =>
      diagnostic.code === 'OG_MODEL_UNAPPROVED' && diagnostic.pointer === '/request/authority'))) {
      // Counterfactual offline check only: never return a launch plan or grant authority.
      const authorized = resolveWorkerPlan(snapshot, { ...roleRequest,
        authority: { premiumAuthorized: true, maxAutoTier: 3 } });
      if (authorized.selected) { plan = authorized; pendingAuthorization = true; }
    }
    const isRequired = required.has(role as 'efficiency' | 'coding' | 'reasoning');
    const diagnostics = [
      ...plan.diagnostics.map(diagnostic => ({ diagnostic, members: membersFor(diagnostic.pointer, role) })),
      ...plan.exclusions.flatMap(item => item.diagnostics.map(diagnostic => ({ diagnostic,
        members: [`${item.group}/${item.member}`] }))),
    ];
    for (const { diagnostic, members } of diagnostics) {
      if (diagnostic.roles && !diagnostic.roles.includes(role)) continue;
      const finding = contextualize({ ...diagnostic,
        status: diagnostic.blocking === false ? 'info' : 'warn', role,
        nextAction: repairAction(diagnostic.code, diagnostic.pointer) }, members);
      const key = JSON.stringify([diagnostic.code, diagnostic.pointer, diagnostic.message, diagnostic.blocking,
        diagnostic.origins, finding.configFile, finding.configKey]);
      const shared = sharedDiagnostics.get(key);
      if (shared) {
        shared.members = [...new Set([...shared.members, ...finding.members])];
        if (shared.role !== role) {
          shared.roles = [...new Set([...(shared.roles ?? [shared.role!]), role])];
          shared.role = null;
        }
      } else {
        sharedDiagnostics.set(key, finding);
        report.findings.push(finding);
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
          nextAction: 'qualify-step-enforcement' }, [`${tuple.group}/${tuple.member}`]);
        continue;
      }
      // External admission needs runtime gate evidence; a config declaration alone cannot prove it.
      const health = resolveWorkerEffectiveHealth(p?.health, { role: plan.policy?.roleGuidance?.[role]?.baseRole ?? role, effort: tuple.effort,
        modelKey: tuple.modelKey, profileRef: tuple.profile, wallSeconds: plan.ceilings.wallSeconds ?? 1800,
        stepEnforcement: nativeSteps ? 'native' : 'unavailable' });
      report.thresholds.push({ role, group: tuple.group, member: tuple.member, health });
      if (!profile.health || profile.health.handshake !== 'semantic' || profile.health.coverage !== 'full') {
        add({ code: 'WORKER_HEALTH_DEGRADED', status: 'warn', role,
          pointer: `/parallelism/clis/${tuple.cli}/invocationProfile`,
          message: 'Profile has degraded or unobserved health coverage; progress and stop evidence may be unavailable.',
          nextAction: 'qualify-health-signals' }, [`${tuple.group}/${tuple.member}`]);
      }
      add({ code: pendingAuthorization ? 'WORKER_ROLE_PENDING_AUTHORIZATION' : 'WORKER_ROLE_ELIGIBLE',
        status: pendingAuthorization ? 'warn' : 'ok', role,
        pointer: `/defaults/workerSelection/roleGuidance/${role}`,
        message: pendingAuthorization
          ? 'Role is ready pending authorization; --authorize-premium requires explicit operator confirmation before resolving a launch.'
          : 'Policy route is eligible; launch still requires current installation and task qualification.',
        nextAction: pendingAuthorization ? 'confirm-premium-with-operator' : 'resolve-current-task' }, [`${tuple.group}/${tuple.member}`]);
    } catch {
      if (isRequired) report.ready = false;
      add({ code: 'WORKER_HEALTH_UNQUALIFIED', status: isRequired ? 'error' : 'warn', role,
        pointer: `/parallelism/clis/${tuple.cli}/invocationProfile`,
        message: 'Health profile scope or effective settings are invalid; requalify the exact version/account/model/effort.',
        nextAction: 'qualify-health-signals' }, [`${tuple.group}/${tuple.member}`]);
    }
  }
  return report;
}
