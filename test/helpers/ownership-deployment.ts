// Share one real framework deployment across receipt, count and redeploy assertions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
function files(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(path.join(root, entry.name)) : entry.isFile() ? [path.join(root, entry.name)] : []);
}
export function receipts(project: string): Map<string, any> {
  const records = new Map();
  for (const file of files(project).filter(file => path.basename(file) === '.aiwg-manifest.json')) {
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [name, record] of Object.entries(receipt.managed || {})) records.set(path.resolve(receipt.scope === 'project' && path.dirname(file) === path.join(project, '.aiwg') ? project : path.dirname(file), name), record);
  }
  return records;
}
export const hash = (file: string) => `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;

export function frameworkOwnershipTests(bundle: string, slug: string): void {
  describe(`framework deploy ownership receipts (#3769): ${bundle}`, () => {
    let scratch: string;
    let project: string;
    let deploy: () => void;
    beforeAll(() => {
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-ownership-integration-'));
      project = path.join(scratch, 'project');
      const home = path.join(scratch, 'home');
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
      deploy = () => {
        const result = spawnSync(process.execPath, [path.join(ROOT, 'bin/aiwg.mjs'), 'use', bundle, '--provider', 'claude',
          '--target', project, '--scope', 'project', '--copy-all', '--no-project-local', '--json'],
        { cwd: project, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
        expect(result.status, `${result.stdout}\n${result.stderr}\n${result.error || ''}`).toBe(0);
      };
      deploy();
    }, 180_000);
    afterAll(() => { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); });

    it(`records every output of ${bundle} and agrees with deployedTo counts`, () => {
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
    });

    it('redeploys idempotently with byte-identical context and bound rules', () => {
      const records = receipts(project);
      const beforeContext = fs.readFileSync(path.join(project, 'AIWG.md'));
      const beforeBound = fs.readFileSync(path.join(project, '.claude/RULES-BOUND.md'));
      const state = [...records.entries()].map(([file, entry]) => [file, entry]).sort();
      deploy();
      const afterContext = fs.readFileSync(path.join(project, 'AIWG.md'));
      expect(afterContext).toEqual(beforeContext);
      const afterBound = fs.readFileSync(path.join(project, '.claude/RULES-BOUND.md'));
      expect(afterBound).toEqual(beforeBound);
      expect([...receipts(project).entries()].map(([file, entry]) => [file, entry]).sort()).toEqual(state);
    }, 180_000);
  });
}
