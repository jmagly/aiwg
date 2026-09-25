import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const transportFixture = vi.hoisted(() => ({ compressedBomb: false }));

vi.mock('node:https', async () => {
  const { EventEmitter } = await import('node:events');
  const { Readable } = await import('node:stream');
  const { gzipSync } = await import('node:zlib');
  const request = vi.fn((_url: URL, _options: unknown, onResponse: (incoming: unknown) => void) => {
    const outgoing = new EventEmitter() as EventEmitter & { end: (body: string) => void; destroy: (error?: Error) => void };
    outgoing.end = (_body: string) => {
      const body = JSON.stringify({ model: 'jev-1.13.0', answers: { category: { type: 'choice', choice: 'documentation',
        confidence: 0.9, probabilities: { documentation: 0.9, runtime: 0.1, other: 0 } } }, usage: {} });
      const encoded = transportFixture.compressedBomb ? gzipSync(Buffer.alloc(1024 * 1024 + 1, 0x78)) : Buffer.from(body);
      const incoming = Readable.from([encoded]) as Readable & {
        statusCode: number; headers: Record<string, string>; rawHeaders: string[];
      };
      incoming.statusCode = 200;
      incoming.headers = { 'content-type': 'application/json', ...(transportFixture.compressedBomb ? { 'content-encoding': 'gzip' } : {}) };
      incoming.rawHeaders = ['content-type', 'application/json', 'x-typesafe-request-id', 'pinned-request',
        ...(transportFixture.compressedBomb ? ['content-encoding', 'gzip'] : [])];
      onResponse(incoming);
      outgoing.emit('close');
    };
    outgoing.destroy = (error?: Error) => { if (error) outgoing.emit('error', error); };
    return outgoing;
  });
  return { request };
});

import { request as httpsRequest } from 'node:https';
import { JevDecisionAdapter, type DecisionBinding, type DecisionDefinition } from '../../../src/decision/index.js';

const fixture = <T>(name: string): T => JSON.parse(readFileSync(`agentic/code/addons/decision-engine/examples/${name}`, 'utf8')) as T;

describe('pinned HTTPS transport', () => {
  it('SEC-DNS-PIN: connects only to the vetted address while TLS verifies the approved hostname', async () => {
    const addresses = ['93.184.216.34', '127.0.0.1'];
    const resolver = vi.fn(async () => [addresses.shift()!]);
    const adapter = new JevDecisionAdapter({ endpoint: 'https://custom.example/v1/systemone',
      allowedOrigins: ['https://custom.example'], resolveAddresses: resolver });
    const result = await adapter.evaluate({
      alias: 'category', definition: fixture<DecisionDefinition>('decision-category.json'), input: fixture('input.json'),
      target: fixture<DecisionBinding>('binding-jev.json').spec.evaluations.category!.targets[0]!,
      invocationId: 'pinned-test', deadlineEpochMs: Date.now() + 10_000, signal: new AbortController().signal,
      resolveCredential: async () => new TextEncoder().encode('synthetic-token'),
    });
    expect(result).toMatchObject({ status: 'success', requestId: 'pinned-request' });
    expect(resolver).toHaveBeenCalledTimes(1);
    const [url, options] = vi.mocked(httpsRequest).mock.calls[0]!;
    expect((url as URL).hostname).toBe('custom.example');
    expect(options).toMatchObject({ servername: 'custom.example', rejectUnauthorized: true, agent: false });
    const lookup = (options as { lookup: (host: string, options: unknown, callback: (error: Error | null, address: string, family: number) => void) => void }).lookup;
    const callback = vi.fn();
    lookup('custom.example', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    expect(addresses).toEqual(['127.0.0.1']);
    const mismatch = vi.fn();
    lookup('other.example', {}, mismatch);
    expect(mismatch.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it('SEC-COMPRESSED-BOUND: rejects a small gzip response that expands beyond the decoded limit', async () => {
    transportFixture.compressedBomb = true;
    try {
      const adapter = new JevDecisionAdapter({ endpoint: 'https://custom.example/v1/systemone',
        allowedOrigins: ['https://custom.example'], resolveAddresses: async () => ['93.184.216.34'] });
      const result = await adapter.evaluate({
        alias: 'category', definition: fixture<DecisionDefinition>('decision-category.json'), input: fixture('input.json'),
        target: fixture<DecisionBinding>('binding-jev.json').spec.evaluations.category!.targets[0]!,
        invocationId: 'compressed-test', deadlineEpochMs: Date.now() + 10_000, signal: new AbortController().signal,
        resolveCredential: async () => new TextEncoder().encode('synthetic-token'),
      });
      expect(result).toMatchObject({ reason: 'invalid-output', requestId: 'pinned-request' });
    } finally { transportFixture.compressedBomb = false; }
  });
});
