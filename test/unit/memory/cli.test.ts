/**
 * Tests for src/memory/cli.ts
 *
 * @issue #934
 * @issue #966
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import { initStorage, resetStorage } from '../../../src/storage/index.js';
import { main } from '../../../src/memory/cli.js';

describe('memory CLI (#966)', () => {
  let projectRoot: string;
  let memoryRoot: string;
  let stdout: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'aiwg-memory-cli-test-'));
    vi.spyOn(process, 'cwd').mockReturnValue(projectRoot);
    for (const name of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR']) vi.stubEnv(name, undefined);
    vi.stubEnv('AIWG_PROJECT_MEMORY_HOME', join(projectRoot, 'registry'));
    memoryRoot = join(projectRoot, '.aiwg', 'memory');
    resetStorage();
    await initStorage(projectRoot);

    stdout = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      stdout.push(args.map((a) => String(a)).join(' '));
    });
  });

  afterEach(async () => {
    logSpy.mockRestore();
    resetStorage();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(projectRoot, { recursive: true, force: true });
  });

  describe('path', () => {
    it('reports a non-filesystem backend without resolving or contacting it', async () => {
      await mkdir(join(projectRoot, '.aiwg'), { recursive: true });
      await writeFile(join(projectRoot, '.aiwg/storage.config'), JSON.stringify({ version: '1', backends: { memory: { type: 'fortemi' } } }));
      resetStorage();
      await main(['path', '--json']);
      expect(JSON.parse(stdout[0])).toEqual({ backend: 'fortemi', note: 'memory subsystem uses backend "fortemi" — physical filesystem path is not applicable. Use `aiwg memory get/list` instead.' });
    });
    it('prints the resolved memory root for the default fs backend', async () => {
      await main(['path']);
      expect(stdout).toEqual([memoryRoot]);
    });

    it('prints subpath when given', async () => {
      await main(['path', 'research-complete/index.md']);
      expect(stdout).toEqual([join(memoryRoot, 'research-complete/index.md')]);
    });

    it('--json outputs structured data', async () => {
      await main(['path', '--json']);
      const parsed = JSON.parse(stdout.join('\n'));
      expect(parsed).toEqual({ backend: 'fs', root: memoryRoot, path: memoryRoot });
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      await mkdir(join(memoryRoot, 'research-complete'), { recursive: true });
      await mkdir(join(memoryRoot, 'sdlc-complete'), { recursive: true });
      await writeFile(join(memoryRoot, 'research-complete/index.md'), 'r-index', 'utf-8');
      await writeFile(join(memoryRoot, 'research-complete/notes.md'), 'r-notes', 'utf-8');
      await writeFile(join(memoryRoot, 'sdlc-complete/log.jsonl'), '{"op":"ingest"}\n', 'utf-8');
    });

    it('lists all entries when no prefix', async () => {
      await main(['list']);
      const out = stdout.join('\n');
      expect(out).toContain('research-complete/index.md');
      expect(out).toContain('research-complete/notes.md');
      expect(out).toContain('sdlc-complete/log.jsonl');
    });

    it('filters by --prefix', async () => {
      await main(['list', '--prefix', 'research-complete/']);
      const out = stdout.join('\n');
      expect(out).toContain('research-complete/index.md');
      expect(out).not.toContain('sdlc-complete/log.jsonl');
    });

    it('reports empty result gracefully', async () => {
      await main(['list', '--prefix', 'nonexistent/']);
      expect(stdout.join(' ')).toMatch(/No memory entries/);
    });

    it('--json outputs an array', async () => {
      await main(['list', '--json']);
      const parsed = JSON.parse(stdout.join('\n'));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(3);
    });
  });

  describe('get / delete', () => {
    it('get reads via the storage adapter', async () => {
      const { resolveStorage } = await import('../../../src/storage/index.js');
      const adapter = await resolveStorage('memory');
      await adapter.write('research-complete/page.md', '# page content');

      const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      try {
        await main(['get', 'research-complete/page.md']);
        expect(output.mock.calls).toEqual([['# page content']]);
      } finally { output.mockRestore(); }
    });

    it('get throws clear error for missing entry', async () => {
      await expect(main(['get', 'missing.md'])).rejects.toThrow(/entry not found/i);
    });

    it('delete removes an existing entry', async () => {
      await mkdir(join(memoryRoot, 'research-complete'), { recursive: true });
      await writeFile(join(memoryRoot, 'research-complete/old.md'), 'x', 'utf-8');
      await main(['delete', 'research-complete/old.md']);
      expect(existsSync(join(memoryRoot, 'research-complete/old.md'))).toBe(false);
    });

    it('delete is a no-op for missing path', async () => {
      await expect(main(['delete', 'nope.md'])).resolves.toBeUndefined();
    });
  });

  describe('append-log', () => {
    function stubStdin(content: string): () => void {
      const originalStdin = process.stdin;
      const mockStdin = {
        async *[Symbol.asyncIterator]() {
          yield content;
        },
      };
      Object.defineProperty(process, 'stdin', { value: mockStdin, configurable: true });
      return () => {
        Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
      };
    }

    it('appends a JSON object as a single JSONL line', async () => {
      const restore = stubStdin('{"op":"ingest","summary":"foo"}');
      try {
        await main(['append-log', 'research-complete/log.jsonl']);
      } finally {
        restore();
      }
      const path = join(memoryRoot, 'research-complete/log.jsonl');
      const content = await readFile(path, 'utf-8');
      expect(content).toBe('{"op":"ingest","summary":"foo"}\n');
    });

    it('appends multiple events without losing entries (round-trip)', async () => {
      const events = ['{"a":1}', '{"b":2}', '{"c":3}'];
      for (const e of events) {
        const restore = stubStdin(e);
        try {
          await main(['append-log', 'consumer/log.jsonl']);
        } finally {
          restore();
        }
      }
      const path = join(memoryRoot, 'consumer/log.jsonl');
      const content = await readFile(path, 'utf-8');
      expect(content.split('\n').filter((l) => l.length > 0)).toEqual(events);
    });

    it('handles existing log without trailing newline (backward compat)', async () => {
      await mkdir(join(memoryRoot, 'consumer'), { recursive: true });
      await writeFile(
        join(memoryRoot, 'consumer/log.jsonl'),
        '{"existing":"entry"}', // no trailing newline
        'utf-8'
      );
      const restore = stubStdin('{"new":"entry"}');
      try {
        await main(['append-log', 'consumer/log.jsonl']);
      } finally {
        restore();
      }
      const content = await readFile(join(memoryRoot, 'consumer/log.jsonl'), 'utf-8');
      const lines = content.split('\n').filter((l) => l.length > 0);
      expect(lines).toEqual(['{"existing":"entry"}', '{"new":"entry"}']);
    });

    it('rejects non-JSON stdin', async () => {
      const restore = stubStdin('not json');
      try {
        await expect(main(['append-log', 'log.jsonl'])).rejects.toThrow(/must be valid JSON/);
      } finally {
        restore();
      }
    });

    it('rejects empty stdin', async () => {
      const restore = stubStdin('');
      try {
        await expect(main(['append-log', 'log.jsonl'])).rejects.toThrow(/empty input/);
      } finally {
        restore();
      }
    });

    it('rejects JSON arrays / primitives', async () => {
      const restore = stubStdin('[1, 2, 3]');
      try {
        await expect(main(['append-log', 'log.jsonl'])).rejects.toThrow(/single JSON object/);
      } finally {
        restore();
      }
    });

    it('rejects when log path is missing', async () => {
      await expect(main(['append-log'])).rejects.toThrow(/Usage: aiwg memory append-log/);
    });
  });

  describe('storage routing', () => {
    it('honors roots.memory override from storage.config', async () => {
      await mkdir(join(projectRoot, '.aiwg'), { recursive: true });
      await writeFile(
        join(projectRoot, '.aiwg', 'storage.config'),
        JSON.stringify({
          version: '1',
          roots: { memory: 'custom-memory' },
        }),
        'utf-8'
      );
      resetStorage();
      await initStorage(projectRoot);

      const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin')!;
      Object.defineProperty(process, 'stdin', { configurable: true, value: {
        async *[Symbol.asyncIterator]() { yield 'custom content\n'; },
      } });
      try { await main(['put', 'redirected.md']); }
      finally { Object.defineProperty(process, 'stdin', originalStdin); }
      expect(await readFile(join(projectRoot, 'custom-memory/redirected.md'), 'utf8')).toBe('custom content\n');
      const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      try {
        await main(['get', 'redirected.md']);
        expect(output.mock.calls).toEqual([['custom content\n']]);
      } finally { output.mockRestore(); }
      stdout.length = 0;
      await main(['list']);
      expect(stdout).toEqual(['redirected.md']);
      stdout.length = 0;
      await main(['path', 'redirected.md', '--json']);
      expect(JSON.parse(stdout[0])).toEqual({ backend: 'fs', root: join(projectRoot, 'custom-memory'), path: join(projectRoot, 'custom-memory/redirected.md') });

      // Default path must NOT exist; custom path must
      expect(existsSync(join(projectRoot, '.aiwg/memory/redirected.md'))).toBe(false);
      expect(existsSync(join(projectRoot, 'custom-memory/redirected.md'))).toBe(true);
    });
  });

  describe('argument validation', () => {
    it('put without path errors clearly', async () => {
      await expect(main(['put'])).rejects.toThrow(/Usage: aiwg memory put/);
    });

    it('get without path errors clearly', async () => {
      await expect(main(['get'])).rejects.toThrow(/Usage: aiwg memory get/);
    });

    it('delete without path errors clearly', async () => {
      await expect(main(['delete'])).rejects.toThrow(/Usage: aiwg memory delete/);
    });

    it('unknown subcommand errors', async () => {
      await expect(main(['frobulate'])).rejects.toThrow(/Unknown memory subcommand/);
    });
  });
});
