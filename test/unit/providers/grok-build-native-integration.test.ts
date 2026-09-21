import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectGrokBuildNative,
  manageGrokBuildMcp,
  mergeGrokMcpServers,
  removeGrokMcpServers,
  renderGrokMcpServer,
  unmanageGrokBuildMcp,
} from '../../../src/mcp/grok-build-config.mjs';
import { translateForGrokBuild } from '../../../src/smiths/hook-bridge/grok-build-translator.js';
import { injectServers, McpServerRegistry } from '../../../src/mcp/registry.mjs';

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-grok-native-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Grok Build native MCP adapter (#2576)', () => {
  it('is wired through the shared MCP registry injector', async () => {
    const root = await fixture();
    const registry = new McpServerRegistry(join(root, 'registry'));
    await registry.add({ name: 'aiwg', type: 'stdio', command: 'aiwg', args: ['mcp', 'serve'] });
    const result = await injectServers(registry, 'grok-build', { projectDir: root });
    expect(result).toMatchObject({ provider: 'grok-build', state: 'configured', serversInjected: ['aiwg'] });
    expect(await readFile(join(root, '.grok', 'config.toml'), 'utf8')).toContain('[mcp_servers.aiwg]');
    expect((await registry.get('aiwg'))?.injectedProviders).toContain('grok-build');
  });

  it('preserves operator bytes and is idempotent across deploy and uninstall', async () => {
    const root = await fixture();
    const config = join(root, '.grok', 'config.toml');
    const operator = '# operator comment\n[theme]\nname = "keep"\n\n[mcp_servers.operator]\ncommand = "keep"\n';
    await mkdir(join(root, '.grok'), { recursive: true });
    await writeFile(config, operator);
    const server = { name: 'aiwg', type: 'stdio', command: 'aiwg', args: ['mcp', 'serve'], env: { TOKEN: '${AIWG_TOKEN}' } };
    await manageGrokBuildMcp(config, [server], { root });
    const once = await readFile(config, 'utf8');
    await manageGrokBuildMcp(config, [server], { root });
    expect(await readFile(config, 'utf8')).toBe(once);
    expect(once).toContain(operator);
    expect(once).toContain('TOKEN = "${AIWG_TOKEN}"');
    await unmanageGrokBuildMcp(config, ['aiwg'], { root });
    expect(await readFile(config, 'utf8')).toBe(operator);
  });

  it('renders HTTP headers as environment references and never expands secrets', () => {
    process.env.SUPER_SECRET_TOKEN = 'must-not-appear';
    const rendered = renderGrokMcpServer({ name: 'remote', type: 'http', url: 'https://example.test/${TENANT}/mcp', headerEnv: { Authorization: 'SUPER_SECRET_TOKEN' } });
    expect(rendered).toContain('Authorization = "${SUPER_SECRET_TOKEN}"');
    expect(rendered).not.toContain(process.env.SUPER_SECRET_TOKEN);
  });

  it.each([
    ['malformed TOML', () => mergeGrokMcpServers('x = "unterminated', [{ name: 'aiwg', type: 'stdio', command: 'aiwg' }])],
    ['duplicate request', () => mergeGrokMcpServers('', [{ name: 'aiwg', type: 'stdio', command: 'a' }, { name: 'aiwg', type: 'stdio', command: 'b' }])],
    ['operator collision', () => mergeGrokMcpServers('[mcp_servers.aiwg]\ncommand="mine"\n', [{ name: 'aiwg', type: 'stdio', command: 'aiwg' }])],
  ])('fails closed for %s without content-bearing diagnostics', (_name, operation) => {
    expect(operation).toThrow();
    try { operation(); } catch (error) { expect(String(error)).not.toContain('unterminated'); }
  });

  it('reports blocked policy without writing and preserves malformed config on rollback', async () => {
    const root = await fixture();
    const config = join(root, '.grok', 'config.toml');
    await mkdir(join(root, '.grok'), { recursive: true });
    await writeFile(config, 'secret = "unterminated');
    const blocked = await manageGrokBuildMcp(config, [{ name: 'aiwg', type: 'stdio', command: 'aiwg' }], { root, blockedByPolicy: 'requirements layer disables project MCP' });
    expect(blocked.state).toBe('blocked-by-policy');
    expect(await readFile(config, 'utf8')).toBe('secret = "unterminated');
    await expect(manageGrokBuildMcp(config, [{ name: 'aiwg', type: 'stdio', command: 'aiwg' }], { root })).rejects.toThrow(/TOML/);
    expect(await readFile(config, 'utf8')).toBe('secret = "unterminated');
  });

  it('rejects symlink escape targets', async () => {
    const root = await fixture();
    const outside = await fixture();
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(root, '.grok'));
    await expect(manageGrokBuildMcp(join(root, '.grok', 'config.toml'), [{ name: 'aiwg', type: 'stdio', command: 'aiwg' }], { root })).rejects.toThrow(/symbolic link/);
  });

  it('distinguishes configured, disabled, blocked, untrusted, unhealthy, and absent states', async () => {
    const root = await fixture();
    const config = join(root, '.grok', 'config.toml');
    expect(await inspectGrokBuildNative({ projectDir: root, configPath: config })).toMatchObject({ mcp: 'absent', hooks: 'absent' });
    await manageGrokBuildMcp(config, [{ name: 'aiwg', type: 'stdio', command: 'aiwg' }], { root });
    await mkdir(join(root, '.grok', 'hooks'));
    expect(await inspectGrokBuildNative({ projectDir: root, configPath: config })).toMatchObject({ mcp: 'configured', hooks: 'untrusted' });
    await manageGrokBuildMcp(config, [{ name: 'aiwg', type: 'stdio', command: 'aiwg', enabled: false }], { root });
    expect(await inspectGrokBuildNative({ projectDir: root, configPath: config })).toMatchObject({ mcp: 'disabled' });
    await manageGrokBuildMcp(config, [{ name: 'aiwg', type: 'stdio', command: 'aiwg' }], { root });
    expect(await inspectGrokBuildNative({ projectDir: root, configPath: config, trusted: true, blockedByPolicy: true })).toMatchObject({ mcp: 'blocked-by-policy', hooks: 'configured' });
    expect(await inspectGrokBuildNative({ projectDir: root, configPath: config, binary: join(root, 'missing-grok') })).toMatchObject({ mcp: 'unhealthy' });
  });

  it('proves the managed server is visible to grok inspect and passes native doctor', async () => {
    const root = await fixture();
    const config = join(root, '.grok', 'config.toml');
    await mkdir(join(root, '.grok'), { recursive: true });
    await writeFile(config, '# operator comment\n[theme]\nname = "keep"\n');
    await manageGrokBuildMcp(config, [{ name: 'aiwg', type: 'stdio', command: 'aiwg', args: ['mcp', 'serve'] }], { root });
    const binary = join(root, 'grok');
    await writeFile(binary, `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ');
if (args === 'inspect --json') console.log(JSON.stringify({ mcpServers: [{ name: 'aiwg', origin: '.grok/config.toml' }] }));
else if (args === 'mcp list --json') console.log(JSON.stringify([{ name: 'aiwg', enabled: true }]));
else if (args === 'mcp doctor aiwg --json') console.log(JSON.stringify({ name: 'aiwg', healthy: true }));
else process.exit(2);
`);
    await chmod(binary, 0o755);
    const result = await inspectGrokBuildNative({ projectDir: root, configPath: config, binary });
    expect(result).toMatchObject({ mcp: 'configured', servers: ['aiwg'], diagnostics: [] });
    const configText = await readFile(config, 'utf8');
    expect(configText).toContain('# operator comment');
    expect(configText).toContain('[theme]');
    expect(configText).toContain('[mcp_servers.aiwg]');
  });

  it('removes only marked entries from source text', () => {
    const merged = mergeGrokMcpServers('[other]\nx=1\n', [{ name: 'one', type: 'stdio', command: 'one' }, { name: 'two', type: 'stdio', command: 'two' }]);
    const result = removeGrokMcpServers(merged, ['one']);
    expect(result.removed).toEqual(['one']);
    expect(result.text).toContain('[mcp_servers.two]');
    expect(result.text).toContain('[other]');
  });
});

describe('Grok Build trust-neutral hook bridge (#2576)', () => {
  it('emits native JSON without creating a trust file and documents fail-open semantics', async () => {
    const root = await fixture();
    const result = await translateForGrokBuild({ id: 'safety-check', description: 'check', events: ['PreToolUse', 'PostToolUse'], command: 'bin/check.sh' }, { projectPath: root });
    expect(result.skipped).toBe(false);
    expect(result.warnings.join(' ')).toMatch(/explicit PreToolUse.*fail open/i);
    expect(await readFile(result.emittedPaths[0], 'utf8')).toContain('"PreToolUse"');
    await expect(readFile(join(root, '.grok', 'trusted_folders.toml'), 'utf8')).rejects.toThrow();
  });

  it('refuses malformed JSON and operator-owned replacement', async () => {
    const root = await fixture();
    const hooks = join(root, '.grok', 'hooks');
    await mkdir(hooks, { recursive: true });
    await writeFile(join(hooks, 'aiwg-safety-check.json'), '{bad');
    await expect(translateForGrokBuild({ id: 'safety-check', description: 'check', events: ['Stop'], command: 'true' }, { projectPath: root })).rejects.toThrow();
    expect(await readFile(join(hooks, 'aiwg-safety-check.json'), 'utf8')).toBe('{bad');
  });
});
