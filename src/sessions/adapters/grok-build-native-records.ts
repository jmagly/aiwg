// Project only the observed 1.0.77 chat records; never acquire snapshots or attachments.
import { z } from 'zod';
import { SessionContractError, type ProviderRecord } from '../contracts.js';
import type { BoundedJsonRecord } from '../readers.js';
const text = z.strictObject({ type: z.literal('text'), text: z.string() });
const tool = z.strictObject({ id: z.string().min(1), name: z.string().min(1), arguments: z.string() });
const recordSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('user'), content: z.array(text), prompt_index: z.number().int().nonnegative().optional(), synthetic_reason: z.enum(['system_reminder', 'compaction_meta']).optional() }),
  z.strictObject({ type: z.literal('assistant'), content: z.string(), tool_calls: z.array(tool).max(999).optional(), model_id: z.string().optional(), model_fingerprint: z.string().optional(), reasoning_effort: z.string().optional() }),
  z.strictObject({ type: z.literal('tool_result'), tool_call_id: z.string(), content: z.string() }),
  z.strictObject({ type: z.literal('system'), content: z.string() }),
  z.strictObject({ type: z.literal('reasoning'), id: z.string(), summary: z.array(z.unknown()), encrypted_content: z.string(), status: z.literal('completed') }),
]);
const summarySchema = z.looseObject({
  chat_format_version: z.literal(1),
  info: z.strictObject({ id: z.string().uuid(), cwd: z.string().min(1) }),
  created_at: z.string(), updated_at: z.string(), current_model_id: z.string(),
  session_kind: z.enum(['headless', 'interactive', 'subagent']).optional(),
  parent_session_id: z.string().uuid().optional(), forked_at: z.string().optional(),
});
export interface NativeProjection {
  kind: 'message' | 'tool-call' | 'tool-result' | 'compaction';
  role?: 'user' | 'assistant' | 'tool';
  content: string;
  model?: string;
  toolName?: string;
  toolCallId?: string;
  sequence: number;
  cwd: string;
  sessionCreatedAt: string;
  sessionUpdatedAt: string;
  currentModelId: string;
  sessionKind?: string;
  lineage?: NativeLineage;
  compaction?: { tokensBefore: number; tokensAfter: number };
  acquisition?: string;
  occurredAt?: string;
}
export interface NativeLineage {
  parentSessionId?: string;
  forkedAt?: string;
  subagents?: Array<{ subagentId: string; parentSessionId?: string; childSessionId?: string; status?: string; output?: string }>;
}
export type NativeMetadata = Pick<NativeProjection, 'sessionCreatedAt' | 'sessionUpdatedAt' | 'currentModelId' | 'sessionKind' | 'lineage'>;
export function nativeDrift(): never {
  throw new SessionContractError('SCHEMA_DRIFT', 'Unrecognized Grok Build 1.0.77 native schema; fall back to `grok export <session-id> <session-id>.md`.');
}
export function parseNativeSummary(value: unknown, sessionId: string, cwd: string) {
  const parsed = summarySchema.safeParse(value);
  if (!parsed.success || parsed.data.info.id.toLowerCase() !== sessionId || parsed.data.info.cwd !== cwd) nativeDrift();
  for (const time of [parsed.data.created_at, parsed.data.updated_at]) if (!Number.isFinite(Date.parse(time))) nativeDrift();
  const data = parsed.data;
  if (data.forked_at !== undefined && (!data.parent_session_id || !Number.isFinite(Date.parse(data.forked_at)))) nativeDrift();
  if (data.parent_session_id?.toLowerCase() === sessionId) nativeDrift();
  const lineage = data.parent_session_id ? { parentSessionId: data.parent_session_id.toLowerCase(), ...(data.forked_at ? { forkedAt: data.forked_at } : {}) } : undefined;
  return { sessionCreatedAt: data.created_at, sessionUpdatedAt: data.updated_at, currentModelId: data.current_model_id, ...(data.session_kind ? { sessionKind: data.session_kind } : {}), ...(lineage ? { lineage } : {}) };
}
export function projectNativeLine(line: BoundedJsonRecord, cwd: string, metadata: NativeMetadata): Array<{ record: NativeProjection; line: BoundedJsonRecord }> {
  const parsed = recordSchema.safeParse(line.value);
  if (!parsed.success) nativeDrift();
  const value = parsed.data;
  const records: NativeProjection[] = [];
  const base = { cwd, ...metadata, sequence: line.sequence * 1_000 };
  if (value.type === 'user' && !value.synthetic_reason) records.push({ ...base, kind: 'message', role: 'user', content: value.content.map(c => c.text).join('\n') });
  if (value.type === 'assistant') {
    if (value.content) records.push({ ...base, kind: 'message', role: 'assistant', content: value.content, model: value.model_id });
    for (const [index, call] of (value.tool_calls ?? []).entries()) records.push({ ...base, sequence: base.sequence + index + 1, kind: 'tool-call', role: 'tool', content: call.arguments, toolName: call.name, toolCallId: call.id, model: value.model_id });
  }
  if (value.type === 'tool_result') records.push({ ...base, kind: 'tool-result', role: 'tool', content: value.content, toolCallId: value.tool_call_id });
  return records.map(record => ({ record, line }));
}
export function nativeProjectionRecord(sessionId: string, entry: { record: NativeProjection; line: BoundedJsonRecord }): ProviderRecord {
  const { record, line } = entry;
  return {
    nativeSessionId: sessionId, nativeEventId: `${sessionId}:${record.acquisition === 'grok-build-native-updates' ? 'updates:' : ''}${record.sequence}`, sequence: record.sequence,
    kind: record.kind, role: record.role, occurredAt: record.occurredAt, text: record.content, model: record.model,
    toolName: record.toolName, toolCallId: record.toolCallId,
    rawReference: { locatorClass: record.acquisition ?? 'grok-build-native-chat-history', sequence: line.sequence },
    extensions: {
      lifecycle: 'unknown-at-import',
      provenance: { product: 'grok-build', acquisition: record.acquisition ?? 'grok-build-native-chat-history', sourceSchema: '1.0.0', nativeStoreInspected: true, toolOutputAvailable: true, grokVersion: '1.0.77', workingDirectory: record.cwd, sessionCreatedAt: record.sessionCreatedAt, sessionUpdatedAt: record.sessionUpdatedAt, sessionCreatedAtMs: Date.parse(record.sessionCreatedAt), sessionUpdatedAtMs: Date.parse(record.sessionUpdatedAt), currentModelId: record.currentModelId, ...(record.sessionKind ? { sessionKind: record.sessionKind } : {}) },
      ...(record.lineage ? { lineage: record.lineage } : {}),
      ...(record.compaction ? { compaction: record.compaction } : {}),
      identity: { nativeSessionIdKnown: true, nativeEventIdKnown: false, eventIdentityBasis: 'source-position' },
      lossReport: { lossless: false, excludedRecordTypes: ['system', 'system_reminder', 'reasoning', ...(record.acquisition ? ['compaction_meta'] : [])], unavailable: [...(record.occurredAt ? [] : ['eventTimestamps']), 'attachments', 'fileSnapshots'] },
    },
  };
}

const updateEnvelope = z.looseObject({
  timestamp: z.number().finite(),
  method: z.enum(['session/update', '_x.ai/session/update']),
  params: z.looseObject({
    sessionId: z.string().uuid(),
    update: z.looseObject({ sessionUpdate: z.string() }),
    _meta: z.looseObject({ agentTimestampMs: z.number().finite().nonnegative().max(8_640_000_000_000_000).optional() }).optional(),
  }),
});
const messageUpdate = z.looseObject({
  content: text,
  _meta: z.looseObject({ modelId: z.string().optional(), promptIndex: z.number().int().nonnegative().optional(), hostTurn: z.boolean().optional() }).optional(),
});
const compactUpdate = z.strictObject({
  sessionUpdate: z.literal('auto_compact_completed'),
  tokens_before: z.number().int().nonnegative(), tokens_after: z.number().int().nonnegative(),
  summary_preview: z.string().nullable(),
});
const omittedUpdates = new Set(['agent_thought_chunk', 'turn_completed', 'hook_execution', 'background_tasks',
  'compaction_checkpoint', 'subagent_spawned', 'subagent_finished', 'workflow_updated']);

/** Text-only update logs retain original turns when compaction rewrites chat history. */
export function projectNativeUpdate(line: BoundedJsonRecord, sessionId: string, cwd: string, metadata: NativeMetadata) {
  const parsed = updateEnvelope.safeParse(line.value);
  if (!parsed.success || parsed.data.params.sessionId.toLowerCase() !== sessionId) nativeDrift();
  const { update, _meta } = parsed.data.params;
  const type = update.sessionUpdate;
  const base = { ...metadata, cwd, sequence: line.sequence * 1_000, acquisition: 'grok-build-native-updates',
    ...(_meta?.agentTimestampMs !== undefined ? { occurredAt: new Date(_meta.agentTimestampMs).toISOString() } : {}) };
  if (type === 'user_message_chunk' || type === 'agent_message_chunk') {
    const message = messageUpdate.safeParse(update);
    if (!message.success) nativeDrift();
    return { record: { ...base, kind: 'message' as const, role: type === 'user_message_chunk' ? 'user' as const : 'assistant' as const,
      content: message.data.content.text, ...(message.data._meta?.modelId ? { model: message.data._meta.modelId } : {}) }, line };
  }
  if (type === 'auto_compact_completed') {
    const compact = compactUpdate.safeParse(update);
    if (!compact.success) nativeDrift();
    return { record: { ...base, kind: 'compaction' as const, content: '',
      compaction: { tokensBefore: compact.data.tokens_before, tokensAfter: compact.data.tokens_after } }, line };
  }
  if (!omittedUpdates.has(type) && type !== 'tool_call' && type !== 'tool_call_update') nativeDrift();
  return null;
}
