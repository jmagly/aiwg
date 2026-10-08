import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const cliPath = resolve(__dirname, '../../../src/mcp/cli.mjs');
let root: string;

function run(args: string[]) {
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd: join(root, 'project'),
    encoding: 'utf-8',
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      HOME: join(root, 'home'),
      AIWG_CONFIG: join(root, 'config'),
      TMPDIR: root,
    },
  });
}

function inject(out: string, extra: string[] = []) {
  return run(['inject', '--provider', 'claude', '--profile', 'triage', '--ephemeral', '--out', out, ...extra]);
}

function configSnapshot(dir = join(root, 'config')): Record<string, string> {
  return Object.fromEntries(readdirSync(dir).sort().flatMap(name => {
    const file = join(dir, name);
    return statSync(file).isDirectory() ? Object.entries(configSnapshot(file)) : [[file, readFileSync(file, 'utf-8')]];
  }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aiwg-ephemeral-settings-'));
  for (const dir of ['config', 'project', 'home']) mkdirSync(join(root, dir));
  writeFileSync(join(root, 'config', 'mcp-servers.json'), JSON.stringify({
    apiVersion: 'aiwg.io/v1', kind: 'McpServerRegistry',
    servers: { tracker: { name: 'tracker', type: 'stdio', command: 'tracker-mcp' } },
  }));
  run(['profile', 'add', 'triage', '--servers', 'tracker', '--tool-deny', 'tracker__delete_issue']);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('ephemeral Claude settings safety', () => {
  it('passes the deny-only sidecar to Claude and keeps both outputs private on reinjection', () => {
    const out = join(root, 'triage.json');
    const settings = join(root, 'triage.settings.json');
    expect(inject(out)).toContain(`claude --mcp-config ${out} --settings ${settings}`);
    expect(JSON.parse(readFileSync(settings, 'utf-8')).permissions).toEqual({ deny: ['mcp__tracker__delete_issue'] });
    if (process.platform !== 'win32') {
      for (const file of [out, settings]) {
        expect(statSync(file).mode & 0o777).toBe(0o600);
        chmodSync(file, 0o644);
      }
      inject(out);
      for (const file of [out, settings]) expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses to overwrite an existing sidecar that AIWG did not create', () => {
    const out = join(root, 'triage.json');
    const settings = join(root, 'triage.settings.json');
    const original = JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] } });
    writeFileSync(settings, original);
    expect(() => inject(out)).toThrow(/sidecar|AIWG|created|owned/i);
    expect(existsSync(out)).toBe(false);
    expect(readFileSync(settings, 'utf-8')).toBe(original);
    expect(readdirSync(join(root, 'config')).sort()).toEqual(['mcp-profiles.json', 'mcp-servers.json']);
  });

  it('rejects a settings symlink before writing the MCP config', () => {
    const out = join(root, 'triage.json');
    const target = join(root, 'operator.json');
    writeFileSync(target, JSON.stringify({ permissions: { deny: [] } }));
    symlinkSync(target, join(root, 'triage.settings.json'));
    expect(() => inject(out)).toThrow(/symlink|symbolic link/i);
    expect(existsSync(out)).toBe(false);
    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ permissions: { deny: [] } });
  });

  it('rejects a symlink parent even when --out is outside the project', () => {
    const actual = join(root, 'actual');
    const link = join(root, 'linked');
    mkdirSync(actual);
    symlinkSync(actual, link, 'dir');
    expect(() => inject(join(link, 'triage.json'))).toThrow(/parent directory is a symlink/);
    expect(readdirSync(actual)).toEqual([]);
  });

  it.each([
    ['invalid JSON', '{'],
    ['array root', '[]'],
    ['array permissions', '{"permissions":[]}'],
    ['non-array deny', '{"permissions":{"deny":"Bash(rm:*)"}}'],
    ['non-string rule', '{"permissions":{"allow":[123]}}'],
  ])('validates %s in an owned sidecar before changing either file or receipts', (_name, invalid) => {
    const out = join(root, 'triage.json');
    const settings = join(root, 'triage.settings.json');
    inject(out);
    const originalMcp = readFileSync(out, 'utf-8');
    writeFileSync(settings, invalid);
    run(['profile', 'edit', 'triage', '--tool-deny', 'tracker__admin_*']);
    const originalConfig = configSnapshot();
    expect(() => inject(out)).toThrow();
    expect(readFileSync(out, 'utf-8')).toBe(originalMcp);
    expect(readFileSync(settings, 'utf-8')).toBe(invalid);
    expect(configSnapshot()).toEqual(originalConfig);
  });

  it.each([false, true])('refuses Claude toolAllow before creating outputs (empty selection: %s)', empty => {
    run(['profile', 'edit', 'triage', '--provider', 'claude', '--tool-allow', 'tracker__list_issues']);
    if (empty) {
      const registryPath = join(root, 'config', 'mcp-servers.json');
      const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
      registry.servers = {};
      writeFileSync(registryPath, JSON.stringify(registry));
    }
    const out = join(root, 'triage.json');
    expect(() => inject(out)).toThrow(/tracker__list_issues/);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(join(root, 'triage.settings.json'))).toBe(false);
    expect(readdirSync(join(root, 'config')).sort()).toEqual(['mcp-profiles.json', 'mcp-servers.json']);
  });

  it('dry-runs without creating outputs or permission ownership records', () => {
    const out = join(root, 'triage.json');
    expect(inject(out, ['--dry-run'])).toContain('[DRY RUN] Tool permissions:');
    expect(existsSync(out)).toBe(false);
    expect(existsSync(join(root, 'triage.settings.json'))).toBe(false);
    expect(readdirSync(join(root, 'config')).sort()).toEqual(['mcp-profiles.json', 'mcp-servers.json']);
  });
});
