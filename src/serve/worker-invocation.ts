/** One nonlaunching typed renderer shared by models resolve and Ralph. */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, realpath, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolveWorkerPlan, type WorkerPlanSnapshot, type WorkerResolutionPlan } from '../models/resolver.js';
import { workerConfigDigest, validateWorkerHealthConfig } from '../config/aiwg-config.js';
import type { McpServerRegistry, McpWorkerQualificationInput } from '../mcp/registry.js';
import type { McpProfile } from '../mcp/profiles.js';
import { assertValidWorkerPayload } from '../mission-protocol/codecs.js';
import type { WorkerResolvedInvocation, WorkerEffectiveHealth } from '../mission-protocol/types.js';
import type { WorkerPolicyDiagnostic } from '../models/types.js';
import { qualificationDigest } from '../models/qualification-digest.mjs';
import type { WorkerExecution, ParallelismConfig } from '../config/aiwg-config.js';
import { qualifyWorkerInvocationProfile, isOperatorQualifiedWorkerAdapter, assertOperatorWorkerNativeArgv, assertWorkerSelectionAllowed,
  requiredWorkerControls, requiresWorkerExternalBoundary, isCanonicalWorkerModelKey, assertWorkerHealthQualification, WorkerPolicyError, DEFAULT_WORKER_SELECTION, type WorkerAdapterMetadata, type WorkerInvocationProfile, type WorkerBoundary } from '../models/provider-policy.js';

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

/**
 * The exact digest formula an MCP worker binding's `inputSchemaDigest`/
 * `outputSchemaDigest` are pinned against (used below and reused verbatim by
 * the #2892 MCP worker-invoke bridge's own live `tools/list` schema-drift
 * check — see `src/mcp/tools/worker-invoke.mjs` M3). Deliberately the raw
 * `JSON.stringify` of the schema object, NOT `workerConfigDigest`'s
 * canonicalized (sorted-key) form — a schema's own declared key order is
 * part of what gets pinned at qualification time.
 */
export function mcpToolSchemaDigest(schema: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(schema)).digest('hex')}`;
}

export interface WorkerInvocationQualification extends ParametersContext {
  installation?: WorkerInstallationRequest;
  /** Host store bytes bound by the recorded-installation loader, never a brief/cwd lookup. */
  stdinFramerBinding?: { storePath: string; storeDigest: string };
  adapter: WorkerAdapterMetadata;
  adapterId: string;
  cliVersion: string;
  platform?: string;
  requiredControls?: string[];
  permissions?: WorkerExecution;
  boundary?: WorkerBoundary;
  mcp?: WorkerInvocationProfile['mcp'];
  mcpSchemas?: { input: Record<string, unknown>; output: Record<string, unknown> };
  expectedDigests?: Pick<WorkerResolvedInvocation, 'policyDigest' | 'catalogDigest' | 'profileDigest' | 'briefDigest'>;
}
/** Host-owned #2885 inspection inputs; never loaded from task/brief data. */
export interface WorkerInstallationRequest {
  executable: string;
  cwd: string;
  workerWritableRoots: string[];
  effectiveConfigDigest: string;
  accountScope: string;
  boundary: WorkerBoundary;
  environment?: Record<string, string>;
  mcpServerDigest?: string;
  evidence: NonNullable<WorkerInvocationProfile['installationQualification']> & { cases: Record<string, string> };
  [key: string]: unknown;
}
type ParametersContext = Parameters<typeof assertWorkerSelectionAllowed>[1];
type CompleteInvocation = WorkerResolvedInvocation & Required<Pick<WorkerResolvedInvocation,
  'cwd' | 'briefPath' | 'stdoutPath' | 'stderrPath' | 'finalPath' | 'argv' | 'envNames'>>;

export async function prepareWorkerInvocation(invocation: WorkerResolvedInvocation,
  qualification: WorkerInvocationQualification): Promise<WorkerResolvedInvocation> {
  const result = structuredClone(invocation) as CompleteInvocation;
  // shellCommand is derived syntax, never authority supplied by a brief.
  if (result.transport === 'shell') result.shellCommand = '';
  // Validate the established invocation shape first. Health is optional and
  // is checked after policy, installation and transport qualification below.
  const contract = { ...result };
  delete contract.health;
  assertValidWorkerPayload('workerResolvedInvocation', contract);
  if ((qualification.platform ?? process.platform) !== 'linux') {
    throw new Error('Unsupported worker invocation platform; Linux is required');
  }
  if (!Number.isFinite(qualification.now) || Date.parse(result.expiresAt) <= qualification.now) {
    throw new Error('Worker invocation is expired or has no validation clock');
  }
  if (qualification.adapter.id !== qualification.adapterId) {
    throw new Error('Worker invocation adapter identity mismatch');
  }
  for (const [key, value] of Object.entries(qualification.expectedDigests ?? {})) {
    if (result[key as keyof WorkerResolvedInvocation] !== value) throw new WorkerPolicyError('OG_PIN_MISMATCH', `Worker invocation ${key} changed`);
  }
  const verified = Date.parse(qualification.adapter.qualification.verifiedAt ?? '');
  const policyDays = qualification.policy?.freshness?.policyDays ?? DEFAULT_WORKER_SELECTION.freshness!.policyDays!;
  if (!Number.isFinite(verified) || verified > qualification.now || qualification.now - verified >= policyDays * 86400000) {
    throw new Error('Worker installation qualification is stale or invalid');
  }
  assertWorkerSelectionAllowed(result.selected, qualification);
  const profile = qualifyWorkerInvocationProfile(qualification.adapter, {
    profile: result.selected.profileRef, transport: result.transport,
    cliVersion: qualification.cliVersion,
    requiredControls: qualification.requiredControls, policy: qualification.policy,
    permissions: qualification.permissions, effort: result.selected.effort.value, boundary: qualification.boundary,
    mcp: qualification.mcp,
  });
  if (requiresWorkerExternalBoundary(qualification.adapter, { ...qualification,
    profile: result.selected.profileRef, transport: result.transport, effort: result.selected.effort.value })) {
    const installed = qualification.installation;
    const evidence = profile.installationQualification;
    if (!installed || !evidence || (['scopeDigest', 'fixtureDigest', 'verifiedAt', 'evidenceRef'] as const)
      .some(key => installed.evidence?.[key] !== evidence[key])
      || !qualification.boundary || qualificationDigest(qualification.boundary) !== qualificationDigest(installed.boundary)) {
      throw new WorkerPolicyError('OG_ADAPTER_UNQUALIFIED', 'Worker installation evidence and qualified boundary must match');
    }
  }
  if (profile.installationQualification) {
    const installedAt = Date.parse(profile.installationQualification.verifiedAt);
    if (!Number.isFinite(installedAt) || installedAt > qualification.now
      || qualification.now - installedAt >= policyDays * 86400000) {
      throw new Error('Worker installation qualification is stale or invalid');
    }
  }
  const scopeDigest = profile.installationQualification?.scopeDigest ?? qualification.adapter.qualification.fixtureDigest;
  if (result.selected.qualificationDigest !== scopeDigest) throw new WorkerPolicyError('OG_PIN_MISMATCH', 'Worker qualification digest changed');
  const absolute = (value: unknown): value is string => typeof value === 'string' && path.posix.isAbsolute(value) && !value.includes('\0');
  for (const key of ['cwd', 'briefPath', 'stdoutPath', 'stderrPath', 'finalPath'] as const) {
    if (!absolute(result[key])) throw new Error(`Worker invocation requires absolute ${key}`);
  }
  const briefPath = path.posix.normalize(result.briefPath);
  if ([result.stdoutPath, result.stderrPath, result.finalPath].some(value => path.posix.normalize(value) === briefPath)
    || path.posix.normalize(result.stdoutPath) === path.posix.normalize(result.stderrPath)) {
    throw new Error('Worker invocation input/output paths must be distinct');
  }
  if (result.transport === 'shell') {
    assertOperatorWorkerNativeArgv(qualification.adapter, result.argv, result.selected, qualification.permissions);
    if (!absolute(result.argv[0]) || result.argv[0].includes('=') || result.argv.some(value => value.includes('\0'))) {
      throw new WorkerPolicyError('OG_CONFIG_REFERENCE', 'Worker invocation requires an absolute binary without equals and NUL-free argv');
    }
    if (result.envNames.some(name => !profile.envAllowlist.includes(name))) {
      throw new Error('Worker invocation environment is outside the qualified allowlist');
    }
    const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
    // Only validated environment names appear as shell syntax; their values
    // remain in the conductor environment and are never printed in the plan.
    const environment = result.envNames.map(name => `${name}="\${${name}-}"`).join(' ');
    // The frozen 'closed' value means empty stdin (immediate EOF). 'brief-json'
    // pipes a conductor-built params document framed from the brief file
    // (worker-stdin-frame.mjs), so brief text never enters any argv.
    const worker = `env -i${environment ? ` ${environment}` : ''} ${result.argv.map(quote).join(' ')}`;
    const outputs = `> ${quote(result.stdoutPath)} 2> ${quote(result.stderrPath)}`;
    if (result.stdin === 'brief-json') {
      const framer = fileURLToPath(new URL('./worker-stdin-frame.mjs', import.meta.url));
      const frame = [process.execPath, framer, result.briefPath, result.selected.model, result.cwd].map(quote).join(' ');
      result.shellCommand = `cd ${quote(result.cwd)} && env -i ${frame} | ${worker} ${outputs}`;
    } else if (result.stdin === 'adapter-frame') {
      const binding = qualification.stdinFramerBinding;
      if (!binding || !absolute(binding.storePath) || !/^sha256:[a-f0-9]{64}$/.test(binding.storeDigest)) {
        throw new Error('Adapter stdin framer requires a trusted installation binding');
      }
      const framer = fileURLToPath(new URL('./worker-stdin-frame.mjs', import.meta.url));
      const frame = [process.execPath, framer, '--adapter-frame', result.briefPath, result.cwd,
        result.selected.cli, qualification.adapterId, result.selected.qualificationDigest, result.briefDigest!,
        binding.storePath, binding.storeDigest, JSON.stringify(qualification.policy ?? null)].map(quote).join(' ');
      result.shellCommand = `cd ${quote(result.cwd)} && env -i${environment ? ` ${environment}` : ''} ${frame} | ${worker} ${outputs}`;
    } else if (result.stdin === 'closed' || result.stdin === 'brief-text') {
      const stdin = result.stdin === 'closed' ? '< /dev/null' : `< ${quote(result.briefPath)}`;
      result.shellCommand = `cd ${quote(result.cwd)} && ${worker} ${stdin} ${outputs}`;
    } else {
      throw new Error(`Unsupported worker stdin mode: ${result.stdin}`);
    }
  } else {
    const binding = result.mcp!;
    for (const key of ['serverRef', 'tool', 'inputSchemaDigest', 'outputSchemaDigest', 'sessionIsolation']) {
      if (binding[key as keyof typeof binding] !== profile.mcp![key as keyof NonNullable<typeof profile.mcp>]) throw new WorkerPolicyError('OG_PIN_MISMATCH', `MCP worker binding changed: ${key}`);
    }
    if (binding.timeoutSeconds > result.limits.wallSeconds) {
      throw new Error('MCP worker timeout exceeds the invocation deadline');
    }
    for (const key of ['input', 'output'] as const) {
      const schema = qualification.mcpSchemas?.[key];
      if (!schema || mcpToolSchemaDigest(schema) !== binding[`${key}SchemaDigest`]) {
        throw new WorkerPolicyError('OG_PIN_MISMATCH', `MCP worker ${key} schema digest changed`);
      }
    }
    const { default: Ajv2020 } = await import('ajv/dist/2020.js');
    const { default: addFormats } = await import('ajv-formats');
    const validate = addFormats(new Ajv2020({ strict: true, allErrors: true })).compile(qualification.mcpSchemas!.input);
    if (!validate(binding.arguments)) throw new Error('MCP worker arguments violate the pinned input schema');
  }
  assertValidWorkerPayload('workerResolvedInvocation', result);
  if (result.health !== undefined) {
    if (result.health.profileRef !== result.selected.profileRef
      || result.health.hardTimeoutSeconds > Math.min(result.limits.wallSeconds, result.mcp?.timeoutSeconds ?? Infinity)) {
      throw new Error('Worker health profile or wall ceiling mismatch');
    }
    if (['native', 'external'].includes(result.health.stepEnforcement)
      && profile.controls.stepCap?.support !== result.health.stepEnforcement) throw new Error('Unqualified worker step enforcement');
  }
  assertWorkerHealthQualification(profile, { profileRef: result.selected.profileRef, cliVersion: qualification.cliVersion,
    accountScope: qualification.installation?.accountScope ?? '', inferenceProvider: result.selected.inferenceProvider,
    model: result.selected.model, effort: result.selected.effort.value });
  return result;
}

/** Trusted #2885 installation owner supplies driver bindings, never task input. */
export interface WorkerInvocationDriver {
  /** Pure installed-adapter framing; called only to deliver stdin. */
  buildWorkerStdinFrame?(brief: string | Buffer): string | Uint8Array;
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
    selected: WorkerResolvedInvocation['selected']; permissions: WorkerExecution;
    cwd: string; briefPath: string; brief: string; finalPath: string;
    limits: WorkerResolvedInvocation['limits'];
    health: WorkerEffectiveHealth;
  }): Promise<Pick<WorkerResolvedInvocation, 'argv' | 'stdin' | 'envNames' | 'mcp' | 'artifacts'>>;
}

export interface WorkerCommandRequest {
  role: 'efficiency' | 'coding' | 'reasoning';
  task: string;
  group: string;
  brief: string;
  workdir: string;
  final_output: string;
  transport?: 'shell' | 'mcp';
  format?: 'shell' | 'json';
  authority?: { premiumAuthorized: true; maxAutoTier: 3 };
}

/** Reject unsupported syntax before discovery or any path reads. */
export function parseWorkerCommandArgs(args: string[]): WorkerCommandRequest {
  const names: Record<string, string> = { role: 'role', task: 'task', group: 'group', brief: 'brief',
    workdir: 'workdir', 'final-output': 'final_output', transport: 'transport', format: 'format' };
  const result: Record<string, string> = {};
  let json = false;
  let premiumAuthorized = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--authorize-premium') {
      if (premiumAuthorized) throw new Error('Duplicate --authorize-premium');
      premiumAuthorized = true; continue;
    }
    if (token === '--json') { if (json) throw new Error('Duplicate --json'); json = true; continue; }
    const match = /^--([^=]+)(?:=([\s\S]*))?$/.exec(token);
    if (!match || !Object.hasOwn(names, match[1])) throw new Error(`Unsupported models resolve argument: ${token}`);
    const key = names[match[1]];
    if (key in result) throw new Error(`Duplicate --${match[1]}`);
    const value = match[2] ?? args[++i];
    if (!value || value.startsWith('--') && match[2] === undefined || value.includes('\0')) {
      throw new Error(`--${match[1]} requires a value`);
    }
    result[key] = value;
  }
  if (json && result.format && result.format !== 'json') throw new Error('--json conflicts with --format');
  if (json) result.format = 'json';
  for (const key of ['role', 'task', 'group', 'brief', 'workdir', 'final_output']) {
    if (!result[key]) throw new Error(`Missing ${key}`);
  }
  if (!['efficiency', 'coding', 'reasoning'].includes(result.role)) throw new Error('Unsupported role');
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(result.group)) throw new Error('Invalid group');
  if (result.transport && !['shell', 'mcp'].includes(result.transport)) throw new Error('Unsupported transport');
  if (result.format && !['shell', 'json'].includes(result.format)) throw new Error('Unsupported renderer; use POSIX shell or JSON');
  return { ...result, ...(premiumAuthorized ? { authority: { premiumAuthorized: true, maxAutoTier: 3 } } : {}) } as unknown as WorkerCommandRequest;
}

const bytesDigest = (bytes: Buffer | string): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export async function inspectWorkerPath(filename: string, kind: 'file' | 'directory' | 'output'): Promise<boolean> {
  if (!path.isAbsolute(filename) || filename.includes('\0')) throw new Error('Absolute NUL-free paths are required');
  if (filename.split('/').includes('..')) throw new Error('Worker path traversal is not allowed');
  const normalized = path.resolve(filename);
  let current = normalized;
  while (true) {
    try {
      const canonical = await realpath(current);
      if (canonical !== current) throw new Error(`Symlink path is not allowed: ${filename}`);
      if (current !== normalized) return false;
      const stat = await lstat(normalized);
      if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) {
        throw new Error(`Expected an unaliased ${kind}: ${filename}`);
      }
      return true;
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}
const inspectPath = inspectWorkerPath;

async function readBrief(filename: string): Promise<Buffer | null> {
  if (!await inspectPath(filename, 'file')) return null;
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 262144) throw new Error('Brief must be a bounded regular file (256 KiB)');
    const buffer = Buffer.alloc(262145);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 262144) throw new Error('Brief exceeds 256 KiB');
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}

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
  drivers: Record<string, WorkerInvocationDriver>, now = new Date().toISOString()): Promise<WorkerResolvedInvocation> {
  if (!saved.request || saved.mode !== 'direct' || saved.status !== 'eligible'
    || saved.invocation?.readiness !== 'launchable' || Date.parse(saved.invocation.expiresAt) <= Date.parse(now)) {
    throw new Error('A fresh launchable models resolve JSON plan is required');
  }
  assertValidWorkerPayload('workerResolvedInvocation', saved.invocation);
  const current = await resolveWorkerInvocation(snapshot, saved.request, drivers, now,
    { digests: saved.digests, briefDigest: saved.invocation.briefDigest ?? null });
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
  expected?: { digests: Record<string, string>; briefDigest: string | null }): Promise<WorkerCommandPlan> {
  snapshot = structuredClone(snapshot);
  request = structuredClone(request);
  let pointer = '/request/brief';
  let failureCode: WorkerPolicyDiagnostic['code'] = 'OG_CONFIG_REFERENCE';
  let plan: WorkerCommandPlan | undefined;
  try {
    if (!path.isAbsolute(request.brief)) throw new WorkerPolicyError('OG_CONFIG_REFERENCE', '--brief must be an absolute path; relative paths are not resolved against cwd or --workdir.');
    const bytes = await readBrief(request.brief);
    const briefDigest = bytes === null ? null : bytesDigest(bytes);
    if (expected && expected.briefDigest !== briefDigest) throw new WorkerPolicyError('OG_PIN_MISMATCH', 'Brief digest changed; resolve again');
    let brief: import('../mission-protocol/types.js').WorkerDirectBrief | undefined;
    if (bytes?.toString('utf8').trimStart().startsWith('{')) {
      brief = JSON.parse(bytes.toString('utf8'));
      assertValidWorkerPayload('workerDirectBrief', brief);
      if (brief!.intent.role !== request.role || brief!.intent.taskClass !== request.task || brief!.intent.group !== request.group
        || brief!.workspace.path !== request.workdir || brief!.output.resultPath !== request.final_output) {
        throw new WorkerPolicyError('OG_PIN_MISMATCH', 'Brief role/task/group/workspace/output differs from request');
      }
    }
    plan = resolveWorkerPlan(snapshot, { role: request.role, taskClass: request.task, group: request.group,
      transport: request.transport, authority: request.authority, now, expectedDigests: expected?.digests,
      ...(brief ? { dataClass: brief.intent.dataClass, member: brief.intent.pins.member,
        model: brief.intent.pins.model, effort: brief.intent.pins.effort?.value, ceilings: {
          ...brief.intent.limits, costUsd: brief.intent.limits.costUsd ?? undefined } } : {}),
      context: { estimator: 'utf8-byte-upper-bound-v1', briefTokens: bytes?.length ?? 0,
        inputTokens: 0, toolOutputAllowance: 1024, reservedOutput: 1024 },
      requiredControls: snapshot.config.parallelism?.health?.requireStepCap ? ['stepCap'] : [],
    });
    plan.request = structuredClone(request);
    if (!plan.selected) return plan;
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
    const limits = { tokens: Math.min(50000, plan.ceilings.tokens ?? 50000), costUsd: plan.ceilings.costUsd ?? null,
      wallSeconds: Math.min(900, plan.ceilings.wallSeconds ?? 900), maxAttempts: plan.ceilings.maxAttempts ?? 3 };
    const observation = snapshot.catalog.discovery!.instances![tuple.cli].models.find(row => row.id === tuple.model || row.apiModelId === tuple.model)!.worker!;
    const profile = adapter.invocationProfiles![tuple.profile];
    const expiresAt = new Date(Math.min(Date.parse(now) + 300000,
      Date.parse(tuple.observedAt) + (plan.policy?.freshness?.blockHours ?? DEFAULT_WORKER_SELECTION.freshness!.blockHours!) * 3600000,
      Math.min(Date.parse(tuple.verifiedAt), Date.parse(adapter.qualification.verifiedAt!),
        profile.installationQualification ? Date.parse(profile.installationQualification.verifiedAt) : Infinity)
        + (plan.policy?.freshness?.policyDays ?? DEFAULT_WORKER_SELECTION.freshness!.policyDays!) * 86400000)).toISOString();
    const healthConfig = snapshot.config.parallelism?.health;
    if (profile.installationQualification && !driver.prepareWorkerInvocation) {
      throw new Error('Installation-scoped profile requires the #2885 adapter preparation/recheck method');
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
    pointer = `/parallelism/clis/${tuple.cli}/invocationProfile`;
    failureCode = 'OG_ADAPTER_UNQUALIFIED';
    const healthInput = { role: request.role, effort: tuple.effort,
      modelKey: tuple.modelKey, profileRef: tuple.profile, wallSeconds: limits.wallSeconds,
      transportSeconds: adapter.invocation.kind === 'http' ? adapter.invocation.timeoutSeconds : undefined,
      stepEnforcement: controls.includes('stepCap') ? profile.controls.stepCap.support as 'native' | 'external' : 'unavailable' as const };
    let effectiveHealth = resolveWorkerEffectiveHealth(healthConfig, healthInput);
    const transport = await driver.buildInvocation({ selected: structuredClone(selected), permissions: structuredClone(tuple.permissions),
      cwd: request.workdir, briefPath: request.brief, brief: bytes?.toString('utf8') ?? '', finalPath, limits: structuredClone(limits),
      health: structuredClone(effectiveHealth) });
    if (transport.stdin === 'adapter-frame' && typeof driver.buildWorkerStdinFrame !== 'function') throw new Error('Installed adapter stdin framer is required');
    if (transport.mcp?.timeoutSeconds !== undefined) effectiveHealth = resolveWorkerEffectiveHealth(healthConfig,
      { ...healthInput, transportSeconds: Math.min(healthInput.transportSeconds ?? Infinity, transport.mcp.timeoutSeconds) });
    if (workerConfigDigest(driver.qualification) !== qualificationDigest) throw new WorkerPolicyError('OG_PIN_MISMATCH', 'Installation profile digest changed during resolution');
    const invocation: WorkerResolvedInvocation = { version: 1, mode: 'direct', transport: tuple.transport, selected,
      policyDigest, catalogDigest: plan.digests.catalogDigest, profileDigest: plan.digests.profileDigest,
      expiresAt, cwd: request.workdir, briefPath: request.brief, stdoutPath, stderrPath, finalPath,
      ...(transport.artifacts ? { artifacts: transport.artifacts } : {}),
      argv: transport.argv, stdin: transport.stdin, envNames: transport.envNames, mcp: transport.mcp,
      ...(tuple.transport === 'shell' ? { shellCommand: '' } : {}),
      readiness: bytes !== null && workspaceExists && outputParentsExist ? 'launchable' : 'preparatory', briefDigest,
      limits, maxOutputBytes: adapter.invocation.maxOutputBytes ?? 10485760,
      effectiveCaps: tuple.effectiveMaxParallel === null ? {} : { parallel: tuple.effectiveMaxParallel },
      controlEvidence: isOperatorQualifiedWorkerAdapter(adapter) ? [adapter.qualification.evidenceRef!, ...controls.map(name => profile.controls[name].evidence)] : controls.map(name => profile.controls[name].evidence),
      health: effectiveHealth,
    };
    const invocationQualification: WorkerInvocationQualification = { ...qualification, now: Date.parse(now),
      policy: plan.policy, permissions: tuple.permissions, role: request.role, modelObservation: observation,
      expectedDigests: { policyDigest, catalogDigest: plan.digests.catalogDigest, profileDigest: plan.digests.profileDigest, briefDigest },
      requiredControls: controls };
    const prepared = await (driver.prepareWorkerInvocation
      ? driver.prepareWorkerInvocation(structuredClone(invocation), invocationQualification)
      : prepareWorkerInvocation(invocation, invocationQualification));
    if (workerConfigDigest({ ...prepared, shellCommand: invocation.shellCommand }) !== workerConfigDigest(invocation)) {
      throw new WorkerPolicyError('OG_PIN_MISMATCH', 'Installation preparation changed the resolved invocation');
    }
    if (tuple.transport === 'mcp' && profile.installationQualification) {
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
  if (error instanceof WorkerPathScopeError) return { code: error.code, pointer: error.pointer, message: error.message };
  const code = error instanceof WorkerPolicyError ? error.code : fallback;
  const messages: Record<WorkerPolicyDiagnostic['code'], string> = {
    OG_CONFIG_REFERENCE: 'Invalid request or configuration reference; check the paths and settings.',
    OG_PIN_MISMATCH: 'Worker selection or pinned evidence changed; resolve again.',
    OG_MODEL_UNAPPROVED: 'The selected model lacks current approved observation evidence.',
    OG_EFFORT_DENIED: 'The selected effort is denied by the resolved worker policy.',
    OG_DATA_POLICY: 'The selected model does not satisfy the resolved data policy.',
    OG_ADAPTER_UNQUALIFIED: 'The installation or invocation could not be revalidated. Run aiwg doctor --probe-workers --qualify to qualify this workspace.',
    OG_POLICY_RELAXATION: 'The request would relax the resolved worker policy.',
    OG_BUDGET_UNMEASURABLE: 'The requested worker budget cannot be enforced.',
  };
  return { code, pointer, message: error instanceof WorkerPolicyError && error.message === '--brief must be an absolute path; relative paths are not resolved against cwd or --workdir.'
    ? error.message : messages[code] };
}
