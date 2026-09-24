import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SESSION_PROVIDER_IDS,
  SessionContractError,
  SessionEventSchema,
  assertSessionProviderId,
  assertSupportedSchemaMajor,
  authorizeSourceFile,
  DeletionReceiptSchema,
  defineSessionAdapterFixture,
  redactSessionText,
  sanitizeNativeExtensions,
  requireNetworkConsent,
  prefilterAuthorizedSearchScope,
  sha256,
} from '../../../src/sessions/index.js';

describe('session contracts', () => {
  it('asserts exactly 17 canonical provider IDs with documented compatibility aliases', () => {
    expect(SESSION_PROVIDER_IDS).toEqual([
      'claude', 'codex', 'copilot', 'cursor', 'factory', 'hermes',
      'opencode', 'openclaw', 'openhuman', 'grokbot', 'pi', 'omp', 'deepseek-harness', 'warp', 'devin-desktop', 'muse', 'generic',
    ]);
    expect(assertSessionProviderId('windsurf')).toBe('devin-desktop');
    expect(assertSessionProviderId('dsh')).toBe('deepseek-harness');
    expect(() => assertSessionProviderId('factory-ai')).toThrowError(
      expect.objectContaining({ code: 'UNKNOWN_PROVIDER' }),
    );
  });

  it('fails closed on unknown schema majors but preserves unknown event kinds', () => {
    expect(() => assertSupportedSchemaMajor('2.0.0')).toThrowError(
      expect.objectContaining({ code: 'UNKNOWN_SCHEMA_MAJOR' }),
    );
    const event = SessionEventSchema.parse({
      contractVersion: '1.0.0',
      eventId: 'event-1', sessionId: 'session-1', sourceId: 'source-1',
      importRunId: 'run-1', nativeId: null, sequence: 0,
      kind: 'provider.future-event', role: null, occurredAt: null,
      searchableText: '', digest: sha256('future'),
      rawReference: { locatorClass: 'fixture', sequence: 0 },
      adapterVersion: '1.0.0', consistency: 'complete',
      sensitivity: { classification: 'none', classes: [] }, opaque: true,
      extensions: { 'native.claude': { future: true } },
    });
    expect(event.opaque).toBe(true);
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
