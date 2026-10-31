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
  const snapshot = () => {
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
    return Object.fromEntries(walk(project).map(file => [path.relative(project, file), fs.readFileSync(file).toString('base64')]));
  };
  return { project, command, snapshot };
}

describe('public experimental Flue app deployment', () => {
  it.each([false, true])('stages the Cloudflare target and restores files on removal (package: %s)', packaged => {
    const { project, command, snapshot } = setup();
    fs.writeFileSync(path.join(project, 'flue.config.ts'), "export default { target: 'cloudflare' };\n");
    fs.writeFileSync(path.join(project, 'wrangler.jsonc'), '{ "name": "synthetic-worker" }\n');
    const before = snapshot();
    command('use', 'sdlc', '--provider', 'flue', ...(packaged ? ['--package'] : []));
    expect(fs.existsSync(path.join(project, 'src/db.ts'))).toBe(false);
    const tools = fs.readFileSync(path.join(project, 'src/aiwg/tools.ts'), 'utf8');
    expect(tools).toContain('getCloudflareContext');
    expect(tools).not.toMatch(/stdio|tools\/node|node:/);
    expect(tools).toContain(packaged ? '@aiwg/flue/tools' : 'defineMcpConnection');
    if (!packaged) expect(fs.readFileSync(path.join(project, 'src/aiwg/remote-specialist.js'), 'utf8')).toContain('createMcpConnection');
    command('remove', 'sdlc');
    const after = snapshot();
    for (const [name, bytes] of Object.entries(before)) expect(after[name], name).toBe(bytes);
    for (const name of ['src/db.ts', '.gitignore', 'AGENTS.md', 'WORKSPACE.md', 'AIWG.md',
      'src/aiwg/tools.ts', 'src/aiwg/skills.ts', 'src/aiwg/specialists.ts',
      'src/aiwg/remote-specialist.js', 'src/aiwg/remote-specialist.d.ts']) expect(after[name], name).toBeUndefined();
    expect(fs.existsSync(path.join(project, '.agents'))).toBe(false);
  }, 900_000);

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
    expect(skills).not.toContain('aiwg-utils-quickref');
    expect(skills).toContain('security-assessment');
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
    for (const file of ['src/aiwg/tools.ts', 'src/aiwg/specialists.ts', 'src/aiwg/skills.ts']) {
      expect(fs.existsSync(path.join(project, file))).toBe(true);
      expect(receipt.managed[file]).toMatchObject({ owners: ['sdlc-complete'], filePreimage: { present: false } });
    }
    if (operatorDatabase) expect(receipt.managed['src/db.ts']).toBeUndefined();
    else expect(receipt.managed['src/db.ts'].owners).toEqual(['sdlc-complete']);
    command('remove', 'sdlc');
    for (const file of ['src/aiwg/tools.ts', 'src/aiwg/specialists.ts', 'src/aiwg/skills.ts']) expect(fs.existsSync(path.join(project, file))).toBe(false);
    for (const [name, bytes] of Object.entries(initial)) expect(fs.readFileSync(path.join(project, name), 'utf8')).toBe(bytes);
    if (operatorDatabase) expect(fs.readFileSync(path.join(project, 'src/db.ts'), 'utf8')).toBe('// Operator database\n');
    else expect(fs.existsSync(path.join(project, 'src/db.ts'))).toBe(false);
    for (const name of ['.agents', '.flue', '.flue-state', 'AIWG.md', 'WORKSPACE.md']) expect(fs.existsSync(path.join(project, name)), name).toBe(false);
  }, 900_000);
  it('declares, deploys and prunes exactly the selected Flue bundles without losing edits', () => {
    const { project, command, snapshot } = setup();
    command('use', 'sdlc', '--provider', 'flue', '--declare');
    command('use', 'voice-framework', '--provider', 'flue', '--declare');
    const configFile = path.join(project, '.aiwg/aiwg.config');
    const config = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
    expect(config().installed).toEqual({ sdlc: { deployedTo: { flue: {} } }, 'voice-framework': { deployedTo: { flue: {} } } });
    expect(fs.existsSync(path.join(project, '.agents'))).toBe(false);
    const before = snapshot();
    const preview = command('refresh', '--skip-update', '--dry-run');
    expect(preview).toContain('sdlc for flue');
    expect(preview).toContain('voice-framework for flue');
    expect(snapshot()).toEqual(before);
    command('refresh', '--skip-update');
    const bundleSkills = (group: string, bundle: string) => fs.readdirSync(path.join(ROOT, 'agentic/code', group, bundle, 'skills'))
      .filter(name => fs.existsSync(path.join(ROOT, 'agentic/code', group, bundle, 'skills', name, 'SKILL.md'))).sort();
    const sdlc = bundleSkills('frameworks', 'sdlc-complete'), voice = bundleSkills('addons', 'voice-framework');
    expect(fs.readdirSync(path.join(project, '.agents/skills')).sort()).toEqual([...new Set([...sdlc, ...voice])].sort());
    expect(config().installed.sdlc).toHaveProperty('version');
    expect(config().installed['voice-framework'].deployedTo.flue.skills).toBeGreaterThan(0);
    const module = () => fs.readFileSync(path.join(project, 'src/aiwg/skills.ts'), 'utf8');
    for (const name of [...sdlc, ...voice]) expect(module()).toContain(`from '../../.agents/skills/${name}/SKILL.md'`);
    expect(module()).toContain('export const voiceFrameworkSkills');
    expect(module()).not.toContain('aiwg-utils');
    expect(fs.readFileSync(path.join(project, 'src/aiwg/specialists.ts'), 'utf8')).toContain('export const codeReviewer');
    const edited = path.join(project, '.agents/skills', voice[0], 'SKILL.md');
    fs.appendFileSync(edited, '\nOperator voice policy.\n');
    const editedBytes = fs.readFileSync(edited, 'utf8');
    // Hand edits and --declare removal both express the same intent.
    const value = config(); delete value.installed['voice-framework'];
    fs.writeFileSync(configFile, JSON.stringify(value));
    const beforePrune = snapshot();
    const prunePreview = command('update', '--skip-check', '--dry-run');
    expect(prunePreview).toContain('Would remove voice-framework for flue');
    expect(snapshot()).toEqual(beforePrune);
    const pruned = command('refresh', '--skip-update');
    expect(pruned).toMatch(/Preserve .*SKILL.md.*modified/);
    expect(fs.readFileSync(edited, 'utf8')).toBe(editedBytes);
    for (const name of voice.slice(1)) expect(fs.existsSync(path.join(project, '.agents/skills', name))).toBe(false);
    for (const name of voice) expect(module()).not.toContain(`.agents/skills/${name}/SKILL.md`);
    expect(module()).not.toContain('voiceFrameworkSkills');
    expect(Object.keys(config().installed)).toEqual(['sdlc']);
  }, 900_000);

  it.each(['voice-framework', 'decision-engine'])('supports %s alone and undeclares without touching deployed files', bundle => {
    const { project, command, snapshot } = setup();
    command('use', bundle, '--provider', 'flue', '--json');
    const before = snapshot();
    expect(fs.readdirSync(path.join(project, '.agents/skills'))).not.toContain('aiwg-utils-quickref');
    expect(fs.readFileSync(path.join(project, 'src/aiwg/specialists.ts'), 'utf8')).not.toContain('export const codeReviewer');
    command('remove', bundle, '--provider', 'flue', '--declare');
    const after = snapshot();
    for (const [name, bytes] of Object.entries(before)) if (!name.endsWith('aiwg.config')) expect(after[name]).toBe(bytes);
    expect(JSON.parse(fs.readFileSync(path.join(project, '.aiwg/aiwg.config'), 'utf8')).installed).toEqual({});
    command('update', '--skip-check');
    expect(fs.existsSync(path.join(project, '.agents/skills'))).toBe(false);
    expect(fs.existsSync(path.join(project, 'src/aiwg/skills.ts'))).toBe(false);
  }, 900_000);

  it.each(['claude', 'codex'])('keeps matching %s provider payloads byte-identical on update', provider => {
    const { command, snapshot } = setup();
    command('use', 'voice-framework', '--provider', provider, '--json');
    const payload = () => Object.fromEntries(Object.entries(snapshot()).filter(([name]) => name.startsWith(`.${provider}/`) || name.startsWith('.agents/')));
    const before = payload();
    expect(Object.keys(before).length).toBeGreaterThan(5);
    command('update', '--skip-check', '--provider', provider);
    expect(payload()).toEqual(before);
  }, 900_000);

  it('regenerates shared skill imports immediately after ordinary bundle removal', () => {
    const { project, command } = setup();
    command('use', 'sdlc', '--provider', 'flue', '--json');
    command('use', 'voice-framework', '--provider', 'flue', '--json');
    expect(fs.readFileSync(path.join(project, 'src/aiwg/skills.ts'), 'utf8')).toContain('voiceFrameworkSkills');
    command('remove', 'voice-framework', '--provider', 'flue');
    const module = fs.readFileSync(path.join(project, 'src/aiwg/skills.ts'), 'utf8');
    expect(module).toContain('sdlcSkills');
    expect(module).not.toContain('voiceFrameworkSkills');
    expect(fs.readdirSync(path.join(project, '.agents/skills'))).not.toContain('output-mode-guide');
  }, 900_000);

  it.each(['claude', 'codex'])('plans zero removals for %s framework additive owners through both CLI commands', provider => {
    const { project, command, snapshot } = setup();
    // A private channel config pins router/corpus resolution; this assertion
    // catches an accidental redirect to the operator's installed runtime.
    const fingerprint = JSON.parse(command('version', '--json'));
    expect(fs.realpathSync(fingerprint.runtimePath)).toBe(fs.realpathSync(ROOT));
    expect(fs.realpathSync(fingerprint.packageRoot)).toBe(fs.realpathSync(ROOT));
    command('use', 'sdlc', '--provider', provider, '--json');
    const config = JSON.parse(fs.readFileSync(path.join(project, '.aiwg/aiwg.config'), 'utf8'));
    expect(Object.keys(config.installed)).toEqual(['sdlc']);
    const before = snapshot();
    for (const args of [['refresh', '--skip-update'], ['update', '--skip-check']]) {
      const output = command(...args, '--dry-run', '--provider', provider);
      expect(output).not.toMatch(/Would remove|Removing /);
      expect(output).toContain(`aiwg use sdlc --provider ${provider}`);
      expect(snapshot()).toEqual(before);
    }
  }, 900_000);

  it('plans exactly the dropped standalone Claude voice bundle through both CLI commands', () => {
    const { project, command, snapshot } = setup();
    command('use', 'voice-framework', '--provider', 'claude', '--declare');
    command('update', '--skip-check', '--provider', 'claude');
    const paths = (output: string) => [...output.matchAll(/^\s+Would remove (.+) — /gm)].map(match => match[1]).sort();
    const declaredRemoval = command('remove', 'voice-framework', '--provider', 'claude', '--dry-run');
    const expected = paths(declaredRemoval);
    const summary = declaredRemoval.match(/Would remove \d+ unchanged recorded file\(s\)/)![0];
    expect(expected.length).toBeGreaterThan(0);
    command('remove', 'voice-framework', '--provider', 'claude', '--declare');
    const before = snapshot();
    for (const args of [['refresh', '--skip-update'], ['update', '--skip-check']]) {
      const output = command(...args, '--dry-run', '--provider', 'claude');
      expect([...output.matchAll(/^Would remove (.+) for (.+)$/gm)].map(match => [match[1], match[2]])).toEqual([['voice-framework', 'claude']]);
      expect(paths(output)).toEqual(expected);
      expect(output).toContain(summary);
      expect(snapshot()).toEqual(before);
    }
    expect(JSON.parse(fs.readFileSync(path.join(project, '.aiwg/aiwg.config'), 'utf8')).installed).toEqual({});
  }, 900_000);

});
