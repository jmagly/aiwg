/**
 * Unit tests for tools/cli/clean-providers.mjs
 *
 * `npm run clean:providers` used to `rm -rf .claude` wholesale, destroying
 * Claude Desktop/Code-owned state that AIWG never wrote (worktrees/,
 * settings.local.json, settings.json and its backups, launch.json). These
 * tests spawn the real script against a synthetic scratch project — no
 * dependency on this host's installed CLIs or home directory — and assert
 * that user-owned files under `.claude/` survive while the AIWG-managed
 * subpaths (and every other provider target, unchanged) are removed.
 *
 * #3055 found the same shape of problem in three more targets AIWG merges
 * entries into rather than owns outright: the Cursor project MCP file
 * (`.cursor/mcp.json`), the Antigravity project MCP file
 * (`.agents/mcp_config.json`), and `opencode.json`'s `instructions` entry.
 * Every `AIWG_CONFIG` passed to the script below points at an isolated
 * scratch directory so these tests never read this host's real
 * `~/.aiwg/mcp-servers.json`.
 *
 * @implements #2626
 * @implements #3055
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, '../../../tools/cli/clean-providers.mjs');

const scratchRoots: string[] = [];

async function makeScratchProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aiwg-clean-providers-'));
  scratchRoots.push(dir);
  return dir;
}

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function seedClaudeDir(projectDir: string): Promise<void> {
  // AIWG-managed subpaths — expected to be removed.
  await mkdir(join(projectDir, '.claude', 'agents'), { recursive: true });
  await writeFile(join(projectDir, '.claude', 'agents', 'some-agent.md'), 'agent', 'utf-8');
  await mkdir(join(projectDir, '.claude', 'commands'), { recursive: true });
  await writeFile(join(projectDir, '.claude', 'commands', 'some-command.md'), 'cmd', 'utf-8');
  await mkdir(join(projectDir, '.claude', '.aiwg', 'skills', 'some-skill'), { recursive: true });
  await writeFile(join(projectDir, '.claude', '.aiwg', 'skills', 'some-skill', 'SKILL.md'), 'skill', 'utf-8');
  await mkdir(join(projectDir, '.claude', 'rules'), { recursive: true });
  await writeFile(join(projectDir, '.claude', 'rules', 'some-rule.md'), 'rule', 'utf-8');
  await mkdir(join(projectDir, '.claude', 'hooks'), { recursive: true });
  await writeFile(join(projectDir, '.claude', 'hooks', 'some-hook.mjs'), 'hook', 'utf-8');
  await mkdir(join(projectDir, '.claude', 'skills', 'kernel-skill'), { recursive: true });
  await writeFile(join(projectDir, '.claude', 'skills', 'kernel-skill', 'SKILL.md'), 'kernel skill', 'utf-8');

  // Claude Desktop/Code-owned state — expected to survive.
  await writeFile(join(projectDir, '.claude', 'settings.json'), '{"hooks":{}}', 'utf-8');
  await writeFile(
    join(projectDir, '.claude', 'settings.json.bak.2026-01-01T00-00-00-000Z'),
    '{}',
    'utf-8',
  );
  await writeFile(join(projectDir, '.claude', 'settings.local.json'), '{"model":"opus"}', 'utf-8');
  await writeFile(join(projectDir, '.claude', 'launch.json'), '{}', 'utf-8');
  await mkdir(join(projectDir, '.claude', 'worktrees', 'feature-x'), { recursive: true });
  await writeFile(
    join(projectDir, '.claude', 'worktrees', 'feature-x', 'session.json'),
    '{"id":"abc"}',
    'utf-8',
  );
}

async function seedOtherProviderTargets(projectDir: string): Promise<void> {
  await mkdir(join(projectDir, '.codex', 'agents'), { recursive: true });
  await writeFile(join(projectDir, '.codex', 'agents', 'a.md'), 'a', 'utf-8');
  await writeFile(join(projectDir, '.hermes.md'), 'hermes context', 'utf-8');
}

/** An isolated, otherwise-empty AIWG user config dir for this test's AIWG_CONFIG. */
async function makeScratchConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aiwg-clean-providers-config-'));
  scratchRoots.push(dir);
  return dir;
}

async function writeMcpRegistry(
  configDir: string,
  servers: Record<string, { injectedProviders: string[] }>,
): Promise<void> {
  await writeFile(
    join(configDir, 'mcp-servers.json'),
    JSON.stringify({ apiVersion: 'aiwg.io/v1', kind: 'McpServerRegistry', servers }, null, 2),
    'utf-8',
  );
}

async function runCleanProviders(
  projectDir: string,
  options: { configDir?: string } = {},
): Promise<{ stdout: string }> {
  const configDir = options.configDir ?? (await makeScratchConfigDir());
  const { stdout } = await execFileAsync(process.execPath, [SCRIPT], {
    cwd: projectDir,
    env: { ...process.env, AIWG_CONFIG: configDir },
  });
  return { stdout };
}

describe('tools/cli/clean-providers.mjs', () => {
  it('removes only the AIWG-managed subpaths under .claude, preserving Claude Desktop/Code-owned state', async () => {
    const projectDir = await makeScratchProject();
    await seedClaudeDir(projectDir);

    await runCleanProviders(projectDir);

    // AIWG-managed subpaths are gone.
    expect(existsSync(join(projectDir, '.claude', 'agents'))).toBe(false);
    expect(existsSync(join(projectDir, '.claude', 'commands'))).toBe(false);
    expect(existsSync(join(projectDir, '.claude', '.aiwg', 'skills'))).toBe(false);
    expect(existsSync(join(projectDir, '.claude', 'rules'))).toBe(false);
    expect(existsSync(join(projectDir, '.claude', 'hooks'))).toBe(false);
    expect(existsSync(join(projectDir, '.claude', 'skills'))).toBe(false);

    // Claude Desktop/Code-owned state survives untouched.
    expect(existsSync(join(projectDir, '.claude', 'settings.json'))).toBe(true);
    expect(existsSync(join(projectDir, '.claude', 'settings.json.bak.2026-01-01T00-00-00-000Z'))).toBe(true);
    expect(existsSync(join(projectDir, '.claude', 'settings.local.json'))).toBe(true);
    expect(existsSync(join(projectDir, '.claude', 'launch.json'))).toBe(true);
    expect(
      existsSync(join(projectDir, '.claude', 'worktrees', 'feature-x', 'session.json')),
    ).toBe(true);

    await expect(
      readFile(join(projectDir, '.claude', 'settings.local.json'), 'utf-8'),
    ).resolves.toBe('{"model":"opus"}');
  });

  it('keeps the previous whole-directory/whole-file removal for every other provider target', async () => {
    const projectDir = await makeScratchProject();
    await seedOtherProviderTargets(projectDir);

    await runCleanProviders(projectDir);

    expect(existsSync(join(projectDir, '.codex'))).toBe(false);
    expect(existsSync(join(projectDir, '.hermes.md'))).toBe(false);
  });

  it('does not error when no provider directories exist', async () => {
    const projectDir = await makeScratchProject();

    await expect(runCleanProviders(projectDir)).resolves.toMatchObject({
      stdout: expect.stringContaining('Removed provider-deployed state'),
    });
  });

  it('reports the .claude managed subpaths it targeted', async () => {
    const projectDir = await makeScratchProject();
    await seedClaudeDir(projectDir);

    const { stdout } = await runCleanProviders(projectDir);

    expect(stdout).toContain('.claude/agents');
    expect(stdout).toContain('.claude/commands');
    expect(stdout).toContain('.claude/rules');
    expect(stdout).toContain('.claude/hooks');
    expect(stdout).toContain('.claude/skills');
    expect(stdout).not.toContain('.claude/settings');
  });
  it('falls back to the hand-written subpaths when the registry cannot be loaded, matching the registry', async () => {
    const mod = await import('../../../tools/cli/clean-providers.mjs');
    const fallback = mod.resolveScopedProviderManagedPaths(null);
    expect(fallback.every((entry: string) => entry.startsWith('.claude/'))).toBe(true);
    expect(fallback).not.toContain('.claude');
    expect([...fallback].sort()).toEqual([...mod.resolveScopedProviderManagedPaths()].sort());
  });

  // ── .cursor and .agents: scoped subdirectory removal (#3055) ───────────

  it('removes only the AIWG-managed subpaths under .cursor, preserving an unrelated user file', async () => {
    const projectDir = await makeScratchProject();
    await mkdir(join(projectDir, '.cursor', 'agents'), { recursive: true });
    await writeFile(join(projectDir, '.cursor', 'agents', 'a.json'), '{}', 'utf-8');
    await mkdir(join(projectDir, '.cursor', 'rules'), { recursive: true });
    await writeFile(join(projectDir, '.cursor', 'rules', 'r.mdc'), 'rule', 'utf-8');
    await writeFile(join(projectDir, '.cursor', 'my-notes.md'), 'not AIWG', 'utf-8');

    await runCleanProviders(projectDir);

    expect(existsSync(join(projectDir, '.cursor', 'agents'))).toBe(false);
    expect(existsSync(join(projectDir, '.cursor', 'rules'))).toBe(false);
    expect(existsSync(join(projectDir, '.cursor', 'my-notes.md'))).toBe(true);
  });

  it('removes only the AIWG-managed subpaths under .agents, preserving an unrelated user file', async () => {
    const projectDir = await makeScratchProject();
    await mkdir(join(projectDir, '.agents', 'skills', 'some-skill'), { recursive: true });
    await writeFile(join(projectDir, '.agents', 'skills', 'some-skill', 'SKILL.md'), 'skill', 'utf-8');
    await writeFile(join(projectDir, '.agents', 'my-notes.md'), 'not AIWG', 'utf-8');

    await runCleanProviders(projectDir);

    expect(existsSync(join(projectDir, '.agents', 'skills'))).toBe(false);
    expect(existsSync(join(projectDir, '.agents', 'my-notes.md'))).toBe(true);
  });

  it('falls back to the hand-written directory paths when the registry cannot be loaded, matching the registry', async () => {
    const mod = await import('../../../tools/cli/clean-providers.mjs');
    for (const dir of ['.cursor', '.agents']) {
      const fallback = mod.resolveDirectoryManagedPaths(dir, null);
      expect(fallback.every((entry: string) => entry.startsWith(`${dir}/`))).toBe(true);
      expect([...fallback].sort()).toEqual([...mod.resolveDirectoryManagedPaths(dir)].sort());
    }
  });

  // ── Cursor / Antigravity project MCP files: merge-aware removal (#3055) ──

  it('removes only the AIWG-managed MCP server from .cursor/mcp.json, preserving the user-owned one', async () => {
    const projectDir = await makeScratchProject();
    const configDir = await makeScratchConfigDir();
    await writeMcpRegistry(configDir, { 'aiwg-fs': { injectedProviders: ['cursor'] } });
    await mkdir(join(projectDir, '.cursor'), { recursive: true });
    await writeFile(
      join(projectDir, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          'aiwg-fs': { command: 'node', args: ['server.js'] },
          'my-own-server': { command: 'python', args: ['mine.py'] },
        },
      }),
      'utf-8',
    );

    await runCleanProviders(projectDir, { configDir });

    const result = JSON.parse(await readFile(join(projectDir, '.cursor', 'mcp.json'), 'utf-8'));
    expect(result.mcpServers).toEqual({ 'my-own-server': { command: 'python', args: ['mine.py'] } });
  });

  it.each(['.agents', '.agents/plugins/aiwg'])('removes only managed Antigravity MCP servers from %s, preserving operator data', async directory => {
    const projectDir = await makeScratchProject();
    const configDir = await makeScratchConfigDir();
    await writeMcpRegistry(configDir, { 'aiwg-fs': { injectedProviders: ['antigravity'] } });
    await mkdir(join(projectDir, directory), { recursive: true });
    await writeFile(
      join(projectDir, directory, 'mcp_config.json'),
      JSON.stringify({
        mcpServers: {
          'aiwg-fs': { command: 'node', args: ['server.js'] },
          'my-own-server': { command: 'python', args: ['mine.py'] },
        },
      }),
      'utf-8',
    );

    const manifest = join(projectDir, directory, 'plugin.json');
    await writeFile(manifest, '{"name":"operator"}\n');
    await runCleanProviders(projectDir, { configDir });
    expect(await readFile(manifest, 'utf8')).toBe('{"name":"operator"}\n');

    const result = JSON.parse(await readFile(join(projectDir, directory, 'mcp_config.json'), 'utf-8'));
    expect(result.mcpServers).toEqual({ 'my-own-server': { command: 'python', args: ['mine.py'] } });
  });

  it('deletes .cursor/mcp.json entirely when only AIWG-managed servers remain', async () => {
    const projectDir = await makeScratchProject();
    const configDir = await makeScratchConfigDir();
    await writeMcpRegistry(configDir, { 'aiwg-fs': { injectedProviders: ['cursor'] } });
    await mkdir(join(projectDir, '.cursor'), { recursive: true });
    await writeFile(
      join(projectDir, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { 'aiwg-fs': { command: 'node' } } }),
      'utf-8',
    );

    await runCleanProviders(projectDir, { configDir });

    expect(existsSync(join(projectDir, '.cursor', 'mcp.json'))).toBe(false);
  });

  it('leaves invalid JSON in .cursor/mcp.json untouched and reports it', async () => {
    const projectDir = await makeScratchProject();
    await mkdir(join(projectDir, '.cursor'), { recursive: true });
    const raw = '{ not valid json';
    await writeFile(join(projectDir, '.cursor', 'mcp.json'), raw, 'utf-8');

    const { stdout } = await runCleanProviders(projectDir);

    await expect(readFile(join(projectDir, '.cursor', 'mcp.json'), 'utf-8')).resolves.toBe(raw);
    expect(stdout).toContain('.cursor/mcp.json');
    expect(stdout).toContain('not valid JSON');
  });

  it('leaves .cursor/mcp.json untouched when the MCP server registry cannot be read', async () => {
    const projectDir = await makeScratchProject();
    const configDir = await makeScratchConfigDir();
    await writeFile(join(configDir, 'mcp-servers.json'), '{ not valid json', 'utf-8');
    await mkdir(join(projectDir, '.cursor'), { recursive: true });
    const raw = JSON.stringify({ mcpServers: { 'maybe-aiwg': { command: 'node' } } });
    await writeFile(join(projectDir, '.cursor', 'mcp.json'), raw, 'utf-8');

    const { stdout } = await runCleanProviders(projectDir, { configDir });

    await expect(readFile(join(projectDir, '.cursor', 'mcp.json'), 'utf-8')).resolves.toBe(raw);
    expect(stdout).toContain('.cursor/mcp.json');
    expect(stdout).toContain('could not read the MCP server registry');
  });

  it('leaves .cursor/mcp.json untouched when no entry is AIWG-managed', async () => {
    const projectDir = await makeScratchProject();
    const configDir = await makeScratchConfigDir();
    await writeMcpRegistry(configDir, { 'aiwg-fs': { injectedProviders: ['codex'] } });
    await mkdir(join(projectDir, '.cursor'), { recursive: true });
    const raw = JSON.stringify({ mcpServers: { 'my-own-server': { command: 'python' } } });
    await writeFile(join(projectDir, '.cursor', 'mcp.json'), raw, 'utf-8');

    await runCleanProviders(projectDir, { configDir });

    await expect(readFile(join(projectDir, '.cursor', 'mcp.json'), 'utf-8')).resolves.toBe(raw);
  });

  // ── opencode.json: merge-aware removal of `instructions` and `mcp` (#3055) ──

  it('removes only the AIWG-managed instructions entries from opencode.json, preserving the rest', async () => {
    const projectDir = await makeScratchProject();
    await writeFile(
      join(projectDir, 'opencode.json'),
      JSON.stringify({ $schema: 'https://opencode.ai/config.json', instructions: ['WORKSPACE.md', 'AIWG.md', 'my-own-instructions.md'] }),
      'utf-8',
    );

    await runCleanProviders(projectDir);

    const result = JSON.parse(await readFile(join(projectDir, 'opencode.json'), 'utf-8'));
    expect(result).toEqual({ $schema: 'https://opencode.ai/config.json', instructions: ['my-own-instructions.md'] });
  });

  it('deletes opencode.json entirely when it holds nothing but the AIWG-managed instructions', async () => {
    const projectDir = await makeScratchProject();
    await writeFile(
      join(projectDir, 'opencode.json'),
      JSON.stringify({ instructions: ['WORKSPACE.md', 'AIWG.md'] }),
      'utf-8',
    );

    await runCleanProviders(projectDir);

    expect(existsSync(join(projectDir, 'opencode.json'))).toBe(false);
  });

  it('keeps opencode.json when only a non-instructions key (e.g. $schema) remains', async () => {
    const projectDir = await makeScratchProject();
    await writeFile(
      join(projectDir, 'opencode.json'),
      JSON.stringify({ $schema: 'https://opencode.ai/config.json', instructions: ['WORKSPACE.md', 'AIWG.md'] }),
      'utf-8',
    );

    await runCleanProviders(projectDir);

    const result = JSON.parse(await readFile(join(projectDir, 'opencode.json'), 'utf-8'));
    expect(result).toEqual({ $schema: 'https://opencode.ai/config.json' });
  });

  it('removes only the AIWG-managed MCP server from opencode.json, preserving the user-owned one and instructions', async () => {
    const projectDir = await makeScratchProject();
    const configDir = await makeScratchConfigDir();
    await writeMcpRegistry(configDir, { 'aiwg-fs': { injectedProviders: ['opencode'] } });
    await writeFile(
      join(projectDir, 'opencode.json'),
      JSON.stringify({
        instructions: ['my-own-instructions.md'],
        mcp: {
          'aiwg-fs': { type: 'local', command: ['node', 'server.js'] },
          'my-own-server': { type: 'local', command: ['python', 'mine.py'] },
        },
      }),
      'utf-8',
    );

    await runCleanProviders(projectDir, { configDir });

    const result = JSON.parse(await readFile(join(projectDir, 'opencode.json'), 'utf-8'));
    expect(result).toEqual({
      instructions: ['my-own-instructions.md'],
      mcp: { 'my-own-server': { type: 'local', command: ['python', 'mine.py'] } },
    });
  });

  it('leaves invalid JSON in opencode.json untouched and reports it', async () => {
    const projectDir = await makeScratchProject();
    const raw = '{ instructions: not valid json';
    await writeFile(join(projectDir, 'opencode.json'), raw, 'utf-8');

    const { stdout } = await runCleanProviders(projectDir);

    await expect(readFile(join(projectDir, 'opencode.json'), 'utf-8')).resolves.toBe(raw);
    expect(stdout).toContain('opencode.json');
    expect(stdout).toContain('not valid JSON');
  });

  it('leaves opencode.json untouched when it has neither managed instructions nor an mcp map', async () => {
    const projectDir = await makeScratchProject();
    const raw = JSON.stringify({ someOtherKey: 'value' });
    await writeFile(join(projectDir, 'opencode.json'), raw, 'utf-8');

    await runCleanProviders(projectDir);

    await expect(readFile(join(projectDir, 'opencode.json'), 'utf-8')).resolves.toBe(raw);
  });
});


describe('cleanup safe writes (#3565)', () => {
  it('refuses a symlinked merge target without modifying external bytes', async () => {
    const project = await makeScratchProject();
    const outsideDir = await makeScratchProject();
    const outside = join(outsideDir, 'operator.json');
    const original = '{ "theme": "keep", "instructions": ["AIWG.md"] }\n';
    await writeFile(outside, original);
    await symlink(outside, join(project, 'opencode.json'));
    await expect(runCleanProviders(project)).rejects.toThrow(/symlink/);
    expect(await readFile(outside, 'utf8')).toBe(original);
  });

  it('refuses a symlinked descendant directory without modifying external bytes', async () => {
    const project = await makeScratchProject();
    const outsideDir = await makeScratchProject();
    const configDir = await makeScratchConfigDir();
    await writeMcpRegistry(configDir, { aiwg: { injectedProviders: ['cursor'] } });
    const outside = join(outsideDir, 'mcp.json');
    const original = '{ "theme": "keep", "mcpServers": { "aiwg": { "command": "aiwg" } } }\n';
    await writeFile(outside, original);
    await symlink(outsideDir, join(project, '.cursor'));
    await expect(runCleanProviders(project, { configDir })).rejects.toThrow(/symlink/);
    expect(await readFile(outside, 'utf8')).toBe(original);
  });

  it('atomically replaces merge targets and keeps project modes', async () => {
    const project = await makeScratchProject();
    const file = join(project, 'opencode.json');
    const snapshot = join(project, 'snapshot.json');
    const original = '{ "theme": "keep", "instructions": ["AIWG.md"] }\n';
    await writeFile(file, original);
    await chmod(file, 0o640);
    await link(file, snapshot);
    await runCleanProviders(project);
    expect(await readFile(snapshot, 'utf8')).toBe(original);
    expect((await stat(file)).mode & 0o777).toBe(0o640);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ theme: 'keep' });
  });
});
