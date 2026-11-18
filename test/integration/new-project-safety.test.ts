// Exercise scaffold safety through the built launcher, including startup and telemetry.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const cli = resolve('bin/aiwg.mjs');
let root: string;
let project: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aiwg-new-built-'));
  project = join(root, 'project'); home = join(root, 'home');
  mkdirSync(join(project, '.aiwg'), { recursive: true }); mkdirSync(home);
  writeFileSync(join(project, '.aiwg', 'aiwg.config'), JSON.stringify({ version: '1',
    command_log: { enabled: true, scopes: ['project', 'global'] },
    telemetry: { skill_usage: { enabled: true, scopes: ['project', 'global'] } } }));
  writeFileSync(join(project, 'keep.txt'), 'existing content');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? Object.entries(snapshot(join(dir, entry.name))).map(([name, body]) => [`${entry.name}/${name}`, body])
      : [[entry.name, readFileSync(join(dir, entry.name), 'utf8')]]));
}
function run(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: project, encoding: 'utf8', timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local/share'), XDG_STATE_HOME: join(home, '.local/state'),
      AIWG_TRACE_STARTUP: '1', NO_COLOR: '1' },
  });
}
describe('built new command (#4278)', () => {
  it('still scaffolds an explicitly selected non-empty current directory', () => {
    const result = run(['new', '.', '--no-agents']);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(join(project, 'keep.txt'), 'utf8')).toBe('existing content');
    expect(readFileSync(join(project, 'WORKSPACE.md'), 'utf8')).toContain('Project Context');
    expect(readdirSync(project)).toContain('.git');
  });
  it.each([
    { args: ['new', '--list-templates'], status: 0, message: 'sdlc' },
    { args: ['-new', '--unknown', '--no-agents'], status: 2, message: 'Unknown option' },
    { args: ['--new', '--no-agents'], status: 2, message: 'aiwg new .' },
  ])('keeps project and home unchanged for $args', ({ args, status, message }) => {
    const before = snapshot(project);
    const result = run(args);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(status);
    expect(result.stdout + result.stderr).toContain(message);
    expect(result.stderr).toContain('notifier:skip (read-only report)');
    expect(snapshot(project)).toEqual(before);
    expect(readdirSync(home)).toEqual([]);
  });
});
