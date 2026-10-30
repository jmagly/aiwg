import { hostResourceReport, type HostResourceReport } from '../config/host-resource-report.mjs';
import type { HostResourceSample } from '../config/host-resource-runtime.mjs';
import { workerReviewLineageDiagnostics } from './worker-review-lineage.js';
// Resolves eligible worker tuples against current config, catalog and installation snapshots.
import { isFlagshipModel, flagshipElected, normalizeModelTier } from './tiers.js';
import { ownWorkerRoleGuidance } from './worker-selection-policy.js';
import { resolveWorkerCeilings } from './worker-ceilings.js';
import { mergeGroupWorkerPolicy } from '../config/worker-group-templates.js';
import { WORKER_DISPATCH_ENABLE_COMMAND, WORKER_DISPATCH_READINESS_COMMAND } from './worker-dispatch-offer.js';
import {
  resolveWorkerGroupInstallation, resolveParallelism, validateWorkerGroupQualifications, validateWorkerGroupReferences, validateWorkerBudgetEnforcement,
  workerActivationDigests, workerConfigDigest,
  type AiwgConfig, type WorkerActivation, type WorkerExecution,
} from '../config/aiwg-config.js';
import {
  qualifyWorkerInvocationProfile, validateWorkerPolicyRoute, validateWorkerModelObservation,
  assertWorkerLaunchMode, hasOperatorWorkerNativeRenderer, workerContextHeadroom, workerModelKey, isCanonicalWorkerModelKey,
  WorkerSelectionPolicySchema, validateWorkerCatalogDiscovery,
  type ProviderModelCapabilityRegistry, type WorkerInvocationProfile, type WorkerContextEstimate,
  type WorkerBoundary,
} from './provider-policy.js';
import type { DiscoveredModel, DynamicModelCatalog } from './model-discovery.js';
import { MODEL_WRAPPERS } from './provider-models.js';
import { routeModelTier } from './router.js';
import type { ModelRouteRequest, WorkerModelObservation, WorkerPolicyDiagnostic } from './types.js';
import type { MergedModelConfig } from './types.js';

type ModelInputDigests = Pick<WorkerActivation, 'projectModelsDigest' | 'userModelsDigest' | 'builtinModelsDigest'>;
export type WorkerIdentityEvidence = 'runtime-configured' | 'backend-attested' | 'unknown' | 'mismatched';

/** Current, trusted qualification projection supplied by the installation owner.
 * Task requests cannot introduce bindings or promote identity evidence. */
export interface WorkerResolutionBinding {
  cliVersion: string;
  accountScope: string;
  endpointFingerprint: string;
  profile: string;
  identityEvidence: WorkerIdentityEvidence;
  mcp?: WorkerInvocationProfile['mcp'];
  boundary?: WorkerBoundary;
}

export interface WorkerPlanSnapshot {
  config: AiwgConfig;
  /** Timestamped host sample supplied by the launch host; never request-controlled. */
  hostResources?: HostResourceSample;
  /** ConfigLoader.load(parallelism), including restriction origins and wrapper pins. */
  models: MergedModelConfig;
  modelDigests: ModelInputDigests;
  catalog: DynamicModelCatalog;
  registry: ProviderModelCapabilityRegistry;
  installations: Record<string, WorkerResolutionBinding>;
  /** Current trusted restrictions; these can only remove candidates. */
  constraints?: { revokedModels?: string[]; unavailableMembers?: string[]; maxParallel?: number; ceilings?: WorkerResolutionCeilings };
}

export interface WorkerResolutionCeilings {
  tokens?: number;
  costUsd?: number;
  wallSeconds?: number;
  maxAttempts?: number;
}

export interface WorkerChoice {
  group: string;
  member: string;
  model: string;
  effort: string | null;
}

export interface WorkerPlanRequest {
  role?: string;
  taskClass?: string;
  group?: string;
  member?: string;
  model?: string;
  effort?: string | null;
  dataClass?: string;
  transport?: 'shell' | 'mcp';
  context: WorkerContextEstimate;
  /** Explicit clock makes freshness and replay reproducible. */
  now: string;
  expectedDigests?: Record<string, string>;
  choice?: WorkerChoice & { rationale: string };
  /** Only the named, eligible replacement may depart from an exact pin. */
  substitution?: WorkerChoice & { rationale: string };
  reviewOf?: WorkerModelObservation;
  /** Enforce observed family diversity; this does not establish independent errors or correctness. */
  requireDifferentFamily?: boolean;
  authority?: ModelRouteRequest;
  requiredControls?: string[];
  maxParallel?: number;
  ceilings?: WorkerResolutionCeilings;
}

export interface WorkerEligibleTuple extends WorkerChoice {
  cli: string;
  inferenceProvider: string;
  modelKey: string;
  family: string;
  identityEvidence: WorkerIdentityEvidence;
  profile: string;
  transport: 'shell' | 'mcp';
  permissions: WorkerExecution;
  context: ReturnType<typeof workerContextHeadroom>;
  observedAt: string;
  verifiedAt: string;
  observationRef: string;
  effectiveMaxParallel: number | null;
  resources?: HostResourceReport;
  diagnostics: WorkerPolicyDiagnostic[];
}

export interface WorkerResolutionPlan {
  mode: 'direct' | 'managed';
  status: 'disabled' | 'eligible' | 'blocked';
  role: string | null;
  selected: WorkerEligibleTuple | null;
  eligible: WorkerEligibleTuple[];
  alternatives: WorkerEligibleTuple[];
  exclusions: Array<{ group: string; member: string; model: string; effort: string | null; diagnostics: WorkerPolicyDiagnostic[] }>;
  diagnostics: WorkerPolicyDiagnostic[];
  digests: Record<string, string>;
  policy: MergedModelConfig['defaults']['workerSelection'];
  origins: MergedModelConfig['workerPolicyOrigins'];
  choice: { source: 'conductor' | 'default'; rationale: string; substitution?: WorkerPlanRequest['substitution'] } | null;
  capacity: 'conductor-guidance-only';
  resources?: HostResourceReport;
  slots?: number;
  ceilings: WorkerResolutionCeilings;
}

const matchesChoice = (tuple: WorkerChoice, choice: WorkerChoice): boolean =>
  tuple.group === choice.group && tuple.member === choice.member && tuple.model === choice.model && tuple.effort === choice.effort;

function findWorkerModelRow(rows: DiscoveredModel[] | undefined, model: string): DiscoveredModel | undefined {
  const matches = rows?.filter(row => row.id === model || row.apiModelId === model) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

function workerCatalogDigest(catalog: DynamicModelCatalog): string {
  if (!catalog.discovery) return workerConfigDigest(catalog);
  // Offline loads synthesize fetchedAt. Keep catalog facts and persisted
  // observation/qualification times pinned, independent of the load clock.
  const { fetchedAt, ...discovery } = catalog.discovery;
  return workerConfigDigest({ ...catalog, discovery });
}

/** Pure S1 resolution. No probing, launch, activation, admission, or writes.
 * Recheck against freshly loaded snapshots before preparing an invocation. */
export function resolveWorkerPlan(snapshot: WorkerPlanSnapshot, request: WorkerPlanRequest,
  ceilingDefaults: WorkerResolutionCeilings = {}): WorkerResolutionPlan {
  let parallelism: ReturnType<typeof resolveParallelism> | NonNullable<WorkerPlanSnapshot['config']['parallelism']> = snapshot.config.parallelism ?? {};
  const policy = snapshot.models.defaults.workerSelection;
  const digests = {
    ...snapshot.modelDigests,
    configDigest: workerActivationDigests(snapshot.config).configDigest,
    resolvedModelsDigest: workerConfigDigest(snapshot.models),
    catalogDigest: workerCatalogDigest(snapshot.catalog),
    profileDigest: workerConfigDigest([snapshot.registry, snapshot.installations]),
    constraintsDigest: workerConfigDigest(snapshot.constraints),
  };
  const plan: WorkerResolutionPlan = {
    mode: parallelism.worker_mode ?? 'direct', status: 'blocked', role: null, selected: null,
    eligible: [], alternatives: [], exclusions: [], diagnostics: [], digests,
    policy: structuredClone(policy), origins: structuredClone(snapshot.models.workerPolicyOrigins),
    choice: null, capacity: 'conductor-guidance-only', ceilings: {},
  };
  const resourceInput = { config: snapshot.config, live: snapshot.hostResources ?? { supported: false, reason: 'host snapshot missing' },
    now: () => Date.parse(request.now) };
  plan.resources = hostResourceReport(resourceInput);
  plan.slots = plan.resources.slots;
  const diagnostic = (code: WorkerPolicyDiagnostic['code'], pointer: string, message: string): WorkerPolicyDiagnostic => ({ code, pointer, message });
  const block = (code: WorkerPolicyDiagnostic['code'], pointer: string, message: string): void => {
    plan.diagnostics.push(diagnostic(code, pointer, message));
  };
  if (!parallelism.worker_dispatch) {
    plan.status = 'disabled';
    block('OG_CONFIG_REFERENCE', '/parallelism/worker_dispatch',
      `Direct worker dispatch is off (parallelism.worker_dispatch). Enable with \`${WORKER_DISPATCH_ENABLE_COMMAND}\` `
      + `(then check readiness with \`${WORKER_DISPATCH_READINESS_COMMAND}\`).`);
    return plan;
  }
  const now = new Date(request.now);
  if (!Number.isFinite(now.getTime())) block('OG_CONFIG_REFERENCE', '/request/now', 'A valid current clock is required');
  if (!request.context || typeof request.context.estimator !== 'string') block('OG_CONFIG_REFERENCE', '/request/context', 'A named, bounded context estimate is required');
  if (snapshot.constraints?.revokedModels?.some(key => !isCanonicalWorkerModelKey(key))) block('OG_CONFIG_REFERENCE', '/constraints/revokedModels', 'Revocations require canonical inference model keys');
  if (request.expectedDigests && (Object.keys(request.expectedDigests).length !== Object.keys(digests).length
    || Object.entries(digests).some(([key, value]) => request.expectedDigests![key] !== value))) {
    block('OG_CONFIG_REFERENCE', '/request/expectedDigests', 'Current input digests changed; resolve again');
  }
  if (Object.values(snapshot.modelDigests).length !== 3 || Object.values(digests).some(value => !/^sha256:[a-f0-9]{64}$/.test(value))) {
    block('OG_CONFIG_REFERENCE', '/models', 'Current loader input digests are required');
  }
  if (plan.mode === 'managed') {
    const activation = parallelism.activation;
    if (!activation || ['configDigest', 'projectModelsDigest', 'userModelsDigest', 'builtinModelsDigest'].some(key =>
      activation[key as keyof WorkerActivation] !== digests[key as keyof typeof digests])) {
      block('OG_CONFIG_REFERENCE', '/parallelism/activation', 'Managed activation is missing or stale');
    }
  }
  if (!policy) block('OG_CONFIG_REFERENCE', '/defaults/workerSelection', 'Current merged worker policy is required');
  const catalogErrors = validateWorkerCatalogDiscovery(snapshot.catalog.discovery);
  if (catalogErrors.length) block('OG_ADAPTER_UNQUALIFIED', '/catalog/discovery', catalogErrors.join('; '));
  if (plan.diagnostics.length || !policy) return plan;
  const policyShape = WorkerSelectionPolicySchema.safeParse(policy);
  if (!policyShape.success) {
    block('OG_CONFIG_REFERENCE', '/defaults/workerSelection', policyShape.error.message);
    return plan;
  }
  for (const message of validateWorkerGroupReferences(parallelism, policy)) block('OG_CONFIG_REFERENCE', '/parallelism', message);
  if (plan.diagnostics.length) return plan;
  parallelism = resolveParallelism(parallelism, snapshot.config.providers?.[0]);
  const resolvedCeilings = resolveWorkerCeilings(parallelism, snapshot.constraints?.ceilings, request.ceilings, ceilingDefaults);
  plan.ceilings = resolvedCeilings.ceilings;
  plan.origins = { ...plan.origins, ...resolvedCeilings.origins };
  plan.diagnostics.push(...resolvedCeilings.diagnostics);
  if (plan.ceilings.maxAttempts === 0) block('OG_BUDGET_UNMEASURABLE', '/request/ceilings/maxAttempts', 'No task attempts remain');
  const qualifiedRoles: Record<string, string[]> = {};
  for (const [groupId, group] of Object.entries(parallelism.groups ?? {})) {
    for (const member of group.members ?? []) {
      const observed = findWorkerModelRow(snapshot.catalog.discovery?.instances?.[member.cli]?.models, member.model)?.worker;
      qualifiedRoles[`${groupId}/${member.id}`] = observed?.qualification.status === 'qualified'
        ? observed.qualification.roles.filter(role => ownWorkerRoleGuidance(policy, role)?.groups.includes(groupId)) : [];
    }
  }
  // Qualification gaps are group-scoped: an unqualified group must not block a
  // request that never considers it. Gaps are applied once the candidates are known.
  const qualificationGaps = validateWorkerGroupQualifications(parallelism, qualifiedRoles).map(diagnostic => ({
    ...diagnostic, message: `${diagnostic.message}. Run aiwg doctor --probe-workers --qualify.`,
  }));
  const gapGroup = (diagnostic: WorkerPolicyDiagnostic): string => diagnostic.pointer.split('/')[3] ?? '';
  const taskRole = request.taskClass && policy.taskClasses && Object.hasOwn(policy.taskClasses, request.taskClass) ? policy.taskClasses[request.taskClass] : undefined;
  const role = request.role ?? taskRole;
  plan.role = role ?? null;
  if (request.taskClass && (!taskRole || request.role && taskRole !== request.role)) block('OG_CONFIG_REFERENCE', '/request/taskClass', 'Unknown task class or conflicting role');
  const guidance = role ? ownWorkerRoleGuidance(policy, role) : undefined;
  if (!role || !guidance) block('OG_CONFIG_REFERENCE', '/defaults/workerSelection/roleGuidance', 'Requested role has no guidance');
  if (request.member && !request.group) block('OG_CONFIG_REFERENCE', '/request/member', 'Group-local member pins require a group');
  if (request.group && !guidance?.groups.includes(request.group)) block('OG_CONFIG_REFERENCE', '/request/group', 'Group is outside role guidance');
  if ([request.maxParallel, snapshot.constraints?.maxParallel].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) block('OG_CONFIG_REFERENCE', '/request/maxParallel', 'Capacity ceilings must be nonnegative integers');
  plan.diagnostics.push(...workerReviewLineageDiagnostics(request));
  const candidateGroups = request.group ? [request.group] : guidance?.groups ?? [];
  const unqualifiedGroups = new Set(qualificationGaps.map(gapGroup));
  const qualifiedGroups = candidateGroups.filter(groupId => !unqualifiedGroups.has(groupId));
  if (!qualifiedGroups.length) {
    plan.diagnostics.push(...qualificationGaps.filter(gap => candidateGroups.includes(gapGroup(gap))));
  } else {
    // Unpinned requests skip an unqualified guidance group visibly instead of failing the role.
    for (const groupId of candidateGroups.filter(groupId => unqualifiedGroups.has(groupId))) {
      const gaps = qualificationGaps.filter(gap => gapGroup(gap) === groupId);
      for (const member of parallelism.groups?.[groupId]?.members ?? []) {
        plan.exclusions.push({ group: groupId, member: member.id, model: member.model, effort: null, diagnostics: gaps });
      }
    }
  }
  if (plan.diagnostics.length || !role || !guidance) return plan;
  const baseRole = guidance.baseRole ?? role;
  const wrapperPin = snapshot.models.agentOverrides[MODEL_WRAPPERS[baseRole as keyof typeof MODEL_WRAPPERS]]?.['model-override'];
  const groupPolicies = new Map<string, typeof policy>();
  const groups = qualifiedGroups;
  for (const groupId of groups) {
    const group = parallelism.groups![groupId];
    const narrowed = mergeGroupWorkerPolicy(policy, group);
    groupPolicies.set(groupId, narrowed.policy);
    if (narrowed.diagnostics.length) { plan.diagnostics.push(...narrowed.diagnostics); continue; }
    const groupPolicy = narrowed.policy;
    const permissions = { ...group.execution, transport: group.execution?.transport ?? 'shell' };
    const transport = permissions.transport;
    if (request.transport === 'mcp' && permissions.launchMode === 'native-sandbox') {
      const reason = diagnostic('OG_POLICY_RELAXATION', `/parallelism/groups/${groupId}/execution/launchMode`,
        'MCP worker-invoke does not support native-sandbox isolation. Use models resolve --transport shell and the shell launcher, or select a group with systemd-unit isolation.');
      for (const member of group.members ?? []) plan.exclusions.push({ group: groupId, member: member.id, model: member.model, effort: null, diagnostics: [reason] });
      if (request.group === groupId) plan.diagnostics.push(reason);
      continue;
    }
    // Priority is guidance only. Preserve declaration order for ties; fallback order stays explicit.
    const members = (group.members ?? []).map((member, index) => ({ member, index })).sort((a, b) =>
      (a.member.priority ?? 100) - (b.member.priority ?? 100) || a.index - b.index);
    for (const { member } of members) {
      const binding = snapshot.installations[member.cli];
      const discovery = snapshot.catalog.discovery?.instances?.[member.cli];
      const row = findWorkerModelRow(discovery?.models, member.model);
      const observation = row?.worker;
      const efforts = request.effort !== undefined ? [request.effort]
        : [...new Set([guidance.initialEffort, ...guidance.effortLadder])];
      for (const effort of efforts) {
        const tuple = { group: groupId, member: member.id, model: member.model, effort };
        const reasons: WorkerPolicyDiagnostic[] = [];
        const deny = (code: WorkerPolicyDiagnostic['code'], pointer: string, message: string): void => { reasons.push(diagnostic(code, pointer, message)); };
        const pointer = `/parallelism/groups/${groupId}/members/${member.id}`;
        if (request.transport !== undefined && request.transport !== transport) deny('OG_POLICY_RELAXATION', '/request/transport', 'Requested transport differs from resolved group permissions');
        if (member.enabled === false || parallelism.clis?.[member.cli]?.enabled === false) deny('OG_CONFIG_REFERENCE', pointer, 'Member or installation is disabled');
        if (!member.roles.includes(baseRole as 'coding' | 'reasoning' | 'efficiency')) deny('OG_CONFIG_REFERENCE', pointer, 'Member does not cover requested role');
        const pinMismatch = request.member && request.member !== member.id || request.model && request.model !== member.model || wrapperPin && wrapperPin !== member.model;
        const substitution = request.substitution && matchesChoice(tuple, request.substitution) && request.substitution.rationale.trim();
        if (pinMismatch && !substitution) deny('OG_PIN_MISMATCH', pointer, 'Exact request or wrapper pin requires explicit substitution');
        if (!observation || !binding || !row?.llmProvider || !row.apiModelId) deny('OG_ADAPTER_UNQUALIFIED', pointer, 'Missing exact model, inference provider, observation or current installation evidence. Run aiwg doctor --probe-workers --qualify.');
        if (observation && binding && row?.llmProvider && row.apiModelId) {
          const shapeErrors = validateWorkerModelObservation(observation);
          if (shapeErrors.length) {
            deny('OG_ADAPTER_UNQUALIFIED', '/worker', shapeErrors.join('; '));
            plan.exclusions.push({ ...tuple, diagnostics: reasons });
            continue;
          }
          if (observation.cliId !== member.cli || observation.runtimeVersion !== binding.cliVersion
            || observation.accountScope !== binding.accountScope || observation.endpointFingerprint !== binding.endpointFingerprint
            || discovery?.accountBinding !== binding.accountScope || discovery?.runtimeVersion !== binding.cliVersion
            || parallelism.clis?.[member.cli]?.accountScope && parallelism.clis[member.cli].accountScope !== binding.accountScope) {
            deny('OG_ADAPTER_UNQUALIFIED', pointer, 'Catalog and current installation scope differ');
          }
          if (group.efforts && (effort === null || !group.efforts.includes(effort))) deny('OG_EFFORT_DENIED', pointer, 'Effort is outside group ceiling');
          reasons.push(...validateWorkerPolicyRoute({ policy: groupPolicy, role, inferenceProvider: row.llmProvider, apiModelId: row.apiModelId,
            selectedModel: member.model, effort, identityEvidence: binding.identityEvidence, observation,
            wrapperPin, ...(substitution ? { substitution: request.substitution } : {}), dataClass: request.dataClass, now, context: request.context }));
          reasons.push(...workerReviewLineageDiagnostics({ ...request, reviewer: observation }));
          try {
            const { adapter } = resolveWorkerGroupInstallation(parallelism, member.cli, snapshot.registry);
            const configuredProfile = parallelism.clis?.[member.cli]?.invocationProfile;
            const profilePointer = `/parallelism/clis/${member.cli}/invocationProfile`;
            if (configuredProfile && !Object.hasOwn(adapter.invocationProfiles ?? {}, configuredProfile)) {
              deny('OG_CONFIG_REFERENCE', profilePointer, 'Configured invocation profile is not registered for this adapter; select a registered profile.');
            } else if (configuredProfile && configuredProfile !== binding.profile) {
              deny('OG_PIN_MISMATCH', profilePointer, 'Configured invocation profile differs from installation qualification; qualify the selected profile again.');
            }
            const configuredServer = parallelism.clis?.[member.cli]?.mcpServerRef;
            if (transport === 'mcp' && configuredServer && configuredServer !== binding.mcp?.serverRef) throw new Error('Configured MCP server changed');
            if (!hasOperatorWorkerNativeRenderer(adapter) && (adapter.capabilities.modelPin === 'unsupported' || !adapter.capabilities.nativeFallbackControllable)) throw new Error('Exact model or fallback control is unqualified; qualify an adapter with these controls');
            if (policy.guards?.denySelfDelegation !== false && !adapter.capabilities.nestedAgentsControllable) throw new Error('Child-agent control is unqualified. Review models.json defaults.workerSelection.guards.denySelfDelegation; false permits uncontrolled child agents without qualifying their behavior.');
            if (binding.identityEvidence === 'backend-attested' && adapter.capabilities.modelPin !== 'observed') throw new Error('Requested-only mapping cannot attest backend identity');
            if (!hasOperatorWorkerNativeRenderer(adapter) && group.execution?.sandbox && !adapter.capabilities.sandboxModes.includes(group.execution.sandbox)) throw new Error('Requested sandbox mode is unqualified');
            assertWorkerLaunchMode(adapter, permissions);
            qualifyWorkerInvocationProfile(adapter, { profile: binding.profile, transport, cliVersion: binding.cliVersion,
              policy, permissions, effort, boundary: binding.boundary,
              requiredControls: request.requiredControls, mcp: binding.mcp });
            if (hasOperatorWorkerNativeRenderer(adapter) && transport === 'shell' && permissions.sandbox === 'external') {
              reasons.push({ code: 'OG_SANDBOX_EXTERNAL', blocking: false,
                pointer: `/parallelism/groups/${groupId}/execution/sandbox`,
                message: `${adapter.provider} CLI's own sandbox is disabled by explicit external policy; isolation relies on the per-task worktree and launcher resource scope.` });
            }
            const { maxAttempts: _maxAttempts, ...budgetLimits } = plan.ceilings;
            const budgetDimensions = { tokens: 'tokens', cost: 'costUsd', 'wall-time': 'wallSeconds' } as const;
            const enforceable = adapter.capabilities.hardBudget.map(key => budgetDimensions[key as keyof typeof budgetDimensions]);
            for (const message of validateWorkerBudgetEnforcement({ ...parallelism.budgets, perTask: budgetLimits }, enforceable)) deny('OG_BUDGET_UNMEASURABLE', '/parallelism/budgets', message);
          } catch (error) { deny('OG_ADAPTER_UNQUALIFIED', pointer, String(error)); }
          let key: string;
          try { key = workerModelKey(row.llmProvider, row.apiModelId); }
          catch { plan.exclusions.push({ ...tuple, diagnostics: reasons }); continue; }
          if (snapshot.constraints?.revokedModels?.includes(key)) deny('OG_MODEL_UNAPPROVED', '/constraints/revokedModels', 'Current model revocation');
          if (snapshot.constraints?.unavailableMembers?.includes(`${groupId}/${member.id}`)) deny('OG_ADAPTER_UNQUALIFIED', pointer, 'Member is currently unavailable');
          const flagship = normalizeModelTier(guidance.tier) === 'flagship' || isFlagshipModel(row.apiModelId);
          if (flagship && !flagshipElected(request.authority ?? {})) deny('OG_MODEL_UNAPPROVED', '/request/authority', 'Flagship models are user-elected only');
          const premium = ['premium', 'flagship', 'max-quality'].includes(guidance.tier) || observation.pricing.costClass === 'premium';
          // Worker candidates always invoke a model; deterministic/routine hints must not bypass premium authority.
          const authority = routeModelTier({ ...request.authority, deterministic: false, routine: false, requestedTier: flagship ? 'flagship' : undefined,
            defaultTier: guidance.tier === 'economy' ? 1 : 2, requestedPremium: premium || request.authority?.requestedPremium });
          if (authority.requiresConfirmation) deny('OG_MODEL_UNAPPROVED', '/request/authority', `${authority.rationale.join('; ')}; agents may pass --authorize-premium only after the human explicitly confirmed the premium escalation (escalation-discipline rule)`);
          const installation = parallelism.clis?.[member.cli];
          const admission = parallelism.admission;
          const capEntries = [
            ['max_parallel_subagents', parallelism.max_parallel_subagents], ['group.maxParallel', group.maxParallel],
            ['admission.groupCaps', admission?.groupCaps?.[groupId]],
            ['admission.memberCaps', admission?.memberCaps?.[`${groupId}/${member.id}`]],
            ['admission.cliCaps', admission?.cliCaps?.[member.cli]], ['admission.modelCaps', admission?.modelCaps?.[key]],
            ['admission.quotaCaps', installation && admission?.quotaCaps?.[installation.quotaScope]],
          ] as const;
          const caps = [...capEntries.map(([, value]) => value), snapshot.constraints?.maxParallel, request.maxParallel]
            .filter((value): value is number => value !== undefined);
          // The shared report owns project/group caps; the remaining entries scope the tuple.
          const resources = hostResourceReport({ ...resourceInput, group: groupId,
            caps: [...capEntries.slice(3).map(([threshold, limit]) => ({ threshold, limit })),
              { threshold: 'constraints.maxParallel', limit: snapshot.constraints?.maxParallel, running: 0 },
              { threshold: 'request.maxParallel', limit: request.maxParallel, running: 0 }] });
          if (resources) {
            if (!plan.eligible.length) { plan.resources = resources; plan.slots = resources.slots; }
            if (!resources.ok) deny('OG_ADAPTER_UNQUALIFIED', '/parallelism/admission/hostResources',
              resources.failures.map(failure => `${failure.signal}: ${failure.reason}`).join('; '));
          }
          const effectiveMaxParallel = caps.length ? Math.min(...caps) : null;
          if (effectiveMaxParallel === 0) deny('OG_ADAPTER_UNQUALIFIED', '/constraints/maxParallel', 'Current capacity ceiling is zero');
          if (!reasons.some(reason => reason.blocking !== false)) plan.eligible.push({ ...tuple, cli: member.cli,
            inferenceProvider: row.llmProvider, modelKey: key, family: observation.family, identityEvidence: binding.identityEvidence,
            profile: binding.profile, transport,
            permissions: structuredClone(permissions), context: workerContextHeadroom(request.context, observation),
            observedAt: observation.observedAt, verifiedAt: observation.verifiedAt, observationRef: observation.recordId,
            effectiveMaxParallel, ...(resources ? { resources } : {}), diagnostics: reasons });
        }
        if (reasons.some(reason => reason.blocking !== false)) plan.exclusions.push({ ...tuple, diagnostics: reasons });
      }
    }
  }
  if (request.choice) {
    if (!request.choice.rationale.trim()) block('OG_CONFIG_REFERENCE', '/request/choice/rationale', 'Conductor choice requires a rationale');
    plan.selected = plan.eligible.find(tuple => matchesChoice(tuple, request.choice!)) ?? null;
    if (!plan.selected) block('OG_MODEL_UNAPPROVED', '/request/choice', 'Conductor choice is outside the eligible set');
  } else plan.selected = plan.eligible[0] ?? null;
  if (plan.diagnostics.length) plan.selected = null;
  if (plan.selected) {
    if (plan.selected.resources) { plan.resources = plan.selected.resources; plan.slots = plan.resources.slots; }
    plan.policy = groupPolicies.get(plan.selected.group);
    plan.status = 'eligible';
    plan.diagnostics.push(...plan.selected.diagnostics.filter(item => item.code === 'OG_SANDBOX_EXTERNAL'));
    plan.choice = { source: request.choice ? 'conductor' : 'default', rationale: request.choice?.rationale ?? 'Role group order, member priority/declaration order, then qualified effort ladder',
      ...(request.substitution && matchesChoice(plan.selected, request.substitution) ? { substitution: structuredClone(request.substitution) } : {}) };
  }
  if (!plan.selected && plan.resources?.slots === 0) {
    block('OG_ADAPTER_UNQUALIFIED', '/parallelism/admission/hostResources',
      plan.resources.failures.map(failure => `${failure.signal}: ${failure.reason}`).join('; '));
  }
  plan.alternatives = plan.eligible.filter(tuple => tuple !== plan.selected);
  return plan;
}
