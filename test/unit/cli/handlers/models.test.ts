import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { modelsHandler } from '../../../../src/cli/handlers/models.js';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-models-'));
  roots.push(root);
  const agent = path.join(root, 'agentic/code/frameworks/demo/agents/reviewer.md');
  const skill = path.join(root, 'agentic/code/frameworks/demo/skills/check/SKILL.md');
  await mkdir(path.dirname(agent), { recursive: true });
  await mkdir(path.dirname(skill), { recursive: true });
  await writeFile(agent, `---
name: reviewer
description: Review
model: opus
---
Review.
`);
  await writeFile(skill, `---
name: check
description: Check
commandHint:
  model: haiku
---
Check.
`);
  return { root, agent, skill };
}
afterEach(async () => {
  vi.restoreAllMocks();
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function run(root: string, args: string[]) {
  return modelsHandler.execute({
    args, rawArgs: ['models', ...args], cwd: root, frameworkRoot: root,
  });
}

describe('models CLI handler', () => {
  it('lists and resolves exact skill policy without mutation', async () => {
    const { root, skill } = await fixture();
    const before = await readFile(skill, 'utf8');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect((await run(root, ['resolve', '--skill', 'check', '--provider', 'codex', '--json'])).exitCode)
      .toBe(0);
    const output = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(output).toHaveLength(1);
    expect(output[0].policy).toMatchObject({ role: 'efficiency', tier: 'economy' });
    expect(output[0].compiled.outcome).toBe('unsupported');
    expect(await readFile(skill, 'utf8')).toBe(before);
  });

  it('supports dry-run and atomic selected skill updates', async () => {
    const { root, skill } = await fixture();
    const before = await readFile(skill, 'utf8');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect((await run(root, [
      'set', '--skill', 'check', '--tier', 'premium', '--provider', 'codex', '--dry-run',
    ])).exitCode)
      .toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain('unsupported');
    expect(await readFile(skill, 'utf8')).toBe(before);
    expect((await run(root, ['set', '--skill', 'check', '--tier', 'premium'])).exitCode)
      .toBe(0);
    expect(await readFile(skill, 'utf8')).toContain('modelTier: premium');
  });

  it('migrates legacy skill hints and preserves unrelated content', async () => {
    const { root, skill } = await fixture();
    expect((await run(root, ['migrate', '--all'])).exitCode).toBe(0);
    const output = await readFile(skill, 'utf8');
    expect(output).toContain('model: haiku');
    expect(output).toContain('modelRole: efficiency');
    expect(output).toContain('modelTier: economy');
    expect(output).toContain('description: Check');
    expect((await run(root, ['migrate', '--all'])).exitCode).toBe(0);
    expect(await readFile(skill, 'utf8')).toBe(output);
  });

  it('round-trips project defaults and rejects invalid mutation before writes', async () => {
    const { root } = await fixture();
    await writeFile(path.join(root, 'models.json'), JSON.stringify({
      description: 'operator content',
      providers: { custom: { coding: 'local/model' } },
    }));
    expect((await run(root, ['set-default', 'economy'])).exitCode).toBe(0);
    const config = JSON.parse(await readFile(path.join(root, 'models.json'), 'utf8'));
    expect(config.defaults.tier).toBe('economy');
    expect(config.description).toBe('operator content');
    expect(config.providers.custom.coding).toBe('local/model');
    expect((await run(root, ['set', '--all', '--tier', 'invalid'])).exitCode).toBe(2);
  });

  it('reports Grok Build source precedence and resolved project roles without leaking credentials', async () => {
    const { root } = await fixture();
    const home = path.join(root, 'grok-home');
    const bin = path.join(root, 'bin');
    await mkdir(home, { recursive: true });
    await mkdir(bin, { recursive: true });
    const config = path.join(home, 'config.toml');
    await writeFile(config, '[model.local]\nmodel = "actual-backend-id"\nenv_key = "TEST_GROK_API_KEY"\nextra_headers = { Authorization = "secret-config-value" }\n[models]\ndefault = "local"\n');
    const executable = path.join(bin, 'grok');
    await writeFile(executable, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'grok 1.0.38'; else printf '%s\\n' '{"configSources":{"layers":[{"role":"user","path":"${config}"}]}}'; fi\n`);
    await chmod(executable, 0o755);
    await writeFile(path.join(root, 'models.json'), JSON.stringify({ providers: { 'grok-build': { efficiency: 'local' } } }));
    const previous = { PATH: process.env.PATH, GROK_HOME: process.env.GROK_HOME, TEST_GROK_API_KEY: process.env.TEST_GROK_API_KEY };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      process.env.PATH = `${bin}:${previous.PATH ?? ''}`;
      process.env.GROK_HOME = home;
      process.env.TEST_GROK_API_KEY = 'secret-env-value';
      expect((await run(root, ['sources', '--provider', 'grok-build', '--json'])).exitCode).toBe(0);
      const sources = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
      expect(sources.discovery.providers['grok-build'].policy.selected['models.default']).toMatchObject({ scope: 'user', value: 'local' });
      expect((await run(root, ['resolve', '--skill', 'check', '--provider', 'grok-build', '--json'])).exitCode).toBe(0);
      const resolved = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
      expect(resolved[0].providerResolution).toMatchObject({ source: 'project-policy', model: 'local' });
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret-config-value|secret-env-value/);
      expect(sources.discovery.providers['grok-build'].models[0]).toMatchObject({ id: 'local', apiModelId: 'actual-backend-id' });
      expect((await run(root, ['audit', '--skill', 'check', '--provider', 'grok-build', '--model', 'missing', '--json'])).exitCode).toBe(2);
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))[0].providerResolution.diagnostic).toContain('unavailable');
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
});
