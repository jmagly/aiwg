import { describe, expect, it } from 'vitest';
import {
  compileModelPolicy,
  loadProviderModelCapabilities,
  loadProviderModelCatalog,
  resetModelPolicyCachesForTests,
  renderCodexAgentToml,
  validateCanonicalModelPolicy,
  validateUserProjectModelConfig,
} from '../../../src/models/provider-policy.js';

describe('provider model registry', () => {
  it('covers every audited provider with sourced, dated capability entries', () => {
    const registry = loadProviderModelCapabilities();
    expect(Object.keys(registry.providers).sort()).toEqual([
      'antigravity', 'claude', 'codex', 'copilot', 'cursor', 'deepseek-harness', 'factory', 'grok-build', 'grokbot', 'hermes',
      'muse', 'omp', 'openclaw', 'opencode', 'openhuman', 'pi', 'warp', 'windsurf',
    ]);
    for (const capability of Object.values(registry.providers)) {
      expect(capability.sourceUrl).toMatch(/^https:\/\//);
      expect(capability.verifiedAt).toMatch(/^2026-(?:07-20|09-04|09-05|09-15|09-21|09-24|09-25)$/);
      expect(capability.identifierSyntax).not.toBe('');
      expect(capability.verification).not.toBe('');
    }
  });
  it('keeps exact IDs in the separately refreshable catalog', () => {
    const catalog = loadProviderModelCatalog();
    expect(catalog.version).toBe('1.0.0');
    expect(catalog.staleAfterDays).toBeGreaterThan(0);
    expect(catalog.providers.codex.roles.coding.id).toBe('gpt-5.6-terra');
  });
});
describe('project/user model config validation', () => {
  it('accepts compatibility max-quality but rejects unknown providers and tiers', () => {
    expect(validateUserProjectModelConfig({
      defaults: { provider: 'codex', tier: 'max-quality' },
    }).valid).toBe(true);
    const result = validateUserProjectModelConfig({
      defaults: { provider: 'mystery', tier: 'free' },
    });
    expect(result.valid).toBe(false);
    expect(result.diagnostics.every(item => item.code === 'MODEL_POLICY_INVALID')).toBe(true);
  });
});
describe('canonical model policy validation', () => {
  it('accepts the versioned role/tier/effort shape', () => {
    expect(validateCanonicalModelPolicy({
      role: 'efficiency', tier: 'economy', effort: 'low',
    }).valid).toBe(true);
  });
  it.each([
    { role: 'unknown', tier: 'economy' },
    { role: 'coding', tier: 'max-quality' },
    { role: 'coding', tier: 'standard', extra: true },
  ])('rejects invalid policy before compilation: %j', policy => {
    const result = validateCanonicalModelPolicy(policy);
    expect(result.valid).toBe(false);
    expect(result.diagnostics[0]?.code).toBe('MODEL_POLICY_INVALID');
  });
});
describe('provider-aware compilation', () => {
  const policy = { role: 'efficiency', tier: 'economy', effort: 'low' } as const;
  it('emits native Codex field names', () => {
    const result = compileModelPolicy({ provider: 'codex', artifact: 'agent', policy });
    expect(result.outcome).toBe('native');
    expect(result.fields).toEqual({
      model: 'gpt-5.6-luna',
      model_reasoning_effort: 'low',
    });
  });
  it('honors an effective dynamic catalog supplied by callers', () => {
    const catalog = JSON.parse(JSON.stringify(loadProviderModelCatalog()));
    catalog.providers.codex.roles.efficiency.id = 'gpt-dynamic-cheap';
    catalog.providers.codex.roles.efficiency.status = 'active';
    const result = compileModelPolicy({
      provider: 'codex',
      artifact: 'agent',
      policy,
      catalog,
    });
    expect(result.fields.model).toBe('gpt-dynamic-cheap');
  });
  it('omits pretend per-agent fields for global-only Warp', () => {
    const result = compileModelPolicy({ provider: 'warp', artifact: 'agent', policy });
    expect(result.outcome).toBe('global-only');
    expect(result.fields).toEqual({});
    expect(result.diagnostics.map(item => item.code)).toContain('MODEL_SURFACE_DEGRADED');
  });
  it('omits unsupported Windsurf and Codex skill fields', () => {
    for (const [provider, artifact] of [
      ['windsurf', 'agent'], ['codex', 'skill'],
    ] as const) {
      const result = compileModelPolicy({ provider, artifact, policy });
      expect(result.outcome).toBe('unsupported');
      expect(result.fields).toEqual({});
      expect(result.diagnostics.map(item => item.code)).toContain('MODEL_SURFACE_UNSUPPORTED');
    }
  });
  it('reports catalog staleness deterministically', () => {
    const result = compileModelPolicy({
      provider: 'codex', artifact: 'agent', policy,
      now: new Date('2027-01-01T00:00:00Z'),
    });
    expect(result.diagnostics.map(item => item.code)).toContain('MODEL_CATALOG_STALE');
  });
  it('reports unsupported effort and unverified exact overrides', () => {
    const unsupportedEffort = compileModelPolicy({
      provider: 'copilot', artifact: 'agent', policy,
    });
    expect(unsupportedEffort.diagnostics.map(item => item.code))
      .toContain('MODEL_EFFORT_UNSUPPORTED');

    const override = compileModelPolicy({
      provider: 'codex',
      artifact: 'agent',
      policy: { ...policy, override: 'provider-specific-preview' },
    });
    expect(override.diagnostics.map(item => item.code))
      .toContain('MODEL_OVERRIDE_UNVERIFIED');
  });
  it('rejects a deprecated catalog selection with a stable diagnostic', () => {
    const catalog = loadProviderModelCatalog();
    const entry = catalog.providers.codex.roles.efficiency;
    const originalStatus = entry.status;
    try {
      entry.status = 'deprecated';
      const result = compileModelPolicy({
        provider: 'codex', artifact: 'agent', policy,
      });
      expect(result.diagnostics.map(item => item.code))
        .toContain('MODEL_CATALOG_DEPRECATED');
    } finally {
      entry.status = originalStatus;
      resetModelPolicyCachesForTests();
    }
  });

  it.each([
    ['claude', 'native', true],
    ['codex', 'native', true],
    ['copilot', 'native', true],
    ['cursor', 'native', true],
    ['factory', 'native', true],
    ['hermes', 'global-only', false],
    ['muse', 'unsupported', false],
    ['opencode', 'native', true],
    ['openclaw', 'native', true],
    ['openhuman', 'compiled', true],
    ['omp', 'native', true],
    ['pi', 'native', true],
    ['warp', 'global-only', false],
    ['windsurf', 'unsupported', false],
  ] as const)(
    'compiles %s agent policy as %s without pretend fields',
    (provider, expectedOutcome, expectsFields) => {
      const result = compileModelPolicy({ provider, artifact: 'agent', policy });
      expect(result.outcome).toBe(expectedOutcome);
      expect(Object.keys(result.fields).length > 0).toBe(expectsFields);
      if (!expectsFields) {
        expect(result.diagnostics.some(item => (
          item.code === 'MODEL_SURFACE_DEGRADED'
          || item.code === 'MODEL_SURFACE_UNSUPPORTED'
        ))).toBe(true);
      }
    },
  );
});
describe('Codex standalone TOML compiler', () => {
  it('emits required custom-agent fields and model controls', () => {
    const output = renderCodexAgentToml({
      name: 'reviewer',
      description: 'Reviews code',
      developerInstructions: 'Inspect changes and report risks.',
      model: 'gpt-5.4',
      modelReasoningEffort: 'high',
    });
    expect(output).toBe([
      'name = "reviewer"',
      'description = "Reviews code"',
      'developer_instructions = "Inspect changes and report risks."',
      'model = "gpt-5.4"',
      'model_reasoning_effort = "high"',
      '',
    ].join('\n'));
  });
  it('rejects incomplete required fields', () => {
    expect(() => renderCodexAgentToml({
      name: '', description: 'Missing name', developerInstructions: 'Do work',
    })).toThrow(/requires name/);
  });
});
