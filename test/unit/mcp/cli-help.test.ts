import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../../../src/mcp/server.mjs';
import { KNOWN_TOOLSETS, registerOptInToolsets } from '../../../src/mcp/tools/subsystems.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
let root: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'aiwg-mcp-help-'));
  const home = path.join(root, 'home');
  mkdirSync(path.join(root, '.aiwg'));
  mkdirSync(home);
  env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'),
    AIWG_CONFIG: path.join(home, 'config'), AIWG_ROOT: repoRoot, TMPDIR: root,
    AIWG_PROJECT_AIWG_DIR: path.join(root, '.aiwg'), AIWG_MCP_TOOLSETS: '' };
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.spyOn(process, 'cwd').mockReturnValue(root);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
function run(command: string) {
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'src/mcp/cli.mjs'), command], {
    cwd: root, env, encoding: 'utf8', timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  return result.stdout;
}
describe('MCP capability help', () => {
  it('documents the authenticated, project-bound HTTP options', () => {
    const output = run('--help');
    for (const flag of ['--project', '--token-env', '--token-file', '--host', '--allow-remote-bind', '--allowed-host', '--max-sessions', '--tools']) {
      expect(output).toContain(flag);
    }
    expect(output).toContain('127.0.0.1');
    expect(output).toContain('stdio (default)');
  });
  it('reports counts equal to the registered core and every optional toolset', async () => {
    const server = await createServer();
    try {
      const core = Object.keys(server._registeredTools).length;
      const names = new Set<string>();
      await registerOptInToolsets({ registerTool: (name: string) => names.add(name) }, new Set(KNOWN_TOOLSETS), {
        projectRoot: root, stdinRuntimeRoot: path.join(root, 'stdin'),
      });
      const output = run('info');
      expect(Number(output.match(/CORE TOOLS \((\d+),/)?.[1])).toBe(core);
      expect(Number(output.match(/OPT-IN TOOLSETS \((\d+) additional tools/)?.[1])).toBe(names.size);
      for (const name of KNOWN_TOOLSETS) expect(output).toMatch(new RegExp(`^  ${name} +`, 'm'));
      expect(output).toContain('ask-user');
      expect(output).toContain('aiwg_authorization_grant_request');
    } finally {
      await server.close();
    }
  });
  it.each(['info', '--help'])('%s explains explicit workers opt-in and decision', command => {
    const output = run(command);
    expect(output).toContain('decision');
    expect(output).toContain('--toolsets all,workers');
    expect(output).toMatch(/all.*excludes workers/i);
  });
});
