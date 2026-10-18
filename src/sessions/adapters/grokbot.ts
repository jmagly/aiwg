/**
 * Grok Bot session adapter — manual-export interchange plus an evidence-gated
 * native locator for the Grok Bot desktop app's local transcript cache.
 *
 * Native discovery (#2970) is Linux-only and requires an explicitly
 * authorized `sand-client-persistence` root (`--grokbot-root`); there is no
 * default path and nothing is guessed for macOS/Windows, where the layout is
 * unverified. The store is one JSON document per key, named `<base32
 * key>.blob` (RFC 4648 section 6, lowercase, unpadded). Discovery decodes
 * ONLY filenames to classify them; it never opens a file whose decoded key
 * is outside the allowlist below, and it never recurses or follows symlinks.
 *
 * Allowlisted keys (see grokbot-locator.ts):
 *   - `...transcript.replicas.<conversation-uuid>` — one conversation; the
 *     only key class ever selected as an importable source.
 *   - `...roster.last-roster` — account conversation index; never opened by
 *     this adapter (no session content), kept out of discover() results.
 * Every other key (composer-drafts, send-journal, experiments, ui-layout,
 * sand-secrets, box-secrets, cookies, local/session storage, etc.) is never
 * decoded content, never opened, and `~/.grokbot` (daemon credentials) is
 * never referenced.
 *
 * Grok Bot conversations carry no workspace/cwd field — there is no native
 * evidence linking a conversation to a project directory. Following the
 * established precedent for other account-scoped, non-workspace-scoped
 * native locators (`pi`, `deepseek-harness`: no per-source workspace
 * filtering in workspace-discovery.ts), every authorized conversation under
 * `--grokbot-root` surfaces to whichever workspace runs discovery; this
 * adapter never guesses a workspace link and `inspect()` never sets
 * `declaredWorkspaceId` for native sources.
 *
 * The replica is a bounded client-side cache (~200 entries) that can evict
 * its oldest entries as new ones arrive, so a re-read is not append-only —
 * the file may shrink, and Grok Bot may rewrite it via a rename-swap that
 * changes its inode. This adapter declares `sourceContinuity: 'snapshot'`
 * (contracts.ts), which tells the shared importer to skip its generic
 * size-shrink / file-identity / prefix-rewrite checks (those assume
 * append-only growth) for this source. Idempotent, non-duplicating re-import
 * across the sliding window then relies on two things instead: (1)
 * `workspace-discovery.ts` assigns a conversation-id–derived,
 * content-independent `sourceId` for native sources (mirroring the existing
 * OMP convention), so the importer's checkpoint continuity survives content
 * changes; (2) `stream()` resumes from the native, monotonic `seq` carried
 * by each entry (not a position/byte offset, which the sliding window would
 * invalidate) and tags every record's `sourceCursor` as `native:<seq>` — an
 * opaque provider-native resume token the importer stores verbatim
 * (`positionKind: 'provider-native'`), never reinterpreted as a byte offset.
 * Combined with the catalog's identity-keyed `INSERT OR IGNORE`, re-importing
 * after the window has slid can only add genuinely new entries, never
 * duplicate ones.
 *
 * @see docs/providers/grokbot-sessions.md
 * @issue #215, #2970
 */

import { opendir } from 'node:fs/promises';
import { resolve } from 'node:path';
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
import {
  GenericSessionInterchangeAdapter,
} from './generic.js';
import {
  classifyGrokbotBlobName,
  grokbotConversationIdFromLocator,
} from './grokbot-locator.js';

export const GROKBOT_ADAPTER_VERSION = '1.0.0';
export const GROKBOT_EXPORT_SCHEMA_VERSION = '1.0.0';
export const GROKBOT_NATIVE_SCHEMA_VERSION = '1.0.0';
export const GROKBOT_NATIVE_SCHEMA_MAJOR = 1;
export const GROKBOT_LOCATOR_CLASS = 'manual-export' as const;
export const GROKBOT_NATIVE_REPLICA_LOCATOR_CLASS = 'grokbot-native-transcript-replica' as const;

const GrokbotEntryBaseSchema = z.object({
  kind: z.string().min(1),
  id: z.string().min(1),
  timestampMs: z.number().int().nonnegative(),
  requestId: z.string().optional(),
  seq: z.number().int().nonnegative(),
}).passthrough();

const SendMessageEntrySchema = GrokbotEntryBaseSchema.extend({
  kind: z.literal('send-message'),
  respondedValue: z.unknown().optional(),
  secretProvided: z.boolean().optional(),
  message: z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), content: z.string() }).passthrough(),
    z.object({
      type: z.literal('widget'),
      widget: z.object({ prompt: z.string() }).passthrough(),
    }).passthrough(),
    z.object({
      type: z.literal('email-draft'),
      draft: z.object({ subject: z.string().optional(), body: z.string() }).passthrough(),
    }).passthrough(),
    z.object({
      type: z.literal('slack-draft'),
      draft: z.object({ target: z.string().optional(), body: z.string() }).passthrough(),
    }).passthrough(),
    z.object({
      type: z.literal('attachment'),
      url: z.string(),
      file_name: z.string(),
    }).passthrough(),
    z.object({
      type: z.literal('user-form'),
      formRequest: z.object({ title: z.string() }).passthrough(),
    }).passthrough(),
    z.object({
      type: z.literal('secret-request'),
      secretRequest: z.object({ label: z.string() }).passthrough(),
    }).passthrough(),
  ]),
});

const MessageEntrySchema = GrokbotEntryBaseSchema.extend({
  kind: z.literal('message'),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  fromAgent: z.object({ id: z.string().optional(), name: z.string().optional() })
    .passthrough().optional(),
});

const UserAttachmentEntrySchema = GrokbotEntryBaseSchema.extend({
  kind: z.literal('user-attachment'),
  file_name: z.string(),
  file_path: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  byteSize: z.number().optional(),
});

const EventEntrySchema = GrokbotEntryBaseSchema.extend({
  kind: z.literal('event'),
  event: z.record(z.string(), z.unknown()),
});

const NoticeEntrySchema = GrokbotEntryBaseSchema.extend({
  kind: z.literal('notice'),
  text: z.string(),
});

const GrokbotReplicaValueSchema = z.object({
  entries: z.array(GrokbotEntryBaseSchema),
  epochHint: z.string().nullish(),
  acceptedSequenceHint: z.number().int().nonnegative().nullish(),
  persistedAt: z.number().int().nonnegative().nullish(),
  precedingTimestampMs: z.number().int().nonnegative().nullish(),
}).passthrough();

const GrokbotReplicaDocumentSchema = z.object({
  schemaVersion: z.number().int().nonnegative(),
  value: GrokbotReplicaValueSchema,
}).passthrough();

type GrokbotRawEntry = z.infer<typeof GrokbotEntryBaseSchema>;

interface GrokbotReplica {
  entries: GrokbotRawEntry[];
  truncated: boolean;
}

interface MappedGrokbotRecord {
  nativeEventId: string;
  sequence: number;
  kind: string;
  role: string;
  participant?: string;
  text: string;
  occurredAt: string;
  extensions: Record<string, unknown>;
}

export class GrokbotSessionAdapter implements SessionSourceAdapter {
  readonly provider = 'grokbot' as const;
  readonly adapterVersion = GROKBOT_ADAPTER_VERSION;
  readonly disposition = 'implemented' as const;
  readonly supportedOperations = ['discover', 'inspect', 'stream'] as const;
  readonly acquisitionModes = ['manual-export', 'jsonl'] as const;
  /**
   * The replica is rewritten wholesale (sliding window, possible
   * rename-swap), not appended to. See the class-level doc comment.
   */
  readonly sourceContinuity = 'snapshot' as const;

  private readonly interchange: GenericSessionInterchangeAdapter;

  constructor(private readonly limits?: Partial<ReaderLimits>, private readonly maxFiles = 10_000) {
    this.interchange = new GenericSessionInterchangeAdapter(limits);
  }

  async *discover(scope: AuthorizedScope): AsyncIterable<SourceDescriptor> {
    if (scope.allowedRoots.length === 0) {
      throw new SessionContractError(
        'SOURCE_NOT_AUTHORIZED',
        'Grok Bot native discovery requires an explicitly authorized sand-client-persistence root; '
          + 'pass --grokbot-root. There is no default root and nothing is guessed for macOS or Windows.',
      );
    }
    let count = 0;
    for (const root of [...scope.allowedRoots].sort()) {
      let directory;
      try {
        directory = await opendir(resolve(root));
      } catch {
        continue;
      }
      for await (const dirent of directory) {
        // Never recurse, never follow symlinks: only plain files directly
        // under the authorized root are even filename-classified.
        if (!dirent.isFile()) continue;
        const classification = classifyGrokbotBlobName(dirent.name);
        if (classification?.kind !== 'transcript-replica') continue;
        if (++count > this.maxFiles) {
          throw new SessionContractError(
            'RESOURCE_LIMIT_EXCEEDED',
            'Grok Bot native discovery exceeded the authorized file limit',
          );
        }
        yield {
          provider: 'grokbot',
          locator: resolve(root, dirent.name),
          locatorClass: GROKBOT_NATIVE_REPLICA_LOCATOR_CLASS,
        };
      }
    }
  }

  async inspect(source: SelectedSource): Promise<SourceProbe> {
    if (source.locatorClass === GROKBOT_LOCATOR_CLASS) {
      return this.interchange.inspect(source);
    }
    this.assertNativeReplica(source);
    const native = await this.readReplica(source);
    return {
      sourceSchemaVersion: GROKBOT_NATIVE_SCHEMA_VERSION,
      consistency: native.truncated ? 'provisional' : 'complete',
      operationalState: 'available',
      // No native evidence links a conversation to a workspace/cwd; never
      // fabricate one.
    };
  }

  async *stream(source: SelectedSource, cursor?: ImportCursor): AsyncIterable<ProviderRecord> {
    if (source.locatorClass === GROKBOT_LOCATOR_CLASS) {
      yield* this.interchange.stream(source, cursor);
      return;
    }
    this.assertNativeReplica(source);
    const native = await this.readReplica(source);
    const conversationId = grokbotConversationIdFromLocator(source.locator);
    if (!conversationId) {
      throw new SessionContractError(
        'SOURCE_NOT_AUTHORIZED',
        'Grok Bot native locator does not decode to an authorized transcript-replica key',
      );
    }
    const lastSeq = parseNativeCursor(cursor?.value);
    const seen = new Set<number>();
    for (const entry of native.entries) {
      if (seen.has(entry.seq)) {
        throw new SessionContractError(
          'DUPLICATE_NATIVE_ID',
          'Grok Bot transcript replica contains a duplicate entry sequence',
        );
      }
      seen.add(entry.seq);
      if (entry.seq <= lastSeq) continue;
      const mapped = mapGrokbotEntry(entry);
      if (!mapped) continue; // Unrecognized entry kind: skipped, never fabricated.
      yield {
        nativeSessionId: conversationId,
        nativeEventId: mapped.nativeEventId,
        sequence: mapped.sequence,
        kind: mapped.kind,
        role: mapped.role,
        participant: mapped.participant,
        text: mapped.text,
        occurredAt: mapped.occurredAt,
        // Opaque provider-native resume token: the importer stores this
        // verbatim (positionKind: 'provider-native') and never reinterprets
        // it as a byte offset. It encodes the last imported native `seq`,
        // which is monotonic and stable across the bounded cache evicting
        // old entries. See the class-level doc comment for the full
        // rationale.
        sourceCursor: `native:${entry.seq}`,
        rawReference: { locatorClass: GROKBOT_NATIVE_REPLICA_LOCATOR_CLASS, sequence: entry.seq },
        extensions: mapped.extensions,
      };
    }
  }

  private assertNativeReplica(source: SelectedSource): void {
    if (source.locatorClass !== GROKBOT_NATIVE_REPLICA_LOCATOR_CLASS) {
      throw new SessionContractError(
        'UNSUPPORTED_OPERATION',
        `Grok Bot supports only locatorClass "${GROKBOT_LOCATOR_CLASS}" or `
          + `"${GROKBOT_NATIVE_REPLICA_LOCATOR_CLASS}" (got "${source.locatorClass}"). `
          + 'Do not reuse Cursor or other provider locators.',
      );
    }
    // Enforce the filename allowlist before any read, not only in discover():
    // a caller can hand inspect()/stream() any path with the native class.
    if (!grokbotConversationIdFromLocator(source.locator)) {
      throw new SessionContractError(
        'SOURCE_NOT_AUTHORIZED',
        'Grok Bot native locator does not decode to an authorized transcript-replica key',
      );
    }
  }

  private async readReplica(source: SelectedSource): Promise<GrokbotReplica> {
    const { value } = await readBoundedJson({
      selectedPath: source.locator,
      allowedRoots: source.authorizedScope.allowedRoots,
    }, this.limits);
    const parsed = GrokbotReplicaDocumentSchema.safeParse(value);
    if (!parsed.success) {
      throw malformedGrokbotSource('transcript replica', parsed.error);
    }
    assertSupportedSchemaMajor(`${parsed.data.schemaVersion}.0.0`, GROKBOT_NATIVE_SCHEMA_MAJOR);
    const { entries, precedingTimestampMs } = parsed.data.value;
    // The resume cursor is the last yielded seq, so stream in seq order even
    // if the cache stores entries out of order.
    entries.sort((left, right) => left.seq - right.seq);
    // A window that no longer starts at seq 1 has evicted history, whether or
    // not the optional precedingTimestampMs hint is present.
    const truncated = entries.length > 0
      && (entries[0].seq > 1 || (precedingTimestampMs ?? 0) > 0);
    return { entries, truncated };
  }
}

function parseNativeCursor(value?: string): number {
  if (!value) return 0;
  const raw = value.startsWith('native:') ? value.slice('native:'.length) : value;
  if (!/^\d+$/.test(raw)) throw new SessionContractError('SCHEMA_DRIFT', 'invalid Grok Bot native cursor');
  return Number(raw);
}

function mapGrokbotEntry(entry: GrokbotRawEntry): MappedGrokbotRecord | null {
  const occurredAt = new Date(entry.timestampMs).toISOString();
  switch (entry.kind) {
    case 'send-message':
      return mapSendMessage(entry, occurredAt);
    case 'message':
      return mapMessage(entry, occurredAt);
    case 'user-attachment':
      return mapUserAttachment(entry, occurredAt);
    case 'event':
      return mapEvent(entry, occurredAt);
    case 'notice':
      return mapNotice(entry, occurredAt);
    default:
      // Unrecognized entry kind: safely skipped, never fabricated into a record.
      return null;
  }
}

function malformedGrokbotSource(subject: string, error: z.ZodError): SessionContractError {
  // Include only schema paths and codes, never Zod messages or input values.
  const issues = error.issues.map((issue) => `${issue.path.join('.') || '<root>'} (${issue.code})`);
  return new SessionContractError('MALFORMED_SOURCE', `Grok Bot ${subject} is malformed at ${issues.join(', ')}`);
}

function mapSendMessage(raw: GrokbotRawEntry, occurredAt: string): MappedGrokbotRecord | null {
  const messageType = z.object({ type: z.string().min(1) }).safeParse(raw.message);
  if (messageType.success && !SendMessageEntrySchema.shape.message.options.some(
    (option) => option.shape.type.value === messageType.data.type,
  )) {
    // Like unknown entry kinds, unknown message types are skipped without inventing content.
    // Known types still go through their full schema validation below.
    return null;
  }
  const parsed = SendMessageEntrySchema.safeParse(raw);
  if (!parsed.success) {
    throw malformedGrokbotSource('send-message entry', parsed.error);
  }
  const entry = parsed.data;
  const { message } = entry;
  let text: string;
  switch (message.type) {
    case 'text':
      text = message.content;
      break;
    case 'widget':
      text = `[widget] ${message.widget.prompt} -> ${stringOrEmpty(entry.respondedValue)}`;
      break;
    case 'email-draft':
      text = `[email-draft] ${message.draft.subject ?? ''}\n${message.draft.body}`;
      break;
    case 'slack-draft':
      text = `[slack-draft] ${message.draft.target ?? ''}\n${message.draft.body}`;
      break;
    case 'attachment':
      text = `[attachment] ${message.file_name} (${message.url})`;
      break;
    case 'user-form':
      text = `[user-form] ${message.formRequest.title}`;
      break;
    case 'secret-request':
      text = `[secret-request] ${message.secretRequest.label} (value not exported)`;
      break;
    default:
      text = '';
  }
  return {
    nativeEventId: entry.id,
    sequence: entry.seq,
    kind: `grokbot.send-message.${message.type}`,
    role: 'assistant',
    text,
    occurredAt,
    extensions: {
      nativeKind: 'send-message',
      messageType: message.type,
      secretProvided: entry.secretProvided,
      provenance: { acquisition: GROKBOT_NATIVE_REPLICA_LOCATOR_CLASS },
    },
  };
}

function mapMessage(raw: GrokbotRawEntry, occurredAt: string): MappedGrokbotRecord {
  const parsed = MessageEntrySchema.safeParse(raw);
  if (!parsed.success) {
    throw malformedGrokbotSource('message entry', parsed.error);
  }
  const entry = parsed.data;
  return {
    nativeEventId: entry.id,
    sequence: entry.seq,
    kind: 'grokbot.message',
    role: entry.role,
    participant: entry.fromAgent?.name ?? entry.fromAgent?.id,
    text: entry.content,
    occurredAt,
    extensions: {
      nativeKind: 'message',
      fromAgent: entry.fromAgent,
      provenance: { acquisition: GROKBOT_NATIVE_REPLICA_LOCATOR_CLASS },
    },
  };
}

function mapUserAttachment(raw: GrokbotRawEntry, occurredAt: string): MappedGrokbotRecord {
  const parsed = UserAttachmentEntrySchema.safeParse(raw);
  if (!parsed.success) {
    throw malformedGrokbotSource('user-attachment entry', parsed.error);
  }
  const entry = parsed.data;
  return {
    nativeEventId: entry.id,
    sequence: entry.seq,
    kind: 'grokbot.user-attachment',
    role: 'user',
    text: `[user-attachment] ${entry.file_name} `
      + `(${entry.width ?? '?'}x${entry.height ?? '?'}, ${entry.byteSize ?? '?'} bytes)`,
    occurredAt,
    extensions: {
      nativeKind: 'user-attachment',
      fileName: entry.file_name,
      filePath: entry.file_path,
      width: entry.width,
      height: entry.height,
      byteSize: entry.byteSize,
      provenance: { acquisition: GROKBOT_NATIVE_REPLICA_LOCATOR_CLASS },
    },
  };
}

function mapEvent(raw: GrokbotRawEntry, occurredAt: string): MappedGrokbotRecord {
  const parsed = EventEntrySchema.safeParse(raw);
  if (!parsed.success) {
    throw malformedGrokbotSource('event entry', parsed.error);
  }
  const entry = parsed.data;
  const label = stringOrEmpty(entry.event.kind) || stringOrEmpty(entry.event.type) || 'event';
  return {
    nativeEventId: entry.id,
    sequence: entry.seq,
    kind: 'grokbot.event',
    role: 'system',
    text: `[event] ${label}`,
    occurredAt,
    extensions: {
      nativeKind: 'event',
      event: entry.event,
      provenance: { acquisition: GROKBOT_NATIVE_REPLICA_LOCATOR_CLASS },
    },
  };
}

function mapNotice(raw: GrokbotRawEntry, occurredAt: string): MappedGrokbotRecord {
  const parsed = NoticeEntrySchema.safeParse(raw);
  if (!parsed.success) {
    throw malformedGrokbotSource('notice entry', parsed.error);
  }
  const entry = parsed.data;
  return {
    nativeEventId: entry.id,
    sequence: entry.seq,
    kind: 'grokbot.notice',
    role: 'system',
    text: entry.text,
    occurredAt,
    extensions: {
      nativeKind: 'notice',
      provenance: { acquisition: GROKBOT_NATIVE_REPLICA_LOCATOR_CLASS },
    },
  };
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
