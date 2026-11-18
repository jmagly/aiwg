// Exercise repository import through the built CLI using offline Git fixtures.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitFixture, repositorySkills } from '../fixtures/skills/bundle-repositories.js';

const bin = fileURLToPath(new URL('../../bin/aiwg.mjs', import.meta.url));
let root: string;
let project: string;
let source: string;
let commit: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-import-cli-'));
  project = path.join(root, 'project');
  source = path.join(root, 'marketingskills');
  fs.mkdirSync(project);
  commit = gitFixture(source, { ...repositorySkills('marketing', 2), LICENSE: 'MIT License\n' });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function cli(args: string[]) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: project, encoding: 'utf8', timeout: 60_000,
    env: {
      PATH: process.env.PATH, HOME: root, USERPROFILE: root,
      XDG_DATA_HOME: path.join(root, '.local/share'), XDG_CONFIG_HOME: path.join(root, '.config'),
      XDG_CACHE_HOME: path.join(root, '.cache'), AIWG_SKIP_UPDATE_CHECK: '1',
      AIWG_ARTIFACTS_PATH: path.join(project, '.aiwg'),
    },
  });
}
const records = (stdout: string) => stdout.trim().split('\n').map(line => JSON.parse(line));

describe('built skill repository import', () => {
  it('previews, imports, discovers uninstalled skills, and refreshes a pinned addon', () => {
    const args = ['skills', 'import', source, '--into', 'community', '--ref', commit];
    const preview = cli([...args, '--dry-run', '--json']);
    expect(preview.status, preview.stderr).toBe(0);
    expect(records(preview.stdout).map(record => record.phase)).toEqual(['preflight', 'result']);
    expect(fs.existsSync(path.join(project, '.aiwg'))).toBe(false);
    const imported = cli(args);
    expect(imported.status, imported.stderr).toBe(0);
    expect(imported.stdout).toContain('Indexed 2 skills; installed: false');
    const discovered = cli(['discover', 'marketing-1', '--graph', 'project', '--json']);
    expect(discovered.status, discovered.stderr).toBe(0);
    const data = JSON.parse(discovered.stdout);
    expect(data.results).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'marketing-1' })]));
    const shown = cli(['show', 'skill', 'marketing-1', '--graph', 'project', '--json']);
    expect(shown.status, shown.stderr).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({ name: 'marketing-1', installed: false });
    const file = path.join(project, '.aiwg/addons/community/skills/marketing-1/SKILL.md');
    fs.appendFileSync(file, '\nlocal edit');
    const refreshed = cli(['skills', 'import', '--refresh', 'community', '--json']);
    expect(refreshed.status, refreshed.stderr).toBe(0);
    expect(records(refreshed.stdout)[0].diff.modified).toContain('skills/marketing-1/SKILL.md');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('local edit');
    expect(fs.existsSync(path.join(project, '.claude'))).toBe(false);
  });

  it.each([
    ['--into'], ['<source>', '--into', '../escape'], ['<source>', '--into', 'community', '--only'],
    ['--refresh', 'missing'], ['<source>', '--into', 'community', '--trust'],
  ])('rejects malformed bundle import arguments %j', (...args) => {
    const result = cli(['skills', 'import', ...args.map(arg => arg === '<source>' ? source : arg)]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Error:');
    expect(fs.existsSync(path.join(project, '.aiwg'))).toBe(false);
  });
});
