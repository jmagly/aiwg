import { requireFeaturePackage } from '../features/runtime.js';
import type {
  CandidateReviewReceipt, DeletionReceipt, ImportCheckpoint, ImportRun,
  IntelligenceCandidate, PromotionDependencyDecision, PromotionReceipt,
  Session, SessionEvent, SessionSource,
} from './contracts.js';
import {
  CandidateReviewReceiptSchema,
  DeletionReceiptSchema,
  IntelligenceCandidateSchema,
  PromotionDependencyDecisionSchema,
  PromotionReceiptSchema,
  SessionContractError,
  sha256,
} from './contracts.js';
import {
  coverageFromBatchRun,
  type BatchImportRun,
  type SessionCoverageReport,
} from './batch-contracts.js';
import { redactSessionText, sanitizeNativeExtensions } from './policy.js';
import type { TimelineInput } from './timeline.js';
import {
  deriveSessionAnalytics,
  type SessionAnalyticsCategory,
  type SessionAnalyticsFact,
  type SessionAnalyticsStatus,
} from './analytics.js';

const POLICY_PROVIDER_MIGRATION = 'policy-provider-identity:v2';
const EVENT_ORIGIN_INTENT_MIGRATION = 'event-origin-intent:v1';
const VISIBLE_SESSION_PREDICATE = `s.lifecycle != 'tombstoned' AND EXISTS (
  SELECT 1 FROM session_events e
  JOIN import_runs r ON r.import_run_id=e.import_run_id
  WHERE e.session_id=s.session_id AND r.status='committed'
)`;

interface SqliteStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
}
interface SqliteDatabase {
  exec(sql: string): void;
  pragma(value: string): unknown;
  prepare(sql: string): SqliteStatement;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
  close(): void;
}

export interface NormalizedImportBatch {
  source: SessionSource;
  run: ImportRun;
  sessions: Session[];
  events: SessionEvent[];
  batchRunId?: string;
}
export interface ImportReceipt {
  operationId: string;
  outcome: 'staged' | 'committed' | 'duplicate';
  sessionsInserted: number;
  eventsInserted: number;
  checkpoint: ImportCheckpoint;
  metrics?: {
    records: number;
    normalizedEvents: number;
    normalizedBytes: number;
    durationMs: number;
    batchLatencyMs: number;
    heapUsedBytes: number;
    rssBytes: number;
    checkpointDurable: true;
  };
}

export interface SessionListOptions {
  provider?: string;
  workspaceId?: string;
  tag?: string;
  limit: number;
  cursor?: string;
  /** @deprecated Compatibility only. New callers must use cursor. */
  offset?: number;
}

export interface SessionListResult {
  items: Session[];
  total: number;
  nextCursor: string | null;
  snapshotRowid: number;
}

export interface SessionCatalogHealth {
  integrity: 'ok' | 'failed';
  indexIntegrity: 'ok' | 'failed';
  sources: number;
  sessions: number;
  events: number;
  stagedImports: number;
}

export interface SessionPurgePreview {
  contractVersion: '1.0.0';
  operationId: string;
  scopeClass: 'session';
  sessionId: string;
  workspaceId?: string;
  counts: Record<string, number>;
  promotedDependents: Array<{
    dependentId: string;
    candidateId: string;
    candidateVersion: number;
    consumer: string;
    destinationRef: string;
  }>;
  confirmationRequired: true;
}

export interface PromotionProvenanceReceipt {
  contractVersion: '1.0.0';
  receiptId: string;
  operationId: string;
  dependentId: string;
  candidateId: string;
  candidateVersion: number;
  consumer: string;
  destinationRef: string;
  evidenceEventIds: string[];
  action: PromotionDependencyDecision['action'];
  basis: string;
  originAvailable: boolean;
  occurredAt: string;
}

export interface SessionSearchOptions {
  query: string;
  workspaceId: string;
  providers?: string[];
  dateFrom?: string;
  dateTo?: string;
  participant?: string;
  model?: string;
  role?: string;
  tool?: string;
  tag?: string;
  entity?: string;
  sensitivity?: string;
  extractionState?: string;
  controlEvents?: 'exclude' | 'include' | 'only';
  sessionIds?: string[];
  limit: number;
  cursor?: string;
}

export interface SessionAuthorizationContext {
  actorId: string;
  workspaceId: string;
  operation: string;
  catalogScope: 'workspace';
  mode: 'local-owner' | 'shared';
}

export interface SessionSearchHit {
  score: number;
  snippet: string;
  provider: string;
  workspaceId: string;
  sessionId: string;
  origin: SessionEvent['origin'];
  eventId: string;
  importRunId: string;
  sourceId: string;
  locatorClass: string;
  sequence: number;
  role: string | null;
  nativeEventId: string | null;
  occurredAt: string | null;
  sensitivity: string;
  citation: {
    provider: string;
    sessionId: string;
    eventId: string;
    importRunId: string;
    sourceId: string;
    locatorClass: string;
    nativeEventId?: string;
  };
}

export interface SessionSearchResult {
  items: SessionSearchHit[];
  nextCursor: string | null;
}

export interface SessionSearchDocument extends SessionSearchHit {
  searchableText: string;
}

export interface AuthorizedDocumentPage {
  items: SessionSearchDocument[];
  nextCursor: string | null;
  snapshotRowid: number;
}

export interface MutationEvent {
  contractVersion: '1.0.0';
  operationId: string;
  correlationId: string;
  eventName: string;
  eventTime: string;
  observedAt: string;
  actorClass: string;
  authorizationClass: string;
  workspaceId: string;
  targetClass: string;
  outcome: 'staged' | 'committed' | 'failed' | 'preview' | 'duplicate';
  counts: Record<string, number>;
  adapterVersion: string;
  policyVersion: string;
  schemaVersion: string;
  resource: { service: 'aiwg.sessions'; workspaceId: string };
  instrumentationScope: { name: 'aiwg.sessions.repository'; version: '1.0.0' };
  integrityDigest: string;
}

export interface MutationAuditPage {
  items: MutationEvent[];
  nextCursor: string | null;
}

export interface SessionAnalyticsQuery {
  workspaceId: string;
  categories?: SessionAnalyticsCategory[];
  provider?: string;
  sessionId?: string;
  dateFrom?: string;
  dateTo?: string;
  tool?: string;
  status?: SessionAnalyticsStatus;
  actor?: string;
  tag?: string;
  sensitivity?: string;
  extractionState?: string;
  limit?: number;
}

export interface SessionAnalyticsSummary {
  analyticsVersion: '1.0.0';
  workspaceId: string;
  totals: {
    facts: number;
    sessions: number;
    toolCalls: number;
    toolFailures: number;
    escalations: number;
    hitlDecisions: number;
    indicators: number;
    retryGroups: number;
  };
  byCategory: Record<string, number>;
  byStatus: Record<string, number>;
  byProvider: Record<string, number>;
  byTool: Record<string, number>;
}

export class SessionRepository {
  private readonly db: SqliteDatabase;

  constructor(path = ':memory:') {
    let Database: new (path: string) => SqliteDatabase;
    try {
      Database = requireFeaturePackage('better-sqlite3') as new (path: string) => SqliteDatabase;
    } catch (cause) {
      throw new Error(
        'session SQLite catalog is unavailable because better-sqlite3 could not be loaded; ' +
        'run `aiwg features install sqlite`, then retry. If the native build fails, install ' +
        'Python 3, make, and a C/C++ compiler supported by node-gyp.',
        { cause },
      );
    }
    this.db = new Database(path);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_sources (
        source_id TEXT PRIMARY KEY, provider TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS import_runs (
        import_run_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, parser_version TEXT NOT NULL,
        status TEXT NOT NULL, checkpoint TEXT NOT NULL, data TEXT NOT NULL,
        batch_run_id TEXT,
        FOREIGN KEY(source_id) REFERENCES session_sources(source_id)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, native_session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL, source_digest TEXT NOT NULL, lifecycle TEXT NOT NULL, data TEXT NOT NULL,
        UNIQUE(source_id, native_session_id, source_digest),
        FOREIGN KEY(source_id) REFERENCES session_sources(source_id)
      );
      CREATE TABLE IF NOT EXISTS session_events (
        event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, source_id TEXT NOT NULL,
        import_run_id TEXT NOT NULL, sequence_no INTEGER NOT NULL, digest TEXT NOT NULL, data TEXT NOT NULL,
        UNIQUE(session_id, event_id, digest),
        FOREIGN KEY(session_id) REFERENCES sessions(session_id),
        FOREIGN KEY(source_id) REFERENCES session_sources(source_id),
        FOREIGN KEY(import_run_id) REFERENCES import_runs(import_run_id)
      );
      CREATE TABLE IF NOT EXISTS import_receipts (
        operation_id TEXT PRIMARY KEY, import_run_id TEXT NOT NULL UNIQUE,
        outcome TEXT NOT NULL, counts TEXT NOT NULL, checkpoint TEXT NOT NULL,
        FOREIGN KEY(import_run_id) REFERENCES import_runs(import_run_id)
      );
      CREATE TABLE IF NOT EXISTS batch_import_runs (
        batch_run_id TEXT PRIMARY KEY, manifest_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL, status TEXT NOT NULL,
        started_at TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL,
        UNIQUE(manifest_id, workspace_id)
      );
      CREATE TABLE IF NOT EXISTS mutation_audit (
        operation_id TEXT PRIMARY KEY, operation TEXT NOT NULL, actor TEXT NOT NULL,
        counts TEXT NOT NULL, adapter_version TEXT NOT NULL, policy_version TEXT NOT NULL,
        outcome TEXT NOT NULL, occurred_at TEXT NOT NULL,
        workspace_id TEXT, target_class TEXT, data TEXT
      );
      CREATE TABLE IF NOT EXISTS session_tags (
        session_id TEXT NOT NULL, tag TEXT NOT NULL,
        PRIMARY KEY(session_id, tag),
        FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS intelligence_candidates (
        candidate_id TEXT NOT NULL, version INTEGER NOT NULL,
        review_state TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(candidate_id, version)
      );
      CREATE TABLE IF NOT EXISTS candidate_review_receipts (
        receipt_id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL,
        candidate_version INTEGER NOT NULL, data TEXT NOT NULL,
        FOREIGN KEY(candidate_id, candidate_version)
          REFERENCES intelligence_candidates(candidate_id, version)
      );
      CREATE TABLE IF NOT EXISTS promotion_receipts (
        receipt_id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL,
        candidate_version INTEGER NOT NULL, consumer TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE(candidate_id, candidate_version, consumer),
        FOREIGN KEY(candidate_id, candidate_version)
          REFERENCES intelligence_candidates(candidate_id, version)
      );
      CREATE TABLE IF NOT EXISTS deletion_receipts (
        operation_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL,
        workspace_id TEXT, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS promotion_dependency_decisions (
        operation_id TEXT NOT NULL, dependent_id TEXT NOT NULL,
        action TEXT NOT NULL, basis TEXT NOT NULL,
        PRIMARY KEY(operation_id, dependent_id)
      );
      CREATE TABLE IF NOT EXISTS promotion_provenance_receipts (
        receipt_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL,
        dependent_id TEXT NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL,
        UNIQUE(operation_id, dependent_id)
      );
      CREATE TABLE IF NOT EXISTS session_catalog_meta (
        key TEXT PRIMARY KEY, value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_analytics_facts (
        fact_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL, event_id TEXT NOT NULL,
        category TEXT NOT NULL, status TEXT NOT NULL,
        provider TEXT NOT NULL, tool_name TEXT, occurred_at TEXT,
        data TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
        FOREIGN KEY(event_id) REFERENCES session_events(event_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_session_workspace_provider
        ON sessions(workspace_id, source_id, lifecycle);
      CREATE INDEX IF NOT EXISTS idx_event_session_sequence
        ON session_events(session_id, sequence_no);
      CREATE INDEX IF NOT EXISTS idx_event_source_run
        ON session_events(source_id, import_run_id);
      CREATE INDEX IF NOT EXISTS idx_event_import_run_session
        ON session_events(import_run_id, session_id);
      CREATE INDEX IF NOT EXISTS idx_session_analytics_session
        ON session_analytics_facts(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_analytics_scope
        ON session_analytics_facts(
          workspace_id, category, provider, status, occurred_at, fact_id
        );
      CREATE VIRTUAL TABLE IF NOT EXISTS session_event_fts USING fts5(
        event_id UNINDEXED, searchable_text, tokenize='unicode61'
      );
      -- FTS5 stores event_id in c0. A covering index checks identity/rowid
      -- alignment without reading searchable text or event JSON.
      CREATE INDEX IF NOT EXISTS idx_fts_event_id ON session_event_fts_content(c0);
    `);
    const deletionReceiptColumns = this.db.prepare(
      'PRAGMA table_info(deletion_receipts)',
    ).all().map((row) => String(row.name));
    if (!deletionReceiptColumns.includes('workspace_id')) {
      this.db.exec('ALTER TABLE deletion_receipts ADD COLUMN workspace_id TEXT');
    }
    const mutationColumns = this.db.prepare(
      'PRAGMA table_info(mutation_audit)',
    ).all().map((row) => String(row.name));
    if (!mutationColumns.includes('workspace_id')) {
      this.db.exec('ALTER TABLE mutation_audit ADD COLUMN workspace_id TEXT');
    }
    if (!mutationColumns.includes('target_class')) {
      this.db.exec('ALTER TABLE mutation_audit ADD COLUMN target_class TEXT');
    }
    if (!mutationColumns.includes('data')) {
      this.db.exec('ALTER TABLE mutation_audit ADD COLUMN data TEXT');
    }
    const importRunColumns = this.db.prepare(
      'PRAGMA table_info(import_runs)',
    ).all().map((row) => String(row.name));
    if (!importRunColumns.includes('batch_run_id')) {
      this.db.exec('ALTER TABLE import_runs ADD COLUMN batch_run_id TEXT');
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_mutation_audit_workspace
      ON mutation_audit(workspace_id, occurred_at, operation_id)
      ;
      CREATE INDEX IF NOT EXISTS idx_import_runs_batch
      ON import_runs(batch_run_id);
      CREATE INDEX IF NOT EXISTS idx_batch_import_workspace
      ON batch_import_runs(workspace_id, updated_at, batch_run_id)
    `);
    this.initializeAnalyticsVerification();
    this.alignSessionFtsRowids();
    this.migrateSessionPolicyAndProviderIdentity();
    this.migrateEventOriginAndIntent();
    this.alignSessionAnalytics();
  }

  private initializeAnalyticsVerification(): void {
    // Invalidate verification even for writes from another connection. Ordinary
    // repository mutations maintain analytics in the same transaction below.
    this.db.transaction(() => {
      this.db.prepare(
        'INSERT OR IGNORE INTO session_catalog_meta(key, value) VALUES (?, ?)',
      ).run('consistency:analytics:v1', 'dirty');
      for (const table of [
        'session_events', 'session_analytics_facts', 'sessions', 'session_sources', 'import_runs',
      ]) {
        for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
          this.db.exec(`
            CREATE TRIGGER IF NOT EXISTS consistency_${table}_${operation.toLowerCase()}
            AFTER ${operation} ON ${table}
            BEGIN
              UPDATE session_catalog_meta SET value='dirty'
              WHERE key='consistency:analytics:v1' AND value!='dirty';
            END;
          `);
        }
      }
    })();
  }

  private analyticsVerified(): boolean {
    return this.db.prepare(
      'SELECT value FROM session_catalog_meta WHERE key=?',
    ).get('consistency:analytics:v1')?.value === 'verified';
  }

  private markAnalyticsVerified(): void {
    this.db.prepare(
      'UPDATE session_catalog_meta SET value=? WHERE key=?',
    ).run('verified', 'consistency:analytics:v1');
  }

  private maintainedAnalyticsTransaction<T>(mutate: () => T): () => T {
    return this.db.transaction(() => {
      const verified = this.analyticsVerified();
      const result = mutate();
      // A scoped mutation must not hide pre-existing damage elsewhere.
      if (verified) this.markAnalyticsVerified();
      return result;
    });
  }

  private alignSessionAnalytics(): void {
    this.db.transaction(() => {
      if (this.analyticsVerified()) return;
      this.rebuildAnalytics();
    })();
  }

  private alignSessionFtsRowids(): void {
    this.db.transaction(() => {
      const eventCount = Number(this.db.prepare(
        'SELECT COUNT(*) AS count FROM session_events',
      ).get()?.count ?? 0);
      const ftsCount = Number(this.db.prepare(
        'SELECT COUNT(*) AS count FROM session_event_fts_content',
      ).get()?.count ?? 0);
      const mismatch = this.db.prepare(
        `SELECT 1 AS mismatch
         FROM session_event_fts_content f
         LEFT JOIN session_events e ON e.event_id=f.c0
         WHERE e.rowid IS NULL OR e.rowid!=f.id
         LIMIT 1`,
      ).get();
      if (eventCount === ftsCount && !mismatch) return;
      this.db.exec('DELETE FROM session_event_fts');
      this.db.exec(`
        INSERT INTO session_event_fts(rowid, event_id, searchable_text)
        SELECT rowid, event_id, json_extract(data, '$.searchableText')
        FROM session_events
      `);
    })();
  }

  private migrateSessionPolicyAndProviderIdentity(): void {
    this.runCatalogMigration(POLICY_PROVIDER_MIGRATION, () => {
      for (const row of this.db.prepare(
        'SELECT source_id, provider, data FROM session_sources',
      ).all()) {
        const source = JSON.parse(String(row.data)) as
          Omit<SessionSource, 'provider'> & { provider: string };
        const canonicalProvider = source.provider === 'windsurf'
          ? 'devin-desktop' : source.provider;
        const extensions = renameNativeWindsurfEnvelope(source.extensions);
        source.provider = canonicalProvider;
        source.locatorClass = canonicalDevinLocator(source.locatorClass);
        source.extensions = sanitizeNativeExtensions(extensions).value;
        this.db.prepare(
          'UPDATE session_sources SET provider=?, data=? WHERE source_id=?',
        ).run(canonicalProvider, JSON.stringify(source), String(row.source_id));
      }
      for (const row of this.db.prepare(
        'SELECT session_id, data FROM sessions',
      ).all()) {
        const session = JSON.parse(String(row.data)) as
          Omit<Session, 'provider'> & { provider: string };
        if (session.provider === 'windsurf') session.provider = 'devin-desktop';
        session.extensions = sanitizeSessionExtensions(
          renameNativeWindsurfEnvelope(session.extensions),
          session.provider,
        );
        this.db.prepare('UPDATE sessions SET data=? WHERE session_id=?')
          .run(JSON.stringify(session), String(row.session_id));
      }
      for (const row of this.db.prepare(
        'SELECT rowid AS event_rowid, event_id, data FROM session_events',
      ).all()) {
        const event = JSON.parse(String(row.data)) as SessionEvent;
        const text = redactSessionText(event.searchableText);
        const native = sanitizeNativeExtensions(
          renameNativeWindsurfEnvelope(event.extensions),
        );
        event.searchableText = text.text;
        event.kind = event.kind.startsWith('windsurf.')
          ? `devin-desktop.${event.kind.slice('windsurf.'.length)}` : event.kind;
        event.rawReference.locatorClass = canonicalDevinLocator(
          event.rawReference.locatorClass,
        );
        event.extensions = native.value;
        event.sensitivity = {
          classification:
            text.sensitivity === 'sensitive' || native.sensitivity === 'sensitive'
              ? 'sensitive' : 'none',
          classes: [...new Set([
            ...event.sensitivity.classes,
            ...text.classes,
            ...native.classes,
          ])].sort(),
        };
        this.db.prepare('UPDATE session_events SET data=? WHERE event_id=?')
          .run(JSON.stringify(event), String(row.event_id));
        this.db.prepare(
          'UPDATE session_event_fts SET searchable_text=? WHERE rowid=?',
        ).run(event.searchableText, Number(row.event_rowid));
      }
      for (const row of this.db.prepare(
        `SELECT m.operation_id, m.operation, m.actor, m.counts,
                m.adapter_version, m.policy_version, m.outcome, m.occurred_at,
                COALESCE(
                  (SELECT s.workspace_id
                   FROM import_runs r
                   JOIN sessions s ON s.source_id=r.source_id
                   WHERE r.import_run_id=m.operation_id
                   LIMIT 1),
                  'legacy'
                ) AS inferred_workspace
         FROM mutation_audit m
         WHERE m.data IS NULL`,
      ).all()) {
        const workspaceId = String(row.inferred_workspace);
        const unsigned = {
          contractVersion: '1.0.0' as const,
          operationId: String(row.operation_id),
          correlationId: String(row.operation_id),
          eventName: String(row.operation),
          eventTime: String(row.occurred_at),
          observedAt: String(row.occurred_at),
          actorClass: String(row.actor),
          authorizationClass: 'legacy-local-operator',
          workspaceId,
          targetClass: 'session-catalog',
          outcome: String(row.outcome) as MutationEvent['outcome'],
          counts: JSON.parse(String(row.counts)) as Record<string, number>,
          adapterVersion: String(row.adapter_version),
          policyVersion: String(row.policy_version),
          schemaVersion: 'legacy-1.0.0',
          resource: { service: 'aiwg.sessions' as const, workspaceId },
          instrumentationScope: {
            name: 'aiwg.sessions.repository' as const,
            version: '1.0.0' as const,
          },
        };
        const event: MutationEvent = {
          ...unsigned,
          integrityDigest: sha256(JSON.stringify(unsigned)),
        };
        this.db.prepare(
          `UPDATE mutation_audit
           SET workspace_id=?, target_class=?, data=?
           WHERE operation_id=?`,
        ).run(
          workspaceId,
          event.targetClass,
          JSON.stringify(event),
          event.operationId,
        );
      }
    });
  }

  private migrateEventOriginAndIntent(): void {
    this.runCatalogMigration(EVENT_ORIGIN_INTENT_MIGRATION, () => {
      for (const row of this.db.prepare(
        'SELECT event_id, data FROM session_events',
      ).all()) {
        const event = JSON.parse(String(row.data)) as Record<string, unknown>;
        let changed = false;
        if (typeof event.origin !== 'string') {
          event.origin = 'unknown';
          event.originRule = 'legacy:unknown';
          event.originClassifierVersion = '1.0.0';
          changed = true;
        }
        if (!Object.hasOwn(event, 'activityBoundary')) {
          event.activityBoundary = null;
          event.activityBoundaryBasis = null;
          event.activityBoundaryConfidence = null;
          changed = true;
        }
        if (changed) {
          this.db.prepare(
            'UPDATE session_events SET data=? WHERE event_id=?',
          ).run(JSON.stringify(event), String(row.event_id));
        }
      }
      for (const row of this.db.prepare(
        'SELECT session_id, data FROM sessions',
      ).all()) {
        const session = JSON.parse(String(row.data)) as Record<string, unknown>;
        if (session.intent !== undefined) continue;
        session.intent = {
          status: 'unknown',
          eventId: null,
          sequence: null,
          title: null,
          summary: null,
        };
        this.db.prepare(
          'UPDATE sessions SET data=? WHERE session_id=?',
        ).run(JSON.stringify(session), String(row.session_id));
      }
    });
  }

  private runCatalogMigration(migration: string, migrate: () => void): void {
    const applied = this.db.prepare(
      'SELECT 1 AS applied FROM session_catalog_meta WHERE key=?',
    ).get(migration);
    if (applied) return;
    const transaction = this.db.transaction(() => {
      migrate();
      this.db.prepare(
        'INSERT INTO session_catalog_meta (key, value) VALUES (?, ?)',
      ).run(migration, 'applied');
    });
    transaction();
  }

  private emitMutation(input: Omit<MutationEvent, 'contractVersion' | 'resource'
    | 'instrumentationScope' | 'integrityDigest'>): MutationEvent {
    const unsigned = {
      contractVersion: '1.0.0' as const,
      ...input,
      counts: Object.fromEntries(
        Object.entries(input.counts)
          .slice(0, 32)
          .map(([key, value]) => [key, Math.max(0, Math.min(
            Number.MAX_SAFE_INTEGER,
            Number.isFinite(value) ? Math.trunc(value) : 0,
          ))]),
      ),
      resource: { service: 'aiwg.sessions' as const, workspaceId: input.workspaceId },
      instrumentationScope: {
        name: 'aiwg.sessions.repository' as const,
        version: '1.0.0' as const,
      },
    };
    const event: MutationEvent = {
      ...unsigned,
      integrityDigest: sha256(JSON.stringify(unsigned)),
    };
    this.db.prepare(
      `INSERT OR IGNORE INTO mutation_audit
       (operation_id, operation, actor, counts, adapter_version, policy_version,
        outcome, occurred_at, workspace_id, target_class, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.operationId,
      event.eventName,
      event.actorClass,
      JSON.stringify(event.counts),
      event.adapterVersion,
      event.policyVersion,
      event.outcome,
      event.observedAt,
      event.workspaceId,
      event.targetClass,
      JSON.stringify(event),
    );
    return event;
  }

  private emitRepositoryMutation(input: {
    operationId: string;
    eventName: string;
    workspaceId: string;
    targetClass: string;
    outcome?: MutationEvent['outcome'];
    counts?: Record<string, number>;
    actorClass?: string;
    eventTime?: string;
  }): MutationEvent {
    const observedAt = new Date().toISOString();
    return this.emitMutation({
      operationId: input.operationId,
      correlationId: input.operationId,
      eventName: input.eventName,
      eventTime: input.eventTime ?? observedAt,
      observedAt,
      actorClass: input.actorClass ?? 'local-operator',
      authorizationClass: 'workspace-owner',
      workspaceId: input.workspaceId,
      targetClass: input.targetClass,
      outcome: input.outcome ?? 'committed',
      counts: input.counts ?? { affected: 1 },
      adapterVersion: 'repository-1.0.0',
      policyVersion: '1.0.0',
      schemaVersion: '1.0.0',
    });
  }

  private workspaceForSession(sessionId: string): string | null {
    const row = this.db.prepare(
      'SELECT workspace_id FROM sessions WHERE session_id=?',
    ).get(sessionId);
    return row ? String(row.workspace_id) : null;
  }

  private workspaceForCandidate(candidate: IntelligenceCandidate): string | null {
    const eventId = candidate.evidence[0]?.eventId;
    if (!eventId) return null;
    const row = this.db.prepare(
      `SELECT s.workspace_id FROM session_events e
       JOIN sessions s ON s.session_id=e.session_id WHERE e.event_id=?`,
    ).get(eventId);
    return row ? String(row.workspace_id) : null;
  }

  listMutationEvents(input: {
    workspaceId: string;
    limit: number;
    cursor?: string;
  }): MutationAuditPage {
    if (!input.workspaceId || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new SessionContractError(
        'OPERATION_NOT_AUTHORIZED',
        'audit reads require a workspace and a limit from 1 to 500',
      );
    }
    const after = decodeMutationCursor(input.cursor, input.workspaceId);
    const rows = this.db.prepare(
      `SELECT rowid, data FROM mutation_audit
       WHERE workspace_id=? AND rowid>?
       ORDER BY rowid LIMIT ?`,
    ).all(input.workspaceId, after, input.limit + 1);
    const page = rows.slice(0, input.limit);
    const items = page.map((row) => {
      const event = JSON.parse(String(row.data)) as MutationEvent;
      const { integrityDigest, ...unsigned } = event;
      if (integrityDigest !== sha256(JSON.stringify(unsigned))) {
        throw new SessionContractError('IMPORT_CONFLICT', 'mutation audit integrity check failed');
      }
      return event;
    });
    const last = page.at(-1);
    return {
      items,
      nextCursor: rows.length > input.limit && last
        ? encodeMutationCursor(Number(last.rowid), input.workspaceId) : null,
    };
  }

  exportMutationEventsOtel(input: {
    workspaceId: string;
    limit: number;
    cursor?: string;
  }): { records: Array<Record<string, unknown>>; nextCursor: string | null } {
    const page = this.listMutationEvents(input);
    return {
      records: page.items.map((event) => ({
        Timestamp: event.eventTime,
        ObservedTimestamp: event.observedAt,
        EventName: event.eventName,
        Body: {},
        Resource: event.resource,
        InstrumentationScope: event.instrumentationScope,
        Attributes: {
          operationId: event.operationId,
          correlationId: event.correlationId,
          actorClass: event.actorClass,
          authorizationClass: event.authorizationClass,
          targetClass: event.targetClass,
          outcome: event.outcome,
          counts: event.counts,
          adapterVersion: event.adapterVersion,
          policyVersion: event.policyVersion,
          schemaVersion: event.schemaVersion,
        },
      })),
      nextCursor: page.nextCursor,
    };
  }

  applyImport(
    batch: NormalizedImportBatch,
    checkpoint: ImportCheckpoint,
    publish = true,
  ): ImportReceipt {
    const apply = this.maintainedAnalyticsTransaction((): ImportReceipt => {
      const existing = this.db.prepare(
        'SELECT outcome, counts, checkpoint FROM import_receipts WHERE import_run_id = ?',
      ).get(batch.run.importRunId);
      if (existing) {
        const counts = JSON.parse(String(existing.counts)) as { sessions: number; events: number };
        return {
          operationId: batch.run.importRunId,
          outcome: 'duplicate',
          sessionsInserted: counts.sessions,
          eventsInserted: counts.events,
          checkpoint: JSON.parse(String(existing.checkpoint)) as ImportCheckpoint,
        };
      }
      this.db.prepare(
        `INSERT INTO session_sources(source_id, provider, data) VALUES (?, ?, ?)
         ON CONFLICT(source_id) DO UPDATE SET data=excluded.data`,
      ).run(batch.source.sourceId, batch.source.provider, JSON.stringify(batch.source));
      this.db.prepare(
        `INSERT INTO import_runs(
           import_run_id, source_id, parser_version, status, checkpoint, data, batch_run_id
         ) VALUES (?, ?, ?, 'running', ?, ?, ?)`,
      ).run(
        batch.run.importRunId,
        batch.source.sourceId,
        batch.run.parserVersion,
        JSON.stringify(checkpoint),
        JSON.stringify(batch.run),
        batch.batchRunId ?? null,
      );

      let sessionsInserted = 0;
      let eventsInserted = 0;
      for (const session of batch.sessions) {
        const priorRow = this.db.prepare(
          'SELECT data FROM sessions WHERE session_id=?',
        ).get(session.sessionId);
        if (!priorRow) {
          sessionsInserted += this.db.prepare(
            `INSERT INTO sessions
             (session_id, source_id, native_session_id, workspace_id, source_digest, lifecycle, data)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            session.sessionId, session.sourceId, session.nativeSessionId,
            session.workspaceId, session.sourceDigest, session.lifecycle, JSON.stringify(session),
          ).changes;
          continue;
        }
        const prior = JSON.parse(String(priorRow.data)) as Session;
        if (prior.workspaceId !== session.workspaceId
          || prior.sourceId !== session.sourceId
          || prior.nativeSessionId !== session.nativeSessionId) {
          throw new SessionContractError(
            'IMPORT_CONFLICT',
            'stable session identity changed authorization or source scope',
          );
        }
        const merged = mergeSessionAggregate(prior, session);
        this.db.prepare(
          `UPDATE sessions SET source_digest=?, lifecycle=?, data=? WHERE session_id=?`,
        ).run(
          merged.sourceDigest,
          merged.lifecycle,
          JSON.stringify(merged),
          merged.sessionId,
        );
      }
      const insertEvent = this.db.prepare(
        `INSERT OR IGNORE INTO session_events
         (event_id, session_id, source_id, import_run_id, sequence_no, digest, data)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const event of batch.events) {
        const prior = this.db.prepare('SELECT digest FROM session_events WHERE event_id=?')
          .get(event.eventId);
        if (prior && String(prior.digest) !== event.digest) {
          const priorEvent = this.db.prepare(
            `SELECT e.data AS event_data, src.provider AS provider, s.native_session_id AS native_session_id
             FROM session_events e
             JOIN sessions s ON s.session_id=e.session_id
             JOIN session_sources src ON src.source_id=e.source_id
             WHERE e.event_id=?`,
          ).get(event.eventId);
          const priorCoordinates = priorEvent
            ? safeEventCoordinates(String(priorEvent.event_data), {
                provider: String(priorEvent.provider),
                nativeSessionId: String(priorEvent.native_session_id),
              })
            : { provider: '<unknown>', sourceId: '<unknown>', nativeSessionId: '<unknown>', nativeEventId: event.eventId };
          const incomingCoordinates = {
            provider: batch.source.provider,
            sourceId: event.sourceId,
            nativeSessionId: batch.sessions.find((session) => session.sessionId === event.sessionId)
              ?.nativeSessionId ?? event.sessionId,
            nativeEventId: event.nativeId ?? `sequence:${event.sequence}`,
          };
          throw new SessionContractError(
            'IMPORT_CONFLICT',
            `stable event identity changed content: ${event.eventId}; prior=${formatEventCoordinates(priorCoordinates)} incoming=${formatEventCoordinates(incomingCoordinates)}`,
          );
        }
        const inserted = insertEvent.run(
          event.eventId, event.sessionId, event.sourceId,
          event.importRunId, event.sequence, event.digest, JSON.stringify(event),
        ).changes;
        eventsInserted += inserted;
        if (inserted > 0) {
          const eventRowid = Number(this.db.prepare(
            'SELECT rowid AS value FROM session_events WHERE event_id=?',
          ).get(event.eventId)?.value);
          this.db.prepare(
            `INSERT INTO session_event_fts(rowid, event_id, searchable_text)
             VALUES (?, ?, ?)`,
          ).run(eventRowid, event.eventId, event.searchableText);
        }
      }
      const outcome = publish ? 'committed' : 'staged';
      this.db.prepare(
        `UPDATE import_runs SET status=?, checkpoint=? WHERE import_run_id=?`,
      ).run(outcome, JSON.stringify(checkpoint), batch.run.importRunId);
      if (publish) {
        for (const session of batch.sessions) {
          this.rebuildAnalytics(session.workspaceId, session.sessionId);
        }
      }
      const counts = { sessions: sessionsInserted, events: eventsInserted };
      this.db.prepare(
        `INSERT INTO import_receipts(operation_id, import_run_id, outcome, counts, checkpoint)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(batch.run.importRunId, batch.run.importRunId, outcome, JSON.stringify(counts), JSON.stringify(checkpoint));
      const observedAt = new Date().toISOString();
      this.emitMutation({
        operationId: batch.run.importRunId,
        correlationId: batch.run.importRunId,
        eventName: 'session.import',
        eventTime: batch.run.startedAt,
        observedAt,
        actorClass: 'local-operator',
        authorizationClass: 'workspace-owner',
        workspaceId: batch.sessions[0]?.workspaceId ?? 'unscoped',
        targetClass: 'session-source',
        outcome,
        counts,
        adapterVersion: batch.source.adapterVersion,
        policyVersion: batch.run.policyVersion,
        schemaVersion: batch.source.sourceSchemaVersion,
      });
      return {
        operationId: batch.run.importRunId, outcome,
        sessionsInserted, eventsInserted, checkpoint,
      };
    });
    return apply();
  }

  commitStagedImports(sourceId: string, parserVersion: string): number {
    const commit = this.maintainedAnalyticsTransaction((): number => {
      const staged = this.db.prepare(
        `SELECT import_run_id FROM import_runs
         WHERE source_id=? AND parser_version=? AND status='staged'`,
      ).all(sourceId, parserVersion).map((row) => String(row.import_run_id));
      const result = this.db.prepare(
        `UPDATE import_runs SET status='committed'
         WHERE source_id=? AND parser_version=? AND status='staged'`,
      ).run(sourceId, parserVersion);
      this.db.prepare(
        `UPDATE import_receipts SET outcome='committed'
         WHERE import_run_id IN (
           SELECT import_run_id FROM import_runs
           WHERE source_id=? AND parser_version=? AND status='committed'
         ) AND outcome='staged'`,
      ).run(sourceId, parserVersion);
      for (const operationId of staged) {
        const row = this.db.prepare(
          'SELECT data FROM mutation_audit WHERE operation_id=?',
        ).get(operationId);
        if (!row?.data) continue;
        const prior = JSON.parse(String(row.data)) as MutationEvent;
        const { integrityDigest: _integrityDigest, ...unsigned } = {
          ...prior,
          outcome: 'committed' as const,
          observedAt: new Date().toISOString(),
        };
        const updated = {
          ...unsigned,
          integrityDigest: sha256(JSON.stringify(unsigned)),
        };
        this.db.prepare(
          `UPDATE mutation_audit SET outcome='committed', occurred_at=?, data=?
           WHERE operation_id=?`,
        ).run(updated.observedAt, JSON.stringify(updated), operationId);
      }
      if (result.changes > 0) this.rebuildImportAnalytics(staged);
      return result.changes;
    });
    return commit();
  }

  commitStagedBatch(batchRunId: string, sourceIds: readonly string[]): number {
    if (sourceIds.length === 0) return 0;
    const placeholders = sourceIds.map(() => '?').join(', ');
    const commit = this.maintainedAnalyticsTransaction((): number => {
      const params = [batchRunId, ...sourceIds];
      const staged = this.db.prepare(
        `SELECT import_run_id FROM import_runs
         WHERE batch_run_id=? AND source_id IN (${placeholders}) AND status='staged'`,
      ).all(...params).map((row) => String(row.import_run_id));
      const result = this.db.prepare(
        `UPDATE import_runs SET status='committed'
         WHERE batch_run_id=? AND source_id IN (${placeholders}) AND status='staged'`,
      ).run(...params);
      if (staged.length > 0) {
        const runPlaceholders = staged.map(() => '?').join(', ');
        this.db.prepare(
          `UPDATE import_receipts SET outcome='committed'
           WHERE import_run_id IN (${runPlaceholders}) AND outcome='staged'`,
        ).run(...staged);
      }
      for (const operationId of staged) {
        const row = this.db.prepare(
          'SELECT data FROM mutation_audit WHERE operation_id=?',
        ).get(operationId);
        if (!row?.data) continue;
        const prior = JSON.parse(String(row.data)) as MutationEvent;
        const { integrityDigest: _integrityDigest, ...unsigned } = {
          ...prior,
          outcome: 'committed' as const,
          observedAt: new Date().toISOString(),
        };
        const updated = {
          ...unsigned,
          integrityDigest: sha256(JSON.stringify(unsigned)),
        };
        this.db.prepare(
          `UPDATE mutation_audit SET outcome='committed', occurred_at=?, data=?
           WHERE operation_id=?`,
        ).run(updated.observedAt, JSON.stringify(updated), operationId);
      }
      if (result.changes > 0) this.rebuildImportAnalytics(staged);
      return result.changes;
    });
    return commit();
  }

  private rebuildImportAnalytics(importRunIds: readonly string[]): void {
    const affected = this.db.prepare(
      `SELECT DISTINCT s.workspace_id, s.session_id
       FROM session_events e
       JOIN sessions s ON s.session_id=e.session_id
       WHERE e.import_run_id=?`,
    );
    const sessions = new Map<string, string>();
    for (const importRunId of importRunIds) {
      for (const row of affected.all(importRunId)) {
        sessions.set(String(row.session_id), String(row.workspace_id));
      }
    }
    for (const [sessionId, workspaceId] of sessions) {
      this.rebuildAnalytics(workspaceId, sessionId);
    }
  }

  sourceImportTotals(
    sourceId: string,
    batchRunId: string,
  ): { sessions: number; events: number } {
    const totals = this.db.prepare(
      `SELECT COUNT(*) AS events, COUNT(DISTINCT e.session_id) AS sessions
       FROM session_events e
       JOIN import_runs r ON r.import_run_id=e.import_run_id
       WHERE e.source_id=? AND r.batch_run_id=?`,
    ).get(sourceId, batchRunId);
    return { sessions: Number(totals?.sessions ?? 0), events: Number(totals?.events ?? 0) };
  }

  getSession(id: string, workspaceId?: string): Session | null {
    const row = this.db.prepare(
      `SELECT s.data FROM sessions s
       WHERE s.session_id=? AND ${VISIBLE_SESSION_PREDICATE}
       ${workspaceId ? 'AND s.workspace_id=?' : ''}`,
    )
      .get(...(workspaceId ? [id, workspaceId] : [id]));
    return row ? JSON.parse(String(row.data)) as Session : null;
  }

  findSessionsByReference(reference: string, workspaceId?: string): Session[] {
    const internal = this.getSession(reference, workspaceId);
    if (internal) return [internal];
    const query = (predicate: string) => this.db.prepare(
      `SELECT s.data FROM sessions s
       WHERE ${workspaceId ? 's.workspace_id=? AND' : ''} ${VISIBLE_SESSION_PREDICATE} AND (${predicate})
       ORDER BY s.session_id`,
    ).all(...(workspaceId ? [workspaceId, reference] : [reference]))
      .map((row) => JSON.parse(String(row.data)) as Session);
    const exact = query('s.native_session_id=?');
    if (exact.length === 1) return exact;
    if (exact.length > 1) {
      // Artifact IDs are redacted by native-extension sanitization. The
      // adapter's boolean subagent flag survives. Only prefer a parent when
      // every other match is a proven Claude subagent in the same workspace.
      if (exact.every((session) => session.provider === 'claude'
        && session.workspaceId === exact[0].workspaceId)) {
        const classified = exact.map((session) => {
          const flags = this.db.prepare(`SELECT
            MAX(json_extract(e.data, '$.extensions."native.claude".transcriptFamily.subagent')=0) AS parent,
            MAX(json_extract(e.data, '$.extensions."native.claude".transcriptFamily.subagent')=1) AS subagent
            FROM session_events e JOIN import_runs r ON r.import_run_id=e.import_run_id
            WHERE e.session_id=? AND r.status='committed'`).get(session.sessionId)!;
          return { session, parent: flags.parent === 1, subagent: flags.subagent === 1 };
        });
        const parents = classified.filter((item) => item.parent && !item.subagent);
        if (parents.length === 1 && classified.every((item) => item === parents[0]
          || (item.subagent && !item.parent))) return [parents[0].session];
      }
      return exact;
    }
    // substr treats %, _ and other characters literally rather than as LIKE patterns.
    return this.db.prepare(
      `SELECT s.data FROM sessions s
       WHERE ${workspaceId ? 's.workspace_id=? AND' : ''} ${VISIBLE_SESSION_PREDICATE}
       AND (substr(s.native_session_id, 1, length(?))=?
         OR substr(s.session_id, 1, length(?))=?)
       ORDER BY s.session_id`,
    ).all(...(workspaceId ? [workspaceId, reference, reference, reference, reference]
      : [reference, reference, reference, reference]))
      .map((row) => JSON.parse(String(row.data)) as Session);
  }

  listWorkspaceSessionCounts(): Array<{ workspaceId: string; count: number }> {
    return this.db.prepare(
      `SELECT s.workspace_id, COUNT(*) AS count FROM sessions s
       WHERE ${VISIBLE_SESSION_PREDICATE} GROUP BY s.workspace_id ORDER BY s.workspace_id`,
    ).all().map((row) => ({ workspaceId: String(row.workspace_id), count: Number(row.count) }));
  }

  listSources(): SessionSource[] {
    return this.db.prepare(
      'SELECT data FROM session_sources ORDER BY provider, source_id',
    ).all().map((row) => JSON.parse(String(row.data)) as SessionSource);
  }

  listWorkspaceIds(): string[] {
    return this.db.prepare(
      'SELECT DISTINCT workspace_id FROM sessions ORDER BY workspace_id',
    ).all().map((row) => String(row.workspace_id));
  }

  saveBatchImportRun(run: BatchImportRun): void {
    const save = this.db.transaction(() => {
      const prior = this.db.prepare(
        'SELECT manifest_id, workspace_id FROM batch_import_runs WHERE batch_run_id=?',
      ).get(run.runId);
      if (prior && (String(prior.manifest_id) !== run.manifestId
        || String(prior.workspace_id) !== run.workspaceId)) {
        throw new SessionContractError(
          'IMPORT_CONFLICT',
          'batch run identity changed manifest or workspace scope',
        );
      }
      this.db.prepare(
        `INSERT INTO batch_import_runs(
           batch_run_id, manifest_id, workspace_id, status, started_at, updated_at, data
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(batch_run_id) DO UPDATE SET
           status=excluded.status, updated_at=excluded.updated_at, data=excluded.data`,
      ).run(
        run.runId,
        run.manifestId,
        run.workspaceId,
        run.status,
        run.startedAt,
        run.updatedAt,
        JSON.stringify(run),
      );
    });
    save();
  }

  getBatchImportRun(runId: string): BatchImportRun | null {
    const row = this.db.prepare(
      'SELECT data FROM batch_import_runs WHERE batch_run_id=?',
    ).get(runId);
    return row ? JSON.parse(String(row.data)) as BatchImportRun : null;
  }

  getBatchImportRunForManifest(
    manifestId: string,
    workspaceId: string,
  ): BatchImportRun | null {
    const row = this.db.prepare(
      `SELECT data FROM batch_import_runs
       WHERE manifest_id=? AND workspace_id=?`,
    ).get(manifestId, workspaceId);
    return row ? JSON.parse(String(row.data)) as BatchImportRun : null;
  }

  getCoverage(workspaceId: string, now = new Date()): SessionCoverageReport {
    const row = this.db.prepare(
      `SELECT data FROM batch_import_runs
       WHERE workspace_id=?
       ORDER BY updated_at DESC, batch_run_id DESC LIMIT 1`,
    ).get(workspaceId);
    const coverage = coverageFromBatchRun(
      row ? JSON.parse(String(row.data)) as BatchImportRun : null,
      now,
    );
    return coverage.status === 'unknown'
      ? { ...coverage, workspaceId }
      : coverage;
  }

  listSessions(options: SessionListOptions): SessionListResult {
    const where = [VISIBLE_SESSION_PREDICATE];
    const scopeDigest = sessionListScopeDigest(options);
    const cursor = decodeSessionListCursor(options.cursor);
    if (cursor && cursor.scopeDigest !== scopeDigest) {
      throw new SessionContractError('SCHEMA_DRIFT', 'session list cursor does not match the requested scope');
    }
    const snapshotRowid = cursor?.snapshotRowid ?? Number(
      this.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS value FROM sessions').get()?.value ?? 0,
    );
    where.push('s.rowid <= ?');
    const params: unknown[] = [snapshotRowid];
    if (options.provider) {
      where.push('json_extract(s.data, \'$.provider\') = ?');
      params.push(options.provider);
    }
    if (options.workspaceId) {
      where.push('s.workspace_id = ?');
      params.push(options.workspaceId);
    }
    if (options.tag) {
      where.push('EXISTS (SELECT 1 FROM session_tags t WHERE t.session_id=s.session_id AND t.tag=?)');
      params.push(options.tag);
    }
    const clause = where.join(' AND ');
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS count FROM sessions s WHERE ${clause}`)
      .get(...params);
    const pageWhere = [...where];
    const pageParams = [...params];
    if (cursor) {
      pageWhere.push(`(
        COALESCE(json_extract(s.data, '$.updatedAt'), '') > ?
        OR (
          COALESCE(json_extract(s.data, '$.updatedAt'), '') = ?
          AND s.session_id > ?
        )
      )`);
      pageParams.push(cursor.updatedAt, cursor.updatedAt, cursor.sessionId);
    }
    const items = this.db.prepare(
      `SELECT s.data FROM sessions s WHERE ${pageWhere.join(' AND ')}
       ORDER BY COALESCE(json_extract(s.data, '$.updatedAt'), ''), s.session_id
       LIMIT ?${options.offset ? ' OFFSET ?' : ''}`,
    ).all(...pageParams, options.limit + 1, ...(options.offset ? [options.offset] : []))
      .map((row) => JSON.parse(String(row.data)) as Session);
    const page = items.slice(0, options.limit);
    const last = page.at(-1);
    return {
      items: page,
      total: Number(totalRow?.count ?? 0),
      nextCursor: items.length > options.limit && last
        ? encodeSessionListCursor({
            snapshotRowid,
            updatedAt: last.updatedAt ?? '',
            sessionId: last.sessionId,
            scopeDigest,
          })
        : null,
      snapshotRowid,
    };
  }

  listTags(sessionId: string, workspaceId?: string): string[] {
    return this.db.prepare(
      `SELECT t.tag FROM session_tags t
       JOIN sessions s ON s.session_id=t.session_id
       WHERE t.session_id=? ${workspaceId ? 'AND s.workspace_id=?' : ''}
       ORDER BY t.tag`,
    ).all(...(workspaceId ? [sessionId, workspaceId] : [sessionId]))
      .map((row) => String(row.tag));
  }

  tagSession(sessionId: string, tag: string, workspaceId?: string): boolean {
    const mutate = this.db.transaction(() => {
      if (!this.getSession(sessionId, workspaceId)) return false;
      const changed = this.db.prepare(
        'INSERT OR IGNORE INTO session_tags(session_id, tag) VALUES (?, ?)',
      ).run(sessionId, tag).changes > 0;
      if (changed) {
        const scope = this.workspaceForSession(sessionId)!;
        this.emitRepositoryMutation({
          operationId: sha256(['session.tag', sessionId, tag].join('\0')),
          eventName: 'session.tag',
          workspaceId: scope,
          targetClass: 'session',
          counts: { tags: 1 },
        });
      }
      return changed;
    });
    return mutate();
  }

  listEvents(sessionId: string, workspaceId?: string): SessionEvent[] {
    return this.db.prepare(
      `SELECT e.data FROM session_events e
       JOIN sessions s ON s.session_id=e.session_id
       JOIN import_runs r ON r.import_run_id=e.import_run_id
       WHERE e.session_id=? ${workspaceId ? 'AND s.workspace_id=?' : ''}
       AND r.status='committed'
       ORDER BY e.sequence_no, e.event_id`,
    ).all(...(workspaceId ? [sessionId, workspaceId] : [sessionId]))
      .map((row) => JSON.parse(String(row.data)) as SessionEvent);
  }

  listTimelineInputs(workspaceId: string): TimelineInput[] {
    return this.db.prepare(
      `SELECT s.data AS session_data, e.data AS event_data
       FROM session_events e
       JOIN sessions s ON s.session_id=e.session_id
       JOIN import_runs r ON r.import_run_id=e.import_run_id
       WHERE s.workspace_id=? AND s.lifecycle!='tombstoned' AND r.status='committed'
       ORDER BY
         CASE WHEN json_extract(e.data, '$.occurredAt') IS NULL THEN 1 ELSE 0 END,
         json_extract(e.data, '$.occurredAt'),
         json_extract(s.data, '$.provider'),
         e.session_id,
         e.sequence_no,
         e.event_id`,
    ).all(workspaceId).map((row) => ({
      session: JSON.parse(String(row.session_data)) as Session,
      event: JSON.parse(String(row.event_data)) as SessionEvent,
    }));
  }

  search(options: SessionSearchOptions): SessionSearchResult {
    const query = options.query.trim();
    if (!query) throw new SessionContractError('MALFORMED_SOURCE', 'search query must not be empty');
    if (options.limit < 1 || options.limit > 500) {
      throw new SessionContractError('RESOURCE_LIMIT_EXCEEDED', 'search limit must be between 1 and 500');
    }
    const scopeDigest = searchScopeDigest(options);
    const cursor = decodeSearchCursor(options.cursor);
    if (cursor && cursor.scopeDigest !== scopeDigest) {
      throw new SessionContractError('SCHEMA_DRIFT', 'search cursor does not match the requested scope');
    }
    const snapshotRowid = cursor?.snapshotRowid ?? Number(
      this.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS value FROM session_events').get()?.value ?? 0,
    );
    const where = [
      `session_event_fts.searchable_text MATCH ?`,
      `e.rowid <= ?`,
      `s.workspace_id = ?`,
      `s.lifecycle != 'tombstoned'`,
      `r.status = 'committed'`,
    ];
    const params: unknown[] = [query, snapshotRowid, options.workspaceId];
    appendMetadataFilters(where, params, options);
    if (cursor) {
      where.push(`(
        session_event_fts.rank > ?
        OR (
          session_event_fts.rank = ?
          AND e.event_id > ?
        )
      )`);
      params.push(cursor.rank, cursor.rank, cursor.eventId);
    }
    let rows: Array<Record<string, unknown>>;
    try {
      rows = this.db.prepare(`
        SELECT
          e.rowid AS event_rowid, e.event_id, e.session_id, e.source_id,
          e.import_run_id, e.sequence_no, e.data AS event_data,
          s.workspace_id, s.data AS session_data, src.data AS source_data,
          session_event_fts.searchable_text,
          session_event_fts.rank AS stable_rank,
          snippet(session_event_fts, 1, '⟦', '⟧', ' … ', 32) AS matched_snippet
        FROM session_event_fts
        -- FTS matches must drive this join. SQLite may otherwise scan the
        -- authorization tables first and execute MATCH once per candidate.
        CROSS JOIN session_events e ON e.rowid=session_event_fts.rowid
        CROSS JOIN sessions s ON s.session_id=e.session_id
        CROSS JOIN import_runs r ON r.import_run_id=e.import_run_id
        CROSS JOIN session_sources src ON src.source_id=e.source_id
        WHERE ${where.join(' AND ')}
        ORDER BY session_event_fts.rank, e.event_id
        LIMIT ?
      `).all(...params, options.limit + 1);
    } catch (error) {
      if (error instanceof Error && /fts5|syntax|unterminated|column/i.test(error.message)) {
        throw new SessionContractError(
          'INVALID_SEARCH_QUERY',
          'search query syntax is invalid',
        );
      }
      throw error;
    }
    const page = rows.slice(0, options.limit);
    const items = page.map(searchHit);
    const last = page.at(-1);
    return {
      items,
      nextCursor: rows.length > options.limit && last
        ? encodeSearchCursor({
            snapshotRowid,
            rank: Number(last.stable_rank),
            eventId: String(last.event_id),
            scopeDigest,
          })
        : null,
    };
  }

  authorizedSearchDocuments(
    options: Omit<SessionSearchOptions, 'query' | 'cursor'>,
  ): SessionSearchDocument[] {
    return this.authorizedSearchDocumentPage(options).items;
  }

  authorizedSearchDocumentPage(
    options: Omit<SessionSearchOptions, 'query'>,
  ): AuthorizedDocumentPage {
    if (options.limit < 1 || options.limit > 500) {
      throw new SessionContractError(
        'RESOURCE_LIMIT_EXCEEDED',
        'semantic candidate limit must be between 1 and 500',
      );
    }
    const scopeDigest = authorizedDocumentScopeDigest(options);
    const cursor = decodeAuthorizedDocumentCursor(options.cursor);
    if (cursor && cursor.scopeDigest !== scopeDigest) {
      throw new SessionContractError(
        'SCHEMA_DRIFT',
        'authorized document cursor does not match the requested scope',
      );
    }
    const snapshotRowid = cursor?.snapshotRowid ?? Number(
      this.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS value FROM session_events').get()?.value ?? 0,
    );
    const where = [
      `e.rowid <= ?`,
      `s.workspace_id = ?`,
      `s.lifecycle != 'tombstoned'`,
      `r.status = 'committed'`,
    ];
    const params: unknown[] = [snapshotRowid, options.workspaceId];
    appendMetadataFilters(where, params, options);
    if (cursor) {
      where.push(`e.event_id > ?`);
      params.push(cursor.eventId);
    }
    const rows = this.db.prepare(`
      SELECT
        e.event_id, e.session_id, e.source_id, e.import_run_id,
        e.sequence_no, e.data AS event_data, s.workspace_id,
        s.data AS session_data, src.data AS source_data,
        json_extract(e.data, '$.searchableText') AS searchable_text,
        length(json_extract(e.data, '$.searchableText')) AS stable_rank
      FROM session_events e
      -- Preserve event-id keyset order as the outer loop. Without this planner
      -- fence SQLite may materialize and sort the entire authorized workspace
      -- before applying the bounded semantic-candidate limit.
      CROSS JOIN sessions s ON s.session_id=e.session_id
      CROSS JOIN import_runs r ON r.import_run_id=e.import_run_id
      CROSS JOIN session_sources src ON src.source_id=e.source_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.event_id
      LIMIT ?
    `).all(...params, options.limit + 1);
    const page = rows.slice(0, options.limit);
    const items = page.map((row) => ({
      ...searchHit(row),
      searchableText: String(row.searchable_text),
    }));
    const last = page.at(-1);
    return {
      items,
      nextCursor: rows.length > options.limit && last
        ? encodeAuthorizedDocumentCursor({
            snapshotRowid,
            eventId: String(last.event_id),
            scopeDigest,
          })
        : null,
      snapshotRowid,
    };
  }

  rebuildAnalytics(workspaceId?: string, sessionId?: string): number {
    return this.maintainedAnalyticsTransaction(() => {
      const inserted = this.rebuildAnalyticsFacts(workspaceId, sessionId);
      if (!workspaceId && !sessionId) this.markAnalyticsVerified();
      return inserted;
    })();
  }

  private rebuildAnalyticsFacts(workspaceId?: string, sessionId?: string): number {
    const where = [
      `r.status='committed'`,
      `s.lifecycle!='tombstoned'`,
    ];
    const params: unknown[] = [];
    if (workspaceId) {
      where.push('s.workspace_id=?');
      params.push(workspaceId);
    }
    if (sessionId) {
      where.push('s.session_id=?');
      params.push(sessionId);
    }
    const sessions = this.db.prepare(
      `SELECT s.session_id, s.data
       FROM sessions s
       WHERE s.lifecycle!='tombstoned'
       ${workspaceId ? 'AND s.workspace_id=?' : ''}
       ${sessionId ? 'AND s.session_id=?' : ''}
       AND EXISTS (
         SELECT 1 FROM session_events e
         JOIN import_runs r ON r.import_run_id=e.import_run_id
         WHERE e.session_id=s.session_id AND r.status='committed'
       )
       ORDER BY s.session_id`,
    ).all(...[
      ...(workspaceId ? [workspaceId] : []),
      ...(sessionId ? [sessionId] : []),
    ]);
    if (!workspaceId && !sessionId) {
      this.db.exec('DELETE FROM session_analytics_facts');
    } else if (sessionId) {
      this.db.prepare('DELETE FROM session_analytics_facts WHERE session_id=?').run(sessionId);
    } else {
      this.db.prepare('DELETE FROM session_analytics_facts WHERE workspace_id=?').run(workspaceId);
    }
    const eventQuery = this.db.prepare(
      `SELECT e.data
       FROM session_events e
       JOIN import_runs r ON r.import_run_id=e.import_run_id
       JOIN sessions s ON s.session_id=e.session_id
       WHERE e.session_id=? AND ${where.join(' AND ')}
       ORDER BY e.sequence_no, e.event_id`,
    );
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO session_analytics_facts(
         fact_id, workspace_id, session_id, event_id, category, status,
         provider, tool_name, occurred_at, data
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let inserted = 0;
    for (const row of sessions) {
      const session = JSON.parse(String(row.data)) as Session;
      const events = eventQuery.all(session.sessionId, ...params)
        .map((eventRow) => JSON.parse(String(eventRow.data)) as SessionEvent);
      for (const fact of deriveSessionAnalytics(session, events)) {
        inserted += insert.run(
          fact.factId,
          fact.workspaceId,
          fact.sessionId,
          fact.eventId,
          fact.category,
          fact.status,
          fact.provider,
          fact.toolName,
          fact.occurredAt,
          JSON.stringify(fact),
        ).changes;
      }
    }
    return inserted;
  }

  listAnalyticsFacts(options: SessionAnalyticsQuery): SessionAnalyticsFact[] {
    const where = [
      'f.workspace_id=?',
      `s.lifecycle!='tombstoned'`,
      `r.status='committed'`,
    ];
    const params: unknown[] = [options.workspaceId];
    if (options.categories?.length) {
      where.push(`f.category IN (${options.categories.map(() => '?').join(', ')})`);
      params.push(...options.categories);
    }
    const scalar = [
      ['f.provider', options.provider],
      ['f.session_id', options.sessionId],
      ['f.tool_name', options.tool],
      ['f.status', options.status],
      [`json_extract(f.data, '$.actor')`, options.actor],
      [`json_extract(f.data, '$.sensitivity')`, options.sensitivity],
      [`json_extract(f.data, '$.extractionState')`, options.extractionState],
    ] as const;
    for (const [column, value] of scalar) {
      if (value === undefined) continue;
      where.push(`${column}=?`);
      params.push(value);
    }
    if (options.dateFrom) {
      where.push('f.occurred_at>=?');
      params.push(options.dateFrom);
    }
    if (options.dateTo) {
      where.push('f.occurred_at<=?');
      params.push(options.dateTo);
    }
    if (options.tag) {
      where.push(`EXISTS (
        SELECT 1 FROM session_tags t
        WHERE t.session_id=f.session_id AND t.tag=?
      )`);
      params.push(options.tag);
    }
    const limit = options.limit ?? 500;
    if (limit < 1 || limit > 5_000) {
      throw new SessionContractError(
        'RESOURCE_LIMIT_EXCEEDED',
        'analytics limit must be between 1 and 5000',
      );
    }
    return this.db.prepare(
      `SELECT f.data
       FROM session_analytics_facts f
       JOIN sessions s ON s.session_id=f.session_id
       JOIN session_events e ON e.event_id=f.event_id
       JOIN import_runs r ON r.import_run_id=e.import_run_id
       WHERE ${where.join(' AND ')}
       ORDER BY
         CASE WHEN f.occurred_at IS NULL THEN 1 ELSE 0 END,
         f.occurred_at, f.session_id,
         json_extract(f.data, '$.sequence'), f.fact_id
       LIMIT ?`,
    ).all(...params, limit)
      .map((row) => JSON.parse(String(row.data)) as SessionAnalyticsFact);
  }

  analyticsSummary(options: SessionAnalyticsQuery): SessionAnalyticsSummary {
    const facts = this.listAnalyticsFacts({ ...options, limit: options.limit ?? 5_000 });
    const byCategory = countBy(facts, (fact) => fact.category);
    const byStatus = countBy(facts, (fact) => fact.status);
    const byProvider = countBy(facts, (fact) => fact.provider);
    const byTool = countBy(
      facts.filter((fact) => fact.toolName),
      (fact) => fact.toolName!,
    );
    return {
      analyticsVersion: '1.0.0',
      workspaceId: options.workspaceId,
      totals: {
        facts: facts.length,
        sessions: new Set(facts.map((fact) => fact.sessionId)).size,
        toolCalls: facts.filter((fact) => fact.category === 'tool-call').length,
        toolFailures: facts.filter((fact) =>
          fact.category === 'tool-result' && fact.status === 'failed').length,
        escalations: facts.filter((fact) => fact.category === 'escalation').length,
        hitlDecisions: facts.filter((fact) => fact.category === 'hitl').length,
        indicators: facts.filter((fact) => fact.category === 'indicator').length,
        retryGroups: new Set(
          facts.map((fact) => fact.retryGroupId).filter(Boolean),
        ).size,
      },
      byCategory,
      byStatus,
      byProvider,
      byTool,
    };
  }

  getAnalyticsEvidence(
    id: string,
    workspaceId: string,
  ): { fact: SessionAnalyticsFact | null; event: SessionEvent | null } {
    const row = this.db.prepare(
      `SELECT f.data AS fact_data, e.data AS event_data
       FROM session_analytics_facts f
       JOIN sessions s ON s.session_id=f.session_id
       JOIN session_events e ON e.event_id=f.event_id
       JOIN import_runs r ON r.import_run_id=e.import_run_id
       WHERE (f.fact_id=? OR f.event_id=?)
       AND f.workspace_id=? AND s.lifecycle!='tombstoned' AND r.status='committed'
       ORDER BY f.fact_id LIMIT 1`,
    ).get(id, id, workspaceId);
    return row
      ? {
          fact: JSON.parse(String(row.fact_data)) as SessionAnalyticsFact,
          event: JSON.parse(String(row.event_data)) as SessionEvent,
        }
      : { fact: null, event: null };
  }

  saveCandidates(candidates: readonly IntelligenceCandidate[]): IntelligenceCandidate[] {
    const save = this.db.transaction(() => {
      let inserted = 0;
      const incomingIds = new Set(candidates.map((candidate) => candidate.candidateId));
      for (const candidate of candidates) {
        for (const linkedId of [...candidate.conflictsWith, ...candidate.supersedes]) {
          if (!incomingIds.has(linkedId) && !this.getCandidate(linkedId)) {
            throw new SessionContractError(
              'MALFORMED_SOURCE',
              'candidate conflict or supersession link does not resolve',
            );
          }
        }
      }
      const saved = candidates.map((input) => {
        const parsed = IntelligenceCandidateSchema.parse(input);
        this.assertCandidateEvidence(parsed);
        const priorRow = this.db.prepare(
          `SELECT data FROM intelligence_candidates
           WHERE candidate_id=? ORDER BY version DESC LIMIT 1`,
        ).get(parsed.candidateId);
        if (priorRow) {
          const prior = JSON.parse(String(priorRow.data)) as IntelligenceCandidate;
          if (candidateContentDigest(prior) === candidateContentDigest(parsed)) return prior;
          parsed.version = prior.version + 1;
          parsed.reviewState = 'pending';
        } else {
          parsed.version = 1;
          parsed.reviewState = 'pending';
        }
        this.db.prepare(
          `INSERT INTO intelligence_candidates(candidate_id, version, review_state, data)
           VALUES (?, ?, ?, ?)`,
        ).run(parsed.candidateId, parsed.version, parsed.reviewState, JSON.stringify(parsed));
        inserted += 1;
        return parsed;
      });
      if (inserted > 0 && saved[0]) {
        const workspaceId = this.workspaceForCandidate(saved[0]);
        if (!workspaceId) {
          throw new SessionContractError(
            'OPERATION_NOT_AUTHORIZED',
            'candidate mutation lacks an authorized workspace',
          );
        }
        this.emitRepositoryMutation({
          operationId: sha256([
            'candidate.save',
            ...saved.map((item) => `${item.candidateId}:${item.version}`).sort(),
          ].join('\0')),
          eventName: 'candidate.save',
          workspaceId,
          targetClass: 'intelligence-candidate',
          counts: { candidates: inserted },
        });
      }
      return saved;
    });
    return save();
  }

  getCandidate(
    candidateId: string,
    version?: number,
    workspaceId?: string,
  ): IntelligenceCandidate | null {
    const workspaceClause = workspaceId
      ? `AND ${candidateWorkspacePredicate('intelligence_candidates')}` : '';
    const row = version === undefined
      ? this.db.prepare(
          `SELECT data FROM intelligence_candidates
           WHERE candidate_id=? ${workspaceClause} ORDER BY version DESC LIMIT 1`,
        ).get(...(workspaceId ? [candidateId, workspaceId, workspaceId] : [candidateId]))
      : this.db.prepare(
          `SELECT data FROM intelligence_candidates
           WHERE candidate_id=? AND version=? ${workspaceClause}`,
        ).get(...(workspaceId
          ? [candidateId, version, workspaceId, workspaceId]
          : [candidateId, version]));
    return row
      ? IntelligenceCandidateSchema.parse(JSON.parse(String(row.data)))
      : null;
  }

  listCandidates(
    reviewState?: IntelligenceCandidate['reviewState'],
    workspaceId?: string,
  ): IntelligenceCandidate[] {
    const predicate = candidateWorkspacePredicate('intelligence_candidates');
    const rows = reviewState
      ? this.db.prepare(
          `SELECT data FROM intelligence_candidates WHERE review_state=?
           ${workspaceId ? `AND ${predicate}` : ''}
           ORDER BY candidate_id, version`,
        ).all(...(workspaceId
          ? [reviewState, workspaceId, workspaceId]
          : [reviewState]))
      : this.db.prepare(
          `SELECT data FROM intelligence_candidates
           ${workspaceId ? `WHERE ${predicate}` : ''}
           ORDER BY candidate_id, version`,
        ).all(...(workspaceId ? [workspaceId, workspaceId] : []));
    return rows.map((row) =>
      IntelligenceCandidateSchema.parse(JSON.parse(String(row.data))));
  }

  reviewCandidate(input: {
    candidateId: string;
    version: number;
    toState: CandidateReviewReceipt['toState'];
    reviewer: string;
    reason: string;
    securityAcknowledged?: boolean;
    workspaceId?: string;
  }): CandidateReviewReceipt {
    const review = this.db.transaction(() => {
      const candidate = this.getCandidate(input.candidateId, input.version, input.workspaceId);
      if (!candidate) {
        throw new SessionContractError('MALFORMED_SOURCE', 'candidate version does not exist');
      }
      if (!allowedCandidateTransition(candidate.reviewState, input.toState)) {
        throw new SessionContractError(
          'UNSUPPORTED_OPERATION',
          `candidate transition ${candidate.reviewState} -> ${input.toState} is not allowed`,
        );
      }
      if (input.toState === 'accepted'
        && candidate.security.requiresAcknowledgement
        && !input.securityAcknowledged) {
        throw new SessionContractError(
          'OPERATION_NOT_AUTHORIZED',
          'suspicious candidate acceptance requires explicit security acknowledgment',
        );
      }
      const occurredAt = new Date().toISOString();
      const receipt = CandidateReviewReceiptSchema.parse({
        contractVersion: '1.0.0',
        receiptId: sha256([
          input.candidateId, input.version, candidate.reviewState,
          input.toState, input.reviewer, input.reason,
        ].join('\0')),
        candidateId: input.candidateId,
        candidateVersion: input.version,
        fromState: candidate.reviewState,
        toState: input.toState,
        reviewer: input.reviewer,
        reason: input.reason,
        securityWarnings: candidate.security.warnings,
        securityAcknowledged: Boolean(input.securityAcknowledged),
        occurredAt,
      });
      candidate.reviewState = input.toState;
      candidate.security.acknowledged = input.toState === 'accepted'
        && Boolean(input.securityAcknowledged);
      this.db.prepare(
        `UPDATE intelligence_candidates SET review_state=?, data=?
         WHERE candidate_id=? AND version=?`,
      ).run(input.toState, JSON.stringify(candidate), input.candidateId, input.version);
      this.db.prepare(
        `INSERT OR IGNORE INTO candidate_review_receipts
         (receipt_id, candidate_id, candidate_version, data) VALUES (?, ?, ?, ?)`,
      ).run(receipt.receiptId, input.candidateId, input.version, JSON.stringify(receipt));
      const workspaceId = this.workspaceForCandidate(candidate);
      if (!workspaceId) {
        throw new SessionContractError(
          'OPERATION_NOT_AUTHORIZED',
          'candidate review lacks an authorized workspace',
        );
      }
      this.emitRepositoryMutation({
        operationId: receipt.receiptId,
        eventName: 'candidate.review',
        workspaceId,
        targetClass: 'intelligence-candidate',
        actorClass: 'reviewer',
        eventTime: receipt.occurredAt,
        counts: { candidates: 1, receipts: 1 },
      });
      return receipt;
    });
    return review();
  }

  getPromotionReceipt(
    candidateId: string,
    version: number,
    consumer: string,
  ): PromotionReceipt | null {
    const row = this.db.prepare(
      `SELECT data FROM promotion_receipts
       WHERE candidate_id=? AND candidate_version=? AND consumer=?`,
    ).get(candidateId, version, consumer);
    return row ? JSON.parse(String(row.data)) as PromotionReceipt : null;
  }

  recordPromotion(receiptInput: PromotionReceipt): PromotionReceipt {
    const record = this.db.transaction(() => {
      const receipt = PromotionReceiptSchema.parse(receiptInput);
      const existing = this.getPromotionReceipt(
        receipt.candidateId,
        receipt.candidateVersion,
        receipt.consumer,
      );
      if (existing) return { ...existing, duplicate: true };
      const candidate = this.getCandidate(receipt.candidateId, receipt.candidateVersion);
      if (!candidate
        || (candidate.reviewState !== 'accepted' && candidate.reviewState !== 'promoted')) {
        throw new SessionContractError(
          'OPERATION_NOT_AUTHORIZED',
          'promotion requires an accepted exact candidate version',
        );
      }
      const evidenceIds = [...new Set(candidate.evidence.map((item) => item.eventId))].sort();
      if (JSON.stringify(evidenceIds) !== JSON.stringify([...receipt.evidenceEventIds].sort())) {
        throw new SessionContractError('IMPORT_CONFLICT', 'promotion lineage does not match candidate evidence');
      }
      this.db.prepare(
        `INSERT INTO promotion_receipts
         (receipt_id, candidate_id, candidate_version, consumer, data)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        receipt.receiptId,
        receipt.candidateId,
        receipt.candidateVersion,
        receipt.consumer,
        JSON.stringify(receipt),
      );
      candidate.reviewState = 'promoted';
      this.db.prepare(
        `UPDATE intelligence_candidates SET review_state='promoted', data=?
         WHERE candidate_id=? AND version=?`,
      ).run(JSON.stringify(candidate), candidate.candidateId, candidate.version);
      const workspaceId = this.workspaceForCandidate(candidate);
      if (!workspaceId) {
        throw new SessionContractError(
          'OPERATION_NOT_AUTHORIZED',
          'promotion lacks an authorized workspace',
        );
      }
      this.emitRepositoryMutation({
        operationId: receipt.receiptId,
        eventName: 'candidate.promote',
        workspaceId,
        targetClass: 'promotion',
        eventTime: receipt.approvedAt,
        counts: { candidates: 1, promotions: 1, evidence: evidenceIds.length },
      });
      return receipt;
    });
    return record();
  }

  private assertCandidateEvidence(candidate: IntelligenceCandidate): void {
    for (const evidence of candidate.evidence) {
      const row = this.db.prepare(
        `SELECT e.data FROM session_events e
         JOIN sessions s ON s.session_id=e.session_id
         JOIN import_runs r ON r.import_run_id=e.import_run_id
         WHERE e.event_id=? AND s.lifecycle!='tombstoned' AND r.status='committed'`,
      ).get(evidence.eventId);
      if (!row) {
        throw new SessionContractError(
          'MALFORMED_SOURCE',
          'candidate evidence does not resolve to a visible committed event',
        );
      }
      const event = JSON.parse(String(row.data)) as SessionEvent;
      if (evidence.end > event.searchableText.length || evidence.start >= evidence.end) {
        throw new SessionContractError('MALFORMED_SOURCE', 'candidate evidence span is invalid');
      }
      if (sha256(event.searchableText.slice(evidence.start, evidence.end)) !== evidence.quoteDigest) {
        throw new SessionContractError('IMPORT_CONFLICT', 'candidate evidence digest does not match');
      }
    }
  }

  getCheckpoint(sourceId: string, parserVersion: string): ImportCheckpoint | null {
    const row = this.db.prepare(
      `SELECT checkpoint FROM import_runs
       WHERE source_id=? AND parser_version=? AND status='committed'
       ORDER BY rowid DESC LIMIT 1`,
    ).get(sourceId, parserVersion);
    return row ? JSON.parse(String(row.checkpoint)) as ImportCheckpoint : null;
  }

  getBatchCheckpoint(
    sourceId: string,
    parserVersion: string,
    batchRunId: string,
  ): ImportCheckpoint | null {
    const row = this.db.prepare(
      `SELECT checkpoint FROM import_runs
       WHERE source_id=? AND parser_version=? AND batch_run_id=?
         AND status IN ('staged', 'committed')
       ORDER BY rowid DESC LIMIT 1`,
    ).get(sourceId, parserVersion, batchRunId);
    return row ? JSON.parse(String(row.checkpoint)) as ImportCheckpoint : null;
  }

  relocateSource(sourceId: string, redactedLocator: string, workspaceId?: string): void {
    const relocate = this.db.transaction(() => {
      const row = this.db.prepare(
        `SELECT src.data FROM session_sources src
         WHERE src.source_id=? ${workspaceId ? `AND EXISTS (
           SELECT 1 FROM sessions s
           WHERE s.source_id=src.source_id AND s.workspace_id=?
         ) AND NOT EXISTS (
           SELECT 1 FROM sessions s
           WHERE s.source_id=src.source_id AND s.workspace_id!=?
         )` : ''}`,
      ).get(...(workspaceId ? [sourceId, workspaceId, workspaceId] : [sourceId]));
      if (!row) return;
      const scopeRows = this.db.prepare(
        'SELECT DISTINCT workspace_id FROM sessions WHERE source_id=?',
      ).all(sourceId);
      if (scopeRows.length !== 1) {
        throw new SessionContractError(
          'OPERATION_NOT_AUTHORIZED',
          'source relocation requires one authorized workspace',
        );
      }
      const source = JSON.parse(String(row.data)) as SessionSource;
      source.redactedLocator = redactedLocator;
      this.db.prepare('UPDATE session_sources SET data=? WHERE source_id=?')
        .run(JSON.stringify(source), sourceId);
      this.emitRepositoryMutation({
        operationId: sha256(['source.relocate', sourceId, redactedLocator].join('\0')),
        eventName: 'source.relocate',
        workspaceId: String(scopeRows[0].workspace_id),
        targetClass: 'session-source',
        counts: { sources: 1 },
      });
    });
    relocate();
  }

  getSource(sourceId: string, workspaceId?: string): SessionSource | null {
    const row = this.db.prepare(
      `SELECT src.data FROM session_sources src
       WHERE src.source_id=? ${workspaceId ? `AND EXISTS (
         SELECT 1 FROM sessions s
         WHERE s.source_id=src.source_id AND s.workspace_id=?
       ) AND NOT EXISTS (
         SELECT 1 FROM sessions s
         WHERE s.source_id=src.source_id AND s.workspace_id!=?
       )` : ''}`,
    ).get(...(workspaceId ? [sourceId, workspaceId, workspaceId] : [sourceId]));
    return row ? JSON.parse(String(row.data)) as SessionSource : null;
  }

  deletionPreview(
    sessionId: string,
    workspaceId?: string,
  ): { sessions: number; events: number; tags: number } {
    const session = this.db.prepare(
      `SELECT COUNT(*) AS count FROM sessions
       WHERE session_id=? AND lifecycle!='tombstoned'
       ${workspaceId ? 'AND workspace_id=?' : ''}`,
    ).get(...(workspaceId ? [sessionId, workspaceId] : [sessionId]));
    const events = this.db.prepare(
      `SELECT COUNT(*) AS count FROM session_events e
       JOIN sessions s ON s.session_id=e.session_id
       WHERE e.session_id=? ${workspaceId ? 'AND s.workspace_id=?' : ''}`,
    ).get(...(workspaceId ? [sessionId, workspaceId] : [sessionId]));
    const tags = this.db.prepare(
      `SELECT COUNT(*) AS count FROM session_tags t
       JOIN sessions s ON s.session_id=t.session_id
       WHERE t.session_id=? ${workspaceId ? 'AND s.workspace_id=?' : ''}`,
    ).get(...(workspaceId ? [sessionId, workspaceId] : [sessionId]));
    return {
      sessions: Number(session?.count ?? 0),
      events: Number(events?.count ?? 0),
      tags: Number(tags?.count ?? 0),
    };
  }

  tombstoneSession(sessionId: string, workspaceId?: string): boolean {
    const tombstone = this.maintainedAnalyticsTransaction(() => {
      const row = this.db.prepare(
        `SELECT data, workspace_id FROM sessions
         WHERE session_id=? ${workspaceId ? 'AND workspace_id=?' : ''}`,
      ).get(...(workspaceId ? [sessionId, workspaceId] : [sessionId]));
      if (!row) return false;
      const session = JSON.parse(String(row.data)) as Session;
      session.lifecycle = 'tombstoned';
      const changed = this.db.prepare(
        `UPDATE sessions SET lifecycle='tombstoned', data=?
         WHERE session_id=? AND lifecycle!='tombstoned'
         ${workspaceId ? 'AND workspace_id=?' : ''}`,
      ).run(...(workspaceId
        ? [JSON.stringify(session), sessionId, workspaceId]
        : [JSON.stringify(session), sessionId])).changes > 0;
      if (changed) {
        this.emitRepositoryMutation({
          operationId: sha256(['session.tombstone', sessionId].join('\0')),
          eventName: 'session.tombstone',
          workspaceId: String(row.workspace_id),
          targetClass: 'session',
          counts: { sessions: 1 },
        });
      }
      if (changed) {
        this.db.prepare(
          'DELETE FROM session_analytics_facts WHERE session_id=?',
        ).run(sessionId);
      }
      return changed;
    });
    return tombstone();
  }

  restoreSession(sessionId: string, workspaceId?: string): boolean {
    const restore = this.maintainedAnalyticsTransaction(() => {
      const row = this.db.prepare(
        `SELECT data, workspace_id FROM sessions
         WHERE session_id=? ${workspaceId ? 'AND workspace_id=?' : ''}`,
      ).get(...(workspaceId ? [sessionId, workspaceId] : [sessionId]));
      if (!row) return false;
      const session = JSON.parse(String(row.data)) as Session;
      session.lifecycle = 'active';
      const changed = this.db.prepare(
        `UPDATE sessions SET lifecycle='active', data=?
         WHERE session_id=? AND lifecycle='tombstoned'
         ${workspaceId ? 'AND workspace_id=?' : ''}`,
      ).run(...(workspaceId
        ? [JSON.stringify(session), sessionId, workspaceId]
        : [JSON.stringify(session), sessionId])).changes > 0;
      if (changed) {
        this.emitRepositoryMutation({
          operationId: sha256(['session.restore', sessionId].join('\0')),
          eventName: 'session.restore',
          workspaceId: String(row.workspace_id),
          targetClass: 'session',
          counts: { sessions: 1 },
        });
      }
      if (changed) this.rebuildAnalytics(workspaceId, sessionId);
      return changed;
    });
    return restore();
  }

  previewPurge(sessionId: string, workspaceId?: string): SessionPurgePreview {
    const session = this.db.prepare(
      `SELECT data FROM sessions
       WHERE session_id=? ${workspaceId ? 'AND workspace_id=?' : ''}`,
    ).get(...(workspaceId ? [sessionId, workspaceId] : [sessionId]));
    if (!session) {
      throw new SessionContractError('MALFORMED_SOURCE', 'session does not exist');
    }
    const eventIds = this.db.prepare(
      'SELECT event_id FROM session_events WHERE session_id=? ORDER BY event_id',
    ).all(sessionId).map((row) => String(row.event_id));
    const eventSet = new Set(eventIds);
    const candidates = this.listCandidates()
      .filter((item) => item.evidence.some((evidence) => eventSet.has(evidence.eventId)));
    const candidateKeys = new Set(
      candidates.map((item) => `${item.candidateId}\0${item.version}`),
    );
    const dependents = this.db.prepare(
      'SELECT data FROM promotion_receipts ORDER BY candidate_id, candidate_version, consumer',
    ).all()
      .map((row) => JSON.parse(String(row.data)) as PromotionReceipt)
      .filter((receipt) => candidateKeys.has(`${receipt.candidateId}\0${receipt.candidateVersion}`))
      .map((receipt) => ({
        dependentId: receipt.receiptId,
        candidateId: receipt.candidateId,
        candidateVersion: receipt.candidateVersion,
        consumer: receipt.consumer,
        destinationRef: receipt.destinationRef,
      }));
    const candidateIds = candidates.map((item) => `${item.candidateId}:${item.version}`).sort();
    const counts = {
      sessions: 1,
      events: eventIds.length,
      indexes: eventIds.length,
      embeddings: 0,
      candidates: candidates.length,
      snapshots: 0,
      tags: Number(this.db.prepare(
        'SELECT COUNT(*) AS count FROM session_tags WHERE session_id=?',
      ).get(sessionId)?.count ?? 0),
      promotedDependents: dependents.length,
    };
    const operationId = sha256(JSON.stringify({
      scopeClass: 'session',
      sessionId,
      workspaceId: workspaceId ?? null,
      eventIds,
      candidateIds,
      dependentIds: dependents.map((item) => item.dependentId),
      counts,
    }));
    const preview: SessionPurgePreview = {
      contractVersion: '1.0.0',
      operationId,
      scopeClass: 'session',
      sessionId,
      workspaceId,
      counts,
      promotedDependents: dependents,
      confirmationRequired: true,
    };
    const sessionValue = JSON.parse(String(session.data)) as Session;
    this.emitRepositoryMutation({
      operationId: sha256(`${operationId}\0preview`),
      eventName: 'session.purge.preview',
      workspaceId: sessionValue.workspaceId,
      targetClass: 'session',
      outcome: 'preview',
      counts,
    });
    return preview;
  }

  getCompletedPurge(sessionId: string, workspaceId?: string): DeletionReceipt | null {
    if (this.db.prepare('SELECT 1 AS present FROM sessions WHERE session_id=?').get(sessionId)) {
      return null;
    }
    const row = this.db.prepare(
      `SELECT data FROM deletion_receipts WHERE scope_id=?
       ${workspaceId ? 'AND workspace_id=?' : ''}
       ORDER BY rowid DESC LIMIT 1`,
    ).get(...(workspaceId ? [sessionId, workspaceId] : [sessionId]));
    return row ? JSON.parse(String(row.data)) as DeletionReceipt : null;
  }

  listPromotionDependencyDecisions(operationId: string): PromotionDependencyDecision[] {
    return this.db.prepare(
      `SELECT dependent_id, action, basis FROM promotion_dependency_decisions
       WHERE operation_id=? ORDER BY dependent_id`,
    ).all(operationId).map((row) => PromotionDependencyDecisionSchema.parse({
      dependentId: String(row.dependent_id),
      action: String(row.action),
      basis: String(row.basis),
    }));
  }

  listPromotionProvenanceReceipts(operationId?: string): PromotionProvenanceReceipt[] {
    const rows = operationId
      ? this.db.prepare(
          `SELECT data FROM promotion_provenance_receipts
           WHERE operation_id=? ORDER BY dependent_id`,
        ).all(operationId)
      : this.db.prepare(
          'SELECT data FROM promotion_provenance_receipts ORDER BY operation_id, dependent_id',
        ).all();
    return rows.map((row) => JSON.parse(String(row.data)) as PromotionProvenanceReceipt);
  }

  purgeSession(input: {
    preview: SessionPurgePreview;
    actorClass: string;
    reasonCode: string;
    decisions: PromotionDependencyDecision[];
  }): DeletionReceipt {
    const existing = this.db.prepare(
      'SELECT data FROM deletion_receipts WHERE operation_id=?',
    ).get(input.preview.operationId);
    if (existing) return JSON.parse(String(existing.data)) as DeletionReceipt;
    const current = this.previewPurge(input.preview.sessionId, input.preview.workspaceId);
    if (current.operationId !== input.preview.operationId) {
      throw new SessionContractError('IMPORT_CONFLICT', 'purge scope changed after preview');
    }
    const validatedDecisions = input.decisions.map(
      (item) => PromotionDependencyDecisionSchema.parse(item),
    );
    const expected = new Set(current.promotedDependents.map((item) => item.dependentId));
    const decisions = new Map(validatedDecisions.map((item) => [item.dependentId, item]));
    if (validatedDecisions.length !== expected.size
      || decisions.size !== expected.size
      || [...expected].some((dependentId) => !decisions.has(dependentId))) {
      throw new SessionContractError(
        'OPERATION_NOT_AUTHORIZED',
        'every promoted dependent requires one explicit disposition',
      );
    }
    const mutationWorkspaceId = this.workspaceForSession(input.preview.sessionId);
    if (!mutationWorkspaceId) {
      throw new SessionContractError(
        'OPERATION_NOT_AUTHORIZED',
        'purge mutation lacks an authorized workspace',
      );
    }
    const apply = this.maintainedAnalyticsTransaction((): DeletionReceipt => {
      for (const decision of validatedDecisions) {
        this.db.prepare(
          `INSERT INTO promotion_dependency_decisions
           (operation_id, dependent_id, action, basis) VALUES (?, ?, ?, ?)`,
        ).run(input.preview.operationId, decision.dependentId, decision.action, decision.basis);
        const dependent = current.promotedDependents.find(
          (item) => item.dependentId === decision.dependentId,
        )!;
        const promotion = this.db.prepare(
          'SELECT data FROM promotion_receipts WHERE receipt_id=?',
        ).get(decision.dependentId);
        if (!promotion) {
          throw new SessionContractError(
            'IMPORT_CONFLICT',
            'promoted dependency disappeared before durable provenance handling',
          );
        }
        const promotionReceipt = JSON.parse(String(promotion.data)) as PromotionReceipt;
        const provenance: PromotionProvenanceReceipt = {
          contractVersion: '1.0.0',
          receiptId: sha256([
            input.preview.operationId,
            decision.dependentId,
            decision.action,
          ].join('\0')),
          operationId: input.preview.operationId,
          dependentId: decision.dependentId,
          candidateId: dependent.candidateId,
          candidateVersion: dependent.candidateVersion,
          consumer: dependent.consumer,
          destinationRef: dependent.destinationRef,
          evidenceEventIds: [...promotionReceipt.evidenceEventIds].sort(),
          action: decision.action,
          basis: decision.basis,
          originAvailable: false,
          occurredAt: new Date().toISOString(),
        };
        this.db.prepare(
          `INSERT INTO promotion_provenance_receipts
           (receipt_id, operation_id, dependent_id, action, data)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(
          provenance.receiptId,
          provenance.operationId,
          provenance.dependentId,
          provenance.action,
          JSON.stringify(provenance),
        );
      }
      const eventRows = this.db.prepare(
        'SELECT rowid AS event_rowid, event_id FROM session_events WHERE session_id=?',
      ).all(input.preview.sessionId);
      for (const row of eventRows) {
        this.db.prepare('DELETE FROM session_event_fts WHERE rowid=?')
          .run(Number(row.event_rowid));
      }
      const eventIds = new Set(eventRows.map((row) => String(row.event_id)));
      const affectedCandidates = this.listCandidates()
        .filter((item) => item.evidence.some((evidence) => eventIds.has(evidence.eventId)));
      for (const candidate of affectedCandidates) {
        this.db.prepare(
          'DELETE FROM candidate_review_receipts WHERE candidate_id=? AND candidate_version=?',
        ).run(candidate.candidateId, candidate.version);
        this.db.prepare(
          'DELETE FROM promotion_receipts WHERE candidate_id=? AND candidate_version=?',
        ).run(candidate.candidateId, candidate.version);
        this.db.prepare(
          'DELETE FROM intelligence_candidates WHERE candidate_id=? AND version=?',
        ).run(candidate.candidateId, candidate.version);
      }
      this.db.prepare('DELETE FROM session_tags WHERE session_id=?').run(input.preview.sessionId);
      this.db.prepare('DELETE FROM session_events WHERE session_id=?').run(input.preview.sessionId);
      this.db.prepare('DELETE FROM sessions WHERE session_id=?').run(input.preview.sessionId);
      const orphanCounts = {
        sessions: Number(this.db.prepare(
          'SELECT COUNT(*) AS count FROM sessions WHERE session_id=?',
        ).get(input.preview.sessionId)?.count ?? 0),
        events: Number(this.db.prepare(
          'SELECT COUNT(*) AS count FROM session_events WHERE session_id=?',
        ).get(input.preview.sessionId)?.count ?? 0),
        indexes: eventRows.reduce((count, row) => count + Number(this.db.prepare(
          'SELECT COUNT(*) AS count FROM session_event_fts WHERE rowid=?',
        ).get(Number(row.event_rowid))?.count ?? 0), 0),
        candidates: affectedCandidates.reduce((count, candidate) => count + Number(
          this.db.prepare(
            'SELECT COUNT(*) AS count FROM intelligence_candidates WHERE candidate_id=? AND version=?',
          ).get(candidate.candidateId, candidate.version)?.count ?? 0,
        ), 0),
      };
      if (Object.values(orphanCounts).some((count) => count !== 0)) {
        throw new SessionContractError('IMPORT_CONFLICT', 'purge orphan check failed');
      }
      const receipt = DeletionReceiptSchema.parse({
        contractVersion: '1.0.0',
        receiptId: sha256(`${input.preview.operationId}\0terminal`),
        operationId: input.preview.operationId,
        scopeClass: 'session',
        counts: input.preview.counts,
        survivingDependentIds: validatedDecisions
          .filter((item) => !['revoke', 'delete'].includes(item.action))
          .map((item) => item.dependentId)
          .sort(),
        actorClass: input.actorClass,
        reasonCode: input.reasonCode,
        orphanCounts,
        outcome: 'committed',
        occurredAt: new Date().toISOString(),
      });
      this.db.prepare(
        `INSERT INTO deletion_receipts(operation_id, scope_id, workspace_id, data)
         VALUES (?, ?, ?, ?)`,
      ).run(
        receipt.operationId,
        input.preview.sessionId,
        input.preview.workspaceId ?? null,
        JSON.stringify(receipt),
      );
      this.emitRepositoryMutation({
        operationId: sha256(`${receipt.operationId}\0commit`),
        eventName: 'session.purge',
        workspaceId: mutationWorkspaceId,
        targetClass: 'session',
        actorClass: input.actorClass,
        eventTime: receipt.occurredAt,
        counts: {
          ...receipt.counts,
          dependencyDispositions: validatedDecisions.length,
        },
      });
      this.db.prepare(
        'DELETE FROM session_analytics_facts WHERE session_id=?',
      ).run(input.preview.sessionId);
      return receipt;
    });
    return apply();
  }

  reindex(workspaceId?: string): void {
    const rebuild = this.maintainedAnalyticsTransaction(() => {
      let indexed = 0;
      if (!workspaceId) {
        this.db.exec('REINDEX');
        this.db.exec('DELETE FROM session_event_fts');
        this.db.exec(`
          INSERT INTO session_event_fts(rowid, event_id, searchable_text)
          SELECT rowid, event_id, json_extract(data, '$.searchableText') FROM session_events
        `);
        indexed = Number(this.db.prepare(
          'SELECT COUNT(*) AS count FROM session_events',
        ).get()?.count ?? 0);
        this.rebuildAnalytics();
      } else {
        this.db.prepare(
          `DELETE FROM session_event_fts WHERE rowid IN (
            SELECT e.rowid FROM session_events e
            JOIN sessions s ON s.session_id=e.session_id
            WHERE s.workspace_id=?
          )`,
        ).run(workspaceId);
        indexed = this.db.prepare(
          `INSERT INTO session_event_fts(rowid, event_id, searchable_text)
           SELECT e.rowid, e.event_id, json_extract(e.data, '$.searchableText')
           FROM session_events e
           JOIN sessions s ON s.session_id=e.session_id
           WHERE s.workspace_id=?`,
        ).run(workspaceId).changes;
        this.rebuildAnalytics(workspaceId);
      }
      this.emitRepositoryMutation({
        operationId: sha256([
          'session.reindex',
          workspaceId ?? 'global',
          String(Date.now()),
        ].join('\0')),
        eventName: 'session.reindex',
        workspaceId: workspaceId ?? 'global',
        targetClass: 'search-index',
        counts: { events: indexed },
      });
    });
    rebuild();
  }

  doctor(): SessionCatalogHealth {
    const integrity = this.db.pragma('integrity_check') as Array<{ integrity_check?: string }>;
    const count = (table: string, where = ''): number => {
      const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get();
      return Number(row?.count ?? 0);
    };
    let indexIntegrity: 'ok' | 'failed' = 'ok';
    try {
      this.db.prepare(
        `INSERT INTO session_event_fts(session_event_fts) VALUES ('integrity-check')`,
      ).run();
      if (count('session_event_fts') !== count('session_events')) indexIntegrity = 'failed';
    } catch {
      indexIntegrity = 'failed';
    }
    return {
      integrity: integrity[0]?.integrity_check === 'ok' ? 'ok' : 'failed',
      indexIntegrity,
      sources: count('session_sources'),
      sessions: count('sessions', `WHERE lifecycle!='tombstoned'`),
      events: count('session_events'),
      stagedImports: count('import_runs', `WHERE status='staged'`),
    };
  }

  close(): void {
    this.db.close();
  }
}

interface SearchCursor {
  snapshotRowid: number;
  rank: number;
  eventId: string;
  scopeDigest: string;
  checksum: string;
}

interface SessionListCursor {
  snapshotRowid: number;
  updatedAt: string;
  sessionId: string;
  scopeDigest: string;
  checksum: string;
}

interface AuthorizedDocumentCursor {
  snapshotRowid: number;
  eventId: string;
  scopeDigest: string;
  checksum: string;
}

function searchHit(row: Record<string, unknown>): SessionSearchHit {
  const event = JSON.parse(String(row.event_data)) as SessionEvent;
  const session = JSON.parse(String(row.session_data)) as Session;
  const source = JSON.parse(String(row.source_data)) as SessionSource;
  const citation = {
    provider: session.provider,
    sessionId: event.sessionId,
    origin: event.origin,
    eventId: event.eventId,
    importRunId: event.importRunId,
    sourceId: event.sourceId,
    locatorClass: source.locatorClass,
    ...(event.nativeId ? { nativeEventId: event.nativeId } : {}),
  };
  return {
    score: Math.max(0, -Number(row.stable_rank)),
    snippet: boundedSnippet(String(row.matched_snippet ?? row.searchable_text), 240),
    provider: session.provider,
    workspaceId: session.workspaceId,
    sessionId: event.sessionId,
    origin: event.origin,
    eventId: event.eventId,
    importRunId: event.importRunId,
    sourceId: event.sourceId,
    locatorClass: source.locatorClass,
    sequence: event.sequence,
    role: event.role,
    nativeEventId: event.nativeId,
    occurredAt: event.occurredAt,
    sensitivity: event.sensitivity.classification,
    citation,
  };
}

function boundedSnippet(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function renameNativeWindsurfEnvelope(
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (!Object.hasOwn(value, 'native.windsurf')) return value;
  const output = { ...value };
  if (!Object.hasOwn(output, 'native.devin-desktop')) {
    output['native.devin-desktop'] = output['native.windsurf'];
  }
  delete output['native.windsurf'];
  return output;
}

function canonicalDevinLocator(value: string): string {
  return value.startsWith('windsurf-')
    ? `devin-desktop-${value.slice('windsurf-'.length)}`
    : value;
}

function countBy<T>(
  items: readonly T[],
  key: (item: T) => string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const value = key(item);
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function encodeMutationCursor(rowid: number, workspaceId: string): string {
  const unsigned = { rowid, workspaceId };
  return Buffer.from(JSON.stringify({
    ...unsigned,
    checksum: sha256(JSON.stringify(unsigned)),
  }), 'utf8').toString('base64url');
}

function decodeMutationCursor(value: string | undefined, workspaceId: string): number {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      rowid: number;
      workspaceId: string;
      checksum: string;
    };
    const unsigned = { rowid: parsed.rowid, workspaceId: parsed.workspaceId };
    if (!Number.isSafeInteger(parsed.rowid)
      || parsed.rowid < 0
      || parsed.workspaceId !== workspaceId
      || parsed.checksum !== sha256(JSON.stringify(unsigned))) {
      throw new Error('invalid cursor');
    }
    return parsed.rowid;
  } catch {
    throw new SessionContractError('SCHEMA_DRIFT', 'mutation audit cursor is invalid');
  }
}

function encodeSearchCursor(cursor: Omit<SearchCursor, 'checksum'>): string {
  const payload = { ...cursor, checksum: sha256(JSON.stringify(cursor)) };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeSearchCursor(value?: string): SearchCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as SearchCursor;
    const { checksum, ...unsigned } = parsed;
    if (!Number.isSafeInteger(parsed.snapshotRowid)
      || !Number.isFinite(parsed.rank)
      || typeof parsed.eventId !== 'string'
      || typeof parsed.scopeDigest !== 'string'
      || checksum !== sha256(JSON.stringify(unsigned))) throw new Error('invalid cursor');
    return parsed;
  } catch {
    throw new SessionContractError('SCHEMA_DRIFT', 'search cursor is invalid');
  }
}

function encodeSessionListCursor(
  cursor: Omit<SessionListCursor, 'checksum'>,
): string {
  const payload = { ...cursor, checksum: sha256(JSON.stringify(cursor)) };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeSessionListCursor(value?: string): SessionListCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as SessionListCursor;
    const { checksum, ...unsigned } = parsed;
    if (!Number.isSafeInteger(parsed.snapshotRowid)
      || typeof parsed.updatedAt !== 'string'
      || typeof parsed.sessionId !== 'string'
      || typeof parsed.scopeDigest !== 'string'
      || checksum !== sha256(JSON.stringify(unsigned))) throw new Error('invalid cursor');
    return parsed;
  } catch {
    throw new SessionContractError('SCHEMA_DRIFT', 'session list cursor is invalid');
  }
}

function sessionListScopeDigest(options: SessionListOptions): string {
  return sha256(JSON.stringify({
    provider: options.provider,
    workspaceId: options.workspaceId,
    tag: options.tag,
  }));
}

function searchScopeDigest(options: SessionSearchOptions): string {
  const { cursor: _cursor, limit: _limit, ...scope } = options;
  return sha256(JSON.stringify(scope));
}

function encodeAuthorizedDocumentCursor(
  cursor: Omit<AuthorizedDocumentCursor, 'checksum'>,
): string {
  const payload = { ...cursor, checksum: sha256(JSON.stringify(cursor)) };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeAuthorizedDocumentCursor(value?: string): AuthorizedDocumentCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as AuthorizedDocumentCursor;
    const { checksum, ...cursor } = parsed;
    if (!Number.isSafeInteger(cursor.snapshotRowid)
      || typeof cursor.eventId !== 'string'
      || typeof cursor.scopeDigest !== 'string'
      || checksum !== sha256(JSON.stringify(cursor))) throw new Error('invalid cursor');
    return parsed;
  } catch {
    throw new SessionContractError('SCHEMA_DRIFT', 'authorized document cursor is invalid');
  }
}

function authorizedDocumentScopeDigest(
  options: Omit<SessionSearchOptions, 'query'>,
): string {
  const { cursor: _cursor, limit: _limit, ...scope } = options;
  return sha256(JSON.stringify(scope));
}

function appendMetadataFilters(
  where: string[],
  params: unknown[],
  options: Omit<SessionSearchOptions, 'query' | 'cursor'>,
): void {
  const controlEvents = options.controlEvents ?? 'exclude';
  const controlOrigins = [
    'provider-bootstrap',
    'workspace-instruction',
    'tool-control',
  ];
  if (controlEvents === 'exclude') {
    where.push(
      `COALESCE(json_extract(e.data, '$.origin'), 'unknown') NOT IN (${controlOrigins.map(() => '?').join(',')})`,
    );
    params.push(...controlOrigins);
  } else if (controlEvents === 'only') {
    where.push(
      `COALESCE(json_extract(e.data, '$.origin'), 'unknown') IN (${controlOrigins.map(() => '?').join(',')})`,
    );
    params.push(...controlOrigins);
  }
  if (options.sessionIds?.length) {
    where.push(`e.session_id IN (${options.sessionIds.map(() => '?').join(',')})`);
    params.push(...options.sessionIds);
  }
  if (options.providers?.length) {
    where.push(`json_extract(s.data, '$.provider') IN (${options.providers.map(() => '?').join(',')})`);
    params.push(...options.providers);
  }
  if (options.dateFrom) {
    where.push(`json_extract(e.data, '$.occurredAt') >= ?`);
    params.push(options.dateFrom);
  }
  if (options.dateTo) {
    where.push(`json_extract(e.data, '$.occurredAt') <= ?`);
    params.push(options.dateTo);
  }
  if (options.role) {
    where.push(`json_extract(e.data, '$.role') = ?`);
    params.push(options.role);
  }
  if (options.participant) {
    where.push(`json_extract(e.data, '$.participant') = ?`);
    params.push(options.participant);
  }
  if (options.tool) {
    where.push(`(json_extract(e.data, '$.toolName') = ?
      OR json_extract(e.data, '$.toolCallId') = ?)`);
    params.push(options.tool, options.tool);
  }
  if (options.tag) {
    where.push(`EXISTS (
      SELECT 1 FROM session_tags t WHERE t.session_id=s.session_id AND t.tag=?
    )`);
    params.push(options.tag);
  }
  if (options.sensitivity) {
    where.push(`json_extract(e.data, '$.sensitivity.classification') = ?`);
    params.push(options.sensitivity);
  }
  if (options.model) {
    where.push(`json_extract(e.data, '$.model') = ?`);
    params.push(options.model);
  }
  if (options.entity) {
    where.push(`EXISTS (
      SELECT 1 FROM json_each(json_extract(e.data, '$.entities'))
      WHERE json_each.value = ?
    )`);
    params.push(options.entity);
  }
  if (options.extractionState) {
    where.push(`json_extract(e.data, '$.extractionState') = ?`);
    params.push(options.extractionState);
  }
}

function candidateWorkspacePredicate(alias: string): string {
  return `EXISTS (
    SELECT 1
    FROM json_each(json_extract(${alias}.data, '$.evidence')) evidence
    JOIN session_events e
      ON e.event_id=json_extract(evidence.value, '$.eventId')
    JOIN sessions s ON s.session_id=e.session_id
    WHERE s.workspace_id=?
  ) AND NOT EXISTS (
    SELECT 1
    FROM json_each(json_extract(${alias}.data, '$.evidence')) evidence
    JOIN session_events e
      ON e.event_id=json_extract(evidence.value, '$.eventId')
    JOIN sessions s ON s.session_id=e.session_id
    WHERE s.workspace_id!=?
  )`;
}

function candidateContentDigest(candidate: IntelligenceCandidate): string {
  return sha256(JSON.stringify({
    ...candidate,
    security: {
      ...candidate.security,
      acknowledged: false,
    },
    version: undefined,
    reviewState: undefined,
    createdAt: undefined,
  }));
}

function mergeSessionAggregate(prior: Session, incoming: Session): Session {
  const timestamp = (
    left: string | null,
    right: string | null,
    direction: 'min' | 'max',
  ): string | null => {
    if (!left) return right;
    if (!right) return left;
    const comparison = Date.parse(left) - Date.parse(right);
    return direction === 'min'
      ? (comparison <= 0 ? left : right)
      : (comparison >= 0 ? left : right);
  };
  const consistencyRank: Record<Session['consistency'], number> = {
    provisional: 0,
    'consistent-snapshot': 1,
    complete: 2,
  };
  const lifecycle = mergeLifecycleAggregate(prior, incoming);
  const nativeKey = `native.${prior.provider}`;
  const priorNative = objectRecord(prior.extensions[nativeKey]);
  const incomingNative = objectRecord(incoming.extensions[nativeKey]);
  return {
    ...prior,
    startedAt: timestamp(prior.startedAt, incoming.startedAt, 'min'),
    updatedAt: timestamp(prior.updatedAt, incoming.updatedAt, 'max'),
    consistency: consistencyRank[prior.consistency] >= consistencyRank[incoming.consistency]
      ? prior.consistency : incoming.consistency,
    lifecycle: lifecycle.lifecycle,
    intent: mergeSessionIntent(prior.intent, incoming.intent),
    sourceDigest: incoming.sourceDigest,
    extensions: {
      ...prior.extensions,
      ...incoming.extensions,
      [nativeKey]: {
        ...priorNative,
        ...incomingNative,
        lifecycleEvidence: lifecycle.evidence,
      },
    },
  };
}

function mergeLifecycleAggregate(
  prior: Session,
  incoming: Session,
): { lifecycle: Session['lifecycle']; evidence: Record<string, unknown> } {
  const nativeKey = `native.${prior.provider}`;
  const priorEvidence = objectRecord(objectRecord(prior.extensions[nativeKey]).lifecycleEvidence);
  const incomingEvidence = objectRecord(
    objectRecord(incoming.extensions[nativeKey]).lifecycleEvidence,
  );
  if (prior.lifecycle === 'tombstoned') {
    return { lifecycle: prior.lifecycle, evidence: priorEvidence };
  }
  const rank: Record<string, number> = {
    'open-provisional-source': 1,
    'inactivity-threshold': 1,
    'complete-source': 2,
    'provider-explicit-event': 3,
  };
  const priorRank = rank[String(priorEvidence.basis)] ?? 0;
  const incomingRank = rank[String(incomingEvidence.basis)] ?? 0;
  const incomingIsNewer = lifecycleEvidenceTimestamp(incomingEvidence)
    > lifecycleEvidenceTimestamp(priorEvidence);
  return incomingRank > priorRank || (incomingRank === priorRank && incomingIsNewer)
    ? { lifecycle: incoming.lifecycle, evidence: incomingEvidence }
    : { lifecycle: prior.lifecycle, evidence: priorEvidence };
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sanitizeSessionExtensions(
  extensions: Record<string, unknown>,
  provider: string,
): Record<string, unknown> {
  const sanitized = sanitizeNativeExtensions(extensions).value;
  const nativeKey = `native.${provider}`;
  const evidence = safeLifecycleEvidence(
    objectRecord(objectRecord(extensions[nativeKey]).lifecycleEvidence),
  );
  if (!evidence) return sanitized;
  sanitized[nativeKey] = {
    ...objectRecord(sanitized[nativeKey]),
    lifecycleEvidence: evidence,
  };
  return sanitized;
}

function safeLifecycleEvidence(
  evidence: Record<string, unknown>,
): Record<string, unknown> | null {
  const bases = new Set([
    'open-provisional-source',
    'inactivity-threshold',
    'complete-source',
    'provider-explicit-event',
  ]);
  const states = new Set([
    'active', 'inactive', 'paused', 'complete', 'interrupted', 'archived',
    'unknown', 'tombstoned',
  ]);
  const confidences = new Set(['high', 'medium', 'low', 'provisional']);
  const basis = String(evidence.basis ?? '');
  const state = String(evidence.state ?? '');
  const confidence = String(evidence.confidence ?? '');
  const observedAt = String(evidence.observedAt ?? '');
  if (!bases.has(basis)
    || !states.has(state)
    || !confidences.has(confidence)
    || !Number.isFinite(Date.parse(observedAt))) {
    return null;
  }
  const output: Record<string, unknown> = {
    basis,
    state,
    observedAt,
    confidence,
  };
  if (typeof evidence.thresholdMs === 'number'
    && Number.isFinite(evidence.thresholdMs)
    && evidence.thresholdMs >= 0) {
    output.thresholdMs = evidence.thresholdMs;
  }
  return output;
}

function lifecycleEvidenceTimestamp(value: Record<string, unknown>): number {
  const parsed = Date.parse(String(value.observedAt ?? ''));
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function mergeSessionIntent(
  prior: Session['intent'],
  incoming: Session['intent'],
): Session['intent'] {
  if (prior.status === 'selected' && incoming.status === 'selected') {
    const priorKey = [prior.sequence ?? Number.MAX_SAFE_INTEGER, prior.eventId ?? ''];
    const incomingKey = [incoming.sequence ?? Number.MAX_SAFE_INTEGER, incoming.eventId ?? ''];
    return priorKey[0] < incomingKey[0]
      || (priorKey[0] === incomingKey[0] && String(priorKey[1]) <= String(incomingKey[1]))
      ? prior
      : incoming;
  }
  if (prior.status === 'selected') return prior;
  if (incoming.status === 'selected') return incoming;
  if (prior.status === 'unknown' || incoming.status === 'unknown') {
    return {
      status: 'unknown',
      eventId: null,
      sequence: null,
      title: null,
      summary: null,
    };
  }
  return prior;
}

function safeEventCoordinates(
  eventData: string,
  fallback: { provider: string; nativeSessionId: string },
): {
  provider: string;
  sourceId: string;
  nativeSessionId: string;
  nativeEventId: string;
} {
  try {
    const event = JSON.parse(eventData) as SessionEvent;
    return {
      provider: fallback.provider,
      sourceId: event.sourceId,
      nativeSessionId: fallback.nativeSessionId,
      nativeEventId: event.nativeId ?? `sequence:${event.sequence}`,
    };
  } catch {
    return {
      provider: fallback.provider,
      sourceId: '<unreadable>',
      nativeSessionId: fallback.nativeSessionId,
      nativeEventId: '<unreadable>',
    };
  }
}

function formatEventCoordinates(input: {
  provider: string;
  sourceId: string;
  nativeSessionId: string;
  nativeEventId: string;
}): string {
  return [
    `provider=${input.provider}`,
    `source=${input.sourceId}`,
    `session=${input.nativeSessionId}`,
    `event=${input.nativeEventId}`,
  ].join(',');
}

function allowedCandidateTransition(
  from: IntelligenceCandidate['reviewState'],
  to: IntelligenceCandidate['reviewState'],
): boolean {
  const transitions: Record<
    IntelligenceCandidate['reviewState'],
    ReadonlySet<IntelligenceCandidate['reviewState']>
  > = {
    pending: new Set(['accepted', 'rejected', 'deferred']),
    deferred: new Set(['pending', 'accepted', 'rejected']),
    accepted: new Set(['superseded']),
    promoted: new Set(['superseded']),
    rejected: new Set(),
    superseded: new Set(),
  };
  return transitions[from].has(to);
}
