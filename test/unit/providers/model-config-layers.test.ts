// Guard provider pins when project model policy contains only worker selection.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadModelConfig } from '../../../tools/agents/providers/base.mjs';
import { deployAgents } from '../../../tools/agents/providers/claude.mjs';
import { FactoryAdapter } from '../../../tools/ralph-external/lib/factory-adapter.mjs';
import { ExternalMultiLoopStateManager } from '../../../tools/ralph-external/external-multi-loop-state-manager.mjs';

const repo = resolve(import.meta.dirname, '../../..');
const defaultsPath = 'agentic/code/frameworks/sdlc-complete/config/models.json';
const shipped = JSON.parse(readFileSync(join(repo, defaultsPath), 'utf8'));
const roles = { opus: 'reasoning', sonnet: 'coding', haiku: 'efficiency' };
const workerSelection = { roleGuidance: { coding: { groups: ['workers'], tier: 'standard' } } };
let root: string;
let home: string;
function put(relative: string, data: unknown) {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  return file;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aiwg-model-layers-'));
  home = join(root, 'home');
  mkdirSync(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('AIWG_ROOT', '');
  vi.spyOn(process, 'cwd').mockReturnValue(root);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('merged deploy models (#4186, #4187)', () => {
  it.each([false, true])('deploys bare Claude aliases with project tier override=%s', override => {
    put('models.json', {
      defaults: { workerSelection },
      ...(override ? { claude: { coding: { model: 'custom-coding-pin' } } } : {}),
    });
    const config = loadModelConfig(repo);
    expect(config.defaults.workerSelection).toEqual(workerSelection);
    const files = Object.keys(roles).map(alias => put(`${alias}.md`,
      `---\nname: ordinary-${alias}\nmodel: ${alias}\ntools: Read\n---\nFixture.\n`));
    deployAgents(files, root, { modelsConfig: config, force: true, quiet: true });
    for (const [alias, role] of Object.entries(roles)) {
      const expected = override && role === 'coding' ? 'custom-coding-pin' : shipped.claude[role].model;
      expect(readFileSync(join(root, '.claude/agents', `${alias}.md`), 'utf8'))
        .toContain(`model: ${expected}\n`);
    }
    expect(config.factory).toEqual(shipped.factory);
    expect(config.claude_shorthand).toEqual(shipped.claude_shorthand);
    expect(config._source).toBe(`AIWG defaults (${join(repo, defaultsPath)}) ← project (${join(root, 'models.json')})`);
  });

  it('merges user and project fields, including partial shorthand maps', () => {
    put('home/.config/aiwg/models.json', {
      claude: { reasoning: { model: 'user-reasoning' }, coding: { model: 'user-coding' } },
      factory: { coding: { model: 'user-factory' } },
      shorthand: { sonnet: 'user-sonnet' }, claude_shorthand: { custom: 'user-custom' },
      factory_shorthand: { custom: 'user-factory-custom' },
      defaults: { workerSelection: { groups: ['user'], tier: 'economy' } },
    });
    put('models.json', {
      claude: { coding: { model: 'project-coding' } },
      shorthand: { haiku: 'project-haiku' }, claude_shorthand: { custom: 'project-custom' },
      factory_shorthand: { other: 'project-other' },
      defaults: { workerSelection: { groups: ['project'] } },
    });
    const config = loadModelConfig(repo);
    expect(config.claude.reasoning.model).toBe('user-reasoning');
    expect(config.claude.coding.model).toBe('project-coding');
    expect(config.claude.efficiency).toEqual(shipped.claude.efficiency);
    expect(config.factory.coding.model).toBe('user-factory');
    expect(config.factory.reasoning).toEqual(shipped.factory.reasoning);
    expect(config.shorthand).toMatchObject({ opus: shipped.shorthand.opus, sonnet: 'user-sonnet', haiku: 'project-haiku' });
    expect(config.claude_shorthand).toMatchObject({ custom: 'project-custom', sonnet: shipped.claude_shorthand.sonnet });
    expect(config.factory_shorthand).toEqual({ custom: 'user-factory-custom', other: 'project-other' });
    expect(config.defaults.workerSelection).toEqual({ groups: ['project'], tier: 'economy' });
    expect(config._source).toContain(`user (${join(home, '.config/aiwg/models.json')}) ← project`);
  });

  it('uses module-relative shipped defaults for an external source', () => {
    put('models.json', { defaults: { workerSelection } });
    expect(loadModelConfig(root).claude).toEqual(shipped.claude);
  });

  it.each([null, [], 'invalid', 42])('ignores non-object provider overrides (%j) with source warnings', value => {
    put('home/.config/aiwg/models.json', { claude: value });
    put('models.json', { claude: value, factory: value, shorthand: value, claude_shorthand: value });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = loadModelConfig(repo);
    for (const key of ['claude', 'factory', 'shorthand', 'claude_shorthand']) {
      expect(config[key]).toEqual(shipped[key]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`key "${key}" at ${join(root, 'models.json')}`));
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`key "claude" at ${join(home, '.config/aiwg/models.json')}`));
    const file = put('ordinary.md', '---\nname: ordinary\nmodel: sonnet\ntools: Read\n---\nFixture.\n');
    deployAgents([file], root, { modelsConfig: config, force: true, quiet: true });
    expect(readFileSync(join(root, '.claude/agents/ordinary.md'), 'utf8')).toContain(`model: ${shipped.claude.coding.model}\n`);
  });

  it('preserves nested tier objects against invalid overrides', () => {
    put('models.json', { claude: { coding: null, efficiency: [] } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadModelConfig(repo).claude).toEqual(shipped.claude);
    for (const key of ['claude.coding', 'claude.efficiency']) {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`key "${key}" at ${join(root, 'models.json')}`));
    }
  });

  it('keeps Ralph Factory alias literals equal to shipped Factory defaults', () => {
    const adapter = new FactoryAdapter();
    for (const [alias, role] of Object.entries(roles)) {
      expect(adapter.mapModel(alias)).toBe(shipped.factory[role].model);
    }
  });

  it.each([false, true])('Ralph loop uses the loaded coding default (project override=%s)', async override => {
    if (override) put('models.json', { claude: { coding: { model: 'project-ralph-coding' } } });
    const manager = new ExternalMultiLoopStateManager(root);
    const { state } = await manager.createLoop({
      objective: 'Synthetic model default check', completionCriteria: 'Configured model is persisted',
    });
    expect(state.config.model).toBe(override ? 'project-ralph-coding' : shipped.claude.coding.model);
  });

  it('derives fallback IDs from the catalog when shipped defaults are unavailable', () => {
    const existsSync = fs.existsSync;
    vi.spyOn(fs, 'existsSync').mockImplementation(file =>
      String(file).endsWith(defaultsPath) ? false : existsSync(file));
    const config = loadModelConfig(repo);
    for (const provider of ['claude', 'factory', 'devin']) {
      for (const role of Object.values(roles)) {
        expect(config[provider][role].model).toBe(shipped[provider][role].model);
      }
    }
    expect(config.shorthand.sonnet).toBe(shipped.shorthand.sonnet);
    expect(config._source).toBe('model catalog (fallback)');
  });

  it('skips malformed layers without losing the shipped pins', () => {
    put('models.json', '{broken');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = loadModelConfig(repo);
    expect(config.claude).toEqual(shipped.claude);
    expect(config._source).not.toContain('project');
    expect(warn).toHaveBeenCalledOnce();
  });

  it.each([false, true])('legacy Devin Desktop deploy inherits pins with shorthand override=%s', override => {
    const source = join(root, 'source');
    put(`source/${defaultsPath}`, shipped);
    put('source/agentic/code/addons/fixture/agents/ordinary.md',
      '---\nname: ordinary\ndescription: Fixture\nmodel: sonnet\ntools: Read\n---\nFixture.\n');
    mkdirSync(join(root, 'target'));
    put('models.json', { defaults: { workerSelection }, ...(override ? { shorthand: { sonnet: 'project-sonnet' } } : {}) });
    const output = execFileSync(process.execPath,
      ['--import', import.meta.resolve('tsx'), join(repo, 'tools/agents/deploy-windsurf.mjs'),
        '--source', source, '--target', join(root, 'target'), '--mode', 'general'],
      { cwd: root, encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, AIWG_ROOT: source, HOME: home, USERPROFILE: home,
          XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache') } });
    expect(output).toContain('AIWG defaults');
    expect(output).toContain(`project (${join(root, 'models.json')})`);
    expect(readFileSync(join(root, 'target/AGENTS.md'), 'utf8'))
      .toContain(`**Model**: ${override ? 'project-sonnet' : shipped.shorthand.sonnet}`);
  });
});
