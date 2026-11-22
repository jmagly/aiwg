// CLI acquisition boundaries derived from the sanitized Grok Build 1.0.77 captures.
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  grokBuildExport, grokBuildList, grokBuildSearch, parseGrokHeadlessSessionId,
} from '../../../src/sessions/grok-build-cli.js';

const captures = resolve('test/fixtures/sessions/grok-build/captured-1.0.77');
const id = '0199c111-1111-7111-8111-111111111111';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function temp() {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-grok-boundary-'));
  roots.push(root);
  return root;
}

async function stream() {
  return (await readFile(join(captures, 'streaming.jsonl'), 'utf8')).trimEnd().split('\n');
}

it.each(['list', 'search', 'export'] as const)('rejects a symlinked sessions root before %s launches', async command => {
  const cwd = await temp();
  const home = join(cwd, 'grok-home');
  const otherStore = join(cwd, '.cursor');
  await mkdir(home);
  await mkdir(otherStore);
  await symlink(otherStore, join(home, 'sessions'));
  const runner = vi.fn(async () => ({ stdout: 'No sessions found.\n', stderr: '' }));
  const options = { cwd, env: { GROK_HOME: home, PATH: '' }, runner };
  const operation = command === 'list' ? grokBuildList(options)
    : command === 'search' ? grokBuildSearch(options, 'synthetic')
      : grokBuildExport(options, id, cwd);
  await expect(operation).rejects.toMatchObject({ code: 'SOURCE_SYMLINK' });
  expect(runner).not.toHaveBeenCalled();
});

it('passes the selected GROK_HOME to CLI acquisition without reading native session content', async () => {
  const cwd = await temp();
  const home = join(cwd, 'grok-home');
  await mkdir(join(home, 'sessions'), { recursive: true });
  const runner = vi.fn(async (_binary: string, _args: string[], _options: unknown) => ({
    stdout: await readFile(join(captures, 'sessions-list.txt'), 'utf8'), stderr: '',
  }));
  expect(await grokBuildList({ cwd, env: { GROK_HOME: home, PATH: '' }, runner })).toEqual([id]);
  expect(runner.mock.calls[0]?.[2]).toMatchObject({ env: { GROK_HOME: home } });
});

it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])('reports unknown headless type %s with an actionable code', async type => {
  const rows = await stream();
  expect(() => parseGrokHeadlessSessionId([JSON.stringify({ type }), ...rows].join('\n'), 'streaming-json'))
    .toThrowError(expect.objectContaining({ code: 'SCHEMA_DRIFT' }));
});

it.each([0, 1, 2, 3, 4, 5, 6])('rejects captured event %i appended after the terminal end', async index => {
  const rows = await stream();
  expect(() => parseGrokHeadlessSessionId([...rows, rows[index]].join('\n'), 'streaming-json'))
    .toThrowError(expect.objectContaining({ code: 'SCHEMA_DRIFT' }));
});

it('accepts one terminal end, trailing whitespace, and the captured nonstreaming result', async () => {
  const rows = await stream();
  expect(parseGrokHeadlessSessionId(rows.join('\n') + '\n\n', 'streaming-json')).toBe(id);
  expect(parseGrokHeadlessSessionId(rows.at(-1)!, 'streaming-json')).toBe(id);
  expect(parseGrokHeadlessSessionId(await readFile(join(captures, 'headless.json'), 'utf8'), 'json')).toBe(id);
});
