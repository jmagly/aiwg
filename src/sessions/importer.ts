import {
  SESSION_CONTRACT_VERSION,
  assertSupportedSchemaMajor, sha256,
  SessionContractError,
  schemaIssueDetail,
  assertSessionResourceLimit,
  type ImportCheckpoint, type ImportRun, type ProviderRecord, type SessionRejectionDetail,
  type SelectedSource, type SessionSource,
  type SessionSourceAdapter,
} from './contracts.js';
import { assertImportByteLimit, DEFAULT_IMPORT_BYTE_LIMITS, resolveImportLimits, type ImportByteLimits } from './import-limits.js';
import { redactSessionValue, sanitizeNativeExtensions } from './policy.js';
import type { ImportReceipt } from './repository.js';
import type { SessionRepositoryPort } from './ports.js';
import { fingerprintSourcePrefix } from './readers.js';
import { normalizeSessionBatch, sourceGenerationDigest } from './normalization.js';

export interface ImportLimits extends ImportByteLimits {
  maxRecords: number;
  batchSize: number;
}
export interface ImportRequest {
  source: SessionSource;
  selectedSource: SelectedSource;
  adapter: SessionSourceAdapter;
  workspaceId: string;
  policyVersion: string;
  limits?: Partial<ImportLimits>;
  batchRunId?: string;
  publish?: boolean;
  signal?: AbortSignal;
  inactivityThresholdMs?: number;
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  maxRecords: 1_000_000,
  ...DEFAULT_IMPORT_BYTE_LIMITS,
  batchSize: 1_000,
};

export interface SessionImportFailureReceipt {
  contractVersion: '1.0.0';
  outcome: 'terminal-failure';
  sourceId: string;
  sourceGeneration: string;
  consistency: SessionSource['consistency'];
  committedPrefix: {
    batches: number;
    records: number;
    events: number;
  };
  resumableCheckpoint: ImportCheckpoint;
  errorCode: string;
  detail?: SessionRejectionDetail;
}

export class SessionImportFailure extends SessionContractError {
  constructor(
    public readonly failureReceipt: SessionImportFailureReceipt,
    cause: unknown,
  ) {
    super(
      cause instanceof SessionContractError ? cause.code : 'IMPORT_INTERRUPTED',
      cause instanceof Error ? cause.message : 'session import failed',
      cause instanceof SessionContractError ? cause.detail : undefined,
    );
    this.failureReceipt = redactSessionValue(failureReceipt).value;
    this.name = 'SessionImportFailure';
  }
}

export class IncrementalSessionImporter {
  constructor(private readonly repository: SessionRepositoryPort) {}

  async import(request: ImportRequest): Promise<ImportReceipt[]> {
    assertSupportedSchemaMajor(request.source.sourceSchemaVersion, request.adapter.sourceSchemaMajor ?? 1);
    if (request.inactivityThresholdMs !== undefined
      && (!Number.isFinite(request.inactivityThresholdMs) || request.inactivityThresholdMs < 0)) {
      throw new SessionContractError(
        'INVALID_ARGUMENT',
        'session inactivity threshold must be a non-negative duration',
      );
    }
    if (request.workspaceId !== request.selectedSource.authorizedScope.workspaceId) {
      throw new SessionContractError(
        'SOURCE_NOT_AUTHORIZED',
        'session import workspace is outside the authorized source scope',
      );
    }
    const limits = { ...DEFAULT_IMPORT_LIMITS, ...resolveImportLimits(undefined, {
      maxRecordBytes: request.limits?.maxRecordBytes, maxSourceBytes: request.limits?.maxTotalBytes,
    }), ...request.limits };
    const previous = request.batchRunId
      ? this.repository.getBatchCheckpoint(
          request.source.sourceId,
          request.adapter.adapterVersion,
          request.batchRunId,
        ) ?? this.repository.getCheckpoint(
          request.source.sourceId,
          request.adapter.adapterVersion,
        )
      : this.repository.getCheckpoint(
          request.source.sourceId,
          request.adapter.adapterVersion,
        );
    const continuity = await sourceContinuity(request, previous);
    const sourceObservedAt = continuity
      ? new Date(continuity.mtimeMs).toISOString()
      : undefined;
    const sourceGeneration = continuity?.sourceGeneration ?? sourceGenerationDigest(request);
    if (previous?.sourceGeneration && previous.sourceGeneration !== sourceGeneration) {
      throw new SessionContractError(
        'SCHEMA_DRIFT',
        'session source generation changed; explicit restart or migration is required',
        schemaIssueDetail('sourceGeneration'),
      );
    }
    if (previous?.adapterVersion && previous.adapterVersion !== request.adapter.adapterVersion) {
      throw new SessionContractError(
        'SCHEMA_DRIFT',
        'session checkpoint adapter version changed; checkpoint migration is required',
        schemaIssueDetail('adapterVersion'),
      );
    }
    if (previous?.sourceSchemaVersion
      && previous.sourceSchemaVersion !== request.source.sourceSchemaVersion) {
      throw new SessionContractError(
        'SCHEMA_DRIFT',
        'session checkpoint source schema changed; checkpoint migration is required',
        schemaIssueDetail('sourceSchemaVersion'),
      );
    }
    if (previous?.policyVersion && previous.policyVersion !== request.policyVersion) {
      throw new SessionContractError(
        'SCHEMA_DRIFT',
        'session checkpoint policy version changed; checkpoint migration is required',
        schemaIssueDetail('policyVersion'),
      );
    }
    const checkpoint: ImportCheckpoint = {
      cursor: previous?.cursor ?? '',
      recordsRead: previous?.recordsRead ?? 0,
      bytesRead: previous?.bytesRead ?? 0,
      checkpointVersion: '2',
      positionKind: previous?.positionKind ?? 'record-index',
      sourceGeneration,
      locatorClass: request.selectedSource.locatorClass,
      adapterVersion: request.adapter.adapterVersion,
      sourceSchemaVersion: request.source.sourceSchemaVersion,
      policyVersion: request.policyVersion,
      continuity: continuity
        ? (!previous || previous.positionKind === 'byte-offset'
            || previous.positionKind === 'provider-native'
            ? continuity.outcome
            : 'unverified')
        : (previous ? 'unverified' : 'new-generation'),
      sourceSize: continuity?.size,
      sourceMtimeMs: continuity?.mtimeMs,
      sourceFileIdentity: continuity?.fileIdentity,
      prefixDigest: continuity?.prefixDigest,
    };
    const receipts: ImportReceipt[] = [];
    let batch: ProviderRecord[] = [];
    let batchBytes = 0;
    let batchStart = checkpoint.recordsRead;
    let durableCheckpoint = { ...checkpoint };
    const importStarted = performance.now();
    let peakHeap = process.memoryUsage().heapUsed;
    let peakRss = process.memoryUsage().rss;

    const flush = (): void => {
      if (batch.length === 0) return;
      if (request.signal?.aborted) {
        throw new SessionContractError(
          'IMPORT_INTERRUPTED',
          'session import was cancelled at a durable batch boundary',
        );
      }
      const identities = batch.map(recordIdentity);
      const batchDigests = identities.map(identity => identity.digest);
      const runId = sha256([
        request.source.sourceId, request.adapter.adapterVersion,
        batchStart, checkpoint.recordsRead,
        ...batchDigests,
      ].join('\0'));
      const normalized = normalizeSessionBatch(request, batch, batchDigests, runId, sourceObservedAt);
      const run: ImportRun = {
        contractVersion: SESSION_CONTRACT_VERSION,
        importRunId: runId,
        sourceId: request.source.sourceId,
        parserVersion: request.adapter.adapterVersion,
        policyVersion: request.policyVersion,
        sourceSchemaVersion: request.source.sourceSchemaVersion,
        consistency: request.source.consistency,
        status: 'running',
        checkpoint: { ...checkpoint },
        startedAt: new Date().toISOString(),
        completedAt: null,
        errorCode: null,
      };
      const flushStarted = performance.now();
      const sanitizedSource = {
        ...request.source,
        extensions: sanitizeNativeExtensions(request.source.extensions).value,
      };
      const receipt = this.repository.applyImport({
        source: sanitizedSource, run,
        sessions: normalized.sessions, events: normalized.events,
        batchRunId: request.batchRunId,
        imageBlobs: normalized.imageBlobs,
      }, { ...checkpoint }, request.publish ?? request.source.consistency !== 'complete');
      const memory = process.memoryUsage();
      peakHeap = Math.max(peakHeap, memory.heapUsed);
      peakRss = Math.max(peakRss, memory.rss);
      receipt.metrics = {
        records: batch.length,
        normalizedEvents: normalized.events.length,
        normalizedBytes: identities.reduce((bytes, identity) => bytes + identity.bytes, 0),
        durationMs: performance.now() - importStarted,
        batchLatencyMs: performance.now() - flushStarted,
        heapUsedBytes: peakHeap,
        rssBytes: peakRss,
        checkpointDurable: true,
      };
      receipts.push(receipt);
      durableCheckpoint = { ...checkpoint };
      batch = [];
      batchBytes = 0;
      batchStart = checkpoint.recordsRead;
    };

    try {
      if (continuity) assertImportByteLimit('maxTotalBytes', limits, continuity.size);
      for await (const record of request.adapter.stream(
        request.selectedSource,
        previous ? { value: previous.cursor } : undefined,
      )) {
        if (request.signal?.aborted) {
          throw new SessionContractError(
            'IMPORT_INTERRUPTED',
            'session import was cancelled and can resume from its durable checkpoint',
          );
        }
        const bytes = recordBytes(record);
        assertImportByteLimit('maxRecordBytes', limits, bytes);
        if (!continuity) assertImportByteLimit('maxTotalBytes', limits, checkpoint.bytesRead + bytes);
        assertSessionResourceLimit('maxRecords', limits.maxRecords, checkpoint.recordsRead + 1);
        // Bound batches by bytes as well as record count for large records.
        if (batchBytes + bytes > 4 * 1024 * 1024) flush();
        batch.push(record);
        batchBytes += bytes;
        checkpoint.recordsRead += 1;
        if (record.sourceCursor?.startsWith('byte:')) {
          checkpoint.positionKind = 'byte-offset';
          checkpoint.cursor = record.sourceCursor;
          checkpoint.bytesRead = Number(record.sourceCursor.slice(5));
        } else if (record.sourceCursor?.startsWith('native:')) {
          // An opaque provider-native resume token (e.g. a monotonic native
          // sequence) — never a byte offset. Stored verbatim; `bytesRead`
          // still accumulates so resource limits remain meaningful.
          checkpoint.positionKind = 'provider-native';
          checkpoint.cursor = record.sourceCursor;
          checkpoint.bytesRead += bytes;
        } else {
          checkpoint.bytesRead += bytes;
          // Older Pi adapters exposed bare byte counts without a byte: tag;
          // those checkpoints historically counted records instead.
          checkpoint.cursor = request.adapter.provider === 'pi' ? String(checkpoint.recordsRead)
            : record.sourceCursor ?? String(checkpoint.recordsRead);
        }
        if (batch.length >= limits.batchSize) flush();
      }
      flush();
    } catch (error) {
      const published = request.publish ?? request.source.consistency !== 'complete';
      const committed = published ? receipts : [];
      throw new SessionImportFailure({
        contractVersion: '1.0.0',
        outcome: 'terminal-failure',
        sourceId: request.source.sourceId,
        sourceGeneration,
        consistency: request.source.consistency,
        committedPrefix: {
          batches: committed.length,
          records: committed.reduce(
            (total, receipt) => total + (receipt.metrics?.records ?? 0),
            0,
          ),
          events: committed.reduce((total, receipt) => total + receipt.eventsInserted, 0),
        },
        resumableCheckpoint: !published
          ? {
              ...durableCheckpoint,
              cursor: '',
              recordsRead: 0,
              bytesRead: 0,
              continuity: 'new-generation',
            }
          : durableCheckpoint,
        errorCode: error instanceof SessionContractError
          ? error.code : 'IMPORT_INTERRUPTED',
        detail: error instanceof SessionContractError ? error.detail : undefined,
      }, error);
    }
    if (request.publish !== false && request.source.consistency === 'complete') {
      this.repository.commitStagedImports(request.source.sourceId, request.adapter.adapterVersion);
      for (const receipt of receipts) {
        if (receipt.outcome === 'staged') receipt.outcome = 'committed';
      }
    }
    return receipts;
  }
}

/** Keep large temporary JSON strings out of the asynchronous import frame. */
function recordBytes(record: ProviderRecord): number {
  return Buffer.byteLength(JSON.stringify(record));
}

/** Compute flush-time identity once, preserving adapters that mutate yielded objects. */
function recordIdentity(record: ProviderRecord): { bytes: number; digest: string } {
  const serialized = JSON.stringify(record);
  return { bytes: Buffer.byteLength(serialized), digest: sha256(serialized) };
}

async function sourceContinuity(
  request: ImportRequest,
  previous: ImportCheckpoint | null,
): Promise<{
  sourceGeneration: string;
  outcome: 'new-generation' | 'validated-append' | 'unchanged-replay';
  size: number;
  mtimeMs: number;
  fileIdentity: string;
  prefixDigest: `sha256:${string}`;
} | null> {
  if (request.selectedSource.authorizedScope.allowedRoots.length === 0
    || /^[a-z][a-z0-9+.-]*:\/\//i.test(request.selectedSource.locator)
    || request.selectedSource.locator.startsWith('<')) {
    return null;
  }
  const authorization = {
    selectedPath: request.selectedSource.locator,
    allowedRoots: request.selectedSource.authorizedScope.allowedRoots,
  };
  // Snapshot sources are rewritten wholesale on every save (no stable
  // append-only byte region, and the file identity may legitimately change
  // via rename-swap): skip the shrink, file-identity, and prefix-rewrite
  // throws below. Idempotency instead rests on the adapter's own monotonic
  // native cursor plus the catalog's identity-keyed inserts.
  const isSnapshot = request.adapter.sourceContinuity === 'snapshot';
  const skipPrefixBytes = await request.adapter.mutablePrefixBytes?.(request.selectedSource) ?? 0;
  const metadata = await fingerprintSourcePrefix(authorization, 0);
  if (!isSnapshot && previous?.sourceSize !== undefined) {
    if (metadata.size < previous.sourceSize) {
      throw new SessionContractError(
        'SCHEMA_DRIFT',
        'session source was truncated before its durable checkpoint',
        schemaIssueDetail('sourceSize'),
      );
    }
    const identicalRestaging = request.adapter.provider === 'codex'
      && metadata.size === previous.sourceSize
      && (await fingerprintSourcePrefix(authorization, metadata.size, skipPrefixBytes)).digest === previous.prefixDigest;
    if (!identicalRestaging && previous.sourceFileIdentity
      && previous.sourceFileIdentity !== metadata.fileIdentity) {
      throw new SessionContractError(
        'SCHEMA_DRIFT',
        'session source file generation was replaced or rotated',
        schemaIssueDetail('sourceFileIdentity'),
      );
    }
    const priorPrefix = await fingerprintSourcePrefix(authorization, previous.sourceSize, skipPrefixBytes);
    if (previous.prefixDigest && priorPrefix.digest !== previous.prefixDigest) {
      throw new SessionContractError(
        'SCHEMA_DRIFT',
        'session source prefix was rewritten before its durable checkpoint',
        schemaIssueDetail('prefixDigest'),
      );
    }
  }
  const current = await fingerprintSourcePrefix(authorization, metadata.size, skipPrefixBytes);
  const generation = previous?.sourceGeneration ?? (isSnapshot
    ? sourceGenerationDigest(request)
    : sha256([sourceGenerationDigest(request), metadata.fileIdentity].join('\0')));
  return {
    sourceGeneration: generation,
    outcome: !previous
      ? 'new-generation'
      : isSnapshot
        ? (current.digest === previous.prefixDigest ? 'unchanged-replay' : 'validated-append')
        : metadata.size === previous.sourceSize
          && current.digest === previous.prefixDigest
          ? 'unchanged-replay' : 'validated-append',
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    fileIdentity: metadata.fileIdentity,
    prefixDigest: current.digest as `sha256:${string}`,
  };
}
