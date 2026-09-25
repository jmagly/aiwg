import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  getProviderDefinition,
  normalizeProviderDefinitionId,
} from '../../../src/providers/provider-definitions.js';
import {
  getProviderCapabilities,
  listProviders,
  providersWithNativeSupport,
} from '../../../src/providers/capability-matrix.js';
import { collectProviderInventory } from '../../../src/providers/provider-inventory.js';

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-muse-provider-'));
  roots.push(root);
  const project = join(root, 'project');
  const home = join(root, 'home');
  await mkdir(join(project, '.aiwg'), { recursive: true });
  await mkdir(join(home, '.aiwg'), { recursive: true });
  await writeFile(join(project, '.aiwg/aiwg.config'), JSON.stringify({
    version: '1',
    providers: ['muse'],
    installed: {},
    scripts: {},
  }));
  return { project, home };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('muse provider registration (#225)', () => {
  it('normalizes the canonical id and rejects every alias spelling', () => {
    expect(normalizeProviderDefinitionId('muse')).toBe('muse');
    expect(normalizeProviderDefinitionId(' Muse ')).toBe('muse');
    // ADR: canonical id is `muse` with no aliases. Rejected spellings are
    // assembled at runtime so the forbidden forms never appear as literals.
    for (const rejected of [
      ['muse', 'code'].join('-'),
      ['muse', 'spark'].join('-'),
      'spark',
      'meta',
    ]) {
      expect(normalizeProviderDefinitionId(rejected)).toBeNull();
    }
  });

  it('registers experimental Muse Code with fail-closed detection', () => {
    const muse = getProviderDefinition('muse');
    expect(muse).toBeDefined();
    expect(muse?.id).toBe('muse');
    expect(muse?.displayName).toBe('Muse Code');
    expect(muse?.status).toBe('experimental');
    expect(muse?.builtIn).toBe(true);
    expect(muse?.aliases).toEqual([]);
    expect(muse?.surfaces.primary).toBe('muse');
    // Fail-closed: no env or process signals. A bare `muse` process name
    // collides with unrelated software and must not be detection evidence.
    expect(muse?.detection).toMatchObject({ env: [], process: [], capabilityId: 'muse' });
  });

  it('locks ADR skill roots without inventing ~/.muse', () => {
    const muse = getProviderDefinition('muse');
    expect(muse?.paths.deployTarget).toBe('mixed');
    expect(muse?.paths.kernelSkills).toBe('.agents/skills');
    expect(muse?.paths.artifacts.skills).toBe('.agents/skills');
    // Only skills are written natively; other artifacts stay indexed.
    expect(muse?.paths.artifacts.agents).toBeNull();
    expect(muse?.paths.artifacts.commands).toBeNull();
    expect(muse?.paths.artifacts.rules).toBeNull();
    expect(muse?.paths.artifacts.behaviors).toBeNull();
    // Never advertise ~/.muse as a default skill root; the user root resolves
    // from XDG_CONFIG_HOME at deploy time (#226).
    expect(JSON.stringify(muse)).not.toContain('~/.muse');
    expect(muse?.paths.contextFiles.contextFile).toBe('AGENTS.md');
    expect(muse?.context.startupFiles).toEqual(['AGENTS.md']);
  });

  it('publishes the ADR capability posture through the matrix', () => {
    const caps = getProviderCapabilities('muse');
    expect(caps).toBeDefined();
    expect(caps?.display_name).toBe('Muse Code');
    expect(caps?.status).toBe('experimental');
    expect(caps?.daemon_tier).toBe('unsupported');
    expect(caps?.deploy_target).toBe('mixed');
    // ADR posture: skills native, rules via AGENTS.md, mcp true,
    // agent_teams false (no team contract), cron false.
    expect(caps?.native_features.mcp).toBe(true);
    expect(caps?.native_features.agent_teams).toBe(false);
    expect(caps?.native_features.cron).toBe(false);
    expect(caps?.native_features.tasks).toBe(false);
    expect(caps?.native_features.daemon).toBe(false);
    expect(caps?.emulation.tasks).toBe('aiwg-mc');
    expect(caps?.hook_wiring.context_file).toBe('AGENTS.md');
    expect(caps?.hook_wiring.hook_file).toBe('.muse/hooks.json');
    expect(caps?.hook_wiring.at_link_support).toBe(false);
  });

  it('lists Muse Code in the steward / runtime-info capability surface', () => {
    expect(listProviders()).toContain('muse');
    expect(providersWithNativeSupport('mcp')).toContain('muse');
    expect(providersWithNativeSupport('agent_teams')).not.toContain('muse');
    expect(providersWithNativeSupport('cron')).not.toContain('muse');
  });
});

describe('muse deploy + setup registries (#225)', () => {
  it('lists canonical muse in setup.aiwg.yaml and deploy-agents.mjs with no alias', async () => {
    const setup = await readFile('setup.aiwg.yaml', 'utf8');
    expect(setup).toMatch(/^\s+- muse$/m);

    const deployAgents = await readFile('tools/agents/deploy-agents.mjs', 'utf8');
    expect(deployAgents).toMatch(/const AVAILABLE_PROVIDERS = \[[^\]]*'muse'/);
    const aliasBlock = deployAgents.match(/const PROVIDER_ALIASES = \{([\s\S]*?)\n\};/);
    expect(aliasBlock?.[1]).toBeDefined();
    // ADR: no aliases for muse, and the forbidden spellings never appear.
    expect(aliasBlock?.[1]).not.toContain('muse');
    expect(deployAgents).not.toContain(['muse', 'code'].join('-'));
  });
});
describe('muse provider inventory', () => {
  it('detects the documented muse CLI binary without process-signal detection', async () => {
    const { project, home } = await fixture();
    const inventory = await collectProviderInventory(project, {
      homeDir: home,
      env: { PATH: '/fixture/bin' },
      detectProcess: true,
      pathExists: async () => false,
      findExecutable: async (names) => (names.includes('muse') ? '/fixture/bin/muse' : null),
      now: () => new Date(0),
    });

    const muse = inventory.providers.find((provider) => provider.id === 'muse')!;
    expect(muse).toBeDefined();
    expect(muse.evidence).toContainEqual(
      expect.objectContaining({ kind: 'executable', scope: 'runtime' }),
    );
    // Fail-closed: the registry claims no process detection signals, so a
    // `muse` process is never treated as Muse Code evidence.
    expect(muse.evidence.map((item) => item.kind)).not.toContain('process');
  });
});
