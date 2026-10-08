import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const cli = resolve(__dirname, '../../../src/mcp/cli.mjs');
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aiwg-codex-home-cli-'));
  for (const dir of ['home/.codex', 'config', 'project']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'home/.codex/config.toml'), 'operator = "unchanged"\n');
  writeFileSync(join(root, 'config/mcp-servers.json'), JSON.stringify({
    apiVersion: 'aiwg.io/v1', kind: 'McpServerRegistry',
    servers: { remote: { name: 'remote', type: 'http', url: 'https://example.test/mcp' } },
  }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe.each(['codex', 'openai'])('%s CLI respects CODEX_HOME', provider => {
  it.each(['inject', 'install', 'install-dry-run'])('uses a custom directory for %s', command => {
    const codexHome = join(root, 'custom-codex');
    const args = command === 'inject' ? ['inject', '--provider', provider]
      : ['install', provider, ...(command === 'install-dry-run' ? ['--dry-run'] : [])];
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      cwd: join(root, 'project'), encoding: 'utf-8', timeout: 60_000,
      env: { PATH: process.env.PATH, HOME: join(root, 'home'), CODEX_HOME: codexHome, AIWG_CONFIG: join(root, 'config') },
    });
    expect(stdout).toContain(join(codexHome, 'config.toml'));
    expect(readFileSync(join(root, 'home/.codex/config.toml'), 'utf-8')).toBe('operator = "unchanged"\n');
    if (command === 'install-dry-run') expect(existsSync(codexHome)).toBe(false);
    else expect(readFileSync(join(codexHome, 'config.toml'), 'utf-8'))
      .toContain(command === 'inject' ? '[mcp_servers.remote]' : '[mcp_servers.aiwg]');
  });
});
