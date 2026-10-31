// Exercise public Flue deploy/remove without importing Flue or starting a model.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
const ROOT = path.resolve(import.meta.dirname, '../..');
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-flue-cli-')); temporary.push(scratch);
  const project = path.join(scratch, 'project'), home = path.join(scratch, 'home');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.mkdirSync(path.join(home, '.aiwg'), { recursive: true });
  fs.writeFileSync(path.join(home, '.aiwg/channel.json'), JSON.stringify({ channel: 'edge', edgePath: ROOT, devMode: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.state'),
    AIWG_CONFIG: path.join(home, '.aiwg'), AIWG_USER_REGISTRY_PATH: path.join(home, '.aiwg/installed.json'),
    AIWG_ROOT: ROOT, AIWG_RESOLVE_IMPL_FROM: 'dist', AIWG_SKIP_ACTIVITY_LOG: '1', NO_UPDATE_NOTIFIER: '1' };
  delete env.AIWG_ARTIFACTS_PATH;
  const command = (...args: string[]) => {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'bin/aiwg.mjs'), ...args], {
      cwd: project, env, encoding: 'utf8', timeout: 600_000, maxBuffer: 16 * 1024 * 1024,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}\n${result.error || ''}`).toBe(0);
    return `${result.stdout}\n${result.stderr}`;
  };
  return { project, command };
}

describe('public experimental Flue app deployment', () => {
  it.each([false, true])('removes every deployed payload and preserves operator files (operator database: %s)', operatorDatabase => {
    const { project, command } = setup();
    const initial = { 'src/app.ts': 'export const operatorApp = true;\n',
      'AGENTS.md': '# Operator instructions\nKeep this policy.  \n', '.gitignore': 'dist/' };
    for (const [name, bytes] of Object.entries(initial)) fs.writeFileSync(path.join(project, name), bytes);
    if (operatorDatabase) fs.writeFileSync(path.join(project, 'src/db.ts'), '// Operator database\n');
    const output = command('use', 'sdlc', '--provider', 'flue', '--scope', 'project', '--no-project-local', '--json');
    expect(output).toContain('flue');
    const context = fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8');
    expect(context).toContain('anti-laziness');
    expect(context).toContain('no-attribution');
    expect(context).toContain('Keep this policy.');
    expect(context).not.toContain('Read and follow [WORKSPACE.md]');
    expect(fs.readFileSync(path.join(project, '.gitignore'), 'utf8')).toBe('dist/\n.flue-state/\n');
    expect(fs.existsSync(path.join(project, '.flue'))).toBe(false);
    expect(fs.existsSync(path.join(project, 'src/db.ts'))).toBe(true);
    const skills = fs.readdirSync(path.join(project, '.agents/skills'));
    expect(skills).toContain('sdlc-quickref');
    expect(skills).toContain('aiwg-utils-quickref');
    for (const skill of skills) {
      const bytes = fs.readFileSync(path.join(project, '.agents/skills', skill, 'SKILL.md'), 'utf8');
      const metadata = parse(bytes.match(/^---\n([\s\S]*?)\n---/)![1]);
      expect(metadata.name).toBe(skill);
      expect(metadata.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(metadata.name.length).toBeLessThanOrEqual(64);
      expect(metadata.description.length).toBeGreaterThan(0);
      expect(metadata.description.length).toBeLessThanOrEqual(1024);
      const receipt = JSON.parse(fs.readFileSync(path.join(project, '.agents/skills', skill, '.aiwg-manifest.json'), 'utf8'));
      expect(receipt.managed['SKILL.md'].owners).toEqual(['sdlc-complete']);
    }
    const receipt = JSON.parse(fs.readFileSync(path.join(project, '.aiwg/.aiwg-manifest.json'), 'utf8'));
    if (operatorDatabase) expect(receipt.managed['src/db.ts']).toBeUndefined();
    else expect(receipt.managed['src/db.ts'].owners).toEqual(['sdlc-complete']);
    command('remove', 'sdlc');
    for (const [name, bytes] of Object.entries(initial)) expect(fs.readFileSync(path.join(project, name), 'utf8')).toBe(bytes);
    if (operatorDatabase) expect(fs.readFileSync(path.join(project, 'src/db.ts'), 'utf8')).toBe('// Operator database\n');
    else expect(fs.existsSync(path.join(project, 'src/db.ts'))).toBe(false);
    for (const name of ['.agents', '.flue', '.flue-state', 'AIWG.md', 'WORKSPACE.md']) expect(fs.existsSync(path.join(project, name)), name).toBe(false);
  }, 900_000);
});
