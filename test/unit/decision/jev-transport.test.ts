import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { JevCredentialError, JevDecisionAdapter, type DecisionAdapterRequest, type DecisionBinding, type DecisionDefinition } from '../../../src/decision/index.js';
import { DecisionValidationError } from '../../../src/decision/validate.js';

const fixture = <T>(name: string): T => JSON.parse(readFileSync(`examples/decision/${name}`, 'utf8')) as T;
const answer = {
  model: 'jev-1.13.0', answers: { category: { type: 'choice', choice: 'documentation', confidence: 0.9,
    probabilities: { documentation: 0.9, runtime: 0.1, other: 0 } } }, usage: { input_tokens: 1, output_tokens: 2 },
};
function request(overrides: Partial<DecisionAdapterRequest> = {}): DecisionAdapterRequest {
  return {
    alias: 'category', definition: fixture<DecisionDefinition>('decision-category.json'), input: fixture('input.json'),
    target: fixture<DecisionBinding>('binding-jev.json').spec.evaluations.category!.targets[0]!,
    invocationId: 'transport-fixture', deadlineEpochMs: Date.now() + 10_000,
    signal: new AbortController().signal, resolveCredential: async () => new TextEncoder().encode('synthetic-token'), ...overrides,
  };
}
const reply = (status = 200, headers: Record<string, string> = {}): Response =>
  new Response(status === 200 ? JSON.stringify(answer) : '{}', { status, headers });

describe('Jev transport contract', () => {
  it.each([
    [{ 'x-typesafe-request-id': 'official' }, 'official', 'typesafe'],
    [{ 'x-typesafe-request-id': 'official', 'x-request-id': 'legacy' }, 'official', 'typesafe'],
    [{ 'x-request-id': 'legacy' }, 'legacy', 'legacy'],
    [{}, null, undefined],
    [{ 'x-typesafe-request-id': 'bad, duplicate' }, null, undefined],
    [{ 'x-typesafe-request-id': 'x'.repeat(129) }, null, undefined],
  ] as const)('ADP-REQID-%#: normalizes safe request ID headers', async (headers, expected, source) => {
    const adapter = new JevDecisionAdapter({ fetch: async () => reply(200, headers) });
    const result = await adapter.evaluate(request());
    expect(result).toMatchObject({ status: 'success', requestId: expected });
    expect(result.requestIdSource).toBe(source);
  });

  it('forwards only a well-formed W3C traceparent to the transport', async () => {
    const traceparent = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;
    const seen: Array<Record<string, string>> = [];
    const adapter = new JevDecisionAdapter({ fetch: async (_url, init) => { seen.push(init!.headers as Record<string, string>); return reply(); } });
    await adapter.evaluate(request({ traceContext: { traceparent } }));
    await adapter.evaluate(request({ traceContext: { traceparent: `${traceparent}\r\nx-injected: 1` } }));
    await adapter.evaluate(request({ traceContext: { traceparent: `00-${'0'.repeat(32)}-${'b'.repeat(16)}-01` } }));
    await adapter.evaluate(request());
    expect(seen.map(headers => headers.traceparent ?? null)).toEqual([traceparent, null, null, null]);
    expect(seen.some(headers => Object.hasOwn(headers, 'tracestate') || Object.hasOwn(headers, 'x-injected'))).toBe(false);
  });

  it.each([408, 429, 529, 500, 503, 401, 403, 404, 422])('RTY-STATUS-%i: classifies HTTP with status and request ID', async status => {
    const adapter = new JevDecisionAdapter({ fetch: async () => reply(status, { 'x-typesafe-request-id': 'error-id' }) });
    const result = await adapter.evaluate(request());
    expect(result).toMatchObject({ httpStatus: status, requestId: 'error-id', dispatchCertainty: 'terminal-response' });
    expect(result.reason).toBe(({ 408: 'timeout', 429: 'rate-limited', 529: 'overloaded', 401: 'authentication', 403: 'authentication', 404: 'invalid-request', 422: 'invalid-request' } as Record<number, string>)[status] ?? 'service-error');
  });

  it('ADP-REQID-BODY: uses a safe error-body request ID only when no safe header ID exists', async () => {
    const body = JSON.stringify({ request_id: 'body-id', error: 'synthetic' });
    const fromBody = new JevDecisionAdapter({ fetch: async () => new Response(body, { status: 429, headers: { 'content-type': 'application/json' } }) });
    expect(await fromBody.evaluate(request())).toMatchObject({ reason: 'rate-limited', requestId: 'body-id', requestIdSource: 'body' });
    const fromHeader = new JevDecisionAdapter({ fetch: async () => new Response(body, { status: 429,
      headers: { 'content-type': 'application/json', 'x-typesafe-request-id': 'header-id' } }) });
    expect(await fromHeader.evaluate(request())).toMatchObject({ requestId: 'header-id', requestIdSource: 'typesafe' });
  });

  it.each([
    [{ 'retry-after-ms': '125', 'retry-after': '20' }, 125],
    [{ 'retry-after': '1.5' }, 1500],
    [{ 'retry-after': 'Wed, 01 Jan 2020 00:00:03 GMT' }, 3000],
    [{ 'retry-after': 'Wed, 01 Jan 2019 00:00:03 GMT' }, null],
    [{ 'retry-after-ms': 'wrong', 'retry-after': '2' }, 2000],
    [{ 'retry-after-ms': '-1', 'retry-after': 'bad' }, null],
  ] as const)('RTY-HINT-%#: parses retry hints', async (headers, expected) => {
    const now = Date.parse('Wed, 01 Jan 2020 00:00:00 GMT');
    const adapter = new JevDecisionAdapter({ now: () => now, fetch: async () => reply(429, headers) });
    const result = await adapter.evaluate(request({ deadlineEpochMs: now + 10_000 }));
    expect(result.retryAfterMs ?? null).toBe(expected);
  });

  it('CAN-PREFLIGHT: distinguishes preflight, caller abort, deadline abort, and network ambiguity', async () => {
    const network = vi.fn(async () => { throw new Error('synthetic network loss'); });
    const adapter = new JevDecisionAdapter({ fetch: network });
    expect(await adapter.evaluate(request({ target: { ...request().target, credentialRef: undefined } }))).toMatchObject({ reason: 'unauthorized', dispatchCertainty: 'not-sent' });
    expect(network).not.toHaveBeenCalled();
    expect(await adapter.evaluate(request({ resolveCredential: async () => { throw new DecisionValidationError('synthetic-secret-canary'); } }))).toMatchObject({ reason: 'unauthorized', dispatchCertainty: 'not-sent' });
    expect(network).not.toHaveBeenCalled();
    const cancelled = new AbortController(); cancelled.abort();
    expect(await adapter.evaluate(request({ signal: cancelled.signal }))).toMatchObject({ reason: 'cancelled', termination: 'caller-cancelled', dispatchCertainty: 'not-sent' });
    const total = new AbortController(); total.abort();
    expect(await adapter.evaluate(request({ signal: total.signal, totalSignal: total.signal, callerSignal: new AbortController().signal }))).toMatchObject({ reason: 'timeout', termination: 'total-deadline', dispatchCertainty: 'not-sent' });
    const racingCaller = new AbortController(); const racingTotal = new AbortController();
    racingTotal.abort(); racingCaller.abort();
    expect(await adapter.evaluate(request({ signal: racingTotal.signal, totalSignal: racingTotal.signal,
      callerSignal: racingCaller.signal }))).toMatchObject({ reason: 'cancelled', termination: 'caller-cancelled' });
    expect(await adapter.evaluate(request({ deadlineEpochMs: Date.now() - 1 }))).toMatchObject({ reason: 'timeout', dispatchCertainty: 'not-sent' });
    expect(await adapter.evaluate(request())).toMatchObject({ reason: 'network-transient', dispatchCertainty: 'unknown', remoteExecution: 'unknown' });
    const backendCancelled = new JevDecisionAdapter({ fetch: async () => { throw new DOMException('backend', 'AbortError'); } });
    expect(await backendCancelled.evaluate(request())).toMatchObject({ reason: 'cancelled', termination: 'backend-cancelled', dispatchCertainty: 'unknown' });
  });

  it('SEC-ORIGIN-REDIRECT: authorizes the final origin before resolving credentials and never follows redirects', async () => {
    const credentials = vi.fn(async () => new TextEncoder().encode('synthetic-token'));
    const fetchMock = vi.fn(async () => reply(302, { location: 'https://attacker.example/steal' }));
    for (const endpoint of ['http://api.typesafe.ai/v1/systemone', 'https://127.0.0.1/v1/systemone', 'https://attacker.example/v1/systemone', 'https://user:pass@api.typesafe.ai/v1/systemone']) {
      const denied = await new JevDecisionAdapter({ endpoint, fetch: fetchMock }).evaluate(request({ resolveCredential: credentials }));
      expect(denied.reason).toBe('data-boundary-denied');
    }
    expect(credentials).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    const adapter = new JevDecisionAdapter({ fetch: fetchMock });
    expect((await adapter.evaluate(request())).reason).toBe('data-boundary-denied');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
  });

  it('SEC-REDIRECT-LOOP: does not follow a same-origin redirect loop', async () => {
    const fetchMock = vi.fn(async () => reply(302, { location: 'https://api.typesafe.ai/v1/systemone' }));
    const adapter = new JevDecisionAdapter({ fetch: fetchMock });
    expect((await adapter.evaluate(request())).reason).toBe('data-boundary-denied');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('SEC-DNS: pins an approved public custom origin across a public-to-private DNS rebind', async () => {
    const credentials = vi.fn(async () => new TextEncoder().encode('synthetic-token'));
    const fetchMock = vi.fn(async () => reply());
    const addresses = ['93.184.216.34', '169.254.1.1'];
    const resolveAddresses = vi.fn(async () => [addresses.shift()!]);
    const pinnedFetch = vi.fn(async (_url: URL, _init: RequestInit, pin: { address: string }) => {
      expect(pin.address).toBe('93.184.216.34');
      return reply();
    });
    const adapter = new JevDecisionAdapter({ endpoint: 'https://custom.example/v1/systemone', allowedOrigins: ['https://custom.example'],
      resolveAddresses, fetch: fetchMock, pinnedFetch });
    expect((await adapter.evaluate(request({ resolveCredential: credentials }))).status).toBe('success');
    expect(resolveAddresses).toHaveBeenCalledTimes(1);
    expect(pinnedFetch).toHaveBeenCalledTimes(1);
    expect(credentials).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('SEC-DNS-PRIVATE: rejects a private approved-origin DNS answer before credentials', async () => {
    const credentials = vi.fn(async () => new TextEncoder().encode('synthetic-token'));
    const pinnedFetch = vi.fn(async () => reply());
    const adapter = new JevDecisionAdapter({ endpoint: 'https://custom.example/v1/systemone', allowedOrigins: ['https://custom.example'],
      resolveAddresses: async () => ['93.184.216.34', '127.0.0.1'], pinnedFetch });
    expect((await adapter.evaluate(request({ resolveCredential: credentials }))).reason).toBe('data-boundary-denied');
    expect(credentials).not.toHaveBeenCalled();
    expect(pinnedFetch).not.toHaveBeenCalled();
  });

  it('SEC-HOST-MISMATCH: rejects a response whose final origin differs from the authorized origin', async () => {
    const redirected = reply();
    Object.defineProperty(redirected, 'url', { value: 'https://attacker.example/steal' });
    const adapter = new JevDecisionAdapter({ fetch: async () => redirected });
    expect((await adapter.evaluate(request())).reason).toBe('data-boundary-denied');
  });

  it('CAN-FETCH: caller cancellation during fetch wins over a simultaneous fetch abort', async () => {
    const controller = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      entered();
      await new Promise<void>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
      throw new Error('unreachable');
    });
    const adapter = new JevDecisionAdapter({ fetch: fetchMock as typeof fetch });
    const pending = adapter.evaluate(request({ signal: controller.signal }));
    await started;
    controller.abort();
    expect(await pending).toMatchObject({ reason: 'cancelled', termination: 'caller-cancelled', dispatchCertainty: 'unknown', remoteExecution: 'unknown' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('CAN-STREAM: caller cancellation during response streaming stops bounded parsing', async () => {
    const controller = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const body = new ReadableStream<Uint8Array>({ pull() { entered(); } }, { highWaterMark: 0 });
    const adapter = new JevDecisionAdapter({ fetch: async () => new Response(body) });
    const pending = adapter.evaluate(request({ signal: controller.signal }));
    await started;
    controller.abort();
    expect(await pending).toMatchObject({ reason: 'cancelled', termination: 'caller-cancelled', remoteExecution: 'unknown' });
  });

  it('CAN-CREDENTIAL: caller cancellation stops a pending credential wait before dispatch', async () => {
    const controller = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const fetchMock = vi.fn(async () => reply());
    const adapter = new JevDecisionAdapter({ fetch: fetchMock });
    const pending = adapter.evaluate(request({ signal: controller.signal,
      resolveCredential: async () => { entered(); return new Promise<Uint8Array>(() => undefined); } }));
    await started;
    controller.abort();
    expect(await pending).toMatchObject({ reason: 'cancelled', termination: 'caller-cancelled', dispatchCertainty: 'not-sent' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('PRV-CRED-CANARY: never serializes credential resolver error text', async () => {
    const canary = 'synthetic-secret-canary-should-never-appear';
    const adapter = new JevDecisionAdapter({ fetch: vi.fn(async () => reply()) });
    const result = await adapter.evaluate(request({ resolveCredential: async () => { throw new Error(canary); } }));
    expect(result).toMatchObject({ reason: 'executor-unavailable', dispatchCertainty: 'not-sent' });
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it.each([
    ['missing', 'authentication'], ['denied', 'unauthorized'], ['configuration', 'unauthorized'], ['failed', 'executor-unavailable'],
  ] as const)('PRV-CRED-%s: normalizes failure before network dispatch', async (category, expected) => {
    const fetchMock = vi.fn(async () => reply());
    const adapter = new JevDecisionAdapter({ fetch: fetchMock });
    const result = await adapter.evaluate(request({ resolveCredential: async () => { throw new JevCredentialError(category); } }));
    expect(result).toMatchObject({ reason: expected, dispatchCertainty: 'not-sent' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ADP-REQID-INJECTION: drops newline-injected request IDs even from a nonconforming fetch transport', async () => {
    const response = reply();
    Object.defineProperty(response, 'headers', { value: {
      get: (name: string) => name === 'x-typesafe-request-id' ? 'safe\nunsafe' : null,
      *[Symbol.iterator]() { yield ['x-typesafe-request-id', 'safe\nunsafe']; },
    } });
    const result = await new JevDecisionAdapter({ fetch: async () => response }).evaluate(request());
    expect(result.requestId).toBeNull();
    expect(JSON.stringify(result)).not.toContain('safe\nunsafe');
  });

  it('SEC-RESPONSE-BOUNDS: bounds headers and streamed/decompressed body before parsing', async () => {
    const largeHeaders = new JevDecisionAdapter({ fetch: async () => reply(200, { 'x-large': 'x'.repeat(33_000) }) });
    expect((await largeHeaders.evaluate(request())).reason).toBe('invalid-output');
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); controller.close(); } });
    const largeBody = new JevDecisionAdapter({ fetch: async () => new Response(body) });
    expect((await largeBody.evaluate(request())).reason).toBe('invalid-output');
    const largeError = new JevDecisionAdapter({ fetch: async () => new Response(new Uint8Array(1024 * 1024 + 1), { status: 429 }) });
    expect((await largeError.evaluate(request())).reason).toBe('invalid-output');
  });

  it('SEC-RESPONSE-PARSE-TIME: interrupts pathological bounded JSON parsing', async () => {
    const deeplyNested = '['.repeat(500_000) + '0' + ']'.repeat(500_000);
    const adapter = new JevDecisionAdapter({ fetch: async () => new Response(deeplyNested) });
    const started = performance.now();
    expect((await adapter.evaluate(request())).reason).toBe('invalid-output');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

// Evaluator contract: one retry owner, bounded jitter, cancellation and attempt chronology.
import { artifactPin, decisionResultForExport, evaluateDecisionRuleset, validateDecisionDocument, type AdapterObservation, type DecisionAdapter, type DecisionRuleset } from '../../../src/decision/index.js';
function evaluationFixture(observe: () => AdapterObservation, extra: Record<string, unknown> = {}) {
  const ruleset = fixture<DecisionRuleset>('ruleset.json');
  ruleset.spec.evaluations = ruleset.spec.evaluations.filter(item => item.alias === 'category');
  ruleset.spec.rules = ruleset.spec.rules.filter(rule => rule.id === 'docs');
  const binding = fixture<DecisionBinding>('binding-jev.json');
  binding.spec.ruleset = artifactPin(ruleset);
  binding.spec.evaluations = { category: binding.spec.evaluations.category! };
  binding.spec.evaluations.category!.targets = [binding.spec.evaluations.category!.targets[0]!];
  binding.spec.evaluations.category!.fallbackOn = [];
  binding.spec.evaluations.category!.targets[0]!.retry = { maxRetries: 1, initialDelayMs: 100, maxDelayMs: 1000 };
  binding.spec.maxAttempts = 2;
  const adapter: DecisionAdapter = {
    id: 'jev', version: '1.0.0',
    capabilities: async () => ({ answerKinds: ['choice'], features: ['typed-output'], maxOptions: 255, maxLevels: 10,
      confidenceProfiles: ['typesafe-distribution-v1'], executable: true }),
    evaluate: async () => observe(),
  };
  return { ruleset, binding, definitions: { category: fixture<DecisionDefinition>('decision-category.json') },
    input: fixture('input.json'), runId: 'run', invocationId: 'retry-fixture', adapters: { jev: adapter }, ...extra };
}
const failed = (reason: AdapterObservation['reason'], retryAfterMs?: number): AdapterObservation => ({
  status: 'error', reason, uncertainty: null, actualModel: null,
  usage: { inputTokens: null, outputTokens: null, costUsd: null }, requestId: 'response-id',
  requestIdSource: 'typesafe', httpStatus: 429, dispatchCertainty: 'terminal-response',
  ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
});

describe('Jev retry and cancellation chronology', () => {
  it.each(['timeout', 'rate-limited', 'overloaded', 'service-error', 'network-transient'] as const)('RTY-BUDGET-%s: retries within one retry budget', async reason => {
    let count = 0; let clock = 0;
    const request = evaluationFixture(() => { count += 1; return failed(reason); }, {
      now: () => clock, random: () => 0.5, delay: async (ms: number) => { clock += ms; },
    });
    const result = await evaluateDecisionRuleset(request);
    const attempts = result.spec.evaluations.category?.spec.attempts ?? [];
    expect(count).toBe(2);
    expect(attempts.map(attempt => attempt.ordinal)).toEqual([1, 2]);
    expect(attempts[0]).toMatchObject({ retryDelayMs: 100, httpStatus: 429, requestIdSource: 'typesafe' });
    expect(() => validateDecisionDocument(result)).not.toThrow();
    const publicResult = decisionResultForExport(result);
    expect(publicResult.spec.evaluations.category?.spec.attempts[0]?.requestId).toBeNull();
    expect(JSON.stringify(publicResult)).not.toContain('response-id');
    expect(decisionResultForExport(result, { includeProviderRequestIds: true }).spec.evaluations.category?.spec.attempts[0]?.requestId).toBe('response-id');
  });

  it.each(['authentication', 'invalid-request', 'invalid-output', 'unauthorized', 'data-boundary-denied'] as const)('RTY-DENY-%s: does not retry', async reason => {
    let count = 0;
    const result = await evaluateDecisionRuleset(evaluationFixture(() => { count += 1; return failed(reason); }, {
      now: () => 0, random: () => 0.5, delay: async () => undefined,
    }));
    expect(count).toBe(1);
    expect(result.spec.evaluations.category?.spec.attempts).toHaveLength(1);
  });

  it('RTY-JITTER-DEADLINE: bounds excessive hints with deterministic jitter and a total deadline', async () => {
    let count = 0; let clock = 0;
    const delays: number[] = [];
    const request = evaluationFixture(() => { count += 1; return failed('rate-limited', 100_000); }, {
      now: () => clock, random: () => 1, delay: async (ms: number) => { delays.push(ms); clock += ms; },
    });
    request.binding.spec.totalTimeoutMs = 2_000;
    const result = await evaluateDecisionRuleset(request);
    expect(count).toBe(2);
    expect(delays).toEqual([1000]); // 1000 ms ceiling also bounds +25% jitter
    expect(result.spec.evaluations.category?.spec.attempts[0]?.retryDelayMs).toBe(1000);
  });

  it('CAN-BACKOFF: stops when caller cancels and starts no new attempt', async () => {
    let count = 0;
    const controller = new AbortController();
    const request = evaluationFixture(() => { count += 1; return failed('rate-limited'); }, {
      signal: controller.signal, now: () => 0, random: () => 0.5,
      delay: async () => { controller.abort(); throw new DOMException('cancelled', 'AbortError'); },
    });
    const result = await evaluateDecisionRuleset(request);
    expect(count).toBe(1);
    expect(result.spec.reason).toBe('cancelled');
    expect(result.spec.evaluations.category?.spec.attempts).toHaveLength(1);
  });
});
