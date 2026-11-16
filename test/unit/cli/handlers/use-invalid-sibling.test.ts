// Verify named installs refresh warm project indexes despite an invalid sibling.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const repository = resolve(import.meta.dirname, '../../../..');
let root: string;
let project: string;
let environment: NodeJS.ProcessEnv;
const diagnostic = 'platforms.pi: expected one of "full"|"partial"|"experimental"|"none", got "skills-as-agents"';

function put(relative: string, content: string): void {
  const file = join(project, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function bundle(id: string, platforms: Record<string, string>): void {
  put(`.aiwg/extensions/${id}/manifest.json`, JSON.stringify({
    id, type: 'extension', name: id, version: '1.0.0', manifestVersion: '1',
    description: `Synthetic ${id} bundle`, platforms, keywords: [id],
    deployment: { pathTemplate: '.{platform}/skills/{id}.md' },
  }));
}

function invoke(args: string[]) {
  const result = spawnSync(process.execPath, [join(repository, 'bin/aiwg.mjs'), ...args], {
    cwd: project, env: environment, encoding: 'utf8', timeout: 90_000,
  });
  if (result.error) throw result.error;
  return { ...result, output: result.stdout + result.stderr };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aiwg-use-invalid-sibling-'));
  project = join(root, 'project');
  environment = { ...process.env, AIWG_ROOT: repository, AIWG_NO_UPDATE_CHECK: '1' };
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR',
    'AIWG_PROJECT_LOCAL_PATHS', 'AIWG_HOME', 'AIWG_USER_REGISTRY_PATH']) delete environment[key];
  for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
    'XDG_STATE_HOME', 'CODEX_HOME', 'HERMES_HOME', 'AIWG_CONFIG']) {
    environment[key] = join(root, key.toLowerCase());
    mkdirSync(environment[key]!, { recursive: true });
  }
  bundle('valid-tools', { claude: 'full', codex: 'full' });
  put('.aiwg/extensions/valid-tools/skills/seed-skill/SKILL.md',
    '---\nname: seed-skill\ndescription: Synthetic seed skill\n---\n# Seed\n');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('named project-local installs with an invalid sibling (#4191, #4192)', () => {
  it.each(['claude', 'codex'])('refreshes a warm index and quickref for %s', { timeout: 180_000 }, provider => {
    const useArgs = ['use', 'valid-tools', '--provider', provider];
    const initial = invoke(useArgs);
    expect(initial.status, initial.output).toBe(0);
    const metadataPath = join(project, '.aiwg/.index/project/metadata.json');
    const before = readFileSync(metadataPath, 'utf8');
    expect(before).not.toContain('tacocat-pulse');

    bundle('broken-tools', { pi: 'skills-as-agents' });
    const linkedBundle = join(project, '.aiwg/extensions/linked-tools');
    symlinkSync(join(project, '.aiwg/extensions/valid-tools'), linkedBundle, 'dir');
    put('.aiwg/extensions/broken-tools/skills/rejected-skill/SKILL.md', '---\nname: rejected-skill\n---\n');
    put('.aiwg/extensions/valid-tools/skills/tacocat-pulse/SKILL.md',
      '---\nname: tacocat-pulse\ndescription: Coordinate synthetic tacocat pulse\n---\n# Tacocat pulse\n');
    const installed = invoke(useArgs);
    expect(installed.status, installed.output).toBe(0);
    expect(installed.output).toContain(`WARN ${join(project, '.aiwg/extensions/broken-tools/manifest.json')}: ${diagnostic}`);
    expect(installed.output).toContain(
      `WARN ${linkedBundle}: (bundle directory): expected regular directory, got symlink; hint: Pass --allow-symlinks to opt in`,
    );
    expect(installed.output).toContain('Refreshed project-scope capability index');
    expect(installed.output).not.toMatch(/AIWG needs repair|project-local deploy\(s\) failed/);
    expect(readFileSync(metadataPath, 'utf8')).toContain('tacocat-pulse');
    const providerSkills = provider === 'codex' ? '.agents/skills' : '.claude/skills';
    expect(readFileSync(join(project, providerSkills, 'tacocat-pulse/SKILL.md'), 'utf8')).toContain('tacocat-pulse');
    const quickref = readFileSync(join(project, providerSkills, 'aiwg-project-project-quickref/SKILL.md'), 'utf8');
    expect(quickref).toContain('aiwg show skill tacocat-pulse');
    expect(quickref).not.toContain('broken-tools');

    const listed = invoke(['list', '--project-local']);
    expect(listed.status, listed.output).toBe(0);
    expect(listed.output).toContain(diagnostic);
    for (const backend of ['local', 'fortemi-core']) {
      const discovered = invoke(['discover', 'tacocat pulse', '--graph', 'project', '--backend', backend, '--no-build', '--json']);
      expect(discovered.status, discovered.output).toBe(0);
      expect(JSON.parse(discovered.stdout).results).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'tacocat-pulse' }),
      ]));
    }
  });
});
