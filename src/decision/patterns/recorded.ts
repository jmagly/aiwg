import { decisionBatchQuestionId } from '../batch.js';
import type { JsonValue } from '../types.js';
import { OFFLINE_RECORDED_CREDENTIAL_REF, OFFLINE_RECORDED_MODEL } from './artifacts.js';

export interface RecordedTransportCall {
  /** Aliases answered by this request, in request order. */
  aliases: string[];
  model: string;
}

/**
 * Offline Jev transport that replays sanitized recorded answers. It is the only
 * transport the offline playground uses: the production Jev adapter still builds
 * the request and validates and normalizes every recorded answer.
 */
export class RecordedJevTransport {
  readonly calls: RecordedTransportCall[] = [];
  private readonly answers: Record<string, JsonValue>;
  private readonly usage: JsonValue | undefined;

  constructor(recordedEvidence: Record<string, JsonValue>, private readonly aliases: readonly string[]) {
    const answers = recordedEvidence.answers;
    this.answers = answers && typeof answers === 'object' && !Array.isArray(answers) ? structuredClone(answers) : {};
    this.usage = recordedEvidence.usage === undefined ? undefined : structuredClone(recordedEvidence.usage);
  }

  readonly fetch = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string; questions?: Record<string, unknown> };
    const byQuestionId = new Map(this.aliases.flatMap(alias => [[alias, alias], [decisionBatchQuestionId(alias), alias]] as const));
    const answers: Record<string, JsonValue> = {};
    const aliases: string[] = [];
    for (const questionId of Object.keys(body.questions ?? {})) {
      const alias = byQuestionId.get(questionId);
      aliases.push(alias ?? questionId);
      if (alias !== undefined && Object.prototype.hasOwnProperty.call(this.answers, alias)) answers[questionId] = structuredClone(this.answers[alias]!);
    }
    this.calls.push({ aliases, model: body.model ?? '' });
    // Unrecorded usage is reported as an empty usage object, which the adapter normalizes to null counts.
    return new Response(JSON.stringify({ answers, model: OFFLINE_RECORDED_MODEL, usage: this.usage ?? {} }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

/** Resolves only the offline logical reference, to a fixed non-secret marker. */
export async function resolveOfflineRecordedCredential(logicalRef: string): Promise<Uint8Array> {
  if (logicalRef !== OFFLINE_RECORDED_CREDENTIAL_REF) throw new Error('Offline playground resolves only its recorded-fixture reference');
  return new TextEncoder().encode('offline-recorded-fixture');
}
