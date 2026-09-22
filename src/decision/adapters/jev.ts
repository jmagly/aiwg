import type {
  AdapterCapabilities,
  AdapterObservation,
  DecisionAdapterBatchObservation,
  DecisionAdapterBatchRequest,
  DecisionAdapterRequest,
  DecisionAdapter,
  DecisionFailureReason,
  DecisionUsage,
} from '../types.js';
import { DecisionValidationError, validateDecisionValue, validateDistribution } from '../validate.js';
import { canonicalJson } from '../../security/artifact-trust.js';
import { runInNewContext } from 'node:vm';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

interface JevAdapterOptions {
  endpoint?: string;
  fetch?: typeof fetch;
  /** Explicitly authorized public HTTPS origins. */
  allowedOrigins?: readonly string[];
  /** DNS policy seam; every answer must be public IPv4. */
  resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
  /** Fake pinned transport seam for offline tests. Production uses Node HTTPS. */
  pinnedFetch?: (url: URL, init: RequestInit, pin: PinnedAddress) => Promise<Response>;
  now?: () => number;
}

interface PinnedAddress { address: string; family: 4 }

const MAX_HEADER_BYTES = 32 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_PARSE_MS = 50;

/** Safe resolver taxonomy; messages are intentionally discarded at this boundary. */
export class JevCredentialError extends Error {
  constructor(readonly category: 'missing' | 'denied' | 'configuration' | 'failed') {
    super('Jev credential resolution failed');
    this.name = 'JevCredentialError';
  }
}

class JevTransportResponseError extends Error {}

export class JevDecisionAdapter implements DecisionAdapter {
  readonly id = 'jev';
  readonly version = '1.0.0';
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly allowedOrigins: readonly string[];
  private readonly resolveAddresses: (hostname: string) => Promise<readonly string[]>;
  private readonly pinnedFetch: NonNullable<JevAdapterOptions['pinnedFetch']>;
  private readonly now: () => number;

  constructor(options: JevAdapterOptions = {}) {
    this.endpoint = options.endpoint ?? JEV_ENDPOINT;
    this.fetchImpl = options.fetch ?? fetch;
    this.allowedOrigins = options.allowedOrigins ?? [];
    this.resolveAddresses = options.resolveAddresses ?? systemResolveAddresses;
    this.pinnedFetch = options.pinnedFetch ?? pinnedHttpsFetch;
    this.now = options.now ?? Date.now;
  }

  async capabilities(): Promise<AdapterCapabilities> {
    return {
      answerKinds: ['choice', 'ordinal-score', 'truth-probability'],
      features: ['typed-output', 'probability-distribution', 'structured-entries', 'native-shared-state-batch'],
      maxOptions: 255,
      maxLevels: 10,
      confidenceProfiles: ['typesafe-distribution-v1', 'typesafe-truth-v1'],
      executable: true,
      batch: { native: true, atomic: true, executionEnvelope: new URL(this.endpoint).origin },
    };
  }

  async evaluate(request: DecisionAdapterRequest): Promise<AdapterObservation> {
    if (request.signal.aborted) return externalInterruption(request, 'not-sent');
    if (this.now() >= request.deadlineEpochMs) return failure('timeout', { termination: 'target-timeout', dispatchCertainty: 'not-sent' });
    let pin: PinnedAddress | null;
    try { pin = await withAbort(authorizeEndpoint(this.endpoint, this.allowedOrigins, this.resolveAddresses), request.signal); }
    catch { return request.signal.aborted ? externalInterruption(request, 'not-sent')
      : failure('data-boundary-denied', { dispatchCertainty: 'not-sent' }); }
    if (request.signal.aborted) return externalInterruption(request, 'not-sent');
    let token: string;
    try {
      if (!request.target.credentialRef) return failure('unauthorized', { dispatchCertainty: 'not-sent' });
      const credential = new Uint8Array(await withAbort(request.resolveCredential(request.target.credentialRef), request.signal));
      try { token = new TextDecoder('utf-8', { fatal: true }).decode(credential); }
      finally { credential.fill(0); }
      if (!token || /[\r\n\u0000-\u001f\u007f]/.test(token)) return failure('authentication', { dispatchCertainty: 'not-sent' });
    } catch (error) {
      if (request.signal.aborted) return externalInterruption(request, 'not-sent');
      const category = error instanceof JevCredentialError ? error.category : null;
      const reason = category === 'missing' ? 'authentication'
        : category === 'denied' || category === 'configuration' || error instanceof DecisionValidationError ? 'unauthorized'
          : 'executor-unavailable';
      return failure(reason, { dispatchCertainty: 'not-sent' });
    }
    if (request.signal.aborted) return externalInterruption(request, 'not-sent');
    const timeoutMs = Math.max(1, request.deadlineEpochMs - this.now());
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([request.signal, deadline]);
    let body: string;
    try {
      body = JSON.stringify({ state: request.input, model: request.target.model,
        questions: { [request.questionId ?? request.alias]: toJevQuestion(request) } });
    } catch { return failure('invalid-request', { dispatchCertainty: 'not-sent' }); }
    if (request.signal.aborted) return externalInterruption(request, 'not-sent');
    let response: Response;
    try {
      const init: RequestInit = {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body,
        signal,
        redirect: 'error',
      };
      response = pin ? await this.pinnedFetch(new URL(this.endpoint), init, pin)
        : await this.fetchImpl(this.endpoint, init);
    } catch (error) {
      return request.signal.aborted ? externalInterruption(request, 'unknown')
        : deadline.aborted ? failure('timeout', { termination: 'target-timeout', remoteExecution: 'unknown', dispatchCertainty: 'unknown' })
          : error instanceof Error && error.name === 'AbortError'
            ? failure('cancelled', { termination: 'backend-cancelled', remoteExecution: 'unknown', dispatchCertainty: 'unknown' })
          : error instanceof JevTransportResponseError || error && typeof error === 'object' && 'code' in error && error.code === 'HPE_HEADER_OVERFLOW'
            ? failure('invalid-output', { remoteExecution: 'unknown', dispatchCertainty: 'unknown' })
          : failure('network-transient', { remoteExecution: 'unknown', dispatchCertainty: 'unknown' });
    }
    const correlation = requestId(response.headers);
    let metadata: Partial<AdapterObservation> = { ...correlation, httpStatus: response.status, dispatchCertainty: 'terminal-response' };
    if (request.signal.aborted) return externalInterruption(request, 'terminal-response', metadata);
    if (deadline.aborted) return failure('timeout', { ...metadata, termination: 'target-timeout', remoteExecution: 'unknown' });
    if (!headersWithinLimit(response.headers)) {
      await response.body?.cancel().catch(() => undefined);
      return failure('invalid-output', metadata);
    }
    let finalOrigin: string | null = null;
    try { if (response.url) finalOrigin = new URL(response.url).origin; }
    catch { finalOrigin = 'invalid'; }
    if (finalOrigin && finalOrigin !== new URL(this.endpoint).origin) {
      await response.body?.cancel().catch(() => undefined);
      return failure('data-boundary-denied', metadata);
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      return failure('data-boundary-denied', metadata);
    }
    if (!response.ok) {
      try {
        const errorBody = await readBoundedBody(response, signal);
        if (!metadata.requestId && response.headers.get('content-type')?.includes('json')) {
          let parsedError: unknown;
          try { parsedError = parseBoundedJson(errorBody); }
          catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw error;
            parsedError = null;
          }
          if (parsedError && typeof parsedError === 'object' && !Array.isArray(parsedError)) {
            const field = (parsedError as Record<string, unknown>).request_id ?? (parsedError as Record<string, unknown>).requestId;
            const safe = safeRequestId(field);
            if (safe) metadata = { ...metadata, requestId: safe, requestIdSource: 'body' as const };
          }
        }
      } catch {
        if (request.signal.aborted) return externalInterruption(request, 'terminal-response', metadata);
        if (deadline.aborted) return failure('timeout', { ...metadata, termination: 'target-timeout', remoteExecution: 'unknown' });
        return failure('invalid-output', metadata);
      }
      const retryAfterMs = parseRetryAfter(response.headers, this.now());
      return failure(mapStatus(response.status), { ...metadata, ...(retryAfterMs === null ? {} : { retryAfterMs }) });
    }

    let parsed: unknown;
    try {
      const encoded = await readBoundedBody(response, signal);
      parsed = parseBoundedJson(encoded);
      if (request.signal.aborted) return externalInterruption(request, 'terminal-response', metadata);
      if (deadline.aborted) return failure('timeout', { ...metadata, termination: 'target-timeout', remoteExecution: 'unknown' });
      const normalized = normalizeResponse(request, parsed);
      return { ...normalized, ...metadata };
    } catch {
      return request.signal.aborted ? externalInterruption(request, 'terminal-response', metadata)
        : deadline.aborted ? failure('timeout', { ...metadata, termination: 'target-timeout', remoteExecution: 'unknown' })
          : failure('invalid-output', metadata);
    }
  }

  async evaluateMany(batch: DecisionAdapterBatchRequest): Promise<DecisionAdapterBatchObservation> {
    const requests = batch.requests;
    const request = requests[0];
    if (!request || requests.length < 2 || requests.some(candidate =>
      canonicalJson(candidate.input) !== canonicalJson(request.input)
      || canonicalJson(batchTargetEnvelope(candidate.target)) !== canonicalJson(batchTargetEnvelope(request.target))
      || candidate.deadlineEpochMs !== request.deadlineEpochMs
      || !candidate.questionId)) {
      return batchFailure(requests, failure('invalid-request', { dispatchCertainty: 'not-sent' }));
    }
    const ids = requests.map(candidate => candidate.questionId!);
    if (new Set(ids).size !== ids.length) return batchFailure(requests, failure('invalid-request', { dispatchCertainty: 'not-sent' }));
    if (request.signal.aborted) return batchFailure(requests, externalInterruption(request, 'not-sent'));
    if (this.now() >= request.deadlineEpochMs) return batchFailure(requests,
      failure('timeout', { termination: 'target-timeout', dispatchCertainty: 'not-sent' }));
    let pin: PinnedAddress | null;
    try { pin = await withAbort(authorizeEndpoint(this.endpoint, this.allowedOrigins, this.resolveAddresses), request.signal); }
    catch { return batchFailure(requests, request.signal.aborted ? externalInterruption(request, 'not-sent')
      : failure('data-boundary-denied', { dispatchCertainty: 'not-sent' })); }
    let token: string;
    try {
      if (!request.target.credentialRef) return batchFailure(requests, failure('unauthorized', { dispatchCertainty: 'not-sent' }));
      const credential = new Uint8Array(await withAbort(request.resolveCredential(request.target.credentialRef), request.signal));
      try { token = new TextDecoder('utf-8', { fatal: true }).decode(credential); }
      finally { credential.fill(0); }
      if (!token || /[\r\n\u0000-\u001f\u007f]/.test(token)) {
        return batchFailure(requests, failure('authentication', { dispatchCertainty: 'not-sent' }));
      }
    } catch (error) {
      if (request.signal.aborted) return batchFailure(requests, externalInterruption(request, 'not-sent'));
      const category = error instanceof JevCredentialError ? error.category : null;
      const reason = category === 'missing' ? 'authentication'
        : category === 'denied' || category === 'configuration' || error instanceof DecisionValidationError ? 'unauthorized'
          : 'executor-unavailable';
      return batchFailure(requests, failure(reason, { dispatchCertainty: 'not-sent' }));
    }
    const deadline = AbortSignal.timeout(Math.max(1, request.deadlineEpochMs - this.now()));
    const signal = AbortSignal.any([request.signal, deadline]);
    let body: string;
    try {
      body = JSON.stringify({ state: request.input, model: request.target.model,
        questions: Object.fromEntries(requests.map(candidate => [candidate.questionId!, toJevQuestion(candidate)])) });
    } catch { return batchFailure(requests, failure('invalid-request', { dispatchCertainty: 'not-sent' })); }
    let response: Response;
    try {
      const init: RequestInit = { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body, signal, redirect: 'error' };
      response = pin ? await this.pinnedFetch(new URL(this.endpoint), init, pin) : await this.fetchImpl(this.endpoint, init);
    } catch (error) {
      const observation = request.signal.aborted ? externalInterruption(request, 'unknown')
        : deadline.aborted ? failure('timeout', { termination: 'target-timeout', remoteExecution: 'unknown', dispatchCertainty: 'unknown' })
          : error instanceof Error && error.name === 'AbortError'
            ? failure('cancelled', { termination: 'backend-cancelled', remoteExecution: 'unknown', dispatchCertainty: 'unknown' })
            : failure('network-transient', { remoteExecution: 'unknown', dispatchCertainty: 'unknown' });
      return batchFailure(requests, observation);
    }
    const correlation = requestId(response.headers);
    let metadata: Partial<AdapterObservation> = { ...correlation, httpStatus: response.status, dispatchCertainty: 'terminal-response' };
    if (!headersWithinLimit(response.headers)) {
      await response.body?.cancel().catch(() => undefined);
      return batchFailure(requests, failure('invalid-output', metadata));
    }
    let finalOrigin: string | null = null;
    try { if (response.url) finalOrigin = new URL(response.url).origin; } catch { finalOrigin = 'invalid'; }
    if (finalOrigin && finalOrigin !== new URL(this.endpoint).origin || response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      return batchFailure(requests, failure('data-boundary-denied', metadata));
    }
    if (!response.ok) {
      try { await readBoundedBody(response, signal); } catch { return batchFailure(requests, failure('invalid-output', metadata)); }
      const retryAfterMs = parseRetryAfter(response.headers, this.now());
      return batchFailure(requests, failure(mapStatus(response.status), { ...metadata, ...(retryAfterMs === null ? {} : { retryAfterMs }) }));
    }
    try {
      const parsed = parseBoundedJson(await readBoundedBody(response, signal));
      const normalized = normalizeBatchResponse(requests, parsed).map(answer => ({
        questionId: answer.questionId,
        observation: { ...answer.observation, ...metadata },
      }));
      return { answers: normalized, sharedUsage: normalizeUsage(asRecord(parsed).usage) };
    } catch {
      return batchFailure(requests, failure('invalid-output', metadata));
    }
  }
}

function batchTargetEnvelope(target: DecisionAdapterRequest['target']): Record<string, unknown> {
  return {
    adapter: target.adapter, adapterVersion: target.adapterVersion, model: target.model,
    credentialRef: target.credentialRef ?? null, subagent: target.subagent ?? null,
    timeoutMs: target.timeoutMs, retry: target.retry,
  };
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  let onAbort = (): void => undefined;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

function toJevQuestion(request: DecisionAdapterRequest): Record<string, unknown> {
  const { answer } = request.definition.spec;
  if (answer.kind === 'choice') {
    return {
      type: 'choice',
      instructions: request.definition.spec.question,
      criteria: Object.fromEntries(answer.options.map(option => [option.id, option.description])),
    };
  }
  if (answer.kind === 'ordinal-score') {
    return { type: 'score', instructions: request.definition.spec.question, criteria: answer.levels };
  }
  return {
    type: 'noul',
    instructions: request.definition.spec.question,
    criteria: { true: answer.trueDescription, false: answer.falseDescription },
  };
}

function normalizeResponse(request: DecisionAdapterRequest, value: unknown): AdapterObservation {
  const body = asRecord(value);
  const answers = asRecord(body.answers);
  const questionId = request.questionId ?? request.alias;
  if (Object.keys(answers).length !== 1 || !Object.prototype.hasOwnProperty.call(answers, questionId)) {
    throw new DecisionValidationError('Jev response must contain exactly the requested answer key');
  }
  return normalizeAnswer(request, body, questionId);
}

function normalizeBatchResponse(requests: readonly DecisionAdapterRequest[], value: unknown): Array<{ questionId: string; observation: AdapterObservation }> {
  const body = asRecord(value);
  const answers = asRecord(body.answers);
  const ids = requests.map(request => request.questionId!);
  if (Object.keys(answers).length !== ids.length || ids.some(id => !Object.prototype.hasOwnProperty.call(answers, id))) {
    throw new DecisionValidationError('Jev batch response must exactly match requested answer keys');
  }
  return requests.map(request => ({ questionId: request.questionId!, observation: normalizeAnswer(request, body, request.questionId!) }));
}

function normalizeAnswer(request: DecisionAdapterRequest, body: Record<string, unknown>, questionId: string): AdapterObservation {
  const answers = asRecord(body.answers);
  const answer = asRecord(answers[questionId]);
  const model = typeof body.model === 'string' && body.model ? body.model : null;
  const usage = normalizeUsage(body.usage);
  const kind = request.definition.spec.answer.kind;
  if (kind === 'choice') {
    if (answer.type !== 'choice' || typeof answer.choice !== 'string') throw new DecisionValidationError('invalid Choice response');
    const distribution = numericRecord(answer.probabilities);
    validateDistribution(request.definition, distribution);
    validateDecisionValue(request.definition, answer.choice);
    const maximum = Math.max(...Object.values(distribution));
    if (distribution[answer.choice] !== maximum) throw new DecisionValidationError('Choice value must have maximal probability');
    return success(answer.choice, model, usage, uncertainty(answer.confidence, distribution, 'typesafe-distribution-v1'));
  }
  if (kind === 'ordinal-score') {
    if (answer.type !== 'score' || typeof answer.score !== 'number') throw new DecisionValidationError('invalid Score response');
    const distribution = numericRecord(answer.probabilities);
    validateDistribution(request.definition, distribution);
    const legend = asRecord(answer.legend);
    request.definition.spec.answer.levels.forEach((level, index) => {
      if (canonicalJson(legend[String(index)]) !== canonicalJson(level)) throw new DecisionValidationError('Score legend does not match declared levels');
    });
    const mean = Object.entries(distribution).reduce((sum, [index, probability]) => sum + Number(index) * probability, 0);
    if (Math.abs(mean - answer.score) > 0.02) throw new DecisionValidationError('Score is not the distribution weighted mean');
    validateDecisionValue(request.definition, answer.score);
    return success(answer.score, model, usage, uncertainty(answer.confidence, distribution, 'typesafe-distribution-v1'));
  }
  if (answer.type !== 'noul' || typeof answer.noul !== 'number') throw new DecisionValidationError('invalid Noul response');
  validateDecisionValue(request.definition, answer.noul);
  return success(answer.noul, model, usage, {
    source: 'provider', profile: 'typesafe-truth-v1', calibration: 'vendor-claimed',
    confidence: null, distribution: null, calibrationRef: null,
  });
}

function batchFailure(requests: readonly DecisionAdapterRequest[], observation: AdapterObservation): DecisionAdapterBatchObservation {
  return {
    answers: requests.map(request => ({ questionId: request.questionId ?? request.alias, observation: { ...observation } })),
    sharedUsage: observation.usage,
  };
}

function success(value: string | number, actualModel: string | null, usage: DecisionUsage, uncertaintyValue: AdapterObservation['uncertainty']): AdapterObservation {
  return { status: 'success', reason: 'none', value, uncertainty: uncertaintyValue, actualModel, usage, requestId: null };
}

function failure(reason: DecisionFailureReason, extra: Partial<AdapterObservation> = {}): AdapterObservation {
  const status = reason === 'unsupported-capability' ? 'unsupported' : reason === 'cancelled' ? 'cancelled' : 'error';
  return { status, reason, uncertainty: null, actualModel: null, usage: emptyUsage(), requestId: null, ...extra };
}

function externalInterruption(request: DecisionAdapterRequest, certainty: NonNullable<AdapterObservation['dispatchCertainty']>,
  metadata: Partial<AdapterObservation> = {}): AdapterObservation {
  const caller = request.callerSignal ? request.callerSignal.aborted : request.signal.aborted;
  const termination = caller ? 'caller-cancelled' : request.totalSignal?.aborted ? 'total-deadline' : 'target-timeout';
  return failure(caller ? 'cancelled' : 'timeout', {
    ...metadata,
    termination,
    dispatchCertainty: certainty,
    ...(certainty === 'not-sent' ? {} : { remoteExecution: 'unknown' as const }),
  });
}

function uncertainty(confidence: unknown, distribution: Record<string, number>, profile: string): AdapterObservation['uncertainty'] {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new DecisionValidationError('confidence must be a finite probability');
  }
  return { source: 'provider', profile, calibration: 'vendor-claimed', confidence, distribution, calibrationRef: null };
}

function normalizeUsage(value: unknown): DecisionUsage {
  const usage = asRecord(value);
  return {
    inputTokens: integerOrNull(usage.input_tokens),
    outputTokens: integerOrNull(usage.output_tokens),
    costUsd: null,
  };
}

function emptyUsage(): DecisionUsage {
  return { inputTokens: null, outputTokens: null, costUsd: null };
}

function integerOrNull(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function numericRecord(value: unknown): Record<string, number> {
  const record = asRecord(value);
  if (Object.values(record).some(entry => typeof entry !== 'number')) throw new DecisionValidationError('probability map must be numeric');
  return record as Record<string, number>;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DecisionValidationError('expected object');
  return value as Record<string, unknown>;
}

function mapStatus(status: number): DecisionFailureReason {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 400 || status === 404 || status === 422) return 'invalid-request';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate-limited';
  if (status === 529) return 'overloaded';
  if (status >= 500) return 'service-error';
  return 'invalid-request';
}

function parseRetryAfter(headers: Headers, now: number): number | null {
  const milliseconds = headers.get('retry-after-ms');
  if (milliseconds !== null && /^\d+(?:\.\d+)?$/.test(milliseconds.trim())) {
    const value = Number(milliseconds);
    if (Number.isSafeInteger(value) && value >= 0) return value;
  }
  const value = headers.get('retry-after');
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const seconds = Number(value);
    return Number.isSafeInteger(Math.ceil(seconds * 1000)) ? Math.ceil(seconds * 1000) : null;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) && date > now ? date - now : null;
}

function requestId(headers: Headers): Pick<AdapterObservation, 'requestId' | 'requestIdSource'> {
  for (const [name, source] of [['x-typesafe-request-id', 'typesafe'], ['x-request-id', 'legacy']] as const) {
    const value = safeRequestId(headers.get(name));
    if (value) {
      return { requestId: value, requestIdSource: source };
    }
  }
  return { requestId: null };
}

function safeRequestId(value: unknown): string | null {
  // A comma indicates merged duplicate headers; decline ambiguous correlation values.
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_REQUEST_ID_LENGTH
    && /^[\x21-\x7e]+$/.test(value) && !value.includes(',') ? value : null;
}

function parseBoundedJson(text: string): unknown {
  rejectDuplicateAnswerKeys(text);
  return structuredClone(runInNewContext('JSON.parse(input)', { input: text }, { timeout: MAX_PARSE_MS }));
}

/** Detect duplicate keys in the response's answer map before JSON.parse erases them. */
function rejectDuplicateAnswerKeys(text: string): void {
  const marker = /"answers"\s*:\s*\{/g.exec(text);
  if (!marker) return;
  let index = marker.index + marker[0].length;
  let depth = 1;
  const keys = new Set<string>();
  while (index < text.length && depth > 0) {
    const char = text[index]!;
    if (char === '"') {
      const start = index++;
      let escaped = false;
      while (index < text.length) {
        const next = text[index++]!;
        if (escaped) escaped = false;
        else if (next === '\\') escaped = true;
        else if (next === '"') break;
      }
      if (depth === 1 && /^\s*:/.test(text.slice(index))) {
        const key = JSON.parse(text.slice(start, index)) as string;
        if (keys.has(key)) throw new DecisionValidationError('duplicate Jev answer key');
        keys.add(key);
      }
      continue;
    }
    if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') depth -= 1;
    index += 1;
  }
}

function headersWithinLimit(headers: Headers): boolean {
  let bytes = 0;
  for (const [name, value] of headers) {
    bytes += name.length + value.length;
    if (bytes > MAX_HEADER_BYTES) return false;
  }
  return true;
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_BODY_BYTES) throw new Error('response too large');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let onAbort = (): void => undefined;
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new Error('aborted'));
    else {
      onAbort = () => reject(new Error('aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), aborted]);
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_BODY_BYTES) throw new Error('response too large');
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    signal.removeEventListener('abort', onAbort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function systemResolveAddresses(hostname: string): Promise<readonly string[]> {
  return (await lookup(hostname, { all: true })).map(address => address.address);
}

async function authorizeEndpoint(endpoint: string, allowedOrigins: readonly string[],
  resolveAddresses: (hostname: string) => Promise<readonly string[]>): Promise<PinnedAddress | null> {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port && url.port !== '443') throw new Error('unsafe endpoint');
  if (url.origin === new URL(JEV_ENDPOINT).origin) return null;
  if (isIP(url.hostname)) throw new Error('literal endpoint address');
  if (!allowedOrigins.some(origin => {
    try {
      const approved = new URL(origin);
      return approved.protocol === 'https:' && !approved.username && !approved.password && !approved.search && !approved.hash
        && approved.pathname === '/' && approved.origin === url.origin;
    } catch { return false; }
  })) throw new Error('unapproved endpoint');
  const addresses = await resolveAddresses(url.hostname);
  if (!addresses.length || addresses.some(address => !publicIpv4(address))) throw new Error('unsafe endpoint address');
  return { address: addresses[0]!, family: 4 };
}

function publicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false; // IPv6 is denied until its full special-use range policy is implemented.
  const [a, b, c] = address.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a! >= 224 || a === 169 && b === 254 || a === 172 && b! >= 16 && b! <= 31
    || a === 192 && (b === 168 || b === 0) || a === 100 && b! >= 64 && b! <= 127
    || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113) return false;
  return true;
}

async function pinnedHttpsFetch(url: URL, init: RequestInit, pin: PinnedAddress): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const headers = init.headers as Record<string, string>;
    const outgoing = httpsRequest(url, {
      method: 'POST', headers, maxHeaderSize: MAX_HEADER_BYTES, agent: false,
      servername: url.hostname, rejectUnauthorized: true,
      lookup: (hostname, _options, callback) => {
        if (hostname !== url.hostname) { callback(new Error('hostname mismatch'), '', 4); return; }
        callback(null, pin.address, pin.family);
      },
    }, incoming => {
      try {
        let stream: Readable = incoming;
        const encoding = incoming.headers['content-encoding'];
        if (encoding === 'gzip') stream = incoming.pipe(createGunzip());
        else if (encoding === 'deflate') stream = incoming.pipe(createInflate());
        else if (encoding === 'br') stream = incoming.pipe(createBrotliDecompress());
        else if (encoding && encoding !== 'identity') throw new JevTransportResponseError();
        const responseHeaders = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          responseHeaders.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
        }
        const status = incoming.statusCode ?? 502;
        const noBody = status === 204 || status === 205 || status === 304;
        const response = new Response(noBody ? null : Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
          status, headers: responseHeaders,
        });
        Object.defineProperty(response, 'url', { value: url.toString() });
        resolve(response);
      } catch (error) { incoming.destroy(); reject(error instanceof JevTransportResponseError ? error : new JevTransportResponseError()); }
    });
    outgoing.on('error', reject);
    const onAbort = (): void => { outgoing.destroy(new DOMException('Aborted', 'AbortError')); };
    init.signal?.addEventListener('abort', onAbort, { once: true });
    outgoing.on('close', () => init.signal?.removeEventListener('abort', onAbort));
    outgoing.end(init.body as string);
  });
}
