// Checks invocation controls, native sandbox rendering and scoped worker health.
import { WorkerAdapterSchema, WorkerPolicyError, type WorkerAdapterMetadata, type WorkerInvocationProfile } from './provider-policy.js';
import type { WorkerExecution } from '../config/aiwg-config.js';
import type { WorkerSelectionPolicy } from './types.js';
import { normalizeProviderDefinitionId } from '../providers/provider-definitions.js';
import { workerVersionRangeMismatch } from './worker-installation.mjs';
import { workerModelKey } from './worker-selection-policy.js';
import { qualificationDigest } from './qualification-digest.mjs';
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
  if (hasOperatorWorkerNativeRenderer(adapter)
    && (selection.permissions?.sandbox !== 'external' || selection.transport === 'shell')) return false;
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

/** Bundled renderers with an independently checked native direct baseline. */
export function hasOperatorWorkerNativeRenderer(adapter: WorkerAdapterMetadata): boolean {
  return isOperatorQualifiedWorkerAdapter(adapter) && ['codex', 'muse', 'factory'].includes(adapter.provider)
    && adapter.invocation.kind === 'process';
}

/** The process-group launch boundary requires the independently verified native renderer. */
export function assertWorkerLaunchMode(adapter: WorkerAdapterMetadata, permissions: WorkerExecution = {}): void {
  const mode = permissions.launchMode ?? 'systemd-unit';
  if (!['systemd-unit', 'native-sandbox'].includes(mode)) {
    throw new WorkerPolicyError('OG_CONFIG_REFERENCE', 'Unknown worker launch mode');
  }
  if (mode === 'native-sandbox' && (!hasOperatorWorkerNativeRenderer(adapter)
    || !['read-only', 'workspace-write'].includes(permissions.sandbox ?? '')
    || (permissions.transport ?? 'shell') !== 'shell')) {
    throw new WorkerPolicyError('OG_POLICY_RELAXATION', 'native-sandbox requires a verified native read-only or workspace-write shell renderer');
  }
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
  if (!['read-only', 'workspace-write', 'external'].includes(sandbox)) throw new Error('Requested sandbox has no verified native renderer');
  if (adapter.provider === 'factory') {
    if (sandbox === 'external' || (permissions?.approval ?? 'never') !== 'never') {
      throw new Error('Factory direct worker requires native sandbox and never approval');
    }
    if (selected.model.startsWith('custom:') && (selected.model.trim() !== selected.model || !/^custom:[^\s\x00-\x1f\x7f]+-\d+$/.test(selected.model))) {
      throw new Error('Factory custom model selector requires a safe normalized name and numeric suffix');
    }
    requirePair('-m', selected.model);
    requirePair('--output-format', 'stream-json');
    const cwd = args[args.indexOf('--cwd') + 1];
    if (!args.includes('--cwd') || !cwd?.startsWith('/') || cwd.includes('\0')) {
      throw new Error('Factory direct worker requires an absolute workspace');
    }
    if (selected.effort.value === null && !selected.model.startsWith('custom:')) {
      throw new Error('Factory built-in models require explicit effort');
    }
    const expected = ['exec', ...(sandbox === 'workspace-write' ? ['--auto', 'low'] : []),
      '-m', selected.model, ...(selected.effort.value === null ? [] : ['-r', selected.effort.value]),
      '--cwd', cwd, '--output-format', 'stream-json'];
    if (args.length !== expected.length || args.some((value, index) => value !== expected[index])) {
      throw new Error('Factory native worker controls could be overridden');
    }
    return;
  }
  if (adapter.provider === 'muse') {
    requirePair('--provider', 'meta');
    requirePair('--model', selected.model);
    if (selected.effort.value === null) throw new Error('Muse requires explicit effort');
    requirePair('--reasoning-effort', selected.effort.value);
    if ((permissions?.approval ?? 'never') !== 'never') throw new Error('Muse direct worker approval requires never');
    requirePair('--approval-mode', 'never');
    requirePair('--approval-judge', 'off');
    // #3685: Tier 0 Muse workers run in conductor-prepared worker trees, so
    // project context must load. An argv without exactly one
    // --trust-workspace would run with project_sources=0 (no project
    // rules/skills/hooks) and is refused rather than silently degraded.
    if (args.filter(token => token === '--trust-workspace').length !== 1) {
      throw new Error('Requested native worker control is absent or ambiguous: --trust-workspace');
    }
    if (args.includes('--disable-sandbox') !== (sandbox === 'external')) {
      throw new Error('Requested native worker sandbox control does not match');
    }
    if (sandbox === 'read-only' && (!args.includes('--disable-write') || !args.includes('--disable-shell'))) {
      throw new Error('Requested native worker read-only control is absent');
    }
    if (args[0] !== 'exec') throw new Error('Native worker controls could be overridden');
    const seen = new Set<string>();
    for (let index = 1; index < args.length; index++) {
      const flag = args[index];
      if (seen.has(flag)) throw new Error('Native worker controls could be overridden');
      seen.add(flag);
      if (['--json', '--trust-workspace', '--disable-write', '--disable-shell', '--disable-sandbox'].includes(flag)) continue;
      if (!['--provider', '--model', '--reasoning-effort', '--workspace', '--approval-mode', '--approval-judge',
        '--max-model-steps', '--output-schema', '--prompt-file'].includes(flag) || index + 1 >= args.length) {
        throw new Error('Native worker controls could be overridden');
      }
      index++;
    }
    return;
  }
  requirePair('-m', selected.model);
  requirePair('-s', sandbox === 'external' ? 'danger-full-access' : sandbox);
  if ((permissions?.approval ?? 'never') !== 'never') throw new Error('Codex direct worker approval requires never');
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
    if (selection.permissions?.sandbox && !['read-only', 'workspace-write', 'external'].includes(selection.permissions.sandbox)) {
      throw new Error('Requested sandbox has no verified native renderer');
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

