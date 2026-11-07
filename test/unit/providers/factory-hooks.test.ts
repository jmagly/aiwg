// Factory 1.0 hook registration, migration and stdout context contracts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { deployFactoryHooks } from '../../../tools/agents/providers/factory-hooks.mjs';
import { installFactoryPromptDiscovery, managedFactoryHooks } from '../../../src/smiths/hook-bridge/factory-translator.js';

const frameworkRoot = path.resolve(import.meta.dirname, '../../..');
let root: string;
let home: string;
let project: string;
function write(file: string, doc: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc));
}
function read(file: string) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
const operator = { matcher: 'operator', hooks: [{ type: 'command', command: 'echo operator' }] };
const old = { type: 'command', command: 'aiwg sync --dry-run --quiet' };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-factory-hooks-'));
  home = path.join(root, 'home');
  project = path.join(root, "project's $literal");
  fs.mkdirSync(project, { recursive: true });
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_DATA_HOME', path.join(root, 'data'));
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

describe('Factory hook installation', () => {
  it('deploys project prompt discovery and preflight, preserves user groups and records ownership', async () => {
    const file = path.join(project, '.factory/hooks.json');
    write(file, { operatorSetting: 42, hooks: { UserPromptSubmit: [operator], SessionStart: [operator] } });
    await deployFactoryHooks(false, project);
    await deployFactoryHooks(false, project);
    const doc = read(file);
    expect(doc.operatorSetting).toBe(42);
    // droid reads hooks.json as a top-level event map; a nested `hooks` key is ignored by droid.
    expect(doc.hooks).toBeUndefined();
    for (const hook of managedFactoryHooks()) {
      expect(doc[hook.event]).toHaveLength(2);
      expect(doc[hook.event][0]).toEqual(operator);
      expect(doc[hook.event][1].hooks[0]).toMatchObject({
        command: hook.command, _aiwg_id: hook.id, _aiwg_managed: true,
      });
    }
    const copied = path.join(project, '.factory/hooks/aiwg-prompt-discovery.cjs');
    expect(fs.readFileSync(copied)).toEqual(fs.readFileSync(path.join(frameworkRoot,
      'agentic/code/addons/aiwg-hooks/hooks/aiwg-prompt-discovery.cjs')));
    const receipt = read(path.join(project, '.factory/.aiwg-manifest.json'));
    const scripts = read(path.join(project, '.factory/hooks/.aiwg-manifest.json'));
    expect(scripts.managed['aiwg-prompt-discovery.cjs'].owners).toContain('aiwg-hooks');
    expect(receipt.managed['hooks.json']).toBeDefined();
    expect(fs.existsSync(path.join(project, '.factory/settings.json'))).toBe(false);
    // The project hooks.json carries the preflight; user hooks are left untouched.
    expect(fs.existsSync(path.join(home, '.factory/hooks.json'))).toBe(false);
  });

  it('moves an old user-level AIWG preflight out on a project deploy without adding a second one', async () => {
    const settings = path.join(home, '.factory/settings.json');
    write(settings, { hooks: { SessionStart: [{ matcher: '*', hooks: [old] }], PreToolUse: [operator] } });
    await deployFactoryHooks(false, project);
    const user = read(path.join(home, '.factory/hooks.json'));
    expect(user.SessionStart ?? []).toEqual([]);
    expect(user.PreToolUse).toEqual([operator]);
    expect(read(path.join(project, '.factory/hooks.json')).SessionStart.at(-1).hooks[0].command)
      .toBe('aiwg refresh --dry-run --quiet');
  });

  it('migrates only AIWG settings entries while retaining mixed user entries and existing hooks.json', async () => {
    const settings = path.join(home, '.factory/settings.json');
    const file = path.join(home, '.factory/hooks.json');
    write(settings, { operatorSetting: 42, hooks: {
      SessionStart: [{ matcher: '*', hooks: [old, ...operator.hooks] }], UserPromptSubmit: [operator],
    } });
    write(file, { hooks: { SessionStart: [operator] } });
    await deployFactoryHooks(false);
    expect(read(settings)).toEqual({ operatorSetting: 42, hooks: {
      SessionStart: [{ matcher: '*', hooks: operator.hooks }], UserPromptSubmit: [operator],
    } });
    expect(read(file).SessionStart).toHaveLength(2);
    expect(read(file).SessionStart[0]).toEqual(operator);
  });

  it('transfers other tagged AIWG entries out of settings even when hooks.json exists', async () => {
    const managed = { type: 'command', command: 'echo managed', _aiwg_managed: true, _aiwg_id: 'other-aiwg-hook' };
    const settings = path.join(home, '.factory/settings.json');
    const file = path.join(home, '.factory/hooks.json');
    write(settings, { hooks: { Stop: [{ matcher: '*', hooks: [managed, ...operator.hooks] }] } });
    write(file, { hooks: { Stop: [operator] } });
    await deployFactoryHooks(false);
    expect(read(settings).hooks.Stop).toEqual([{ matcher: '*', hooks: operator.hooks }]);
    expect(read(file).Stop).toEqual([operator, { matcher: '*', hooks: [managed] }]);
  });

  it('copies user fallback hooks when creating hooks.json and migrates legacy hooks/hooks.json', async () => {
    write(path.join(home, '.factory/settings.json'), { hooks: { SessionStart: [{ hooks: [old] }], Stop: [operator] } });
    await deployFactoryHooks(false);
    expect(read(path.join(home, '.factory/hooks.json')).Stop).toEqual([operator]);
    const legacy = path.join(project, '.factory/hooks/hooks.json');
    write(legacy, { hooks: { UserPromptSubmit: [operator], SessionStart: [{ hooks: [old] }] } });
    await deployFactoryHooks(false, project);
    expect(read(path.join(project, '.factory/hooks.json')).UserPromptSubmit[0]).toEqual(operator);
    expect(read(path.join(project, '.factory/hooks.json')).SessionStart).toHaveLength(1);
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it('dry run leaves settings, scripts and registrations unchanged', async () => {
    const file = path.join(home, '.factory/settings.json');
    write(file, { hooks: { SessionStart: [{ hooks: [old] }] } });
    const before = fs.readFileSync(file, 'utf8');
    await deployFactoryHooks(true, project);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(home, '.factory/hooks.json'))).toBe(false);
    expect(fs.existsSync(path.join(project, '.factory'))).toBe(false);
  });

  it('refuses malformed documents without removing legacy registrations', async () => {
    const file = path.join(home, '.factory/hooks.json');
    const settings = path.join(home, '.factory/settings.json');
    write(file, '{broken');
    write(settings, { hooks: { SessionStart: [{ hooks: [old] }] } });
    await expect(deployFactoryHooks(false)).rejects.toThrow();
    expect(read(settings).hooks.SessionStart[0].hooks).toEqual([old]);
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
  });
});

describe('Factory context output', () => {
  it.each(['nested', 'top-level'])('delivers %s additionalContext as stdout from a nested cwd', async shape => {
    await installFactoryPromptDiscovery({ projectPath: project, frameworkRoot });
    const script = path.join(project, '.factory/hooks/aiwg-prompt-discovery.cjs');
    const output = shape === 'nested' ? { hookSpecificOutput: { additionalContext: 'AIWG candidates: fixture' } }
      : { additionalContext: 'AIWG candidates: fixture' };
    write(script, `process.stdout.write(${JSON.stringify(JSON.stringify(output))});`);
    const cwd = path.join(project, 'nested');
    fs.mkdirSync(cwd);
    expect(execFileSync('/bin/sh', ['-c', managedFactoryHooks()[1].command], {
      cwd, encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH },
    })).toBe('AIWG candidates: fixture');
  });

  it('runs the unchanged shared discovery script offline and appends readable candidates', async () => {
    await installFactoryPromptDiscovery({ projectPath: project, frameworkRoot });
    const runtime = path.join(root, 'runtime');
    write(path.join(runtime, 'package.json'), { type: 'module' });
    write(path.join(runtime, 'dist/src/artifacts/query-engine-discover.js'),
      'export async function discoverCapability(){console.log(JSON.stringify({results:[{type:"skill",name:"fixture",score:0.9,capability:"Fixture discovery"}]}));}');
    const output = execFileSync('/bin/sh', ['-c', managedFactoryHooks()[1].command], {
      cwd: project, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'help inspect factory hooks' }),
      timeout: 5000, env: { PATH: process.env.PATH, AIWG_ROOT: runtime },
    });
    expect(output).toContain('AIWG candidates:');
    expect(output).toContain('skill fixture');
    expect(output).not.toContain('hookSpecificOutput');
  });
});
