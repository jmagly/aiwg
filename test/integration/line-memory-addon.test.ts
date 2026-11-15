import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UseHandler } from '../../src/cli/handlers/use.js';

const ENV_KEYS = [
  'AIWG_ARTIFACTS_PATH',
  'AIWG_PROJECT_ARTIFACTS_PATH',
  'AIWG_PROJECT_AIWG_DIR',
  'AIWG_PROJECT_LOCAL_PATHS',
] as const;

let projectDir: string;
let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

function context(args: string[]) {
  return {
    args,
    rawArgs: args,
    cwd: projectDir,
    frameworkRoot: path.resolve(__dirname, '../..'),
  };
}

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(os.tmpdir(), 'aiwg-line-memory-addon-'));
  originalEnv = {};
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(projectDir, { recursive: true, force: true });
});

describe('line-memory addon deployment', () => {
  it('aiwg use line-memory registers its expandable CLI namespace', async () => {
    const handler = new UseHandler();
    const result = await handler.execute(context([
      'line-memory',
      '--target', projectDir,
      '--provider', 'claude',
      '--copy-all',
    ]));

    expect(result.exitCode, result.message).toBe(0);
    const registry = JSON.parse(
      await readFile(path.join(projectDir, '.aiwg', 'cli-extensions.json'), 'utf8'),
    );
    expect(Object.keys(registry['line-memory'].subcommands).sort()).toEqual([
      'add', 'archive', 'config', 'import', 'list', 'prune', 'remove',
      'search', 'supersede', 'touch',
    ]);
    expect(registry['line-memory'].source).toMatch(
      /agentic\/code\/addons\/line-memory\/commands$/,
    );
  }, 90_000);

  it('registers CLI commands from a project-local plugin addon payload', async () => {
    const wrapperDir = path.join(projectDir, '.aiwg', 'plugins', 'custom-memory');
    const payloadDir = path.join(wrapperDir, 'payload');
    await mkdir(path.join(payloadDir, 'commands'), { recursive: true });
    await mkdir(path.join(payloadDir, 'skills', 'custom-memory'), { recursive: true });

    await writeFile(path.join(wrapperDir, 'manifest.json'), JSON.stringify({
      id: 'custom-memory',
      type: 'plugin',
      name: 'Custom Memory Plugin',
      version: '1.0.0',
      description: 'Project-local plugin wrapper',
      manifestVersion: '1',
      platforms: { claude: 'full' },
      keywords: ['memory', 'plugin'],
      deployment: { pathTemplate: '.{platform}/skills/{id}.md' },
      pluginConfig: { payloadType: 'addon', payloadPath: 'payload/' },
    }, null, 2));
    await writeFile(path.join(payloadDir, 'manifest.json'), JSON.stringify({
      id: 'custom-memory-payload',
      type: 'addon',
      name: 'Custom Memory Payload',
      version: '1.0.0',
      description: 'Project-local addon payload',
      manifestVersion: '1',
      platforms: { claude: 'full' },
      keywords: ['memory', 'addon'],
      deployment: { pathTemplate: '.{platform}/skills/{id}.md' },
      addonConfig: { entry: { skills: 'skills/' } },
      cli_commands: {
        namespace: 'custom-memory',
        description: 'Custom memory commands',
        entry: 'commands/',
        subcommands: {
          ping: { file: 'ping.mjs', description: 'Ping custom memory' },
        },
      },
    }, null, 2));
    await writeFile(
      path.join(payloadDir, 'commands', 'ping.mjs'),
      'export default async () => ({ exitCode: 0, message: "pong" });\n',
    );
    await writeFile(
      path.join(payloadDir, 'skills', 'custom-memory', 'SKILL.md'),
      '---\nname: custom-memory\ndescription: Custom memory test skill\n---\n\n# Custom Memory\n',
    );

    const handler = new UseHandler();
    const result = await handler.execute(context([
      'custom-memory',
      '--target', projectDir,
      '--provider', 'claude',
    ]));

    expect(result.exitCode, result.message).toBe(0);
    const registry = JSON.parse(
      await readFile(path.join(projectDir, '.aiwg', 'cli-extensions.json'), 'utf8'),
    );
    expect(registry['custom-memory'].subcommands.ping.file).toBe('ping.mjs');
    // `aiwg use` records project-relative sources so a committed registry is portable (#4189).
    expect(registry['custom-memory'].source).toBe(path.relative(projectDir, path.join(payloadDir, 'commands')));
  }, 90_000);
});
