import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MemoryIntakeCoordinator } from '../../../src/memory/intake.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aiwg-memory-intake-'));
  mkdirSync(join(root, 'sources'), { recursive: true });
  writeFileSync(join(root, 'sources/decision.md'), '# Decision\n\nSQLite is authoritative.\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('compound-memory intake', () => {
  it('rejects bytes changed after confirmation preview and emits no receipt', () => {
    const sourcePath = join(root, 'sources/decision.md');
    const original = readFileSync(sourcePath);
    const digest = createHash('sha256').update(original).digest('hex');
    const rawPath = join(root, '.aiwg/wiki/raw', `${digest.slice(0, 16)}-decision.md`);
    const coordinator = new MemoryIntakeCoordinator(root);
    const approved = coordinator.preview('sources/decision.md');
    const realPreview = coordinator.preview.bind(coordinator);
    const changed = Buffer.from('owned source changed after preview');
    const preview = vi.spyOn(coordinator, 'preview').mockImplementation(requested => {
      const current = realPreview(requested);
      writeFileSync(sourcePath, changed);
      return current;
    });
    try {
      expect(() => coordinator.confirm('sources/decision.md', approved.operationId))
        .toThrow('immutable raw copy digest does not match the source preview');
      expect(preview.mock.calls).toEqual([['sources/decision.md']]);
      expect(readFileSync(rawPath)).toEqual(changed);
      expect(readFileSync(sourcePath)).toEqual(changed);
      expect(createHash('sha256').update(readFileSync(rawPath)).digest('hex')).not.toBe(digest);
      expect(existsSync(join(root, '.aiwg/memory/compound-memory/intake-receipts'))).toBe(false);
    } finally {
      preview.mockRestore();
    }
  });

  it.each([
    ['jsonl', 'session-transcript', 'sessions'], ['transcript', 'session-transcript', 'sessions'],
    ['png', 'image', 'llm-wiki'], ['jpg', 'image', 'llm-wiki'], ['jpeg', 'image', 'llm-wiki'],
    ['gif', 'image', 'llm-wiki'], ['webp', 'image', 'llm-wiki'], ['svg', 'image', 'llm-wiki'],
    ['pdf', 'pdf', 'llm-wiki'], ['yaml', 'structured', 'llm-wiki'], ['yml', 'structured', 'llm-wiki'],
    ['json', 'structured', 'llm-wiki'], ['md', 'document', 'llm-wiki'], ['txt', 'document', 'llm-wiki'],
    ['html', 'document', 'llm-wiki'], ['htm', 'document', 'llm-wiki'],
    ['JSONL', 'session-transcript', 'sessions'], ['PNG', 'image', 'llm-wiki'],
    ['PDF', 'pdf', 'llm-wiki'], ['JSON', 'structured', 'llm-wiki'], ['MD', 'document', 'llm-wiki'],
    ['unknown', 'artifact', 'llm-wiki'], ['', 'artifact', 'llm-wiki'],
  ])('classifies extension %s as %s routed to %s', (extension, kind, route) => {
    const locator = `sources/fixture${extension ? `.${extension}` : ''}`;
    const bytes = Buffer.from('inert UTF-8 fixture: café');
    writeFileSync(join(root, locator), bytes);
    const preview = new MemoryIntakeCoordinator(root).preview(locator);
    expect(preview.source).toEqual({ locator, kind, byteLength: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
    expect(preview.route).toBe(route);
    expect(existsSync(join(root, '.aiwg'))).toBe(false);
    expect(readFileSync(join(root, locator))).toEqual(bytes);
  });

  it('sanitizes a raw basename without altering the source locator or bytes', () => {
    const locator = 'sources/design notes (révision).md';
    const bytes = Buffer.from('Résumé — inert fixture');
    writeFileSync(join(root, locator), bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const preview = new MemoryIntakeCoordinator(root).preview(locator);
    expect(preview.source).toEqual({ locator, kind: 'document', byteLength: bytes.length, digest: `sha256:${digest}` });
    expect(preview.rawLocator).toBe(`.aiwg/wiki/raw/${digest.slice(0, 16)}-design-notes-r-vision-.md`);
    expect(readFileSync(join(root, locator))).toEqual(bytes);
    expect(existsSync(join(root, '.aiwg'))).toBe(false);
  });

  it('preserves conflicting raw bytes and emits no receipt', () => {
    const source = readFileSync(join(root, 'sources/decision.md'));
    const prefix = createHash('sha256').update(source).digest('hex').slice(0, 16);
    const rawPath = join(root, '.aiwg/wiki/raw', `${prefix}-decision.md`);
    mkdirSync(dirname(rawPath), { recursive: true });
    writeFileSync(rawPath, 'preexisting conflicting fixture');
    const coordinator = new MemoryIntakeCoordinator(root);
    const preview = coordinator.preview('sources/decision.md');
    expect(preview.duplicate).toBe(false);
    expect(preview.mutation.wouldCopyRaw).toBe(true);
    expect(() => coordinator.confirm('sources/decision.md', preview.operationId)).toThrow(/EEXIST/);
    expect(readFileSync(rawPath, 'utf8')).toBe('preexisting conflicting fixture');
    expect(readFileSync(join(root, 'sources/decision.md'))).toEqual(source);
    expect(existsSync(join(root, '.aiwg/memory/compound-memory/intake-receipts'))).toBe(false);
  });

  it('reuses an identical raw copy without a preexisting receipt', () => {
    const source = readFileSync(join(root, 'sources/decision.md'));
    const digest = createHash('sha256').update(source).digest('hex');
    const rawLocator = `.aiwg/wiki/raw/${digest.slice(0, 16)}-decision.md`;
    mkdirSync(dirname(join(root, rawLocator)), { recursive: true });
    writeFileSync(join(root, rawLocator), source);
    const coordinator = new MemoryIntakeCoordinator(root);
    const preview = coordinator.preview('sources/decision.md');
    expect(preview).toMatchObject({ duplicate: true, rawLocator, mutation: { wouldCopyRaw: false } });
    const receiptRoot = join(root, '.aiwg/memory/compound-memory/intake-receipts');
    expect(existsSync(receiptRoot)).toBe(false);
    const receipt = coordinator.confirm('sources/decision.md', preview.operationId);
    expect(receipt).toMatchObject({ duplicate: true, rawLocator, sourceDigest: `sha256:${digest}` });
    expect(JSON.parse(readFileSync(join(receiptRoot, `${preview.operationId.replace(':', '_')}.json`), 'utf8'))).toEqual(receipt);
    expect(readFileSync(join(root, rawLocator))).toEqual(source);
    expect(readFileSync(join(root, 'sources/decision.md'))).toEqual(source);
  });

  it.each(['absolute', 'symlink'])('rejects an outside source via %s without creating output', mode => {
    const outside = mkdtempSync(join(tmpdir(), 'aiwg-intake-outside-fixture-'));
    try {
      const source = join(outside, 'inert.md');
      writeFileSync(source, 'owned inert fixture');
      const requested = mode === 'absolute' ? source : 'sources/outside.md';
      if (mode === 'symlink') symlinkSync(source, join(root, requested));
      const coordinator = new MemoryIntakeCoordinator(root);
      expect(() => coordinator.preview(requested)).toThrow('intake source must resolve inside the project');
      expect(() => coordinator.confirm(requested, 'unconfirmed')).toThrow('intake source must resolve inside the project');
      expect(existsSync(join(root, '.aiwg'))).toBe(false);
      expect(readFileSync(source, 'utf8')).toBe('owned inert fixture');
      expect(readdirSync(outside)).toEqual(['inert.md']);
    } finally {
      rmSync(outside, { recursive: true, force: true });
      expect(existsSync(outside)).toBe(false);
    }
  });

  it.each(['.env', '.ssh/config', 'credentials.json', 'secrets/key.txt', 'tokens.txt'])('rejects protected-name fixture %s', requested => {
    const source = join(root, requested);
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, 'owned inert fixture, not a credential');
    const coordinator = new MemoryIntakeCoordinator(root);
    expect(() => coordinator.preview(requested)).toThrow('protected paths cannot be ingested into ordinary project memory');
    expect(existsSync(join(root, '.aiwg'))).toBe(false);
    expect(readFileSync(source, 'utf8')).toBe('owned inert fixture, not a credential');
  });

  it('rejects a directory source without mutation', () => {
    expect(() => new MemoryIntakeCoordinator(root).preview('sources')).toThrow('intake source must be a regular file');
    expect(readdirSync(join(root, 'sources'))).toEqual(['decision.md']);
    expect(existsSync(join(root, '.aiwg'))).toBe(false);
  });

  it.each(['.aiwg/wiki/raw', '.aiwg/memory/compound-memory/intake-receipts'])('rejects existing outside storage link at %s', storage => {
    const outside = mkdtempSync(join(tmpdir(), 'aiwg-intake-storage-fixture-'));
    try {
      writeFileSync(join(outside, 'sentinel'), 'preserve external fixture');
      const target = join(root, storage);
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(outside, target, 'dir');
      expect(() => new MemoryIntakeCoordinator(root)).toThrow('intake storage cannot traverse a link outside the project');
      expect(readdirSync(outside)).toEqual(['sentinel']);
      expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('preserve external fixture');
    } finally {
      rmSync(outside, { recursive: true, force: true });
      expect(existsSync(outside)).toBe(false);
    }
  });

  it('previews without mutation and preserves an immutable digest-addressed raw copy', () => {
    const coordinator = new MemoryIntakeCoordinator(root);
    const original = readFileSync(join(root, 'sources/decision.md'), 'utf8');
    const digest = `sha256:${createHash('sha256').update(original).digest('hex')}`;
    const rawLocator = `.aiwg/wiki/raw/${digest.slice(7, 23)}-decision.md`;
    const identity = {
      source: { locator: 'sources/decision.md', digest, byteLength: Buffer.byteLength(original), kind: 'document' },
      rawLocator,
      route: 'llm-wiki',
    };
    const operationId = `sha256:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
    const preview = coordinator.preview('sources/decision.md');
    expect(preview).toEqual({
      schemaVersion: 'aiwg.compound-memory.intake-preview.v1',
      operationId,
      ...identity,
      duplicate: false,
      confirmationRequired: true,
      mutation: { wouldCopyRaw: true, wouldPromoteKnowledge: false },
    });
    expect(existsSync(join(root, '.aiwg'))).toBe(false);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-10T12:34:56.789Z'));
      const expected = {
        schemaVersion: 'aiwg.compound-memory.intake-receipt.v1',
        receiptId: `sha256:${createHash('sha256').update(`${operationId}\0${rawLocator}`).digest('hex')}`,
        operationId,
        sourceLocator: 'sources/decision.md',
        sourceDigest: digest,
        rawLocator,
        route: 'llm-wiki',
        duplicate: false,
        registeredAt: '2026-09-10T12:34:56.789Z',
      };
      const receipt = coordinator.confirm('sources/decision.md', operationId);
      expect(receipt).toEqual(expected);
      const receiptPath = join(root, '.aiwg/memory/compound-memory/intake-receipts', `${operationId.replace(':', '_')}.json`);
      const persisted = readFileSync(receiptPath, 'utf8');
      expect(JSON.parse(persisted)).toEqual(expected);
      expect(readFileSync(join(root, rawLocator), 'utf8')).toBe(original);
      expect(readFileSync(join(root, 'sources/decision.md'), 'utf8')).toBe(original);
      vi.setSystemTime(new Date('2026-09-10T12:35:00.000Z'));
      expect(new MemoryIntakeCoordinator(root).confirm('sources/decision.md', operationId)).toEqual({ ...expected, duplicate: true });
      expect(readFileSync(receiptPath, 'utf8')).toBe(persisted);
      expect(coordinator.preview('sources/decision.md')).toEqual({ ...preview, duplicate: true, mutation: { wouldCopyRaw: false, wouldPromoteKnowledge: false } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('routes transcript formats to sessions and rejects changed-source confirmation', () => {
    writeFileSync(join(root, 'sources/session.jsonl'), '{"role":"user","text":"Decision: keep receipts"}\n');
    const coordinator = new MemoryIntakeCoordinator(root);
    expect(coordinator.preview('sources/session.jsonl').route).toBe('sessions');
    const preview = coordinator.preview('sources/decision.md');
    writeFileSync(join(root, 'sources/decision.md'), '# Changed\n');
    expect(() => coordinator.confirm('sources/decision.md', preview.operationId))
      .toThrow(/exact current preview/);
  });
});
