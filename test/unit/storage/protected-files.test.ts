import { chmod, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import * as shared from '../../../src/storage/protected-files.js';
import * as protection from '../../../src/decision/batch-receipts/protection.js';
import { BatchReceiptValidationError } from '../../../src/decision/batch-receipts/validate.js';

const KEY = Buffer.alloc(32, 9);
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true }))); });

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'aiwg-protected-files-'));
  temporary.push(directory);
  return directory;
}

describe('shared protected-file primitives (#2716)', () => {
  it('does not import from src/decision', () => {
    const source = readFileSync(new URL('../../../src/storage/protected-files.ts', import.meta.url), 'utf8');
    const specifiers = [...source.matchAll(/\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((specifier) => /(^|\/)decision(\/|$)/.test(specifier))).toEqual([]);
  });

  it('keeps the batch-receipt re-exports bound to the shared implementations', () => {
    for (const name of ['exists', 'keyedName', 'macFor', 'macMatches', 'publishExclusive', 'requireIntegrityKey', 'serialized', 'syncDirectory'] as const) {
      expect(protection[name]).toBe(shared[name]);
    }
  });

  it('produces the golden keyed names, MACs and canonical bytes', () => {
    expect(shared.keyedName(KEY, 'dom', ['a', 'b'])).toBe('9af99695b937b6d11e60fcfd3a9d87712db547f0f541e1cea176e68e83639102');
    expect(shared.macFor(KEY, 'dom', { b: 1, a: [2] })).toBe('ff7e91c889be2c4b42ec691997d19eb6dea63597ea06836d5aad4f802a1cac58');
    expect(shared.macMatches(KEY, 'dom', { a: [2], b: 1 }, 'ff7e91c889be2c4b42ec691997d19eb6dea63597ea06836d5aad4f802a1cac58')).toBe(true);
    expect(shared.macMatches(KEY, 'dom', { a: [3], b: 1 }, 'ff7e91c889be2c4b42ec691997d19eb6dea63597ea06836d5aad4f802a1cac58')).toBe(false);
    expect(shared.serialized({ b: 1, a: 'é' })).toBe('{"a":"é","b":1}\n');
    expect(() => shared.requireIntegrityKey(Buffer.alloc(31), 'Test')).toThrow('Test integrity key must be at least 32 bytes');
  });

  it('writes the golden batch tombstone bytes through the shared publisher', async () => {
    const directory = await scratch();
    const path = join(directory, 'tombstone');
    await protection.writeTombstone(directory, path, { surface: 'receipt', id: 'r1' } as never, 123);
    await protection.writeTombstone(directory, path, { surface: 'receipt', id: 'other' } as never, 456);
    expect(await readFile(path, 'utf8'))
      .toBe('{"deletedAtEpochMs":123,"reference":{"id":"r1","surface":"receipt"},"version":"decision-batch-tombstone/v1"}\n');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(['tombstone']);
  });

  it('publishes exclusively and reports an existing destination', async () => {
    const directory = await scratch();
    const destination = join(directory, 'record');
    expect(await shared.publishExclusive(directory, destination, 'first\n', 'test')).toBe(true);
    expect(await shared.publishExclusive(directory, destination, 'second\n', 'test')).toBe(false);
    expect(await readFile(destination, 'utf8')).toBe('first\n');
    expect(await shared.exists(destination)).toBe(true);
    expect(await shared.exists(join(directory, 'missing'))).toBe(false);
  });

  it('refuses non-canonical bytes with the caller error class', () => {
    expect(shared.parseCanonical('{"a":1}\n')).toEqual({ a: 1 });
    expect(() => shared.parseCanonical('{"a": 1}\n')).toThrow(shared.ProtectedFileIntegrityError);
    class CustomError extends Error {}
    expect(() => shared.parseCanonical('{"b":1,"a":2}\n', () => new CustomError('x'))).toThrow(CustomError);
    expect(() => protection.parseCanonical('{"a": 1}\n')).toThrow(protection.BatchStoreIntegrityError);
    expect(() => protection.parseCanonical('{"a": 1}\n')).toThrow('Batch store integrity check failed');
  });

  it('requires owner-only directories with the caller error class', async () => {
    const directory = join(await scratch(), 'private');
    await shared.ensurePrivateDirectory(directory, 'unsafe');
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    await chmod(directory, 0o750);
    await expect(shared.ensurePrivateDirectory(directory, 'unsafe')).rejects.toThrow('unsafe');
    await expect(protection.ensurePrivateDirectory(directory, 'batch directory is unsafe'))
      .rejects.toThrow(BatchReceiptValidationError);
    await expect(protection.ensurePrivateDirectory(directory, 'batch directory is unsafe'))
      .rejects.toThrow('batch directory is unsafe');
  });
});
