/** Validate and render a prepared invocation against trusted installation controls. */
import path from 'node:path';
import { findPackageRoot } from '../cli/find-package-root.js';
import { workerOutputPaths } from './worker-invocation-paths.js';
import { directWorkerEnvironment } from '../config/worker-attribution.mjs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateWorkerArtifacts } from './worker-artifacts.mjs';
import { assertValidWorkerPayload } from '../mission-protocol/codecs.js';
import type { WorkerResolvedInvocation } from '../mission-protocol/types.js';
import type { WorkerExecution } from '../config/aiwg-config.js';
import type { WorkerResolutionCeilings } from '../models/worker-plan.js';
import { qualificationDigest } from '../models/qualification-digest.mjs';
import { qualifyWorkerInvocationProfile, assertOperatorWorkerNativeArgv, assertWorkerSelectionAllowed,
  assertWorkerLaunchMode, requiresWorkerExternalBoundary, assertWorkerHealthQualification, WorkerPolicyError,
  DEFAULT_WORKER_SELECTION, type WorkerAdapterMetadata, type WorkerInvocationProfile, type WorkerBoundary } from '../models/provider-policy.js';

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
  /** Explicit task restrictions from the same request used to resolve the plan. */
  ceilings?: WorkerResolutionCeilings;
  task?: string;
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
  validateWorkerArtifacts(result);
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
  assertWorkerLaunchMode(qualification.adapter, qualification.permissions);
  if (result.isolation !== undefined && result.isolation !== (qualification.permissions?.launchMode ?? 'systemd-unit')) {
    throw new WorkerPolicyError('OG_PIN_MISMATCH', 'Worker launch mode differs from the execution policy');
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
    const deadline = qualification.ceilings?.wallSeconds === undefined ? ''
      : `timeout --signal=KILL ${quote(`${Math.min(result.health?.hardTimeoutSeconds ?? Infinity, result.limits.wallSeconds)}s`)} `;
    const markers = Object.entries(directWorkerEnvironment(result)).map(([name, value]) => `${name}=${quote(value)}`).join(' ');
    const worker = `${deadline}env -i${environment ? ` ${environment}` : ''} ${markers} ${result.argv.map(quote).join(' ')}`;
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
        binding.storePath, binding.storeDigest, JSON.stringify(qualification.policy ?? null), result.selected.model].map(quote).join(' ');
      result.shellCommand = `cd ${quote(result.cwd)} && env -i${environment ? ` ${environment}` : ''} ${frame} | ${worker} ${outputs}`;
    } else if (result.stdin === 'closed' || result.stdin === 'brief-text') {
      const stdin = result.stdin === 'closed' ? '< /dev/null' : `< ${quote(result.briefPath)}`;
      result.shellCommand = `cd ${quote(result.cwd)} && ${worker} ${stdin} ${outputs}`;
    } else {
      throw new Error(`Unsupported worker stdin mode: ${result.stdin}`);
    }
    const root = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
    if (!root) throw new Error('Worker shell handoff requires the installed AIWG package root');
    const guard = path.join(root, 'tools/ralph-external/lib/worker-shell-capture.mjs');
    const binding = { request: { role: qualification.role, task: qualification.task ?? null,
      group: result.selected.group, workdir: result.cwd },
      invocation: { cwd: result.cwd, briefPath: result.briefPath, briefDigest: result.briefDigest, stdin: result.stdin, selected: result.selected },
      paths: workerOutputPaths(result) };
    // Reserve every output before shell redirection or vendor-owned final writes.
    // Noclobber also protects stream files created between reservation and exec.
    result.shellCommand = `${[process.execPath, guard, JSON.stringify(binding)].map(quote).join(' ')} && (set -C; ${result.shellCommand})`;
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

