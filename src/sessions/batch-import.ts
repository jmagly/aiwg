import { assertClaudeManifestBoundary } from './source-boundary.js';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionAdapterRegistry } from './adapter-registry.js';
import { coveragePreflight, sessionRuntimeIdentity } from './coverage-preflight.js';
import {
  SESSION_CONTRACT_VERSION,
  SessionContractError,
  schemaIssueDetail,
  SessionSourceSchema,
  sha256,
  stableSessionId,
  stableEventId,
  type Session,
  type SessionEvent,
  type SessionProviderId,
  type SelectedSource,
  type SessionSource,
  type SessionSourceAdapter,
  type SessionRuntimeIdentity,
} from './contracts.js';
import {
  BATCH_IMPORT_VERSION,
  coverageFromBatchRun,
  type BatchImportRun,
  type BatchSourceDisposition,
  type SessionCoverageReport,
} from './batch-contracts.js';
import { IncrementalSessionImporter, SessionImportFailure, type ImportLimits } from './importer.js';
import {
  HOST_CATALOG_WORKSPACE_ID,
  isAccountScopedAdapter,
  publishHostRoutedBatch,
} from './host-catalog.js';
import { matchImportExclusion, resolveImportExclusions, type SourceExclusion } from './import-exclusions.js';
import { resolveImportLimits } from './import-limits.js';
import { fingerprintSourceFile } from './readers.js';
import { SessionRepository } from './repository.js';
import { redactSessionValue, sanitizeSessionEvent } from './policy.js';
import { deriveSessionIntent } from './origin.js';
import { recoverCodexRolloutIdentity } from './adapters/codex.js';
import type {
  DiscoveryManifestSource,
  SessionDiscoveryManifest,
} from './workspace-discovery.js';

export interface BatchImportOptions {
  manifest: SessionDiscoveryManifest;
  claudeProjectDirs?: readonly string[];
  /** Open the previous catalog read-only; never copy its derived indexes. */
  carryForward?: SessionRepository;
  exclude?: string[];
  limits?: Partial<ImportLimits>;
  runtime?: SessionRuntimeIdentity;
  repository: SessionRepository;
  /**
   * Host catalog for account-scoped providers (#3232). When present (with
   * hostCatalogPath), their sessions import once into the host repository
   * and the workspace repository records a reference instead of a copy.
   * Without it, account-scoped sources import locally (legacy behavior).
   */
  hostRepository?: SessionRepository;
  hostCatalogPath?: string;
  signal?: AbortSignal;
  inactivityThresholdMs?: number;
  now?: () => Date;
  fault?: (
    boundary: 'run-saved' | 'source-staged' | 'before-publication' | 'after-publication',
    sourceId?: string,
  ) => void;
}

export interface BatchImportReceipt {
  schemaVersion: typeof BATCH_IMPORT_VERSION;
  carryForward?: BatchImportRun['carryForward'];
  run: BatchImportRun;
  coverage: SessionCoverageReport;
  interruptedRuns: Array<{ runId: string; interruptedAt: string }>;
  totals: {
    unsupported: number;
    unreadable: number;
    imported: number;
    discovered: number;
    accepted: number;
    rejected: number;
    excluded: number;
    skipped: number;
    duplicated: number;
    previouslyCommitted: number;
    pending: number;
    sessionsAccepted: number;
    eventsAccepted: number;
  };
}

export async function importDiscoveryManifest(
  options: BatchImportOptions,
): Promise<BatchImportReceipt> {
  await assertClaudeManifestBoundary(options.manifest, options.claudeProjectDirs);
  if (options.carryForward) return rebuildFromCatalog(options);
  const exclusions = resolveImportExclusions(undefined, options.exclude);
  const limits = { ...resolveImportLimits(undefined, {
    maxRecordBytes: options.limits?.maxRecordBytes, maxSourceBytes: options.limits?.maxTotalBytes,
  }), ...options.limits };
  const now = options.now ?? (() => new Date());
  const runId = sha256([
    'workspace-import-v1',
    options.manifest.manifestId,
    options.manifest.workspaceId,
  ].join('\0'));
  const prior = options.repository.getBatchImportRunForManifest(
    options.manifest.manifestId,
    options.manifest.workspaceId,
  );
  const run = prior ?? newBatchRun(options.manifest, runId, now());
  if (run.runId !== runId) {
    throw new SessionContractError(
      'IMPORT_CONFLICT',
      'discovery manifest is already associated with a different batch run',
    );
  }
  run.schemaVersion = BATCH_IMPORT_VERSION;
  run.preflight = coveragePreflight({
    configuredProviders: options.manifest.preflight?.configuredProviders,
    scopeWarnings: options.manifest.preflight?.scopeWarnings,
    expectedProviders: options.manifest.preflight?.expectedProviders,
    expectedProviderBasis: options.manifest.preflight?.expectedProviderBasis ?? 'legacy',
    runtime: options.runtime ?? sessionRuntimeIdentity(),
    reports: options.manifest.providers,
  });
  run.status = 'running';
  run.updatedAt = now().toISOString();
  run.completedAt = null;
  options.repository.saveBatchImportRun(run);
  injectFault(options, run, 'run-saved');
  const hostRoutedSourceIds: string[] = [];

  for (const manifestSource of options.manifest.sources) {
    const disposition = run.sources.find(
      (candidate) => candidate.sourceId === manifestSource.sourceId,
    );
    if (!disposition) {
      throw new SessionContractError(
        'IMPORT_CONFLICT',
        `batch run is missing discovered source ${manifestSource.sourceId}`,
      );
    }
    const exclusion = matchImportExclusion(manifestSource, exclusions) ?? manifestSource.exclusion;
    if (exclusion) {
      excludeSource(disposition, exclusion, now());
      continue;
    }
    if (manifestSource.status === 'unsupported' || manifestSource.status === 'unreadable') continue;
    delete disposition.exclusion;
    if (isAccepted(disposition.status)) {
      disposition.status = 'previously-committed';
      disposition.updatedAt = now().toISOString();
      continue;
    }
    if (options.signal?.aborted) {
      run.status = 'interrupted';
      run.updatedAt = now().toISOString();
      options.repository.saveBatchImportRun(run);
      throw new SessionContractError(
        'IMPORT_INTERRUPTED',
        'workspace batch import was cancelled and can be resumed',
      );
    }

    disposition.status = 'running';
    disposition.attempts += 1;
    disposition.errorCode = null;
    disposition.diagnostic = null;
    disposition.detail = null;
    disposition.updatedAt = now().toISOString();
    persistProgress(options.repository, run, now());
    try {
      await assertManifestSourceUnchanged(manifestSource);
      const adapter = adapterFor(manifestSource.provider, limits);
      // Account-scoped providers (Grok Bot) are imported once into the
      // host catalog; the workspace catalog records a reference (#3232).
      // Any adapter declaring account scope follows this route.
      const hostRouted = options.hostRepository !== undefined
        && options.hostCatalogPath !== undefined
        && isAccountScopedAdapter(adapter);
      const targetRepository = hostRouted ? options.hostRepository! : options.repository;
      const importWorkspaceId = hostRouted ? HOST_CATALOG_WORKSPACE_ID : options.manifest.workspaceId;
      if (hostRouted) hostRoutedSourceIds.push(manifestSource.sourceId);
      const selectedSource: SelectedSource = {
        provider: manifestSource.provider,
        locator: manifestSource.locator,
        locatorClass: manifestSource.locatorClass,
        sourceId: manifestSource.sourceId,
        authorizedScope: {
          workspaceId: importWorkspaceId,
          allowedRoots: [manifestSource.authorizedRoot],
        },
      };
      const source = await sessionSource(selectedSource, adapter);
      const receipts = await new IncrementalSessionImporter(targetRepository).import({
        source,
        selectedSource,
        adapter,
        workspaceId: importWorkspaceId,
        policyVersion: '1.0.0',
        batchRunId: run.runId,
        publish: false,
        signal: options.signal,
        inactivityThresholdMs: options.inactivityThresholdMs,
        limits,
      });
      await assertManifestSourceUnchanged(manifestSource);
      const totals = targetRepository.sourceImportTotals(
        manifestSource.sourceId,
        run.runId,
      );
      disposition.sessionsAccepted = totals.sessions;
      disposition.eventsAccepted = totals.events;
      disposition.status = receipts.length > 0
        && receipts.every((receipt) => receipt.outcome === 'duplicate')
        ? 'duplicate'
        : receipts.length === 0
          ? 'previously-committed'
          : 'committed';
    } catch (error) {
      disposition.status = 'rejected';
      disposition.errorCode = importErrorCode(error);
      disposition.detail = error instanceof SessionContractError ? error.detail ?? null : null;
      disposition.diagnostic = [
        `provider=${manifestSource.provider}`,
        `source=${manifestSource.sourceId}`,
        `code=${disposition.errorCode}`,
        ...(disposition.detail ? [`detail=${JSON.stringify(disposition.detail)}`] : []),
      ].join(' ');
    }
    disposition.updatedAt = now().toISOString();
    persistProgress(options.repository, run, now());
    injectFault(options, run, 'source-staged', manifestSource.sourceId);
  }

  const rejected = run.sources.some((source) => ['rejected', 'unsupported', 'unreadable'].includes(source.status));
  const pending = run.sources.some(
    (source) => source.status === 'pending' || source.status === 'running',
  );
  const acquisitionIncomplete = coverageFromBatchRun(run, now()).acquisitionStatus !== 'complete';
  const publishable = run.sources
    .filter((source) => isAccepted(source.status))
    .map((source) => source.sourceId);
  injectFault(options, run, 'before-publication');
  options.repository.commitStagedBatch(run.runId, publishable);
  if (options.hostRepository && options.hostCatalogPath && hostRoutedSourceIds.length > 0) {
    const acceptedHost = run.sources
      .filter((source) => hostRoutedSourceIds.includes(source.sourceId) && isAccepted(source.status))
      .map((source) => source.sourceId);
    publishHostRoutedBatch({
      hostRepository: options.hostRepository,
      workspaceRepository: options.repository,
      batchRunId: run.runId,
      sourceIds: acceptedHost,
      hostCatalogPath: options.hostCatalogPath,
    });
  }
  injectFault(options, run, 'after-publication');
  run.status = pending ? 'interrupted' : rejected || acquisitionIncomplete ? 'partial' : 'complete';
  run.updatedAt = now().toISOString();
  run.completedAt = pending ? null : run.updatedAt;
  options.repository.saveBatchImportRun(run);
  return receiptFor(run, now());
}

function injectFault(
  options: BatchImportOptions,
  run: BatchImportRun,
  boundary: 'run-saved' | 'source-staged' | 'before-publication' | 'after-publication',
  sourceId?: string,
): void {
  if (!options.fault) return;
  try {
    options.fault(boundary, sourceId);
  } catch (error) {
    run.status = 'interrupted';
    run.updatedAt = (options.now ?? (() => new Date()))().toISOString();
    run.completedAt = null;
    options.repository.saveBatchImportRun(run);
    throw error;
  }
}

export function previewDiscoveryImport(
  manifest: SessionDiscoveryManifest,
  existing: BatchImportRun | null,
  now = new Date(),
  exclude: string[] = [],
): BatchImportReceipt {
  const run = existing ?? newBatchRun(
    manifest,
    sha256(['workspace-import-v1', manifest.manifestId, manifest.workspaceId].join('\0')),
    now,
  );
  const exclusions = resolveImportExclusions(undefined, exclude);
  return receiptFor({
    ...run,
    sources: run.sources.map(source => {
      const manifestSource = manifest.sources.find(candidate => candidate.sourceId === source.sourceId)!;
      const exclusion = matchImportExclusion(manifestSource, exclusions) ?? manifestSource.exclusion;
      if (!exclusion) return source;
      const disposition = { ...source };
      excludeSource(disposition, exclusion, now);
      return disposition;
    }),
    preflight: coveragePreflight({
      configuredProviders: manifest.preflight?.configuredProviders,
      scopeWarnings: manifest.preflight?.scopeWarnings,
      expectedProviders: manifest.preflight?.expectedProviders,
      expectedProviderBasis: manifest.preflight?.expectedProviderBasis ?? 'legacy',
      reports: manifest.providers,
    }),
  }, now);
}

function newBatchRun(
  manifest: SessionDiscoveryManifest,
  runId: string,
  now: Date,
): BatchImportRun {
  const timestamp = now.toISOString();
  return {
    schemaVersion: BATCH_IMPORT_VERSION,
    runId,
    manifestId: manifest.manifestId,
    manifestCreatedAt: manifest.createdAt,
    workspaceId: manifest.workspaceId,
    status: 'running',
    startedAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    preflight: manifest.preflight,
    discoveryRuntime: manifest.preflight?.runtime,
    providers: manifest.providers,
    sources: manifest.sources.map((source): BatchSourceDisposition => ({
      sourceId: source.sourceId,
      provider: source.provider,
      status: source.status ?? 'pending',
      ...(source.exclusion ? { exclusion: source.exclusion } : {}),
      attempts: 0,
      sessionsAccepted: 0,
      eventsAccepted: 0,
      errorCode: null,
      diagnostic: null,
      updatedAt: timestamp,
    })),
  };
}

function receiptFor(run: BatchImportRun, now: Date): BatchImportReceipt {
  const coverage = coverageFromBatchRun(run, now);
  return {
    schemaVersion: BATCH_IMPORT_VERSION,
    run,
    coverage,
    interruptedRuns: [],
    ...(run.carryForward ? { carryForward: run.carryForward } : {}),
    totals: {
      unsupported: coverage.sources.unsupported, unreadable: coverage.sources.unreadable, imported: coverage.sources.imported,
      discovered: coverage.sources.discovered,
      accepted: coverage.sources.accepted,
      rejected: coverage.sources.rejected,
      excluded: coverage.sources.excluded,
      skipped: coverage.sources.skipped,
      duplicated: coverage.sources.duplicated,
      previouslyCommitted: coverage.sources.previouslyCommitted,
      pending: coverage.sources.pending,
      sessionsAccepted: coverage.sessionsAccepted,
      eventsAccepted: coverage.eventsAccepted,
    },
  };
}

function excludeSource(source: BatchSourceDisposition, exclusion: SourceExclusion, now: Date): void {
  source.status = 'excluded';
  source.exclusion = exclusion;
  source.errorCode = null;
  source.diagnostic = null;
  source.detail = null;
  source.sessionsAccepted = 0;
  source.eventsAccepted = 0;
  source.updatedAt = now.toISOString();
}

function persistProgress(
  repository: SessionRepository,
  run: BatchImportRun,
  now: Date,
): void {
  run.updatedAt = now.toISOString();
  repository.saveBatchImportRun(run);
}

async function assertManifestSourceUnchanged(source: DiscoveryManifestSource): Promise<void> {
  let details;
  try {
    details = await stat(source.locator);
  } catch {
    throw new SessionContractError(
      'SCHEMA_DRIFT',
      'discovered source is no longer available; run discovery again',
      schemaIssueDetail('locator'),
    );
  }
  if (details.size !== source.sizeBytes || details.mtime.toISOString() !== source.modifiedAt) {
    throw new SessionContractError(
      'SCHEMA_DRIFT',
      'discovered source changed after manifest creation; run discovery again',
      schemaIssueDetail(details.size !== source.sizeBytes ? 'sizeBytes' : 'modifiedAt'),
    );
  }
  const fingerprint = await fingerprintSourceFile({
    selectedPath: source.locator,
    allowedRoots: [source.authorizedRoot],
  });
  if (fingerprint.digest !== source.digest || fingerprint.size !== source.sizeBytes) {
    throw new SessionContractError(
      'SCHEMA_DRIFT',
      'discovered source content changed after manifest creation; run discovery again',
      schemaIssueDetail('digest'),
    );
  }
}

function adapterFor(provider: DiscoveryManifestSource['provider'], limits?: Partial<ImportLimits>): SessionSourceAdapter {
  return createSessionAdapterRegistry(limits).get(provider);
}

async function sessionSource(
  selected: SelectedSource,
  adapter: SessionSourceAdapter,
): Promise<SessionSource> {
  const probe = await adapter.inspect(selected);
  return SessionSourceSchema.parse({
    contractVersion: SESSION_CONTRACT_VERSION,
    sourceId: selected.sourceId,
    provider: selected.provider,
    providerProfile: providerProfile(selected.provider, selected.locatorClass),
    locatorClass: selected.locatorClass,
    redactedLocator: '<discovered-session-source>',
    adapterVersion: adapter.adapterVersion,
    sourceSchemaVersion: probe.sourceSchemaVersion,
    disposition: 'implemented',
    operationalState: probe.operationalState,
    consistency: probe.consistency,
    authorizedAt: new Date().toISOString(),
    extensions: { [`native.${selected.provider}`]: {} },
  });
}

function providerProfile(
  provider: DiscoveryManifestSource['provider'],
  locatorClass: string,
): string {
  if (provider === 'deepseek-harness') return 'native-session-v2-jsonl';
  if (provider === 'omp') return 'native-title-slot-v3';
  if (provider === 'claude') return 'documented-local-jsonl';
  if (provider === 'codex') return 'app-server-v2-rollout-fallback';
  if (provider === 'cursor') {
    return locatorClass === 'cursor-agent-transcript-jsonl'
      ? 'agent-transcript-jsonl'
      : 'cli-stream-json';
  }
  if (provider === 'factory') return 'documented-project-jsonl';
  if (provider === 'muse') return 'muse-native-session-log-v1';
  if (provider === 'grokbot') return 'grokbot-native-transcript-replica-v1';
  if (provider === 'grok-build') {
    return locatorClass === 'grok-build-native-chat-history'
      ? 'grok-build-native-chat-history-v1'
      : 'documented-cli-markdown-export';
  }
  if (provider === 'hermes') {
    return locatorClass === 'hermes-consistent-snapshot-jsonl'
      ? 'native-state-db-backup-snapshot-v1'
      : 'native-schema-23-export';
  }
  return 'manual-interchange';
}

function importErrorCode(error: unknown): string {
  if (error instanceof SessionImportFailure) return error.failureReceipt.errorCode;
  if (error instanceof SessionContractError) return error.code;
  return 'IMPORT_INTERRUPTED';
}

function isAccepted(status: BatchSourceDisposition['status']): boolean {
  return status === 'committed'
    || status === 'duplicate'
    || status === 'previously-committed';
}

/** Reuse source import and normalized repository gates, without copying FTS/analytics. */
async function rebuildFromCatalog(options: BatchImportOptions): Promise<BatchImportReceipt> {
  const previous = options.carryForward!;
  if (previous === options.repository) {
    throw new SessionContractError('INVALID_ARGUMENT', 'carry-forward requires a separate destination catalog');
  }
  const workspaceId = options.manifest.workspaceId;
  const exclusions = resolveImportExclusions(undefined, options.exclude);
  const byProvider: NonNullable<BatchImportReceipt['carryForward']>['byProvider'] = {};
  const counts = (provider: SessionProviderId) => byProvider[provider] ??= {
    reimported: 0, carried: 0, droppedAsDuplicate: 0, excluded: 0,
  };
  const oldSessions = catalogSessions(previous, workspaceId);
  const available: DiscoveryManifestSource[] = [];
  const present = new Set<string>();
  const excludedSources = new Set<string>();
  for (const source of options.manifest.sources) {
    if (matchImportExclusion(source, exclusions) ?? source.exclusion) {
      excludedSources.add(source.sourceId);
      continue;
    }
    let details;
    try { details = await stat(source.locator); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
      throw error;
    }
    // Refresh the snapshot, but retain the explicitly saved authorization and source identity.
    const fingerprint = await fingerprintSourceFile({ selectedPath: source.locator,
      allowedRoots: [source.authorizedRoot] });
    available.push({ ...source, sizeBytes: details.size, modifiedAt: details.mtime.toISOString(),
      digest: fingerprint.digest });
    present.add(source.sourceId);
  }
  const manifest = { ...options.manifest, sources: available,
    manifestId: sha256(JSON.stringify(['carry-forward-v1', options.manifest.manifestId, available])) };
  const stagingDirectory = await mkdtemp(join(tmpdir(), 'aiwg-session-rebuild-'));
  let staged: SessionRepository | undefined;
  try {
    staged = new SessionRepository(join(stagingDirectory, 'staging.sqlite'));
    // The staged rebuild transfers normalized rows (not host references) into
    // the destination, so account-scoped sources rebuild locally here as
    // before; the destination's own host routing applies on its next import.
    const receipt = await importDiscoveryManifest({ ...options, manifest, repository: staged,
      carryForward: undefined, fault: undefined,
      hostRepository: undefined, hostCatalogPath: undefined });
    const identities = new Set<string>();
    const destinationCodex = new Map(catalogSessions(options.repository, workspaceId)
      .filter(session => session.provider === 'codex').map(session => [session.nativeSessionId, session.sourceId]));
    const transfer = (repository: SessionRepository, sessions: Session[], category: 'reimported' | 'carried') => {
      // A legacy Codex rollout may have split replayed parent events into phantom rows.
      // Recover the first session_meta ID for the whole source before grouping events.
      const sourceGroups = new Map<string, Session[]>();
      for (const session of sessions) {
        const group = sourceGroups.get(session.sourceId) ?? [];
        group.push(session);
        sourceGroups.set(session.sourceId, group);
      }
      for (const [sourceId, group] of sourceGroups) {
        if (options.signal?.aborted) throw new SessionContractError('IMPORT_INTERRUPTED', 'catalog rebuild interrupted');
        const source = repository.getSource(sourceId, workspaceId);
        if (!source) throw new SessionContractError('IMPORT_CONFLICT', 'catalog session has no authorized source');
        const allEvents = group.flatMap(session => repository.listEvents(session.sessionId, workspaceId))
          .sort((a, b) => a.sequence - b.sequence || a.eventId.localeCompare(b.eventId));
        const rollout = source.provider === 'codex' ? recoverCodexRolloutIdentity(allEvents) : undefined;
        const childId = rollout?.nativeSessionId;
        // Prefer the child's aggregate when the legacy source also has phantom parent aggregates.
        group.sort((a, b) => Number(b.nativeSessionId === childId) - Number(a.nativeSessionId === childId));
        const canonical = new Map<string, { session: Session; events: SessionEvent[] }>();
        for (const session of group) {
          const nativeId = childId ?? session.nativeSessionId;
          const locator = options.manifest.sources.find(item => item.sourceId === sourceId)?.locator
            ?? source.redactedLocator;
          if (excludedSources.has(sourceId) || matchImportExclusion({ provider: session.provider,
            locator, locatorClass: source.locatorClass, nativeSessionId: nativeId }, exclusions)) {
            counts(session.provider).excluded++;
            continue;
          }
          const key = session.provider === 'codex' ? `${session.provider}\0${nativeId}` : session.sessionId;
          if (identities.has(key)) {
            counts(session.provider).droppedAsDuplicate++;
            continue;
          }
          const existing = canonical.get(key);
          if (existing) {
            counts(session.provider).droppedAsDuplicate++;
            existing.events.push(...repository.listEvents(session.sessionId, workspaceId));
          } else canonical.set(key, { session: { ...session, nativeSessionId: nativeId },
            events: repository.listEvents(session.sessionId, workspaceId) });
        }
        for (const [key, entry] of canonical) {
          if (source.provider === 'codex' && destinationCodex.has(entry.session.nativeSessionId)
            && destinationCodex.get(entry.session.nativeSessionId) !== sourceId) {
            throw new SessionContractError('IMPORT_CONFLICT', 'destination has a different source for this Codex identity; select a fresh catalog');
          }
          const session = redactSessionValue({ ...entry.session,
            sessionId: stableSessionId(source.provider, sourceId, entry.session.nativeSessionId),
          }).value;
          // Hash only sanitized content; receipts and IDs must never retain old plaintext.
          const sanitized = entry.events.map(sanitizeSessionEvent);
          const runId = sha256(JSON.stringify(['catalog-carry-v1', session.sessionId, sanitized]));
          const events = sanitized.map(event => {
            const digest = event.digest;
            return { ...event, sessionId: session.sessionId, importRunId: runId, digest,
              eventId: stableEventId(source.provider, sourceId, {
                nativeSessionId: session.nativeSessionId, nativeEventId: event.nativeId ?? event.eventId,
                sequence: event.sequence, kind: event.kind, text: event.searchableText,
                rawReference: event.rawReference,
              }, digest) };
          });
          if (rollout && Object.keys(rollout.lineage).length > 0) {
            session.extensions['native.codex'] = { lineage: rollout.lineage };
          }
          session.intent = deriveSessionIntent(events);
          const checkpoint = repository.getCheckpoint(sourceId, source.adapterVersion)
            ?? { cursor: '', recordsRead: events.length, bytesRead: Buffer.byteLength(JSON.stringify(events)) };
          options.repository.applyImport({ source, sessions: [session], events,
            run: { contractVersion: SESSION_CONTRACT_VERSION, importRunId: runId, sourceId,
              parserVersion: source.adapterVersion, policyVersion: '1.0.0',
              sourceSchemaVersion: source.sourceSchemaVersion, consistency: source.consistency,
              status: 'running', checkpoint, startedAt: (options.now?.() ?? new Date()).toISOString(),
              completedAt: null, errorCode: null } }, checkpoint);
          for (const old of group.filter(item => (childId ?? item.nativeSessionId) === entry.session.nativeSessionId)) {
            for (const tag of repository.listTags(old.sessionId, workspaceId)) {
              options.repository.tagSession(session.sessionId, tag, workspaceId);
            }
          }
          identities.add(key);
          counts(source.provider)[category]++;
        }
      }
    };
    const reimported = catalogSessions(staged, workspaceId);
    transfer(staged, reimported, 'reimported');
    for (const sourceId of present) {
      const old = oldSessions.filter(session => session.sourceId === sourceId && session.provider === 'codex');
      const imported = reimported.filter(session => session.sourceId === sourceId);
      // Account for phantom rows eliminated by current source parsing, separately from copied duplicates.
      if (imported.length > 0 && old.length > imported.length) {
        counts('codex').droppedAsDuplicate += old.length - imported.length;
      }
    }
    transfer(previous, oldSessions.filter(session => !present.has(session.sourceId)), 'carried');
    options.repository.reindex(workspaceId);
    const finalSessions = catalogSessions(options.repository, workspaceId);
    const sourceIds = new Set([...receipt.run.sources.map(item => item.sourceId),
      ...oldSessions.map(session => session.sourceId)]);
    for (const sourceId of sourceIds) {
      const accepted = finalSessions.filter(session => session.sourceId === sourceId);
      let disposition = receipt.run.sources.find(item => item.sourceId === sourceId);
      if (!disposition) {
        const old = oldSessions.find(session => session.sourceId === sourceId)!;
        const excluded = excludedSources.has(sourceId) || matchImportExclusion({
          provider: old.provider, nativeSessionId: old.nativeSessionId,
          locator: previous.getSource(sourceId, workspaceId)?.redactedLocator ?? '', locatorClass: 'catalog',
        }, exclusions);
        disposition = { sourceId, provider: old.provider,
          status: excluded ? 'excluded' : accepted.length > 0 ? 'committed' : 'duplicate',
          attempts: 1, sessionsAccepted: 0, eventsAccepted: 0,
          errorCode: null, diagnostic: null, updatedAt: receipt.run.updatedAt };
        receipt.run.sources.push(disposition);
      }
      disposition.sessionsAccepted = accepted.length;
      disposition.eventsAccepted = accepted.reduce((sum, session) =>
        sum + options.repository.listEvents(session.sessionId, workspaceId).length, 0);
    }
    receipt.run.carryForward = { byProvider };
    options.repository.saveBatchImportRun(receipt.run);
    return redactSessionValue(receiptFor(receipt.run, options.now?.() ?? new Date())).value;
  } finally {
    staged?.close();
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

function catalogSessions(repository: SessionRepository, workspaceId: string): Session[] {
  const sessions: Session[] = [];
  let cursor: string | undefined;
  do {
    const page = repository.listSessions({ workspaceId, limit: 500, cursor });
    sessions.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return sessions;
}
