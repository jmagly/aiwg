/**
 * Practical end-to-end coverage for `aiwg use --provider grok-build`.
 * Project deploy, $GROK_HOME user mirroring, registry record, and receipts.
 * Reviewed project removal is covered here; live `grok inspect` verification
 * remains separate from this deterministic absent-binary integration path.
 *
 * @issue #2575
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(__dirname, '../..');
const roots: string[] = [];

function isolated(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runUse(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const routerUrl = pathToFileURL(path.join(REPO_ROOT, 'src/cli/router.ts')).href;
  const runner = `import { run } from ${JSON.stringify(routerUrl)}; await run(process.argv.slice(1), { cwd: process.env.AIWG_TEST_PROJECT_ROOT }); process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--eval', runner, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 180_000,
    env: {
      ...process.env,
      ...env,
      NO_UPDATE_NOTIFIER: '1',
    },
  });
  let json: Record<string, unknown> = {};
  try {
    json = result.stdout ? JSON.parse(result.stdout) : {};
  } catch {
    json = { raw: result.stdout };
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    json,
  };
}

function runRemoval(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  // CI builds the packaged CLI before tests. Exercise that path when available;
  // source-only local test runs can still validate the removal contract.
  if (!existsSync(path.join(REPO_ROOT, 'dist/src/cli/router.js'))) return runUse(args, env, cwd);
  const routerUrl = pathToFileURL(path.join(REPO_ROOT, 'dist/src/cli/router.js')).href;
  const runner = `import { run } from ${JSON.stringify(routerUrl)}; await run(process.argv.slice(1), { cwd: process.env.AIWG_TEST_PROJECT_ROOT }); process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);`;
  const result = spawnSync(process.execPath, ['--eval', runner, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, ...env, NO_UPDATE_NOTIFIER: '1' },
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('aiwg use grok-build e2e (#2575)', () => {
  it('deploys project kernel skills, mirrors to $GROK_HOME, and records registry/receipts', () => {
    const home = isolated('aiwg-grok-use-home-');
    const project = isolated('aiwg-grok-use-project-');
    const grokHome = path.join(home, 'custom-grok-home');
    const operatorProjectSkill = path.join(project, '.grok', 'skills', 'operator', 'SKILL.md');
    const operatorUserSkill = path.join(grokHome, 'skills', 'operator', 'SKILL.md');
    mkdirSync(path.dirname(operatorProjectSkill), { recursive: true });
    mkdirSync(path.dirname(operatorUserSkill), { recursive: true });
    writeFileSync(operatorProjectSkill, '# Operator-owned project skill\n');
    writeFileSync(operatorUserSkill, '# Operator-owned user skill\n');
    const operatorConfig = '[mcp_servers.operator]\ncommand = "operator-tool"\n# SECRET_CANARY_2580\n';
    writeFileSync(path.join(project, '.grok', 'config.toml'), operatorConfig);
    mkdirSync(path.join(home, '.aiwg'), { recursive: true });
    writeFileSync(path.join(home, '.aiwg', 'channel.json'), JSON.stringify({
      channel: 'edge',
      edgePath: REPO_ROOT,
      devMode: true,
    }));
    const userRegistry = path.join(home, '.aiwg', 'installed.json');

    const useArgs = [
      'use', 'sdlc',
      '--provider', 'grok-build',
      '--target', project,
      '--scope', 'user',
      '--no-project-local',
      '--no-utils',
      '--json',
    ];
    const useEnv = {
      HOME: home,
      USERPROFILE: home,
      XDG_CACHE_HOME: path.join(home, '.cache'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      AIWG_USER_REGISTRY_PATH: userRegistry,
      AIWG_TEST_PROJECT_ROOT: project,
      GROK_HOME: grokHome,
      // Keep the runner's Node executable available without normal Grok install roots.
      PATH: path.dirname(process.execPath),
    };
    const use = runUse(useArgs, useEnv, project);

    expect(use.status, use.stderr || use.stdout).toBe(0);
    expect(readFileSync(operatorProjectSkill, 'utf8')).toBe('# Operator-owned project skill\n');
    expect(readFileSync(operatorUserSkill, 'utf8')).toBe('# Operator-owned user skill\n');
    expect(readFileSync(path.join(project, '.grok', 'config.toml'), 'utf8')).toBe(operatorConfig);
    expect(use.stdout + use.stderr).not.toContain('SECRET_CANARY_2580');
    const repeated = runUse(useArgs, useEnv, project);
    expect(repeated.status, repeated.stderr || repeated.stdout).toBe(0);
    expect(readFileSync(operatorProjectSkill, 'utf8')).toBe('# Operator-owned project skill\n');
    expect(readFileSync(operatorUserSkill, 'utf8')).toBe('# Operator-owned user skill\n');
    expect(use.json).toMatchObject({
      schema: 'aiwg.use.result.v1',
    });

    expect(existsSync(path.join(project, 'AGENTS.md'))).toBe(true);
    expect(readFileSync(path.join(project, 'AGENTS.md'), 'utf8')).toMatch(/Grok Build|grok-build/i);
    expect(existsSync(path.join(project, '.grok', 'skills'))).toBe(true);
    const projectSkills = readdirSync(path.join(project, '.grok', 'skills')).filter((name) =>
      existsSync(path.join(project, '.grok', 'skills', name, 'SKILL.md')));
    expect(projectSkills.length).toBeGreaterThan(0);
    expect(projectSkills.length).toBeLessThan(80);
    // No full-corpus dump into the standard mirror without --copy-all.
    expect(existsSync(path.join(project, '.grok', '.aiwg', 'skills'))).toBe(false);
    // Qualified native agent writer deploys the model-worker wrappers (#2577).
    const projectAgents = path.join(project, '.grok', 'agents');
    expect(existsSync(projectAgents)).toBe(true);
    expect(readdirSync(projectAgents).filter(name => name.endsWith('.md')).length).toBeGreaterThan(0);
    expect(existsSync(path.join(project, '.grok', 'rules'))).toBe(false);

    // User-scope mirror via $GROK_HOME/skills
    expect(existsSync(path.join(grokHome, 'skills'))).toBe(true);
    const userSkills = readdirSync(path.join(grokHome, 'skills')).filter((name) =>
      existsSync(path.join(grokHome, 'skills', name, 'SKILL.md')));
    expect(userSkills.length).toBeGreaterThan(0);

    // The user registry must record the actual provider deployment and entries.
    expect(existsSync(userRegistry)).toBe(true);
    const registry = JSON.parse(readFileSync(userRegistry, 'utf8')) as {
      installed?: Record<string, { deployedTo?: Record<string, {
        skills?: number;
        entries?: { skills?: string[] };
      }> }>;
    };
    const recorded = registry.installed?.sdlc?.deployedTo?.['grok-build'];
    expect(recorded?.skills).toBeGreaterThan(0);
    expect(recorded?.entries?.skills?.length).toBeGreaterThan(0);

    // Local-source delivery deterministically emits the policy-exempt evidence state.
    const evidencePath = path.join(
      project,
      '.aiwg',
      'receipts',
      'providers',
      'grok-build.user.evidence.json',
    );
    expect(existsSync(evidencePath)).toBe(true);
    expect(JSON.parse(readFileSync(evidencePath, 'utf8'))).toMatchObject({
      schemaVersion: 'aiwg.provider-transformation-evidence-state.v1',
      provider: 'grok-build',
      scope: 'user',
      disposition: 'local-source',
    });
    expect(readFileSync(evidencePath, 'utf8')).not.toContain('SECRET_CANARY_2580');

    expect(use.json).toMatchObject({
      providers: [expect.objectContaining({
        provider: 'grok-build',
        findings: expect.arrayContaining([
          expect.objectContaining({ id: 'grok-inspect-absent', severity: 'advisory' }),
        ]),
      })],
    });

    const managedSkill = path.join(project, '.grok', 'skills', 'aiwg-help', 'SKILL.md');
    const originalSkill = readFileSync(managedSkill, 'utf8');
    writeFileSync(managedSkill, `${originalSkill}\nOperator modification.\n`);
    const modifiedPreview = runRemoval(['remove', 'grok-build', '--provider', 'grok-build', '--dry-run'], useEnv, project);
    expect(modifiedPreview.status).toBe(1);
    expect(modifiedPreview.stdout + modifiedPreview.stderr).toContain('Preserved modified or unverifiable: .grok/skills/aiwg-help');
    expect(readFileSync(managedSkill, 'utf8')).toContain('Operator modification.');
    writeFileSync(managedSkill, originalSkill);

    const addedFile = path.join(path.dirname(managedSkill), 'operator-note.txt');
    writeFileSync(addedFile, 'Preserve this operator file.\n');
    const addedFilePreview = runRemoval(['remove', 'grok-build', '--provider', 'grok-build', '--dry-run'], useEnv, project);
    expect(addedFilePreview.status).toBe(1);
    expect(existsSync(addedFile)).toBe(true);
    rmSync(addedFile);

    const preview = runRemoval(['remove', 'grok-build', '--provider', 'grok-build', '--dry-run'], useEnv, project);
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain('Would remove');
    expect(preview.stdout).not.toContain(operatorProjectSkill);
    expect(preview.stdout).not.toContain('SECRET_CANARY_2580');
    expect(existsSync(managedSkill)).toBe(true);

    const removal = runRemoval(['remove', 'grok-build', '--provider', 'grok-build'], useEnv, project);
    expect(removal.status, removal.stderr).toBe(0);
    expect(existsSync(managedSkill)).toBe(false);
    expect(readdirSync(projectAgents).filter(name => name.endsWith('.md'))).toHaveLength(0);
    expect(readFileSync(operatorProjectSkill, 'utf8')).toBe('# Operator-owned project skill\n');
    expect(readFileSync(operatorUserSkill, 'utf8')).toBe('# Operator-owned user skill\n');
    expect(readFileSync(path.join(project, '.grok', 'config.toml'), 'utf8')).toBe(operatorConfig);
    expect(existsSync(path.join(project, 'AGENTS.md'))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(project, '.aiwg', 'aiwg.config'), 'utf8')).installed?.sdlc).toBeUndefined();
  }, 180_000);
});
