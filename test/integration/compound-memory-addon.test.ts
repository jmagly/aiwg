import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UseHandler } from '../../src/cli/handlers/use.js';

let projectDir: string;

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
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
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
    const result = await new UseHandler().execute(context([
      'compound-memory',
      '--target', projectDir,
      '--provider', 'claude',
      '--copy-all',
      '--dry-run',
    ]));
    expect(result.exitCode, result.message).toBe(0);
    expect(existsSync(path.join(projectDir, '.aiwg/cli-extensions.json'))).toBe(false);
    expect(existsSync(path.join(projectDir, '.claude/.aiwg/skills'))).toBe(false);
  });

  it('activates over standalone line-memory and llm-wiki data without rewriting either store', async () => {
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
