// Regression coverage for the shared Antigravity MCP and resource contract refresh.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as typed from '../../../src/mcp/registry.js';
import * as runtime from '../../../src/mcp/registry.mjs';
import { getProviderCapabilities, loadCapabilityMatrix } from '../../../src/providers/capability-matrix.js';
import { formatProvider } from '../../../src/cli/handlers/steward-format.js';
import { buildDryRunUseResult, verifyProviderDeployment } from '../../../src/cli/services/deployment-verification.js';
import { buildParallelismSection } from '../../../src/smiths/context-pipeline/parallelism-section.js';
import { getProviderDefinition } from '../../../src/providers/provider-definitions.js';
import { emptyConfig } from '../../../src/config/aiwg-config.js';
import { USER_SCOPE_PATHS } from '../../../src/cli/scope-resolver.js';
import { scanContextMemoryFirewall } from '../../../tools/security/context-memory-firewall.mjs';

const roots: string[] = [];
function temp() { const root = mkdtempSync(join(tmpdir(), 'aiwg-agy-upgrade-')); roots.push(root); return root; }
function put(root: string, file: string, value: unknown) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), typeof value === 'string' ? value : JSON.stringify(value));
}
const plugin = '.agents/plugins/aiwg';
const legacy = '.agents/mcp_config.json';
const json = (root: string, file: string) => JSON.parse(readFileSync(join(root, file), 'utf8'));
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe.each([['typed', typed], ['runtime', runtime]] as const)('%s Antigravity project plugin', (_label, api) => {
  async function fixture() {
    const root = temp();
    const registry = new api.McpServerRegistry(join(root, 'registry'));
    await registry.add({ name: 'new', type: 'http', url: 'https://example.invalid/mcp' });
    return { root, registry, inject: (extra = {}) => api.injectServers(registry, 'agy', { projectDir: root, ...extra }) };
  }

  it('preserves legacy bytes, migrates URLs and extras, keeps plugin collisions, and is idempotent', async () => {
    const { root, inject } = await fixture();
    put(root, legacy, { keep: { value: 1 }, mcpServers: { remote: { serverUrl: 'https://old.invalid/mcp', disabled: true }, collision: { command: 'legacy' } } });
    const original = readFileSync(join(root, legacy));
    put(root, `${plugin}/mcp_config.json`, { other: true, mcpServers: { collision: { command: 'operator' } } });
    put(root, `${plugin}/plugin.json`, { name: 'custom', disabled: true });
    const result = await inject();
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('superseded'), expect.stringContaining('collision')]));
    expect(json(root, `${plugin}/mcp_config.json`)).toEqual({ keep: { value: 1 }, other: true, mcpServers: {
      remote: { url: 'https://old.invalid/mcp', disabled: true }, collision: { command: 'operator' }, new: { url: 'https://example.invalid/mcp' },
    } });
    expect(json(root, `${plugin}/plugin.json`)).toEqual({ name: 'custom', disabled: true });
    const first = readFileSync(join(root, `${plugin}/mcp_config.json`));
    await inject();
    expect(readFileSync(join(root, `${plugin}/mcp_config.json`))).toEqual(first);
    expect(readFileSync(join(root, legacy))).toEqual(original);
  });

  it('previews without writes and creates the required manifest on injection', async () => {
    const { root, inject } = await fixture();
    put(root, legacy, { mcpServers: { local: { command: 'operator' } } });
    expect((await inject({ dryRun: true })).warnings).toEqual(expect.arrayContaining([expect.stringContaining('superseded')]));
    expect(existsSync(join(root, plugin))).toBe(false);
    await inject();
    expect(json(root, `${plugin}/plugin.json`)).toEqual({ name: 'aiwg' });
  });

  it.each([legacy, `${plugin}/plugin.json`])('refuses malformed %s before creating a config', async file => {
    const { root, inject } = await fixture();
    put(root, file, '{broken');
    await expect(inject()).rejects.toThrow('Refusing to overwrite malformed MCP config');
    expect(readFileSync(join(root, file), 'utf8')).toBe('{broken');
    expect(existsSync(join(root, `${plugin}/mcp_config.json`))).toBe(false);
  });

  it.each([legacy, `${plugin}/plugin.json`])('refuses symlinked %s without touching its target', async file => {
    const { root, inject } = await fixture();
    put(root, 'operator.json', { keep: true });
    mkdirSync(dirname(join(root, file)), { recursive: true });
    symlinkSync(join(root, 'operator.json'), join(root, file));
    await expect(inject()).rejects.toThrow('symlink');
    expect(json(root, 'operator.json')).toEqual({ keep: true });
    expect(existsSync(join(root, `${plugin}/mcp_config.json`))).toBe(false);
  });
});

describe('Antigravity provider contract refresh', () => {
  it('exposes native capabilities with provider-specific examples and evidence limits', () => {
    const provider = getProviderCapabilities('antigravity')!;
    for (const feature of ['cron', 'agent_teams', 'tasks', 'mcp', 'behaviors'] as const) expect(provider.native_features[feature]).toBe(true);
    const output = formatProvider('antigravity', provider, loadCapabilityMatrix());
    for (const text of ['schedule', 'swarm', 'invoke_subagent', 'define_subagent', 'run_workflow', 'manage_task', '.agents/hooks.json', 'HTTP url']) expect(output).toContain(text);
    expect(output).not.toContain('Claude Code MCP');
    const contract = json(process.cwd(), 'agentic/code/providers/antigravity/provider-contract.v1.json');
    const evidence = json(process.cwd(), 'test/fixtures/providers/antigravity-conformance/host-contract-evidence.json');
    expect(contract.qualifiedCli.version).toBe(evidence.schemaCli.version);
    expect(contract.qualifiedCli.authenticatedExecution).toBe(false);
    expect(evidence.swarmSchema.properties.workspace.enum).toEqual(['inherit', 'share', 'branch']);
    expect(contract.surfaces.globalSkills.path).toBe('~/.gemini/config/skills');
    expect(USER_SCOPE_PATHS.antigravity.skills).toMatch(/\.gemini\/config\/skills$/);
  });

  it('generates native parallelism guidance and documents actual startup loaders', async () => {
    const definition = getProviderDefinition('antigravity')!;
    expect(definition.context.startupFiles).toContain('.agents/rules/*.md');
    expect(definition.context.maxContextBytes).toBe(24000);
    const section = await buildParallelismSection(temp(), { readConfig: async () => emptyConfig(['antigravity']) });
    for (const text of ['invoke_subagent', 'inherit|flash_lite|flash|pro', 'swarm', 'inherit|share|branch', 'run_workflow', 'aiwg-mc']) expect(section).toContain(text);
    expect(section).not.toContain('heterogeneous model pinning remain unqualified');
  });

  it('reports restart-required for both planned and probed deployments', async () => {
    const root = temp();
    const options = { projectRoot: root, frameworkRoot: root, providers: ['antigravity'], scope: 'project' as const, requestedBundles: ['all'] };
    expect(buildDryRunUseResult(options).providers[0]).toMatchObject({ reloadPolicy: 'restart-required', restartRequired: true });
    const result = await verifyProviderDeployment({ ...options, provider: 'antigravity' });
    expect(result).toMatchObject({ reloadPolicy: 'restart-required', restartRequired: true });
    expect(result.restartAction).toContain('Restart agy');
  });

  it('audits deployed .antigravity/rules alongside skills and the bootstrap', async () => {
    const root = temp();
    for (const file of ['.antigravity/rules/project.md', '.agents/skills/demo/SKILL.md', 'AGENTS.md']) put(root, file, '# Local instructions\n');
    const result = await scanContextMemoryFirewall({ rootDir: root, packageRoot: root, providers: ['antigravity'], contentScan: false });
    expect(result.records.map(record => record.path)).toEqual(expect.arrayContaining(['.antigravity/rules/project.md', '.agents/skills/demo/SKILL.md', 'AGENTS.md']));
  });
});
