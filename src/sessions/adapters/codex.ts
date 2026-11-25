import { discoverJsonl } from '../source-boundary.js';
import { basename, resolve } from 'node:path';
import { z } from 'zod';
import { integer } from '../../schema/zod-validation.mjs';
import {
  schemaRejectionDetail,
  schemaIssueDetail,
  SessionContractError,
  assertSupportedSchemaMajor,
  type AuthorizedScope,
  type ImportCursor,
  type ProviderRecord,
  type SelectedSource,
  type SessionSourceAdapter,
  type SessionEvent,
  type SourceDescriptor,
  type SourceProbe,
} from '../contracts.js';
import {
  streamBoundedJsonLines,
  type BoundedJsonRecord, type ReaderLimits,
} from '../readers.js';

export const CODEX_ADAPTER_VERSION = '1.0.0';
export const CODEX_SOURCE_SCHEMA_VERSION = '1.0.0';

const AppServerEnvelopeSchema = z.looseObject({
  schemaVersion: z.string().optional(),
  productVersion: z.string().optional(),
  method: z.string().min(1),
  result: z.unknown().optional(),
  params: z.unknown().optional(),
});

const ThreadSchema = z.looseObject({
  id: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  parentThreadId: z.string().nullable().optional(),
  forkedFromId: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  preview: z.string().optional(),
  modelProvider: z.string().optional(),
  cliVersion: z.string().optional(),
  createdAt: integer().optional(),
  updatedAt: integer().optional(),
  cwd: z.string().optional(),
  path: z.string().nullable().optional(),
  ephemeral: z.boolean().optional(),
  status: z.unknown().optional(),
  source: z.unknown().optional(),
  gitInfo: z.unknown().optional(),
  turns: z.array(z.unknown()).optional(),
});

const RolloutEnvelopeSchema = z.looseObject({
  schemaVersion: z.string().optional(),
  timestamp: z.string().optional(),
  type: z.string().min(1),
  payload: z.unknown().optional(),
});

type Thread = z.infer<typeof ThreadSchema>;

export class CodexSessionAdapter implements SessionSourceAdapter {
  readonly provider = 'codex' as const;
  readonly adapterVersion = CODEX_ADAPTER_VERSION;
  readonly disposition = 'implemented' as const;
  readonly supportedOperations = ['discover', 'inspect', 'stream'] as const;
  readonly acquisitionModes = ['api', 'jsonl'] as const;

  constructor(
    private readonly limits?: Partial<ReaderLimits>,
    private readonly discoveryLimits = { maxDepth: 8, maxFiles: 10_000 },
  ) {}

  async *discover(scope: AuthorizedScope): AsyncIterable<SourceDescriptor> {
    if (scope.allowedRoots.length === 0) {
      throw new SessionContractError(
        'SOURCE_NOT_AUTHORIZED',
        'Codex discovery requires an explicitly authorized export or sessions root',
      );
    }
    let emitted = 0;
    for (const root of [...scope.allowedRoots].sort()) {
      for await (const locator of discoverJsonl(resolve(root), this.discoveryLimits.maxDepth)) {
        if (++emitted > this.discoveryLimits.maxFiles) {
          throw new SessionContractError(
            'RESOURCE_LIMIT_EXCEEDED',
            'Codex source discovery exceeded the authorized file limit',
            { limit: 'maxFiles', configured: this.discoveryLimits.maxFiles, observed: emitted },
          );
        }
        yield {
          provider: 'codex',
          locator,
          locatorClass: isAppServerLocator(locator)
            ? 'codex-app-server-jsonl'
            : 'codex-rollout-jsonl',
        };
      }
    }
  }

  async inspect(source: SelectedSource): Promise<SourceProbe> {
    const records = this.readSource(source);
    let result = await records.next();
    while (!result.done) result = await records.next();
    return result.value;
  }

  async *stream(source: SelectedSource, cursor?: ImportCursor): AsyncIterable<ProviderRecord> {
    yield* this.readSource(source, cursor);
  }

  private async *readSource(
    source: SelectedSource,
    cursor?: ImportCursor,
  ): AsyncGenerator<ProviderRecord, SourceProbe> {
    const start = parseCursor(cursor?.value);
    const input = await streamBoundedJsonLines(
      { selectedPath: source.locator, allowedRoots: source.authorizedScope.allowedRoots },
      { consistency: 'provisional', limits: this.limits },
    );
    let mode: 'app-server' | 'rollout' | null = isAppServerLocator(source.locator)
      ? 'app-server' : null;
    let schemaVersion: string | null = null;
    const sourceArtifactSessionId = rolloutIdFromFilename(source.locator);
    const rolloutState: RolloutState = { nativeSessionId: sourceArtifactSessionId };
    const identities = new Map<string, string>();
    let outputIndex = 0;
    let sawRecord = false;
    let complete = false;
    let sawActive = false;
    for await (const line of input) {
      sawRecord = true;
      mode ??= isAppServerRecord(line.value) ? 'app-server' : 'rollout';
      const currentSchema = declaredSchemaVersion([line]);
      if (schemaVersion && schemaVersion !== currentSchema) {
        throw new SessionContractError('SCHEMA_DRIFT', 'Codex source declares mixed schema versions', schemaIssueDetail('schemaVersion'));
      }
      schemaVersion = currentSchema;
      assertSupportedSchemaMajor(schemaVersion);
      let normalized: ProviderRecord[];
      if (mode === 'app-server') {
        const parsed = AppServerEnvelopeSchema.safeParse(line.value);
        if (!parsed.success) {
          throw new SessionContractError('MALFORMED_SOURCE', 'Codex App Server record is malformed', schemaRejectionDetail(parsed.error));
        }
        for (const thread of extractThreads(parsed.data)) {
          validateThreadIdentity(thread, identities);
          sawActive ||= statusType(thread.status) === 'active';
        }
        const appServer = normalizeAppServer([line]);
        complete ||= appServer.complete;
        normalized = appServer.records;
      } else {
        const parsed = RolloutEnvelopeSchema.safeParse(line.value);
        if (!parsed.success) {
          throw new SessionContractError('MALFORMED_SOURCE', 'Codex rollout record is malformed', schemaRejectionDetail(parsed.error));
        }
        normalized = [normalizeRolloutRecord(
          rolloutState,
          parsed.data,
          line,
          sourceArtifactSessionId,
        )];
      }
      for (const record of normalized) {
        if (outputIndex++ >= start) yield record;
      }
    }
    if (!sawRecord && !input.incompleteTail) {
      throw new SessionContractError('MALFORMED_SOURCE', 'Codex JSONL source is empty', schemaIssueDetail('<root>'));
    }
    return {
      sourceSchemaVersion: schemaVersion ?? CODEX_SOURCE_SCHEMA_VERSION,
      consistency: complete && !sawActive ? 'complete' : 'provisional',
      operationalState: 'available',
    };
  }

}

function normalizeAppServer(
  input: BoundedJsonRecord[],
): { records: ProviderRecord[]; complete: boolean } {
  const records: ProviderRecord[] = [];
  const identities = new Map<string, string>();
  let complete = false;
  let sawActive = false;
  for (const line of input) {
    const parsed = AppServerEnvelopeSchema.safeParse(line.value);
    if (!parsed.success) {
      throw new SessionContractError('MALFORMED_SOURCE', 'Codex App Server record is malformed', schemaRejectionDetail(parsed.error));
    }
    const envelope = parsed.data;
    const threads = extractThreads(envelope);
    for (const thread of threads) {
      validateThreadIdentity(thread, identities);
      sawActive ||= statusType(thread.status) === 'active';
      records.push(threadEvidence(thread, envelope, line));
      for (const [turnIndex, turn] of (thread.turns ?? []).entries()) {
        for (const [itemIndex, item] of extractItems(turn).entries()) {
          records.push(threadItem(thread, turn, item, line, turnIndex, itemIndex));
        }
      }
    }
    const threadId = notificationThreadId(envelope);
    if (threadId) {
      const event = lifecycleEvent(envelope.method);
      complete ||= event === 'deleted' || event === 'archived';
      records.push({
        nativeSessionId: threadId,
        nativeEventId: `${envelope.method}:${line.sequence}`,
        sequence: line.sequence * 1_000,
        kind: event === 'compacted' ? 'summary' : 'codex.lifecycle',
        role: 'system',
        activityBoundary: event === 'unarchived'
          ? 'resume'
          : event === 'compacted'
            ? 'continuation'
            : event === 'archived' || event === 'deleted'
              ? 'end'
              : undefined,
        activityBoundaryBasis: `codex-app-server:${event}`,
        activityBoundaryConfidence: event === 'status-changed' ? 'medium' : 'high',
        text: '',
        rawReference: { locatorClass: 'codex-app-server-jsonl', offset: line.byteOffset },
        extensions: {
          lifecycleEvent: event,
          provenance: { acquisition: 'codex-app-server', method: envelope.method },
          unknownFields: unknownFields(envelope, APP_SERVER_KEYS),
        },
      });
    }
  }
  return { records, complete: complete && !sawActive };
}

interface RolloutState {
  nativeSessionId?: string;
  metadataId?: string;
  lineage?: Record<string, unknown>;
  replayParentId?: string;
}

function normalizeRolloutRecord(
  state: RolloutState,
  envelope: z.infer<typeof RolloutEnvelopeSchema>,
  line: BoundedJsonRecord,
  sourceArtifactSessionId?: string,
): ProviderRecord {
  const payload = asObject(envelope.payload);
  let firstMetadata = false;
  if (envelope.type === 'session_meta') {
    const declaredId = stringValue(payload.id);
    if (!declaredId) {
      throw new SessionContractError('MALFORMED_SOURCE', 'Codex session metadata is missing its id', schemaIssueDetail('payload.id'));
    }
    if (!state.metadataId) {
      firstMetadata = true;
      state.metadataId = declaredId;
      state.nativeSessionId = declaredId;
      const lineage = rolloutLineage(payload);
      if (Object.keys(lineage).length > 0) state.lineage = lineage;
    } else if (declaredId !== state.metadataId) {
      state.replayParentId ??= declaredId;
    }
  }
  if (!state.nativeSessionId) {
    throw new SessionContractError(
      'MALFORMED_SOURCE',
      'Codex rollout has no session identity before content records',
      schemaIssueDetail('payload.id'),
    );
  }
  const historyStart = state.lineage?.subagentHistoryStartOrdinal;
  // Legacy rollouts have no ordinal boundary; a new turn ends the replay prefix.
  if (historyStart === undefined && (envelope.type === 'turn_context'
    || (envelope.type === 'event_msg' && payload.type === 'task_started'))) {
    state.replayParentId = undefined;
  }
  const parentId = stringValue(state.lineage?.parentThreadId)
    ?? stringValue(state.lineage?.forkedFromId)
    ?? state.replayParentId;
  const inherited = !firstMetadata && parentId && (typeof historyStart === 'number'
    ? (nonnegativeInteger(envelope.ordinal) ?? line.sequence) < historyStart
    : state.replayParentId !== undefined);
  const record = rolloutRecord(state.nativeSessionId, envelope, payload, line, sourceArtifactSessionId);
  if (state.lineage) record.extensions!.lineage = state.lineage;
  if (inherited) {
    record.extensions!.inheritedFromId = parentId;
    record.extensions!.replayed = true;
  }
  return record;
}

/** Apply the rollout identity rule to legacy catalog rows, including split parent replay. */
export function recoverCodexRolloutIdentity(events: readonly SessionEvent[]): {
  nativeSessionId: string;
  lineage: Record<string, unknown>;
} | undefined {
  const metadata = [...events].sort((a, b) => a.sequence - b.sequence || a.eventId.localeCompare(b.eventId))
    .find(event => asObject(event.extensions['native.codex']).rolloutType === 'session_meta');
  if (!metadata?.nativeId) return undefined; // App Server sources can contain multiple independent threads.
  const native = asObject(metadata.extensions['native.codex']);
  return { nativeSessionId: metadata.nativeId,
    lineage: { ...rolloutLineage(asObject(native.unknownFields)), ...asObject(native.lineage) } };
}

function rolloutLineage(payload: Record<string, unknown>): Record<string, unknown> {
  const spawn = asObject(asObject(asObject(payload.source).subagent).thread_spawn);
  return Object.fromEntries(Object.entries({
    forkedFromId: stringValue(payload.forked_from_id),
    parentThreadId: stringValue(spawn.parent_thread_id),
    depth: nonnegativeInteger(spawn.depth ?? payload.depth),
    agentPath: stringValue(payload.agent_path ?? spawn.agent_path),
    agentNickname: stringValue(payload.agent_nickname ?? spawn.agent_nickname),
    subagentHistoryStartOrdinal: nonnegativeInteger(payload.subagent_history_start_ordinal),
    threadSource: stringValue(payload.thread_source),
  }).filter(([, value]) => value !== undefined));
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value : undefined;
}

function threadEvidence(
  thread: Thread,
  envelope: z.infer<typeof AppServerEnvelopeSchema>,
  line: BoundedJsonRecord,
): ProviderRecord {
  const status = statusType(thread.status);
  return {
    nativeSessionId: thread.id,
    nativeEventId: `${envelope.method}:${thread.id}:${line.sequence}`,
    sequence: line.sequence * 1_000,
    kind: 'codex.thread-state',
    role: 'system',
    occurredAt: unixTimestamp(thread.updatedAt ?? thread.createdAt),
    text: '',
    rawReference: { locatorClass: 'codex-app-server-jsonl', offset: line.byteOffset },
    extensions: {
      method: envelope.method,
      status,
      lifecycle: status === 'active' ? 'active' : status === 'notLoaded' ? 'idle' : status,
      sessionTreeId: thread.sessionId,
      parentThreadId: thread.parentThreadId,
      forkedFromId: thread.forkedFromId,
      productVersion: thread.cliVersion ?? envelope.productVersion,
      modelProvider: thread.modelProvider,
      ephemeral: thread.ephemeral,
      workspace: {
        cwdClass: thread.cwd ? '<workspace>' : undefined,
        git: sanitizeGitInfo(thread.gitInfo),
      },
      pagination: paginationEvidence(envelope.result),
      provenance: { acquisition: 'codex-app-server', method: envelope.method },
      unknownFields: unknownFields(thread, THREAD_KEYS),
    },
  };
}

function threadItem(
  thread: Thread,
  turn: unknown,
  item: Record<string, unknown>,
  line: BoundedJsonRecord,
  turnIndex: number,
  itemIndex: number,
): ProviderRecord {
  const type = stringValue(item.type) ?? 'unknown';
  const itemId = stringValue(item.id);
  return {
    nativeSessionId: thread.id,
    nativeEventId: itemId ?? `${stringValue(asObject(turn).id) ?? turnIndex}:${itemIndex}`,
    sequence: line.sequence * 1_000 + turnIndex * 100 + itemIndex + 1,
    kind: itemKind(type),
    role: itemRole(type),
    participant: itemRole(type),
    toolName: stringValue(item.name) ?? stringValue(item.tool_name),
    toolCallId: stringValue(item.call_id),
    occurredAt: stringValue(item.timestamp),
    text: itemText(item),
    rawReference: { locatorClass: 'codex-app-server-jsonl', offset: line.byteOffset },
    extensions: {
      turnId: stringValue(asObject(turn).id),
      itemType: type,
      provenance: { acquisition: 'codex-app-server', method: 'thread/read' },
      unknownFields: unknownFields(item, ITEM_KEYS),
    },
  };
}

function rolloutRecord(
  nativeSessionId: string,
  envelope: z.infer<typeof RolloutEnvelopeSchema>,
  payload: Record<string, unknown>,
  line: BoundedJsonRecord,
  sourceArtifactSessionId?: string,
): ProviderRecord {
  const nativeId = stringValue(payload.id)
    ?? stringValue(payload.call_id)
    ?? `${envelope.type}:${line.sequence}`;
  const message = asObject(payload.message);
  const role = stringValue(payload.role) ?? stringValue(message.role);
  return {
    nativeSessionId,
    nativeEventId: nativeId,
    sequence: line.sequence,
    kind: rolloutKind(envelope.type, payload),
    role,
    participant: role,
    toolName: stringValue(payload.name) ?? stringValue(payload.tool_name),
    toolCallId: stringValue(payload.call_id),
    model: stringValue(payload.model),
    occurredAt: envelope.timestamp,
    activityBoundary: envelope.type === 'compacted'
      ? 'continuation'
      : envelope.type === 'event_msg'
        && stringValue(payload.type) === 'task_complete'
        ? 'end'
        : undefined,
    activityBoundaryBasis: envelope.type === 'compacted'
      ? 'codex-rollout:compacted'
      : envelope.type === 'event_msg' && stringValue(payload.type) === 'task_complete'
        ? 'codex-rollout:task-complete'
        : undefined,
    activityBoundaryConfidence: envelope.type === 'compacted'
      || (envelope.type === 'event_msg' && stringValue(payload.type) === 'task_complete')
      ? 'high'
      : undefined,
    text: rolloutText(payload),
    rawReference: { locatorClass: 'codex-rollout-jsonl', offset: line.byteOffset },
    extensions: {
      rolloutType: envelope.type,
      workspace: envelope.type === 'session_meta'
        ? {
            cwdClass: stringValue(payload.cwd) ? '<workspace>' : undefined,
            git: sanitizeGitInfo(payload.git),
          }
        : undefined,
      productVersion: stringValue(payload.cli_version),
      provenance: { acquisition: 'codex-rollout', durableReplay: true },
      transcriptFamily: {
        sourceArtifactSessionId,
        nativeSessionId,
        identityRelation: !sourceArtifactSessionId || sourceArtifactSessionId === nativeSessionId
          ? 'self'
          : 'related',
      },
      opaque: !KNOWN_ROLLOUT_TYPES.has(envelope.type),
      unknownFields: unknownFields(payload, ROLLOUT_KEYS),
    },
  };
}

function extractThreads(
  envelope: z.infer<typeof AppServerEnvelopeSchema>,
): Thread[] {
  const result = asObject(envelope.result);
  const candidates = Array.isArray(result.data)
    ? result.data
    : result.thread ? [result.thread] : [];
  return candidates.map((candidate) => {
    const parsed = ThreadSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new SessionContractError('MALFORMED_SOURCE', 'Codex App Server thread is malformed', schemaRejectionDetail(parsed.error));
    }
    return parsed.data;
  });
}

function validateThreadIdentity(thread: Thread, identities: Map<string, string>): void {
  const sessionTree = thread.sessionId ?? thread.id;
  const previous = identities.get(thread.id);
  if (previous && previous !== sessionTree) {
    throw new SessionContractError('SCHEMA_DRIFT', 'Codex thread session-tree identity changed', schemaIssueDetail('sessionId'));
  }
  identities.set(thread.id, sessionTree);
}

function extractItems(turn: unknown): Record<string, unknown>[] {
  const value = asObject(turn);
  if (!Array.isArray(value.items)) return [];
  return value.items.map(asObject);
}

function notificationThreadId(
  envelope: z.infer<typeof AppServerEnvelopeSchema>,
): string | undefined {
  if (!/^thread\/(status\/changed|archived|unarchived|deleted|compacted)$/.test(envelope.method)
    && envelope.method !== 'context/compacted') return undefined;
  const params = asObject(envelope.params);
  return stringValue(params.threadId) ?? stringValue(params.thread_id);
}

function lifecycleEvent(method: string): string {
  if (method.includes('status')) return 'status-changed';
  if (method.includes('unarchive')) return 'unarchived';
  if (method.includes('archive')) return 'archived';
  if (method.includes('delete')) return 'deleted';
  return 'compacted';
}

function itemKind(type: string): string {
  if (type === 'userMessage' || type === 'agentMessage') return 'message';
  if (type.includes('Command') || type.includes('Tool') || type.includes('Mcp')) return 'tool-call';
  if (type.includes('FileChange')) return 'artifact';
  if (type.includes('Compaction')) return 'summary';
  return `codex.${type}`;
}

function itemRole(type: string): string | undefined {
  if (type === 'userMessage') return 'user';
  if (type === 'agentMessage') return 'assistant';
  return 'tool';
}

function itemText(item: Record<string, unknown>): string {
  return stringValue(item.text)
    ?? stringValue(item.command)
    ?? stringValue(item.name)
    ?? '';
}

function rolloutKind(type: string, payload: Record<string, unknown>): string {
  if (type === 'compacted') return 'summary';
  if (type === 'response_item') {
    const payloadType = stringValue(payload.type);
    if (payloadType === 'message') return 'message';
    if (payloadType?.includes('call')) return 'tool-call';
    if (payloadType?.includes('output')) return 'tool-result';
  }
  return `codex.${type}`;
}

function rolloutText(payload: Record<string, unknown>): string {
  const direct = stringValue(payload.text);
  if (direct) return direct;
  const content = payload.content;
  if (!Array.isArray(content)) return '';
  return content.map((entry) => {
    const value = asObject(entry);
    return stringValue(value.text) ?? stringValue(value.input_text) ?? stringValue(value.output_text) ?? '';
  }).filter(Boolean).join('\n');
}

function statusType(value: unknown): string {
  if (typeof value === 'string') return value;
  return stringValue(asObject(value).type) ?? 'unknown';
}

function paginationEvidence(value: unknown): Record<string, unknown> | undefined {
  const result = asObject(value);
  if (!('nextCursor' in result) && !('backwardsCursor' in result)) return undefined;
  return {
    hasNext: typeof result.nextCursor === 'string',
    hasBackwards: typeof result.backwardsCursor === 'string',
  };
}

function sanitizeGitInfo(value: unknown): Record<string, unknown> | undefined {
  const git = asObject(value);
  if (Object.keys(git).length === 0) return undefined;
  return {
    branch: stringValue(git.branch),
    commit: stringValue(git.commitHash) ?? stringValue(git.commit),
    repositoryClass: stringValue(git.repositoryUrl) ? '<repository>' : undefined,
  };
}

function isAppServerLocator(locator: string): boolean {
  return /\.app-server\.jsonl$/i.test(locator);
}

function isAppServerRecord(value: unknown): boolean {
  const record = asObject(value);
  return typeof record.method === 'string';
}

function declaredSchemaVersion(records: BoundedJsonRecord[]): string {
  for (const record of records) {
    const version = asObject(record.value).schemaVersion;
    if (typeof version === 'string') return version;
  }
  return CODEX_SOURCE_SCHEMA_VERSION;
}

function rolloutIdFromFilename(locator: string): string | undefined {
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i
    .exec(basename(locator));
  return match?.[1];
}

function parseCursor(value?: string): number {
  if (value === undefined || value === '') return 0;
  if (!/^\d+$/.test(value)) throw new SessionContractError('SCHEMA_DRIFT', 'Codex record cursor is invalid', schemaIssueDetail('cursor'));
  return Number(value);
}

function unixTimestamp(value?: number): string | undefined {
  return value === undefined ? undefined : new Date(value * 1_000).toISOString();
}

function asObject(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function unknownFields(
  value: Record<string, unknown>,
  known: ReadonlySet<string>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !known.has(key)));
}

const APP_SERVER_KEYS = new Set(['schemaVersion', 'productVersion', 'method', 'result', 'params']);
const THREAD_KEYS = new Set([
  'id', 'sessionId', 'parentThreadId', 'forkedFromId', 'name', 'preview',
  'modelProvider', 'cliVersion', 'createdAt', 'updatedAt', 'cwd', 'path',
  'ephemeral', 'status', 'source', 'gitInfo', 'turns',
]);
const ITEM_KEYS = new Set(['id', 'type', 'text', 'command', 'name', 'timestamp']);
const ROLLOUT_KEYS = new Set([
  'id', 'call_id', 'type', 'role', 'message', 'text', 'content', 'cwd',
  'git', 'cli_version',
]);
const KNOWN_ROLLOUT_TYPES = new Set([
  'session_meta', 'turn_context', 'event_msg', 'response_item', 'compacted',
]);
