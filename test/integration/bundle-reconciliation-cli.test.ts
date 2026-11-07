// Pin the public launcher and implementation resolver to this checkout's compiled CLI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertFreshCliBuild } from '../helpers/compiled-cli-freshness.js';
import { bundleReconciliationSource } from '../helpers/bundle-reconciliation-source.js';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
const ROOT = path.resolve(import.meta.dirname, '../..');
const temporary: string[] = [];
const retained: string[] = [];
const baselines = new Map<string, { fixture: ReturnType<typeof setup>; saved: string }>();
let sourceFixture: string | undefined;
let cliCompileCache: string | undefined;
beforeAll(() => assertFreshCliBuild(ROOT));
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
afterAll(() => { for (const dir of retained.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function setup(frameworkRoot = ROOT, freshHome = false) {
  if (!cliCompileCache) { cliCompileCache = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-bundle-bytecode-')); retained.push(cliCompileCache); }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-bundle-cli-')); temporary.push(scratch);
  const project = path.join(scratch, 'project'), home = path.join(scratch, 'home');
  fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(home, { recursive: true });
  if (!freshHome) {
    fs.mkdirSync(path.join(home, '.aiwg'), { recursive: true });
    fs.writeFileSync(path.join(home, '.aiwg/channel.json'), JSON.stringify({ channel: 'edge', edgePath: frameworkRoot, devMode: true, checkOnStartup: false }));
  }
  const env = { ...process.env, HOME: home, USERPROFILE: home, AIWG_CONFIG: path.join(home, '.aiwg'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.state'),
    AIWG_ROOT: frameworkRoot, AIWG_RESOLVE_IMPL_FROM: 'dist', AIWG_SKIP_ACTIVITY_LOG: '1', NO_UPDATE_NOTIFIER: '1' };
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR', 'AIWG_USER_REGISTRY_PATH']) delete env[key];
  // Cache compilation in this run's TMPDIR; every CLI still starts a fresh process.
  Object.assign(env, { NODE_COMPILE_CACHE: cliCompileCache }); delete env.NODE_DISABLE_COMPILE_CACHE;
  // The reduced corpus owns its indexes; the lane's immutable cache is for ROOT.
  if (frameworkRoot !== ROOT) Object.assign(env, {
    AIWG_RULE_BINDING_INDEX_CACHE: path.join(frameworkRoot, '.cache/bindings'),
    AIWG_FRAMEWORK_INDEX_CACHE: path.join(frameworkRoot, '.cache/framework'),
    AIWG_FRAMEWORK_INDEX_CACHE_SOURCE: frameworkRoot,
  });
  const command = (...args: string[]) => {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'bin/aiwg.mjs'), ...args], {
      cwd: project, env, encoding: 'utf8', timeout: 600_000, maxBuffer: 16 * 1024 * 1024,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}\n${result.error || ''}`).toBe(0);
    expect(result.stderr).not.toContain('Source checkout detected');
    if (args[0] === 'use' && args.includes('--json')) {
      expect(JSON.parse(result.stdout).frameworkRoot).toBe(frameworkRoot);
      expect(fs.realpathSync(path.join(frameworkRoot, 'dist'))).toBe(path.join(ROOT, 'dist'));
    }
    return `${result.stdout}\n${result.stderr}`;
  };
  const readConfig = () => JSON.parse(fs.readFileSync(path.join(project, '.aiwg/aiwg.config'), 'utf8'));
  const writeConfig = (config: unknown) => fs.writeFileSync(path.join(project, '.aiwg/aiwg.config'), JSON.stringify(config, null, 2));
  const plans = (provider: string) => ['refresh', 'update'].map(action => command(action, '--dry-run', '--provider', provider, action === 'update' ? '--skip-check' : '--skip-update'));
  const snapshot = () => {
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
    return Object.fromEntries(walk(project).map(file => [path.relative(project, file), fs.readFileSync(file).toString('base64')]));
  };
  return { scratch, home, project, command, plans, readConfig, writeConfig, snapshot };
}
it('retains composed ownership after use all in a fresh HOME (#3924)', () => {
  const { project, home, command, snapshot, readConfig } = setup(ROOT, true);
  expect(fs.readdirSync(home)).toEqual([]);
  const initialized = spawnSync('git', ['init', '-q'], { cwd: project,
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') }, timeout: 10_000 });
  expect(initialized.status).toBe(0);
  command('use', 'all', '--provider', 'claude', '--quiet');
  expect(readConfig().installed.all.deployedTo.claude).toMatchObject({ kernelOnly: true, skipUtils: false });
  const before = snapshot();
  const hooks = Object.fromEntries(Object.entries(before).filter(([file]) =>
    file.startsWith('.claude/hooks/') || file === '.claude/settings.json'));
  expect(Object.keys(hooks)).toContain('.claude/hooks/aiwg-prompt-discovery.cjs');
  const receipts = Object.keys(before).filter(file => file.startsWith('.aiwg/frameworks/') && file.endsWith('.aiwg-manifest.json'));
  expect(receipts).toContain('.aiwg/frameworks/.aiwg-manifest.json');
  for (const args of [['--dry-run'], []]) {
    const output = command('refresh', ...args, '--skip-update', '--provider', 'claude');
    expect(output).not.toMatch(/Would remove|Would release|Removing \S+ for|Stale deployment:/);
    expect(output).toContain('All deployments up to date');
    const after = snapshot();
    if (args.length) expect(after).toEqual(before);
    expect(Object.fromEntries(Object.entries(after).filter(([file]) => file in hooks))).toEqual(hooks);
    for (const file of receipts) {
      const managed = JSON.parse(fs.readFileSync(path.join(project, file), 'utf8')).managed;
      const previous = JSON.parse(Buffer.from(before[file], 'base64').toString()).managed;
      expect(Object.keys(managed)).toEqual(Object.keys(previous));
      for (const key of Object.keys(previous)) expect(managed[key].owners).toEqual(previous[key].owners);
    }
  }
}, 600_000);
function focusedSource() {
  if (!sourceFixture) { sourceFixture = bundleReconciliationSource(ROOT); retained.push(sourceFixture); }
  return sourceFixture;
}
// Restore project AND isolated HOME at their original absolute paths.
function restoreBaseline(key: string) {
  const existing = baselines.get(key);
  if (existing) {
    for (const name of ['project', 'home'] as const) {
      fs.rmSync(existing.fixture[name], { recursive: true, force: true });
      fs.cpSync(path.join(existing.saved, name), existing.fixture[name], { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    }
    return existing.fixture;
  }
  return undefined;
}
function saveBaseline(key: string, fixture: ReturnType<typeof setup>) {
  const saved = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-bundle-baseline-')); retained.push(saved);
  for (const name of ['project', 'home'] as const) fs.cpSync(fixture[name], path.join(saved, name), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  baselines.set(key, { fixture, saved });
  return fixture;
}
// Build lazily inside the existing case timeout; beforeAll stays a freshness check.
function sdlcSetup(provider: string, fullCorpus = false) {
  const key = `${provider}:${fullCorpus}`;
  const existing = restoreBaseline(key);
  if (existing) return existing;
  const fixture = setup(fullCorpus ? ROOT : focusedSource());
  temporary.splice(temporary.indexOf(fixture.scratch), 1); retained.push(fixture.scratch);
  fixture.command('use', 'sdlc', '--provider', provider, '--no-project-local', '--yes', ...(fullCorpus ? ['--json'] : []));
  return saveBaseline(key, fixture);
}
function voiceSetup(provider: string, fixture: ReturnType<typeof setup>) {
  const key = `voice:${provider}`;
  if (restoreBaseline(key)) return;
  fixture.command('use', 'voice-framework', '--provider', provider, '--declare');
  fixture.command('use', 'voice-framework', '--provider', provider, '--yes');
  saveBaseline(key, fixture);
}
it.each(['codex', 'claude'].flatMap(provider => [false, true].map(declared => ({ provider, declared }))))(
  'preserves edited voice bytes and original ownership across updates ($provider, declared=$declared)', ({ provider, declared }) => {
    // Keep the real framework, voice additive pass and all 19 kernel skills.
    // The complete addon/extension corpus is covered by the cases below.
    const fixture = sdlcSetup(provider);
    const { project, command, readConfig, writeConfig } = fixture;
    expect(readConfig().installed.sdlc.deployedTo[provider].skills).toBe(19);
    voiceSetup(provider, fixture);
    const skills = provider === 'codex' ? '.agents/skills' : '.claude/.aiwg/skills';
    const file = path.join(project, skills, 'voice-create/SKILL.md');
    const unchanged = path.join(project, skills, 'voice-apply/SKILL.md');
    const receipt = () => JSON.parse(fs.readFileSync(path.join(path.dirname(file), '.aiwg-manifest.json'), 'utf8')).managed['SKILL.md'];
    const originalHash = receipt().hash;
    const edited = fs.readFileSync(file, 'utf8') + '\n# operator note\n';
    fs.writeFileSync(file, edited);
    const update = () => {
      const output = command('update', '--skip-check', '--provider', provider);
      expect(fs.existsSync(file), output).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).toBe(edited);
      expect(receipt().hash).toBe(originalHash);
      expect(receipt().owners).toEqual(['voice-framework']);
      expect(readConfig().installed.sdlc.deployedTo[provider].skills).toBe(19);
      expect(output).toMatch(/voice-create.*(?:operator-edited|modified or unverifiable)/);
    };
    if (declared) { update(); update(); }
    const config = readConfig(); delete config.installed['voice-framework']; writeConfig(config);
    update();
    expect(fs.existsSync(unchanged)).toBe(false);
    update();
    expect(fs.existsSync(unchanged)).toBe(false);
  }, 600_000,
);
it.each(['claude', 'codex'])('keeps every additive owner after real use sdlc for %s', provider => {
  const { plans, readConfig, snapshot } = sdlcSetup(provider, true);
  expect(Object.keys(readConfig().installed)).toEqual(['sdlc']);
  const before = snapshot();
  for (const output of plans(provider)) {
    expect(output).not.toMatch(/Would remove|Removing \S+ for|stale AIWG-managed files/);
    expect(output).toContain(`aiwg use sdlc --provider ${provider}`);
  }
  expect(snapshot()).toEqual(before);
}, 600_000);
it('plans exactly the dropped explicit voice bundle through refresh and update', () => {
  const { project, command, plans, readConfig, writeConfig, snapshot } = sdlcSetup('claude', true);
  command('use', 'voice-framework', '--provider', 'claude', '--declare');
  command('use', 'voice-framework', '--provider', 'claude', '--yes', '--json');
  const voiceFile = path.join(project, '.claude/.aiwg/skills/voice-apply/SKILL.md');
  expect(fs.existsSync(voiceFile)).toBe(true);
  const config = readConfig(); delete config.installed['voice-framework']; writeConfig(config);
  const before = snapshot();
  for (const output of plans('claude')) {
    expect(output.match(/^Would remove \S+ for claude$/gm)).toEqual(['Would remove voice-framework for claude']);
    expect(output).toMatch(/Would remove [1-9]\d* unchanged recorded file/);
    const removalLines = output.split('\n').filter(line => /^    Would remove /.test(line));
    expect(removalLines.length).toBeGreaterThan(0);
    expect(removalLines.every(line => /voice-|output-mode|ownership metadata released/.test(line))).toBe(true);
  }
  expect(snapshot()).toEqual(before);
  command('update', '--skip-check', '--provider', 'claude');
  expect(fs.existsSync(voiceFile)).toBe(false);
  for (const output of plans('claude')) expect(output).not.toMatch(/^Would remove \S+ for claude$/m);
}, 600_000);

it.each([false, true])('persists mode, updates unchanged standard copies, and keeps edits (copy=%s)', copy => {
  const { project, command, plans, readConfig, writeConfig, snapshot } = setup(focusedSource());
  const source = path.join(project, '.aiwg/addons/local-mode');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({
    id: 'local-mode', type: 'addon', name: 'Local mode', version: '1.0.0', manifestVersion: '1',
    description: 'Synthetic standard skills for deployment lifecycle tests.', platforms: { claude: 'full' }, keywords: ['test'],
    deployment: { pathTemplate: '.{platform}/skills/{id}.md' }, addonConfig: { entry: { skills: 'skills/' } },
  }));
  const writeSource = (revision: number) => {
    for (const name of ['mode-current', 'mode-edited']) {
      const dir = path.join(source, 'skills', name); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Synthetic skill\nplatforms: [claude]\n---\nRevision ${revision}\n`);
    }
  };
  writeSource(1);
  command('use', 'local-mode', '--provider', 'claude', '--declare', ...(copy ? ['--copy-all'] : []));
  expect(readConfig().installed['local-mode'].deployedTo.claude).toEqual(copy ? { copy: true } : {});
  command('update', '--skip-check', '--provider', 'claude');
  expect(readConfig().installed['local-mode'].deployedTo.claude.copy).toBe(copy);
  const current = path.join(project, '.claude/.aiwg/skills/mode-current/SKILL.md');
  const edited = path.join(project, '.claude/.aiwg/skills/mode-edited/SKILL.md');
  expect(fs.readFileSync(current, 'utf8')).toContain('Revision 1');
  fs.writeFileSync(edited, 'Operator-edited skill\n');
  command('use', 'sdlc', '--provider', 'claude', '--yes', '--json', ...(copy ? ['--copy-all'] : []));
  expect(readConfig().installed['local-mode'].deployedTo.claude.copy).toBe(copy);
  for (const [index, action] of ['update', 'refresh'].entries()) {
    writeSource(index + 2);
    const output = command(action, action === 'update' ? '--skip-check' : '--skip-update', '--provider', 'claude');
    expect(fs.readFileSync(current, 'utf8')).toContain(`Revision ${index + 2}`);
    expect(fs.readFileSync(edited, 'utf8')).toBe('Operator-edited skill\n');
    expect(output).toContain('operator-edited');
    expect(readConfig().installed['local-mode'].deployedTo.claude.copy).toBe(copy);
  }
  command('use', 'local-mode', '--provider', 'claude', '--copy-standard-skills', '--yes', '--json');
  expect(readConfig().installed['local-mode'].deployedTo.claude.copy).toBe(true);
  command('use', 'local-mode', '--provider', 'claude', '--yes', '--json');
  expect(readConfig().installed['local-mode'].deployedTo.claude.copy).toBe(false);
  if (copy) command('use', 'local-mode', '--provider', 'claude', '--copy-all', '--yes', '--json');
  const config = readConfig(); delete config.installed['local-mode']; writeConfig(config);
  for (const output of plans('claude')) {
    if (copy) {
      expect(output).toContain('kept (copy mode); run `aiwg remove local-mode` to delete');
      expect(output).not.toContain('Would remove local-mode for claude');
    } else expect(output).toContain('Would remove local-mode for claude');
  }
  command('refresh', '--skip-update', '--provider', 'claude');
  expect(fs.existsSync(current)).toBe(copy);
  expect(fs.readFileSync(edited, 'utf8')).toBe('Operator-edited skill\n');
  if (copy) {
    command('remove', 'local-mode', '--provider', 'claude');
    expect(fs.existsSync(current)).toBe(false);
    expect(fs.readFileSync(edited, 'utf8')).toBe('Operator-edited skill\n');
    const remaining = readConfig(); delete remaining.installed.sdlc; writeConfig(remaining);
    const providerSnapshot = () => Object.fromEntries(Object.entries(snapshot()).filter(([name]) => name.startsWith('.claude/') || name.startsWith('.agents/')));
    const copied = providerSnapshot();
    for (const output of plans('claude')) expect(output).not.toMatch(/^Would remove \S+ for claude$/m);
    command('refresh', '--skip-update', '--provider', 'claude');
    expect(providerSnapshot()).toEqual(copied);
  }
}, 600_000);

it.each(['claude', 'codex'])('prunes only unchanged utils after a recorded --no-utils deploy (%s)', provider => {
  const { project, command, plans, readConfig, writeConfig } = sdlcSetup(provider, true);
  const skills = provider === 'codex' ? '.agents/skills' : '.claude/skills';
  const unchanged = path.join(project, skills, 'aiwg-help/SKILL.md');
  const edited = path.join(project, skills, 'aiwg-status/SKILL.md');
  const framework = path.join(project, skills, 'sdlc-quickref/SKILL.md');
  const frameworkBytes = fs.readFileSync(framework, 'utf8');
  fs.writeFileSync(edited, fs.readFileSync(edited, 'utf8') + '\nOperator note\n');
  const editedBytes = fs.readFileSync(edited, 'utf8');
  command('use', 'sdlc', '--provider', provider, '--no-project-local', '--no-utils', '--yes');
  expect(readConfig().installed.sdlc.deployedTo[provider]).toMatchObject({ skipUtils: true, kernelOnly: false });
  expect(fs.existsSync(unchanged)).toBe(true);
  const known = readConfig();
  const unknown = structuredClone(known);
  delete unknown.installed.sdlc.deployedTo[provider].skipUtils;
  delete unknown.installed.sdlc.deployedTo[provider].kernelOnly;
  writeConfig(unknown);
  for (const output of plans(provider)) expect(output).not.toContain(`Would remove aiwg-utils for ${provider}`);
  expect(fs.existsSync(unchanged)).toBe(true);
  writeConfig(known);
  for (const output of plans(provider)) expect(output).toContain(`Would remove aiwg-utils for ${provider}`);
  for (const [action, flag] of [['update', '--skip-check'], ['refresh', '--skip-update']]) {
    command(action, flag, '--provider', provider);
    expect(fs.existsSync(unchanged)).toBe(false);
    expect(fs.readFileSync(edited, 'utf8')).toBe(editedBytes);
    expect(fs.readFileSync(framework, 'utf8')).toBe(frameworkBytes);
    expect(readConfig().installed.sdlc.deployedTo[provider].skipUtils).toBe(true);
  }
}, 600_000);

it.each(['.ts', '.mjs', '.json', '.yaml'])('detects stale and missing compiled dependencies (%s)', extension => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-cli-freshness-')); temporary.push(root);
  fs.mkdirSync(path.join(root, 'src/nested'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist/src/nested'), { recursive: true });
  const source = path.join(root, 'src/nested/dependency' + extension);
  const output = path.join(root, 'dist/src/nested/dependency' + (extension === '.ts' ? '.js' : extension));
  fs.writeFileSync(source, 'fixture');
  expect(() => assertFreshCliBuild(root)).toThrow('run npm run build:cli');
  fs.writeFileSync(output, 'fixture');
  fs.utimesSync(source, 100, 100); fs.utimesSync(output, 101, 101);
  expect(() => assertFreshCliBuild(root)).not.toThrow();
  fs.utimesSync(source, 102, 102);
  expect(() => assertFreshCliBuild(root)).toThrow('run npm run build:cli');
});
