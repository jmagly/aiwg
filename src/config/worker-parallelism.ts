// Defines and validates direct worker parallelism configuration before use.
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDER_IDS } from '../providers/provider-definitions.js';
import { isCanonicalWorkerModelKey, loadProviderModelCapabilities, resolveWorkerInstallation, type ProviderModelCapabilityRegistry } from '../models/provider-policy.js';
import { resolveDispatchHostThresholds } from './dispatch-thresholds-runtime.mjs';
import type { DispatchHostThresholds } from './aiwg-config.js';
import type { ParallelismConfig } from './aiwg-config.js';
import { localModelsUrl } from '../models/local-endpoint-models.js';
import { expandWorkerGroupTemplates } from './worker-group-templates.js';

export interface WorkerInstallation {
  adapter: string;
  enabled?: boolean;
  executable?: string;
  endpoint?: string;
  localModels?: import('../models/local-endpoint-models.js').LocalModelSource;
  accountScope: string;
  quotaScope: string;
  credentialRef?: string;
  approvalRef?: string;
  invocationProfile?: string;
  mcpServerRef?: string;
}
export interface WorkerMember {
  id: string;
  cli: string;
  model: string;
  roles: Array<'efficiency' | 'coding' | 'reasoning'>;
  enabled?: boolean;
  priority?: number;
}
export interface WorkerExecution {
  launchMode?: 'systemd-unit' | 'native-sandbox';
  isolation?: 'worktree' | 'snapshot' | 'isolated-copy';
  sandbox?: 'read-only' | 'workspace-write' | 'external';
  approval?: 'never' | 'on-request';
  network?: 'deny' | 'allowlisted';
  runnerRef?: string;
  verifierRunnerRef?: string;
  transport?: 'shell' | 'mcp';
  receipts?: 'off' | 'optional' | 'required';
}
export interface WorkerGroup {
  template?: string;
  efforts?: string[];
  dataPolicy?: import('../models/types.js').WorkerDataPolicy;
  members?: WorkerMember[];
  fallback?: string[];
  execution?: WorkerExecution;
  requiredRoles?: Array<'efficiency' | 'coding' | 'reasoning'>;
  maxParallel?: number;
}
export interface WorkerActivation {
  revision: number;
  configDigest: string;
  projectModelsDigest: string;
  userModelsDigest: string;
  builtinModelsDigest: string;
  previousRef?: string;
  snapshotRef: string;
}
export interface WorkerParallelism {
  worker_dispatch?: boolean;
  worker_mode?: 'direct' | 'managed';
  clis?: Record<string, WorkerInstallation>;
  groups?: Record<string, WorkerGroup>;
  groupTemplates?: Record<string, WorkerGroup>;
  admission?: {
    groupCaps?: Record<string, number>; cliCaps?: Record<string, number>;
    memberCaps?: Record<string, number>; modelCaps?: Record<string, number>; quotaCaps?: Record<string, number>;
    queueTimeoutSeconds?: number; leaseSeconds?: number; starvationSeconds?: number; maxQueued?: number; authorityRef?: string;
    /**
     * Live host-resource thresholds (FR-OG-107, #2954). Tightens
     * `build.resource_preflight.dispatch` field-by-field; unset fields fall back to
     * {@link DEFAULT_DISPATCH_HOST_THRESHOLDS}. File-based admission wiring is
     * advisory for Tier 0 conductors; shared enforced admission lands in S2.
     */
    hostResources?: DispatchHostThresholds;
  };
  budgets?: {
    perRun?: { tokens?: number; costUsd?: number; wallSeconds?: number };
    perTask?: { tokens?: number; costUsd?: number; wallSeconds?: number };
    enforcement?: 'hard' | 'observed'; unknownCost?: 'deny' | 'reserve'; reservationUsd?: number;
  };
  retry?: { maxAttempts?: number; on?: Array<'rate-limit' | 'unavailable' | 'timeout'>; baseDelaySeconds?: number; maxDelaySeconds?: number };
  health?: {
    startupSeconds?: number; checkSeconds?: number; quietSeconds?: number; stallSeconds?: number;
    diagnosticGraceSeconds?: number; terminateGraceSeconds?: number; hardTimeoutSeconds?: number; maxSteps?: number;
    requireStepCap?: boolean; roleScale?: Partial<Record<'efficiency' | 'coding' | 'reasoning', number>>;
    effortScale?: Record<string, number>; modelScale?: Record<string, number>; modelStartupSeconds?: Record<string, number>;
    correlationWindowSeconds?: number; failureCount?: number; allFailedMinimum?: number; cooldownSeconds?: number;
    maxCooldownSeconds?: number; probeSeconds?: number; probeMaxBytes?: number; halfOpenMaxProbes?: 1;
  };
  activation?: WorkerActivation;
}

let parallelismValidator: ValidateFunction | undefined;
/** Offline shape and declaration validation. Qualification is checked at use time. */
export function validateParallelismConfig(value: unknown): string[] {
  if (value === undefined) return [];
  const raw = value;
  const expansion = expandWorkerGroupTemplates(value);
  if (expansion.errors.length) return expansion.errors;
  value = expansion.parallelism;
  if (!parallelismValidator) {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [resolve(here, '../../vscode-extension/schemas/aiwg.config.v1.json'), resolve(here, '../../../vscode-extension/schemas/aiwg.config.v1.json')];
    const file = candidates.find(existsSync);
    if (!file) throw new Error('Parallelism schema is unavailable');
    const schema = JSON.parse(readFileSync(file, 'utf8'));
    const ajv = addFormats(new Ajv({ strict: true, allErrors: true }));
    parallelismValidator = ajv.compile({ ...schema.properties.parallelism, definitions: schema.definitions });
  }
  if (!parallelismValidator(raw)) return (parallelismValidator.errors ?? []).map(error => `OG_CONFIG_REFERENCE /parallelism${error.instancePath}: ${error.message}`);
  if (!parallelismValidator(value)) return (parallelismValidator.errors ?? []).map(error => `OG_CONFIG_REFERENCE /parallelism${error.instancePath}: ${error.message}`);
  const policy = value as ParallelismConfig;
  const errors: string[] = [];
  const error = (pointer: string, message: string): void => { errors.push(`OG_CONFIG_REFERENCE /parallelism/${pointer}: ${message}`); };
  const builtinIds = new Set<string>(PROVIDER_IDS.filter(id => id !== 'generic'));
  for (const [id, installation] of Object.entries(policy.clis ?? {})) {
    if (installation.localModels) {
      try { localModelsUrl(installation.localModels); } catch { error(`clis/${id}/localModels/endpoint`, 'Requires a credential-free HTTP endpoint on loopback or allowedHosts'); }
      if (new Set(installation.localModels.models.map(model => model.id)).size !== installation.localModels.models.length) error(`clis/${id}/localModels/models`, 'Duplicate model ID');
    }
    if (installation.adapter.startsWith('providers:') && !builtinIds.has(installation.adapter.slice(10))) error(`clis/${id}/adapter`, 'Unknown provider binding');
  }
  for (const [id, group] of Object.entries(policy.groups ?? {})) {
    if (group.execution?.launchMode === 'native-sandbox'
      && (!['read-only', 'workspace-write'].includes(group.execution.sandbox ?? '')
        || (group.execution.transport ?? 'shell') !== 'shell')) {
      error(`groups/${id}/execution/launchMode`, 'native-sandbox requires an enforcing read-only or workspace-write shell sandbox');
    }
    if (group.execution?.launchMode === 'native-sandbox') {
      if (group.execution.approval === 'on-request') error(`groups/${id}/execution/approval`, 'native-sandbox requires approval="never"');
      if (group.execution.network === 'allowlisted') error(`groups/${id}/execution/network`, 'native-sandbox requires network="deny"');
    }
    const ids = new Set<string>();
    for (const member of (group.members ?? [])) {
      if (ids.has(member.id)) error(`groups/${id}/members`, 'Duplicate member ID');
      ids.add(member.id);
      if (!policy.clis?.[member.cli] && !builtinIds.has(member.cli)) error(`groups/${id}/members/${member.id}/cli`, 'Unknown installation');
      if (group.execution?.launchMode === 'native-sandbox'
        && (policy.clis?.[member.cli]?.adapter ?? `providers:${member.cli}`) !== 'providers:codex') {
        error(`groups/${id}/members/${member.id}/cli`, 'native-sandbox requires a codex adapter');
      }
    }
    for (const member of group.fallback ?? []) if (!ids.has(member)) error(`groups/${id}/fallback`, 'Unknown fallback member');
    for (const role of group.requiredRoles ?? []) {
      if (!(group.members ?? []).some(m => m.enabled !== false && policy.clis?.[m.cli]?.enabled !== false && m.roles.includes(role))) error(`groups/${id}/requiredRoles`, `No enabled member covers ${role}`);
    }
  }
  const admission = policy.admission;
  for (const group of Object.keys(admission?.groupCaps ?? {})) if (!policy.groups?.[group]) error('admission/groupCaps', 'Unknown group');
  for (const cli of Object.keys(admission?.cliCaps ?? {})) if (!policy.clis?.[cli] && !builtinIds.has(cli)) error('admission/cliCaps', 'Unknown installation');
  for (const key of Object.keys(admission?.memberCaps ?? {})) {
    const [group, member, extra] = key.split('/');
    if (extra !== undefined || !policy.groups?.[group]?.members?.some(m => m.id === member)) error('admission/memberCaps', 'Unknown group/member');
  }
  for (const key of Object.keys(admission?.modelCaps ?? {})) if (!isCanonicalWorkerModelKey(key)) error('admission/modelCaps', 'Noncanonical inference model key');
  if (admission?.hostResources !== undefined) {
    try {
      resolveDispatchHostThresholds(undefined, admission.hostResources);
    } catch (validation) {
      error('admission/hostResources', validation instanceof Error ? validation.message : String(validation));
    }
  }
  errors.push(...validateWorkerHealthConfig(policy.health));
  return errors;
}

/** Cross-field health preferences are validated offline; controls are qualified at dispatch. */
export function validateWorkerHealthConfig(health: WorkerParallelism['health']): string[] {
  if (health === undefined) return [];
  const errors: string[] = [];
  const error = (field: string, message: string): void => { errors.push(`OG_CONFIG_REFERENCE /parallelism/health/${field}: ${message}`); };
  const checkSeconds = health.checkSeconds ?? 15;
  if (checkSeconds > (health.startupSeconds ?? 60)) error('checkSeconds', 'Must not exceed startupSeconds');
  if ((health.quietSeconds ?? 90) >= (health.stallSeconds ?? 300)) error('quietSeconds', 'Must be less than stallSeconds');
  if ((health.cooldownSeconds ?? 120) > (health.maxCooldownSeconds ?? 900)) error('cooldownSeconds', 'Must not exceed maxCooldownSeconds');
  for (const role of Object.keys(health.roleScale ?? {})) {
    if (!['efficiency', 'coding', 'reasoning'].includes(role)) error('roleScale', `Unknown role ${role}`);
  }
  for (const field of ['modelScale', 'modelStartupSeconds'] as const) {
    for (const [key, value] of Object.entries(health[field] ?? {})) {
      if (!isCanonicalWorkerModelKey(key)) error(field, 'Noncanonical inference model key');
      if (field === 'modelStartupSeconds' && checkSeconds > value) error(field, 'Model startup must cover checkSeconds');
    }
  }
  return errors;
}

/** Resolve one enabled installation through trusted metadata, without probes.
 * Implicit canonical IDs inherit current-account auth; no account/quota identity
 * is invented. Profile qualification remains the invocation owner's obligation.
 */
export function resolveWorkerGroupInstallation(
  parallelism: ParallelismConfig,
  installationId: string,
  registry: ProviderModelCapabilityRegistry = loadProviderModelCapabilities(),
) {
  const errors = validateParallelismConfig(parallelism);
  if (errors.length) throw new Error(errors.join('; '));
  if (!parallelism.worker_dispatch) throw new Error('OG_CONFIG_REFERENCE /parallelism/worker_dispatch: Worker dispatch is disabled');
  const explicit = parallelism.clis?.[installationId];
  const installation = explicit
    ? structuredClone(explicit)
    : { adapter: `providers:${installationId}`, enabled: true };
  if (!explicit && (!PROVIDER_IDS.includes(installationId as typeof PROVIDER_IDS[number]) || installationId === 'generic')) {
    throw new Error(`OG_CONFIG_REFERENCE /parallelism/clis/${installationId}: Unknown canonical installation`);
  }
  if (installation.enabled === false) throw new Error(`OG_CONFIG_REFERENCE /parallelism/clis/${installationId}: Installation is disabled`);
  try {
    return { installation: { ...installation, enabled: true }, ...resolveWorkerInstallation(registry, installation) };
  } catch (error) {
    throw new Error(`OG_ADAPTER_UNQUALIFIED /parallelism/clis/${installationId}: ${error}`);
  }
}
