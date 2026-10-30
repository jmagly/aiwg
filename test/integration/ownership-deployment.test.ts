import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function files(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(path.join(root, entry.name)) : entry.isFile() ? [path.join(root, entry.name)] : []);
}
function receipts(project: string): Map<string, any> {
  const records = new Map();
  for (const file of files(project).filter(file => path.basename(file) === '.aiwg-manifest.json')) {
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [name, record] of Object.entries(receipt.managed || {})) records.set(path.resolve(receipt.scope === 'project' && path.dirname(file) === path.join(project, '.aiwg') ? project : path.dirname(file), name), record);
  }
  return records;
}
const hash = (file: string) => `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;

describe('framework deploy ownership receipts (#3769)', () => {
  it.each([['sdlc', 'sdlc-complete'], ['marketing', 'media-marketing-kit']])('records every output of %s and agrees with deployedTo counts', (bundle, slug) => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-ownership-integration-')); temporary.push(scratch);
    const project = path.join(scratch, 'project'), home = path.join(scratch, 'home');
    const packageRoot = ROOT;
    fs.mkdirSync(project); fs.mkdirSync(path.join(home, '.aiwg'), { recursive: true });
    fs.mkdirSync(path.join(project, '.aiwg'));
    // Keep the declared bundle selection identical across both deploys; no outputs exist yet.
    fs.writeFileSync(path.join(project, '.aiwg/aiwg.config'), JSON.stringify({
      version: '1', providers: ['claude'], scripts: {}, installed: { [bundle]: {
        version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version, source: 'bundled', installedAt: '2026-01-01T00:00:00.000Z', deployedTo: {},
      } },
    }));
    fs.writeFileSync(path.join(home, '.aiwg/channel.json'), JSON.stringify({ channel: 'edge', edgePath: packageRoot, devMode: true }));
    const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CACHE_HOME: path.join(home, '.cache'),
      AIWG_CONFIG: path.join(home, '.aiwg'), AIWG_USER_REGISTRY_PATH: path.join(home, '.aiwg/installed.json'), AIWG_ROOT: packageRoot,
      AIWG_RESOLVE_IMPL_FROM: 'dist', NO_UPDATE_NOTIFIER: '1' };
    delete env.AIWG_ARTIFACTS_PATH;
    const deploy = () => {
      const result = spawnSync(process.execPath, [path.join(ROOT, 'bin/aiwg.mjs'), 'use', bundle, '--provider', 'claude',
        '--target', project, '--scope', 'project', '--copy-all', '--no-project-local', '--json'],
      { cwd: project, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
      expect(result.status, `${result.stdout}\n${result.stderr}\n${result.error || ''}`).toBe(0);
    };
    deploy();
    const records = receipts(project);
    for (const [file, entry] of records) expect(entry.hash, path.relative(project, file)).toBe(hash(file));
    const outputs = files(path.join(project, '.claude')).filter(file => path.basename(file) !== '.aiwg-manifest.json');
    expect(outputs.length).toBeGreaterThan(10);
    for (const file of outputs) {
      expect(records.get(file), path.relative(project, file)).toMatchObject({ hash: hash(file), owners: expect.any(Array) });
    }
    const counts = JSON.parse(fs.readFileSync(path.join(project, '.aiwg/aiwg.config'), 'utf8')).installed[bundle].deployedTo.claude;
    const source = path.join(ROOT, 'agentic/code/frameworks', slug);
    for (const [kind, directory] of [['agents', 'agents'], ['commands', 'commands']] as const) {
      const deployed = files(path.join(source, directory)).filter(file => file.endsWith('.md')).filter(file => {
        const dest = path.join(project, '.claude', directory, path.basename(file));
        return fs.existsSync(dest);
      });
      const actual = outputs.filter(file => path.dirname(file) === path.join(project, '.claude', directory) && file.endsWith('.md'));
      expect(actual.length, `${kind} config count`).toBe(counts[kind]);
      expect(actual.every(file => records.has(file)), `${kind} recorded count`).toBe(true);
      for (const file of deployed) expect(records.get(path.join(project, '.claude', directory, path.basename(file)))?.owners, file).toContain(slug);
    }
    const skills = outputs.filter(file => path.basename(file) === 'SKILL.md');
    expect(skills.length, 'skills config count').toBe(counts.skills);
    expect(skills.every(file => records.has(file)), 'skills recorded count').toBe(true);
    const rules = outputs.filter(file => path.dirname(file) === path.join(project, '.claude/rules') && file.endsWith('.md'));
    expect(rules.length, 'rules config count').toBe(counts.rules);
    expect(rules.every(file => records.has(file)), 'rules recorded count').toBe(true);
    const settings = records.get(path.join(project, '.claude/settings.json'));
    expect(settings.settings['/aiwg/mode']).toMatchObject({ value: expect.any(String), owners: expect.any(Array) });
    expect(settings.settings['/aiwg/mode'].value).toBe(JSON.parse(fs.readFileSync(path.join(project, '.claude/settings.json'), 'utf8')).aiwg.mode);
    expect(settings.settings['/attribution/commit']).toBeDefined();
    const beforeContext = fs.readFileSync(path.join(project, 'AIWG.md'));
    const beforeBound = fs.readFileSync(path.join(project, '.claude/RULES-BOUND.md'));
    const state = [...records.entries()].map(([file, entry]) => [file, entry]).sort();
    deploy();
    const afterContext = fs.readFileSync(path.join(project, 'AIWG.md'));
    expect(afterContext).toEqual(beforeContext);
    const afterBound = fs.readFileSync(path.join(project, '.claude/RULES-BOUND.md'));
    expect(afterBound).toEqual(beforeBound);
    expect([...receipts(project).entries()].map(([file, entry]) => [file, entry]).sort()).toEqual(state);
  }, 240_000);
  it('records two framework owners of an identical file through the real deployer', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-shared-ownership-')); temporary.push(scratch);
    const project = path.join(scratch, 'project'), home = path.join(scratch, 'home');
    fs.mkdirSync(project); fs.mkdirSync(home);
    const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CACHE_HOME: path.join(home, '.cache') };
    for (const slug of ['sdlc-complete', 'media-marketing-kit', 'media-marketing-kit']) {
      const source = path.join(scratch, 'agentic/code/frameworks', slug);
      fs.mkdirSync(path.join(source, 'agents'), { recursive: true });
      fs.writeFileSync(path.join(source, 'agents/shared.md'), '---\nname: shared\ndescription: Shared fixture\n---\nSame instructions.\n');
      const result = spawnSync(process.execPath, [path.join(ROOT, 'tools/agents/deploy-agents.mjs'), '--source', source,
        '--target', project, '--provider', 'claude', '--no-context-files', '--no-attribution', '--deploy-version', '1'],
      { cwd: ROOT, env: { ...env, AIWG_ROOT: source }, encoding: 'utf8', timeout: 60_000 });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      const entry = receipts(project).get(path.join(project, '.claude/agents/shared.md'));
      expect(entry.hash).toBe(hash(path.join(project, '.claude/agents/shared.md')));
      expect(entry.owners).toEqual(slug === 'sdlc-complete' ? ['sdlc-complete'] : ['media-marketing-kit', 'sdlc-complete']);
    }
  });

});
