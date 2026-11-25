import type { SourceExclusion } from './import-exclusions.js';
import type { SessionCoveragePreflight, SessionRejectionDetail, SessionRuntimeIdentity, SessionProviderId } from './contracts.js';
import { reconcileCoveragePreflight } from './coverage-preflight.js';
import type { DiscoveryProviderReport } from './workspace-discovery.js';

export const BATCH_IMPORT_VERSION = '2.0.0' as const;
export const COVERAGE_VERSION = '2.0.0' as const;

export type BatchSourceStatus =
  | 'unsupported'
  | 'unreadable'
  | 'pending'
  | 'running'
  | 'committed'
  | 'duplicate'
  | 'previously-committed'
  | 'excluded'
  | 'rejected'
  | 'skipped';

export interface BatchSourceDisposition {
  sourceId: string;
  provider: string;
  status: BatchSourceStatus;
  attempts: number;
  sessionsAccepted: number;
  eventsAccepted: number;
  errorCode: string | null;
  diagnostic: string | null;
  detail?: SessionRejectionDetail | null;
  exclusion?: SourceExclusion;
  updatedAt: string;
}

export interface CarryForwardCounts {
  byProvider: Partial<Record<SessionProviderId, {
    reimported: number;
    carried: number;
    droppedAsDuplicate: number;
    excluded: number;
  }>>;
}

export interface BatchImportRun {
  schemaVersion: '1.0.0' | typeof BATCH_IMPORT_VERSION;
  runId: string;
  manifestId: string;
  manifestCreatedAt: string;
  workspaceId: string;
  status: 'running' | 'complete' | 'partial' | 'interrupted';
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  interruptedAt?: string;
  carryForward?: CarryForwardCounts;
  preflight?: SessionCoveragePreflight;
  discoveryRuntime?: SessionRuntimeIdentity;
  providers: DiscoveryProviderReport[];
  sources: BatchSourceDisposition[];
}

export interface SessionCoverageReport {
  schemaVersion: typeof COVERAGE_VERSION;
  status: 'complete' | 'partial' | 'stale' | 'unknown';
  acquisitionStatus: 'complete' | 'partial' | 'unknown';
  unresolvedProviders: string[];
  preflight?: SessionCoveragePreflight;
  semanticReview: 'not-assessed';
  workspaceId: string;
  manifestId: string | null;
  batchRunId: string | null;
  manifestCreatedAt: string | null;
  manifestAgeMs: number | null;
  providers: {
    checked: string[];
    unavailable: string[];
    exportRequired: string[];
    notChecked: string[];
  };
  sources: {
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
  };
  sessionsAccepted: number;
  eventsAccepted: number;
  coverageRatio: number | null;
  rejectionCounts: Record<string, number>;
  sourceDateRange: { earliest: string | null; latest: string | null };
  importedDateRange: { earliest: string | null; latest: string | null };
  remediation: string[];
}

export function coverageFromBatchRun(
  run: BatchImportRun | null,
  now = new Date(),
  staleAfterMs = 24 * 60 * 60 * 1_000,
): SessionCoverageReport {
  if (!run) return unknownCoverage();
  const coveredStatuses = new Set<BatchSourceStatus>([
    'committed', 'duplicate', 'previously-committed',
  ]);
  const unsupported = run.sources.filter(source => source.status === 'unsupported').length;
  const unreadable = run.sources.filter(source => source.status === 'unreadable').length;
  const accepted = run.sources.filter((source) => source.status === 'committed').length;
  const rejected = run.sources.filter((source) => source.status === 'rejected').length;
  const excluded = run.sources.filter(source => source.status === 'excluded').length;
  const skipped = run.sources.filter((source) => source.status === 'skipped').length;
  const duplicated = run.sources.filter(
    (source) => source.status === 'duplicate',
  ).length;
  const previouslyCommitted = run.sources.filter(
    (source) => source.status === 'previously-committed',
  ).length;
  const pending = run.sources.filter(
    (source) => source.status === 'pending' || source.status === 'running',
  ).length;
  const checked = providerNames(run, 'checked');
  const unavailable = providerNames(run, 'unavailable');
  const exportRequired = providerNames(run, 'export-required');
  const notChecked = providerNames(run, 'not-checked');
  const manifestAgeMs = Math.max(0, now.getTime() - Date.parse(run.manifestCreatedAt));
  const isStale = manifestAgeMs > staleAfterMs;
  const preflight = run.preflight ? reconcileCoveragePreflight(run.preflight, run.sources) : undefined;
  const unresolvedProviders = preflight?.unresolvedProviders
    ?? [...new Set([...unavailable, ...exportRequired, ...notChecked])].sort();
  const acquisitionIncomplete = unsupported > 0 || unreadable > 0 || rejected > 0 || pending > 0 || skipped > 0
    || (preflight && ['explicit', 'workspace-config'].includes(preflight.expectedProviderBasis) && unresolvedProviders.length > 0);
  const incomplete = acquisitionIncomplete || !preflight || preflight.status !== 'complete'
    || unavailable.length > 0 || accepted + duplicated + previouslyCommitted + excluded === 0
    || exportRequired.length > 0 || notChecked.length > 0;
  const rejectionCounts: Record<string, number> = {};
  for (const source of run.sources) {
    if (source.status !== 'rejected') continue;
    const code = source.errorCode ?? 'UNKNOWN_REJECTION';
    rejectionCounts[code] = (rejectionCounts[code] ?? 0) + 1;
  }
  const sourceTimestamps = run.providers.flatMap((provider) => [
    provider.dateRange.earliest,
    provider.dateRange.latest,
  ]).filter((value): value is string => value !== null).sort();
  const importedTimestamps = run.sources
    .filter((source) => coveredStatuses.has(source.status))
    .map((source) => source.updatedAt)
    .sort();
  const remediation = [
    ...(preflight?.ledger.flatMap((entry) => entry.remediation ? [entry.remediation] : []) ?? ['Legacy receipt lacks provider/runtime preflight; rediscover with --expected-providers.']),
    ...(preflight && ['mismatch', 'stale', 'unknown'].includes(preflight.runtime.installationState)
      ? ['Inspect the recorded runtime identity and deliberately select a compatible installation; then rediscover. No automatic switch is performed.'] : []),
    ...(rejected > 0
      ? ['Run `aiwg sessions import-discovered --resume --confirm` after correcting rejected sources.']
      : []),
    ...(exportRequired.length > 0
      ? ['Export and explicitly authorize providers marked export-required, then run discovery again.']
      : []),
    ...(isStale ? ['Run `aiwg sessions discover` to refresh the stale manifest.'] : []),
  ];
  return {
    schemaVersion: COVERAGE_VERSION,
    status: isStale ? 'stale' : incomplete ? 'partial' : 'complete',
    acquisitionStatus: acquisitionIncomplete ? 'partial' : 'complete',
    unresolvedProviders,
    preflight,
    semanticReview: 'not-assessed',
    workspaceId: run.workspaceId,
    manifestId: run.manifestId,
    batchRunId: run.runId,
    manifestCreatedAt: run.manifestCreatedAt,
    manifestAgeMs,
    providers: { checked, unavailable, exportRequired, notChecked },
    sources: {
      unsupported, unreadable, imported: accepted + duplicated + previouslyCommitted,
      discovered: run.sources.length,
      accepted,
      rejected,
      excluded,
      skipped,
      duplicated,
      previouslyCommitted,
      pending,
    },
    sessionsAccepted: run.sources.reduce((sum, source) => sum + source.sessionsAccepted, 0),
    eventsAccepted: run.sources.reduce((sum, source) => sum + source.eventsAccepted, 0),
    coverageRatio: run.sources.length === excluded
      ? null
      : (accepted + duplicated + previouslyCommitted) / (run.sources.length - excluded),
    rejectionCounts,
    sourceDateRange: {
      earliest: sourceTimestamps.at(0) ?? null,
      latest: sourceTimestamps.at(-1) ?? null,
    },
    importedDateRange: {
      earliest: importedTimestamps.at(0) ?? null,
      latest: importedTimestamps.at(-1) ?? null,
    },
    remediation,
  };
}

function providerNames(
  run: BatchImportRun,
  status: DiscoveryProviderReport['status'],
): string[] {
  return run.providers
    .filter((provider) => provider.status === status)
    .map((provider) => provider.provider)
    .sort();
}

function unknownCoverage(): SessionCoverageReport {
  return {
    schemaVersion: COVERAGE_VERSION,
    status: 'unknown',
    acquisitionStatus: 'unknown',
    unresolvedProviders: [],
    semanticReview: 'not-assessed',
    workspaceId: '',
    manifestId: null,
    batchRunId: null,
    manifestCreatedAt: null,
    manifestAgeMs: null,
    providers: {
      checked: [],
      unavailable: [],
      exportRequired: [],
      notChecked: [],
    },
    sources: {
      unsupported: 0, unreadable: 0, imported: 0,
      discovered: 0,
      accepted: 0,
      rejected: 0,
      excluded: 0,
      skipped: 0,
      duplicated: 0,
      previouslyCommitted: 0,
      pending: 0,
    },
    sessionsAccepted: 0,
    eventsAccepted: 0,
    coverageRatio: null,
    rejectionCounts: {},
    sourceDateRange: { earliest: null, latest: null },
    importedDateRange: { earliest: null, latest: null },
    remediation: ['Run `aiwg sessions discover --workspace <path>` to establish coverage.'],
  };
}
