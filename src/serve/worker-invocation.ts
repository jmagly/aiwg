import { WorkerRequestArgumentError, type WorkerCommandRequest } from './worker-command-request.js';
export { parseWorkerCommandArgs, type WorkerCommandRequest } from './worker-command-request.js';
/** One nonlaunching typed renderer shared by models resolve and Ralph. */
import path from 'node:path';
import { inspectWorkerPath as inspectPath, workerOutputPaths, readBrief, assertConductorWorkerPlan } from './worker-invocation-paths.js';
export { inspectWorkerPath } from './worker-invocation-paths.js';
import { createHash, randomUUID } from 'node:crypto';
import { resolveWorkerPlan, type WorkerPlanSnapshot, type WorkerResolutionPlan } from '../models/resolver.js';
import { workerConfigDigest, validateWorkerHealthConfig } from '../config/aiwg-config.js';
import { intersectWorkerCeilings } from '../models/worker-ceilings.js';
import type { McpServerRegistry, McpWorkerQualificationInput } from '../mcp/registry.js';
import type { McpProfile } from '../mcp/profiles.js';
import { assertValidWorkerPayload } from '../mission-protocol/codecs.js';
import type { WorkerResolvedInvocation, WorkerEffectiveHealth } from '../mission-protocol/types.js';
import type { WorkerPolicyDiagnostic } from '../models/types.js';
import { qualificationDigest } from '../models/qualification-digest.mjs';
import { prepareWorkerInvocation, type WorkerInvocationQualification } from './worker-invocation-preparation.js';
export { prepareWorkerInvocation, mcpToolSchemaDigest, type WorkerInvocationQualification, type WorkerInstallationRequest } from './worker-invocation-preparation.js';
import type { WorkerExecution, ParallelismConfig } from '../config/aiwg-config.js';
import { isOperatorQualifiedWorkerAdapter, assertOperatorWorkerNativeArgv,
  assertWorkerLaunchMode, WorkerRoleEffortError, requiredWorkerControls, isCanonicalWorkerModelKey, WorkerPolicyError, DEFAULT_WORKER_SELECTION } from '../models/provider-policy.js';

/** Frozen per-attempt windows; parent/transport ceilings include time already spent. */
export function resolveWorkerEffectiveHealth(config: ParallelismConfig['health'], input: {
  role: string; effort: string | null; modelKey: string; profileRef: string; wallSeconds: number;
  transportSeconds?: number; remainingSteps?: number; stepEnforcement: WorkerEffectiveHealth['stepEnforcement'];
  startupCeilingSeconds?: number; checkSeconds?: number; profileSteps?: number;
}): WorkerEffectiveHealth {
  const roleDefaults: Record<string, number> = { efficiency: 1, coding: 1, reasoning: 2 };
  const effortDefaults: Record<string, number> = { xhigh: 2, max: 3 };
  if (!Object.hasOwn(roleDefaults, input.role) || !isCanonicalWorkerModelKey(input.modelKey)) throw new Error('Invalid worker health role/model identity');
  const configErrors = validateWorkerHealthConfig(config);
  if (configErrors.length) throw new Error(configErrors.join('; '));
  if (config?.requireStepCap && !['native', 'external'].includes(input.stepEnforcement)) throw new Error('Required model-step cap is not qualified for enforcement');
  for (const value of [input.wallSeconds, input.transportSeconds, input.remainingSteps, input.startupCeilingSeconds, input.checkSeconds, input.profileSteps]) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error('Invalid remaining worker health ceiling');
  }
  const factors = [config?.roleScale?.[input.role as 'efficiency' | 'coding' | 'reasoning'] ?? roleDefaults[input.role] ?? 1,
    input.effort === null ? 1 : config?.effortScale?.[input.effort] ?? effortDefaults[input.effort] ?? 1,
    config?.modelScale?.[input.modelKey] ?? 1];
  if (factors.some(factor => !Number.isFinite(factor) || factor < 1)) throw new Error('Invalid worker health scale');
  const scale = Math.max(1, Math.min(6, Math.max(...factors)));
  const pointer = (field: keyof NonNullable<ParallelismConfig['health']>): string => config?.[field] === undefined ? `defaults/parallelism.health.${field}` : `/parallelism/health/${field}`;
  const origins: Record<string, string[]> = {};
  for (const field of ['startupSeconds', 'checkSeconds', 'quietSeconds', 'stallSeconds', 'diagnosticGraceSeconds', 'terminateGraceSeconds', 'hardTimeoutSeconds', 'maxSteps'] as const) origins[field] = [pointer(field)];
  const modelPointer = input.modelKey.replace(/~/g, '~0').replace(/\//g, '~1');
  if (config?.modelStartupSeconds?.[input.modelKey] !== undefined) origins.startupSeconds = [`/parallelism/health/modelStartupSeconds/${modelPointer}`];
  const factorOrigins = [config?.roleScale?.[input.role as 'efficiency' | 'coding' | 'reasoning'] === undefined ? `defaults/parallelism.health.roleScale.${input.role}` : `/parallelism/health/roleScale/${input.role}`,
    input.effort === null || config?.effortScale?.[input.effort] === undefined ? `defaults/parallelism.health.effortScale.${input.effort ?? 'not-applicable'}` : `/parallelism/health/effortScale/${input.effort.replace(/~/g, '~0').replace(/\//g, '~1')}`,
    config?.modelScale?.[input.modelKey] === undefined ? 'defaults/parallelism.health.modelScale' : `/parallelism/health/modelScale/${modelPointer}`];
  origins.scale = factorOrigins.filter((_, index) => factors[index] === Math.max(...factors));
  const limitingOrigins = (values: Array<[number | undefined, string]>): string[] => {
    const minimum = Math.min(...values.map(([value]) => value ?? Infinity));
    return values.filter(([value]) => value === minimum).map(([, origin]) => origin);
  };
  origins.hardTimeoutSeconds = limitingOrigins([[config?.hardTimeoutSeconds ?? 1800, pointer('hardTimeoutSeconds')], [input.wallSeconds, 'runtime/remainingWallSeconds'], [input.transportSeconds, 'profile/transportSeconds']]);
  origins.maxSteps = limitingOrigins([[config?.maxSteps ?? 100, pointer('maxSteps')], [input.remainingSteps, 'runtime/remainingSteps'], [input.profileSteps, 'profile/maxSteps']]);
  origins.stepEnforcement = ['profile/controls/stepCap'];
  const health: WorkerEffectiveHealth = { version: 1,
    startupSeconds: Math.min(config?.modelStartupSeconds?.[input.modelKey] ?? config?.startupSeconds ?? 60, input.startupCeilingSeconds ?? Infinity),
    checkSeconds: Math.min(config?.checkSeconds ?? 15, input.checkSeconds ?? Infinity), quietSeconds: (config?.quietSeconds ?? 90) * scale,
    stallSeconds: (config?.stallSeconds ?? 300) * scale, diagnosticGraceSeconds: config?.diagnosticGraceSeconds ?? 60,
    terminateGraceSeconds: config?.terminateGraceSeconds ?? 5,
    hardTimeoutSeconds: Math.min(config?.hardTimeoutSeconds ?? 1800, input.wallSeconds, input.transportSeconds ?? Infinity),
    maxSteps: Math.min(config?.maxSteps ?? 100, input.remainingSteps ?? Infinity, input.profileSteps ?? Infinity),
    stepEnforcement: input.stepEnforcement, scale, profileRef: input.profileRef, runDir: null, origins };
  if (input.startupCeilingSeconds !== undefined) origins.startupSeconds = limitingOrigins([[config?.modelStartupSeconds?.[input.modelKey] ?? config?.startupSeconds ?? 60, origins.startupSeconds[0]], [input.startupCeilingSeconds, 'runtime/startupCeilingSeconds']]);
  if (input.checkSeconds !== undefined) origins.checkSeconds = limitingOrigins([[config?.checkSeconds ?? 15, pointer('checkSeconds')], [input.checkSeconds, 'task/checkSeconds']]);
  health.truncatedWindows = (['startup', 'quiet', 'stall'] as const).filter(window => health[`${window}Seconds`] > health.hardTimeoutSeconds);
  health.diagnosticGraceSeconds = Math.min(health.diagnosticGraceSeconds, health.hardTimeoutSeconds);
  health.terminateGraceSeconds = Math.min(health.terminateGraceSeconds, health.hardTimeoutSeconds);
  for (const field of ['diagnosticGraceSeconds', 'terminateGraceSeconds'] as const) {
    if (health[field] === health.hardTimeoutSeconds) origins[field].push(...origins.hardTimeoutSeconds);
  }
  assertValidWorkerPayload('workerEffectiveHealth', health);
  return health;
}

/** Trusted #2885 installation owner supplies driver bindings, never task input. */
export interface WorkerInvocationDriver {
  /** Pure installed-adapter framing; called only to deliver stdin. */
  buildWorkerStdinFrame?(brief: string | Buffer, invocation?: { selected?: { model?: string } }): string | Uint8Array;
  /** Existing adapter extraction; raw stream remains separate and untrusted. */
  extractFinal?(stdout: string): unknown;
  parseWorkerFinal?(output: string | Uint8Array, options: Record<string, unknown>): Promise<unknown>;
  createHealthObserver?(options: Record<string, unknown>): unknown;
  qualification: Omit<WorkerInvocationQualification, 'policy' | 'permissions' | 'role' | 'now' | 'modelObservation' | 'defaultObservation'>;
  mcpRegistry?: Pick<McpServerRegistry, 'get'> & Partial<Pick<McpServerRegistry, 'assertWorkerQualified'>>;
  mcpProfile?: Pick<McpProfile, 'servers' | 'providerOverrides'>;
  /** #2885's existing adapter method retains installation/path/argv rechecks,
   * delegating rendering to this module. Required for installation-scoped profiles. */
  prepareWorkerInvocation?(invocation: WorkerResolvedInvocation, qualification: WorkerInvocationQualification): Promise<WorkerResolvedInvocation>;
  /** Must use the installed qualified driver, not legacy session defaults or template eval. */
  buildInvocation(input: {
    invocationId?: string; selected: WorkerResolvedInvocation['selected']; permissions: WorkerExecution;
    cwd: string; briefPath: string; brief: string; finalPath: string;
    limits: WorkerResolvedInvocation['limits'];
    health: WorkerEffectiveHealth; role?: string;
  }): Promise<Pick<WorkerResolvedInvocation, 'argv' | 'stdin' | 'envNames' | 'mcp' | 'artifacts'>>;
}

const invocationChecks = {
  invocation_build_failed: { pointer: '/invocation/buildInvocation',
    message: 'Worker adapter could not build the invocation; check the selected model, effort, permissions and request paths.' },
  native_argv_invalid: { pointer: '/invocation/argv',
    message: 'Worker adapter arguments do not preserve the requested native controls; review the installed driver and qualify again.' },
  invocation_prepare_failed: { pointer: '/invocation/prepareWorkerInvocation',
    message: 'Worker invocation preparation failed; check installation evidence, policy, paths and environment, then qualify again.' },
  installation_recheck_unavailable: { pointer: '/invocation/prepareWorkerInvocation',
    message: 'The selected profile requires an installation recheck, but the installed driver has no preparation method. Restore the qualified driver and qualify again.' },
  qualified_workspace_mismatch: { pointer: '/request/workdir',
    message: 'Worker workdir differs from the qualified workspace. Use the qualified workspace or run aiwg doctor --probe-workers --qualify from the requested workdir.' },
} satisfies Record<NonNullable<WorkerPolicyDiagnostic['reason']>, { pointer: string; message: string }>;

/** Only fixed check identifiers, never adapter/filesystem error text, cross this boundary. */
export class WorkerInvocationCheckError extends WorkerPolicyError {
  constructor(code: WorkerPolicyDiagnostic['code'], public readonly reason: keyof typeof invocationChecks) {
    super(code, invocationChecks[reason].message);
  }
}

/** Nonlaunching build and native-control check shared by resolution and doctor. */
export async function buildWorkerInvocationTransport(driver: Pick<WorkerInvocationDriver, 'qualification' | 'buildInvocation'>,
  input: Parameters<WorkerInvocationDriver['buildInvocation']>[0]): ReturnType<WorkerInvocationDriver['buildInvocation']> {
  assertWorkerLaunchMode(driver.qualification.adapter, input.permissions);
  let transport: Awaited<ReturnType<WorkerInvocationDriver['buildInvocation']>>;
  try { transport = await driver.buildInvocation(input); }
  catch (error) {
    throw new WorkerInvocationCheckError(error instanceof WorkerPolicyError ? error.code : 'OG_ADAPTER_UNQUALIFIED', 'invocation_build_failed');
  }
  if (driver.qualification.adapter.invocationProfiles?.[input.selected.profileRef]?.transport === 'shell') {
    try { assertOperatorWorkerNativeArgv(driver.qualification.adapter, transport.argv!, input.selected, input.permissions); }
    catch { throw new WorkerInvocationCheckError('OG_ADAPTER_UNQUALIFIED', 'native_argv_invalid'); }
  }
  return transport;
}

const bytesDigest = (bytes: Buffer | string): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export type WorkerCommandPlan = WorkerResolutionPlan & { invocation?: WorkerResolvedInvocation; request?: WorkerCommandRequest };

/** Structured root-check failure; only these explicit path details are public. */
export class WorkerPathScopeError extends WorkerPolicyError {
  readonly pointer: string;

  constructor(key: 'briefPath' | 'stdoutPath' | 'stderrPath' | 'finalPath', filename: string, roots: string[]) {
    super('OG_CONFIG_REFERENCE', `${filename} must be inside the worker-writable ${roots.length === 1 ? 'root' : 'roots'} ${roots.join(', ')}.`);
    this.pointer = key === 'briefPath' ? '/request/brief' : '/request/finalOutput';
  }
}

/** Re-resolve saved JSON through the same trusted owners; saved argv is never authority. */
export async function revalidateWorkerInvocationPlan(saved: WorkerCommandPlan, snapshot: WorkerPlanSnapshot,
  drivers: Record<string, WorkerInvocationDriver>, now = new Date().toISOString(), invocationPath?: string): Promise<WorkerResolvedInvocation> {
  const managed = saved.mode === 'managed' && snapshot.config.parallelism?.worker_mode === 'managed';
  if (!saved.request || (saved.mode !== 'direct' && !managed) || saved.mode !== (snapshot.config.parallelism?.worker_mode ?? 'direct') || saved.status !== 'eligible'
    || (managed && saved.invocation?.mode !== 'managed')
    || saved.invocation?.readiness !== 'launchable' || Date.parse(saved.invocation.expiresAt) <= Date.parse(now)) {
    throw new Error('A fresh launchable models resolve JSON plan is required');
  }
  assertValidWorkerPayload('workerResolvedInvocation', saved.invocation);
  if (saved.invocation.invocationId) await assertConductorWorkerPlan(saved, invocationPath, drivers);
  const current = await resolveWorkerInvocation(snapshot, saved.request, drivers, now,
    { digests: saved.digests, briefDigest: saved.invocation.briefDigest ?? null, invocationId: saved.invocation.invocationId });
  // Expiry is calculated from the resolution clock. All execution bindings,
  // controls, thresholds and paths must remain byte-for-byte digest equivalent.
  if (!current.invocation || current.status !== 'eligible'
    || Date.parse(saved.invocation.expiresAt) > Date.parse(current.invocation.expiresAt)
    || qualificationDigest({ ...current.invocation, expiresAt: saved.invocation.expiresAt }) !== qualificationDigest(saved.invocation)) {
    throw new WorkerPolicyError('OG_PIN_MISMATCH', 'Saved invocation differs from current qualified plan; resolve again');
  }
  return structuredClone(saved.invocation);
}

/** Snapshot/driver inputs are supplied by the existing trusted installation owner.
 * This function does no probing, spawning, registration, admission or writes. */
export async function resolveWorkerInvocation(snapshot: WorkerPlanSnapshot, request: WorkerCommandRequest,
  drivers: Record<string, WorkerInvocationDriver>, now = new Date().toISOString(),
  expected?: { digests: Record<string, string>; briefDigest: string | null; invocationId?: string }): Promise<WorkerCommandPlan> {
  snapshot = structuredClone(snapshot);
  request = structuredClone(request);
  let pointer = '/request/brief';
  let failureCode: WorkerPolicyDiagnostic['code'] = 'OG_CONFIG_REFERENCE';
  let plan: WorkerCommandPlan | undefined;
  try {
    const managedIntent = request.managedIntent;
    if (managedIntent) {
      assertValidWorkerPayload('workerSelectionIntent', managedIntent);
      if (snapshot.config.parallelism?.worker_mode !== 'managed'
        || managedIntent.role !== request.role || managedIntent.taskClass !== request.task || managedIntent.group !== request.group) {
        throw new Error('Managed task authority differs from the worker request');
      }
    }
    for (const key of ['brief', 'workdir', 'final_output'] as const) {
      if (!path.isAbsolute(request[key])) throw new WorkerRequestArgumentError(key);
    }
    const bytes = await readBrief(request.brief);
    const briefDigest = bytes === null ? null : bytesDigest(bytes);
    if (expected && expected.briefDigest !== briefDigest) throw new WorkerPolicyError('OG_PIN_MISMATCH', 'Brief digest changed; resolve again');
    let brief: import('../mission-protocol/types.js').WorkerDirectBrief | import('../mission-protocol/types.js').WorkerBrief | undefined;
    if (bytes?.toString('utf8').trimStart().startsWith('{')) {
      brief = JSON.parse(bytes.toString('utf8'));
      assertValidWorkerPayload(managedIntent ? 'workerBrief' : 'workerDirectBrief', brief);
      if (managedIntent && workerConfigDigest(brief!.intent) !== workerConfigDigest(managedIntent)) {
        throw new Error('Managed brief differs from parent task authority');
      }
      if (brief!.intent.role !== (snapshot.models.defaults.workerSelection?.roleGuidance?.[request.role]?.baseRole ?? request.role) || brief!.intent.taskClass !== request.task || brief!.intent.group !== request.group
        || brief!.workspace.path !== request.workdir || brief!.output.resultPath !== request.final_output) {
        throw new WorkerPolicyError('OG_PIN_MISMATCH', 'Brief role/task/group/workspace/output differs from request');
      }
    }
    // Brief and parent authority restrict caller ceilings; neither can overwrite them.
    const intent = managedIntent ?? brief?.intent;
    if (intent) snapshot.constraints = { ...snapshot.constraints, ceilings: intersectWorkerCeilings(
      snapshot.constraints?.ceilings, { ...intent.limits, costUsd: intent.limits.costUsd ?? undefined }) };
    plan = resolveWorkerPlan(snapshot, { role: request.role, taskClass: request.task, group: request.group,
      transport: request.transport, authority: request.authority, now, expectedDigests: expected?.digests,
      ceilings: request.ceilings,
      ...(intent ? { dataClass: intent.dataClass, member: intent.pins.member,
        model: intent.pins.model, effort: intent.pins.effort?.value } : {}),
      context: { estimator: 'utf8-byte-upper-bound-v1', briefTokens: bytes?.length ?? 0,
        inputTokens: 0, toolOutputAllowance: 1024, reservedOutput: 1024 },
      requiredControls: snapshot.config.parallelism?.health?.requireStepCap ? ['stepCap'] : [],
    }, { tokens: 50000, wallSeconds: 900 });
    plan.request = structuredClone(request);
    if (!plan.selected) return plan;
    if (plan.mode === 'managed' && !managedIntent) {
      plan.diagnostics.push({ code: 'OG_CONFIG_REFERENCE', pointer: '/request/managedIntent',
        message: 'Managed execution requires the parent task authority and shared admission.' });
      return plan;
    }
    const tuple = plan.selected;
    pointer = `/parallelism/clis/${tuple.cli}`;
    failureCode = 'OG_ADAPTER_UNQUALIFIED';
    const driver = drivers[tuple.cli];
    const binding = snapshot.installations[tuple.cli];
    if (!driver) throw new Error('Qualified installation renderer unavailable (#2885 installation owner required)');
    const qualification = structuredClone(driver.qualification);
    const qualificationDigest = workerConfigDigest(qualification);
    if (qualification.cliVersion !== binding.cliVersion) throw new WorkerPolicyError('OG_PIN_MISMATCH', 'Installation version changed');
    const adapter = qualification.adapter;
    // The driver must be bound to the same registry metadata used by the resolver.
    const { resolveWorkerGroupInstallation } = await import('../config/aiwg-config.js');
    const resolved = resolveWorkerGroupInstallation(snapshot.config.parallelism!, tuple.cli, snapshot.registry);
    if (workerConfigDigest(resolved.adapter) !== workerConfigDigest(adapter)
      || workerConfigDigest(qualification.boundary) !== workerConfigDigest(binding.boundary)) throw new WorkerPolicyError('OG_PIN_MISMATCH', 'Installation profile/boundary digest changed');
    const selected: WorkerResolvedInvocation['selected'] = { group: tuple.group, member: tuple.member,
      cli: tuple.cli, model: tuple.model, inferenceProvider: tuple.inferenceProvider, family: tuple.family,
      effort: { support: tuple.effort === null ? 'not-applicable' : 'explicit', value: tuple.effort },
      profileRef: tuple.profile, qualificationDigest: adapter.invocationProfiles![tuple.profile].installationQualification?.scopeDigest
        ?? adapter.qualification.fixtureDigest! };
    const policyDigest = workerConfigDigest([plan.digests.configDigest, plan.digests.resolvedModelsDigest]);
    if (brief && (workerConfigDigest(brief.selected) !== workerConfigDigest(selected)
      || brief.policyDigest !== policyDigest || brief.catalogDigest !== plan.digests.catalogDigest)) {
      pointer = '/request/brief';
      throw new WorkerPolicyError('OG_PIN_MISMATCH', 'Brief selection/policy/catalog digest changed; prepare and resolve again');
    }
    pointer = '/request/workdir';
    failureCode = 'OG_CONFIG_REFERENCE';
    const workspaceExists = await inspectPath(request.workdir, 'directory');
    pointer = '/request/final_output';
    await inspectPath(request.final_output, 'output');
    const finalPath = path.resolve(request.final_output);
    const stdoutPath = `${finalPath}.stdout`;
    const stderrPath = `${finalPath}.stderr`;
    let outputParentsExist = true;
    for (const output of [finalPath, stdoutPath, stderrPath]) {
      await inspectPath(output, 'output');
      if (path.resolve(request.brief) === output) throw new Error('Brief and output paths must be distinct');
      if (!await inspectPath(path.dirname(output), 'directory')) outputParentsExist = false;
    }
    const limits = { tokens: plan.ceilings.tokens!, costUsd: plan.ceilings.costUsd ?? null,
      wallSeconds: plan.ceilings.wallSeconds!, maxAttempts: plan.ceilings.maxAttempts! };
    const observation = snapshot.catalog.discovery!.instances![tuple.cli].models.find(row => row.id === tuple.model || row.apiModelId === tuple.model)!.worker!;
    const profile = adapter.invocationProfiles![tuple.profile];
    const expiresAt = new Date(Math.min(Date.parse(now) + 300000,
      Date.parse(tuple.observedAt) + (plan.policy?.freshness?.blockHours ?? DEFAULT_WORKER_SELECTION.freshness!.blockHours!) * 3600000,
      Math.min(Date.parse(tuple.verifiedAt), Date.parse(adapter.qualification.verifiedAt!),
        profile.installationQualification ? Date.parse(profile.installationQualification.verifiedAt) : Infinity)
        + (plan.policy?.freshness?.policyDays ?? DEFAULT_WORKER_SELECTION.freshness!.policyDays!) * 86400000)).toISOString();
    const healthConfig = snapshot.config.parallelism?.health;
    if (profile.installationQualification && !driver.prepareWorkerInvocation) {
      throw new WorkerInvocationCheckError('OG_ADAPTER_UNQUALIFIED', 'installation_recheck_unavailable');
    }
    if (tuple.transport === 'mcp') {
      const serverRef = profile.mcp!.serverRef;
      const server = await driver.mcpRegistry?.get(serverRef);
      const allowlist = driver.mcpProfile?.servers;
      const tools = driver.mcpProfile?.providerOverrides?.[tuple.cli];
      if (!server || server.enabled === false || !allowlist?.some(name => name === serverRef || name === '__all__')
        || tools?.toolDeny?.includes(profile.mcp!.tool)
        || tools?.toolAllow && !tools.toolAllow.includes(profile.mcp!.tool)) {
        throw new Error('MCP server/tool is not registered and allowed by the current MCP profile');
      }
    }
    const controls = isOperatorQualifiedWorkerAdapter(adapter) ? (healthConfig?.requireStepCap ? ['stepCap'] : []) : requiredWorkerControls({ policy: plan.policy, permissions: tuple.permissions, effort: tuple.effort,
      requiredControls: healthConfig?.requireStepCap ? ['stepCap'] : [] });
    pointer = '/parallelism/health';
    failureCode = 'OG_ADAPTER_UNQUALIFIED';
    const healthInput = { role: plan.policy?.roleGuidance?.[request.role]?.baseRole ?? request.role, effort: tuple.effort,
      modelKey: tuple.modelKey, profileRef: tuple.profile, wallSeconds: limits.wallSeconds,
      transportSeconds: adapter.invocation.kind === 'http' ? adapter.invocation.timeoutSeconds : undefined,
      stepEnforcement: controls.includes('stepCap') ? profile.controls.stepCap.support as 'native' | 'external' : 'unavailable' as const };
    let effectiveHealth = resolveWorkerEffectiveHealth(healthConfig, healthInput);
    const invocationId = expected?.invocationId ?? randomUUID();
    const transport = await buildWorkerInvocationTransport(driver, { invocationId, selected: structuredClone(selected), permissions: structuredClone(tuple.permissions),
      cwd: request.workdir, briefPath: request.brief, brief: bytes?.toString('utf8') ?? '', finalPath, limits: structuredClone(limits),
      health: structuredClone(effectiveHealth), role: request.role });
    for (const output of Object.values(workerOutputPaths({ ...transport, selected, transport: tuple.transport, finalPath, stdoutPath, stderrPath }))) {
      await inspectPath(output, 'output');
      if (path.resolve(request.brief) === output) throw new Error('Brief and output paths must be distinct');
    }
    pointer = '/invocation/buildInvocation';
    if (transport.stdin === 'adapter-frame' && typeof driver.buildWorkerStdinFrame !== 'function') throw new Error('Installed adapter stdin framer is required');
    if (transport.mcp?.timeoutSeconds !== undefined) effectiveHealth = resolveWorkerEffectiveHealth(healthConfig,
      { ...healthInput, transportSeconds: Math.min(healthInput.transportSeconds ?? Infinity, transport.mcp.timeoutSeconds) });
    if (request.ceilings?.wallSeconds !== undefined && request.ceilings.wallSeconds > effectiveHealth.hardTimeoutSeconds) {
      plan.status = 'blocked';
      plan.selected = null;
      plan.diagnostics.push({ code: 'OG_POLICY_RELAXATION', pointer: '/request/ceilings/wallSeconds',
        message: `Requested wallSeconds ceiling ${request.ceilings.wallSeconds} exceeds resolved policy ceiling ${effectiveHealth.hardTimeoutSeconds}.` });
      return plan;
    }
    if (effectiveHealth.hardTimeoutSeconds === limits.wallSeconds) effectiveHealth.origins?.hardTimeoutSeconds.push(
      ...(plan.origins?.['/ceilings/wallSeconds'] ?? []).map(origin => origin.pointer));
    if (workerConfigDigest(driver.qualification) !== qualificationDigest) throw new WorkerPolicyError('OG_PIN_MISMATCH', 'Installation profile digest changed during resolution');
    const invocation: WorkerResolvedInvocation = { version: 1, mode: managedIntent ? 'managed' : 'direct', transport: tuple.transport, selected,
      isolation: tuple.permissions.launchMode ?? 'systemd-unit',
      policyDigest, catalogDigest: plan.digests.catalogDigest, profileDigest: plan.digests.profileDigest,
      expiresAt, cwd: request.workdir, briefPath: request.brief, stdoutPath, stderrPath, finalPath,
      ...(transport.artifacts ? { artifacts: transport.artifacts,
        ...(transport.artifacts.some(artifact => artifact.location === 'workspace-relative') ? { invocationId } : {}) } : {}),
      argv: transport.argv, stdin: transport.stdin, envNames: transport.envNames, mcp: transport.mcp,
      ...(tuple.transport === 'shell' ? { shellCommand: '' } : {}),
      readiness: bytes !== null && workspaceExists && outputParentsExist ? 'launchable' : 'preparatory', briefDigest,
      limits, maxOutputBytes: adapter.invocation.maxOutputBytes ?? 10485760,
      effectiveCaps: tuple.effectiveMaxParallel === null ? {} : { parallel: tuple.effectiveMaxParallel },
      controlEvidence: isOperatorQualifiedWorkerAdapter(adapter) ? [adapter.qualification.evidenceRef!, ...controls.map(name => profile.controls[name].evidence)] : controls.map(name => profile.controls[name].evidence),
      health: effectiveHealth,
    };
    const invocationQualification: WorkerInvocationQualification = { ...qualification, now: Date.parse(now),
      ceilings: request.ceilings,
      policy: plan.policy, permissions: tuple.permissions, role: request.role, modelObservation: observation,
      expectedDigests: { policyDigest, catalogDigest: plan.digests.catalogDigest, profileDigest: plan.digests.profileDigest, briefDigest },
      requiredControls: controls };
    let prepared: WorkerResolvedInvocation;
    pointer = '/invocation/prepareWorkerInvocation';
    try {
      prepared = await (driver.prepareWorkerInvocation
        ? driver.prepareWorkerInvocation(structuredClone(invocation), invocationQualification)
        : prepareWorkerInvocation(invocation, invocationQualification));
    } catch (error) {
      if (error instanceof WorkerPathScopeError || error instanceof WorkerInvocationCheckError) throw error;
      throw new WorkerInvocationCheckError(error instanceof WorkerPolicyError ? error.code : 'OG_ADAPTER_UNQUALIFIED', 'invocation_prepare_failed');
    }
    if (workerConfigDigest({ ...prepared, shellCommand: invocation.shellCommand }) !== workerConfigDigest(invocation)) {
      throw new WorkerPolicyError('OG_PIN_MISMATCH', 'Installation preparation changed the resolved invocation');
    }
    if (tuple.transport === 'mcp' && profile.installationQualification) {
      pointer = '/invocation/mcp';
      const installation = qualification.installation;
      if (!installation?.mcpServerDigest || !driver.mcpRegistry?.assertWorkerQualified) {
        throw new Error('MCP installation registration recheck is required');
      }
      const input: McpWorkerQualificationInput = {
        authorizedServerDigest: installation.mcpServerDigest, adapter, profile: tuple.profile,
        cliVersion: qualification.cliVersion, requiredControls: controls,
        policy: plan.policy, permissions: tuple.permissions, effort: tuple.effort, boundary: qualification.boundary,
        mcp: profile.mcp!, installationQualification: {
          ...profile.installationQualification, status: 'ENABLED', cliVersion: qualification.cliVersion,
          platform: qualification.platform ?? process.platform, serverDigest: installation.mcpServerDigest,
        },
      };
      await driver.mcpRegistry.assertWorkerQualified(profile.mcp!.serverRef, input);
    }
    plan.invocation = prepared;
    pointer = '/request/brief';
    const rechecked = await readBrief(request.brief);
    if ((rechecked === null ? null : bytesDigest(rechecked)) !== briefDigest) throw new WorkerPolicyError('OG_PIN_MISMATCH', 'Brief digest changed during resolution');
    if (prepared.readiness !== 'launchable') {
      plan.diagnostics.push({ code: 'OG_CONFIG_REFERENCE', pointer: bytes === null ? '/request/brief'
        : !workspaceExists ? '/request/workdir' : '/request/final_output',
        message: 'Preparatory plan: create the brief, workspace and output directories, then resolve again.' });
    }
    return plan;
  } catch (error) {
    plan ??= resolveWorkerPlan(snapshot, { role: request.role, taskClass: request.task, group: request.group, now,
      context: { estimator: 'blocked-path-v1', briefTokens: 0, inputTokens: 0, toolOutputAllowance: 0, reservedOutput: 0 } });
    delete plan.invocation;
    plan.status = 'blocked';
    plan.selected = null;
    plan.diagnostics.push(workerInvocationDiagnostic(error, pointer, failureCode));
    return plan;
  }
}

/** Public diagnostics contain fixed summaries or explicit typed request-path details. */
export function workerInvocationDiagnostic(error: unknown, pointer: string,
  fallback: WorkerPolicyDiagnostic['code'] = 'OG_CONFIG_REFERENCE'): WorkerPolicyDiagnostic {
  if (error instanceof WorkerRoleEffortError) return { code: error.code, pointer: error.pointer, message: error.message };
  if (error instanceof WorkerPathScopeError || error instanceof WorkerRequestArgumentError) {
    return { code: error.code, pointer: error.pointer, message: error.message };
  }
  if (error instanceof WorkerInvocationCheckError) return { code: error.code, reason: error.reason, ...invocationChecks[error.reason] };
  const code = error instanceof WorkerPolicyError ? error.code : fallback;
  const signatureReason = error instanceof WorkerPolicyError
    ? error.details?.rejections.find(row => row.reason.startsWith('signature-'))?.reason : undefined;
  if (code === 'OG_ADAPTER_UNQUALIFIED' && signatureReason) {
    const messages: Record<string, string> = {
      'signature-missing': 'Unsigned worker installation approval is unqualified. This requires deliberate one-time requalification: re-run aiwg doctor --probe-workers --qualify.',
      'signature-trust-unavailable': 'Worker qualification signing trust is unavailable. Check effects.keyProvider in aiwg.config and the existing delivery effect-ledger keyring (aiwg effect keys list); restore trust, then re-run aiwg doctor --probe-workers --qualify.',
    };
    return { code, pointer, message: messages[signatureReason]
      ?? 'Worker installation signature is invalid or its keyid is untrusted. Re-run aiwg doctor --probe-workers --qualify.' };
  }
  const messages: Record<WorkerPolicyDiagnostic['code'], string> = {
    OG_SANDBOX_EXTERNAL: "The CLI's own sandbox is disabled by explicit external policy; isolation relies on the per-task worktree and launcher resource scope.",
    OG_NATIVE_SANDBOX_UNAVAILABLE: 'Native sandbox unavailable inside systemd user units; select policy launchMode native-sandbox or allow unprivileged user namespaces through host AppArmor policy.',
    OG_CONFIG_REFERENCE: 'Invalid request or configuration reference; check the paths and settings.',
    OG_PIN_MISMATCH: 'Worker selection or pinned evidence changed; resolve again.',
    OG_MODEL_UNAPPROVED: 'The selected model lacks current approved observation evidence.',
    OG_EFFORT_DENIED: 'The selected effort is denied by the resolved worker policy.',
    OG_DATA_POLICY: 'The selected model does not satisfy the resolved data policy.',
    OG_HOST_ATTRIBUTION: 'Host capacity includes unattributed workers. Inspect aiwg doctor --resources --json before retrying.',
    OG_HOST_CAPACITY: 'Worker capacity is exhausted. Inspect aiwg doctor --resources --json before retrying.',
    OG_ADAPTER_UNQUALIFIED: 'The installation or invocation could not be revalidated. Run aiwg doctor --probe-workers --qualify to qualify this workspace.',
    OG_POLICY_RELAXATION: 'The request would relax the resolved worker policy.',
    OG_BUDGET_UNMEASURABLE: 'The requested worker budget cannot be enforced.',
  };
  return { code, pointer, message: messages[code] };
}
