/**
 * Provider-aware model policy registry, validation, and compilation.
 * @implements #1802
 * @implements #1805
 */
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createRequire } from 'node:module';
import { compileWorkerVersionPattern, workerVersionRangeMismatch } from './worker-installation.mjs';
import type { WorkerExecution } from '../config/aiwg-config.js';
import { normalizeProviderDefinitionId } from '../providers/provider-definitions.js';
import { qualificationDigest } from './qualification-digest.mjs';
import type {
  CanonicalModelPolicy, ModelCompilationOutcome, ModelEffort, ModelRole, Provider,
  WorkerModelObservation, WorkerSelectionPolicy, WorkerDataPolicy, WorkerPolicyOrigin, WorkerPolicyDiagnostic,
} from './types.js';

const require = createRequire(import.meta.url);
function requireModelResource(filename: string): unknown {
  const candidates = [
    `./${filename}`,
    `../../agentic/code/providers/${filename}`,
    `../../../agentic/code/providers/${filename}`,
    `../../schemas/models/${filename}`,
    `../../../schemas/models/${filename}`,
  ];
  for (const candidate of candidates) {
    try { return require(candidate); } catch (error: any) {
      if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error(`Model policy resource is missing: ${filename}`);
}
const capabilityData = requireModelResource('model-capabilities.v1.json');
const catalogData = requireModelResource('model-catalog.v1.json');

const ProviderSchema = z.enum([
  'antigravity', 'claude', 'codex', 'copilot', 'cursor', 'deepseek-harness', 'factory', 'grokbot', 'grok-build', 'hermes',
  'muse', 'opencode', 'openclaw', 'openhuman', 'omp', 'pi', 'warp', 'windsurf',
]);
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
const CapabilityEntrySchema = z.object({
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
  sourceUrl: z.string().url(),
  verifiedAt: z.string().date(),
  workerAdapter: WorkerAdapterSchema.optional(),
  // Descriptive health coverage is not an installed executable registration.
  workerHealthAdapter: WorkerAdapterSchema.optional(),
  workerHealthCoverage: z.object({
    scope: z.literal('out'), coverage: z.literal('unobserved'), handshake: z.literal('unobserved'),
    evidenceGrades: z.array(z.enum(['H', 'R', 'D'])).max(3),
    qualificationOwner: z.string().regex(/^B-OG-[0-9]{2}$/),
    provenance: z.array(z.string().min(1).max(4096)).min(1).max(16), reason: z.string().min(1).max(4096),
  }).strict().optional(),
}).strict();
const CapabilityRegistrySchema = z.object({
  $schema: z.enum([
    '../../../schemas/models/provider-model-capabilities.v1.schema.json',
    'https://aiwg.io/schemas/models/provider-model-capabilities.v1.schema.json',
  ]).optional(),
  version: z.literal('1.0.0'),
  verifiedAt: z.string().date(),
  providers: z.record(ProviderSchema, CapabilityEntrySchema),
  workerAdapters: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,62}$/), WorkerAdapterSchema)
    .refine(value => Object.keys(value).length <= 128, 'At most 128 worker adapters').optional(),
  workerHealthAdapters: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,62}$/), WorkerAdapterSchema)
    .refine(value => Object.keys(value).length <= 128, 'At most 128 worker health descriptors').optional(),
}).strict();
const CatalogModelSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['active', 'deprecated', 'unverified']),
  fallback: z.string().min(1).optional(),
  observed: z.boolean().optional(),
});
const CatalogProviderSchema = z.object({
  roles: z.object({
    reasoning: CatalogModelSchema,
    coding: CatalogModelSchema,
    efficiency: CatalogModelSchema,
  }),
  sourceUrl: z.string().url(),
  verifiedAt: z.string().date(),
});
let catalogValidators: { catalog: ValidateFunction; observation: ValidateFunction; discovery: ValidateFunction } | undefined;
function getCatalogValidators(): NonNullable<typeof catalogValidators> {
  if (!catalogValidators) {
    const here = dirname(fileURLToPath(import.meta.url));
    const file = [resolve(here, '../../schemas/models/model-catalog.v1.schema.json'), resolve(here, '../../../schemas/models/model-catalog.v1.schema.json')].find(existsSync);
    if (!file) throw new Error('Model catalog schema is unavailable');
    const schema = JSON.parse(readFileSync(file, 'utf8'));
    const ajv = addFormats(new Ajv2020({ strict: false, allErrors: true }));
    ajv.addSchema(schema);
    catalogValidators = { catalog: ajv.getSchema(schema.$id)!, observation: ajv.compile({ $ref: `${schema.$id}#/$defs/workerObservation` }), discovery: ajv.compile({ $ref: `${schema.$id}#/properties/discovery` }) };
  }
  return catalogValidators;
}
export function validateWorkerModelObservation(input: unknown): string[] {
  const validate = getCatalogValidators().observation;
  return validate(input) ? [] : (validate.errors ?? []).map(error => `${error.instancePath}: ${error.message}`);
}
const WorkerObservationSchema = z.custom<WorkerModelObservation>(input => validateWorkerModelObservation(input).length === 0);
const DiscoveredWorkerModelSchema = z.object({
  id: z.string().min(1), apiModelId: z.string().optional(), llmProvider: z.string().optional(),
  hidden: z.boolean().optional(), reasoningEfforts: z.array(z.string()).optional(), worker: WorkerObservationSchema.optional(),
}).passthrough().superRefine((model, context) => {
  if (!model.worker) return;
  if (model.hidden !== undefined && model.worker.visibility !== (model.hidden ? 'hidden' : 'listed')) context.addIssue({ code: 'custom', path: ['worker', 'visibility'], message: 'Conflicting visibility evidence' });
  const efforts = model.reasoningEfforts ?? [];
  const observed = model.worker.efforts.map(e => e.id);
  if (efforts.length !== observed.length || new Set(observed).size !== observed.length || efforts.some(e => !observed.includes(e))) context.addIssue({ code: 'custom', path: ['worker', 'efforts'], message: 'Conflicting effort evidence' });
});
const ProviderDiscoverySchema = z.object({
  provider: z.string(), source: z.enum(['native', 'cache', 'remote', 'static']), observedAt: z.string().datetime({ offset: true }),
  runtimeVersion: z.string().optional(), accountScope: z.enum(['local-account', 'local-runtime', 'public-feed', 'static']),
  accountBinding: z.string().min(1).optional(), models: z.array(DiscoveredWorkerModelSchema),
}).passthrough();
const DiscoverySchema = z.object({
  source: z.enum(['native', 'cache', 'remote', 'static']), upstreamSource: z.enum(['native', 'remote', 'static']).optional(),
  fetchedAt: z.string().datetime({ offset: true }), remoteUrl: z.string().url().optional(), remoteError: z.string().optional(),
  inventorySignature: z.string().optional(), providers: z.record(z.string(), ProviderDiscoverySchema),
  instances: z.record(z.string(), ProviderDiscoverySchema).optional(),
}).strict();

/** Optional enrichment is checked without tightening legacy catalog rows. */
export function validateWorkerCatalogDiscovery(input: unknown): string[] {
  if (input === undefined) return [];
  const validate = getCatalogValidators().discovery;
  if (!validate(input)) return (validate.errors ?? []).map(error => `${error.instancePath}: ${error.message}`);
  const parsed = DiscoverySchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map(issue => `${issue.path.join('/')}: ${issue.message}`);
}

const CatalogSchema = z.object({
  version: z.literal('1.0.0'),
  $schema: z.literal('../../../schemas/models/model-catalog.v1.schema.json').optional(),
  discovery: DiscoverySchema.optional(),
  refreshedAt: z.string().date(),
  staleAfterDays: z.number().int().positive(),
  providers: z.record(ProviderSchema, CatalogProviderSchema),
}).strict();
const PolicySchema = z.object({
  role: z.enum(['reasoning', 'coding', 'efficiency']),
  tier: z.enum(['economy', 'standard', 'premium']),
  effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
  override: z.string().min(1).optional(),
}).strict();
const uniqueStrings = z.array(z.string().min(1)).refine(values => new Set(values).size === values.length, 'Duplicate entries');
const WorkerDataPolicySchema = z.object({
  allowedProcessing: z.array(z.enum(['local', 'remote'])).refine(values => new Set(values).size === values.length).optional(),
  allowProductImprovement: z.boolean().optional(),
  allowUnknown: z.boolean().optional(),
  maxRetentionDays: z.number().int().nonnegative().optional(),
}).strict();
const WorkerRoleSchema = z.object({
  groups: uniqueStrings.refine(values => values.length > 0),
  tier: z.enum(['economy', 'standard', 'premium', 'max-quality']),
  initialEffort: z.string().min(1).nullable(),
  effortLadder: uniqueStrings,
  escalateAfter: z.number().int().positive().optional(),
  maxEscalations: z.number().int().nonnegative().optional(),
  deescalateAfter: z.number().int().positive().optional(),
  allowNotApplicableEffort: z.boolean().optional(),
}).strict();
export const WorkerSelectionPolicySchema = z.object({
  roleGuidance: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,62}$/), WorkerRoleSchema).optional(),
  guards: z.object({
    deniedEfforts: uniqueStrings.optional(),
    deniedModels: uniqueStrings.optional(),
    denySelfDelegation: z.boolean().optional(),
    requireExactModel: z.boolean().optional(),
    allowedVisibility: z.array(z.enum(['listed', 'hidden'])).refine(v => new Set(v).size === v.length).optional(),
    allowedLifecycle: z.array(z.enum(['active', 'deprecated'])).refine(v => new Set(v).size === v.length).optional(),
    minimumIdentityEvidence: z.enum(['runtime-configured', 'backend-attested']).optional(),
  }).strict().optional(),
  dataPolicy: WorkerDataPolicySchema.optional(),
  dataClasses: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,62}$/), WorkerDataPolicySchema).optional(),
  freshness: z.object({
    warnHours: z.number().int().positive().optional(),
    blockHours: z.number().int().positive().optional(),
    policyDays: z.number().int().positive().optional(),
  }).strict().optional(),
  taskClasses: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,62}$/), z.string().min(1)).optional(),
}).strict().superRefine((policy, context) => {
  for (const [role, guidance] of Object.entries(policy.roleGuidance ?? {})) {
    if (!['efficiency', 'coding', 'reasoning'].includes(role)) context.addIssue({ code: 'custom', path: ['roleGuidance', role], message: 'Unknown worker role' });
    if (guidance.effortLadder.includes('none') || (guidance.initialEffort === 'none' ? guidance.effortLadder.length !== 0 : guidance.initialEffort !== null && !guidance.effortLadder.includes(guidance.initialEffort))) {
      context.addIssue({ code: 'custom', path: ['roleGuidance', role], message: 'Initial effort must belong to the ladder; real none requires an empty ladder' });
    }
    if (guidance.initialEffort === null && (guidance.allowNotApplicableEffort !== true || guidance.effortLadder.length !== 0)) {
      context.addIssue({ code: 'custom', path: ['roleGuidance', role], message: 'Null effort requires an empty ladder and allowNotApplicableEffort=true' });
    }
  }
  for (const key of policy.guards?.deniedModels ?? []) {
    if (!isCanonicalWorkerModelKey(key)) context.addIssue({ code: 'custom', path: ['guards', 'deniedModels'], message: 'Noncanonical inference model key' });
  }
  if (policy.freshness?.warnHours !== undefined && policy.freshness.blockHours !== undefined && policy.freshness.warnHours > policy.freshness.blockHours) {
    context.addIssue({ code: 'custom', path: ['freshness'], message: 'warnHours must not exceed blockHours' });
  }
  for (const role of Object.values(policy.taskClasses ?? {})) {
    if (!['coding', 'reasoning', 'efficiency'].includes(role)) context.addIssue({ code: 'custom', path: ['taskClasses'], message: 'Unknown worker role' });
  }
});

/** Canonical RFC3986 identity; installation and account never enter the key. */
export function workerModelKey(inferenceProvider: string, apiModelId: string): string {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(inferenceProvider) || !apiModelId) throw new Error('OG_CONFIG_REFERENCE: invalid inference model identity');
  return `${inferenceProvider}/${encodeURIComponent(apiModelId).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
export function isCanonicalWorkerModelKey(key: string): boolean {
  const slash = key.indexOf('/');
  try { return slash > 0 && workerModelKey(key.slice(0, slash), decodeURIComponent(key.slice(slash + 1))) === key; } catch { return false; }
}

export const DEFAULT_WORKER_SELECTION: WorkerSelectionPolicy = {
  guards: { deniedEfforts: ['ultra'], deniedModels: [], denySelfDelegation: true, requireExactModel: true, allowedVisibility: ['listed'], allowedLifecycle: ['active'], minimumIdentityEvidence: 'runtime-configured' },
  dataPolicy: { allowedProcessing: ['local', 'remote'], allowProductImprovement: false, allowUnknown: false },
  freshness: { warnHours: 24, blockHours: 168, policyDays: 30 },
  taskClasses: { inventory: 'efficiency', implementation: 'coding', architecture: 'reasoning', review: 'reasoning' },
};

export interface WorkerPolicyLayer {
  source: string;
  authority: WorkerPolicyOrigin['authority'];
  digest: string;
  policy?: WorkerSelectionPolicy;
}

/** Merge leaves, preserving pre-merge explicit origins and attempted relaxations. */
export function mergeWorkerSelection(layers: WorkerPolicyLayer[]): {
  policy: WorkerSelectionPolicy; origins: Record<string, WorkerPolicyOrigin[]>; diagnostics: WorkerPolicyDiagnostic[];
} {
  const policy: Record<string, any> = {};
  const origins: Record<string, WorkerPolicyOrigin[]> = {};
  const diagnostics: WorkerPolicyDiagnostic[] = [];
  const visit = (target: Record<string, any>, input: Record<string, any>, parts: string[], layer: WorkerPolicyLayer): void => {
    for (const [key, value] of Object.entries(input)) {
      const path = [...parts, key];
      const pointer = `/defaults/workerSelection/${path.map(p => p.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        target[key] ??= {};
        visit(target[key], value, path, layer);
        continue;
      }
      const origin: WorkerPolicyOrigin = { source: layer.source, authority: layer.authority, digest: layer.digest, pointer, contribution: structuredClone(value) };
      const prior = origins[pointer] ?? [];
      const explicit = prior.filter(o => o.authority !== 'builtin');
      let effective = structuredClone(value);
      let relaxation = false;
      if (layer.authority !== 'builtin' && explicit.length > 0) {
        const previous = target[key];
        if (['deniedEfforts', 'deniedModels'].includes(key)) effective = [...new Set([...previous, ...value])];
        else if (['allowedVisibility', 'allowedLifecycle', 'allowedProcessing'].includes(key)) {
          relaxation = value.some((v: string) => !previous.includes(v));
          effective = previous.filter((v: string) => value.includes(v));
        } else if (['denySelfDelegation', 'requireExactModel'].includes(key)) {
          relaxation = previous === true && value === false;
          effective = previous || value;
        } else if (['allowUnknown', 'allowProductImprovement'].includes(key)) {
          relaxation = previous === false && value === true;
          effective = previous && value;
        } else if (['maxRetentionDays', 'warnHours', 'blockHours', 'policyDays'].includes(key)) {
          relaxation = value > previous;
          effective = Math.min(previous, value);
        } else if (key === 'minimumIdentityEvidence') {
          relaxation = previous === 'backend-attested' && value !== previous;
          effective = previous === 'backend-attested' ? previous : value;
        }
      }
      if (relaxation) diagnostics.push({ code: 'OG_POLICY_RELAXATION', pointer, message: 'Explicit restriction cannot relax an inherited restriction', origins: [...explicit, origin] });
      target[key] = effective;
      origins[pointer] = [...prior, origin];
    }
  };
  for (const layer of layers) if (layer.policy) visit(policy, layer.policy, [], layer);
  const validation = WorkerSelectionPolicySchema.safeParse(policy);
  if (!validation.success) for (const issue of validation.error.issues) diagnostics.push({ code: 'OG_CONFIG_REFERENCE', pointer: `/defaults/workerSelection/${issue.path.join('/')}`, message: issue.message });
  // Data classes are applied as further restrictions to the base path.
  for (const dataClass of Object.values(policy.dataClasses ?? {}) as WorkerDataPolicy[]) {
    const base = policy.dataPolicy ?? {};
    if (dataClass.allowedProcessing) dataClass.allowedProcessing = dataClass.allowedProcessing.filter(p => !base.allowedProcessing || base.allowedProcessing.includes(p));
    for (const key of ['allowUnknown', 'allowProductImprovement'] as const) if (base[key] === false) dataClass[key] = false;
    if (base.maxRetentionDays !== undefined) dataClass.maxRetentionDays = Math.min(dataClass.maxRetentionDays ?? base.maxRetentionDays, base.maxRetentionDays);
  }
  return { policy, origins, diagnostics };
}

const UserProjectModelConfigSchema = z.object({
  defaults: z.object({
    tier: z.enum(['economy', 'standard', 'premium', 'max-quality']).optional(),
    provider: ProviderSchema.optional(),
    workerSelection: WorkerSelectionPolicySchema.optional(),
  }).strict().optional(),
  agentOverrides: z.record(z.string(), z.object({
    'model-tier': z.enum(['economy', 'standard', 'premium', 'max-quality']).optional(),
    'model-override': z.string().min(1).optional(),
    rationale: z.string().min(1).optional(),
  }).strict()).optional(),
  customTiers: z.record(z.string(), z.object({
    description: z.string().min(1),
    costMultiplier: z.number().nonnegative(),
    roleMapping: z.object({
      reasoning: z.enum(['reasoning', 'coding', 'efficiency']),
      coding: z.enum(['reasoning', 'coding', 'efficiency']),
      efficiency: z.enum(['reasoning', 'coding', 'efficiency']),
    }).strict(),
  }).strict()).optional(),
  rationale: z.string().optional(),
}).passthrough();

export type ProviderModelCapability = z.infer<typeof CapabilityEntrySchema>;
export type ProviderModelCapabilityRegistry = z.infer<typeof CapabilityRegistrySchema>;
export type ProviderModelCatalog = z.infer<typeof CatalogSchema>;
export type ModelPolicyProvider = Exclude<Provider, 'openai'>;
export type ModelDiagnosticSeverity = 'error' | 'warning' | 'info';
export interface ModelDiagnostic {
  code:
    | 'MODEL_POLICY_INVALID' | 'MODEL_PROVIDER_UNKNOWN' | 'OG_CONFIG_REFERENCE'
    | 'MODEL_SURFACE_UNSUPPORTED' | 'MODEL_SURFACE_DEGRADED'
    | 'MODEL_EFFORT_UNSUPPORTED' | 'MODEL_CATALOG_DEPRECATED'
    | 'MODEL_CATALOG_UNVERIFIED' | 'MODEL_CATALOG_STALE'
    | 'MODEL_OVERRIDE_UNVERIFIED';
  severity: ModelDiagnosticSeverity;
  message: string;
  provider?: Provider;
  pointer?: string;
}
export interface CompileModelPolicyInput {
  provider: ModelPolicyProvider;
  artifact: 'agent' | 'skill';
  policy: CanonicalModelPolicy;
  catalog?: ProviderModelCatalog;
  now?: Date;
}
export interface CompiledModelPolicy {
  provider: ModelPolicyProvider;
  artifact: 'agent' | 'skill';
  outcome: ModelCompilationOutcome;
  effectiveModel?: string;
  effectiveEffort?: ModelEffort;
  fields: Record<string, string>;
  target: string;
  source: 'override' | 'catalog' | 'inheritance';
  diagnostics: ModelDiagnostic[];
}

let registryCache: ProviderModelCapabilityRegistry | null = null;
let catalogCache: ProviderModelCatalog | null = null;

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
  constructor(public readonly code: WorkerPolicyDiagnostic['code'], message: string) {
    super(message);
    this.name = 'WorkerPolicyError';
  }
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
  const guidance = context.role ? policy.roleGuidance?.[context.role] : undefined;
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

export interface WorkerBoundary {
  kind: 'native' | 'os' | 'executor';
  identity: string;
  digest: string;
  controls: string[];
}

const WORKER_CONTROLS = ['model', 'effort', 'sandbox', 'approval', 'workdir',
  'finalOutput', 'stdin', 'structuredOutput', 'stepCap', 'trust', 'children', 'fallback'];

/** Caller controls only add restrictions. Absent resolved authority, require all controls. */
export function requiredWorkerControls(context: {
  policy?: WorkerSelectionPolicy; permissions?: WorkerExecution; effort?: string | null;
  requiredControls?: string[];
}): string[] {
  if (context.requiredControls !== undefined && (!Array.isArray(context.requiredControls)
    || context.requiredControls.some(name => typeof name !== 'string' || !name))) {
    throw new Error('Worker required controls must be an array of control names');
  }
  const controls = new Set(WORKER_CONTROLS);
  if (context.policy && context.permissions) {
    if (context.effort === null) controls.delete('effort');
    // Step limits are observed unless explicitly required by the trusted route.
    controls.delete('stepCap');
    if (context.policy.guards?.denySelfDelegation === false) controls.delete('children');
  }
  for (const name of context.requiredControls ?? []) controls.add(name);
  return [...controls];
}

interface WorkerProfileSelection {
  profile: string; transport: 'shell' | 'mcp'; cliVersion: string; requiredControls?: string[];
  policy?: WorkerSelectionPolicy; permissions?: WorkerExecution; effort?: string | null;
  boundary?: WorkerBoundary;
  mcp?: WorkerInvocationProfile['mcp'];
}

/** The same sandbox requirement governs inspection, resolution and rendering. */
export function requiresWorkerExternalBoundary(adapter: WorkerAdapterMetadata, selection: WorkerProfileSelection): boolean {
  if (hasOperatorWorkerNativeRenderer(adapter) && selection.permissions?.sandbox !== 'external') return false;
  const providers = [adapter.id, adapter.provider].map(normalizeProviderDefinitionId);
  return requiredWorkerControls(selection).includes('sandbox')
    && (providers.some(provider => provider && ['claude', 'muse', 'hermes'].includes(provider))
      || adapter.invocationProfiles?.[selection.profile]?.controls.sandbox?.support === 'external'
      || selection.permissions?.sandbox === 'external');
}

/** Explicit local operator approval for the direct CLI baseline (decision 17).
 * This is not backend attestation or a live negative-fixture result. */
export const WORKER_OPERATOR_APPROVAL = 'aiwg doctor --probe-workers --qualify';
export function isOperatorQualifiedWorkerAdapter(adapter: WorkerAdapterMetadata): boolean {
  return adapter.qualification.status === 'qualified'
    && adapter.qualification.evidenceRef === WORKER_OPERATOR_APPROVAL;
}

/** Only this bundled renderer has an independently checked native direct baseline. */
export function hasOperatorWorkerNativeRenderer(adapter: WorkerAdapterMetadata): boolean {
  return isOperatorQualifiedWorkerAdapter(adapter) && adapter.provider === 'codex'
    && adapter.invocation.kind === 'process';
}

/** Check the actual argv before granting the direct renderer exception. */
export function assertOperatorWorkerNativeArgv(adapter: WorkerAdapterMetadata, argv: string[],
  selected: { model: string; effort: { value: string | null } }, permissions?: { sandbox?: string; approval?: string }): void {
  if (!hasOperatorWorkerNativeRenderer(adapter)) return;
  const args = argv.slice(1);
  const requirePair = (flag: string, value: string): void => {
    if (args.filter(token => token === flag).length !== 1 || args[args.indexOf(flag) + 1] !== value) {
      throw new Error(`Requested native worker control is absent or ambiguous: ${flag}`);
    }
  };
  const sandbox = permissions?.sandbox ?? 'workspace-write';
  if (!['read-only', 'workspace-write'].includes(sandbox)) throw new Error('Requested sandbox has no verified native renderer');
  requirePair('-m', selected.model);
  requirePair('-s', sandbox);
  for (const [name, value] of [['model_reasoning_effort', selected.effort.value], ['approval_policy', permissions?.approval ?? 'never']]) {
    const overrides = args.flatMap((token, index) => token === '-c' ? [args[index + 1]] : [])
      .filter(token => token?.split('=')[0] === name);
    if (value === null || overrides.length !== 1 || overrides[0] !== `${name}=${JSON.stringify(value)}`) {
      throw new Error(`Requested native worker control is absent or ambiguous: ${name}`);
    }
  }
  // Permit only the bounded native command grammar. Alternate/combined flags,
  // profiles and additional config overrides must not undo the checked pairs.
  if (args[0] !== '--no-daemon' || args[1] !== 'exec' || !args.includes('--ignore-user-config')) {
    throw new Error('Native worker controls could be overridden');
  }
  for (let index = 2; index < args.length; index++) {
    const flag = args[index];
    if (['--ignore-user-config', '--skip-git-repo-check', '--json'].includes(flag)) continue;
    if (flag === '-' && index === args.length - 1) continue;
    if (!['-m', '-s', '-c', '-C', '-o'].includes(flag) || index + 1 >= args.length) {
      throw new Error('Native worker controls could be overridden');
    }
    const value = args[++index];
    if (flag === '-c' && !['model_reasoning_effort', 'approval_policy'].includes(value.split('=')[0])) {
      throw new Error('Native worker controls could be overridden');
    }
  }
}

/** Inspect declared controls before installation evidence can be produced. This
 * does not authorize invocation; consumers must use qualifyWorkerInvocationProfile. */
export function inspectWorkerInvocationProfile(adapter: WorkerAdapterMetadata, selection: WorkerProfileSelection): WorkerInvocationProfile {
  WorkerAdapterSchema.parse(adapter);
  const profile = adapter.invocationProfiles?.[selection.profile];
  if (adapter.qualification.status !== 'qualified' || !profile || profile.transport !== selection.transport) {
    throw new Error('Worker transport/profile is unqualified');
  }
  // Shared range predicate (worker-installation.mjs): read-only surfaces
  // (worker-direct-readiness.ts) reuse the same helper instead of
  // re-deriving this inspector's range logic.
  if (workerVersionRangeMismatch(selection.cliVersion, [adapter.supportedVersions, profile.supportedVersions]) !== null) {
    throw new Error('Worker CLI version is outside qualified profile');
  }
  // The direct CLI baseline trusts the installed driver's bounded renderer.
  // Explicit extra controls still require the existing qualified mappings.
  if (hasOperatorWorkerNativeRenderer(adapter) && profile.transport === 'shell') {
    if (selection.permissions?.sandbox && !['read-only', 'workspace-write'].includes(selection.permissions.sandbox)) {
      throw new Error('Requested sandbox has no verified native renderer');
    }
    if (selection.permissions?.sandbox === 'external' && (!selection.boundary
      || !['os', 'executor'].includes(selection.boundary.kind) || !selection.boundary.controls.includes('sandbox'))) {
      throw new Error('Requested external sandbox requires an enforcing boundary');
    }
    for (const name of selection.requiredControls ?? []) {
      if (!['native', 'external'].includes(profile.controls[name]?.support)) {
        throw new Error(`Required worker control is unqualified: ${name}`);
      }
    }
    return profile;
  }
  const requiredControls = requiredWorkerControls(selection);
  if (requiresWorkerExternalBoundary(adapter, selection)
    && (!selection.boundary || !['os', 'executor'].includes(selection.boundary.kind)
      || !selection.boundary.identity || !/^sha256:[a-f0-9]{64}$/.test(selection.boundary.digest)
      || !selection.boundary.controls?.includes('sandbox'))) {
    throw new Error('Required worker control sandbox needs a qualified external enforcing boundary');
  }
  for (const name of requiredControls) {
    if ((name === 'children' && !adapter.capabilities.nestedAgentsControllable)
      || (name === 'fallback' && !adapter.capabilities.nativeFallbackControllable)) {
      throw new Error(`Required worker control is unqualified: ${name}`);
    }
    const control = profile.controls[name];
    if (!control || !['native', 'external'].includes(control.support) || !control.mapping || !control.evidence) {
      throw new Error(`Required worker control is unqualified: ${name}`);
    }
  }
  if (selection.transport === 'mcp' && (!selection.mcp || !profile.mcp
    || Object.keys(profile.mcp).some(key => profile.mcp![key as keyof NonNullable<typeof profile.mcp>]
      !== selection.mcp![key as keyof NonNullable<typeof selection.mcp>]))) {
    throw new Error('MCP server/tool/schema/session qualification changed');
  }
  return profile;
}

/** Qualification is transport/version scoped; declaration or boundary claims
 * alone cannot qualify an external sandbox. The invocation owner rechecks the
 * installation scope, including this boundary, against the recorded digest. */
export function qualifyWorkerInvocationProfile(adapter: WorkerAdapterMetadata, selection: WorkerProfileSelection): WorkerInvocationProfile {
  const profile = inspectWorkerInvocationProfile(adapter, selection);
  if (isOperatorQualifiedWorkerAdapter(adapter) && selection.policy?.guards?.denySelfDelegation !== false
    && !adapter.capabilities.nestedAgentsControllable) {
    throw new Error('Required worker control is unqualified: children');
  }
  if (requiresWorkerExternalBoundary(adapter, selection) && !profile.installationQualification) {
    throw new Error('Required worker control sandbox needs matching installation qualification for its external boundary');
  }
  return profile;
}

export interface WorkerHealthQualificationScope {
  profileRef: string;
  cliVersion: string;
  accountScope: string;
  inferenceProvider: string;
  model: string;
  effort: string | null;
}

/** Health timing evidence belongs to the exact execution profile and tuple.
 * Fixture qualification does not become authenticated/live qualification. */
export function workerHealthScopeDigest(profile: WorkerInvocationProfile, scope: WorkerHealthQualificationScope): string {
  const { installationQualification: _installation, health, ...executionProfile } = profile;
  const { qualification: _qualification, ...signals } = health ?? {};
  return qualificationDigest({ profile: executionProfile, health: signals,
    profileRef: scope.profileRef, cliVersion: scope.cliVersion, accountScope: scope.accountScope,
    modelKey: workerModelKey(scope.inferenceProvider, scope.model), effort: scope.effort });
}

/** Reused by observation and invocation owners before using qualified health.
 * Older profiles have no qualification record and retain degraded observation. */
export function assertWorkerHealthQualification(profile: WorkerInvocationProfile, scope: WorkerHealthQualificationScope): void {
  const evidence = profile.health?.qualification;
  if (!evidence) return;
  if (evidence.status === 'unqualified') {
    if (profile.health?.coverage === 'full' || profile.health?.handshake === 'semantic') {
      throw new Error('Unqualified worker health cannot assert full or semantic coverage');
    }
    return;
  }
  const modelKey = workerModelKey(scope.inferenceProvider, scope.model);
  if (evidence.cliVersion !== scope.cliVersion || evidence.accountScope !== scope.accountScope
    || evidence.profileRef !== scope.profileRef || evidence.modelKey !== modelKey || evidence.effort !== scope.effort
    || !profile.health?.qualifiedAt || !Number.isFinite(Date.parse(profile.health.qualifiedAt))
    || evidence.scopeDigest !== workerHealthScopeDigest(profile, scope)
    || (evidence.status === 'live-qualified' && evidence.authorizedLive !== true)) {
    throw new Error('Worker health qualification scope changed or lacks live authorization');
  }
}

export function parseProviderModelCatalog(input: unknown): ProviderModelCatalog {
  const validate = getCatalogValidators().catalog;
  if (!validate(input)) throw new Error(`MODEL_POLICY_INVALID: ${validate.errors?.map(e => `${e.instancePath} ${e.message}`).join('; ')}`);
  return CatalogSchema.parse(input);
}
export function loadProviderModelCatalog(): ProviderModelCatalog {
  if (!catalogCache) catalogCache = parseProviderModelCatalog(catalogData);
  return catalogCache;
}
export function validateCanonicalModelPolicy(
  input: unknown,
): { valid: true; policy: CanonicalModelPolicy; diagnostics: ModelDiagnostic[] }
  | { valid: false; diagnostics: ModelDiagnostic[] } {
  const parsed = PolicySchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      diagnostics: parsed.error.issues.map(issue => ({
        code: 'MODEL_POLICY_INVALID',
        severity: 'error',
        message: `${issue.path.join('.') || 'policy'}: ${issue.message}`,
      })),
    };
  }
  return { valid: true, policy: parsed.data, diagnostics: [] };
}
export function validateUserProjectModelConfig(input: unknown): {
  valid: boolean;
  diagnostics: ModelDiagnostic[];
} {
  const parsed = UserProjectModelConfigSchema.safeParse(input);
  if (parsed.success) return { valid: true, diagnostics: [] };
  return {
    valid: false,
    diagnostics: parsed.error.issues.map(issue => ({
      code: issue.path.includes('workerSelection') ? 'OG_CONFIG_REFERENCE' : 'MODEL_POLICY_INVALID',
      pointer: `/${issue.path.map(p => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`,
      severity: 'error',
      message: `${issue.path.join('.') || 'config'}: ${issue.message}`,
    })),
  };
}
function catalogRole(policy: CanonicalModelPolicy): ModelRole {
  if (policy.tier === 'economy') return 'efficiency';
  if (policy.tier === 'premium') return 'reasoning';
  return policy.role;
}
function fieldNames(provider: Provider): { model?: string; effort?: string } {
  switch (provider) {
    case 'antigravity': return { model: 'model', effort: 'effort' };
    case 'codex': return { model: 'model', effort: 'model_reasoning_effort' };
    case 'factory': return { model: 'model', effort: 'reasoningEffort' };
    case 'claude': return { model: 'model', effort: 'effort' };
    case 'copilot':
    case 'cursor':
    case 'opencode': return { model: 'model' };
    case 'grok-build': return { model: 'model', effort: 'effort' };
    case 'omp': return { model: 'model', effort: 'thinkingLevel' };
    case 'pi': return { model: 'model', effort: 'thinking' };
    case 'openhuman': return { model: 'model_hint' };
    case 'openclaw': return { model: 'subagents.model' };
    default: return {};
  }
}
export function compileModelPolicy(input: CompileModelPolicyInput): CompiledModelPolicy {
  const registry = loadProviderModelCapabilities();
  const catalog = input.catalog ?? loadProviderModelCatalog();
  const capability = registry.providers[input.provider];
  if (!capability) throw new Error(`Unknown provider model capability: ${input.provider}`);
  const surface = capability[input.artifact];
  const diagnostics: ModelDiagnostic[] = [];
  const fields: Record<string, string> = {};
  const names = fieldNames(input.provider);
  const catalogProvider = catalog.providers[input.provider];
  if (!catalogProvider) throw new Error(`Unknown provider model catalog: ${input.provider}`);
  const catalogEntry = catalogProvider.roles[catalogRole(input.policy)];
  const effectiveModel = input.policy.override ?? catalogEntry.id;

  if (surface === 'unsupported' || surface === 'informational') {
    diagnostics.push({
      code: surface === 'unsupported' ? 'MODEL_SURFACE_UNSUPPORTED' : 'MODEL_SURFACE_DEGRADED',
      severity: surface === 'unsupported' ? 'warning' : 'info',
      provider: input.provider,
      message: `${input.provider} cannot enforce ${input.artifact}-scoped model policy (${surface})`,
    });
  } else if (surface === 'global-only' || surface === 'inherited') {
    diagnostics.push({
      code: 'MODEL_SURFACE_DEGRADED', severity: 'warning', provider: input.provider,
      message: `${input.provider} compiles ${input.artifact} policy as ${surface}`,
    });
  } else if (names.model) {
    fields[names.model] = effectiveModel;
  }
  if (input.policy.effort) {
    if (names.effort && capability.effortValues?.includes(input.policy.effort)
      && surface !== 'unsupported' && surface !== 'informational') {
      fields[names.effort] = input.policy.effort;
    } else {
      diagnostics.push({
        code: 'MODEL_EFFORT_UNSUPPORTED', severity: 'warning', provider: input.provider,
        message: `${input.provider} does not enforce effort=${input.policy.effort} on ${input.artifact} artifacts`,
      });
    }
  }
  if (input.policy.override) {
    diagnostics.push({
      code: 'MODEL_OVERRIDE_UNVERIFIED', severity: 'warning', provider: input.provider,
      message: `Exact override ${input.policy.override} requires provider validation`,
    });
  } else if (catalogEntry.status === 'deprecated') {
    diagnostics.push({
      code: 'MODEL_CATALOG_DEPRECATED', severity: 'error', provider: input.provider,
      message: `${catalogEntry.id} is deprecated`,
    });
  } else if (catalogEntry.status === 'unverified') {
    diagnostics.push({
      code: 'MODEL_CATALOG_UNVERIFIED', severity: 'warning', provider: input.provider,
      message: `${catalogEntry.id} has not been observed on ${input.provider}`,
    });
  }
  const now = input.now ?? new Date();
  const refreshedAt = new Date(`${catalog.refreshedAt}T00:00:00Z`);
  const ageDays = Math.floor((now.getTime() - refreshedAt.getTime()) / 86_400_000);
  if (ageDays > catalog.staleAfterDays) {
    diagnostics.push({
      code: 'MODEL_CATALOG_STALE', severity: 'warning', provider: input.provider,
      message: `Model catalog is ${ageDays} days old (limit ${catalog.staleAfterDays})`,
    });
  }
  return {
    provider: input.provider,
    artifact: input.artifact,
    outcome: surface,
    effectiveModel: surface === 'unsupported' || surface === 'informational' ? undefined : effectiveModel,
    effectiveEffort: fields[names.effort ?? ''] ? input.policy.effort : undefined,
    fields,
    target: capability.configTarget,
    source: input.policy.override ? 'override' : (surface === 'inherited' ? 'inheritance' : 'catalog'),
    diagnostics,
  };
}
function tomlString(value: string): string { return JSON.stringify(value); }
export interface CodexAgentDefinition {
  name: string;
  description: string;
  developerInstructions: string;
  model?: string;
  modelReasoningEffort?: ModelEffort;
}
export function renderCodexAgentToml(definition: CodexAgentDefinition): string {
  const required = [
    ['name', definition.name],
    ['description', definition.description],
    ['developer_instructions', definition.developerInstructions],
  ] as const;
  for (const [field, value] of required) {
    if (!value.trim()) throw new Error(`Codex custom agent requires ${field}`);
  }
  const lines: string[] = required.map(([field, value]) => `${field} = ${tomlString(value)}`);
  if (definition.model) lines.push(`model = ${tomlString(definition.model)}`);
  if (definition.modelReasoningEffort) {
    lines.push(`model_reasoning_effort = ${tomlString(definition.modelReasoningEffort)}`);
  }
  return `${lines.join('\n')}\n`;
}
export function resetModelPolicyCachesForTests(): void {
  registryCache = null;
  catalogCache = null;
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
  const narrowed = dataClass ? policy.dataClasses?.[dataClass] : undefined;
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

/** Optional catalog facts do not veto otherwise qualified selection. */
export function hasSelectionRelevantConflicts(observation: WorkerModelObservation): boolean {
  const relevant = /^\/(?:lifecycle|availability|visibility|hidden|efforts|effortSupport|reasoningEfforts|sunsetAt|retiredAt|replacementModelId|supersededBy|dataUse|id|apiModelId|llmProvider|cliId|family|runtimeVersion|accountScope|endpointFingerprint|identityEvidence|contextTokens|maxOutputTokens|qualification)(?:\/|$)/;
  return observation.conflicts?.some(conflict => relevant.test(conflict.field)) ?? false;
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
  const guidance = input.policy.roleGuidance?.[input.role];
  if (observation.qualification.status !== 'qualified' || !observation.qualification.roles.includes(input.role)) deny('OG_ADAPTER_UNQUALIFIED', '/worker/qualification', 'Role lacks qualified evidence. Run aiwg doctor --probe-workers --qualify.');
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
