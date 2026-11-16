// Validates the refreshable model catalog and compiles canonical tier intent.
import { z } from 'zod';
import { integer, dateTime, url, number } from '../schema/zod-validation.mjs';
import { getCatalogValidators, validateWorkerModelObservation } from './worker-review-lineage.js';
import { MODEL_TIERS, normalizeModelTier, flagshipElected, isFlagshipModel, type FlagshipAuthority } from './tiers.js';
import { ProviderSchema, requireModelResource } from './policy-resources.js';
import { loadProviderModelCapabilities } from './provider-policy.js';
import { WorkerSelectionPolicySchema } from './worker-selection-policy.js';
import type { CanonicalModelPolicy, ModelCompilationOutcome, ModelEffort, ModelRole, Provider, WorkerModelObservation } from './types.js';
const catalogData = requireModelResource('model-catalog.v1.json');
const CatalogModelSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['active', 'deprecated', 'unverified']),
  fallback: z.string().min(1).optional(),
  observed: z.boolean().optional(),
  selection: z.literal('user-elected').optional(),
});
const CatalogProviderSchema = z.object({
  roles: z.object({
    reasoning: CatalogModelSchema,
    coding: CatalogModelSchema,
    efficiency: CatalogModelSchema,
  }),
  tiers: z.object({
    flagship: CatalogModelSchema.extend({ selection: z.literal('user-elected') }),
    premium: CatalogModelSchema, standard: CatalogModelSchema, economy: CatalogModelSchema,
  }).optional(),
  verified_at: z.string().date().optional(),
  evidence: z.string().min(1).optional(),
  sourceUrl: url(),
  verifiedAt: z.string().date(),
});
// One copy of the catalog validators lives with the lightweight lineage module (#3167).
export { validateWorkerModelObservation } from './worker-review-lineage.js';
const WorkerObservationSchema = z.custom<WorkerModelObservation>(input => validateWorkerModelObservation(input).length === 0);
const DiscoveredWorkerModelSchema = z.looseObject({
  id: z.string().min(1), apiModelId: z.string().optional(), llmProvider: z.string().optional(),
  hidden: z.boolean().optional(), reasoningEfforts: z.array(z.string()).optional(), worker: WorkerObservationSchema.optional(),
}).superRefine((model, context) => {
  if (!model.worker) return;
  if (model.hidden !== undefined && model.worker.visibility !== (model.hidden ? 'hidden' : 'listed')) context.addIssue({ code: 'custom', path: ['worker', 'visibility'], message: 'Conflicting visibility evidence' });
  const efforts = model.reasoningEfforts ?? [];
  const observed = model.worker.efforts.map(e => e.id);
  if (efforts.length !== observed.length || new Set(observed).size !== observed.length || efforts.some(e => !observed.includes(e))) context.addIssue({ code: 'custom', path: ['worker', 'efforts'], message: 'Conflicting effort evidence' });
});
const ProviderDiscoverySchema = z.looseObject({
  provider: z.string(), source: z.enum(['native', 'cache', 'remote', 'static', 'local-endpoint']), observedAt: dateTime({ offset: true }),
  runtimeVersion: z.string().optional(), accountScope: z.enum(['local-account', 'local-runtime', 'public-feed', 'static']),
  accountBinding: z.string().min(1).optional(), models: z.array(DiscoveredWorkerModelSchema),
});
const DiscoverySchema = z.strictObject({
  source: z.enum(['native', 'cache', 'remote', 'static', 'local-endpoint']), upstreamSource: z.enum(['native', 'remote', 'static', 'local-endpoint']).optional(),
  fetchedAt: dateTime({ offset: true }), remoteUrl: url().optional(), remoteError: z.string().optional(),
  inventorySignature: z.string().optional(), providers: z.record(z.string(), ProviderDiscoverySchema),
  instances: z.record(z.string(), ProviderDiscoverySchema).optional(),
});

/** Optional enrichment is checked without tightening legacy catalog rows. */
export function validateWorkerCatalogDiscovery(input: unknown): string[] {
  if (input === undefined) return [];
  const validate = getCatalogValidators().discovery;
  if (!validate(input)) return (validate.errors ?? []).map(error => `${error.instancePath}: ${error.message}`);
  const parsed = DiscoverySchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map(issue => `${issue.path.join('/')}: ${issue.message}`);
}

const CatalogSchema = z.strictObject({
  version: z.literal('1.0.0'),
  $schema: z.literal('../../../schemas/models/model-catalog.v1.schema.json').optional(),
  discovery: DiscoverySchema.optional(),
  refreshedAt: z.string().date(),
  staleAfterDays: integer().positive(),
  providers: z.partialRecord(ProviderSchema, CatalogProviderSchema),
});
const PolicySchema = z.strictObject({
  role: z.enum(['reasoning', 'coding', 'efficiency']),
  tier: z.enum(MODEL_TIERS).transform(normalizeModelTier),
  effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
  override: z.string().min(1).optional(),
});
const UserProjectModelConfigSchema = z.looseObject({
  defaults: z.strictObject({
    tier: z.enum(MODEL_TIERS).optional(),
    provider: ProviderSchema.optional(),
    workerSelection: WorkerSelectionPolicySchema.optional(),
  }).optional(),
  agentOverrides: z.record(z.string(), z.strictObject({
    'model-tier': z.enum(MODEL_TIERS).optional(),
    'model-override': z.string().min(1).optional(),
    rationale: z.string().min(1).optional(),
  })).optional(),
  customTiers: z.record(z.string(), z.strictObject({
    description: z.string().min(1),
    costMultiplier: number().check(z.gte(0)).meta({ type: 'number', minimum: 0 }),
    roleMapping: z.strictObject({
      reasoning: z.enum(['reasoning', 'coding', 'efficiency']),
      coding: z.enum(['reasoning', 'coding', 'efficiency']),
      efficiency: z.enum(['reasoning', 'coding', 'efficiency']),
    }),
  })).optional(),
  rationale: z.string().optional(),
});

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
export interface CompileModelPolicyInput extends FlagshipAuthority {
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

let catalogCache: ProviderModelCatalog | null = null;
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
  const tier = normalizeModelTier(input.policy.tier);
  const catalogEntry = catalogProvider.tiers?.[tier] ?? catalogProvider.roles[catalogRole(input.policy)];
  if (tier === 'flagship' && !catalogProvider.tiers) throw new Error('Provider has no flagship binding');
  const effectiveModel = input.policy.override ?? catalogEntry.id;
  const electedOnly = tier === 'flagship' || isFlagshipModel(effectiveModel)
    || [...Object.values(catalogProvider.roles), ...Object.values(catalogProvider.tiers ?? {})]
      .some(entry => entry.id === effectiveModel && entry.selection === 'user-elected');
  if (electedOnly && !flagshipElected(input)) throw new Error('Flagship models are user-elected only');

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

export function resetCatalogPolicyCache(): void { catalogCache = null; }
