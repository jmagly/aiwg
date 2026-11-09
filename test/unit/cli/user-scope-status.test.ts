// Exercise global engagement through the public CLI with a disposable HOME.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const root = mkdtempSync(join(tmpdir(), 'aiwg-4028-'));
const home = join(root, 'home');
const providers = ['claude', 'codex', 'muse', 'pi', 'opencode'];
const env = {
  ...process.env, HOME: home, USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
  XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local/state'),
  AIWG_ROOT: repo, AIWG_HOME: repo, AIWG_CONFIG: join(home, '.aiwg'),
  AIWG_USER_REGISTRY_PATH: '', CODEX_HOME: '', PI_CODING_AGENT_DIR: '',
  AIWG_LOG_LEVEL: 'silent', NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1',
};
let deployed = '';

function cli(args: string[], cwd = home) {
  const result = spawnSync(process.execPath, [join(repo, 'bin/aiwg.mjs'), ...args], {
    cwd, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
  });
  expect(result.error, result.stderr).toBeUndefined();
  return result;
}

beforeAll(() => {
  mkdirSync(home);
  const init = cli(['init', '--providers', providers.join(','), '--default-scripts', 'true',
    '--custom-scripts', 'false', '--worker-dispatch', 'decline', '--non-interactive']);
  expect(init.status, init.stderr + init.stdout).toBe(0);
  const use = cli(['use', 'all', '--global', '--providers', providers.join(','), '--no-hooks']);
  expect(use.status, use.stderr + use.stdout).toBe(0);
  deployed = use.stdout + use.stderr;
}, 240_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('global-only home install (#4028)', () => {
  it('recognizes all five user deployments without a home project deployment', () => {
    const result = cli(['status', '--probe', '--json']);
    const probe = JSON.parse(result.stdout);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(probe.engaged).toBe(true);
    expect(probe.checks.framework_count).toBe(1);
    expect(probe.checks.provider_deployment_count).toBe(5);
    expect(probe.deployment_verification.scope).toBe('user');
    expect(probe.provider_deployments.map((p: { provider: string }) => p.provider).sort()).toEqual([...providers].sort());
    expect(probe.verification.next_command).toBeNull();
    const config = JSON.parse(readFileSync(join(home, '.aiwg/aiwg.config'), 'utf8'));
    expect(Object.keys(config.installed ?? {})).toHaveLength(0);
  });

  it('does not require a project receipt for a successful user deployment', () => {
    expect(deployed).not.toContain('Project registry does not describe');
  });

  it('recognizes user deployments through the standalone status script too', () => {
    const result = spawnSync(process.execPath, [join(repo, 'tools/cli/workspace-status.mjs'), '--probe', '--json'], {
      cwd: home, env, encoding: 'utf8', timeout: 30_000,
    });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ engaged: true,
      checks: { framework_count: 1, provider_deployment_count: 5 } });
  });

  it('keeps the explicit project-scope probe separate', () => {
    const result = cli(['status', '--probe', '--scope', 'project', '--json']);
    expect(JSON.parse(result.stdout)).toMatchObject({ engaged: false, status: 'not-configured' });
  });

  it('keeps project scope in another directory and reports user scope when asked', () => {
    const project = join(root, 'other-project');
    mkdirSync(project);
    // Unqualified: a project without its own deployment is not a broken user deployment.
    const unqualified = cli(['status', '--probe', '--json'], project);
    expect(unqualified.status).toBe(0);
    expect(JSON.parse(unqualified.stdout).deployment_verification.scope).toBe('project');
    // Explicit user scope still shows the global install and an actionable context repair.
    const probe = JSON.parse(cli(['status', '--probe', '--json', '--scope', 'user'], project).stdout);
    expect(probe.checks.framework_count).toBe(1);
    expect(probe.checks.provider_deployment_count).toBe(5);
    expect(probe.engaged).toBe(false);
    expect(probe.verification.next_command).toContain('regenerate');
  });

  it('applies the kernel-only exemption at HOME without hiding a broken project deployment', () => {
    const result = cli(['doctor', '--provider', 'claude', '--no-budget-check']);
    expect(result.stdout).toContain('Claude Code Agents: 0 agents deployed');
    expect(result.stdout).not.toContain('Half-deployed tree');
    expect(result.stdout).not.toContain('aiwg use sdlc --provider claude');
    const project = join(root, 'broken-project');
    mkdirSync(join(project, '.aiwg'), { recursive: true });
    mkdirSync(join(project, '.claude/rules'), { recursive: true });
    writeFileSync(join(project, '.aiwg/aiwg.config'), JSON.stringify({
      version: '1.0', providers: ['claude'], scripts: {}, installed: {},
    }));
    writeFileSync(join(project, '.claude/rules/fixture.md'), '# Fixture\n');
    expect(cli(['doctor', '--provider', 'claude', '--no-budget-check'], project).stdout).toContain('Half-deployed tree');
    const configPath = join(home, '.aiwg/aiwg.config');
    const originalConfig = readFileSync(configPath, 'utf8');
    try {
      const config = JSON.parse(originalConfig);
      config.installed = { sdlc: { version: 'test', source: 'bundled', installedAt: new Date().toISOString(),
        deployedTo: { claude: { agents: 12, commands: 0, skills: 1, rules: 1 } } } };
      writeFileSync(configPath, JSON.stringify(config));
      const drift = cli(['doctor', '--provider', 'claude', '--no-budget-check']);
      expect(drift.stdout).toContain('Half-deployed tree');
      expect(drift.stdout).toContain('Recorded deployment drift');
    } finally {
      writeFileSync(configPath, originalConfig);
    }
  }, 240_000);

  it('rejects a user receipt whose managed artifacts disappeared', () => {
    rmSync(join(home, '.claude'), { recursive: true, force: true });
    const result = cli(['status', '--probe', '--provider', 'claude', '--json']);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ engaged: false, status: 'needs-repair' });
  });
});
