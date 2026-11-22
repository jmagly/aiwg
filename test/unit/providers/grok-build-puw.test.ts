// Qualify Grok Build's offline lifecycle without claiming native OS or model evidence.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withWindows, windowsPath, uncPath } from '../../helpers/windows-simulation.mjs';
import { resolveGrokHomeResult } from '../../../src/providers/grok-build-paths.js';
import { validateGrokInspectReport } from '../../../src/providers/grok-build-inspect.js';
import { assertGrokUserMirrorPaths, mirrorArtifactDir } from '../../../src/cli/user-scope-mirror.js';
import { deploy, deploySkills, createAgentsMd, uninstall, resolveGrokHome } from '../../../tools/agents/providers/grok-build.mjs';
import { load } from 'js-yaml';

const repo = path.resolve(__dirname, '../../..');
let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'aiwg-grok-puw-'));
  for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'GROK_HOME']) {
    vi.stubEnv(key, path.join(root, 'home', key));
  }
  for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

function put(file: string, content: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function snapshot(dir: string, prefix = ''): Record<string, string> {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const relative = path.join(prefix, entry.name);
    return entry.isDirectory() ? Object.entries(snapshot(path.join(dir, entry.name), relative))
      : [[relative, readFileSync(path.join(dir, entry.name)).toString('base64')]];
  }));
}

describe('Grok Build cross-platform home qualification', () => {
  it.each([windowsPath('C', 'Users', 'Test Operator', '.grok'), uncPath('server', 'share', 'Grok Home')])(
    'resolves simulated Windows home %s in both source and deployment owners', home => withWindows(() => {
      const env = { GROK_HOME: home };
      expect(resolveGrokHomeResult(env)).toMatchObject({ ok: true, path: home });
      expect(resolveGrokHomeResult({}, windowsPath('C', 'Users', 'Test Operator')))
        .toMatchObject({ ok: true, path: windowsPath('C', 'Users', 'Test Operator', '.grok') });
      expect(resolveGrokHome(env)).toBe(home);
      expect(resolveGrokHomeResult({ GROK_HOME: '~/Grok Home' }, windowsPath('C', 'Users', 'Test Operator')))
        .toMatchObject({ ok: true, path: windowsPath('C', 'Users', 'Test Operator', 'Grok Home') });
      expect(resolveGrokHome({ GROK_HOME: '~/Grok Home' }, windowsPath('C', 'Users', 'Test Operator')))
        .toBe(windowsPath('C', 'Users', 'Test Operator', 'Grok Home'));
      for (const unsafe of ['C:\\', uncPath('server', 'share'), 'C:relative', '~', 'relative', `${home}\0escape`]) {
        expect(resolveGrokHomeResult({ GROK_HOME: unsafe }).ok).toBe(false);
        expect(resolveGrokHome({ GROK_HOME: unsafe })).toBeNull();
      }
    }, { profile: windowsPath('C', 'Users', 'Test Operator') }),
  );

  it('rejects a null-byte override consistently before any deployment', () => {
    const env = { GROK_HOME: `${root}/grok\0escape` };
    expect(resolveGrokHomeResult(env).ok).toBe(false);
    expect(resolveGrokHome(env)).toBeNull();
  });
});

describe.each(['linux', 'windows-powershell-simulated', 'wsl-path-simulated'])('%s provider under workflow', platform => {
  it.each(['clean', 'existing'])('preserves scope and operator content through the %s lifecycle', async state => {
    const exercise = async () => {
      // Real I/O stays in tmpdir. WSL mount layout and Windows names exercise path operands only.
      const project = path.join(root, platform === 'wsl-path-simulated' ? 'mnt/c/Users/Test Operator/project' : 'Project With Spaces');
      const user = path.join(root, 'User Home With Spaces', '.grok');
      const source = path.join(root, 'source');
      const skill = path.join(source, 'skills', 'aiwg-puw');
      const agent = path.join(source, 'agents', 'puw-worker.md');
      const skillBody = (version: number) => `---\nname: aiwg-puw\ndescription: Offline qualification\nkernel: true\n---\nVersion ${version}\n`;
      put(path.join(skill, 'SKILL.md'), skillBody(1));
      const agentBody = '---\nname: puw-worker\ndescription: Synthetic role\nmodel: sonnet\n---\n\nScoped prompt.\n';
      put(agent, agentBody);
      mkdirSync(project, { recursive: true });
      mkdirSync(user, { recursive: true });
      const operator: Record<string, string> = {};
      if (state === 'existing') {
        for (const relative of ['.grok/config.toml', '.grok/skills/operator/SKILL.md', '.grok/agents/operator.md', '.grok/rules/operator.md',
          '.grok/hooks/operator.mjs', '.grok/sessions/operator.json', '.agents/skills/operator/SKILL.md', '.claude/skills/operator/SKILL.md', 'CLAUDE.md', 'WORKSPACE.md']) {
          operator[path.join(project, relative)] = '# operator SECRET_CANARY_2580\n';
        }
        operator[path.join(user, 'config.toml')] = '# user SECRET_CANARY_2580\n';
        operator[path.join(user, 'skills/operator/SKILL.md')] = '# operator user skill\n';
        for (const [file, bytes] of Object.entries(operator)) put(file, bytes);
        put(path.join(project, 'AGENTS.md'), '# Operator project guidance\n');
      }
      // Clean install + deploy. Compatibility trees are optional and never source dependencies.
      const options = { srcRoot: source, target: project, mode: 'all', provider: 'grok-build', quiet: true, contextFiles: false, deployVersion: 'puw-1' };
      await deploy(options);
      deploySkills([skill], project, { srcRoot: source, provider: 'grok-build', quiet: true });
      createAgentsMd(project, repo, false);
      const nativeSkill = path.join(project, '.grok/skills/aiwg-puw/SKILL.md');
      expect(readFileSync(nativeSkill, 'utf8')).toContain('Version 1');
      expect(readFileSync(path.join(project, '.grok/agents/puw-worker.md'), 'utf8')).toContain('Scoped prompt.');
      if (state === 'existing') expect(readFileSync(path.join(project, 'AGENTS.md'), 'utf8')).toContain('# Operator project guidance');
      // User scope is explicit and must leave the project native surface unchanged.
      const projectBeforeUser = snapshot(path.join(project, '.grok'));
      const userPaths = { agents: path.join(user, 'agents'), skills: path.join(user, 'skills') };
      const projectPaths = { agents: path.join(project, '.grok/agents'), skills: path.join(project, '.grok/skills') };
      await assertGrokUserMirrorPaths(projectPaths, userPaths);
      await mirrorArtifactDir(projectPaths.skills, userPaths.skills);
      expect(readFileSync(path.join(user, 'skills/aiwg-puw/SKILL.md'), 'utf8')).toContain('Version 1');
      expect(snapshot(path.join(project, '.grok'))).toEqual(projectBeforeUser);
      // Update then refresh with the same source; repeat deployments retain authored bytes.
      put(path.join(skill, 'SKILL.md'), skillBody(2));
      await deploy({ ...options, deployVersion: 'puw-2' });
      expect(readFileSync(nativeSkill, 'utf8')).toContain('Version 2');
      const refreshed = readFileSync(nativeSkill, 'utf8');
      const instructionsBefore = readFileSync(path.join(project, 'AGENTS.md'), 'utf8');
      await deploy({ ...options, deployVersion: 'puw-2' });
      createAgentsMd(project, repo, false);
      expect(readFileSync(nativeSkill, 'utf8')).toBe(refreshed);
      expect(readFileSync(path.join(project, 'AGENTS.md'), 'utf8')).toBe(instructionsBefore);
      await mirrorArtifactDir(projectPaths.skills, userPaths.skills);
      expect(readFileSync(path.join(user, 'skills/aiwg-puw/SKILL.md'), 'utf8')).toContain('Version 2');
      // Verify real inspector validation using synthetic native data, without executing Grok.
      const inspection = { projectInstructions: [{ path: 'AGENTS.md' }], skills: [{ name: 'aiwg-puw' }], agents: [{ name: 'puw-worker' }] };
      const expected = { instructionPaths: ['AGENTS.md'], skillNames: ['aiwg-puw'], agentNames: ['puw-worker'] };
      expect(validateGrokInspectReport(inspection, expected)).toEqual([]);
      expect(validateGrokInspectReport({ ...inspection, skills: [] }, expected)).toHaveLength(1);
      // A compilation failure is staged: the exact project preimage survives.
      const beforeFailure = snapshot(project);
      put(agent, 'invalid agent frontmatter');
      await expect(deploy(options)).rejects.toThrow(/frontmatter/);
      expect(snapshot(project)).toEqual(beforeFailure);
      // Refuse a path escape before writing to the linked target.
      const outside = path.join(root, 'outside');
      mkdirSync(outside);
      const linked = path.join(root, 'linked');
      mkdirSync(linked);
      symlinkSync(outside, path.join(linked, '.grok'), 'junction');
      expect(() => deploySkills([skill], linked, { srcRoot: source, quiet: true })).toThrow(/unsafe/);
      expect(readdirSync(outside)).toEqual([]);
      const preview = uninstall(project, { srcRoot: source, dryRun: true });
      expect(preview.planned).toContain('.grok/skills/aiwg-puw');
      expect(existsSync(nativeSkill)).toBe(true);
      for (const relative of Object.keys(snapshot(project)).filter(file => file.endsWith('.aiwg-manifest.json'))) {
        expect(readFileSync(path.join(project, relative), 'utf8')).not.toContain('SECRET_CANARY_2580');
      }
      uninstall(project, { srcRoot: source });
      expect(existsSync(nativeSkill)).toBe(false);
      expect(uninstall(project, { srcRoot: source }).removed).toEqual([]);
      uninstall(path.dirname(user), { srcRoot: source });
      expect(existsSync(path.join(user, 'skills/aiwg-puw/SKILL.md'))).toBe(false);
      for (const [file, bytes] of Object.entries(operator)) expect(readFileSync(file, 'utf8')).toBe(bytes);
      for (const method of ['log', 'warn', 'error'] as const) {
        expect(vi.mocked(console[method]).mock.calls.flat().join('\n')).not.toContain('SECRET_CANARY_2580');
      }
    };
    if (platform === 'windows-powershell-simulated') await withWindows(exercise, { profile: path.join(root, 'home') });
    else await exercise();
  });
});

it('schedules upstream drift and gates promotion without any paid CI step or credential retrieval', () => {
  const workflow = load(readFileSync(path.join(repo, '.gitea/workflows/grok-build-qualification.yml'), 'utf8')) as any;
  expect(workflow.on.schedule).toHaveLength(1);
  expect(workflow.on.push.tags).toContain('v*');
  const commands = workflow.jobs.qualification.steps.map((step: any) => step.run || '').join('\n');
  expect(commands).toContain('grok-build-qualification.mjs gate');
  expect(commands).toContain('grok-build-qualification.mjs drift');
  expect(commands).not.toMatch(/vault-fetch|grok-build-native-smoke|grok login/);
});
