// Real deploy/remove round trips in isolated project and HOME directories.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { emptyConfig, readAiwgConfig, writeAiwgConfig } from '../../src/config/aiwg-config.js';
import { afterEach, describe, expect, it } from 'vitest';
const ROOT = path.resolve(import.meta.dirname, '../..');
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function files(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(path.join(root, entry.name)) : entry.isFile() ? [path.join(root, entry.name)] : []);
}
function records(project: string): Map<string, any> {
  const result = new Map();
  for (const file of files(project).filter(file => path.basename(file) === '.aiwg-manifest.json')) {
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    const base = receipt.scope === 'project' && path.dirname(file) === path.join(project, '.aiwg') ? project : path.dirname(file);
    for (const [name, record] of Object.entries(receipt.managed || {})) result.set(path.resolve(base, name), record);
  }
  return result;
}
function setup(audit = true) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-remove-integration-')); temporary.push(scratch);
  const project = path.join(scratch, 'project'), home = path.join(scratch, 'home');
  fs.mkdirSync(project); fs.mkdirSync(path.join(home, '.aiwg'), { recursive: true });
  fs.writeFileSync(path.join(home, '.aiwg/channel.json'), JSON.stringify({ channel: 'edge', edgePath: ROOT, devMode: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.state'),
    AIWG_CONFIG: path.join(home, '.aiwg'), AIWG_USER_REGISTRY_PATH: path.join(home, '.aiwg/installed.json'),
    AIWG_ROOT: ROOT, AIWG_RESOLVE_IMPL_FROM: 'dist', NO_UPDATE_NOTIFIER: '1' };
  delete env.AIWG_ARTIFACTS_PATH;
  // The independent command audit sink is outside a file deployment round trip.
  if (!audit) env.AIWG_SKIP_ACTIVITY_LOG = '1';
  const command = (script: string, args: string[]) => {
    const result = spawnSync(process.execPath, [path.isAbsolute(script) ? script : path.join(ROOT, script), ...args], {
      cwd: project, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}\n${result.error || ''}`).toBe(0);
    return result.stdout;
  };
  return { project, scratch, command };
}
function write(root: string, file: string, value: string) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), value);
}

describe('receipt-backed removal after deployment (#3769)', () => {

  it('restores Claude settings and managed hooks after public sdlc/marketing deployment and removal', () => {
    const { project, command } = setup(false);
    const settingsFile = path.join(project, '.claude/settings.json');
    const original = '{\n\t"theme": "operator", "hooks": { "SessionStart": [{"hooks": [{"type": "command", "command": "operator"}]}] }\n}\n';
    write(project, '.claude/settings.json', original);
    const deploy = (bundle: string) => command('bin/aiwg.mjs', ['use', bundle, '--provider', 'claude',
      '--target', project, '--scope', 'project', '--copy-all', '--no-project-local', '--json']);
    deploy('sdlc');
    const sdlcSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    expect(sdlcSettings.aiwg.mode).toBeUndefined();
    expect(Object.values(sdlcSettings.hooks).flat().some((group: any) => group.hooks.some((hook: any) => hook._aiwg_managed))).toBe(true);
    deploy('marketing');
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).aiwg.mode).toBeUndefined();
    const deployed = fs.readFileSync(settingsFile);
    const preview = command('bin/aiwg.mjs', ['remove', 'marketing', '--dry-run']);
    expect(preview).toContain('settings.json#/attribution/');
    expect(fs.readFileSync(settingsFile)).toEqual(deployed);
    command('bin/aiwg.mjs', ['remove', 'marketing']);
    const remaining = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    expect(remaining.aiwg.mode).toBeUndefined();
    expect(remaining.hooks).toEqual(sdlcSettings.hooks);
    command('bin/aiwg.mjs', ['remove', 'sdlc']);
    expect(fs.readFileSync(settingsFile, 'utf8')).toBe(original);
    expect(records(project).get(settingsFile)).toBeUndefined();
  }, 240_000);

  it('removes exactly sdlc-owned recorded files after real sdlc and marketing deploys', () => {
    const { project, command } = setup();
    write(project, '.claude/agents/operator.md', 'Operator instructions.\n');
    for (const bundle of ['sdlc', 'marketing']) command('bin/aiwg.mjs', ['use', bundle, '--provider', 'claude',
      '--target', project, '--scope', 'project', '--copy-all', '--no-project-local', '--json']);
    const before = records(project);
    const deferred = (file: string, entry: any) => ['settings', 'hook'].includes(entry.kind)
      || ['CLAUDE.md', 'WORKSPACE.md', 'AIWG.md', 'AGENTS.md'].includes(path.basename(file));
    const owner = 'sdlc-complete';
    const owned = [...before].filter(([, entry]) => entry.owners?.includes(owner));
    const sourceAgents = files(path.join(ROOT, 'agentic/code/frameworks/sdlc-complete/agents')).filter(file => file.endsWith('.md'))
      .map(file => path.join(project, '.claude/agents', path.basename(file))).filter(file => before.get(file)?.owners?.includes(owner));
    expect(owned.filter(([, entry]) => entry.kind === 'agent').map(([file]) => file).sort()).toEqual(sourceAgents.sort());
    expect(sourceAgents.length).toBeGreaterThan(0);
    const protectedFiles = new Map([...before].filter(([, entry]) => !entry.owners?.includes(owner) || entry.owners.length > 1)
      .map(([file]) => [file, fs.readFileSync(file)]));
    const settingsFile = path.join(project, '.claude/settings.json');
    const settingsBefore = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const edited = owned.find(([, entry]) => entry.kind === 'agent')![0];
    fs.appendFileSync(edited, '\nOperator edit.\n');
    const preview = command('bin/aiwg.mjs', ['remove', 'sdlc', '--dry-run']);
    const expected = owned.filter(([file, entry]) => file !== edited && !deferred(file, entry) && entry.owners.length === 1).map(([file]) => file).sort();
    const planned = preview.split('\n').filter(line => /^\s*Would remove .* — /.test(line)).map(line => path.resolve(project, line.trim().slice('Would remove '.length).split(' — ')[0]))
      .filter(file => before.has(file)).sort();
    expect(planned).toEqual(expected);
    expect(preview).toContain('Receipt inventory:'); expect(preview).toContain('aiwg.config deployedTo:');
    const actual = command('bin/aiwg.mjs', ['remove', 'sdlc']);
    expect(actual).toContain('modified or unverifiable managed file');
    for (const file of expected) expect(fs.existsSync(file), path.relative(project, file)).toBe(false);
    for (const [file, bytes] of protectedFiles) expect(fs.readFileSync(file), path.relative(project, file)).toEqual(bytes);
    expect(fs.readFileSync(edited, 'utf8')).toContain('Operator edit.');
    expect(fs.readFileSync(path.join(project, '.claude/agents/operator.md'), 'utf8')).toBe('Operator instructions.\n');
    expect(records(project).get(edited).owners).toContain(owner);
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).aiwg.mode).toBe('sdlc');
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).hooks).toEqual(settingsBefore.hooks);
    for (const [file, entry] of records(project)) if (entry.owners?.includes(owner) && !deferred(file, entry)) {
      expect(entry).toEqual(before.get(edited));
    }
  }, 240_000);

  it.each([false, true])('restores the file tree after a file-only deploy/remove round trip (operator edit: %s)', async edited => {
    const { project, scratch, command } = setup(false);
    write(project, '.claude/agents/operator.md', 'Operator instructions.\n');
    await writeAiwgConfig(project, emptyConfig(['claude']));
    const initial = new Map(files(project).map(file => [file, fs.readFileSync(file)]));
    const source = path.join(scratch, 'agentic/code/frameworks/sdlc-complete');
    write(source, 'agents/demo.md', '---\nname: demo\ndescription: synthetic agent\n---\nAgent.\n');
    write(source, 'commands/demo.md', '---\nname: demo\ndescription: synthetic command\n---\nCommand.\n');
    write(source, 'skills/demo/SKILL.md', '---\nname: demo\ndescription: synthetic skill\n---\nSkill.\n');
    write(source, 'rules/demo.md', '---\nname: demo\ndescription: synthetic rule\n---\nRule.\n');
    // Exercise the real file deployers without invoking settings, hooks or workspace registration.
    // Those independent writers are the next release-plan item's round-trip scope.
    const script = path.join(scratch, 'file-deploy.mjs');
    fs.writeFileSync(script, `
      import * as provider from ${JSON.stringify(path.join(ROOT, 'tools/agents/providers/claude.mjs'))};
      import { captureDeploymentOutputs, recordDeploymentOutputs } from ${JSON.stringify(path.join(ROOT, 'src/providers/deployment-ownership.mjs'))};
      const target = ${JSON.stringify(project)}, source = ${JSON.stringify(source)};
      const roots = [target + '/.claude'];
      const before = captureDeploymentOutputs(roots);
      const opts = { srcRoot: source, provider: 'claude', frameworkSlug: 'sdlc-complete', deployVersion: '1', copyStandardSkills: true };
      provider.deployAgents([source + '/agents/demo.md'], target, opts);
      provider.deployCommands([source + '/commands/demo.md'], target, opts);
      provider.deploySkills([source + '/skills/demo'], target, opts);
      provider.deployRules([source + '/rules/demo.md'], target, opts);
      recordDeploymentOutputs(before, roots, { ...opts, target });
    `);
    command(script, []);
    // Direct deploy records ownership; install metadata mirrors what `use` would register.
    const received = records(project);
    const owned = [...received].filter(([, entry]) => entry.owners?.includes('sdlc-complete'));
    expect(owned.length).toBeGreaterThan(3);
    const installedConfig = (await readAiwgConfig(project))!;
    installedConfig.installed.sdlc = { version: '1', source: 'bundled', installedAt: '2026-01-01T00:00:00Z',
      deployedTo: { claude: { agents: 1, commands: 1, skills: 1, rules: 1 } } };
    await writeAiwgConfig(project, installedConfig);
    const agent = path.join(project, '.claude/agents/demo.md');
    if (edited) fs.appendFileSync(agent, '\nOperator edit.\n');
    command('bin/aiwg.mjs', ['remove', 'sdlc']);
    const remaining = files(project);
    const expected = [...initial.keys(), ...(edited ? [agent, path.join(project, '.claude/agents/.aiwg-manifest.json')] : [])].sort();
    expect(remaining.sort()).toEqual(expected);
    for (const [file, bytes] of initial) {
      if (edited && file === path.join(project, '.aiwg/aiwg.config')) {
        const expectedConfig = JSON.parse(bytes.toString());
        expectedConfig.installed.sdlc = { ...installedConfig.installed.sdlc, deployedTo: { claude: { agents: 1, commands: 0, skills: 0, rules: 0 } } };
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(expectedConfig);
      } else expect(fs.readFileSync(file)).toEqual(bytes);
    }
    if (edited) expect(fs.readFileSync(agent, 'utf8')).toContain('Operator edit.');
  }, 60_000);
});
