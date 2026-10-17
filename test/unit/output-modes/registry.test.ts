import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadOutputModeRegistry, readOutputModeState, resolveOutputModes, writeOutputModeState } from '../../../src/output-modes/registry.js';
import { applyOutputModes } from '../../../src/output-modes/runtime.js';

const roots: string[] = [];
async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'aiwg-output-mode-test-'));
  roots.push(value);
  return value;
}

beforeEach(async () => {
  vi.stubEnv('TMPDIR', await root());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  delete process.env.AIWG_SESSION_ID;
  delete process.env.AIWG_CONFIG;
  // `roots` was tracked but never actually removed (#3018), leaking a directory per call.
  await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('output mode registry', () => {
  it('uses a true unaltered default when no modes are configured', async () => {
    const cwd = await root();
    const result = await resolveOutputModes(cwd, cwd);
    expect(result.modes).toEqual([]);
    expect(result.diagnostics[0]).toContain('no instructions or post-processing');
  });

  it('loads project profiles ahead of built-ins', async () => {
    const cwd = await root();
    const dir = join(cwd, '.aiwg', 'output-modes');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'wittgenstein-inspired.yaml'), [
      'id: wittgenstein-inspired', 'version: 2.0.0', 'description: project override',
      'kind: voice', 'stage: voice', 'instructions: project guidance',
      'provenance:', '  source: project', '  license: MIT',
      'validation:', '  level: advisory', '',
    ].join('\n'));
    const registry = await loadOutputModeRegistry(cwd, cwd);
    expect(registry.get('wittgenstein-inspired')).toMatchObject({ version: '2.0.0', source: 'project' });
  });

  it('loads user profiles from the resolved AIWG config directory', async () => {
    const cwd = await root();
    const configDir = join(await root(), 'operator-config');
    process.env.AIWG_CONFIG = configDir;
    await mkdir(join(configDir, 'output-modes'), { recursive: true });
    await writeFile(join(configDir, 'output-modes', 'personal-syntax.yaml'), [
      'id: personal-syntax', 'version: 1.0.0', 'description: personal syntax',
      'kind: voice', 'stage: voice', 'instructions: Use short declarative sentences.',
      'provenance:', '  source: operator', '  license: CC0-1.0',
      'validation:', '  level: advisory', '',
    ].join('\n'));
    const registry = await loadOutputModeRegistry(cwd, cwd);
    expect(registry.get('personal-syntax')).toMatchObject({ source: 'user', sourcePath: join(configDir, 'output-modes', 'personal-syntax.yaml') });
  });

  it('rejects malformed nested profile metadata', async () => {
    const cwd = await root();
    const dir = join(cwd, '.aiwg', 'output-modes');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'invalid.yaml'), [
      'id: Invalid ID', 'version: 1.0.0', 'description: invalid',
      'kind: voice', 'stage: voice', 'instructions: test',
      'provenance:', '  source: test', '  license: MIT',
      'validation:', '  level: conformance', '',
    ].join('\n'));
    await expect(loadOutputModeRegistry(cwd, cwd)).rejects.toThrow(/id:.*lowercase.*validation\.hook.*validation\.standardVersion/);
  });

  it('persists project and session scopes outside provider startup files', async () => {
    const cwd = await root();
    process.env.AIWG_SESSION_ID = 'test-session';
    const projectPath = await writeOutputModeState(cwd, 'project', ['asd-ste']);
    const sessionPath = await writeOutputModeState(cwd, 'session', ['wittgenstein-inspired']);
    expect(projectPath).toBe(join(cwd, '.aiwg', 'output-modes.yaml'));
    expect(sessionPath).not.toContain(join(cwd, '.claude'));
    expect(await readOutputModeState(cwd, 'project')).toMatchObject({ modes: ['asd-ste'] });
    expect(await readOutputModeState(cwd, 'session')).toMatchObject({ modes: ['wittgenstein-inspired'] });
    expect(await readFile(projectPath, 'utf8')).toContain('asd-ste');
  });

  it('composes cross-kind modes in deterministic stage order', async () => {
    const cwd = await root();
    const result = await resolveOutputModes(cwd, cwd, ['asd-ste', 'wittgenstein-inspired']);
    expect(result.modes.map(mode => mode.id)).toEqual(['wittgenstein-inspired', 'asd-ste']);
    expect(result.modes.map(mode => mode.scope)).toEqual(['invocation', 'invocation']);
  });

  it('fails safe for unknown modes', async () => {
    const cwd = await root();
    await expect(resolveOutputModes(cwd, cwd, ['provider.future-surface'])).rejects.toThrow(/fail safe/);
  });

  it('validates proposed project state before it is persisted', async () => {
    const cwd = await root();
    const dir = join(cwd, '.aiwg', 'output-modes');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'dependent.yaml'), [
      'id: dependent', 'version: 1.0.0', 'description: requires another mode',
      'kind: structure', 'stage: structure', 'instructions: test',
      'requires: [missing-mode]', 'provenance:', '  source: test', '  license: MIT',
      'validation:', '  level: advisory', '',
    ].join('\n'));
    await expect(resolveOutputModes(cwd, cwd, [], { project: ['dependent'] })).rejects.toThrow(/requires 'missing-mode'/);
  });

  it('rejects same-kind composition without a merge strategy', async () => {
    const cwd = await root();
    const dir = join(cwd, '.aiwg', 'output-modes');
    await mkdir(dir, { recursive: true });
    for (const id of ['one', 'two']) await writeFile(join(dir, `${id}.yaml`), [
      `id: ${id}`, 'version: 1.0.0', `description: ${id}`, 'kind: structure', 'stage: structure',
      `instructions: ${id}`, 'provenance:', '  source: test', '  license: MIT', 'validation:', '  level: advisory', '',
    ].join('\n'));
    await expect(resolveOutputModes(cwd, cwd, ['one', 'two'])).rejects.toThrow(/without a merge strategy/);
  });
});

describe('output mode runtime', () => {
  it('returns byte-for-byte unaltered content with an empty stack', async () => {
    const input = 'Exact bytes: `x = 1`\n';
    const result = await applyOutputModes(input, [], { transform: value => value.toUpperCase() });
    expect(result.content).toBe(input);
  });

  it('preserves declared literals across transformations', async () => {
    const cwd = await root();
    const mode = (await resolveOutputModes(cwd, cwd, ['wittgenstein-inspired'])).modes[0];
    const result = await applyOutputModes('Explain `npm test` and [source](https://example.test).', [mode], {
      transform: value => value.replace('Explain', 'Clarify'),
    });
    expect(result.content).toBe('Clarify `npm test` and [source](https://example.test).');
  });

  it('does not confuse pre-existing text with protected-literal tokens', async () => {
    const cwd = await root();
    const mode = (await resolveOutputModes(cwd, cwd, ['wittgenstein-inspired'])).modes[0];
    const marker = '\uE000AIWG_OUTPUT_MODE_0\uE001';
    const result = await applyOutputModes(`${marker} Preserve \`npm test\`.`, [mode], { transform: value => value });
    expect(result.content).toBe(`${marker} Preserve \`npm test\`.`);
  });

  it('rejects transforms that duplicate protected literals', async () => {
    const cwd = await root();
    const mode = (await resolveOutputModes(cwd, cwd, ['wittgenstein-inspired'])).modes[0];
    await expect(applyOutputModes('Run `npm test`.', [mode], { transform: value => `${value} ${value}` })).rejects.toThrow(/duplicated a protected literal/);
  });

  it('falls back to the original output after mandatory validation failure', async () => {
    const cwd = await root();
    const mode = { ...(await resolveOutputModes(cwd, cwd, ['asd-ste'])).modes[0], validation: { level: 'validated' as const, hook: 'operator-validator' } };
    const result = await applyOutputModes('Original.', [mode], {
      transform: () => 'Changed.', validate: () => ({ valid: false, message: 'term not approved' }),
    });
    expect(result).toMatchObject({ content: 'Original.', fallback: 'unaltered' });
    expect(result.diagnostics[0].message).toBe('term not approved');
  });
});
