import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import fs, { existsSync } from 'node:fs';
import { channel } from 'node:diagnostics_channel';
import os from 'node:os';
import path from 'node:path';
import { UseHandler } from '../../src/cli/handlers/use.js';

let projectDir: string;
let homeDir: string;

function context(args: string[]) {
  return {
    args,
    rawArgs: args,
    cwd: projectDir,
    frameworkRoot: path.resolve(__dirname, '../..'),
  };
}

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(os.tmpdir(), 'aiwg-compound-addon-'));
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'aiwg-compound-addon-home-'));
  // Index rebuilds must not contend with other tests or use the operator cache.
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('USERPROFILE', homeDir);
  vi.stubEnv('CODEX_HOME', path.join(homeDir, '.codex'));
  vi.stubEnv('XDG_CACHE_HOME', path.join(homeDir, '.cache'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(homeDir, '.config'));
  vi.stubEnv('XDG_DATA_HOME', path.join(homeDir, '.local', 'share'));
  vi.stubEnv('AIWG_CONFIG', path.join(homeDir, '.aiwg'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all([
    rm(projectDir, { recursive: true, force: true }),
    rm(homeDir, { recursive: true, force: true }),
  ]);
});

describe('compound-memory addon activation', () => {
  it('deploys transitive required addons before registering the selected addon', async () => {
    const result = await new UseHandler().execute(context([
      'compound-memory',
      '--target', projectDir,
      '--provider', 'claude',
      '--copy-all',
    ]));
    expect(result.exitCode, result.message).toBe(0);

    const registry = JSON.parse(await readFile(
      path.join(projectDir, '.aiwg/cli-extensions.json'),
      'utf8',
    ));
    expect(registry['line-memory'].subcommands.import).toBeDefined();
    expect(registry['compound-memory'].subcommands.status).toBeDefined();
    expect(registry['compound-memory'].subcommands.ingest).toBeDefined();
    expect(registry['compound-memory'].subcommands['capture-output']).toBeDefined();
    expect(registry['compound-memory'].subcommands.context).toBeDefined();
    expect(registry['compound-memory'].subcommands.review).toBeDefined();
    expect(registry['compound-memory'].subcommands.maintain).toBeDefined();
    expect(registry['compound-memory'].subcommands.update).toBeDefined();

    for (const skill of [
      'compound-memory',
      'line-memory',
      'llm-wiki',
      'memory-ingest',
      'aiwg-guide',
    ]) {
      await expect(access(path.join(
        projectDir,
        '.claude/.aiwg/skills',
        skill,
        'SKILL.md',
      ))).resolves.toBeUndefined();
    }
  }, 60_000);

  it('previews transitive activation without writing deployment artifacts', async () => {
    const events: Array<{ phase: string }> = [];
    const staging = channel('aiwg.provider-staging');
    const observe = (event: unknown) => events.push(event as typeof events[number]);
    staging.subscribe(observe);
    const copySpy = vi.spyOn(fs, 'copyFileSync');
    const sentinel = path.join(projectDir, 'operator.txt');
    await writeFile(sentinel, 'Existing operator file.\n');
    let result;
    let copiedFiles: number;
    try {
      result = await new UseHandler().execute(context([
        'compound-memory',
        '--target', projectDir,
        '--provider', 'claude',
        '--copy-all',
        '--dry-run',
      ]));
      copiedFiles = copySpy.mock.calls.length;
    } finally {
      staging.unsubscribe(observe);
      copySpy.mockRestore();
    }
    expect(result.exitCode, result.message).toBe(0);
    expect(existsSync(path.join(projectDir, '.aiwg/cli-extensions.json'))).toBe(false);
    expect(existsSync(path.join(projectDir, '.claude/.aiwg/skills'))).toBe(false);
    expect(await readdir(projectDir)).toEqual(['operator.txt']);
    expect(await readFile(sentinel, 'utf8')).toBe('Existing operator file.\n');
    // Standalone snapshots do not emit the pooled-input event. Count copies
    // as well, and prove the observer saw every required addon projection.
    expect(events.filter(event => event.phase === 'snapshot-provider-inputs')).toHaveLength(0);
    expect(events.filter(event => event.phase === 'prepare-provider-staging')).toHaveLength(5);
    expect(copiedFiles).toBe(0);
    for (const skill of ['line-memory', 'aiwg-guide', 'memory-ingest', 'llm-wiki', 'compound-memory']) {
      expect(result.message).toContain(`[dry-run] Would write ${path.join(projectDir, '.claude/.aiwg/skills', skill, 'SKILL.md')}`);
    }
  });

  it('activates over standalone line-memory and llm-wiki data without rewriting either store', async () => {
    expect(process.env.CODEX_HOME).toBe(path.join(homeDir, '.codex'));
    const linePath = path.join(projectDir, '.aiwg/memory/line-memory.txt');
    const wikiPath = path.join(projectDir, '.aiwg/wiki/concepts/existing.md');
    await mkdir(path.dirname(linePath), { recursive: true });
    await mkdir(path.dirname(wikiPath), { recursive: true });
    const lineBefore = 'Existing reviewed fact.\n';
    const wikiBefore = '# Existing knowledge\n\nLinked knowledge remains owned by llm-wiki.\n';
    await writeFile(linePath, lineBefore);
    await writeFile(wikiPath, wikiBefore);

    const result = await new UseHandler().execute(context([
      'compound-memory',
      '--target', projectDir,
      '--provider', 'codex',
      '--copy-all',
    ]));
    expect(result.exitCode, result.message).toBe(0);
    expect(await readFile(linePath, 'utf8')).toBe(lineBefore);
    expect(await readFile(wikiPath, 'utf8')).toBe(wikiBefore);
    await expect(access(path.join(
      projectDir,
      '.agents/skills/compound-memory/SKILL.md',
    ))).resolves.toBeUndefined();
  }, 60_000);
});
