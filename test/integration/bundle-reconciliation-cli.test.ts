// Exercise Claude and provider-neutral reconciliation through the built public CLI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { assertFreshCliBuild } from '../helpers/compiled-cli-freshness.js';
import { ROOT, temporary, setup, focusedSource, sdlcSetup } from '../helpers/bundle-reconciliation-cli.js';
import { registerProviderReconciliation } from '../helpers/bundle-reconciliation-provider-cases.js';

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
registerProviderReconciliation('claude');

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
  const current = path.join(project, '.claude/skills/mode-current/SKILL.md');
  const edited = path.join(project, '.claude/skills/mode-edited/SKILL.md');
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
