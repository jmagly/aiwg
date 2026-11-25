import { assertClaudeRootSelection, containsSource, selectedClaudeRoots } from './source-boundary.js';
import { recordDiscoveryProblem, unsupportedSource } from './discovery-problems.js';
import {
  access, mkdir, readFile, readdir, realpath, rename, stat, writeFile,
} from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { inspectMuseNativeWorkspace, type MuseWorkspaceInspection } from './adapters/muse.js';
import { readOmpSessionHeader } from './adapters/omp.js';
import { grokbotConversationIdFromLocator } from './adapters/grokbot-locator.js';
import {
  GROK_BUILD_ACTIVE_FRESHNESS_MS,
  grokBuildLiveState, grokBuildNativeAvailability,
  grokBuildSourceWorkspaceMatch,
  readGrokBuildActiveRegistry,
  type GrokBuildActiveRegistry,
  type GrokBuildLiveEvidence,
} from './adapters/grok-build-native.js';
import { hermesSnapshotStagingDir } from './adapters/hermes-state-db.js';
import { resolveOmpPaths } from '../providers/omp-paths.mjs';
import { readAiwgConfig } from '../config/aiwg-config.js';
import {
  SessionCoveragePreflightSchema,
  SessionContractError,
  type SessionCoveragePreflight,
  type SessionRuntimeIdentity,
  sha256,
  type AuthorizedScope,
  type SessionProviderId,
  type SourceDescriptor,
} from './contracts.js';
import { redactSourceLocator, type SessionSourceAdapterRegistry } from './discovery.js';
import { createSessionAdapterRegistry } from './adapter-registry.js';
import { coveragePreflight, providerScopeWarnings, resolveSessionProviderScope } from './coverage-preflight.js';
import { fingerprintSourceFile, streamJsonLines } from './readers.js';
import { matchSessionWorkspace, type WorkspaceMatchKind } from './workspace-matching.js';
import { matchImportExclusion, nativeSessionIdFromLocator, resolveImportExclusions, type SourceExclusion } from './import-exclusions.js';

export const DISCOVERY_MANIFEST_VERSION = '1.0.0' as const;

export type DiscoveryProviderStatus =
  | 'checked'
  | 'unavailable'
  | 'export-required'
  | 'not-checked';

export interface GrokBuildSourceLiveEvidence extends GrokBuildLiveEvidence {
  observedAt: string;
  expiresAt: string | null;
}

export interface DiscoveryManifestSource {
  sourceId: string;
  provider: SessionProviderId;
  locator: string;
  redactedLocator: string;
  locatorClass: string;
  authorizedRoot: string;
  modifiedAt: string;
  sizeBytes: number;
  digest: string;
  nativeSessionId?: string;
  status?: 'excluded' | 'unsupported' | 'unreadable';
  exclusion?: SourceExclusion;
  /** Advisory provider-reported activity; excluded from the manifest identity hash. */
  liveEvidence?: GrokBuildSourceLiveEvidence;
}

export interface DiscoveryProviderReport {
  provider: string;
  status: DiscoveryProviderStatus;
  disposition: 'discoverable' | 'manual-export' | 'unsupported';
  sourceCount: number;
  matchedBySubfolder?: number;
  matchedByWorktree?: number;
  dateRange: { earliest: string | null; latest: string | null };
  dateRangeBasis: 'source-mtime';
  reasonCode: string | null;
  remediation: string | null;
  rootCounts?: Array<{
    root: string;
    rootId: string;
    status: 'checked' | 'unavailable';
    sourceCount: number;
    duplicateCount: number;
  }>;
  museSourceInspections?: Array<MuseWorkspaceInspection & {
    sourceKey: string;
    redactedLocator: string;
    nativeSessionId?: string;
  }>;
}

export interface SessionDiscoveryManifest {
  schemaVersion: typeof DISCOVERY_MANIFEST_VERSION;
  manifestId: string;
  createdAt: string;
  workspaceId: string;
  workspacePath: string;
  preflight?: SessionCoveragePreflight;
  /** Exact canonical roots authorized by the discovery invocation. */
  authorizedRoots?: Partial<Record<SessionProviderId, string[]>>;
  providers: DiscoveryProviderReport[];
  sources: DiscoveryManifestSource[];
}

export interface DiscoverWorkspaceOptions {
  workspace: string;
  exclude?: string[];
  knownSources?: readonly DiscoveryManifestSource[];
  /** Re-derive maintenance scope from config while retaining saved root grants. */
  refreshFrom?: SessionDiscoveryManifest;
  /** Logical paths to the same canonical workspace, used for provider project keys. */
  workspaceAliases?: readonly string[];
  expectedProviders?: readonly string[];
  registry?: SessionSourceAdapterRegistry;
  runtime?: SessionRuntimeIdentity;
  providerHome?: string;
  operatorHome?: string;
  claudeProjectDirs?: readonly string[];
  codexRoot?: string;
  codexRoots?: readonly string[];
  ompRoot?: string;
  museRoot?: string;
  dshRoot?: string;
  grokbotRoot?: string;
  grokRoot?: string;
  grokActiveSessions?: string;
  hermesRoot?: string;
  createdAt?: string;
  /** Restrict maintenance discovery to previously authorized roots, with no defaults. */
  authorizedRoots?: Partial<Record<SessionProviderId, string[]>>;
}

interface DiscoverableProvider {
  provider: 'claude' | 'codex' | 'cursor' | 'factory' | 'pi' | 'omp' | 'deepseek-harness' | 'muse' | 'grokbot' | 'grok-build' | 'hermes';
  roots: string[];
}

const MANUAL_EXPORT_PROVIDERS = new Set<SessionProviderId>([
  'copilot', 'opencode', 'openclaw', 'openhuman',
  'warp', 'devin-desktop', 'generic', 'grok-build',
]);

export async function discoverWorkspaceHistories(
  options: DiscoverWorkspaceOptions,
): Promise<SessionDiscoveryManifest> {
  const registry = options.registry ?? createSessionAdapterRegistry();
  const exclusions = resolveImportExclusions(undefined, options.exclude);
  const supportedProviders = new Set(registry.list().map((adapter) => adapter.provider));
  const workspacePath = await canonicalPath(options.workspace);
  const config = await readAiwgConfig(workspacePath);
  const configuredProviders = config?.providers ?? [];
  const claudeRoots = await selectedClaudeRoots(options.claudeProjectDirs);
  const explicitlyRootedProviders = [
    ...(claudeRoots ? ['claude'] : []),
    ...(options.codexRoot || options.codexRoots?.length || config?.sessions?.codex_roots?.length ? ['codex'] : []),
    ...(options.ompRoot ? ['omp'] : []),
    ...(options.museRoot ? ['muse'] : []),
    ...(options.dshRoot ? ['deepseek-harness'] : []),
    ...(options.grokbotRoot ? ['grokbot'] : []),
    ...(options.grokRoot ? ['grok-build'] : []),
    ...(options.hermesRoot ? ['hermes'] : []),
  ];
  const savedRoots = options.authorizedRoots ?? options.refreshFrom?.authorizedRoots;
  if (claudeRoots && savedRoots) assertClaudeRootSelection(claudeRoots, savedRoots.claude ?? []);
  const authorizedProviders = options.refreshFrom
    ? Object.keys(savedRoots ?? {}).filter(provider => savedRoots?.[provider as SessionProviderId]?.length)
    : configuredProviders.length ? explicitlyRootedProviders : undefined;
  const providerScope = resolveSessionProviderScope(configuredProviders, options.expectedProviders, authorizedProviders);
  if (options.refreshFrom) {
    providerScope.scopeWarnings = providerScopeWarnings(configuredProviders, options.refreshFrom.preflight?.expectedProviders ?? []);
  }
  const { expectedProviders } = providerScope;
  const workspaceId = workspacePath;
  const workspacePaths = [...new Set([workspacePath, resolve(options.workspace),
    ...(options.workspaceAliases ?? []).map((alias) => resolve(alias))])];
  for (const alias of workspacePaths) {
    if (await canonicalPath(alias) !== workspacePath) {
      throw new SessionContractError('INVALID_ARGUMENT', 'workspace alias resolves to a different workspace');
    }
  }
  const providerHomes = providerHomeCandidates(options.providerHome, options.operatorHome);
  const discoverable: DiscoverableProvider[] = [
    { provider: 'deepseek-harness', roots: options.dshRoot
      ? [resolve(options.dshRoot)] : options.providerHome
        ? [join(resolve(options.providerHome), '.dsh', 'sessions')] : [] },
    { provider: 'omp', roots: options.ompRoot
      ? [resolve(options.ompRoot)] : options.providerHome
        ? [resolveOmpPaths({ home: resolve(options.providerHome), cwd: workspacePath }).sessionsDir] : [] },
    { provider: 'muse', roots: options.museRoot
      ? [resolve(options.museRoot)] : [] },
    // Grok Bot conversations carry no workspace/cwd field, so unlike
    // claude/cursor/factory there is no per-workspace default path to derive
    // from providerHome. Native discovery requires an explicit
    // --grokbot-root (same shared-root authorization model as
    // codex/omp/deepseek-harness/muse below), and every authorized
    // conversation surfaces to whichever workspace runs discovery (same
    // no-filtering behavior already used for `pi`/`deepseek-harness`).
    { provider: 'grokbot', roots: options.grokbotRoot
      ? [resolve(options.grokbotRoot)] : [] },
    // Grok Build authorizes the sessions directory itself, never Grok home:
    // `<root>/<url-encoded cwd>/<id>/chat_history.jsonl`. No fallback through
    // $HOME, GROK_HOME, or --provider-home grants access.
    { provider: 'grok-build', roots: options.grokRoot
      ? [resolve(options.grokRoot)] : [] },
    // Hermes authorizes `<root>/state.db` for a read-only backup snapshot.
    // Staging joins the scope below; nothing else under the root is read.
    { provider: 'hermes', roots: options.hermesRoot
      ? [resolve(options.hermesRoot)] : [] },
    {
      provider: 'claude',
      // Same scope rule as codex: configured providers keep their root grant
      // even when a narrow discovery does not scan them (#3402).
      roots: savedRoots || (!expectedProviders.includes('claude') && !providerScope.configuredProviders?.includes('claude'))
        ? [] : claudeRoots ?? await claudeDiscoveryRoots(providerHomes, workspacePaths, workspacePath, registry, exclusions),
    },
    {
      provider: 'codex',
      roots: savedRoots || (!expectedProviders.includes('codex') && !providerScope.configuredProviders?.includes('codex')
        && !explicitlyRootedProviders.includes('codex'))
        ? [] : await codexDiscoveryRoots({ ...options, codexRoots: [
          ...(config?.sessions?.codex_roots ?? []).map(root => resolve(workspacePath, root)),
          ...(options.codexRoots ?? []),
        ] }),
    },
    {
      provider: 'cursor',
      roots: providerHomes.flatMap((providerHome) => workspacePaths.map(
        (workspace) => join(providerHome, '.cursor', 'projects', workspaceKey(workspace, false), 'agent-transcripts'),
      )),
    },
    {
      provider: 'factory',
      roots: providerHomes.flatMap((providerHome) => workspacePaths.flatMap((workspace) => [
        join(providerHome, '.factory', 'projects', workspaceKey(workspace, true)),
        join(providerHome, '.factory', 'sessions', workspaceKey(workspace, true)),
      ])),
    },
    {
      // Pi stores every working directory's sessions in its own
      // subdirectory of the sessions root, named `--<path>--` where
      // `<path>` has its leading separator removed and `/`, `\`, and `:`
      // replaced with `-` (https://pi.dev/docs/latest/session-format,
      // "File Location", verified 2026-10-12) — the same transform
      // `workspaceKey(path, false)` already applies for Cursor below.
      // Scanning the whole sessions root (as before) would import every
      // other workspace's history into this one's catalog (#2656).
      provider: 'pi',
      roots: (process.env.PI_CODING_AGENT_SESSION_DIR
        ? [resolve(process.env.PI_CODING_AGENT_SESSION_DIR)]
        : providerHomes.map(
          (providerHome) => join(providerHome, '.pi', 'agent', 'sessions'),
        )
      ).flatMap((sessionsRoot) => workspacePaths.map(
        (workspace) => join(sessionsRoot, `--${workspaceKey(workspace, false)}--`),
      )),
    },
  ];

  const authorizedRoots: Partial<Record<SessionProviderId, string[]>> = { ...savedRoots };
  const reports = new Map<string, DiscoveryProviderReport>();
  const candidates: DiscoveryManifestSource[] = [];
  const seen = new Set<string>();
  for (const entry of discoverable) {
    // A hand-run narrow scope must not discard explicit root grants, including
    // configured providers under an authorized home. Do not scan their histories.
    if (!savedRoots && !expectedProviders.includes(entry.provider)
      && (explicitlyRootedProviders.includes(entry.provider)
        || (providerScope.configuredProviders?.includes(entry.provider) && options.providerHome))) {
      const roots: string[] = [];
      for (const root of entry.roots) if (await pathExists(root)) roots.push(await canonicalPath(root));
      authorizedRoots[entry.provider] = [...new Set(roots)];
    }
    if (!expectedProviders.includes(entry.provider) || !supportedProviders.has(entry.provider)) continue;
    const adapter = registry.get(entry.provider);
    if (adapter.disposition === 'unsupported' || !adapter.supportedOperations.includes('discover')) continue;
    const availableRoots: string[] = [];
    const rootCounts = new Map<string, NonNullable<DiscoveryProviderReport['rootCounts']>[number]>();
    for (const root of savedRoots ? savedRoots[entry.provider] ?? [] : entry.roots) {
      if (await pathExists(root)) {
        const canonical = await canonicalPath(root);
        if (savedRoots && canonical !== root) {
          throw new SessionContractError('INVALID_ARGUMENT', 'previously authorized provider root changed; rediscover with explicit authorization');
        }
        if (!availableRoots.includes(canonical)) {
          availableRoots.push(canonical);
          rootCounts.set(canonical, {
            root: redactSourceLocator(canonical), rootId: sha256(canonical),
            status: 'checked', sourceCount: 0, duplicateCount: 0,
          });
        }
      } else {
        rootCounts.set(root, {
          root: redactSourceLocator(root), rootId: sha256(root),
          status: 'unavailable', sourceCount: 0, duplicateCount: 0,
        });
      }
    }
    if (availableRoots.length === 0) {
      const needsExplicitRoot = (entry.provider === 'codex' || entry.provider === 'omp'
        || entry.provider === 'deepseek-harness' || entry.provider === 'muse'
        || entry.provider === 'grokbot' || entry.provider === 'grok-build'
        || entry.provider === 'hermes')
        && entry.roots.length === 0;
      const expectedFlag = entry.provider === 'deepseek-harness' ? 'dsh' : entry.provider === 'grok-build' ? 'grok' : entry.provider;
      const rootKind = entry.provider === 'hermes' ? 'Hermes home (state.db is snapshotted read-only)' : 'sessions root';
      reports.set(entry.provider, providerReport(
        entry.provider,
        needsExplicitRoot ? 'export-required' : 'unavailable',
        needsExplicitRoot ? 'manual-export' : 'discoverable',
        [],
        needsExplicitRoot
          ? 'SHARED_ROOT_AUTHORIZATION_REQUIRED'
          : 'PROVIDER_ROOT_UNAVAILABLE',
        needsExplicitRoot
          ? `Pass --${expectedFlag}-root with an explicitly authorized ${rootKind}.`
          : `No authorized ${entry.provider} workspace history root was found.`,
      ));
      if (entry.provider === 'codex') reports.get(entry.provider)!.rootCounts = [...rootCounts.values()];
      continue;
    }
    authorizedRoots[entry.provider] = availableRoots;
    const scope: AuthorizedScope = {
      workspaceId,
      allowedRoots: availableRoots,
    };
    if (entry.provider === 'hermes') {
      // The consistent snapshot is staged under owned workspace staging (the
      // provider home stays read-only); staged locators need scope cover, and
      // refresh must retain both the origin grant and the staging grant.
      const staging = hermesSnapshotStagingDir(workspacePath);
      if (!scope.allowedRoots.includes(staging)) scope.allowedRoots.push(staging);
      authorizedRoots[entry.provider] = [...new Set([...availableRoots, staging])];
      if (!rootCounts.has(staging)) {
        rootCounts.set(staging, {
          root: redactSourceLocator(staging), rootId: sha256(staging),
          status: 'checked', sourceCount: 0, duplicateCount: 0,
        });
      }
    }
    const providerSources: DiscoveryManifestSource[] = [];
    let matchedBySubfolder = 0;
    let matchedByWorktree = 0;
    const museSourceInspections: NonNullable<DiscoveryProviderReport['museSourceInspections']> = [];
    // Grok Build live detection reads exactly one explicitly authorized file
    // (never the sessions root's parent implicitly); absence means unknown.
    let grokActiveRegistry: GrokBuildActiveRegistry | null = null;
    let grokActiveRegistryLoaded = false;
    const grokActiveEvidence = async (): Promise<GrokBuildActiveRegistry | null> => {
      if (grokActiveRegistryLoaded || entry.provider !== 'grok-build' || !options.grokActiveSessions) return grokActiveRegistry;
      grokActiveRegistryLoaded = true;
      try {
        grokActiveRegistry = await readGrokBuildActiveRegistry(
          resolve(options.grokActiveSessions),
          [resolve(options.grokActiveSessions)].map((file) => dirname(file)),
        );
      } catch {
        grokActiveRegistry = null;
      }
      return grokActiveRegistry;
    };
    for await (const descriptor of adapter.discover(scope)) {
      const known = options.knownSources?.find(source => source.provider === descriptor.provider && source.locator === descriptor.locator);
      // A Hermes projection holds many sessions, so its locator basename is
      // never a session identity.
      const nativeSessionId = entry.provider === 'hermes'
        ? (known?.nativeSessionId ?? descriptor.nativeSessionId)
        : (known?.nativeSessionId ?? descriptor.nativeSessionId ?? nativeSessionIdFromLocator(descriptor));
      const exclusion = matchImportExclusion({ ...descriptor, nativeSessionId }, exclusions);
      if (exclusion) {
        const locator = resolve(descriptor.locator);
        const authorizedRoot = scope.allowedRoots.find(root => containsSource(root, locator));
        if (!authorizedRoot) continue;
        const key = `excluded\0${entry.provider}\0${locator}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const source: DiscoveryManifestSource = {
          sourceId: known?.sourceId ?? sha256(key), provider: entry.provider,
          locator, redactedLocator: redactSourceLocator(locator), locatorClass: descriptor.locatorClass,
          authorizedRoot, modifiedAt: '', sizeBytes: 0, digest: '', nativeSessionId,
          status: 'excluded', exclusion,
        };
        rootCounts.get(authorizedRoot)!.sourceCount += 1;
        providerSources.push(source);
        candidates.push(source);
        continue;
      }
      if (unsupportedSource(descriptor)) {
        recordDiscoveryProblem(descriptor, scope.allowedRoots, 'unsupported', providerSources, candidates); continue;
      }
      try {
      let workspaceMatch: WorkspaceMatchKind | null = null;
      if (entry.provider === 'muse') {
        const inspection = await inspectMuseNativeWorkspace({
          ...descriptor,
          sourceId: 'discovery',
          authorizedScope: scope,
        }, workspacePath);
        museSourceInspections.push({
          sourceKey: sha256(['muse-workspace-inspection-v1', descriptor.locator].join('\0')),
          redactedLocator: redactSourceLocator(descriptor.locator),
          nativeSessionId: basename(dirname(descriptor.locator)),
          ...inspection,
        });
        if (inspection.outcome !== 'matched') continue;
        workspaceMatch = inspection.matchKind ?? null;
      }
      const locator = await canonicalPath(descriptor.locator);
      if (entry.provider === 'codex') {
        workspaceMatch = await codexSourceWorkspaceMatch(locator, workspacePath);
        if (!workspaceMatch) continue;
      }
      if (entry.provider === 'grok-build') {
        // The url-encoded cwd directory is the only workspace evidence; an
        // unresolvable or conflicting value never attaches to the caller.
        workspaceMatch = await grokBuildSourceWorkspaceMatch(locator, workspacePath);
        if (!workspaceMatch) continue;
      }
      const ompHeader = entry.provider === 'omp' ? await readOmpSessionHeader({ ...descriptor, sourceId: 'discovery', authorizedScope: scope }) : undefined;
      if (ompHeader) {
        workspaceMatch = await matchSessionWorkspace(ompHeader.cwd, workspacePath);
        if (!workspaceMatch) continue;
      }
      const details = await stat(locator);
      const authorizedRoot = scope.allowedRoots.find(
        (root) => containsSource(root, locator),
      );
      if (!authorizedRoot) continue;
      if (entry.provider === 'claude') {
        const exactProject = Boolean(claudeRoots || savedRoots?.claude) || workspacePaths.some(path => basename(authorizedRoot) === claudeProjectKey(path));
        workspaceMatch = await claudeSourceWorkspaceMatch(locator, workspacePath, exactProject);
        if (!workspaceMatch) continue;
      }
      const fingerprint = await fingerprintSourceFile({
        selectedPath: locator,
        allowedRoots: [authorizedRoot],
      });
      const rolloutId = entry.provider === 'codex' && descriptor.locatorClass === 'codex-rollout-jsonl'
        ? await codexRolloutId(locator) : undefined;
      const dedupeKey = rolloutId
        ? `codex\0rollout\0${rolloutId}`
        : `${entry.provider}\0${fingerprint.digest}\0${fingerprint.size}`;
      const rootCount = rootCounts.get(authorizedRoot)!;
      if (seen.has(dedupeKey)) {
        rootCount.duplicateCount += 1;
        continue;
      }
      seen.add(dedupeKey);
      if (workspaceMatch === 'subfolder') matchedBySubfolder += 1;
      if (workspaceMatch === 'worktree') matchedByWorktree += 1;
      rootCount.sourceCount += 1;
      const source = sourceFromDescriptor(
        descriptor,
        locator,
        authorizedRoot,
        details,
        fingerprint.digest,
      );
      source.nativeSessionId = rolloutId ?? ompHeader?.id ?? nativeSessionId;
      if (entry.provider === 'hermes') {
        // A state.db projection holds many sessions; the locator basename is
        // not a session identity.
        delete source.nativeSessionId;
      }
      if (entry.provider === 'grok-build' && source.nativeSessionId) {
        // Provider-reported activity only; histories stay usable without it.
        const observedAt = options.createdAt ?? new Date().toISOString();
        const registry = await grokActiveEvidence();
        const evidence = grokBuildLiveState(registry, source.nativeSessionId);
        source.liveEvidence = {
          ...evidence,
          observedAt,
          expiresAt: evidence.state === 'active'
            ? new Date(Date.parse(observedAt) + GROK_BUILD_ACTIVE_FRESHNESS_MS).toISOString()
            : null,
        };
      }
      if (ompHeader) source.sourceId = sha256(['omp-native-source-v1', workspaceId, ompHeader.id].join('\0'));
      if (entry.provider === 'grokbot') {
        // The replica is rewritten wholesale as its sliding window evicts
        // old entries, so a content-digest sourceId (the default above)
        // would churn every re-discovery and break checkpoint continuity.
        // Key it on the conversation id instead, same rationale as the OMP
        // override above. Unlike OMP, the key carries no workspaceId: Grok
        // Bot conversations are account-scoped (#3232), so the same replica
        // must resolve to one host-catalog source no matter which workspace
        // authorizes it; workspace catalogs keep a reference instead of a copy.
        const conversationId = grokbotConversationIdFromLocator(locator);
        if (conversationId) {
          source.sourceId = sha256(['grokbot-native-source-v1', conversationId].join('\0'));
        }
      }
      providerSources.push(source);
      candidates.push(source);
      } catch (error) {
        recordDiscoveryProblem(descriptor, scope.allowedRoots, 'unreadable', providerSources, candidates, error);
      }
    }
    const incompleteMuseInspection = museSourceInspections.some(
      (inspection) => inspection.outcome === 'inconclusive',
    );
    const report = providerReport(
      entry.provider,
      incompleteMuseInspection || providerSources.some(source => source.status === 'unreadable' || source.status === 'unsupported') ? 'not-checked' : 'checked',
      'discoverable',
      providerSources,
      incompleteMuseInspection ? 'MUSE_SOURCE_INSPECTION_INCOMPLETE'
        : providerSources.length === 0 ? 'NO_WORKSPACE_SOURCES' : null,
      incompleteMuseInspection
        ? 'Review unattributed museSourceInspections and their limit name/value; authorize a supported Muse export for unresolved sources before claiming workspace coverage.'
        : providerSources.length === 0
        ? `The ${entry.provider} root was checked, but no source matched the authorized workspace.`
        : null,
    );
    if (entry.provider === 'muse') {
      report.museSourceInspections = museSourceInspections.sort(
        (a, b) => a.sourceKey.localeCompare(b.sourceKey),
      );
    }
    report.matchedBySubfolder = matchedBySubfolder;
    report.matchedByWorktree = matchedByWorktree;
    if (entry.provider === 'codex') report.rootCounts = [...rootCounts.values()];
    reports.set(entry.provider, report);
  }

  for (const provider of expectedProviders) {
    if (reports.has(provider)) continue;
    const manual = MANUAL_EXPORT_PROVIDERS.has(provider as SessionProviderId);
    if (!supportedProviders.has(provider as SessionProviderId)) {
      reports.set(provider, providerReport(provider, 'not-checked', 'unsupported', [],
        'MISSING_ADAPTER', 'Deliberately select a compatible runtime or an authorized supported export.'));
      continue;
    }
    const grokBuild = provider === 'grok-build';
    reports.set(provider, providerReport(
      provider,
      manual ? 'export-required' : 'not-checked',
      manual ? 'manual-export' : 'unsupported',
      [],
      grokBuild ? grokBuildNativeAvailability().reasonCode
        : manual ? 'EXPLICIT_EXPORT_REQUIRED' : 'PROVIDER_NOT_CHECKED',
      grokBuild
        ? grokBuildNativeAvailability().remediation
        : manual
        ? `Select and authorize a supported ${provider} export before importing it.`
        : `No discovery strategy is registered for ${provider}.`,
    ));
  }

  const sources = candidates.sort(compareSources);
  const providers = [...reports.values()].sort((a, b) => a.provider.localeCompare(b.provider));
  const preflight = coveragePreflight({
    ...providerScope,
    registry, runtime: options.runtime, reports: providers,
  });
  const identity = {
    schemaVersion: DISCOVERY_MANIFEST_VERSION,
    workspaceId,
    preflight,
    authorizedRoots,
    sources: sources.map((source) => ({
      sourceId: source.sourceId,
      provider: source.provider,
      locatorClass: source.locatorClass,
      locator: source.locator,
      modifiedAt: source.modifiedAt,
      sizeBytes: source.sizeBytes,
      digest: source.digest,
      ...(source.nativeSessionId ? { nativeSessionId: source.nativeSessionId } : {}),
      ...(source.status ? { status: source.status, exclusion: source.exclusion } : {}),
    })),
    providers: providers.map((provider) => ({
      provider: provider.provider,
      status: provider.status,
      reasonCode: provider.reasonCode,
      ...(provider.matchedBySubfolder !== undefined ? { matchedBySubfolder: provider.matchedBySubfolder } : {}),
      ...(provider.matchedByWorktree !== undefined ? { matchedByWorktree: provider.matchedByWorktree } : {}),
      ...(provider.rootCounts ? { rootCounts: provider.rootCounts } : {}),
      ...(provider.museSourceInspections ? { museSourceInspections: provider.museSourceInspections } : {}),
    })),
  };
  return {
    schemaVersion: DISCOVERY_MANIFEST_VERSION,
    manifestId: sha256(JSON.stringify(identity)),
    createdAt: options.createdAt ?? new Date().toISOString(),
    workspaceId,
    workspacePath,
    preflight,
    authorizedRoots,
    providers,
    sources,
  };
}

export function defaultDiscoveryManifestPath(workspace: string): string {
  return resolve(workspace, '.aiwg', 'sessions', 'discovery-manifest.json');
}

export async function writeDiscoveryManifest(
  path: string,
  manifest: SessionDiscoveryManifest,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function readDiscoveryManifest(path: string): Promise<SessionDiscoveryManifest> {
  const value = JSON.parse(await readFile(path, 'utf8')) as SessionDiscoveryManifest;
  if (value.schemaVersion !== DISCOVERY_MANIFEST_VERSION
    || typeof value.manifestId !== 'string'
    || typeof value.workspaceId !== 'string'
    || !Array.isArray(value.providers)
    || !Array.isArray(value.sources)) {
    throw new Error('session discovery manifest is malformed or unsupported');
  }
  if (value.preflight) {
    const parsed = SessionCoveragePreflightSchema.safeParse(value.preflight);
    if (!parsed.success) throw new SessionContractError('INVALID_ARGUMENT', 'invalid discovery coverage preflight');
  }
  const expected = await rediscoverManifestIdentity(value);
  if (expected !== value.manifestId) {
    throw new Error('session discovery manifest identity does not match its contents');
  }
  return value;
}

export function publicDiscoveryManifest(manifest: SessionDiscoveryManifest): Record<string, unknown> {
  return {
    schemaVersion: manifest.schemaVersion,
    manifestId: manifest.manifestId,
    createdAt: manifest.createdAt,
    workspaceId: manifest.workspaceId,
    workspacePath: manifest.workspacePath,
    preflight: manifest.preflight,
    providers: manifest.providers,
    sources: manifest.sources.map(({ locator: _locator, authorizedRoot: _root, ...source }) => source),
    totals: {
      providers: manifest.providers.length,
      sources: manifest.sources.length,
      excluded: manifest.sources.filter(source => source.status === 'excluded').length,
      unsupported: manifest.sources.filter(source => source.status === 'unsupported').length,
      unreadable: manifest.sources.filter(source => source.status === 'unreadable').length,
      matchedBySubfolder: manifest.providers.reduce((sum, provider) => sum + (provider.matchedBySubfolder ?? 0), 0),
      matchedByWorktree: manifest.providers.reduce((sum, provider) => sum + (provider.matchedByWorktree ?? 0), 0),
    },
  };
}

function sourceFromDescriptor(
  descriptor: SourceDescriptor,
  locator: string,
  authorizedRoot: string,
  details: Awaited<ReturnType<typeof stat>>,
  digest: string,
): DiscoveryManifestSource {
  return {
    sourceId: sha256([
      'workspace-source-v1', descriptor.provider, descriptor.locatorClass, digest,
    ].join('\0')),
    provider: descriptor.provider,
    locator,
    redactedLocator: redactSourceLocator(locator),
    locatorClass: descriptor.locatorClass,
    authorizedRoot,
    modifiedAt: details.mtime.toISOString(),
    sizeBytes: Number(details.size),
    digest,
  };
}

function providerReport(
  provider: string,
  status: DiscoveryProviderStatus,
  disposition: DiscoveryProviderReport['disposition'],
  sources: DiscoveryManifestSource[],
  reasonCode: string | null,
  remediation: string | null,
): DiscoveryProviderReport {
  const timestamps = sources.map((source) => source.modifiedAt).filter(Boolean).sort();
  return {
    provider,
    status,
    disposition,
    sourceCount: sources.length,
    matchedBySubfolder: 0,
    matchedByWorktree: 0,
    dateRange: {
      earliest: timestamps.at(0) ?? null,
      latest: timestamps.at(-1) ?? null,
    },
    dateRangeBasis: 'source-mtime',
    reasonCode,
    remediation,
  };
}

async function rediscoverManifestIdentity(manifest: SessionDiscoveryManifest): Promise<string> {
  const identity = {
    schemaVersion: manifest.schemaVersion,
    workspaceId: manifest.workspaceId,
    ...(manifest.preflight ? { preflight: manifest.preflight } : {}),
    ...(manifest.authorizedRoots ? { authorizedRoots: manifest.authorizedRoots } : {}),
    sources: manifest.sources.map((source) => ({
      sourceId: source.sourceId,
      provider: source.provider,
      locatorClass: source.locatorClass,
      locator: source.locator,
      modifiedAt: source.modifiedAt,
      sizeBytes: source.sizeBytes,
      digest: source.digest,
      ...(source.nativeSessionId ? { nativeSessionId: source.nativeSessionId } : {}),
      ...(source.status ? { status: source.status, exclusion: source.exclusion } : {}),
    })),
    providers: manifest.providers.map((provider) => ({
      provider: provider.provider,
      status: provider.status,
      reasonCode: provider.reasonCode,
      ...(provider.matchedBySubfolder !== undefined ? { matchedBySubfolder: provider.matchedBySubfolder } : {}),
      ...(provider.matchedByWorktree !== undefined ? { matchedByWorktree: provider.matchedByWorktree } : {}),
      ...(provider.rootCounts ? { rootCounts: provider.rootCounts } : {}),
      ...(provider.museSourceInspections ? { museSourceInspections: provider.museSourceInspections } : {}),
    })),
  };
  return sha256(JSON.stringify(identity));
}

async function codexDiscoveryRoots(options: DiscoverWorkspaceOptions): Promise<string[]> {
  const explicit = [...(options.codexRoots ?? []), ...(options.codexRoot ? [options.codexRoot] : [])];
  const roots = [...new Set(explicit.map((root) => resolve(root)))];
  // Shared stores require the same explicit provider-home authorization as the default root.
  if (!options.providerHome) return roots;
  const codexHome = join(resolve(options.providerHome), '.codex');
  roots.push(join(codexHome, 'sessions'));
  if (process.env.CODEX_HOME) roots.push(resolve(process.env.CODEX_HOME, 'sessions'));
  try {
    const roles = await readdir(join(codexHome, 'roles-runtime'), { withFileTypes: true });
    for (const role of roles.sort((a, b) => a.name.localeCompare(b.name))) {
      if (role.isDirectory() || role.isSymbolicLink()) {
        roots.push(join(codexHome, 'roles-runtime', role.name, '.codex', 'sessions'));
      }
    }
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
  return [...new Set(roots)];
}

async function codexRolloutId(locator: string): Promise<string | undefined> {
  let count = 0;
  for await (const { line } of streamJsonLines(locator)) {
    if (++count > 50) break;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    const record = asObject(value);
    const id = asObject(record.payload).id;
    if (record.type === 'session_meta' && typeof id === 'string' && id.length > 0) return id;
  }
  return /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
    .exec(basename(locator))?.[1];
}

async function codexSourceWorkspaceMatch(
  locator: string,
  workspacePath: string,
): Promise<WorkspaceMatchKind | null> {
  let count = 0;
  for await (const { line } of streamJsonLines(locator)) {
    if (++count > 50) break;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const cwd = codexWorkspaceField(value);
    if (!cwd) continue;
    return await matchSessionWorkspace(cwd, workspacePath);
  }
  return null;
}

function codexWorkspaceField(value: unknown): string | null {
  const root = asObject(value);
  const payload = asObject(root.payload);
  const result = asObject(root.result);
  const resultThread = asObject(result.thread);
  const params = asObject(root.params);
  const paramsThread = asObject(params.thread);
  for (const candidate of [
    payload.cwd, result.cwd, resultThread.cwd, params.cwd, paramsThread.cwd,
  ]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return null;
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function canonicalPath(path: string): Promise<string> {
  return realpath(resolve(path));
}

/** Claude keys are lossy: use transcript cwd, never decode hyphens into paths. */
async function claudeDiscoveryRoots(
  homes: string[], paths: string[], workspace: string,
  registry: SessionSourceAdapterRegistry, exclusions: string[],
): Promise<string[]> {
  const roots = homes.flatMap(home => paths.map(path =>
    join(home, '.claude', 'projects', claudeProjectKey(path))));
  const adapter = registry.get('claude');
  for (const home of homes) {
    const projects = join(home, '.claude', 'projects');
    let entries;
    try { entries = await readdir(projects, { withFileTypes: true }); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const root = join(projects, entry.name);
      if (roots.includes(root)) continue;
      for await (const descriptor of adapter.discover({ workspaceId: workspace, allowedRoots: [root] })) {
        if (matchImportExclusion(descriptor, exclusions)) continue;
        if (await claudeSourceWorkspaceMatch(descriptor.locator, workspace, false)) {
          roots.push(root);
          break;
        }
      }
    }
  }
  return [...new Set(roots)];
}

async function claudeSourceWorkspaceMatch(
  locator: string,
  workspacePath: string,
  exactProject: boolean,
): Promise<WorkspaceMatchKind | null> {
  let count = 0;
  for await (const { line } of streamJsonLines(locator, { end: 1024 * 1024 - 1 })) {
    if (++count > 50) break;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const cwd = asObject(value).cwd;
    if (typeof cwd !== 'string' || cwd.length === 0) continue;
    return matchSessionWorkspace(cwd, workspacePath);
  }
  // Only exact project keys can establish ownership without cwd.
  return exactProject ? 'exact' : null;
}

export function claudeProjectKey(path: string): string {
  // Claude Code 2.1.302 replaces each character, then caps keys at 200
  // characters with a base-36 suffix from the original path's 32-bit hash.
  const key = path.replace(/[^A-Za-z0-9-]/g, '-');
  if (key.length <= 200) return key;
  let hash = 0;
  for (let index = 0; index < path.length; index += 1) {
    hash = ((hash << 5) - hash + path.charCodeAt(index)) | 0;
  }
  return `${key.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

function workspaceKey(path: string, retainLeadingSeparator: boolean): string {
  const normalized = path.replace(/\\/g, '/');
  const input = retainLeadingSeparator ? normalized : normalized.replace(/^\/+/, '');
  return input.replace(/[/:]+/g, '-');
}

function providerHomeCandidates(
  explicit: string | undefined,
  operatorHome: string | undefined,
): string[] {
  if (explicit) return [resolve(explicit)];
  let accountHome = operatorHome;
  if (!accountHome) {
    try {
      accountHome = userInfo().homedir;
    } catch {
      accountHome = undefined;
    }
  }
  return [...new Set([homedir(), accountHome].filter(
    (candidate): candidate is string => Boolean(candidate),
  ).map((candidate) => resolve(candidate)))];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function compareSources(
  left: DiscoveryManifestSource,
  right: DiscoveryManifestSource,
): number {
  return left.provider.localeCompare(right.provider)
    || left.locator.localeCompare(right.locator)
    || basename(left.locator).localeCompare(basename(right.locator));
}
