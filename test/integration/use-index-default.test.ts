// Offline end-to-end coverage of the discovery-first use/new/refresh contract.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveOmpPaths } from '../../src/providers/omp-paths.mjs';
import { workerVersionProbeEnvironment } from '../../src/models/worker-installation.mjs';

const repo = resolve(import.meta.dirname, '../..');
let root: string;
let project: string;
let env: NodeJS.ProcessEnv;
function write(relative: string, body: string) {
  const file = join(project, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}
function cli(args: string[]) {
  const result = spawnSync(process.execPath, [join(repo, 'bin/aiwg.mjs'), ...args], {
    cwd: project, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return args.includes('--json') ? result.stdout : result.stdout + result.stderr;
}
function payloads(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? payloads(join(dir, entry.name)) : entry.name.endsWith('.md') ? [join(dir, entry.name)] : []);
}
function localBundle() {
  write('.aiwg/addons/local-helper/manifest.json', JSON.stringify({
    id: 'local-helper', type: 'addon', name: 'Local helper', version: '1.0.0', manifestVersion: '1',
    description: 'Synthetic helper', keywords: ['local-helper'],
    platforms: { claude: 'full', codex: 'full', generic: 'full' },
    deployment: { pathTemplate: '.{platform}/skills/{id}.md' },
    addonConfig: { entry: { skills: 'skills/', agents: 'agents/', commands: 'commands/' } },
  }));
  write('.aiwg/addons/local-helper/skills/local-helper/SKILL.md', '---\nname: local-helper\ndescription: Synthetic local helper\nplatforms: [all]\n---\n# Local helper\n');
  write('.aiwg/addons/local-helper/agents/local-helper.md', '---\nname: local-helper\ndescription: Synthetic agent\n---\n# Local helper\n');
  write('.aiwg/addons/local-helper/commands/local-helper.md', '---\nname: local-helper\ndescription: Synthetic command\n---\n# Local helper\n');
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aiwg-index-default-'));
  project = join(root, 'project');
  mkdirSync(project);
  env = { ...workerVersionProbeEnvironment(), HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'),
    AIWG_ROOT: repo, AIWG_NO_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1' };
  mkdirSync(env.HOME!, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('discovery-first CLI (#4279)', () => {
  it.each(['sdlc', 'voice-framework', 'aiwg-utils', 'local-helper'])('indexes %s without provider agents, commands or standard skills', { timeout: 210_000 }, target => {
    if (target === 'local-helper') localBundle();
    const output = cli(['use', target, '--provider', 'claude', '--no-utils', '--no-hooks']);
    expect(payloads(join(project, '.claude/agents'))).toEqual([]);
    expect(payloads(join(project, '.claude/commands'))).toEqual([]);
    expect(payloads(join(project, '.claude/.aiwg/skills'))).toEqual([]);
    if (target === 'local-helper') {
      expect(payloads(join(project, '.claude/skills')).filter(file => file.endsWith('/local-helper/SKILL.md'))).toEqual([]);
      const found = JSON.parse(cli(['discover', 'local-helper', '--graph', 'project', '--json']));
      expect(found.results.some((entry: any) => entry.name === 'local-helper')).toBe(true);
      const shown = JSON.parse(cli(['show', 'skill', 'local-helper', '--graph', 'project', '--json']));
      expect(shown.installed).toBe(false);
    } else {
      const [kind, name] = target === 'sdlc' ? ['agent', 'test-engineer']
        : ['skill', target === 'voice-framework' ? 'voice-create' : 'new-project'];
      const found = JSON.parse(cli(['discover', name, '--type', kind, '--json']));
      expect(found.results.some((entry: any) => entry.name === (target === 'sdlc' ? 'Test Engineer' : name))).toBe(true);
      expect(JSON.parse(cli(['show', kind, name, '--json'])).installed).toBe(false);
    }
    expect(output).toContain('aiwg discover');
    expect(output).toContain('--copy');
    const receipt = JSON.parse(readFileSync(join(project, '.aiwg/.aiwg-manifest.json'), 'utf8'));
    expect(Object.values(receipt.bundleDeployments.claude).some((entry: any) => entry.copy === true)).toBe(false);
  });
  it('keeps bundled extension rules when a framework is indexed without copies', { timeout: 210_000 }, () => {
    cli(['use', 'sdlc', '--provider', 'claude', '--no-hooks']);
    expect(payloads(join(project, '.claude/agents'))).toEqual([]);
    for (const rule of ['sys-interactive-gate.md', 'sys-hardware-safety.md']) {
      expect(existsSync(join(project, '.claude/rules', rule)), rule).toBe(true);
    }
  });
  it.each(['codex', 'muse', 'pi', 'omp'])('indexes local bundles for %s without provider copies', { timeout: 210_000 }, provider => {
    localBundle();
    cli(['use', 'local-helper', '--provider', provider, '--no-hooks']);
    for (const prefix of ['.claude', '.codex', '.agents', '.muse', '.pi', '.omp']) {
      expect(payloads(join(project, prefix)).filter(file => /local-helper(?:\/SKILL)?\.md$/.test(file))).toEqual([]);
    }
  });
  it.each(['sdlc', 'voice-framework'])('indexes %s at OMP user scope without agent or command copies', { timeout: 210_000 }, target => {
    cli(['use', target, '--provider', 'omp', '--scope', 'user', '--no-utils', '--no-hooks']);
    const { resourceDirs } = resolveOmpPaths({ cwd: project, home: env.HOME, env });
    expect(payloads(resourceDirs.agents)).toEqual([]);
    expect(payloads(resourceDirs.commands)).toEqual([]);
    expect(payloads(resourceDirs.skills).some(file => file.endsWith('/voice-apply/SKILL.md'))).toBe(false);
  });
  it.each([false, true])('keeps a declared local copy=%s independent of the parent framework mode', { timeout: 210_000 }, copy => {
    localBundle();
    cli(['use', 'local-helper', '--provider', 'claude', '--no-hooks', ...(copy ? ['--copy-all'] : [])]);
    const source = '.aiwg/addons/local-helper/skills/local-helper/SKILL.md';
    write(source, readFileSync(join(project, source), 'utf8') + '\nUpdated local instructions.\n');
    cli(['use', 'sdlc', '--provider', 'claude', '--no-utils', '--no-hooks', ...(copy ? [] : ['--copy-all'])]);
    const skill = join(project, '.claude/skills/local-helper/SKILL.md');
    if (copy) expect(readFileSync(skill, 'utf8')).toContain('Updated local instructions.');
    else expect(existsSync(skill)).toBe(false);
    const config = JSON.parse(readFileSync(join(project, '.aiwg/aiwg.config'), 'utf8'));
    expect(config.installed['local-helper'].deployedTo.claude.copy).toBe(copy);
  });
  it('copies only the selected bundle with use all --copy <bundle>', { timeout: 210_000 }, () => {
    localBundle();
    cli(['use', 'all', '--copy', 'local-helper', '--provider', 'claude', '--no-utils', '--no-hooks']);
    expect(payloads(join(project, '.claude/agents')).map(file => file.split('/').at(-1))).toEqual(['local-helper.md']);
    const receipt = JSON.parse(readFileSync(join(project, '.aiwg/.aiwg-manifest.json'), 'utf8'));
    expect(receipt.bundleDeployments.claude.all.copy).toBe(false);
    expect(receipt.bundleDeployments.claude['local-helper'].copy).toBe(true);
  });
  it.each(['--copy', '--copy-all'])('copies on %s and preserves the choice through refresh', { timeout: 210_000 }, flag => {
    localBundle();
    cli(['use', 'local-helper', '--provider', 'claude', flag, '--no-hooks']);
    const copies = payloads(join(project, '.claude'));
    expect(copies.some(file => file.endsWith('/local-helper/SKILL.md'))).toBe(true);
    expect(copies.some(file => file.endsWith('/agents/local-helper.md'))).toBe(true);
    cli(['refresh', '--skip-update', '--no-diff', '--quiet']);
    for (const file of copies) expect(existsSync(file), file).toBe(true);
    const receipt = JSON.parse(readFileSync(join(project, '.aiwg/.aiwg-manifest.json'), 'utf8'));
    expect(receipt.bundleDeployments.claude['local-helper'].copy).toBe(true);
  });
  it.each(['use', 'refresh'])('offers a reviewed migration through %s and preserves existing copies', { timeout: 210_000 }, command => {
    localBundle();
    cli(['use', 'local-helper', '--provider', 'claude', '--copy-all', '--no-hooks']);
    const file = payloads(join(project, '.claude/agents'))[0];
    const before = readFileSync(file, 'utf8');
    const configPath = join(project, '.aiwg/aiwg.config');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    delete config.installed['local-helper'].deployedTo.claude.copy;
    writeFileSync(configPath, JSON.stringify(config));
    const output = command === 'use' ? cli(['use', 'local-helper', '--provider', 'claude', '--no-hooks'])
      : cli(['refresh', '--skip-update', '--no-diff', '--provider', 'claude']);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(output).toContain('aiwg remove');
    expect(output).toContain('review');
  });
  it('scaffolds new projects without agent or command copies', { timeout: 210_000 }, () => {
    const output = cli(['new', '--name', 'synthetic']);
    expect(payloads(join(project, '.claude/agents'))).toEqual([]);
    expect(payloads(join(project, '.claude/commands'))).toEqual([]);
    expect(output).toContain('aiwg discover');
  });
  it('preserves configured provider homes in the cleared new-project child environment', { timeout: 210_000 }, () => {
    env.HERMES_HOME = join(root, 'hermes-profile');
    cli(['new', '--name', 'synthetic', '--provider', 'hermes']);
    expect(payloads(join(env.HERMES_HOME, 'skills')).some(file => file.endsWith('/sdlc-quickref/SKILL.md'))).toBe(true);
    expect(existsSync(join(env.HOME!, '.hermes/skills'))).toBe(false);
  });
  it('scaffolds indexed bundles and explains the copy opt-in', { timeout: 210_000 }, () => {
    const output = cli(['new-bundle', 'fresh-helper', '--starter', 'skill']);
    expect(output).toContain('indexed');
    expect(output).toContain('aiwg use fresh-helper --copy');
    expect(payloads(join(project, '.claude'))).toEqual([]);
  });
});
