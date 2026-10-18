/**
 * Direct-worker onboarding/readiness (issue #2894, S1 Tier 0 direct handoff).
 *
 * For each configured worker this reports two separate facts that must never
 * be merged:
 * - "installation readiness": is the CLI installed, and is the installed
 *   version in the registered range;
 * - "dispatch eligibility": what the resolver itself decides for this cli
 *   (worker_dispatch, per-cli enable, adapter binding, group/member
 *   qualification). When the caller supplies a `resolverSnapshot`, this calls
 *   the actual offline dispatch resolver (`resolveWorkerPlan` in resolver.ts)
 *   for every group member referencing the cli and reports its real
 *   member-specific refusals (missing installation/model evidence, policy
 *   denials, etc.) — never a re-derived approximation. Without a
 *   `resolverSnapshot` (for callers that have not resolved the wider model
 *   config/catalog), this falls back to a binding-only check through
 *   `resolveWorkerGroupInstallation` and says plainly that the result is
 *   binding-level only, not a dispatch verdict.
 *
 * Probing is opt-in. `diagnoseDirectWorkerReadiness` starts no process unless
 * the caller supplies a `probe`; surfaces such as `aiwg doctor` report
 * configuration from config and the registry by default and only probe behind
 * an explicit flag. Immediately before each probe, the resolved executable
 * and its version argv are announced through the caller's `announce`
 * callback (synchronous, never buffered) so operators see exactly what is
 * about to run before anything is spawned. The single probe implementation
 * lives in the shared installation owner (`boundedVersionProbe` in
 * worker-installation.mjs) with its credential-free environment allowlist and
 * bounds; this module only maps its outcome onto readiness findings.
 *
 * Trust boundary: a version probe runs the executable named by project
 * configuration (or the registry default) with only its registered
 * `versionArgv`, a filtered credential-free environment, and an explicit
 * cwd. That configuration is an execution trust boundary, not an executable
 * allowlist — project configuration can select an arbitrary binary, and a
 * `versionArgv` label cannot prove the selected program is side-effect free.
 * Opting into `--probe-workers` trusts that executable (and, for bare names,
 * PATH resolution) to the same extent any other locally invoked tool is
 * trusted.
 *
 * The configured `adapter` binding is always resolved through the same
 * public resolver used by installation and dispatch (`resolveWorkerGroupInstallation`
 * / `resolveWorkerAdapter`): exact, case-sensitive namespace:id references,
 * with implicit canonical `providers:<cli>` bindings for cli ids that are
 * only referenced by a group member and have no explicit `parallelism.clis`
 * entry. No alias normalization happens here — a binding this module accepts
 * is a binding the public config validator also accepts, and vice versa.
 *
 * The shipped direct profiles are declarations, not live qualification: no
 * finding ever calls a profile "qualified". Explicit operator approval uses `aiwg doctor --probe-workers --qualify`;
 * a probe alone does not qualify a profile, and an installed, in-range CLI
 * can still be refused by the resolver — the dispatch finding says so
 * plainly with the resolver's own reason.
 *
 * Decision 17 (baseline simplification) dropped provider qualification
 * runners, attestations and prescribed evidence files; this module therefore
 * performs no live-qualification recording and requires no evidence files.
 */
import { tmpdir } from 'node:os';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import {
  boundedVersionProbe,
  normalizeWorkerVersionBanner,
  workerVersionProbeDefaults,
  workerVersionProbeEnvironment,
  workerVersionRangeMismatch,
} from './worker-installation.mjs';
import { resolveWorkerGroupInstallation } from '../config/aiwg-config.js';
import { resolveWorkerPlan } from './resolver.js';
import type { AiwgConfig, ParallelismConfig, WorkerMember } from '../config/aiwg-config.js';
import type { WorkerPlanSnapshot } from './resolver.js';
import type { MergedModelConfig, WorkerPolicyDiagnostic } from './types.js';
import type { DynamicModelCatalog } from './model-discovery.js';
import type {
  ProviderModelCapabilityRegistry,
  WorkerAdapterMetadata,
} from './provider-policy.js';

export type DirectWorkerProbeOutcome =
  | { ok: true; rawBanner: string }
  | { ok: false; reason: 'not-installed' | 'probe-failed' };

/** Spawn one bounded version probe. Read-only: only `versionArgv` is ever run. */
export type DirectWorkerProber = (
  executable: string,
  versionArgv: string[],
  options: { timeoutMs: number; cwd: string },
) => Promise<DirectWorkerProbeOutcome>;

/**
 * Called synchronously immediately before a probe is spawned, one call per
 * executable. Callers that want a real-time announcement (as opposed to a
 * finding buffered into a later report) must write it out inside this
 * callback — it runs before `probe()` is awaited, never after.
 */
export type DirectWorkerAnnounce = (cli: string, executable: string, versionArgv: string[]) => void;

export type DirectWorkerInstallReadiness = 'ready' | 'not-ready' | 'skipped' | 'unprobed';
export type DirectWorkerDispatchEligibility = 'eligible' | 'blocked' | 'skipped';

export interface DirectWorkerDispatchDiagnostic extends WorkerPolicyDiagnostic {
  /** Group/member labels affected by this distinct diagnostic. */
  members: string[];
  roles: string[];
}

export interface DirectWorkerReadinessFinding {
  cli: string;
  /** 'install' speaks to installation readiness; 'dispatch' to resolver eligibility. */
  kind: 'install' | 'dispatch';
  profile: string | null;
  executable: string | null;
  installedVersion: string | null;
  status: 'ok' | 'info' | 'warn' | 'error';
  code: string;
  message: string;
  nextAction: string;
  /** Config pointer: project config file plus the exact key, for findings. */
  configFile: string;
  configKey: string;
  /** Set on kind 'install'; the other kind carries null. Never merged. */
  readiness: DirectWorkerInstallReadiness | null;
  /** Set on kind 'dispatch'; the other kind carries null. From the resolver. */
  eligibility: DirectWorkerDispatchEligibility | null;
  /** Resolver verdict in plain words (kind 'dispatch' only). */
  eligibilityDetail: string | null;
  /** Distinct resolver refusals with their affected members and roles. */
  diagnostics?: DirectWorkerDispatchDiagnostic[];
  /** Group members referencing this cli (`group/member`), for member context. */
  members: string[];
}

export interface DirectWorkerReadinessReport {
  enabled: boolean;
  workersConfigured: boolean;
  ready: boolean;
  findings: DirectWorkerReadinessFinding[];
}

/**
 * Offline snapshot for the actual dispatch resolver (`resolveWorkerPlan`).
 * When supplied, dispatch eligibility is the resolver's real verdict for
 * every group member referencing the cli, not a re-derived approximation.
 * Pass the same config/models/catalog/registry already resolved for worker
 * health readiness — building a second one is wasteful and risks drifting
 * from it. `installations` is deliberately omitted here: direct readiness
 * never invents current installation/account evidence; the resolver's own
 * "missing evidence" diagnostic is the honest offline answer.
 */
export interface DirectWorkerResolverSnapshot {
  config: AiwgConfig;
  models: MergedModelConfig;
  modelDigests: WorkerPlanSnapshot['modelDigests'];
  catalog: DynamicModelCatalog;
  now: string;
}

const SMOKE_NOTE = 'A version probe alone leaves profiles unqualified. To record direct CLI operator approval, run aiwg doctor --probe-workers --qualify; a version probe is not an authenticated smoke run (see #3005).';

function truncateBanner(banner: string, limit = 200): string {
  const singleLine = banner.replace(/[\r\n]+/g, '\\n');
  return singleLine.length > limit ? `${singleLine.slice(0, limit)}…` : singleLine;
}

/**
 * Resolve a configured executable against the project root before any probe
 * changes its working directory. Bare command names (no path separator) are
 * left untouched so PATH resolution still applies; already-absolute paths
 * are left untouched; relative paths containing a separator are resolved
 * against `projectRoot` so a project-relative executable is never looked up
 * relative to the probe's tmpdir cwd.
 */
export function resolveDirectWorkerExecutablePath(executable: string, projectRoot: string): string {
  if (isAbsolute(executable)) return executable;
  if (!executable.includes('/') && !executable.includes('\\')) return executable;
  return resolvePath(projectRoot, executable);
}

/**
 * Default live prober: the shared bounded probe with a credential-free
 * environment and explicit cwd. ENOENT means not installed; every other
 * spawn, timeout or output failure is a failed probe. Never launches a
 * worker. Callers opt in by passing this (or their own prober); without a
 * prober no process is started.
 */
export async function probeDirectWorkerVersion(
  executable: string,
  versionArgv: string[],
  options: { timeoutMs?: number; maxBytes?: number; cwd?: string } = {},
): Promise<DirectWorkerProbeOutcome> {
  const timeoutMs = options.timeoutMs ?? workerVersionProbeDefaults.timeoutMs;
  const maxBytes = options.maxBytes ?? workerVersionProbeDefaults.maxBytes;
  const cwd = options.cwd ?? tmpdir();
  try {
    const { rawBanner } = await boundedVersionProbe(
      executable, versionArgv, workerVersionProbeEnvironment(), cwd, timeoutMs, maxBytes, undefined);
    return { ok: true, rawBanner };
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'not-installed' : 'probe-failed' };
  }
}

interface ResolvedDirectEntry {
  adapter: WorkerAdapterMetadata;
  adapterRef: string;
}

const ADAPTER_REFERENCE = /^(providers|workerAdapters):(.+)$/;

/**
 * Resolve the configured binding by exact, case-sensitive namespace:id
 * lookup — the same shape `resolveWorkerAdapter` (provider-policy.ts) uses
 * for dispatch and `validateParallelismConfig` uses for config validation.
 * No alias normalization happens for either namespace, so a binding this
 * accepts is also a binding the public config validator accepts, and a
 * custom `workerAdapters:<id>` reference resolves against
 * `registry.workerAdapters`, never against the provider-alias registry.
 *
 * For the `providers` namespace this falls back from `workerAdapter` to
 * `workerHealthAdapter` when no direct-dispatch binding is pinned yet — the
 * install/version metadata is identical either way, and that is exactly
 * what lets install readiness and dispatch eligibility disagree honestly
 * (installed and in range, but the resolver still has no workerAdapter to
 * dispatch through).
 */
function resolveDirectBinding(
  registry: ProviderModelCapabilityRegistry,
  configuredAdapter: string | undefined,
  cli: string,
): ResolvedDirectEntry | { error: string } {
  let namespace: string;
  let id: string;
  if (configuredAdapter !== undefined) {
    const match = ADAPTER_REFERENCE.exec(configuredAdapter.trim());
    if (!match) return { error: `Invalid worker adapter reference '${configuredAdapter}'` };
    [, namespace, id] = match;
  } else {
    namespace = 'providers';
    id = cli;
  }
  if (namespace === 'providers') {
    const entry = registry.providers[id as keyof typeof registry.providers];
    const adapter = entry?.workerAdapter ?? entry?.workerHealthAdapter;
    if (!adapter) return { error: `No direct worker profile is registered for binding 'providers:${id}'` };
    return { adapter, adapterRef: `providers:${id}` };
  }
  const adapter = registry.workerAdapters?.[id];
  if (!adapter) return { error: `Unknown worker adapter reference 'workerAdapters:${id}'` };
  return { adapter, adapterRef: `workerAdapters:${id}` };
}

interface MemberReference { groupId: string; memberId: string; member: WorkerMember; enabled: boolean }

/** Every group member referencing this cli, including disabled ones (for context). */
function memberReferences(parallelism: ParallelismConfig, cli: string): MemberReference[] {
  const refs: MemberReference[] = [];
  for (const [groupId, group] of Object.entries(parallelism.groups ?? {})) {
    for (const member of group?.members ?? []) {
      if (member.cli !== cli) continue;
      refs.push({ groupId, memberId: member.id, member,
        enabled: member.enabled !== false && parallelism.clis?.[cli]?.enabled !== false });
    }
  }
  return refs.sort((a, b) => `${a.groupId}/${a.memberId}`.localeCompare(`${b.groupId}/${b.memberId}`));
}

function memberLabels(refs: MemberReference[]): string[] {
  return refs.map(ref => `${ref.groupId}/${ref.memberId}${ref.enabled ? '' : ' (disabled)'}`);
}

function describeConfigContext(members: string[]): string {
  return members.length ? `members: ${members.join(', ')}` : 'members: no group member references this cli';
}

/**
 * Union of every cli id a readiness pass must consider: explicit
 * `parallelism.clis` entries plus any cli id referenced only implicitly by a
 * group member (canonical default binding, no explicit installation entry).
 */
function allConfiguredCliIds(parallelism: ParallelismConfig, cli?: string): string[] {
  const ids = new Set(Object.keys(parallelism.clis ?? {}));
  for (const group of Object.values(parallelism.groups ?? {})) {
    for (const member of group?.members ?? []) ids.add(member.cli);
  }
  return [...ids].filter(id => cli === undefined || id === cli).sort();
}

/**
 * A cli is "required" only when an enabled group member referencing it also
 * covers a role its group lists in `requiredRoles`. Every other configured
 * cli is optional: installation failures stay advisory (never 'error', so
 * they never flip doctor's exit code) until something actually requires it.
 */
function isCliRequired(parallelism: ParallelismConfig, cli: string): boolean {
  for (const group of Object.values(parallelism.groups ?? {})) {
    const required = new Set(group?.requiredRoles ?? []);
    if (!required.size) continue;
    for (const member of group?.members ?? []) {
      if (member.cli !== cli || member.enabled === false) continue;
      if (parallelism.clis?.[cli]?.enabled === false) continue;
      if (member.roles.some(role => required.has(role))) return true;
    }
  }
  return false;
}

/** Cap a status at 'warn' for optional (non-required) clis so an unreferenced
 * or not-yet-wired profile never flips doctor's exit code. */
function advisoryStatus(status: 'ok' | 'info' | 'warn' | 'error', required: boolean): 'ok' | 'info' | 'warn' | 'error' {
  return required || status !== 'error' ? status : 'warn';
}

export interface DirectWorkerEligibility {
  eligibility: DirectWorkerDispatchEligibility;
  detail: string;
  diagnostics?: DirectWorkerDispatchDiagnostic[];
}

const offlineDirectContext = (): { estimator: string; briefTokens: number; inputTokens: number; toolOutputAllowance: number; reservedOutput: number } => (
  { estimator: 'doctor-offline-direct-context-v1', briefTokens: 0, inputTokens: 0, toolOutputAllowance: 0, reservedOutput: 0 }
);

/**
 * Dispatch eligibility from the actual offline dispatch resolver
 * (`resolveWorkerPlan`): called once per role for every group member
 * referencing this cli, never re-derived. A resolvable binding alone is not
 * reported as eligible — eligibility requires the resolver to actually place
 * at least one referencing member in its eligible/alternatives set. Refusals
 * are member-specific and name the resolver's own missing-evidence or policy
 * diagnostics.
 */
function resolveEligibilityFromDispatchResolver(
  resolverSnapshot: DirectWorkerResolverSnapshot,
  registry: ProviderModelCapabilityRegistry,
  cli: string,
  refs: MemberReference[],
): DirectWorkerEligibility {
  const snapshot: WorkerPlanSnapshot = {
    config: resolverSnapshot.config, models: resolverSnapshot.models, modelDigests: resolverSnapshot.modelDigests,
    catalog: resolverSnapshot.catalog, registry, installations: {},
  };
  const diagnostics = new Map<string, DirectWorkerDispatchDiagnostic>();
  const uncovered: string[] = [];
  for (const ref of refs) {
    if (!ref.enabled) continue;
    const matches = (tuple: { group: string; member: string }): boolean =>
      tuple.group === ref.groupId && tuple.member === ref.memberId;
    const seen: DirectWorkerDispatchDiagnostic[] = [];
    let eligibleHere = false;
    for (const role of ref.member.roles) {
      const plan = resolveWorkerPlan(snapshot, {
        role: role as 'efficiency' | 'coding' | 'reasoning', group: ref.groupId, member: ref.memberId,
        now: resolverSnapshot.now, context: offlineDirectContext(),
      });
      if ([plan.selected, ...plan.alternatives].some(tuple => tuple && matches(tuple))) { eligibleHere = true; break; }
      const exclusion = plan.exclusions.find(matches);
      for (const diagnostic of exclusion?.diagnostics ?? plan.diagnostics) {
        // Only an exact member pointer is generalized; other config pointers
        // remain distinct even when their diagnostic text happens to match.
        const memberPointer = `/parallelism/groups/${ref.groupId}/members/${ref.memberId}`;
        const pointer = diagnostic.pointer === memberPointer || diagnostic.pointer.startsWith(`${memberPointer}/`)
          ? `/parallelism/groups/${ref.groupId}/members${diagnostic.pointer.slice(memberPointer.length)}`
          : diagnostic.pointer;
        seen.push({ ...diagnostic, pointer, members: [`${ref.groupId}/${ref.memberId}`],
          roles: diagnostic.roles ?? [role] });
      }
    }
    if (eligibleHere) {
      return { eligibility: 'eligible',
        detail: `Dispatch resolver accepts cli '${cli}' for group '${ref.groupId}' member '${ref.memberId}'. `
          + `Dispatch eligibility: eligible. ${SMOKE_NOTE}` };
    }
    if (!seen.length) uncovered.push(`${ref.groupId}/${ref.memberId}`);
    for (const diagnostic of seen) {
      const key = JSON.stringify([diagnostic.code, diagnostic.pointer, diagnostic.message,
        diagnostic.blocking, diagnostic.origins]);
      const shared = diagnostics.get(key);
      if (shared) {
        shared.members = [...new Set([...shared.members, ...diagnostic.members])];
        shared.roles = [...new Set([...shared.roles, ...diagnostic.roles])];
      } else diagnostics.set(key, diagnostic);
    }
  }
  if (!diagnostics.size && !uncovered.length) {
    return { eligibility: 'blocked',
      detail: `Dispatch resolver has no enabled group member to evaluate for cli '${cli}'. `
        + `Dispatch eligibility: blocked. ${SMOKE_NOTE}` };
  }
  const distinct = [...diagnostics.values()];
  const reasons = distinct.map(diagnostic => `${diagnostic.code} ${diagnostic.pointer}: ${diagnostic.message}`
    + ` [roles: ${diagnostic.roles.join(', ')}; members: ${diagnostic.members.join(', ')}]`);
  if (uncovered.length) reasons.push(`No qualified route [members: ${uncovered.join(', ')}]`);
  return { eligibility: 'blocked', diagnostics: distinct,
    detail: `Dispatch resolver refuses cli '${cli}': ${reasons.join('; ')}. `
      + `Dispatch eligibility: blocked. ${SMOKE_NOTE}` };
}

/**
 * Binding-only fallback used only when the caller has not supplied a
 * `resolverSnapshot` (for example a direct unit-level call that never
 * resolved the wider model config/catalog). States plainly that this is a
 * binding-level result, not the dispatch resolver's verdict.
 */
function resolveEligibilityFromBindingOnly(
  parallelism: ParallelismConfig,
  registry: ProviderModelCapabilityRegistry,
  cli: string,
  installReady: boolean,
): DirectWorkerEligibility {
  try {
    const resolved = resolveWorkerGroupInstallation(parallelism, cli, registry);
    return { eligibility: 'eligible',
      detail: `Resolver accepts cli '${cli}' (binding '${resolved.installation.adapter}'). Dispatch eligibility: eligible at binding level only — `
        + `no resolver snapshot was supplied, so group/member qualification was not evaluated. `
        + `Launch additionally requires current installation evidence and model observation under the dispatch resolver's gates. `
        + `${SMOKE_NOTE}` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const readyNote = installReady
      ? ' The CLI is installed with an in-range version, but dispatch stays refused for the reason above; '
        + `an authenticated smoke run (see #3005) alone does not satisfy the resolver gates. ${SMOKE_NOTE}`
      : ` ${SMOKE_NOTE}`;
    return { eligibility: 'blocked',
      detail: `Resolver refuses cli '${cli}': ${reason}. Dispatch eligibility: blocked.${readyNote}` };
  }
}

function checkDispatchEligibility(
  parallelism: ParallelismConfig,
  registry: ProviderModelCapabilityRegistry,
  cli: string,
  installReady: boolean,
  resolverSnapshot: DirectWorkerResolverSnapshot | undefined,
  refs: MemberReference[],
): DirectWorkerEligibility {
  if (resolverSnapshot && refs.length) return resolveEligibilityFromDispatchResolver(resolverSnapshot, registry, cli, refs);
  return resolveEligibilityFromBindingOnly(parallelism, registry, cli, installReady);
}

/**
 * Read-only readiness for every configured worker. Starts no process unless
 * `probe` is supplied; without a prober each cli gets a config-only install
 * finding plus its resolver eligibility. Never claims a profile is
 * "qualified". Considers every explicit `parallelism.clis` entry plus any
 * cli id a group member references implicitly (no explicit installation
 * entry, canonical default binding).
 */
export async function diagnoseDirectWorkerReadiness(input: {
  parallelism: ParallelismConfig;
  registry: ProviderModelCapabilityRegistry;
  probe?: DirectWorkerProber;
  announce?: DirectWorkerAnnounce;
  timeoutMs?: number;
  probeCwd?: string;
  configFile?: string;
  projectRoot?: string;
  cli?: string;
  resolverSnapshot?: DirectWorkerResolverSnapshot;
}): Promise<DirectWorkerReadinessReport> {
  const { parallelism, registry, probe, announce, timeoutMs = workerVersionProbeDefaults.timeoutMs,
    probeCwd = tmpdir(), configFile = '.aiwg/aiwg.config', projectRoot = process.cwd(), resolverSnapshot } = input;
  const report: DirectWorkerReadinessReport = {
    enabled: parallelism.worker_dispatch === true,
    workersConfigured: allConfiguredCliIds(parallelism, input.cli).length > 0,
    ready: true,
    findings: [],
  };
  if (!report.enabled) {
    report.findings.push({ cli: '*', kind: 'dispatch', profile: null, executable: null, installedVersion: null,
      status: 'info', code: 'WORKER_DIRECT_DISABLED',
      message: `Group dispatch is disabled (config ${configFile} key /parallelism/worker_dispatch); install/version checks do not apply and onboarding cannot proceed.`,
      nextAction: 'enable-worker-dispatch-to-onboard',
      configFile, configKey: '/parallelism/worker_dispatch',
      readiness: null, eligibility: 'blocked',
      eligibilityDetail: 'Dispatch eligibility: blocked — group dispatch is disabled.',
      members: [] });
    return report;
  }
  const cliIds = allConfiguredCliIds(parallelism, input.cli);
  if (!cliIds.length) {
    // No workers configured: no findings at all so doctor stays silent.
    return report;
  }
  const pushInstall = (finding: Omit<DirectWorkerReadinessFinding, 'kind' | 'eligibility' | 'eligibilityDetail'>): void => {
    report.findings.push({ ...finding, kind: 'install', eligibility: null, eligibilityDetail: null });
    if (finding.status === 'error' || finding.status === 'warn') report.ready = false;
  };
  const pushDispatch = (cli: string, profile: string | null, status: 'ok' | 'info' | 'warn',
    code: string, eligibility: DirectWorkerDispatchEligibility, detail: string, configKey: string,
    members: string[], nextAction: string, diagnostics?: DirectWorkerDispatchDiagnostic[]): void => {
    report.findings.push({ cli, kind: 'dispatch', profile, executable: null, installedVersion: null,
      status, code, message: `${detail} (config ${configFile} key ${configKey}; ${describeConfigContext(members)})`,
      nextAction, configFile, configKey,
      readiness: null, eligibility, eligibilityDetail: detail, members, ...(diagnostics ? { diagnostics } : {}) });
  };
  await Promise.all(cliIds.map(async cli => {
    const configured = parallelism.clis?.[cli];
    const refs = memberReferences(parallelism, cli);
    const members = memberLabels(refs);
    const required = isCliRequired(parallelism, cli);
    const configKey = `/parallelism/clis/${cli}`;
    if (configured?.enabled === false) {
      pushInstall({ cli, profile: configured.invocationProfile ?? null,
        executable: configured.executable ?? null, installedVersion: null,
        status: 'info', code: 'WORKER_DIRECT_CLI_DISABLED',
        message: `Dispatch is disabled for cli '${cli}' (config ${configFile} key ${configKey}/enabled); the version probe was skipped. Installation readiness: skipped. (${describeConfigContext(members)})`,
        nextAction: 'enable-cli-to-onboard',
        configFile, configKey, readiness: 'skipped', members });
      const { eligibility, detail, diagnostics } = checkDispatchEligibility(parallelism, registry, cli, false, resolverSnapshot, refs);
      pushDispatch(cli, configured.invocationProfile ?? null, 'info', 'WORKER_DIRECT_DISPATCH_BLOCKED',
        eligibility, detail, configKey, members, 'enable-cli-to-onboard', diagnostics);
      return;
    }
    const resolved = resolveDirectBinding(registry, configured?.adapter, cli);
    if ('error' in resolved) {
      pushInstall({ cli, profile: configured?.invocationProfile ?? null, executable: null, installedVersion: null,
        status: advisoryStatus(probe ? 'error' : 'warn', required), code: 'WORKER_DIRECT_NO_PROFILE',
        message: `${resolved.error} (config ${configFile} key ${configKey}/adapter); the profile cannot be onboarded. Installation readiness: not-ready. (${describeConfigContext(members)})`,
        nextAction: 'review-worker-configuration',
        configFile, configKey: `${configKey}/adapter`, readiness: 'not-ready', members });
      const { eligibility, detail, diagnostics } = checkDispatchEligibility(parallelism, registry, cli, false, resolverSnapshot, refs);
      pushDispatch(cli, configured?.invocationProfile ?? null, 'warn', 'WORKER_DIRECT_DISPATCH_BLOCKED',
        eligibility, detail, configKey, members, 'review-worker-configuration', diagnostics);
      return;
    }
    const { adapter, adapterRef } = resolved;
    if (adapter.invocation.kind !== 'process') {
      pushInstall({ cli, profile: null, executable: null, installedVersion: null,
        status: 'info', code: 'WORKER_DIRECT_HTTP',
        message: `Cli '${cli}' binds '${adapterRef}' (config ${configFile} key ${configKey}/adapter), which uses an HTTP adapter; there is no CLI version probe — check endpoint health instead. Installation readiness: skipped. (${describeConfigContext(members)})`,
        nextAction: 'check-endpoint-health',
        configFile, configKey, readiness: 'skipped', members });
      const { eligibility, detail, diagnostics } = checkDispatchEligibility(parallelism, registry, cli, false, resolverSnapshot, refs);
      pushDispatch(cli, null, eligibility === 'eligible' ? 'ok' : 'warn',
        eligibility === 'eligible' ? 'WORKER_DIRECT_DISPATCH_ELIGIBLE' : 'WORKER_DIRECT_DISPATCH_BLOCKED',
        eligibility, detail, configKey, members,
        eligibility === 'eligible' ? 'check-endpoint-health' : 'review-worker-configuration', diagnostics);
      return;
    }
    const profileIds = Object.keys(adapter.invocationProfiles ?? {});
    const profileRef = configured?.invocationProfile
      ?? (profileIds.length === 1 ? profileIds[0] : undefined);
    if (!profileRef || !adapter.invocationProfiles?.[profileRef]) {
      pushInstall({ cli, profile: configured?.invocationProfile ?? null,
        executable: null, installedVersion: null,
        status: advisoryStatus('error', required), code: 'WORKER_DIRECT_PROFILE_UNKNOWN',
        message: configured?.invocationProfile
          ? `Configured invocation profile '${configured.invocationProfile}' is not registered for binding '${adapterRef}' (config ${configFile} key ${configKey}/invocationProfile). Installation readiness: not-ready. (${describeConfigContext(members)})`
          : `Cli '${cli}' binding '${adapterRef}' has no single direct profile to check (config ${configFile} key ${configKey}); configure invocationProfile explicitly. Installation readiness: not-ready. (${describeConfigContext(members)})`,
        nextAction: 'review-worker-configuration',
        configFile, configKey, readiness: 'not-ready', members });
      const { eligibility, detail, diagnostics } = checkDispatchEligibility(parallelism, registry, cli, false, resolverSnapshot, refs);
      pushDispatch(cli, configured?.invocationProfile ?? null, 'warn', 'WORKER_DIRECT_DISPATCH_BLOCKED',
        eligibility, detail, configKey, members, 'review-worker-configuration', diagnostics);
      return;
    }
    const profile = adapter.invocationProfiles[profileRef];
    const executable = resolveDirectWorkerExecutablePath(configured?.executable ?? adapter.invocation.executable, projectRoot);
    if (!probe) {
      pushInstall({ cli, profile: profileRef, executable, installedVersion: null,
        status: 'info', code: 'WORKER_DIRECT_UNPROBED',
        message: `Cli '${cli}' binds '${adapterRef}' profile '${profileRef}' (config ${configFile} key ${configKey}); version probe not run — no subprocess was started. Installation readiness: unprobed. Rerun with probes to check install/version. (${describeConfigContext(members)})`,
        nextAction: 'rerun-with-probe-workers',
        configFile, configKey, readiness: 'unprobed', members });
      const { eligibility, detail, diagnostics } = checkDispatchEligibility(parallelism, registry, cli, false, resolverSnapshot, refs);
      pushDispatch(cli, profileRef, eligibility === 'eligible' ? 'ok' : 'warn',
        eligibility === 'eligible' ? 'WORKER_DIRECT_DISPATCH_ELIGIBLE' : 'WORKER_DIRECT_DISPATCH_BLOCKED',
        eligibility, detail, configKey, members,
        eligibility === 'eligible' ? 'rerun-with-probe-workers' : 'review-worker-configuration', diagnostics);
      return;
    }
    announce?.(cli, executable, adapter.invocation.versionArgv);
    let outcome: DirectWorkerProbeOutcome;
    try {
      outcome = await probe(executable, adapter.invocation.versionArgv, { timeoutMs, cwd: probeCwd });
    } catch {
      outcome = { ok: false, reason: 'probe-failed' };
    }
    if (!outcome.ok) {
      const notInstalled = outcome.reason === 'not-installed';
      pushInstall({ cli, profile: profileRef, executable, installedVersion: null,
        status: advisoryStatus(notInstalled ? 'error' : 'warn', required),
        code: notInstalled ? 'WORKER_DIRECT_NOT_INSTALLED' : 'WORKER_DIRECT_PROBE_FAILED',
        message: notInstalled
          ? `CLI '${executable}' is not installed (version probe failed to start; config ${configFile} key ${configKey}/executable); install it before onboarding cli '${cli}'. Installation readiness: not-ready. (${describeConfigContext(members)})`
          : `Version probe for cli '${cli}' ('${executable}', config ${configFile} key ${configKey}) failed; retry once, then check PATH and execute permission. Installation readiness: not-ready. (${describeConfigContext(members)})`,
        nextAction: notInstalled ? 'install-cli' : 'retry-version-probe',
        configFile, configKey, readiness: 'not-ready', members });
      const { eligibility, detail, diagnostics } = checkDispatchEligibility(parallelism, registry, cli, false, resolverSnapshot, refs);
      pushDispatch(cli, profileRef, 'warn', 'WORKER_DIRECT_DISPATCH_BLOCKED',
        eligibility, detail, configKey, members, notInstalled ? 'install-cli' : 'retry-version-probe', diagnostics);
      return;
    }
    const rawBanner = outcome.rawBanner.trim();
    let installedVersion: string;
    try {
      installedVersion = normalizeWorkerVersionBanner(rawBanner, adapter.invocation.versionPattern);
    } catch {
      pushInstall({ cli, profile: profileRef, executable, installedVersion: null,
        status: advisoryStatus('error', required), code: 'WORKER_DIRECT_BANNER_UNMATCHED',
        message: `CLI '${executable}' banner ${JSON.stringify(truncateBanner(rawBanner))} does not match the registered version pattern (config ${configFile} key ${configKey}); the install is unexpected — reinstall a supported release. Installation readiness: not-ready. (${describeConfigContext(members)})`,
        nextAction: 'reinstall-supported-cli',
        configFile, configKey, readiness: 'not-ready', members });
      const { eligibility, detail, diagnostics } = checkDispatchEligibility(parallelism, registry, cli, false, resolverSnapshot, refs);
      pushDispatch(cli, profileRef, 'warn', 'WORKER_DIRECT_DISPATCH_BLOCKED',
        eligibility, detail, configKey, members, 'reinstall-supported-cli', diagnostics);
      return;
    }
    const mismatch = workerVersionRangeMismatch(installedVersion, [profile.supportedVersions, adapter.supportedVersions]);
    if (mismatch) {
      pushInstall({ cli, profile: profileRef, executable, installedVersion,
        status: advisoryStatus('warn', required), code: 'WORKER_DIRECT_VERSION_OUT_OF_RANGE',
        message: `CLI '${executable}' version ${installedVersion} is outside supported range '${mismatch}' for cli '${cli}' (profile '${profileRef}', config ${configFile} key ${configKey}); upgrade or pin a supported release. Installation readiness: not-ready. (${describeConfigContext(members)})`,
        nextAction: 'upgrade-or-pin-cli',
        configFile, configKey, readiness: 'not-ready', members });
      const { eligibility, detail, diagnostics } = checkDispatchEligibility(parallelism, registry, cli, false, resolverSnapshot, refs);
      pushDispatch(cli, profileRef, 'warn', 'WORKER_DIRECT_DISPATCH_BLOCKED',
        eligibility, detail, configKey, members, 'upgrade-or-pin-cli', diagnostics);
      return;
    }
    pushInstall({ cli, profile: profileRef, executable, installedVersion,
      status: 'ok', code: 'WORKER_DIRECT_READY',
      message: `CLI '${executable}' version ${installedVersion} matches profile '${profileRef}' for cli '${cli}' (config ${configFile} key ${configKey}). Installation readiness: ready. ${SMOKE_NOTE} See the dispatch finding for whether the resolver would dispatch. (${describeConfigContext(members)})`,
      nextAction: 'qualify-installed-cli',
      configFile, configKey, readiness: 'ready', members });
    const { eligibility, detail, diagnostics } = checkDispatchEligibility(parallelism, registry, cli, true, resolverSnapshot, refs);
    pushDispatch(cli, profileRef, eligibility === 'eligible' ? 'ok' : 'warn',
      eligibility === 'eligible' ? 'WORKER_DIRECT_DISPATCH_ELIGIBLE' : 'WORKER_DIRECT_DISPATCH_BLOCKED',
      eligibility, detail, configKey, members, 'qualify-installed-cli', diagnostics);
  }));
  report.findings.sort((a, b) => a.cli.localeCompare(b.cli) || a.kind.localeCompare(b.kind));
  return report;
}

export interface DirectWorkerDoctorLine {
  name: string;
  status: 'ok' | 'info' | 'warn' | 'error';
  message: string;
}

/**
 * Doctor wiring for the direct-worker section. With `probeWorkers` false this
 * is config-only and starts no process; with true it runs the shared bounded
 * probes, announcing each resolved executable through `announce` (if
 * supplied) immediately before it is spawned — never a worker launch, model
 * call or mutation, and never buffered behind the rest of the report. No
 * workers configured (explicitly or implicitly through a group member) means
 * no lines at all, so doctor output and exit code are unchanged there.
 *
 * `installFindings` carries the structured per-cli installation findings
 * (`kind === 'install'`, one per configured cli, untruncated) backing
 * `lines`, so machine-readable surfaces (`aiwg doctor --probe-workers
 * --json`) can render one record per CLI without re-running the probes.
 *
 * Trust boundary: with `probeWorkers: true`, every probed executable is
 * exactly the one named by project configuration (or the registry default)
 * run with only its registered version arguments — opting in trusts that
 * executable; a version probe cannot prove the program has no side effects.
 */
export async function buildDirectWorkerDoctorSection(input: {
  parallelism: ParallelismConfig | undefined | null;
  registry: ProviderModelCapabilityRegistry;
  probeWorkers: boolean;
  probe?: DirectWorkerProber;
  announce?: DirectWorkerAnnounce;
  configFile?: string;
  projectRoot?: string;
  cli?: string;
  resolverSnapshot?: DirectWorkerResolverSnapshot;
}): Promise<{ lines: DirectWorkerDoctorLine[]; probed: boolean; workersConfigured: boolean; installFindings: DirectWorkerReadinessFinding[] }> {
  const { parallelism, registry, probeWorkers } = input;
  const cliIds = allConfiguredCliIds(parallelism ?? {}, input.cli);
  if (!cliIds.length) return { lines: [], probed: false, workersConfigured: false, installFindings: [] };
  const lines: DirectWorkerDoctorLine[] = [];
  if (probeWorkers) {
    lines.push({ name: 'Direct Worker Probes', status: 'info',
      message: 'probe execution is opt-in (--probe-workers): running bounded `<executable> ...versionArgv` probes with a cleared environment and explicit cwd (no worker launch, no model call, no mutation). Trust boundary: each probe runs exactly the executable named by project configuration with only its version arguments — a version probe cannot prove that executable is side-effect free.' });
  } else {
    lines.push({ name: 'Direct Worker', status: 'info',
      message: 'direct-worker configuration only: no subprocess was started. Rerun with --probe-workers to run the bounded version probes' });
  }
  const report = await diagnoseDirectWorkerReadiness({
    parallelism: parallelism as ParallelismConfig,
    registry,
    cli: input.cli,
    ...(probeWorkers ? { probe: input.probe ?? probeDirectWorkerVersion, ...(input.announce ? { announce: input.announce } : {}) } : {}),
    ...(input.configFile ? { configFile: input.configFile } : {}),
    ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
    ...(input.resolverSnapshot ? { resolverSnapshot: input.resolverSnapshot } : {}),
  });
  for (const finding of report.findings.slice(0, 15)) {
    const name = finding.cli === '*' ? 'Direct Worker'
      : finding.kind === 'dispatch' ? `Direct Worker Dispatch (${finding.cli})` : `Direct Worker (${finding.cli})`;
    lines.push({ name, status: finding.status, message: `${finding.code}: ${finding.message} [next: ${finding.nextAction}]` });
  }
  if (report.findings.length > 15) {
    lines.push({ name: 'Direct Worker', status: 'warn',
      message: `${report.findings.length - 15} additional findings; narrow the cli set in parallelism.clis` });
  }
  if (probeWorkers && !report.findings.some(finding => finding.code === 'WORKER_DIRECT_READY')) {
    lines.push({ name: 'Direct Worker', status: 'info',
      message: `no profile is onboarded; ${SMOKE_NOTE}` });
  }
  return {
    lines,
    probed: probeWorkers,
    workersConfigured: true,
    // Disabled dispatch skips probes but still needs one record per configured
    // CLI in machine-readable output. Keep the existing text findings intact.
    installFindings: report.enabled
      ? report.findings.filter(finding => finding.kind === 'install')
      : cliIds.map(cli => ({
        ...report.findings[0]!, cli, kind: 'install' as const,
        configKey: `/parallelism/clis/${cli}`, readiness: 'skipped' as const,
        eligibility: null, eligibilityDetail: null,
      })),
  };
}
