import { describe, expect, it } from 'vitest';

import {
  getProviderDefinition,
  listProviderDefinitions,
  normalizeProviderDefinitionId,
  validateProviderDefinitionRegistry,
} from '../../../src/providers/provider-definitions.js';

const CURRENT_PLATFORM_IDS = [
  'antigravity',
  'claude',
  'codex',
  'copilot',
  'cursor',
  'deepseek-harness',
  'factory',
  'grokbot',
  'hermes',
  'opencode',
  'openclaw',
  'openhuman',
  'pi',
  'omp',
  'warp',
  'windsurf',
  'generic',
];

describe('provider definition registry', () => {
  it('has a valid definition for every current Platform value', () => {
    const definitions = validateProviderDefinitionRegistry();

    expect(definitions.map((definition) => definition.id)).toEqual(CURRENT_PLATFORM_IDS);
    for (const definition of definitions) {
      expect(definition.displayName).toBeTruthy();
      expect(definition.paths.artifacts).toHaveProperty('agents');
      expect(definition.paths.artifacts).toHaveProperty('commands');
      expect(definition.paths.artifacts).toHaveProperty('skills');
      expect(definition.paths.artifacts).toHaveProperty('rules');
      expect(definition.paths.artifacts).toHaveProperty('behaviors');
      expect(definition.paths.contextDiscovery).toHaveProperty('agents');
      expect(definition.paths.contextDiscovery).toHaveProperty('skills');
      expect(definition.paths.contextDiscovery).toHaveProperty('rules');
      expect(definition.paths.contextDiscovery).toHaveProperty('behaviors');
      expect(definition.adapters.agentFormat).toBeTruthy();
    }
  });

  it('normalizes existing provider aliases through definition data', () => {
    expect(normalizeProviderDefinitionId('claude-code')).toBe('claude');
    expect(normalizeProviderDefinitionId('openai')).toBe('codex');
    expect(normalizeProviderDefinitionId('tinyhumansai')).toBe('openhuman');
    expect(normalizeProviderDefinitionId('devin')).toBe('windsurf');
    expect(normalizeProviderDefinitionId('devin-desktop')).toBe('windsurf');
    expect(normalizeProviderDefinitionId('devin-local')).toBe('windsurf');
    expect(normalizeProviderDefinitionId('cascade')).toBe('windsurf');
    expect(normalizeProviderDefinitionId('pi-coding-agent')).toBe('pi');
    expect(normalizeProviderDefinitionId('dsh')).toBe('deepseek-harness');
    expect(normalizeProviderDefinitionId('missing-provider')).toBeNull();
  });

  it('models Pi native resources without claiming unimplemented bridges', () => {
    const pi = getProviderDefinition('pi');
    expect(pi).toBeDefined();
    expect(pi?.status).toBe('experimental');
    expect(pi?.detection).toMatchObject({ env: [], process: ['pi'], capabilityId: 'pi' });
    expect(pi?.paths.kernelSkills).toBe('.agents/skills');
    expect(pi?.paths.artifacts.commands).toBe('.pi/prompts');
    expect(pi?.paths.artifacts.behaviors).toBe('.pi/extensions');
    expect(pi?.context.startupFiles).toEqual(['AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md']);
    expect(pi?.context.verification.source).toContain('79680533c6b898894f2d2421c7f640b212d3dfdd');
    expect(pi?.adapters.hookBridge).toBeNull();
    expect(pi?.adapters.mcpInjection).toBeNull();
  });

  it('registers experimental grokbot without a bare grok alias', () => {
    const grokbot = getProviderDefinition('grokbot');
    expect(grokbot).toBeDefined();
    expect(grokbot?.displayName).toBe('Grok Bot');
    expect(grokbot?.status).toBe('experimental');
    expect(grokbot?.aliases).toEqual([]);
    expect(normalizeProviderDefinitionId('grokbot')).toBe('grokbot');
    expect(normalizeProviderDefinitionId('grok')).toBeNull();
    expect(normalizeProviderDefinitionId('grok-build')).toBeNull();
    expect(grokbot?.detection).toMatchObject({ env: [], process: [], capabilityId: 'grokbot' });
    expect(grokbot?.paths.contextFiles.agentsMd).toBe(true);
    expect(grokbot?.context.loadMode).toBe('prose-directive');
    expect(grokbot?.context.support).toBe('degraded');
  });


  it('keeps capability matrix references resolvable for all non-generic providers', () => {
    for (const definition of listProviderDefinitions()) {
      if (definition.id === 'generic') {
        expect(definition.capabilities.matrixRef).toBeNull();
        continue;
      }
      expect(definition.capabilities.matrixRef).toBeTruthy();
      expect(Object.keys(definition.capabilities.nativeFeatures)).toContain('mcp');
      expect(Object.keys(definition.capabilities.emulation)).toContain('mission_control');
    }
  });

  it('models the current no-behavior-change paths for representative providers', () => {
    expect(getProviderDefinition('claude')?.paths.kernelSkills).toBe('.claude/skills');
    expect(getProviderDefinition('codex')?.paths.kernelSkills).toBe('.agents/skills');
    expect(getProviderDefinition('openhuman')?.paths.deployTarget).toBe('mixed');
    expect(getProviderDefinition('openhuman')?.paths.kernelSkills).toBe('~/.openhuman/skills');
    expect(getProviderDefinition('windsurf')?.surfaces.precedence).toContain('.devin/rules/');
    expect(getProviderDefinition('windsurf')?.paths.artifacts.rules).toBe('.windsurf/rules');
    expect(getProviderDefinition('windsurf')?.paths.kernelSkills).toBe('.windsurf/skills');
  });

  it('records the Devin/Windsurf topology decision without enabling .devin writes', () => {
    const windsurf = getProviderDefinition('windsurf');
    expect(windsurf).toBeDefined();
    expect(windsurf?.displayName).toBe('Devin Desktop');
    expect(windsurf?.status).toBe('stable');
    expect(normalizeProviderDefinitionId('devin')).toBe('windsurf');
    expect(normalizeProviderDefinitionId('devin-desktop')).toBe('windsurf');
    expect(normalizeProviderDefinitionId('devin-cli')).toBeNull();

    const desktop = windsurf?.surfaces.related.find((surface) => surface.id === 'devin-desktop');
    expect(desktop?.relationship).toBe('same-provider');
    expect(desktop?.deployable).toBe(true);
    expect(windsurf?.aliases).toEqual(expect.arrayContaining(['devin', 'devin-desktop', 'devin-local', 'cascade']));
    expect(desktop?.paths.rules).toEqual(['.devin/rules/*.md', '.windsurf/rules/*.md']);
    expect(desktop?.paths.agentsMd).toEqual(['AGENTS.md', 'agents.md']);
    expect(desktop?.notes.join('\n')).toContain('AIWG keeps .devin/ as ignored local provider output');
    expect(windsurf?.surfaces.precedence).toEqual([
      '.devin/rules/',
      '.windsurf/rules/',
      'AGENTS.md',
      '.windsurfrules',
    ]);

    const cli = windsurf?.surfaces.related.find((surface) => surface.id === 'devin-cli');
    expect(cli?.relationship).toBe('future-provider');
    expect(cli?.deployable).toBe(false);
    expect(cli?.paths.rules).toContain('AGENTS.md');
    expect(cli?.paths.skills).toContain('.devin/skills/<skill-name>/SKILL.md');

    const productSkills = windsurf?.surfaces.related.find((surface) => surface.id === 'devin-product-skills');
    expect(productSkills?.relationship).toBe('companion-standard');
    expect(productSkills?.deployable).toBe(false);
    expect(productSkills?.paths.skills).toEqual(['.agents/skills/<skill-name>/SKILL.md']);
  });

  it('models smith-facing paths separately from deploy paths where legacy behavior differs', () => {
    expect(getProviderDefinition('copilot')?.paths.artifacts.commands).toBe('.github/commands');
    expect(getProviderDefinition('copilot')?.smithPaths.commands).toBe('.github/agents');
    expect(getProviderDefinition('opencode')?.paths.artifacts.agents).toBe('.opencode/agent');
    expect(getProviderDefinition('opencode')?.smithPaths.agents).toBeNull();
    expect(getProviderDefinition('openhuman')?.paths.artifacts.skills).toBe('~/.openhuman/.aiwg/skills');
    expect(getProviderDefinition('openhuman')?.smithPaths.skills).toBe('~/.openhuman/skills');
  });

  it('models context-discovery paths separately where regenerate differs from deploy paths', () => {
    expect(getProviderDefinition('codex')?.paths.artifacts.skills).toBe('.codex/.aiwg/skills');
    expect(getProviderDefinition('codex')?.paths.contextDiscovery.skills).toBe('.agents/skills');
    expect(getProviderDefinition('copilot')?.paths.artifacts.rules).toBe('.github/copilot-rules');
    expect(getProviderDefinition('copilot')?.paths.contextDiscovery.rules).toBe('.github/instructions');
    expect(getProviderDefinition('openhuman')?.paths.artifacts.agents).toBeNull();
    expect(getProviderDefinition('openhuman')?.paths.contextDiscovery.agents).toBe('.agents/agents');
  });
});
