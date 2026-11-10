import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
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
const resultEnvelope = { text: 'private output', thought: '', stopReason: 'end_turn', sessionId: ID, requestId: 'request-fixture', cwd: '/synthetic/workspace', usage: {}, modelUsage: {}, num_turns: 1, total_cost_usd: 0, total_cost_usd_ticks: 0 };
const endEnvelope = { ...resultEnvelope, type: 'end' };
delete (endEnvelope as Partial<typeof resultEnvelope>).text;
delete (endEnvelope as Partial<typeof resultEnvelope>).thought;
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

  it('maps launch failures to distinct actionable errors without echoing stderr', async () => {
    const root = await workspace();
    const env = { PATH: '/nonexistent', GROK_HOME: join(root, '.grok') };
    const failing = (error: Record<string, unknown>) => vi.fn(async () => {
      throw Object.assign(new Error('launch failed'), { stderr: 'private session text', ...error });
    });
    await expect(grokBuildList({ cwd: root, env, runner: failing({ code: 'ENOENT' }) }))
      .rejects.toMatchObject({
        code: 'UNSUPPORTED_OPERATION',
        message: expect.stringMatching(/not on PATH.*--grok-bin/),
      });
    await expect(grokBuildList({ cwd: root, env, runner: failing({ killed: true, signal: 'SIGTERM' }) }))
      .rejects.toMatchObject({ message: expect.stringContaining('timed out after 15s') });
    await expect(grokBuildList({ cwd: root, env, runner: failing({ code: 2 }) }))
      .rejects.toMatchObject({ message: expect.stringContaining('exited with code 2') });
    await expect(grokBuildList({ cwd: root, env, runner: failing({ code: 2 }) }))
      .rejects.not.toMatchObject({ message: expect.stringContaining('private') });
  });

  it('falls back to the installer link in $GROK_HOME/bin when grok is not on PATH', async () => {
    const root = await workspace();
    const bin = join(root, '.grok', 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'grok-1.0.38'), '#!/bin/sh\n', { mode: 0o755 });
    await symlink('grok-1.0.38', join(bin, 'grok'));
    const runner = vi.fn(async () => ({ stdout: 'No sessions found.\n', stderr: '' }));
    const env = { PATH: '/nonexistent', GROK_HOME: join(root, '.grok') };
    expect(await grokBuildList({ cwd: root, env, runner })).toEqual([]);
    expect(runner.mock.calls[0]?.[0]).toBe(join(await realpath(bin), 'grok-1.0.38'));
  });

  it('ignores a $GROK_HOME/bin/grok link that escapes the bin directory', async () => {
    const root = await workspace();
    const bin = join(root, '.grok', 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(root, 'elsewhere'), '#!/bin/sh\n', { mode: 0o755 });
    await symlink(join(root, 'elsewhere'), join(bin, 'grok'));
    const runner = vi.fn(async () => ({ stdout: 'No sessions found.\n', stderr: '' }));
    await grokBuildList({ cwd: root, env: { PATH: '/nonexistent', GROK_HOME: join(root, '.grok') }, runner });
    expect(runner.mock.calls[0]?.[0]).toBe('grok');
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
    expect(parseGrokHeadlessSessionId(JSON.stringify(resultEnvelope), 'json')).toBe(ID);
    const transcript = join(root, 'headless.jsonl');
    await writeFile(transcript, `${JSON.stringify({ type: 'available_commands', tools: [], commands: [] })}\n${JSON.stringify(endEnvelope)}\n`);
    expect(await grokHeadlessSessionIdFromFile(transcript, 'streaming-json')).toBe(ID);
    const linked = join(root, 'linked.jsonl');
    await symlink(transcript, linked);
    await expect(grokHeadlessSessionIdFromFile(linked, 'streaming-json'))
      .rejects.toMatchObject({ code: 'SOURCE_SYMLINK' });
    expect(() => parseGrokHeadlessSessionId('{}', 'json')).toThrowError(/one consistent sessionId|unrecognized Grok Build/);
    expect(() => parseGrokHeadlessSessionId(`${JSON.stringify(endEnvelope)}\n${JSON.stringify({ ...endEnvelope, sessionId: '0199a222-2222-7222-8222-222222222222' })}`, 'streaming-json'))
      .toThrowError(/one consistent sessionId|unrecognized Grok Build/);
  });

  it('exposes a redacted ID-only headless command envelope', async () => {
    const root = await workspace();
    const input = join(root, 'headless.json');
    await writeFile(input, JSON.stringify(resultEnvelope));
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
