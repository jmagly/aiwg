import { mkdtemp } from '../../helpers/temp-dir.js';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  SessionSourceAdapterRegistry,
  fingerprintSourceFile,
  readBoundedJsonLines,
  streamBoundedJsonLines,
  redactSourceLocator,
  type SessionSourceAdapter,
} from '../../../src/sessions/index.js';

const execFileAsync = promisify(execFile);

function fixtureAdapter(overrides: Partial<SessionSourceAdapter> = {}): SessionSourceAdapter {
  return {
    provider: 'generic',
    adapterVersion: '1.2.3',
    disposition: 'implemented',
    supportedOperations: ['discover', 'inspect', 'stream'],
    acquisitionModes: ['manual-export', 'jsonl'],
    async *discover(scope) {
      for (const root of scope.allowedRoots) {
        yield { provider: 'generic', locator: join(root, 'session.jsonl'), locatorClass: 'authorized-root' };
      }
    },
    async inspect() {
      return { sourceSchemaVersion: '1.0.0', consistency: 'complete', operationalState: 'available' };
    },
    async *stream() {},
    ...overrides,
  };
}

describe('session source adapter registry', () => {
  it('discovers only within explicitly authorized roots', async () => {
    const registry = new SessionSourceAdapterRegistry();
    registry.register(fixtureAdapter());
    await expect(collect(registry.discover('generic', {
      workspaceId: 'workspace-1', allowedRoots: [],
    }))).rejects.toMatchObject({ code: 'SOURCE_NOT_AUTHORIZED' });
    await expect(collect(registry.discover('generic', {
      workspaceId: 'workspace-1', allowedRoots: ['/explicit/root'],
    }))).resolves.toEqual([{
      provider: 'generic',
      locator: '/explicit/root/session.jsonl',
      locatorClass: 'authorized-root',
    }]);
  });

  it('represents explicitly authorized account discovery without a filesystem root', async () => {
    const registry = new SessionSourceAdapterRegistry();
    registry.register(fixtureAdapter({
      acquisitionModes: ['api'],
      async *discover(scope) {
        for (const account of scope.authorizedAccounts ?? []) {
          yield { provider: 'generic', locator: account, locatorClass: 'authorized-account' };
        }
      },
    }));
    await expect(collect(registry.discover('generic', {
      workspaceId: 'workspace-1', allowedRoots: [], authorizedAccounts: ['account-1'],
    }))).resolves.toEqual([{
      provider: 'generic', locator: 'account-1', locatorClass: 'authorized-account',
    }]);
  });

  it('rejects unsupported operations before invoking an adapter', () => {
    const discover = vi.fn();
    const registry = new SessionSourceAdapterRegistry();
    registry.register(fixtureAdapter({
      supportedOperations: ['inspect'],
      async *discover() { discover(); },
    }));
    expect(() => registry.assertOperation('generic', 'discover'))
      .toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_OPERATION' }));
    expect(discover).not.toHaveBeenCalled();
  });

  it('reports independent classification, state, evidence, modes, and remediation', () => {
    const registry = new SessionSourceAdapterRegistry();
    registry.register(fixtureAdapter());
    expect(registry.report('generic', {
      state: 'unavailable',
      evidence: { adapterVersion: '1.2.3', verifiedAt: '2026-07-26', reference: 'fixture-contract' },
      reason: 'manual export not selected',
      remediation: 'select an exported JSONL file',
    })).toMatchObject({
      provider: 'generic',
      classification: 'implemented',
      state: 'unavailable',
      supportedOperations: ['discover', 'inspect', 'stream'],
      acquisitionModes: ['manual-export', 'jsonl'],
      reason: 'manual export not selected',
    });
  });

  it('redacts normal diagnostic locators', () => {
    const redacted = redactSourceLocator('/Users/operator/secret-workspace/session 1.jsonl');
    expect(redacted).toBe('<session-source>/session_1.jsonl');
    expect(redacted).not.toContain('operator');
  });
});

describe('bounded session readers', () => {
  it('reads complete JSONL records with stable byte cursors and fingerprints', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-reader-'));
    const path = join(root, 'session.jsonl');
    await writeFile(path, '{"id":1}\n{"id":2}\n');
    const authorization = { selectedPath: path, allowedRoots: [root], maxBytes: 1024 };
    const result = await readBoundedJsonLines(authorization, { consistency: 'complete' });
    expect(result.records.map((record) => record.value)).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.nextCursor).toBe('18');
    expect(result.incompleteTail).toBe(false);
    await expect(fingerprintSourceFile(authorization)).resolves.toMatchObject({
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      size: 18,
    });
  });

  it('pulls records on demand and stops source consumption on cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-reader-stream-'));
    const path = join(root, 'large.jsonl');
    await writeFile(path, Array.from(
      { length: 10_000 },
      (_, index) => JSON.stringify({ id: index }),
    ).join('\n') + '\n');
    const stream = await streamBoundedJsonLines(
      { selectedPath: path, allowedRoots: [root] },
      { consistency: 'complete' },
    );
    expect(stream.recordsRead).toBe(0);
    expect(stream.bytesRead).toBe(0);
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { value: { id: 0 }, sequence: 0 },
    });
    expect(stream.recordsRead).toBe(1);
    expect(stream.bytesRead).toBeGreaterThan(0);
    await iterator.return?.();
    expect(stream.recordsRead).toBe(1);
  });

  it('streams one million records with source-size-independent retained memory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-reader-million-'));
    const path = join(root, 'million.jsonl');
    await writeFile(path, '{"ok":1}\n'.repeat(1_000_000));
    const probe = fileURLToPath(new URL('../../fixtures/sessions/reader-retained-memory.ts', import.meta.url));
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--expose-gc', '--import', 'tsx', probe, path, root],
      { timeout: 20_000, maxBuffer: 64 * 1024 },
    );
    const result = JSON.parse(stdout) as {
      count: number;
      recordsRead: number;
      first: unknown;
      last: unknown;
      retainedPeakGrowthBytes: number;
    };
    expect(result).toMatchObject({
      count: 1_000_000,
      recordsRead: 1_000_000,
      first: { ok: 1 },
      last: { ok: 1 },
    });
    expect(result.retainedPeakGrowthBytes).toBeLessThan(32 * 1024 * 1024);
  }, 30_000);

  it('ignores an incomplete active tail without advancing past it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-reader-tail-'));
    const path = join(root, 'active.jsonl');
    await writeFile(path, '{"id":1}\n{"id":');
    const result = await readBoundedJsonLines(
      { selectedPath: path, allowedRoots: [root] },
      { consistency: 'provisional' },
    );
    expect(result.records).toHaveLength(1);
    expect(result.nextCursor).toBe('9');
    expect(result.incompleteTail).toBe(true);
  });

  it('fails closed for malformed snapshots and resource violations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-reader-invalid-'));
    const path = join(root, 'invalid.jsonl');
    await writeFile(path, '{"nested":{"too":{"deep":true}}}\n');
    await expect(readBoundedJsonLines(
      { selectedPath: path, allowedRoots: [root] },
      { consistency: 'complete', limits: { maxNestingDepth: 1 } },
    )).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
    await writeFile(path, '{"broken":\n');
    await expect(readBoundedJsonLines(
      { selectedPath: path, allowedRoots: [root] },
      { consistency: 'complete' },
    )).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
  });

  it('does not leak source paths through authorization errors', async () => {
    const secretPath = '/private/operator/session-secret.jsonl';
    await expect(readBoundedJsonLines(
      { selectedPath: secretPath, allowedRoots: ['/private/operator'] },
      { consistency: 'complete' },
    )).rejects.toSatisfy((error: Error) => !error.message.includes(secretPath));
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
