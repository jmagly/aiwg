import { mkdtemp } from '../../helpers/temp-dir.js';
import { symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { multilineSecrets, multilineSecretValue, strictScannerPatterns, syntheticSecrets } from '../../fixtures/sessions/redaction-secrets.js';
import { measureThreadCpuBatch, medianPairedRatio } from '../../helpers/cli-perf-policy.js';
import { ImportCheckpointSchema, IntelligenceCandidateSchema, SessionRejectionDetailSchema } from '../../../src/sessions/contracts.js';
import {
  SESSION_PROVIDER_IDS,
  SessionContractError,
  schemaRejectionDetail,
  SessionEventSchema,
  assertSessionProviderId,
  assertSupportedSchemaMajor,
  authorizeSourceFile,
  DeletionReceiptSchema,
  defineSessionAdapterFixture,
  redactSessionText,
  redactSessionValue,
  sanitizeNativeExtensions,
  requireNetworkConsent,
  prefilterAuthorizedSearchScope,
  sha256,
} from '../../../src/sessions/index.js';

describe('session contracts', () => {
  it.each(['flag', 'env', 'config', 'default'])('preserves %s byte-limit origin in rejection details', origin => {
    const detail = { limit: 'maxTotalBytes', configured: 1, observed: 2,
      setting: 'sessions.import.max_source_bytes', origin };
    expect(SessionRejectionDetailSchema.parse(detail)).toEqual(detail);
  });

  it('extracts bounded paths and codes from nested validator failures without input values', () => {
    const schema = z.object({ events: z.array(z.union([
      z.object({ role: z.literal('user') }), z.object({ role: z.literal('assistant') }),
    ])) });
    const result = schema.safeParse({ events: [{ role: 'synthetic-transcript-marker' }] });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(schemaRejectionDetail(result.error)).toEqual({ issues: [
      { path: 'events.0.role', code: 'invalid_literal' },
      { path: 'events.0.role', code: 'invalid_literal' },
    ] });
    const many = z.array(z.string()).safeParse(Array(30).fill(null));
    if (many.success) throw new Error('expected validator failure');
    expect(schemaRejectionDetail(many.error)).toHaveProperty('issues.length', 20);
  });

  it('preserves diagnostic codes and locations for enums, formats and nested discriminators', () => {
    const schema = z.object({
      provider: z.enum(['claude', 'codex']),
      occurredAt: z.string().datetime(),
      event: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('user') }),
        z.object({ kind: z.literal('assistant') }),
      ]),
    });
    const result = schema.safeParse({ provider: 'synthetic-marker', occurredAt: 'synthetic-marker', event: {} });
    if (result.success) throw new Error('expected validator failure');
    expect(schemaRejectionDetail(result.error)).toEqual({ issues: [
      { path: 'provider', code: 'invalid_enum_value' },
      { path: 'occurredAt', code: 'invalid_string' },
      { path: 'event.kind', code: 'invalid_union_discriminator' },
    ] });
  });

  it('preserves unbounded number acceptance and one-sided numeric limits', () => {
    expect(SessionRejectionDetailSchema.parse({ limit: 'synthetic', configured: Infinity, observed: -Infinity }))
      .toEqual({ limit: 'synthetic', configured: Infinity, observed: -Infinity });
    const checkpoint = { cursor: '', recordsRead: 0, bytesRead: 0 };
    expect(ImportCheckpointSchema.parse({ ...checkpoint, sourceMtimeMs: Infinity }).sourceMtimeMs).toBe(Infinity);
    const negative = ImportCheckpointSchema.safeParse({ ...checkpoint, sourceMtimeMs: -Infinity });
    if (negative.success) throw new Error('expected negative mtime rejection');
    expect(negative.error.issues).toMatchObject([{ path: ['sourceMtimeMs'], code: 'too_small' }]);
    expect(ImportCheckpointSchema.safeParse({ ...checkpoint, sourceMtimeMs: NaN }).success).toBe(false);
  });

  it('parses candidate security defaults independently for each candidate', () => {
    const security = IntelligenceCandidateSchema.shape.security;
    const first = security.parse(undefined);
    first.warnings.push('instruction-like');
    expect(security.parse(undefined)).toEqual({
      disposition: 'clear', warnings: [], requiresAcknowledgement: false,
      acknowledged: false, policyVersion: '1.0.0',
    });
  });

  it('redacts session diagnostics and dynamic validator paths before they can reach receipts', () => {
    const canary = 'redaction-canary-diagnostic';
    const error = new SessionContractError('MALFORMED_SOURCE', canary, { issues: [{ path: canary, code: 'custom' }] });
    expect(error.message).not.toContain(canary);
    expect(JSON.stringify(error.detail)).not.toContain(canary);
    const result = z.record(z.string(), z.string()).safeParse({ [canary]: 42 });
    if (result.success) throw new Error('expected validator failure');
    expect(JSON.stringify(schemaRejectionDetail(result.error))).not.toContain(canary);
  });

  it('asserts every canonical provider ID with documented compatibility aliases', () => {
    expect(SESSION_PROVIDER_IDS).toEqual([
      'claude', 'codex', 'copilot', 'cursor', 'factory', 'hermes',
      'opencode', 'openclaw', 'openhuman', 'grokbot', 'grok-build', 'pi', 'omp', 'deepseek-harness', 'warp', 'devin-desktop', 'muse', 'generic',
    ]);
    expect(assertSessionProviderId('windsurf')).toBe('devin-desktop');
    expect(assertSessionProviderId('dsh')).toBe('deepseek-harness');
    expect(() => assertSessionProviderId('factory-ai')).toThrowError(
      expect.objectContaining({ code: 'UNKNOWN_PROVIDER' }),
    );
  });

  it.each(['2026-10-25T09:30Z', '2026-10-25T09:30:00+0200'])(
    'preserves minute and basic-offset timestamps (%s) and represented large integers', occurredAt => {
    expect(() => assertSupportedSchemaMajor('2.0.0')).toThrowError(
      expect.objectContaining({ code: 'UNKNOWN_SCHEMA_MAJOR' }),
    );
    const event = SessionEventSchema.parse({
      contractVersion: '1.0.0',
      eventId: 'event-1', sessionId: 'session-1', sourceId: 'source-1',
      importRunId: 'run-1', nativeId: null, sequence: 2 ** 54,
      kind: 'provider.future-event', role: null, occurredAt,
      searchableText: '', digest: sha256('future'),
      rawReference: { locatorClass: 'fixture', sequence: 0 },
      adapterVersion: '1.0.0', consistency: 'complete',
      sensitivity: { classification: 'none', classes: [] }, opaque: true,
      extensions: { 'native.claude': { future: true } },
    });
    expect(event.opaque).toBe(true);
    expect(event.sequence).toBe(2 ** 54);
    expect(event.occurredAt).toBe(occurredAt);
  });

  it('enforces fixture dispositions', () => {
    expect(() => defineSessionAdapterFixture({
      provider: 'warp', disposition: 'manual-only', synthetic: true,
      schemaVersion: '1.0.0', adapterVersion: '1.0.0', records: [],
    })).toThrow(/explicit reason/);
  });

  it('keeps deletion receipts content- and locator-free', () => {
    expect(() => DeletionReceiptSchema.parse({
      contractVersion: '1.0.0', receiptId: 'receipt-1', operationId: 'operation-1',
      scopeClass: 'workspace', counts: { events: 2 }, survivingDependentIds: [],
      actorClass: 'operator', reasonCode: 'user_request',
      orphanCounts: { events: 0 },
      outcome: 'committed', occurredAt: '2026-07-26T00:00:00.000Z',
      rawPath: '/sensitive/path',
    })).toThrow();
  });
});

describe('session source and content policy', () => {
  it('reports the authorized byte limit and observed source size without content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-policy-limit-'));
    const file = join(root, 'session.jsonl');
    const content = 'synthetic-transcript-marker';
    await writeFile(file, content);
    await expect(authorizeSourceFile({ selectedPath: file, allowedRoots: [root], maxBytes: 1 }))
      .rejects.toMatchObject({
        code: 'RESOURCE_LIMIT_EXCEEDED',
        detail: { limit: 'maxBytes', configured: 1, observed: Buffer.byteLength(content) },
      });
  });

  it('authorizes only explicitly selected regular files under canonical roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-session-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'aiwg-session-outside-'));
    const file = join(root, 'session.jsonl');
    const outsideFile = join(outside, 'session.jsonl');
    await writeFile(file, '{}\n');
    await writeFile(outsideFile, '{}\n');
    await expect(authorizeSourceFile({ selectedPath: file, allowedRoots: [root] }))
      .resolves.toMatchObject({ canonicalPath: file });
    await expect(authorizeSourceFile({ selectedPath: outsideFile, allowedRoots: [root] }))
      .rejects.toMatchObject({ code: 'SOURCE_OUTSIDE_ALLOWED_ROOT' });

    const link = join(root, 'linked.jsonl');
    await symlink(outsideFile, link);
    await expect(authorizeSourceFile({ selectedPath: link, allowedRoots: [root] }))
      .rejects.toMatchObject({ code: 'SOURCE_SYMLINK' });
  });

  it('redacts secrets and PII before derived use', () => {
    const result = redactSessionText('email a@example.com token=super-secret-value');
    expect(result.text).not.toContain('a@example.com');
    expect(result.text).not.toContain('super-secret-value');
    expect(result.sensitivity).toBe('sensitive');
  });

  it('still redacts email after long email-shaped prose without an at-sign', () => {
    const near = 'a.'.repeat(2_048);
    expect(redactSessionText(near).text).toBe(near);
    expect(redactSessionText(`${near} owner@example.com`).text)
      .toBe(`${near} [REDACTED:email]`);
  });

  it('recursively sanitizes native attributes with typed bounded markers', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = sanitizeNativeExtensions({
      status: 'complete',
      authorization: 'Bearer redaction-canary-authorization',
      nested: {
        futureField: 'redaction-canary-future',
        toolResult: 'redaction-canary-tool-output',
        url: 'https://user:redaction-canary-password@example.test/path',
        ownerEmail: 'redaction-canary@example.test',
        path: '/private/redaction-canary/path',
      },
      items: [
        { token: 'redaction-canary-array-token' },
        'redaction-canary-array-value',
      ],
      circular,
      deep: { a: { b: { c: { d: { e: { f: { g: { h: { i: 'secret' } } } } } } } } },
    });

    const serialized = JSON.stringify(result.value);
    expect(result.value.status).toBe('complete');
    expect(serialized).not.toContain('redaction-canary');
    expect(serialized).toContain('[REDACTED:sensitive-field]');
    expect(serialized).toContain('[REDACTED:content]');
    expect(serialized).toContain('[REDACTED:path]');
    expect(serialized).toContain('[REDACTED:circular-reference]');
    expect(serialized).toContain('[REDACTED:depth-limit]');
    expect(result.sensitivity).toBe('sensitive');
    expect(result.decisions).not.toHaveProperty('value');
  });

  it.each(syntheticSecrets)('redacts synthetic %s and records its classification count (%#)', (classification, value) => {
    const result = redactSessionText(value);
    expect(result.text).toBe(`[REDACTED:${classification}]`);
    expect(result.decisions[classification]).toBe(1);
  });

  it.each(multilineSecrets)('redacts bounded multiline %s and counts it (%#)', (classification, value) => {
    expect(redactSessionText(value)).toMatchObject({
      text: `[REDACTED:${classification}]`, decisions: { [classification]: 1 },
    });
  });

  it.each(['password', 'token', 'secret', 'api_key', 'MY_API_TOKEN'])('preserves multiline %s prose and bounds the gap', key => {
    const separator = key === 'MY_API_TOKEN' ? '=' : ':';
    for (const value of ['- description', 'ordinary prose', '123456789012345678901234',
      'abcdefghijklmnopqrstuvwxyz', '```sh\necho fixture\n```', '`unterminated', '"unterminated']) {
      const text = `${key}${separator}\n  ${value}`;
      expect(redactSessionText(text)).toMatchObject({ text, decisions: {} });
    }
    const text = `${key}${separator}\n\n\n${multilineSecretValue}`;
    expect(redactSessionText(text).text).toBe(text);
    expect(redactSessionText('token budget:\nnone').text).toBe('token budget:\nnone');
  });

  it.each(['"', "'", '`'])('accepts short quoted multiline values with %s delimiters', quote => {
    for (const [key, classification] of [['password:', 'credential'], ['MY_API_TOKEN=', 'environment-assignment']]) {
      expect(redactSessionText(`${key}\n  ${quote}fake ${quote === '"' ? '\\"' : ''}value${quote}`))
        .toMatchObject({ text: `[REDACTED:${classification}]`, decisions: { [classification]: 1 } });
    }
  });

  it('preserves a prose fence that needs scanner-policy adjudication', () => {
    // Masked scanner hit: token:<LF><BACKTICK x 3><letters x 10>.
    const text = 'token:\n```typescript\nconst example = true;\n```';
    expect(redactSessionText(text)).toMatchObject({ text, decisions: {} });
    expect(strictScannerPatterns[0].test(text)).toBe(true);
  });

  it.each(['Bearer', 'Authorization:', 'Cookie:', 'Set-Cookie:', 'https://fixture-user:'])
    ('bounds the newline gap for %s', prefix => {
      const text = `${prefix}\n\n\n${multilineSecretValue}${prefix.startsWith('https') ? '@localhost/path' : ''}`;
      expect(redactSessionText(text)).toMatchObject({ text, decisions: {} });
    });

  it('redacts a folded authorization header and a next-line cookie assignment', () => {
    expect(redactSessionText(`Authorization:\r\n\tBearer\r\n  ${multilineSecretValue}`))
      .toMatchObject({ text: '[REDACTED:authorization]', decisions: { authorization: 1, 'bearer-token': 1 } });
    expect(redactSessionText(`Set-Cookie:\n  session=${multilineSecretValue}; Path=/; HttpOnly`))
      .toMatchObject({ text: '[REDACTED:cookie]', decisions: { cookie: 1 } });
  });

  it('retains same-line unterminated quote coverage', () => {
    for (const [key, classification] of [['password=', 'credential'], ['MY_API_TOKEN=', 'environment-assignment']]) {
      expect(redactSessionText(`${key}"${multilineSecretValue}`).text).toBe(`[REDACTED:${classification}]`);
    }
    expect(redactSessionText(`MY_API_TOKEN=${multilineSecretValue}\\"fake-suffix`).text)
      .toBe('[REDACTED:environment-assignment]');
  });

  it('redacts JWTs with large claims and lower-case AWS configuration assignments', () => {
    const jwt = `eyJ${'a'.repeat(12)}.${'b'.repeat(16_384)}.${'c'.repeat(128)}`;
    expect(redactSessionText(jwt + '.').text).toBe('[REDACTED:provider-token].');
    expect(redactSessionText('aws_secret_access_key = FAKE000000000000000000000000000000000000').text)
      .toBe('[REDACTED:environment-assignment]');
    expect(redactSessionText('api_key' + ' '.repeat(4096) + '= FAKE0000000000').text)
      .toBe('[REDACTED:credential]');
  });

  it('preserves ordinary prose, digests, UUIDs and session IDs', () => {
    const text = `The password should remain private. A token represents a word.
${sha256('safe')}
019d0000-0000-7000-8000-000000000101
session_0123456789abcdef`;
    expect(redactSessionText(text)).toMatchObject({ text, classes: [], decisions: {} });
  });

  it('redacts space-separated generated credentials but keeps keyword prose', () => {
    const value = 'FAKE' + '0a1b2c3d4e'.repeat(3);
    for (const keyword of ['token', 'api_key', 'API-KEY', 'secret']) {
      expect(redactSessionText(`${keyword} ${value}`).text).toBe('[REDACTED:credential]');
    }
    const prose = 'token count 123456, a secret ingredient, token budget exceeded, api key rotation';
    expect(redactSessionText(prose)).toMatchObject({ text: prose, classes: [] });
  });

  it('redacts nested keys and arrays without prototype mutation or input mutation', () => {
    const input = { nested: [{ ['redaction-canary-key']: 'redaction-canary-value' }], id: 'session-1' };
    const result = redactSessionValue(input);
    expect(JSON.stringify(result.value)).not.toContain('redaction-canary');
    expect(result.value.id).toBe('session-1');
    expect(input.nested[0]['redaction-canary-key']).toBe('redaction-canary-value');
    expect(result.decisions['fixture-credential']).toBe(2);
    const native = sanitizeNativeExtensions({
      ['redaction-canary-native-key']: { name: 'safe' },
      password: { name: 'otherwise-safe' },
      dataBytes: [70, 65, 75, 69],
    });
    expect(JSON.stringify(native.value)).not.toContain('redaction-canary');
    expect(native.value.password).toBe('[REDACTED:sensitive-field]');
    expect(sanitizeNativeExtensions({ tokenCount: 42 }).value.tokenCount).toBe(42);
    expect(native.value.dataBytes).toBe('[REDACTED:content]');
  });

  it('bounds redaction of a 32 MiB record with malformed key blocks and long near matches', () => {
    const sizes = [16 * 1024 * 1024, 32 * 1024 * 1024];
    const bySize = sizes.map((recordSize) => {
      const benignChunk = 'ordinary session prose without sensitive content.\n';
      const benign = benignChunk.repeat(Math.ceil(recordSize / benignChunk.length)).slice(0, recordSize);
      const chunk = '-----BEGIN PRIVATE KEY-----\n'.repeat(32)
        + 'password' + ' '.repeat(1024) + 'end\n'
        + 'eyJ' + 'a-'.repeat(1024) + '\n'
        + 'a.'.repeat(1024) + '\n';
      const text = chunk.repeat(Math.ceil(recordSize / chunk.length)).slice(0, recordSize);
      // Exercise every regex on a large record as well as the unfinished-key scanner.
      const nearMatch = 'ordinary prose password' + ' '.repeat(1024) + '\neyJ' + 'a-'.repeat(1024) + '\n' + 'a.'.repeat(1024) + '\n';
      const secretSuffix = '\n' + syntheticSecrets[0][1];
      const plain = nearMatch.repeat(Math.ceil(recordSize / nearMatch.length))
        .slice(0, recordSize - secretSuffix.length);
      const plainInput = plain + secretSuffix;
      // Sparse incomplete JWTs isolate repeated suffix searches from the
      // expensive but linear whitespace and email near matches above.
      const jwtChunk = 'eyJaaaaa\n' + '~'.repeat(4096);
      const jwtInput = jwtChunk.repeat(Math.ceil(recordSize / jwtChunk.length)).slice(0, recordSize);
      return [
        { recordSize, name: 'benign', input: benign, expected: benign, samples: [] as number[] },
        { recordSize, name: 'malformed key blocks', input: text, expected: '[REDACTED:private-key]', samples: [] as number[] },
        { recordSize, name: 'JWT suffix near matches', input: jwtInput, expected: jwtInput, samples: [] as number[] },
        { recordSize, name: 'near matches', input: plainInput, expected: plain + '\n[REDACTED:provider-token]', samples: [] as number[] },
      ];
    });

    // Keep each size pair adjacent so unrelated slow paths cannot separate
    // the measurements used by a growth ratio.
    const cases = bySize[0].flatMap((entry, index) => entry.name === 'JWT suffix near matches'
      ? bySize.map((entries) => entries[index]) : [bySize[1][index]]);

    // Warm every full-size path before sampling: first-use JIT and string
    // flattening costs must not skew either side of the ratio.
    for (const entry of cases) expect(redactSessionText(entry.input).text).toBe(entry.expected);

    // Thread CPU excludes scheduler waits. Batch for >=250 ms of CPU so a
    // short lucky/unlucky run cannot dominate, then normalize by operation count.
    // Keep pairs adjacent and alternate order to limit drift under shared load.
    for (let sample = 0; sample < 7; sample++) {
      const order = sample % 2 === 0 ? cases : [...cases].reverse();
      for (const entry of order) {
        const batch = measureThreadCpuBatch(() => redactSessionText(entry.input));
        entry.samples.push(batch.cpuMs / batch.operations);
        expect(batch.value.text).toBe(entry.expected);
      }
    }

    // Doubling linear work should cost about 2x; quadratic suffix rescans
    // approach 4x. Check growth before the coarser ratio-to-baseline cap.
    // A median of paired ratios rejects isolated contention. Independent minima
    // can compare different host conditions; a ratio of medians also loses pairing.
    const maxGrowth = 3;
    for (const small of cases.filter((entry) => entry.recordSize === sizes[0])) {
      const large = cases.find((entry) => entry.recordSize === sizes[1] && entry.name === small.name)!;
      expect(medianPairedRatio(large.samples, small.samples), `${small.name} CPU growth (32 / 16 MiB)`)
        .toBeLessThan(maxGrowth);
    }
    const maxSlowdown = 20;
    for (const recordSize of sizes.slice(1)) {
      const sameSize = cases.filter((entry) => entry.recordSize === recordSize);
      for (const entry of sameSize.slice(1)) {
        expect(medianPairedRatio(entry.samples, sameSize[0].samples), `${entry.name} / benign baseline (${recordSize / 1024 / 1024} MiB)`)
          .toBeLessThan(maxSlowdown);
      }
    }
  }, 120_000); // Hang guard only; performance is bounded by CPU growth and baseline ratios.

  it('requires operation-specific network consent', () => {
    expect(() => requireNetworkConsent('codex.export', 'claude.export')).toThrowError(
      expect.objectContaining<Partial<SessionContractError>>({ code: 'NETWORK_NOT_AUTHORIZED' }),
    );
    expect(() => requireNetworkConsent('codex.export', 'codex.export')).not.toThrow();
  });

  it('prefilters workspace and provider authorization before ranking', () => {
    const visible = prefilterAuthorizedSearchScope([
      { workspaceId: 'one', provider: 'claude', score: 1 },
      { workspaceId: 'two', provider: 'claude', score: 100 },
      { workspaceId: 'one', provider: 'codex', score: 50 },
    ], { workspaceId: 'one', providers: ['claude'] });
    expect(visible).toEqual([{ workspaceId: 'one', provider: 'claude', score: 1 }]);
  });
});
