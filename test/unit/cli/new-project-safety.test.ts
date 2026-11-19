// Prevent read-only probes and malformed scaffold requests from modifying a workspace.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { newProjectHandler } from '../../../src/cli/handlers/subcommands-plugins.js';

vi.mock('../../../src/channel/manager.mjs', () => ({ getFrameworkRoot: async () => process.cwd() }));
vi.mock('../../../src/cli/handlers/script-runner.js', () => ({
  createScriptRunner: () => ({ run: async () => ({ exitCode: 0 }) }),
}));
vi.mock('../../../src/community/nudge-policy.js', () => ({ shouldShowNudge: () => false, markNudgeShown: () => {} }));

const script = resolve('tools/install/new-project.mjs');
let root: string;
let project: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aiwg-new-safety-'));
  project = join(root, 'project'); home = join(root, 'home');
  mkdirSync(project); mkdirSync(home);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function scaffold(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: project, encoding: 'utf8', timeout: 20_000,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'),
      AIWG_NO_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1', AIWG_RESOLVE_IMPL_FROM: 'src' },
  });
}

describe('new project safety (#4278)', () => {
  it('lists the supported templates without creating files', () => {
    const result = scaffold(['--list-templates', '--no-agents']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('sdlc');
    expect(readdirSync(project)).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  });

  it.each([['--unknown'], ['--list-templates', '--unknown'], ['--provider'], ['--name']])(
    'rejects malformed arguments %j without writes', (...args) => {
      const result = scaffold([...args, '--no-agents']);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Unknown option|requires a value/);
      expect(readdirSync(project)).toEqual([]);
    },
  );

  it.each([[], ['named-project'], ['--name', 'named-project']])(
    'refuses a non-empty directory without explicit dot: %j', (...args) => {
      writeFileSync(join(project, 'keep.txt'), 'preserve me');
      const result = scaffold([...args, '--no-agents']);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('aiwg new .');
      expect(readdirSync(project)).toEqual(['keep.txt']);
      expect(readFileSync(join(project, 'keep.txt'), 'utf8')).toBe('preserve me');
    },
  );

  it.each([[], ['.']])('allows an empty directory or explicit dot: %j', (...args) => {
    if (args.length) writeFileSync(join(project, 'keep.txt'), 'preserve me');
    const result = scaffold([...args, '--no-agents']);
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(project)).toContain('.aiwg');
    if (args.length) expect(readFileSync(join(project, 'keep.txt'), 'utf8')).toBe('preserve me');
  });

  it('does not finalize workspace context after a template listing', async () => {
    const result = await newProjectHandler.execute({ args: ['--list-templates'], rawArgs: ['new', '--list-templates'],
      cwd: project, frameworkRoot: process.cwd() });
    expect(result.exitCode).toBe(0);
    expect(readdirSync(project)).toEqual([]);
  });
});

describe('new project copy flags (#4279 with #4278)', () => {
  it('accepts --copy and --copy-all and defaults to indexed discovery', async () => {
    const { parseNewProjectArgs } = await import('../../../src/cli/new-project-options.js');
    // The per-test project directory is empty and removed in afterEach.
    const empty = project;
    expect(parseNewProjectArgs([], empty).copy).toBe(false);
    expect(parseNewProjectArgs(['--copy'], empty).copy).toBe(true);
    expect(parseNewProjectArgs(['--copy-all'], empty).copy).toBe(true);
  });
});
