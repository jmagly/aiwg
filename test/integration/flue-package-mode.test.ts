// Pin the public launcher and implementation resolver to this checkout's compiled CLI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
const ROOT = path.resolve(import.meta.dirname, '../..');
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-bundle-cli-')); temporary.push(scratch);
  const project = path.join(scratch, 'project'), home = path.join(scratch, 'home');
  fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(path.join(home, '.aiwg'), { recursive: true });
  fs.writeFileSync(path.join(home, '.aiwg/channel.json'), JSON.stringify({ channel: 'edge', edgePath: ROOT, devMode: true, checkOnStartup: false }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, AIWG_CONFIG: path.join(home, '.aiwg'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.state'),
    AIWG_ROOT: ROOT, AIWG_RESOLVE_IMPL_FROM: 'dist', AIWG_SKIP_ACTIVITY_LOG: '1', NO_UPDATE_NOTIFIER: '1' };
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR', 'AIWG_USER_REGISTRY_PATH']) delete env[key];
  const command = (...args: string[]) => {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'bin/aiwg.mjs'), ...args], {
      cwd: project, env, encoding: 'utf8', timeout: 600_000, maxBuffer: 16 * 1024 * 1024,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}\n${result.error || ''}`).toBe(0);
    expect(result.stderr).not.toContain('Source checkout detected');
    if (args[0] === 'use' && args.includes('--json')) expect(JSON.parse(result.stdout).frameworkRoot).toBe(ROOT);
    return `${result.stdout}\n${result.stderr}`;
  };
  const readConfig = () => JSON.parse(fs.readFileSync(path.join(project, '.aiwg/aiwg.config'), 'utf8'));
  const writeConfig = (config: unknown) => fs.writeFileSync(path.join(project, '.aiwg/aiwg.config'), JSON.stringify(config, null, 2));
  const plans = (provider: string) => ['refresh', 'update'].map(action => command(action, '--dry-run', '--provider', provider, action === 'update' ? '--skip-check' : '--skip-update'));
  const snapshot = () => {
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
    return Object.fromEntries(walk(project).map(file => [path.relative(project, file), fs.readFileSync(file).toString('base64')]));
  };
  return { project, command, plans, readConfig, writeConfig, snapshot };
}
it.each(['voice-framework', 'sdlc'])('imports %s package skills headlessly and retains package mode on update and refresh', bundle => {
  const { project, command, readConfig } = setup();
  command('use', bundle, '--provider', 'flue', '--package', '--no-project-local');
  const check = () => {
    expect(readConfig().installed[bundle].deployedTo.flue.package).toBe(true);
    expect(fs.readFileSync(path.join(project, 'src/aiwg/tools.ts'), 'utf8')).toContain("export * from '@aiwg/flue/tools/node'");
    const skills = fs.readFileSync(path.join(project, 'src/aiwg/skills.ts'), 'utf8');
    expect(skills).toContain(`from '@aiwg/flue/skills/${bundle === 'sdlc' ? 'sdlc-quickref' : 'voice-apply'}/SKILL.md'`);
    expect(skills).not.toContain('../../.agents/skills');
    expect(fs.existsSync(path.join(project, '.agents/skills'))).toBe(false);
  };
  check();
  command('update', '--skip-check', '--provider', 'flue'); check();
  command('refresh', '--skip-update', '--provider', 'flue'); check();
}, 600_000);
