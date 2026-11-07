/**
 * Provider-aware model policy registry, validation, and compilation.
 * @implements #1802
 * @implements #1805
 */
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { z } from 'zod';
import { url } from '../schema/zod-validation.mjs';
import { compileWorkerVersionPattern } from './worker-installation.mjs';
import type {
  WorkerModelObservation, WorkerSelectionPolicy, WorkerDataPolicy, WorkerPolicyDiagnostic,
} from './types.js';

import { ProviderSchema, requireModelResource } from './policy-resources.js';
import { resetCatalogPolicyCache, validateWorkerModelObservation } from './catalog-policy.js';
import { hasSelectionRelevantConflicts } from './worker-review-lineage.js';
export { hasSelectionRelevantConflicts } from './worker-review-lineage.js';
export * from './catalog-policy.js';
export * from './worker-invocation-policy.js';

import { DEFAULT_WORKER_SELECTION, workerModelKey, ownWorkerRoleGuidance } from './worker-selection-policy.js';
export { DEFAULT_WORKER_SELECTION, WorkerSelectionPolicySchema, mergeWorkerSelection, workerModelKey, isCanonicalWorkerModelKey } from './worker-selection-policy.js';
export type { WorkerPolicyLayer } from './worker-selection-policy.js';

const capabilityData = requireModelResource('model-capabilities.v1.json');

const OutcomeSchema = z.enum([
  'native', 'compiled', 'inherited', 'global-only', 'informational', 'unsupported',
]);

export interface WorkerProfileHealth {
  version: 1;
  handshake: 'semantic' | 'process-only' | 'unobserved';
  outputFraming: 'jsonl' | 'plain' | 'final-json' | 'http-stream' | 'mcp-progress' | 'opaque';
  signalParser: string;
  sessionLogLocator: string | null;
  progressEvidence: string[];
  stopEvidence: string;
  fixtureRef: string;
  qualifiedAt: string | null;
  statusOperation: string | null;
  cancelOperation: string | null;
  coverage?: 'full' | 'degraded' | 'unobserved';
  qualificationTarget?: 'semantic' | 'process-only' | 'unobserved';
  evidenceGrades?: Array<'H' | 'R' | 'D'>;
  provenance?: Array<{ kind: 'help' | 'repository' | 'documentation' | 'synthetic'; ref: string;
    observedAt: string; cliVersion: string | null }>;
  qualificationOwner?: string;
  qualification?: { status: 'unqualified' | 'synthetic' | 'live-qualified'; scopeDigest: string | null;
    cliVersion: string | null; accountScope: string | null; profileRef: string | null;
    modelKey: string | null; effort: string | null; authorizedLive: boolean };
}

export interface WorkerHealthCoverage {
  scope: 'out';
  coverage: 'unobserved';
  handshake: 'unobserved';
  evidenceGrades: Array<'H' | 'R' | 'D'>;
  qualificationOwner: string;
  provenance: string[];
  reason: string;
}

export interface WorkerInvocationProfile {
  transport: 'shell' | 'mcp';
  supportedVersions: string;
  controls: Record<string, { support: 'native' | 'external' | 'not-applicable' | 'unqualified'; mapping: string; evidence: string }>;
  envAllowlist: string[];
  pitfalls: string[];
  mcp?: { serverRef: string; tool: string; inputSchemaDigest: string; outputSchemaDigest: string;
    sessionIsolation: 'per-call' | 'per-instance' | 'serialized'; cancel: 'confirmed' | 'uncertain' };
  health?: WorkerProfileHealth;
  installationQualification?: { scopeDigest: string; fixtureDigest: string; verifiedAt: string; evidenceRef: string };
}
export interface WorkerAdapterMetadata {
  version: 1;
  id: string;
  provider: string;
  adapterVersion: string;
  supportedVersions: string;
  runtimeDriver: string;
  catalogAdapter: { kind: 'command' | 'file' | 'http' | 'module'; locator: string; parser: string;
    argv?: string[]; timeoutSeconds?: number; maxBytes?: number };
  invocation: { kind: 'process'; executable: string; argv: string[]; stdin: 'closed' | 'brief-json' | 'brief-text' | 'adapter-frame';
    cwd: '${workspace}'; envAllowlist: string[]; versionArgv: string[]; versionPattern?: string; maxOutputBytes?: number }
    | { kind: 'http'; protocol: 'ollama' | 'llama-cpp' | 'openai-compatible'; healthPath: string;
      modelsPath: string; generatePath: string; timeoutSeconds?: number; maxOutputBytes?: number };
  capabilities: { output: 'native-schema' | 'validated-file' | 'text'; modelPin: 'observed' | 'requested' | 'unsupported';
    effort: 'explicit' | 'not-applicable' | 'unsupported'; cancel: 'process-group' | 'session' | 'none';
    resume: boolean; sandboxModes: string[]; nestedAgentsControllable: boolean; nativeFallbackControllable: boolean; hardBudget: string[] };
  qualification: { status: 'unqualified' | 'qualified'; fixtureDigest?: string; verifiedAt?: string; evidenceRef?: string };
  invocationProfiles?: Record<string, WorkerInvocationProfile>;
}

// Use the bundled owner for nested controls, including forward-compatible optional
// health records. Zod must validate and preserve them, never silently strip them.
const capabilitySchema = requireModelResource('provider-model-capabilities.v1.schema.json') as any;
const capabilityAjv = addFormats(new Ajv2020({ strict: false, allErrors: true }));
capabilityAjv.addSchema(capabilitySchema);
const validateAdapter = capabilityAjv.compile({ $ref: `${capabilitySchema.$id}#/$defs/workerAdapter` });
export const WorkerAdapterSchema = z.custom<WorkerAdapterMetadata>().superRefine((value, context) => {
  if (!validateAdapter(value)) {
    context.addIssue({ code: 'custom', message: `Invalid worker adapter: ${capabilityAjv.errorsText(validateAdapter.errors)}` });
    return;
  }
  try {
    const invocation = (value as WorkerAdapterMetadata).invocation;
    if (invocation.kind === 'process' && invocation.versionPattern !== undefined) compileWorkerVersionPattern(invocation.versionPattern);
  } catch (error) {
    context.addIssue({ code: 'custom', path: ['invocation', 'versionPattern'],
      message: `Invalid worker adapter: ${error instanceof Error ? error.message : String(error)}` });
  }
});
const CapabilityEntrySchema = z.strictObject({
  sessionEnvAllowlist: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).optional(),
  agent: OutcomeSchema,
  skill: OutcomeSchema,
  globalChild: OutcomeSchema,
  identifierSyntax: z.string().min(1),
  effortValues: z.array(z.string().min(1)).optional(),
  inheritance: z.string().min(1),
  invalidPinFallback: z.string().min(1),
  configTarget: z.string().min(1),
  artifactFormat: z.string().min(1),
  verification: z.string().min(1),
  sourceUrl: url(),
  verifiedAt: z.string().date(),
  workerAdapter: WorkerAdapterSchema.optional(),
  // Descriptive health coverage is not an installed executable registration.
  workerHealthAdapter: WorkerAdapterSchema.optional(),
  workerHealthCoverage: z.strictObject({
    scope: z.literal('out'), coverage: z.literal('unobserved'), handshake: z.literal('unobserved'),
    evidenceGrades: z.array(z.enum(['H', 'R', 'D'])).max(3),
    qualificationOwner: z.string().regex(/^B-OG-[0-9]{2}$/),
    provenance: z.array(z.string().min(1).max(4096)).min(1).max(16), reason: z.string().min(1).max(4096),
  }).optional(),
});
const CapabilityRegistrySchema = z.strictObject({
  $schema: z.enum([
    '../../../schemas/models/provider-model-capabilities.v1.schema.json',
    'https://aiwg.io/schemas/models/provider-model-capabilities.v1.schema.json',
  ]).optional(),
  version: z.literal('1.0.0'),
  verifiedAt: z.string().date(),
  providers: z.partialRecord(ProviderSchema, CapabilityEntrySchema),
  workerAdapters: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,62}$/), WorkerAdapterSchema)
    .refine(value => Object.keys(value).length <= 128, 'At most 128 worker adapters').optional(),
  workerHealthAdapters: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,62}$/), WorkerAdapterSchema)
    .refine(value => Object.keys(value).length <= 128, 'At most 128 worker health descriptors').optional(),
});
export type ProviderModelCapability = z.infer<typeof CapabilityEntrySchema>;
export type ProviderModelCapabilityRegistry = z.infer<typeof CapabilityRegistrySchema>;
let registryCache: ProviderModelCapabilityRegistry | null = null;

export function loadProviderModelCapabilities(): ProviderModelCapabilityRegistry {
  if (!registryCache) {
    registryCache = parseProviderModelCapabilities(capabilityData);
  }
  return registryCache;
}

export function parseProviderModelCapabilities(input: unknown): ProviderModelCapabilityRegistry {
  const registry = CapabilityRegistrySchema.parse(input);
  const expected = new Set(ProviderSchema.options);
  const actual = new Set(Object.keys(registry.providers));
  if (actual.size !== expected.size || [...expected].some(id => !actual.has(id))) {
    throw new Error('Provider model capability registry must cover all registered providers');
  }
  const ids = new Set<string>();
  for (const adapter of [...Object.values(registry.providers).flatMap(p => p.workerAdapter ? [p.workerAdapter] : []),
    ...Object.values(registry.workerAdapters ?? {})]) {
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(adapter.id) || ids.has(adapter.id)) throw new Error(`Duplicate or invalid worker adapter ID: ${adapter.id}`);
    ids.add(adapter.id);
  }
  return registry;
}

/** Exact, case-sensitive references; deployment and inference provider identities differ. */
export function resolveWorkerAdapter(registry: ProviderModelCapabilityRegistry, reference: string): WorkerAdapterMetadata {
  const match = /^(providers|workerAdapters):([a-z][a-z0-9-]{0,62})$/.exec(reference);
  if (!match) throw new Error(`Invalid worker adapter reference: ${reference}`);
  const [, namespace, id] = match;
  const adapter = namespace === 'providers'
    ? registry.providers[id as keyof typeof registry.providers]?.workerAdapter
    : registry.workerAdapters?.[id];
  if (!adapter) throw new Error(`Unknown worker adapter reference: ${reference}`);
  return WorkerAdapterSchema.parse(adapter);
}

/** Pure direct/shared mapping: no admission store, Mission or activation marker. */
export function resolveWorkerInstallation(registry: ProviderModelCapabilityRegistry,
  installation: { adapter: string; executable?: string; endpoint?: string }) {
  const adapter = resolveWorkerAdapter(registry, installation.adapter);
  if (adapter.invocation.kind === 'process') {
    if (installation.endpoint !== undefined) throw new Error('Process adapter forbids endpoint');
    const executable = installation.executable ?? adapter.invocation.executable;
    if (!executable.trim() || executable.includes('\0')) throw new Error('Process adapter requires executable');
    return { adapter, executable };
  }
  if (installation.executable !== undefined) throw new Error('HTTP adapter forbids executable');
  if (!installation.endpoint) throw new Error('HTTP adapter requires endpoint');
  const endpoint = new URL(installation.endpoint);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error('Invalid HTTP adapter endpoint');
  }
  return { adapter, endpoint: installation.endpoint };
}

/** Typed policy failures let public surfaces retain the cause without exposing internal details. */
export class WorkerPolicyError extends Error {
  constructor(public readonly code: WorkerPolicyDiagnostic['code'], message: string,
    public readonly details?: { rejections: { registration: number | null; reason: string }[] }) {
    super(message);
    this.name = 'WorkerPolicyError';
  }
}

/** Only the trusted installation loader supplies this public policy-drift summary. */
export class WorkerQualificationPolicyError extends WorkerPolicyError {
  readonly pointer: string;
  constructor(diagnostic: WorkerPolicyDiagnostic, rejections: NonNullable<WorkerPolicyError['details']>['rejections']) {
    super('OG_ADAPTER_UNQUALIFIED', diagnostic.message, { rejections });
    this.pointer = diagnostic.pointer;
  }
}

export class WorkerRoleEffortError extends WorkerPolicyError {
  readonly pointer: string;
  constructor(role: string) {
    const pointer = `/defaults/workerSelection/roleGuidance/${role.replace(/~/g, '~0').replace(/\//g, '~1')}/initialEffort`;
    super('OG_CONFIG_REFERENCE', `Missing role guidance or explicit initial effort for role ${role}; configure models.json ${pointer}.`);
    this.pointer = pointer;
  }
}

/** Validate policy input before entering the sanitized adapter boundary. Null
 * remains valid for models whose effort is explicitly not applicable. */
export function assertWorkerRoleEffort(policy: WorkerSelectionPolicy | undefined, role: string, requiresExplicit = false): void {
  const effort = ownWorkerRoleGuidance(policy, role)?.initialEffort;
  if (effort === undefined || requiresExplicit && (effort === null || !effort.trim())) throw new WorkerRoleEffortError(role);
}

/**
 * Dispatch-time safety checks belong here, alongside transport qualification.
 * Like route validation, rendering requires observation evidence; a default
 * observation may supply it when no model observation is available.
 */
export function assertWorkerSelectionAllowed(selected: {
  inferenceProvider: string; model: string; effort: { support: string; value: string | null };
}, context: {
  now: number;
  policy?: WorkerSelectionPolicy;
  dataClass?: string;
  role?: string;
  modelObservation?: WorkerSelectionObservation;
  defaultObservation?: WorkerSelectionObservation;
}): void {
  const policy = context.policy ?? DEFAULT_WORKER_SELECTION;
  if (isWorkerEffortDenied(selected.effort.value, policy)) {
    throw new WorkerPolicyError('OG_EFFORT_DENIED', `Worker invocation denied effort: ${selected.effort.value}`);
  }
  if (isContributorWorkerModel(selected.model)
    || isWorkerModelDenied(workerModelKey(selected.inferenceProvider, selected.model), policy)) {
    throw new WorkerPolicyError('OG_MODEL_UNAPPROVED', `Worker invocation denied model: ${selected.model}`);
  }
  const { data, unknownDataClass } = workerRouteDataPolicy(policy, context.dataClass);
  if (unknownDataClass) throw new WorkerPolicyError('OG_DATA_POLICY', 'Worker invocation has denied data-use: unknown data class');
  const observation = context.modelObservation ?? context.defaultObservation;
  if (!observation) throw new WorkerPolicyError('OG_MODEL_UNAPPROVED', 'Worker invocation requires model or default observation evidence');
  const guidance = context.role ? ownWorkerRoleGuidance(policy, context.role) : undefined;
  if (isWorkerNullEffortDenied(selected.effort.value, observation, guidance)) {
    throw new WorkerPolicyError('OG_EFFORT_DENIED', 'Worker invocation denied effort: null effort requires qualified absence of an effort control');
  }
  for (const [kind, observation] of [
    ['model', context.modelObservation], ['default', context.defaultObservation],
  ] as const) {
    if (!observation) continue;
    if (observation.lifecycle === 'retired'
      || (observation.retiredAt != null && Date.parse(observation.retiredAt) <= context.now)
      || (observation.sunsetAt != null && Date.parse(observation.sunsetAt) <= context.now)) {
      throw new WorkerPolicyError('OG_MODEL_UNAPPROVED', `Worker invocation ${kind} observation is retired`);
    }
    const blockMs = (policy.freshness?.blockHours ?? DEFAULT_WORKER_SELECTION.freshness!.blockHours!) * 3_600_000;
    const observedAt = Date.parse(observation.observedAt);
    if (!Number.isFinite(context.now) || !Number.isFinite(observedAt)
      || !Number.isFinite(blockMs) || blockMs <= 0
      || (observation.verifiedAt !== undefined && !Number.isFinite(Date.parse(observation.verifiedAt)))
      || isWorkerEvidenceStale(observation, policy, context.now)) {
      throw new WorkerPolicyError('OG_MODEL_UNAPPROVED', `Worker invocation ${kind} observation is stale or invalid`);
    }
    if (hasSelectionRelevantConflicts(observation as WorkerModelObservation)) {
      throw new WorkerPolicyError('OG_MODEL_UNAPPROVED', `Worker invocation ${kind} observation has conflicting selection-relevant evidence`);
    }
    if (observation.dataUse && isWorkerDataUseDenied({
      processing: observation.dataUse.processing ?? 'unknown',
      productImprovement: observation.dataUse.productImprovement ?? null,
      retentionDays: observation.dataUse.retentionDays ?? null,
    }, data)) {
      throw new WorkerPolicyError('OG_DATA_POLICY', `Worker invocation ${kind} observation has denied data-use`);
    }
  }
}

interface WorkerSelectionObservation {
  effortSupport?: string;
  observedAt: string;
  verifiedAt?: string;
  lifecycle: string;
  retiredAt?: string | null;
  sunsetAt?: string | null;
  dataUse?: Partial<WorkerModelObservation['dataUse']>;
  conflicts?: WorkerModelObservation['conflicts'];
}

export function resetModelPolicyCachesForTests(): void {
  registryCache = null;
  resetCatalogPolicyCache();
}

// Dispatch rechecks consume the effective policy from resolution. Keep these
// predicates shared with route validation so defaults and restrictions agree.
function isContributorWorkerModel(model: string): boolean {
  return /(?:^|[-_:/.])contributor(?:$|[-_:/.])/i.test(model);
}
function isWorkerModelDenied(modelKey: string, policy: WorkerSelectionPolicy): boolean {
  return (policy.guards?.deniedModels ?? DEFAULT_WORKER_SELECTION.guards!.deniedModels!).includes(modelKey);
}
function isWorkerEffortDenied(effort: string | null, policy: WorkerSelectionPolicy): boolean {
  return effort !== null && (policy.guards?.deniedEfforts ?? DEFAULT_WORKER_SELECTION.guards!.deniedEfforts!).includes(effort);
}
function isWorkerNullEffortDenied(effort: string | null, observation: { effortSupport?: string },
  guidance?: { allowNotApplicableEffort?: boolean }): boolean {
  return effort === null && (observation.effortSupport !== 'not-applicable' || guidance?.allowNotApplicableEffort !== true);
}
function workerRouteDataPolicy(policy: WorkerSelectionPolicy, dataClass?: string): {
  data: WorkerDataPolicy; unknownDataClass: boolean;
} {
  const data = { ...DEFAULT_WORKER_SELECTION.dataPolicy, ...policy.dataPolicy };
  const narrowed = dataClass && policy.dataClasses && Object.hasOwn(policy.dataClasses, dataClass) ? policy.dataClasses[dataClass] : undefined;
  if (narrowed) {
    if (narrowed.allowedProcessing) data.allowedProcessing = data.allowedProcessing?.filter(p => narrowed.allowedProcessing!.includes(p));
    if (narrowed.allowUnknown === false) data.allowUnknown = false;
    if (narrowed.allowProductImprovement === false) data.allowProductImprovement = false;
    if (narrowed.maxRetentionDays !== undefined) data.maxRetentionDays = Math.min(data.maxRetentionDays ?? Infinity, narrowed.maxRetentionDays);
  }
  return { data, unknownDataClass: Boolean(dataClass && !narrowed) };
}
function isWorkerDataUseDenied(facts: WorkerModelObservation['dataUse'], data: WorkerDataPolicy): boolean {
  return (facts.processing === 'unknown' && data.allowUnknown !== true)
    || (facts.processing !== 'unknown' && !data.allowedProcessing?.includes(facts.processing))
    || (facts.productImprovement === null && data.allowUnknown !== true)
    || (facts.productImprovement === true && data.allowProductImprovement !== true)
    || (data.maxRetentionDays !== undefined && (facts.retentionDays === null ? data.allowUnknown !== true : facts.retentionDays > data.maxRetentionDays));
}
function isWorkerEvidenceStale(observation: { observedAt: string; verifiedAt?: string }, policy: WorkerSelectionPolicy, now: number): boolean {
  const observed = Date.parse(observation.observedAt);
  const verified = observation.verifiedAt === undefined ? undefined : Date.parse(observation.verifiedAt);
  const blockHours = policy.freshness?.blockHours ?? DEFAULT_WORKER_SELECTION.freshness!.blockHours!;
  const policyDays = policy.freshness?.policyDays ?? DEFAULT_WORKER_SELECTION.freshness!.policyDays!;
  return observed > now || now - observed > blockHours * 3600000
    || (verified !== undefined && (verified > now || now - verified > policyDays * 86400000));
}


/** Validate a resolved route without launching or creating managed state. */
export function validateWorkerPolicyRoute(input: {
  policy: WorkerSelectionPolicy;
  role: string;
  inferenceProvider: string;
  apiModelId: string;
  selectedModel: string;
  effort: string | null;
  identityEvidence: 'runtime-configured' | 'backend-attested' | 'unknown' | 'mismatched';
  observation: WorkerModelObservation;
  wrapperPin?: string;
  /** Recorded replacement from resolution, which also checks the group/member match. */
  substitution?: { model: string; effort: string | null; rationale: string };
  dataClass?: string;
  now?: Date;
  context?: WorkerContextEstimate;
}): WorkerPolicyDiagnostic[] {
  const diagnostics: WorkerPolicyDiagnostic[] = [];
  const deny = (code: WorkerPolicyDiagnostic['code'], pointer: string, message: string): void => { diagnostics.push({ code, pointer, message }); };
  const shapeErrors = validateWorkerModelObservation(input.observation);
  if (shapeErrors.length) return [{ code: 'OG_ADAPTER_UNQUALIFIED', pointer: '/worker', message: shapeErrors.join('; ') }];
  const observation = input.observation;
  if (hasSelectionRelevantConflicts(observation)) deny('OG_MODEL_UNAPPROVED', '/worker/conflicts', 'Conflicting selection-relevant model evidence blocks the route');
  else if (observation.conflicts?.length) diagnostics.push({
    code: 'OG_MODEL_UNAPPROVED', pointer: '/worker/conflicts', blocking: false,
    message: `Conflicting optional model evidence remains unknown: ${observation.conflicts.map(conflict => conflict.field).join(', ')}`,
  });
  const guards = input.policy.guards ?? DEFAULT_WORKER_SELECTION.guards!;
  const guidance = ownWorkerRoleGuidance(input.policy, input.role);
  if (observation.qualification.status !== 'qualified' || !observation.qualification.roles.includes(guidance?.baseRole ?? input.role)) deny('OG_ADAPTER_UNQUALIFIED', '/worker/qualification', 'Role lacks qualified evidence. Run aiwg doctor --probe-workers --qualify.');
  if (!guidance) deny('OG_CONFIG_REFERENCE', `/defaults/workerSelection/roleGuidance/${input.role}`, 'Role guidance is unavailable');
  const substitution = input.substitution?.model === input.selectedModel
    && input.substitution.effort === input.effort && input.substitution.rationale.trim();
  if (input.wrapperPin && input.wrapperPin !== input.selectedModel && !substitution) deny('OG_PIN_MISMATCH', '/agentOverrides', 'Wrapper exact pin differs from selected model');
  if (guards.requireExactModel !== false && input.selectedModel !== input.apiModelId) deny('OG_PIN_MISMATCH', '/worker/id', 'Selected model is not the exact observed API model');
  let modelKey: string | undefined;
  try { modelKey = workerModelKey(input.inferenceProvider, input.apiModelId); } catch { deny('OG_CONFIG_REFERENCE', '/worker/id', 'Invalid inference model identity'); }
  // The dispatch guard checks the selected model; when requireExactModel is
  // false that can differ from apiModelId, so deny on either identity.
  let selectedKey: string | undefined;
  try { selectedKey = workerModelKey(input.inferenceProvider, input.selectedModel); } catch { /* reported via apiModelId */ }
  if (isContributorWorkerModel(input.apiModelId) || isContributorWorkerModel(input.selectedModel)
    || (modelKey && isWorkerModelDenied(modelKey, input.policy))
    || (selectedKey && isWorkerModelDenied(selectedKey, input.policy))) deny('OG_MODEL_UNAPPROVED', '/defaults/workerSelection/guards/deniedModels', 'Inference model is denied');
  if (input.identityEvidence === 'unknown' || input.identityEvidence === 'mismatched' || (guards.minimumIdentityEvidence === 'backend-attested' && input.identityEvidence !== 'backend-attested')) deny('OG_ADAPTER_UNQUALIFIED', '/defaults/workerSelection/guards/minimumIdentityEvidence', 'Identity evidence does not meet the required order');
  if (!(guards.allowedVisibility ?? ['listed']).includes(observation.visibility as 'listed' | 'hidden') || !(guards.allowedLifecycle ?? ['active']).includes(observation.lifecycle as 'active' | 'deprecated') || observation.availability !== 'accessible') deny('OG_MODEL_UNAPPROVED', '/worker', 'Visibility, lifecycle or availability is ineligible');
  if (input.effort === null) {
    if (isWorkerNullEffortDenied(input.effort, observation, guidance)) deny('OG_EFFORT_DENIED', '/worker/effortSupport', 'Null effort requires qualified absence of an effort control');
  } else {
    const effort = observation.efforts.find(e => e.id === input.effort);
    if (observation.effortSupport !== 'explicit' || !effort || !(input.effort === 'none' ? guidance?.initialEffort === 'none' && guidance.effortLadder.length === 0 : guidance?.effortLadder.includes(input.effort)) || isWorkerEffortDenied(input.effort, input.policy) || (guards.denySelfDelegation !== false && effort.selfDelegates !== false)) deny('OG_EFFORT_DENIED', '/worker/efforts', 'Unsupported, denied or self-delegating effort. Check catalog effort evidence and models.json defaults.workerSelection.roleGuidance, guards.deniedEfforts and guards.denySelfDelegation.');
  }
  const { data, unknownDataClass } = workerRouteDataPolicy(input.policy, input.dataClass);
  if (unknownDataClass) deny('OG_DATA_POLICY', '/defaults/workerSelection/dataClasses', 'Unknown data class');
  if (isWorkerDataUseDenied(observation.dataUse, data)) {
    const facts = observation.dataUse;
    const keys = [
      ...((facts.processing === 'unknown' || facts.productImprovement === null
        || data.maxRetentionDays !== undefined && facts.retentionDays === null) && data.allowUnknown !== true ? ['allowUnknown'] : []),
      ...(facts.processing !== 'unknown' && !data.allowedProcessing?.includes(facts.processing) ? ['allowedProcessing'] : []),
      ...(facts.productImprovement === true && data.allowProductImprovement !== true ? ['allowProductImprovement'] : []),
      ...(data.maxRetentionDays !== undefined && facts.retentionDays !== null && facts.retentionDays > data.maxRetentionDays ? ['maxRetentionDays'] : []),
    ];
    deny('OG_DATA_POLICY', '/worker/dataUse', `Execution path data facts do not satisfy policy. Review models.json ${keys.map(key => `defaults.workerSelection.dataPolicy.${key}`).join(', ')}${input.dataClass ? ` and defaults.workerSelection.dataClasses.${input.dataClass}` : ''}; unknown facts remain unknown.`);
  }
  const now = (input.now ?? new Date()).getTime();
  if (observation.retiredAt != null && Date.parse(observation.retiredAt) <= now
    || observation.sunsetAt && Date.parse(observation.sunsetAt) <= now) {
    deny('OG_MODEL_UNAPPROVED', '/worker/lifecycle', 'Model retirement or sunset is effective');
  }
  if (isWorkerEvidenceStale(observation, input.policy, now)) deny('OG_ADAPTER_UNQUALIFIED', '/worker/observedAt', 'Model evidence is stale or from the future');
  else if (now - Date.parse(observation.observedAt) > (input.policy.freshness?.warnHours ?? DEFAULT_WORKER_SELECTION.freshness!.warnHours!) * 3600000) {
    diagnostics.push({ code: 'OG_ADAPTER_UNQUALIFIED', pointer: '/worker/observedAt', blocking: false, message: 'Model observation exceeds the freshness warning threshold' });
  }
  if (input.context && !workerContextHeadroom(input.context, observation).fits) {
    const missing = [observation.contextTokens === null ? 'contextTokens' : ''].filter(Boolean);
    deny('OG_MODEL_UNAPPROVED', '/worker/contextTokens', missing.length
      ? `Bounded context and output cannot be checked: catalog does not report a qualified ${missing.join(', ')} limit. Refresh discovery with reported limits; operator approval does not invent limits.`
      : 'Bounded context and output do not fit qualified limits; reduce the request context or reserved output.');
  }
  if (input.context && observation.contextTokens !== null && observation.maxOutputTokens === null) {
    diagnostics.push({ code: 'OG_MODEL_UNAPPROVED', pointer: '/worker/maxOutputTokens', blocking: false,
      message: 'Output limit is unreported; only the context window was checked.' });
  }
  return diagnostics;
}

/** Every term is an upper bound from the conductor's named tokenizer/estimator. */
export interface WorkerContextEstimate {
  estimator: string;
  briefTokens: number;
  inputTokens: number;
  toolOutputAllowance: number;
  reservedOutput: number;
  safetyMargin?: number;
}

export function workerContextHeadroom(estimate: WorkerContextEstimate,
  observation: Pick<WorkerModelObservation, 'contextTokens' | 'maxOutputTokens'>) {
  const safetyMargin = Math.max(estimate.safetyMargin ?? 0, Math.ceil((observation.contextTokens ?? 0) * 0.1));
  const terms = [estimate.briefTokens, estimate.inputTokens, estimate.toolOutputAllowance, estimate.reservedOutput, safetyMargin];
  const total = terms.reduce((sum, value) => sum + value, 0);
  const fits = Boolean(estimate.estimator.trim()) && terms.every(value => Number.isSafeInteger(value) && value >= 0)
    && (estimate.safetyMargin === undefined || Number.isSafeInteger(estimate.safetyMargin) && estimate.safetyMargin >= 0)
    && Number.isSafeInteger(total) && observation.contextTokens !== null
    && total <= observation.contextTokens && (observation.maxOutputTokens === null || estimate.reservedOutput <= observation.maxOutputTokens);
  return { ...estimate, safetyMargin, total, qualifiedContextTokens: observation.contextTokens,
    qualifiedMaxOutputTokens: observation.maxOutputTokens, fits };
}
