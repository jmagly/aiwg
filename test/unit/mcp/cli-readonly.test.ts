import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const cliPath = resolve(__dirname, '../../../src/mcp/cli.mjs');
const doctorPath = resolve(__dirname, '../../../tools/cli/doctor.mjs');
let root: string;
let projectDir: string;
let configDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aiwg-mcp-readonly-'));
  projectDir = join(root, 'project');
  configDir = join(root, 'config');
  const homeDir = join(root, 'home');
  for (const dir of [projectDir, configDir, homeDir]) mkdirSync(dir, { recursive: true });
  env = {
    PATH: process.env.PATH, HOME: homeDir, CODEX_HOME: join(homeDir, '.codex'),
    AIWG_CONFIG: configDir, TMPDIR: root,
    AIWG_ROOT: resolve(__dirname, '../../..'), AIWG_BIN: join(root, 'unavailable-aiwg'),
    AIWG_UPDATE_CHECK: 'false',
  };
  writeFileSync(join(configDir, 'mcp-servers.json'), JSON.stringify({
    apiVersion: 'aiwg.io/v1', kind: 'McpServerRegistry',
    servers: { git: { name: 'git', type: 'stdio', command: 'git-mcp' } },
  }));
  writeFileSync(join(configDir, 'mcp-profiles.json'), JSON.stringify({
    apiVersion: 'aiwg.io/v1', kind: 'McpProfileRegistry',
    profiles: {
      restricted: { name: 'restricted', servers: ['git'], providerOverrides: { claude: { toolAllow: ['git__list'] } } },
    },
  }));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: projectDir, env, encoding: 'utf-8', timeout: 60_000,
  });
  if (result.error) throw result.error;
  return result;
}

describe('read-only paths with Claude toolAllow refusal', () => {
  it.each([['profile', 'show', 'restricted'], ['profile', 'list'], ['list']])(
    'displays %j without evaluating the unsupported filter', (...args) => {
      const result = run(cliPath, args);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain(args[0] === 'list' ? 'git' : 'restricted');
      if (args[1] === 'show') expect(result.stdout).toContain('toolAllow: git__list');
    },
  );

  it.each([false, true])('reports a clear dry-run refusal (ephemeral: %s) without writing', ephemeral => {
    const original = readFileSync(join(configDir, 'mcp-profiles.json'), 'utf-8');
    const args = ['inject', '--provider', 'claude', '--profile', 'restricted', '--dry-run'];
    if (ephemeral) args.push('--ephemeral', '--out', join(root, 'ephemeral.json'));
    const result = run(cliPath, args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Error:');
    expect(result.stderr).toContain('toolAllow');
    expect(result.stderr).toContain('git__list');
    expect(result.stderr).not.toMatch(/\n\s+at /);
    expect(existsSync(join(projectDir, '.mcp.json'))).toBe(false);
    expect(existsSync(join(root, 'ephemeral.json'))).toBe(false);
    expect(readFileSync(join(configDir, 'mcp-profiles.json'), 'utf-8')).toBe(original);
  });

  it('doctor completes its diagnostics without evaluating profile toolAllow', () => {
    const original = readFileSync(join(configDir, 'mcp-profiles.json'), 'utf-8');
    const result = run(doctorPath, ['--provider', 'claude']);
    expect(result.stdout).toContain('AIWG Doctor');
    expect(result.stdout).toMatch(/(?:FAIL|WARN|OK) /);
    expect(result.stderr).not.toContain('Doctor failed:');
    expect(result.stderr).not.toContain('toolAllow');
    expect(readFileSync(join(configDir, 'mcp-profiles.json'), 'utf-8')).toBe(original);
  });
});
