import { discoverJsonl } from '../source-boundary.js';
import { basename, extname, resolve } from 'node:path';
import { z } from 'zod';
import { dateTime, number } from '../../schema/zod-validation.mjs';
import {
  schemaRejectionDetail,
  schemaIssueDetail,
  SessionContractError,
  assertSupportedSchemaMajor,
  sha256,
  type AuthorizedScope,
  type ImportCursor,
  type ProviderRecord,
  type SelectedSource,
  type SessionSourceAdapter,
  type SourceDescriptor,
  type SourceProbe,
} from '../contracts.js';
import { redactSourceLocator } from '../discovery.js';
import {
  readBoundedJson, streamBoundedJsonLines,
  type BoundedJsonRecord, type ReaderLimits,
} from '../readers.js';

export const CLAUDE_ADAPTER_VERSION = '1.1.0';
export const CLAUDE_TRANSCRIPT_SCHEMA_VERSION = '1.0.0';
/** AIWG's own understanding of the layout it supports; Claude web/account
 *  exports carry no in-band schema version to read instead. */
export const CLAUDE_WEB_EXPORT_SCHEMA_VERSION = '1.0.0';

const ClaudeRecordSchema = z.looseObject({
  type: z.string().min(1),
  subtype: z.string().optional(),
  uuid: z.string().min(1).optional(),
  parentUuid: z.string().min(1).nullable().optional(),
  sessionId: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  timestamp: dateTime({ offset: true }).optional(),
  cwd: z.string().optional(),
  gitBranch: z.string().optional(),
  parentSessionId: z.string().min(1).optional(),
  isSidechain: z.boolean().optional(),
  agentId: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  version: z.string().optional(),
  schemaVersion: z.string().optional(),
  message: z.looseObject({
    id: z.string().min(1).optional(),
    role: z.string().min(1).optional(),
    content: z.union([z.string(), z.array(z.unknown())]).optional(),
  }).optional(),
});

const ClaudeHookSchema = z.looseObject({
  session_id: z.string().min(1),
  transcript_path: z.string().min(1),
  cwd: z.string().min(1),
  hook_event_name: z.string().min(1),
  permission_mode: z.string().optional(),
  source: z.enum(['startup', 'resume', 'clear', 'compact']).optional(),
  model: z.string().optional(),
  reason: z.string().optional(),
  schemaVersion: z.string().optional(),
  timestamp: dateTime({ offset: true }).optional(),
});

type ClaudeRecord = z.infer<typeof ClaudeRecordSchema>;
type ClaudeHook = z.infer<typeof ClaudeHookSchema>;

/**
 * Claude.ai web/account data export (`conversations.json`): a JSON array of
 * conversations, each carrying its own `chat_messages`. This is a distinct
 * source format from local JSONL transcripts/hooks -- renaming the file does
 * not make it one (#2565). Unrecognized fields are captured via unknownFields
 * rather than dropped, and content the export marks as an attachment/file is
 * recorded as a reference (bytes are not embedded in this export format).
 */
const ClaudeWebExportAttachmentSchema = z.looseObject({
  file_name: z.string().optional(),
  file_type: z.string().optional(),
  file_size: number().optional(),
  extracted_content: z.string().optional(),
});

const ClaudeWebExportContentBlockSchema = z.looseObject({
  type: z.string().optional(),
  text: z.string().optional(),
});

const ClaudeWebExportMessageSchema = z.looseObject({
  uuid: z.string().min(1),
  text: z.string().optional(),
  sender: z.enum(['human', 'assistant']),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  content: z.array(ClaudeWebExportContentBlockSchema).optional(),
  attachments: z.array(ClaudeWebExportAttachmentSchema).optional(),
  files: z.array(ClaudeWebExportAttachmentSchema).optional(),
});

const ClaudeWebExportConversationSchema = z.looseObject({
  uuid: z.string().min(1),
  name: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  account: z.looseObject({ uuid: z.string().optional() }).optional(),
  chat_messages: z.array(ClaudeWebExportMessageSchema),
});

const ClaudeWebExportSchema = z.array(ClaudeWebExportConversationSchema);

type ClaudeWebExportMessage = z.infer<typeof ClaudeWebExportMessageSchema>;
type ClaudeWebExportConversation = z.infer<typeof ClaudeWebExportConversationSchema>;

export class ClaudeSessionAdapter implements SessionSourceAdapter {
  readonly provider = 'claude' as const;
  readonly adapterVersion = CLAUDE_ADAPTER_VERSION;
  readonly disposition = 'implemented' as const;
  readonly supportedOperations = ['discover', 'inspect', 'stream'] as const;
  readonly acquisitionModes = ['jsonl', 'hook', 'manual-export'] as const;

  constructor(
    private readonly limits?: Partial<ReaderLimits>,
    private readonly discoveryLimits = { maxDepth: 8, maxFiles: 10_000 },
  ) {}

  async *discover(scope: AuthorizedScope): AsyncIterable<SourceDescriptor> {
    if (scope.allowedRoots.length === 0) {
      throw new SessionContractError(
        'SOURCE_NOT_AUTHORIZED',
        'Claude discovery requires an explicitly authorized projects or hook root',
      );
    }
    let emitted = 0;
    for (const root of [...scope.allowedRoots].sort()) {
      for await (const locator of discoverJsonl(resolve(root), this.discoveryLimits.maxDepth)) {
        emitted += 1;
        if (emitted > this.discoveryLimits.maxFiles) {
          throw new SessionContractError(
            'RESOURCE_LIMIT_EXCEEDED',
            'Claude source discovery exceeded the authorized file limit',
            { limit: 'maxFiles', configured: this.discoveryLimits.maxFiles, observed: emitted },
          );
        }
        yield {
          provider: 'claude',
          locator,
          locatorClass: isHookLocator(locator) ? 'claude-hook-jsonl' : 'claude-transcript-jsonl',
        };
      }
    }
  }

  async inspect(source: SelectedSource): Promise<SourceProbe> {
    if (source.locatorClass === 'claude-web-export-json') {
      const parsed = await this.readWebExportSource(source);
      return {
        sourceSchemaVersion: parsed.schemaVersion,
        consistency: parsed.consistency,
        operationalState: 'available',
      };
    }
    const records = this.readSource(source);
    let result = await records.next();
    while (!result.done) result = await records.next();
    return result.value;
  }

  async *stream(source: SelectedSource, cursor?: ImportCursor): AsyncIterable<ProviderRecord> {
    if (source.locatorClass === 'claude-web-export-json') {
      const parsed = await this.readWebExportSource(source);
      const start = parseRecordCursor(cursor?.value);
      for (const record of parsed.records.slice(start)) yield record;
      return;
    }
    yield* this.readSource(source, cursor);
  }

  private async *readSource(
    source: SelectedSource,
    cursor?: ImportCursor,
  ): AsyncGenerator<ProviderRecord, SourceProbe> {
    const start = parseRecordCursor(cursor?.value);
    const input = await streamBoundedJsonLines(
      {
        selectedPath: source.locator,
        allowedRoots: source.authorizedScope.allowedRoots,
      },
      { consistency: 'provisional', limits: this.limits },
    );
    let hookSource: boolean | undefined = isHookLocator(source.locator) ? true : undefined;
    let outputIndex = 0;
    let sawRecord = false;
    let complete = false;
    let schemaVersion: string | null = null;
    for await (const line of input) {
      sawRecord = true;
      const value = line.value && typeof line.value === 'object'
        ? line.value as Record<string, unknown> : {};
      const currentSchema = typeof value.schemaVersion === 'string'
        ? value.schemaVersion : CLAUDE_TRANSCRIPT_SCHEMA_VERSION;
      if (schemaVersion && currentSchema !== schemaVersion) {
        throw new SessionContractError('SCHEMA_DRIFT', 'Claude source declares mixed schema versions', schemaIssueDetail('schemaVersion'));
      }
      schemaVersion = currentSchema;
      assertSupportedSchemaMajor(schemaVersion);
      hookSource ??= isHookRecord(line.value);
      const normalized = hookSource
        ? normalizeHooks([line])
        : normalizeTranscript([line], source.locator);
      complete ||= normalized.complete;
      for (const record of normalized.records) {
        if (outputIndex++ >= start) yield record;
      }
    }
    if (!sawRecord && !input.incompleteTail) {
      throw new SessionContractError('MALFORMED_SOURCE', 'Claude JSONL source is empty', schemaIssueDetail('<root>'));
    }
    return {
      sourceSchemaVersion: schemaVersion ?? CLAUDE_TRANSCRIPT_SCHEMA_VERSION,
      consistency: complete ? 'complete' : 'provisional',
      operationalState: 'available',
    };
  }

  private async readWebExportSource(source: SelectedSource): Promise<{
    records: ProviderRecord[];
    schemaVersion: string;
    consistency: 'provisional' | 'complete';
  }> {
    const { value } = await readBoundedJson(
      { selectedPath: source.locator, allowedRoots: source.authorizedScope.allowedRoots },
      this.limits,
    );
    const parsed = ClaudeWebExportSchema.safeParse(value);
    if (!parsed.success) {
      throw new SessionContractError(
        'MALFORMED_SOURCE',
        'Claude web/account export is not a recognized conversations.json layout',
        schemaRejectionDetail(parsed.error),
      );
    }
    if (parsed.data.length === 0) {
      throw new SessionContractError('MALFORMED_SOURCE', 'Claude web/account export is empty', schemaIssueDetail('<root>'));
    }
    return {
      records: normalizeWebExport(parsed.data),
      schemaVersion: CLAUDE_WEB_EXPORT_SCHEMA_VERSION,
      // The export is a completed snapshot at request time, not a live tail.
      consistency: 'complete',
    };
  }
}

function normalizeWebExport(conversations: ClaudeWebExportConversation[]): ProviderRecord[] {
  const output: ProviderRecord[] = [];
  const seenConversationIds = new Set<string>();
  for (const conversation of conversations) {
    if (seenConversationIds.has(conversation.uuid)) {
      throw new SessionContractError(
        'DUPLICATE_NATIVE_ID',
        `Claude web export declares the same conversation uuid twice: ${conversation.uuid}`,
      );
    }
    seenConversationIds.add(conversation.uuid);
    const seenMessageIds = new Set<string>();
    for (const [index, message] of conversation.chat_messages.entries()) {
      if (seenMessageIds.has(message.uuid)) {
        throw new SessionContractError(
          'DUPLICATE_NATIVE_ID',
          `Claude web export conversation ${conversation.uuid} declares the same message uuid twice: ${message.uuid}`,
        );
      }
      seenMessageIds.add(message.uuid);
      output.push(webExportProviderRecord(conversation, message, index));
    }
  }
  return output;
}

function webExportProviderRecord(
  conversation: ClaudeWebExportConversation,
  message: ClaudeWebExportMessage,
  sequence: number,
): ProviderRecord {
  const text = message.text && message.text.length > 0
    ? message.text
    : (message.content ?? []).map((block) => block.text ?? '').filter(Boolean).join('\n');
  const attachments = [...(message.attachments ?? []), ...(message.files ?? [])];
  return {
    nativeSessionId: conversation.uuid,
    nativeEventId: message.uuid,
    sequence,
    kind: 'message',
    role: message.sender,
    participant: message.sender,
    occurredAt: message.created_at,
    text,
    rawReference: { locatorClass: 'claude-web-export-json', sequence },
    extensions: {
      conversationName: conversation.name,
      conversationCreatedAt: conversation.created_at,
      conversationUpdatedAt: conversation.updated_at,
      provenance: { acquisition: 'claude-web-export-json', schema: CLAUDE_WEB_EXPORT_SCHEMA_VERSION },
      // Web/account exports reference attachments/files by metadata only; the
      // export format does not embed original bytes, so this is a coverage
      // note (#2565 acceptance criteria), not a loss AIWG introduced.
      ...(attachments.length > 0 ? {
        attachmentReferences: attachments.map((attachment) => ({
          fileName: attachment.file_name,
          fileType: attachment.file_type,
          fileSize: attachment.file_size,
          extractedContentAvailable: typeof attachment.extracted_content === 'string',
        })),
        metadataLoss: ['attachment bytes unavailable in web/account export format'],
      } : {}),
      unknownFields: unknownFields(
        message as unknown as Record<string, unknown>,
        WEB_EXPORT_MESSAGE_KEYS,
      ),
    },
  };
}

const WEB_EXPORT_MESSAGE_KEYS = new Set([
  'uuid', 'text', 'sender', 'created_at', 'updated_at', 'content', 'attachments', 'files',
]);

function normalizeTranscript(
  records: BoundedJsonRecord[],
  locator: string,
): { records: ProviderRecord[]; complete: false } {
  const filenameSessionId = basename(locator, extname(locator));
  const output: ProviderRecord[] = [];
  for (const record of records) {
    const parsed = ClaudeRecordSchema.safeParse(record.value);
    if (!parsed.success) {
      throw new SessionContractError('MALFORMED_SOURCE', 'Claude transcript record is malformed', schemaRejectionDetail(parsed.error));
    }
    const value = parsed.data;
    const embeddedSessionId = value.sessionId ?? value.session_id;
    const nativeSessionId = embeddedSessionId ?? filenameSessionId;
    const blocks = messageBlocks(value);
    if (blocks.length === 0) {
      output.push(providerRecord(value, record, nativeSessionId, filenameSessionId, {
        kind: `claude.${value.type}`,
        text: '',
        opaque: true,
        unknownFields: unknownFields(value, TRANSCRIPT_KEYS),
      }));
      continue;
    }
    for (const [blockIndex, block] of blocks.entries()) {
      output.push(providerRecord(value, record, nativeSessionId, filenameSessionId, {
        kind: block.kind,
        text: block.text,
        blockIndex,
        blockNativeId: block.nativeId,
        opaque: block.opaque,
        unknownFields: block.unknownFields,
      }));
    }
  }
  return { records: output, complete: false };
}

function normalizeHooks(
  records: BoundedJsonRecord[],
): { records: ProviderRecord[]; complete: boolean } {
  const output: ProviderRecord[] = [];
  let complete = false;
  for (const record of records) {
    const parsed = ClaudeHookSchema.safeParse(record.value);
    if (!parsed.success) {
      throw new SessionContractError('MALFORMED_SOURCE', 'Claude lifecycle hook record is malformed', schemaRejectionDetail(parsed.error));
    }
    const hook = parsed.data;
    complete ||= hook.hook_event_name === 'SessionEnd';
    output.push({
      nativeSessionId: hook.session_id,
      nativeEventId: hookNativeId(hook, record.sequence),
      sequence: record.sequence,
      kind: 'lifecycle-hook',
      role: 'system',
      participant: 'claude',
      model: hook.model,
      occurredAt: hook.timestamp,
      activityBoundary: hook.hook_event_name === 'SessionEnd'
        ? 'end'
        : hook.source === 'resume'
          ? 'resume'
          : hook.source === 'compact'
            ? 'continuation'
            : undefined,
      activityBoundaryBasis: hook.hook_event_name === 'SessionEnd' || hook.source
        ? `claude-hook:${hook.hook_event_name}:${hook.source ?? 'none'}`
        : undefined,
      activityBoundaryConfidence: hook.hook_event_name === 'SessionEnd' || hook.source
        ? 'high'
        : undefined,
      text: '',
      rawReference: { locatorClass: 'claude-hook-jsonl', offset: record.byteOffset },
      extensions: {
        hookEventName: hook.hook_event_name,
        ...(hook.hook_event_name === 'SessionEnd' ? { lifecycle: 'complete' } : {}),
        startSource: hook.source,
        model: hook.model,
        reason: hook.reason,
        permissionMode: hook.permission_mode,
        workspace: { cwdClass: '<workspace>', transcript: redactSourceLocator(hook.transcript_path) },
        provenance: { acquisition: 'claude-hook', schema: CLAUDE_TRANSCRIPT_SCHEMA_VERSION },
        unknownFields: unknownFields(hook, HOOK_KEYS),
      },
    });
  }
  return { records: output, complete };
}

function providerRecord(
  value: ClaudeRecord,
  record: BoundedJsonRecord,
  nativeSessionId: string,
  sourceArtifactSessionId: string,
  block: {
    kind: string;
    text: string;
    blockIndex?: number;
    blockNativeId?: string;
    opaque: boolean;
    unknownFields: Record<string, unknown>;
  },
): ProviderRecord {
  const nativeBase = value.uuid ?? value.message?.id;
  const nativeEventId = block.blockNativeId
    ?? (nativeBase ? `${nativeBase}:${block.blockIndex ?? 0}` : undefined);
  return {
    nativeSessionId,
    nativeEventId,
    sequence: record.sequence * 1_000 + (block.blockIndex ?? 0),
    kind: block.kind,
    role: value.message?.role,
    occurredAt: value.timestamp,
    text: block.text,
    rawReference: { locatorClass: 'claude-transcript-jsonl', offset: record.byteOffset },
    extensions: {
      transcriptType: value.type,
      transcriptSubtype: value.subtype,
      parentUuid: value.parentUuid,
      productVersion: value.version,
      workspace: { cwdClass: value.cwd ? '<workspace>' : undefined, gitBranch: value.gitBranch },
      provenance: { acquisition: 'claude-transcript', schema: CLAUDE_TRANSCRIPT_SCHEMA_VERSION },
      transcriptFamily: {
        sourceArtifactSessionId,
        nativeSessionId,
        identityRelation: nativeSessionId === sourceArtifactSessionId ? 'self' : 'related',
        parentUuid: value.parentUuid,
        parentSessionId: value.parentSessionId,
        gitBranch: value.gitBranch,
        continuation: record.sequence > 0 && value.parentUuid !== null,
        subagent: value.isSidechain === true || Boolean(value.agentId),
        agentId: value.agentId,
        agentSlug: value.slug,
      },
      opaque: block.opaque,
      unknownFields: {
        ...unknownFields(value, TRANSCRIPT_KEYS),
        ...block.unknownFields,
      },
    },
  };
}

function messageBlocks(value: ClaudeRecord): Array<{
  kind: string;
  text: string;
  nativeId?: string;
  opaque: boolean;
  unknownFields: Record<string, unknown>;
}> {
  const content = value.message?.content;
  if (typeof content === 'string') {
    return [{ kind: 'message', text: content, opaque: false, unknownFields: {} }];
  }
  if (!Array.isArray(content)) return [];
  return content.map((input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { kind: 'claude.unknown-block', text: '', opaque: true, unknownFields: { value: input } };
    }
    const block = input as Record<string, unknown>;
    const type = typeof block.type === 'string' ? block.type : 'unknown';
    if (type === 'text' && typeof block.text === 'string') {
      return {
        kind: 'message', text: block.text, opaque: false,
        unknownFields: unknownFields(block, new Set(['type', 'text'])),
      };
    }
    if (type === 'tool_use') {
      return {
        kind: 'tool-call',
        text: typeof block.name === 'string' ? block.name : '',
        nativeId: typeof block.id === 'string' ? block.id : undefined,
        opaque: false,
        unknownFields: unknownFields(block, new Set(['type', 'id', 'name', 'input'])),
      };
    }
    if (type === 'tool_result') {
      return {
        kind: 'tool-result',
        text: extractToolResultText(block.content),
        nativeId: typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
        opaque: false,
        unknownFields: unknownFields(block, new Set(['type', 'tool_use_id', 'content', 'is_error'])),
      };
    }
    return {
      kind: `claude.${type}`,
      text: '',
      opaque: true,
      unknownFields: { ...block },
    };
  });
}

function extractToolResultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .filter((item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => typeof item.text === 'string' ? item.text : '')
    .filter(Boolean)
    .join('\n');
}

function parseRecordCursor(value?: string): number {
  if (value === undefined || value === '') return 0;
  if (!/^\d+$/.test(value)) throw new SessionContractError('SCHEMA_DRIFT', 'Claude record cursor is invalid', schemaIssueDetail('cursor'));
  return Number(value);
}

function hookNativeId(hook: ClaudeHook, sequence: number): string {
  return sha256([
    hook.session_id, hook.hook_event_name, hook.source ?? '',
    hook.timestamp ?? '', hook.reason ?? '', sequence,
  ].join('\0'));
}

function isHookLocator(locator: string): boolean {
  return /\.hooks?\.jsonl$/i.test(locator);
}

function isHookRecord(value: unknown): boolean {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).hook_event_name === 'string';
}

function unknownFields(
  value: Record<string, unknown>,
  known: ReadonlySet<string>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !known.has(key)));
}

const TRANSCRIPT_KEYS = new Set([
  'type', 'subtype', 'uuid', 'parentUuid', 'sessionId', 'session_id',
  'timestamp', 'cwd', 'gitBranch', 'parentSessionId', 'isSidechain',
  'agentId', 'slug', 'version', 'schemaVersion', 'message',
]);
const HOOK_KEYS = new Set([
  'session_id', 'transcript_path', 'cwd', 'hook_event_name', 'permission_mode',
  'source', 'model', 'reason', 'schemaVersion', 'timestamp',
]);
