// Devin branding must retain the legacy adapter's deployed paths and install evidence.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { getProviderDefinition, listProviderDefinitions, normalizeProviderDefinitionId } from '../../../src/providers/provider-definitions.js';
import { collectProviderInventory } from '../../../src/providers/provider-inventory.js';
import { commandLooksLikeProvider, resolveActiveProvider } from '../../../src/cli/provider-resolution.js';
import { normalizeRuntimeProviderId, resolveMcpConfigPath } from '../../../src/providers/provider-definitions.mjs';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-devin-branding-'));
  roots.push(root);
  return { project: join(root, 'project'), home: join(root, 'home') };
}

describe('Devin Desktop identity and legacy installation support', () => {
  it.each(['devin', 'devin-desktop', 'devin-local', 'cascade', 'windsurf'])('normalizes %s to the canonical devin id', selector => {
    expect(normalizeProviderDefinitionId(selector)).toBe('devin');
    expect(normalizeRuntimeProviderId(selector)).toBe('devin');
    expect(getProviderDefinition(selector)?.id).toBe('devin');
  });
  it('lists Devin once while retaining all existing deployment paths', () => {
    expect(listProviderDefinitions().filter(d => ['devin', 'windsurf'].includes(d.id)).map(d => d.id)).toEqual(['devin']);
    const def = getProviderDefinition('devin')!;
    expect(def.displayName).toBe('Devin Desktop');
    expect(def.paths.artifacts).toEqual({ agents: '.windsurf/agents', commands: '.windsurf/workflows', skills: '.windsurf/.aiwg/skills', rules: '.windsurf/rules', behaviors: '.windsurf/rules' });
    expect(def.paths.kernelSkills).toBe('.windsurf/skills');
    expect(resolveMcpConfigPath('windsurf')).toBe(resolveMcpConfigPath('devin'));
    expect(resolveMcpConfigPath('devin')).toMatch(/\.codeium\/windsurf\/mcp_config\.json$/);
  });
  it.each(['windsurf', 'devin-desktop'])('detects the %s binary as Devin Desktop', async binary => {
    const { home, project } = await fixture();
    const inventory = await collectProviderInventory(project, { homeDir: home, env: {}, detectProcess: false,
      pathExists: async () => false, findExecutable: async names => names.includes(binary) ? `/fixture/bin/${binary}` : null });
    expect(inventory.providers.find(d => d.id === 'devin')).toMatchObject({ displayName: 'Devin Desktop', detected: true, available: true });
    expect(commandLooksLikeProvider(`/usr/bin/${binary} --new-window`)).toBe('devin');
  });
  it.each(['.codeium', '.devin', '.config/Devin'])('detects the %s config directory without reading its contents', async directory => {
    const { home, project } = await fixture();
    const inventory = await collectProviderInventory(project, { homeDir: home, env: {}, detectProcess: false,
      pathExists: async file => file === join(home, directory), findExecutable: async () => null });
    expect(inventory.providers.find(d => d.id === 'devin')).toMatchObject({ detected: true, available: false });
  });
  it('reports an existing legacy deployment under the canonical Devin name in status', async () => {
    const { project, home } = await fixture();
    await mkdir(join(project, '.windsurf/agents'), { recursive: true });
    await mkdir(home, { recursive: true });
    await mkdir(join(project, '.aiwg'), { recursive: true });
    await writeFile(join(project, '.windsurf/agents/fixture.md'), '# Fixture');
    const output = execFileSync(process.execPath, [resolve('tools/cli/workspace-status.mjs'), '--json', project], {
      cwd: project, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'),
        XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local/share'), AIWG_ROOT: resolve('.') },
    });
    expect(JSON.parse(output).providerDeployments).toContainEqual(expect.objectContaining({ name: 'devin', path: '.windsurf', counts: { agents: 1 } }));
  }, 90_000);
  it('brands the retained standalone deployment entry point as Devin Desktop', async () => {
    const { project, home } = await fixture();
    await mkdir(home, { recursive: true });
    await mkdir(project, { recursive: true });
    const output = execFileSync(process.execPath, [resolve('tools/agents/deploy-windsurf.mjs'), '--source', project,
      '--target', project, '--dry-run'], { encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config') } });
    expect(output).toContain('Devin Desktop provider');
    expect(output).not.toContain('Windsurf');
  }, 90_000);
  it('continues to detect the legacy runtime marker', async () => {
    const { project } = await fixture();
    expect(await resolveActiveProvider({ cwd: project, env: { WINDSURF_VERSION: '1.141.2' }, detectProcess: false })).toMatchObject({ provider: 'devin', source: 'runtime-env' });
  });
  it.each(['README.md', 'docs/agents/providers/windsurf.md', 'docs/integrations/windsurf-quickstart.md', 'docs/integrations/windsurf-mcp-sidecar.md'])('presents Devin in %s', file => {
    const content = readFileSync(resolve(file), 'utf8');
    const unlabeled = content.split('\n').filter(line => !/legacy|deprecated|alias|histor|compatibility/i.test(line));
    expect(unlabeled.join('\n')).not.toMatch(/\bWindsurf\b/);
  });
});
