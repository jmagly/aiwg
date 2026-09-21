import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  grokBuildExport,
  grokBuildList,
  grokBuildSearch,
  grokHeadlessSessionIdFromFile,
  parseGrokHeadlessSessionId,
} from '../../../src/sessions/grok-build-cli.js';
import { sessionsHandler } from '../../../src/cli/handlers/sessions.js';

const ID = '0199a111-1111-7111-8111-111111111111';
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-grok-cli-'));
  roots.push(root);
  return root;
}

describe('documented Grok Build CLI routes', () => {
  it('invokes bounded list/search with safe GROK_HOME and returns only IDs', async () => {
    const root = await workspace();
    const runner = vi.fn(async (_binary, args: string[], options) => {
      expect(args[0]).toBe('--no-auto-update');
      expect(options).toMatchObject({ cwd: root, timeout: 15000, maxBuffer: 2000000 });
      expect(options.env.GROK_HOME).toBe(join(root, '.grok'));
      return {
        stdout: args[1] === 'sessions' && args[2] === 'list'
          ? `\n(no label)\nSESSION ID                            CREATED     UPDATED     STATUS     SUMMARY\n${ID}  2026-09-21  2026-09-21  local  sensitive summary\n`
          : `${ID} (score: 1.00)  Sep 21, 3:00pm\n  sensitive title\n  sensitive prompt\n\nTotal: 1\n`,
        stderr: 'private diagnostics',
      };
    });
    const options = { cwd: root, env: { PATH: '/usr/bin', GROK_HOME: join(root, '.grok') }, runner };
    expect(await grokBuildList(options)).toEqual([ID]);
    expect(await grokBuildSearch(options, 'sensitive query')).toEqual([ID]);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[1]?.[1]).toEqual([
      '--no-auto-update', 'sessions', 'search', 'sensitive query', '--limit', '20',
    ]);
  });

  it('fails closed on drift, unsafe roots, and unbounded queries', async () => {
    const root = await workspace();
    const runner = vi.fn(async () => ({ stdout: 'unexpected provider output', stderr: 'secret' }));
    await expect(grokBuildList({ cwd: root, env: { GROK_HOME: join(root, '.grok') }, runner }))
      .rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
    await expect(grokBuildList({ cwd: root, env: { GROK_HOME: '/' }, runner }))
      .rejects.toMatchObject({ code: 'SOURCE_NOT_AUTHORIZED' });
    await expect(grokBuildSearch({ cwd: root, runner }, '\ninvalid'))
      .rejects.toMatchObject({ code: 'INVALID_SEARCH_QUERY' });
    const escape = join(root, 'linked-home');
    await symlink('/tmp', escape);
    await expect(grokBuildList({ cwd: root, env: { GROK_HOME: escape }, runner }))
      .rejects.toMatchObject({ code: 'SOURCE_SYMLINK' });
  });

  it('exports a bounded transcript to an exclusive UUID file', async () => {
    const root = await workspace();
    const runner = vi.fn(async () => ({ stdout: '## User\n\nSynthetic prompt.\n', stderr: '' }));
    const options = { cwd: root, env: { GROK_HOME: join(root, '.grok') }, runner };
    const output = await grokBuildExport(options, ID, root);
    expect(output).toBe(join(root, `${ID}.md`));
    expect(await readFile(output, 'utf8')).toBe('## User\n\nSynthetic prompt.\n');
    expect(runner.mock.calls[0]?.[1]).toEqual(['--no-auto-update', 'export', ID]);
    await expect(grokBuildExport(options, ID, root)).rejects.toMatchObject({ code: 'IMPORT_CONFLICT' });
    await expect(grokBuildExport(options, 'not-an-id', root)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('does not persist a changed CLI export', async () => {
    const root = await workspace();
    const runner = vi.fn(async () => ({ stdout: '## User\n\nHello.\n\n## New Section\n\nChanged.\n', stderr: '' }));
    await expect(grokBuildExport({ cwd: root, env: { GROK_HOME: join(root, '.grok') }, runner }, ID, root))
      .rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
    await expect(readFile(join(root, `${ID}.md`), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reads documented headless JSON and streaming JSON IDs without retaining content', async () => {
    const root = await workspace();
    expect(parseGrokHeadlessSessionId(JSON.stringify({ sessionId: ID, result: 'sensitive' }), 'json')).toBe(ID);
    const transcript = join(root, 'headless.jsonl');
    await writeFile(transcript, `${JSON.stringify({ type: 'start', sessionId: ID })}\n${JSON.stringify({ type: 'end', sessionId: ID, text: 'private' })}\n`);
    expect(await grokHeadlessSessionIdFromFile(transcript, 'streaming-json')).toBe(ID);
    const linked = join(root, 'linked.jsonl');
    await symlink(transcript, linked);
    await expect(grokHeadlessSessionIdFromFile(linked, 'streaming-json'))
      .rejects.toMatchObject({ code: 'SOURCE_SYMLINK' });
    expect(() => parseGrokHeadlessSessionId('{}', 'json')).toThrowError(/one consistent sessionId/);
    expect(() => parseGrokHeadlessSessionId(`${JSON.stringify({ sessionId: ID })}\n${JSON.stringify({ sessionId: '0199a222-2222-7222-8222-222222222222' })}`, 'streaming-json'))
      .toThrowError(/one consistent sessionId/);
  });

  it('exposes a redacted ID-only headless command envelope', async () => {
    const root = await workspace();
    const input = join(root, 'headless.json');
    await writeFile(input, JSON.stringify({ sessionId: ID, result: 'private output' }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await sessionsHandler.execute({
      args: ['grok-id', input, '--format', 'json', '--json'],
      rawArgs: [], cwd: root, frameworkRoot: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(output.data).toEqual({ sessionId: ID });
    expect(JSON.stringify(output)).not.toContain('private output');
  });

  it('routes CLI export preview and rejects an unsafe GROK_HOME before process launch', async () => {
    const root = await workspace();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const preview = await sessionsHandler.execute({
      args: ['grok-export', ID, '--workspace', root, '--out', root, '--dry-run', '--json'],
      rawArgs: [], cwd: root, frameworkRoot: process.cwd(),
    });
    expect(preview.exitCode).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      status: 'preview', data: { sessionId: ID, wouldExport: true },
    });
    const prior = process.env.GROK_HOME;
    process.env.GROK_HOME = '/';
    try {
      const result = await sessionsHandler.execute({
        args: ['grok-list', '--workspace', root, '--json'],
        rawArgs: [], cwd: root, frameworkRoot: process.cwd(),
      });
      expect(result.exitCode).not.toBe(0);
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).error.code).toBe('SOURCE_NOT_AUTHORIZED');
    } finally {
      if (prior === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prior;
    }
  });
});
