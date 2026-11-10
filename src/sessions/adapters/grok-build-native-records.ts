// Project only the observed 1.0.77 chat records; never acquire snapshots or attachments.
import { z } from 'zod';
import { SessionContractError, type ProviderRecord } from '../contracts.js';
import type { BoundedJsonRecord } from '../readers.js';
const text = z.strictObject({ type: z.literal('text'), text: z.string() });
const tool = z.strictObject({ id: z.string().min(1), name: z.string().min(1), arguments: z.string() });
const recordSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('user'), content: z.array(text), prompt_index: z.number().int().nonnegative().optional(), synthetic_reason: z.literal('system_reminder').optional() }),
  z.strictObject({ type: z.literal('assistant'), content: z.string(), tool_calls: z.array(tool).max(999).optional(), model_id: z.string().optional(), model_fingerprint: z.string().optional(), reasoning_effort: z.string().optional() }),
  z.strictObject({ type: z.literal('tool_result'), tool_call_id: z.string(), content: z.string() }),
  z.strictObject({ type: z.literal('system'), content: z.string() }),
  z.strictObject({ type: z.literal('reasoning'), id: z.string(), summary: z.array(z.unknown()), encrypted_content: z.string(), status: z.literal('completed') }),
]);
const summarySchema = z.looseObject({
  chat_format_version: z.literal(1),
  info: z.strictObject({ id: z.string().uuid(), cwd: z.string().min(1) }),
  created_at: z.string(), updated_at: z.string(), current_model_id: z.string(),
});
export interface NativeProjection {
  kind: 'message' | 'tool-call' | 'tool-result';
  role: 'user' | 'assistant' | 'tool';
  content: string;
  model?: string;
  toolName?: string;
  toolCallId?: string;
  sequence: number;
  cwd: string;
  sessionCreatedAt: string;
  sessionUpdatedAt: string;
  currentModelId: string;
}
export function nativeDrift(): never {
  throw new SessionContractError('SCHEMA_DRIFT', 'Unrecognized Grok Build 1.0.77 native schema; fall back to `grok export <session-id> <session-id>.md`.');
}
export function parseNativeSummary(value: unknown, sessionId: string, cwd: string) {
  const parsed = summarySchema.safeParse(value);
  if (!parsed.success || parsed.data.info.id.toLowerCase() !== sessionId || parsed.data.info.cwd !== cwd) nativeDrift();
  for (const time of [parsed.data.created_at, parsed.data.updated_at]) if (!Number.isFinite(Date.parse(time))) nativeDrift();
  return { sessionCreatedAt: parsed.data.created_at, sessionUpdatedAt: parsed.data.updated_at, currentModelId: parsed.data.current_model_id };
}
export function projectNativeLine(line: BoundedJsonRecord, cwd: string, metadata: Pick<NativeProjection, 'sessionCreatedAt' | 'sessionUpdatedAt' | 'currentModelId'>): Array<{ record: NativeProjection; line: BoundedJsonRecord }> {
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
    nativeSessionId: sessionId, nativeEventId: `${sessionId}:${record.sequence}`, sequence: record.sequence,
    kind: record.kind, role: record.role, occurredAt: undefined, text: record.content, model: record.model,
    toolName: record.toolName, toolCallId: record.toolCallId,
    rawReference: { locatorClass: 'grok-build-native-chat-history', sequence: line.sequence },
    extensions: {
      lifecycle: 'unknown-at-import',
      provenance: { product: 'grok-build', acquisition: 'grok-build-native-chat-history', sourceSchema: '1.0.0', nativeStoreInspected: true, toolOutputAvailable: true, grokVersion: '1.0.77', workingDirectory: record.cwd, sessionCreatedAt: record.sessionCreatedAt, sessionUpdatedAt: record.sessionUpdatedAt, sessionCreatedAtMs: Date.parse(record.sessionCreatedAt), sessionUpdatedAtMs: Date.parse(record.sessionUpdatedAt), currentModelId: record.currentModelId },
      identity: { nativeSessionIdKnown: true, nativeEventIdKnown: false, eventIdentityBasis: 'source-position' },
      lossReport: { lossless: false, excludedRecordTypes: ['system', 'system_reminder', 'reasoning'], unavailable: ['eventTimestamps', 'attachments', 'fileSnapshots', 'compaction', 'lineage', 'subagents'] },
    },
  };
}
