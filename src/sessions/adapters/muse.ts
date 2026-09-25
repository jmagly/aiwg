/**
 * Muse Code session adapter — manual export only, trajectory-first.
 *
 * Muse Code journals model calls, tool runs, and approvals to an append-only
 * session log and projects it into a self-contained JSON document via
 * `muse export` (also surfaced as `/export trajectory`). The adapter ingests
 * ONLY those explicit operator-supplied export documents, gated on the
 * document's `export_schema_version` major (currently `1`); unknown majors
 * fail closed with `UNKNOWN_SCHEMA_MAJOR`, as with peer native-export
 * adapters.
 *
 * Auto-discovery is unsupported and must never scrape home directories or
 * invent session roots. The documented candidate native root
 * (`$XDG_DATA_HOME/muse/sessions/YYYY/MM/DD/<session-id>/session.jsonl`,
 * default `~/.local/share/muse/sessions`) is NOT authorized or implemented
 * here; a future evidence-gated `--muse-root` discover path remains the
 * route to native discovery (#222 PR B).
 *
 * Trajectory shape follows the documented export format at
 * https://dev.meta.ai/docs/cookbook/audit-agent-sessions: top-level
 * `export_schema_version`, `redaction`, `exporter_version`, `session_build`,
 * `session_terminated_abnormally`, per-stream `sessions` summaries, ordered
 * `events` elements with `envelope`/`payload`, and `diagnostics` counters.
 * Approval, tool, and model-lifecycle facts are preserved with provenance
 * under `extensions['native.muse']`.
 *
 * Live-evidence notes (real `muse export`, Muse Code 1.3.0, build
 * `3c572bc734`, 2026-09-24): the document carries exactly one `sessions[]`
 * summary per exported parent session; subagents appear only inside
 * `sessions[0].accepted_spawns[]` as spawn handles, never as extra summaries.
 * Every merged record event carries its own `envelope.stream.id` (always the
 * parent here), so attribution reads the envelope per event. Subagent tool
 * runs are NOT merged — they live in `subagent/<child_session_id>/session.jsonl`
 * under their own stream id; only `subagent.control.*` records (26 in the
 * probe) are merged, linked via `child_session_bound.child_session_id` /
 * `start_attested.subagent_session_id`. CRITICAL: `subagent_id` (spawn handle)
 * and `child_session_id` (child session/dir identity) are distinct values and
 * must never be conflated. Gap markers carry `"envelope": null` and are
 * skipped, never fabricated into records.
 *
 * @see docs/providers/muse-sessions.md
 * @issue #232
 */

import { z } from 'zod';
import {
  SessionContractError,
  assertSupportedSchemaMajor,
  type AuthorizedScope,
  type ImportCursor,
  type ProviderRecord,
  type SelectedSource,
  type SessionSourceAdapter,
  type SourceDescriptor,
  type SourceProbe,
} from '../contracts.js';
import { readBoundedJson, type ReaderLimits } from '../readers.js';

export const MUSE_ADAPTER_VERSION = '1.0.0';
export const MUSE_EXPORT_SCHEMA_VERSION = '1.0.0';
export const MUSE_EXPORT_SCHEMA_MAJOR = 1;
export const MUSE_LOCATOR_CLASS = 'manual-export' as const;

const Rfc3339Schema = z.string().refine(
  (value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value)),
  'timestamp must be RFC 3339 with an explicit UTC offset',
);

/**
 * One log line projected by `muse export`. Per the documented format, each
 * record element is an envelope `{sequence, recorded_at, record_type,
 * durability, payload_type, payload}`; the interesting content is
 * `payload.event.kind` (a task-lifecycle or runtime event) or `payload_type`
 * (a stream fact). Live exports (Muse Code 1.3.0) also carry `id`,
 * `causation_id`, `schema_version`, `payload_schema_version`, and a
 * `stream: {kind, id}` block on every record envelope; gap markers carry
 * `"envelope": null` instead.
 */
const MuseStreamSchema = z.object({
  kind: z.string().optional(),
  id: z.string().optional(),
}).passthrough();

const MuseEnvelopeSchema = z.object({
  sequence: z.number().int().nonnegative(),
  id: z.string().optional(),
  causation_id: z.string().nullish(),
  schema_version: z.union([z.number(), z.string()]).optional(),
  payload_schema_version: z.union([z.number(), z.string()]).optional(),
  stream: MuseStreamSchema.optional(),
  // Muse Code 1.4.0 exports epoch microseconds; RFC 3339 strings stay valid.
  recorded_at: z.union([z.string(), z.number().int().nonnegative()]).optional(),
  record_type: z.string().optional(),
  durability: z.string().optional(),
  payload_type: z.string().optional(),
  payload: z.object({
    event: z.object({ kind: z.string().min(1) }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();

/**
 * Record events carry a record envelope, validated strictly. Every other
 * event kind is an audit marker: `gap` carries `"envelope": null`, and
 * `retained_frame` (Muse Code 1.4.0) carries a transaction frame
 * (`children`, `transaction_id`, `content_sha256`) instead of a record.
 * Markers are never fabricated into provider records.
 */
const MuseRecordEventSchema = z.object({
  kind: z.literal('record'),
  envelope: MuseEnvelopeSchema,
}).passthrough();

const MuseMarkerEventSchema = z.object({
  kind: z.string().min(1).refine((kind) => kind !== 'record'),
  envelope: z.record(z.string(), z.unknown()).nullish(),
}).passthrough();

const MuseExportEventSchema = z.union([MuseRecordEventSchema, MuseMarkerEventSchema]);

const MuseAcceptedSpawnSchema = z.object({
  subagent_id: z.string().optional(),
  agent_path: z.string().optional(),
  role: z.string().optional(),
  parent_session_id: z.string().optional(),
}).passthrough();

const MuseSessionSummarySchema = z.object({
  session_id: z.string().min(1),
  turn_count: z.number().int().nonnegative().optional(),
  step_count: z.number().int().nonnegative().optional(),
  // Live evidence: one summary per exported parent session; subagents appear
  // only here, as spawn handles (subagent_id), never as extra summaries.
  accepted_spawns: z.array(MuseAcceptedSpawnSchema).optional(),
  session_end: z.object({
    exit_reason: z.string().optional(),
    uptime_ms: z.number().nonnegative().optional(),
  }).passthrough().optional(),
}).passthrough();

const MuseDiagnosticsSchema = z.object({
  unparseable_lines: z.number().int().nonnegative().optional(),
  unknown_payload_kinds: z.number().int().nonnegative().optional(),
  gaps: z.number().int().nonnegative().optional(),
  omitted_live_only: z.number().int().nonnegative().optional(),
  duplicate_records: z.number().int().nonnegative().optional(),
}).passthrough();

const MuseTrajectorySchema = z.object({
  export_schema_version: z.number().int().nonnegative(),
  redaction: z.string().optional(),
  exporter_version: z.object({ display: z.string() }).passthrough().optional(),
  session_build: z.object({ display: z.string() }).passthrough().optional(),
  session_terminated_abnormally: z.boolean().optional(),
  sessions: z.array(MuseSessionSummarySchema).min(1),
  events: z.array(MuseExportEventSchema),
  diagnostics: MuseDiagnosticsSchema.optional(),
}).passthrough();

type MuseTrajectory = z.infer<typeof MuseTrajectorySchema>;
type MuseExportEvent = z.infer<typeof MuseExportEventSchema>;
type MuseRecordEvent = z.infer<typeof MuseRecordEventSchema>;

function isRecordEvent(event: MuseExportEvent): event is MuseRecordEvent {
  return event.kind === 'record';
}
type MuseEnvelope = z.infer<typeof MuseEnvelopeSchema>;

export class MuseSessionAdapter implements SessionSourceAdapter {
  readonly provider = 'muse' as const;
  readonly adapterVersion = MUSE_ADAPTER_VERSION;
  readonly disposition = 'manual-only' as const;
  readonly supportedOperations = ['inspect', 'stream'] as const;
  readonly acquisitionModes = ['manual-export'] as const;

  constructor(private readonly limits?: Partial<ReaderLimits>) {}

  async *discover(_scope: AuthorizedScope): AsyncIterable<SourceDescriptor> {
    throw new SessionContractError(
      'UNSUPPORTED_OPERATION',
      'Muse Code session auto-discover is unsupported: the native log under '
        + '$XDG_DATA_HOME/muse/sessions uses an internal format. Run `muse export --session '
        + '<id-or-session.jsonl>` and select that trajectory file. AIWG does not scrape home '
        + 'directories for this provider.',
    );
  }

  async inspect(source: SelectedSource): Promise<SourceProbe> {
    this.assertManualExport(source);
    const { trajectory } = await this.readTrajectory(source);
    for (const event of trajectory.events) this.parseEvent(event);
    return {
      sourceSchemaVersion: MUSE_EXPORT_SCHEMA_VERSION,
      consistency: trajectory.session_terminated_abnormally === false ? 'complete' : 'provisional',
      operationalState: 'available',
    };
  }

  async *stream(
    source: SelectedSource,
    cursor?: ImportCursor,
  ): AsyncIterable<ProviderRecord> {
    this.assertManualExport(source);
    const { trajectory, bytesRead } = await this.readTrajectory(source);
    const start = parseEventCursor(cursor?.value);
    const spawns = acceptedSpawnsById(trajectory);
    let index = 0;
    for (const event of trajectory.events) {
      // Cursor positions are raw event positions so resume stays aligned
      // even when gap markers are skipped.
      const position = index;
      index += 1;
      if (position < start) continue;
      // Gap/retained-frame markers carry no record payload: skip them, never
      // fabricate a ProviderRecord for one.
      if (!isRecordEvent(event)) continue;
      yield this.toProviderRecord(trajectory, bytesRead, event.envelope, spawns, event, position);
    }
  }

  private async readTrajectory(source: SelectedSource): Promise<{ trajectory: MuseTrajectory; bytesRead: number }> {
    let value: unknown;
    let bytesRead: number;
    try {
      ({ value, bytesRead } = await readBoundedJson(
        { selectedPath: source.locator, allowedRoots: source.authorizedScope.allowedRoots },
        this.limits,
      ));
    } catch (error) {
      if (error instanceof SessionContractError && error.code === 'SCHEMA_DRIFT') {
        throw new SessionContractError('MALFORMED_SOURCE', 'muse export document is not valid JSON');
      }
      throw error;
    }
    const parsed = MuseTrajectorySchema.safeParse(value);
    if (!parsed.success) {
      throw new SessionContractError(
        'MALFORMED_SOURCE',
        'input is not a declared muse export trajectory document',
      );
    }
    assertSupportedSchemaMajor(`${parsed.data.export_schema_version}.0.0`, MUSE_EXPORT_SCHEMA_MAJOR);
    return { trajectory: parsed.data, bytesRead };
  }

  private parseEvent(event: MuseExportEvent): void {
    eventKindOf(event);
  }

  private toProviderRecord(
    trajectory: MuseTrajectory,
    bytesRead: number,
    envelope: MuseEnvelope,
    spawns: Map<string, { agentPath?: string; role?: string }>,
    event: MuseExportEvent,
    index: number,
  ): ProviderRecord {
    // Attribute by the event's own stream id; fall back to the document's
    // first session summary only when the stream block is absent. Live
    // evidence (Muse Code 1.3.0) shows merged events always carry the parent
    // id here, so never assume sessions[0] without reading the envelope.
    const nativeSessionId = streamSessionIdOf(envelope) ?? trajectory.sessions[0].session_id;
    const payload = envelope.payload ?? {};
    const payloadRecord = payload as Record<string, unknown>;
    const eventKind = eventKindOf(event);
    const toolName = toolNameOf(payloadRecord);
    const policyDecision = stringField(payloadRecord, 'policy_decision');
    const operation = stringField(payloadRecord, 'operation');
    const decision = stringField(payloadRecord, 'decision');
    const approvalOutcome = stringField(payloadRecord, 'outcome');
    const decisionSource = objectField(payloadRecord, 'decision_source');
    const linkage = subagentLinkageOf(payloadRecord);
    const spawnContext = spawnContextOf(spawns, envelope.payload_type, linkage.subagentId);
    return {
      nativeSessionId,
      nativeEventId: `muse-seq-${envelope.sequence}`,
      sequence: index,
      kind: eventKind,
      role: undefined,
      participant: undefined,
      toolName: toolName ?? undefined,
      toolCallId: undefined,
      model: undefined,
      entities: [],
      occurredAt: occurredAtOf(envelope.recorded_at) ?? undefined,
      text: describeEvent(eventKind, envelope.sequence, {
        operation, policyDecision, decision, approvalOutcome, decisionSource,
      }),
      rawReference: { locatorClass: MUSE_LOCATOR_CLASS, sequence: index },
      sourceCursor: String(index + 1),
      sourceBytes: bytesRead,
      extensions: {
        'native.muse': compactObject({
          eventKind,
          recordType: event.kind,
          payloadType: envelope.payload_type,
          durability: envelope.durability,
          streamKind: envelope.stream?.kind,
          streamId: streamSessionIdOf(envelope),
          envelopeSequence: envelope.sequence,
          envelopeId: envelope.id,
          causationId: envelope.causation_id,
          exportSchemaVersion: trajectory.export_schema_version,
          redaction: trajectory.redaction,
          exporterVersion: trajectory.exporter_version?.display,
          sessionBuild: trajectory.session_build?.display,
          terminatedAbnormally: trajectory.session_terminated_abnormally,
          operation,
          policyDecision,
          decision,
          decisionSource,
          approvalOutcome,
          ...linkage,
          ...spawnContext,
          diagnostics: trajectory.diagnostics,
        }),
      },
    };
  }

  private assertManualExport(source: SelectedSource): void {
    if (source.locatorClass !== MUSE_LOCATOR_CLASS) {
      throw new SessionContractError(
        'UNSUPPORTED_OPERATION',
        `Muse Code supports only locatorClass "${MUSE_LOCATOR_CLASS}" because its native log format is internal `
          + `(got "${source.locatorClass}"). Select an explicit \`muse export\` trajectory file.`,
      );
    }
  }
}

/**
 * Effective event kind per the documented jq projection:
 * `payload.event.kind`, falling back to `payload_type` (a stream fact such
 * as `approval_wait.effect.started`). Gap/retained-frame markers have no
 * envelope, so fall back to the marker kind (e.g. `gap`).
 */
function eventKindOf(event: MuseExportEvent): string {
  if (!isRecordEvent(event)) return event.kind;
  const envelope = event.envelope;
  const payload = envelope.payload;
  const eventKind = payload?.event?.kind;
  if (typeof eventKind === 'string' && eventKind.length > 0) return eventKind;
  const payloadType = envelope.payload_type;
  if (typeof payloadType === 'string' && payloadType.length > 0) return payloadType;
  return event.kind;
}

/**
 * Per-event stream session id from the envelope. Live evidence (Muse Code
 * 1.3.0) shows this is always the exported parent session id for merged
 * record events; subagent tool runs are not merged at all.
 */
function streamSessionIdOf(envelope: MuseEnvelope): string | null {
  const streamId = envelope.stream?.id;
  return typeof streamId === 'string' && streamId.length > 0 ? streamId : null;
}

/**
 * Spawn handles from `sessions[0].accepted_spawns[]`, keyed by subagent_id.
 * These are the spawn-side keys for joining merged control-plane records to
 * child sessions; they are NOT child session ids.
 */
function acceptedSpawnsById(
  trajectory: MuseTrajectory,
): Map<string, { agentPath?: string; role?: string }> {
  const spawns = new Map<string, { agentPath?: string; role?: string }>();
  for (const spawn of trajectory.sessions[0].accepted_spawns ?? []) {
    if (typeof spawn.subagent_id === 'string' && spawn.subagent_id.length > 0) {
      spawns.set(spawn.subagent_id, { agentPath: spawn.agent_path, role: spawn.role });
    }
  }
  return spawns;
}

/**
 * Subagent spawn/child linkage from control-plane payloads. CRITICAL: live
 * evidence (Muse Code 1.3.0) shows `subagent_id` is the spawn handle while
 * `child_session_id` (from `child_session_bound`) and `subagent_session_id`
 * (from `start_attested`) are the child session identity — distinct values,
 * also naming the `subagent/<child-id>/session.jsonl` directories. Never
 * conflate the two.
 */
function subagentLinkageOf(payload: Record<string, unknown>): {
  subagentId?: string;
  childSessionId?: string;
  subagentSessionId?: string;
  eventChildSessionId?: string;
  sourceSessionId?: string;
} {
  const record = objectField(payload, 'record');
  const event = objectField(payload, 'event');
  return compactObject({
    subagentId: record ? stringField(record, 'subagent_id') ?? undefined : undefined,
    childSessionId: record ? stringField(record, 'child_session_id') ?? undefined : undefined,
    subagentSessionId: record ? stringField(record, 'subagent_session_id') ?? undefined : undefined,
    eventChildSessionId: event ? stringField(event, 'child_session_id') ?? undefined : undefined,
    sourceSessionId: stringField(payload, 'source_session_id') ?? undefined,
  });
}

/**
 * Human context for a merged subagent control-plane record, joined against
 * the document's accepted spawns. The join key is the spawn handle
 * (subagent_id); the child session id stays separate.
 */
function spawnContextOf(
  spawns: Map<string, { agentPath?: string; role?: string }>,
  payloadType: string | undefined,
  subagentId: string | undefined,
): { spawnAgentPath?: string; spawnRole?: string } {
  if (payloadType == null || !payloadType.startsWith('subagent.control.')) return {};
  if (subagentId == null) return {};
  const spawn = spawns.get(subagentId);
  if (!spawn) return {};
  return compactObject({ spawnAgentPath: spawn.agentPath, spawnRole: spawn.role });
}

/**
 * `side_effect_intent` carries `operation: tool:<name>` (documented as
 * `operation: tool:bash`); extract the tool name only from that documented
 * shape.
 */
function toolNameOf(payload: Record<string, unknown>): string | null {
  const operation = stringField(payload, 'operation');
  if (!operation) return null;
  const match = /^tool:(.+)$/.exec(operation);
  return match ? match[1] : null;
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function objectField(payload: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = payload[key];
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function occurredAtOf(recordedAt: string | number | undefined): string | null {
  if (typeof recordedAt === 'number') {
    // Epoch microseconds (Muse Code 1.4.0 export and native log).
    const date = new Date(Math.floor(recordedAt / 1000));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (!recordedAt) return null;
  return Rfc3339Schema.safeParse(recordedAt).success ? recordedAt : null;
}

function describeEvent(
  eventKind: string,
  sequence: number,
  provenance: {
    operation: string | null;
    policyDecision: string | null;
    decision: string | null;
    approvalOutcome: string | null;
    decisionSource: Record<string, unknown> | null;
  },
): string {
  const parts = [`muse export trajectory event ${eventKind} (sequence ${sequence})`];
  if (provenance.operation) parts.push(`operation=${provenance.operation}`);
  if (provenance.policyDecision) parts.push(`policy_decision=${provenance.policyDecision}`);
  if (provenance.decision) parts.push(`decision=${provenance.decision}`);
  if (provenance.decisionSource) {
    const sourceKind = provenance.decisionSource.kind;
    if (typeof sourceKind === 'string' && sourceKind.length > 0) {
      parts.push(`decision_source=${sourceKind}`);
    }
  }
  if (provenance.approvalOutcome) parts.push(`outcome=${provenance.approvalOutcome}`);
  return parts.join(' ');
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null));
}

function parseEventCursor(value?: string): number {
  if (value === undefined || value === '') return 0;
  if (!/^\d+$/.test(value)) throw new SessionContractError('SCHEMA_DRIFT', 'muse event cursor is invalid');
  return Number(value);
}
