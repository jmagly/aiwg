import { describe, expect, it } from 'vitest';
import { buildSessionEnvironment } from '../../../tools/ralph-external/lib/session-environment.mjs';
import {
  compileModelPolicy,
  assertOperatorWorkerNativeArgv,
  assertWorkerLaunchMode,
  WORKER_OPERATOR_APPROVAL,
  loadProviderModelCapabilities,
  loadProviderModelCatalog,
  resetModelPolicyCachesForTests,
  renderCodexAgentToml,
  validateCanonicalModelPolicy,
  validateUserProjectModelConfig,
} from '../../../src/models/provider-policy.js';

describe('provider model registry', () => {
  const sessionPolicies = {
    antigravity: ['GEMINI_API_KEY'],
    cursor: ['CURSOR_API_KEY'],
    warp: ['WARP_API_KEY'],
    windsurf: [],
    openclaw: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
      'OPENROUTER_API_KEY', 'MISTRAL_API_KEY', 'XAI_API_KEY', 'OPENCLAW_HOME',
      'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH', 'OPENCLAW_GATEWAY_URL',
      'OPENCLAW_GATEWAY_TOKEN', 'OPENCLAW_GATEWAY_PASSWORD'],
    grokbot: [],
    'grok-build': ['XAI_API_KEY', 'GROK_HOME'],
    hermes: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'GEMINI_API_KEY',
      'GOOGLE_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY',
      'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL',
      'OPENROUTER_BASE_URL', 'CUSTOM_BASE_URL', 'HERMES_HOME', 'HERMES_INFERENCE_PROVIDER'],
    openhuman: ['OPENHUMAN_CORE_TOKEN', 'OPENHUMAN_CORE_RPC_URL', 'OPENHUMAN_CORE_HOST',
      'OPENHUMAN_CORE_PORT', 'OPENHUMAN_WORKSPACE', 'OPENHUMAN_DOTENV_PATH',
      'OPENHUMAN_KEYRING_MASTER_KEY', 'OPENHUMAN_KEYRING_MASTER_KEY_FILE',
      'OPENHUMAN_APP_ENV', 'BACKEND_URL', 'OPENHUMAN_MODEL'],
  };

  it('makes session inheritance an explicit decision for every bundled provider', () => {
    for (const capability of Object.values(loadProviderModelCapabilities().providers)) {
      expect(Object.hasOwn(capability, 'sessionEnvAllowlist')).toBe(true);
      expect(Array.isArray(capability.sessionEnvAllowlist)).toBe(true);
    }
  });

  it.each(Object.entries(sessionPolicies))('inherits only declared provider variables for %s', (provider, names) => {
    expect(loadProviderModelCapabilities().providers[provider].sessionEnvAllowlist).toEqual(names);
    const candidates = new Set([
      ...Object.values(sessionPolicies).flat(), 'UNRELATED_API_KEY', 'AIWG_RESOURCE_TOKEN',
      'GROK_CODE_XAI_API_KEY', 'OPENHUMAN_HOME', 'HERMES_YOLO_MODE',
    ]);
    const source = Object.fromEntries([...candidates].map(name => [name, `dummy-${name}`]));
    const expected = Object.fromEntries(names.map(name => [name, source[name]]));
    expect(buildSessionEnvironment(provider, {}, source)).toEqual(expected);
    expect(buildSessionEnvironment(provider, {}, { ...source, HOME: '/synthetic-home', PATH: '/synthetic-bin' }))
      .toEqual({ ...expected, HOME: '/synthetic-home', PATH: '/synthetic-bin' });
    expect(source.UNRELATED_API_KEY).toBe('dummy-UNRELATED_API_KEY');
  });

  it.each(['windsurf', 'grokbot'])('keeps %s coverage-only with an explained empty session policy', provider => {
    const capability = loadProviderModelCapabilities().providers[provider];
    expect(capability.sessionEnvAllowlist).toEqual([]);
    expect(capability.verification).toContain('no CLI credential variable is evidenced');
    expect(capability.workerAdapter).toBeUndefined();
    expect(capability.workerHealthAdapter).toBeUndefined();
    expect(capability.workerHealthCoverage?.scope).toBe('out');
  });

  it('confirms Antigravity key prerequisites without broadening worker policy', () => {
    const adapter = loadProviderModelCapabilities().providers.antigravity.workerHealthAdapter!;
    expect(adapter.invocation.kind).toBe('process');
    if (adapter.invocation.kind !== 'process') throw new Error('Expected process adapter');
    expect(adapter.invocation.envAllowlist).toEqual(['GEMINI_API_KEY', 'HOME', 'PATH']);
    const profile = adapter.invocationProfiles!['direct-shell'];
    expect(profile.envAllowlist).toEqual(adapter.invocation.envAllowlist);
    expect(profile.pitfalls.join(' ')).toContain('modelProvider to gemini');
    expect(adapter.qualification.status).toBe('unqualified');
  });

  it('covers every audited provider with sourced, dated capability entries', () => {
    const registry = loadProviderModelCapabilities();
    expect(Object.keys(registry.providers).sort()).toEqual([
      'antigravity', 'claude', 'codex', 'copilot', 'cursor', 'deepseek-harness', 'factory', 'flue', 'grok-build', 'grokbot', 'hermes',
      'muse', 'omp', 'openclaw', 'opencode', 'openhuman', 'pi', 'warp', 'windsurf',
    ]);
    for (const [provider, capability] of Object.entries(registry.providers)) {
      expect(capability.sourceUrl).toMatch(/^https:\/\//);
      if (provider === 'flue') expect(capability.verifiedAt).toBe('2026-10-30');
      else expect(capability.verifiedAt).toMatch(/^2026-(?:07-20|09-04|09-05|09-15|09-21|09-24|09-25)$/);
      expect(capability.identifierSyntax).not.toBe('');
      expect(capability.verification).not.toBe('');
    }
  });
  it('keeps exact IDs in the separately refreshable catalog', () => {
    const catalog = loadProviderModelCatalog();
    expect(catalog.version).toBe('1.0.0');
    expect(catalog.staleAfterDays).toBeGreaterThan(0);
    expect(catalog.providers.codex.roles.coding.id).toBe('gpt-6.1-terra');
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
    { role: 'coding', tier: 'unknown-tier' },
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
      model: 'gpt-6-luna',
      model_reasoning_effort: 'low',
    });
  });
  it('honors an effective dynamic catalog supplied by callers', () => {
    const catalog = JSON.parse(JSON.stringify(loadProviderModelCatalog()));
    catalog.providers.codex.tiers.economy.id = 'gpt-dynamic-cheap';
    catalog.providers.codex.tiers!.economy.status = 'active';
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
      now: new Date('2027-03-01T00:00:00Z'),
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
    const entry = catalog.providers.codex.tiers!.economy;
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


describe('operator-approved native Codex controls', () => {
  const adapter = () => {
    const result = structuredClone(loadProviderModelCapabilities().providers.codex.workerHealthAdapter!);
    result.qualification = { status: 'qualified', evidenceRef: WORKER_OPERATOR_APPROVAL };
    return result;
  };
  const selected = { model: 'synthetic-code', effort: { value: 'medium' } };
  const permissions = { sandbox: 'workspace-write', approval: 'never' };
  const argv = ['/trusted/codex', '--no-daemon', 'exec', '--ignore-user-config', '-m', selected.model,
    '-c', 'model_reasoning_effort="medium"', '-s', 'workspace-write', '-c', 'approval_policy="never"', '-'];
  it.each(['read-only', 'workspace-write', 'external'])('accepts exact %s flags and rejects other sandbox flags', sandbox => {
    const rendered = argv.map(token => token === 'workspace-write' ? sandbox === 'external' ? 'danger-full-access' : sandbox : token);
    expect(() => assertOperatorWorkerNativeArgv(adapter(), rendered, selected, { ...permissions, sandbox })).not.toThrow();
    for (const other of ['read-only', 'workspace-write', 'external'].filter(value => value !== sandbox)) {
      expect(() => assertOperatorWorkerNativeArgv(adapter(), rendered, selected, { ...permissions, sandbox: other })).toThrow();
    }
  });
  it.each(['codex', 'muse'])('keeps native-sandbox incompatible with external for %s', provider => {
    expect(() => assertWorkerLaunchMode({ ...adapter(), provider }, { launchMode: 'native-sandbox', sandbox: 'external' })).toThrow('native-sandbox requires');
  });
  it.each(['-m', '-s', 'model_reasoning_effort="medium"'])('blocks dropped %s', control => {
    const broken = [...argv];
    const index = broken.indexOf(control);
    if (control.startsWith('-')) broken.splice(index, 2);
    else broken.splice(index - 1, 2);
    expect(() => assertOperatorWorkerNativeArgv(adapter(), broken, selected, permissions)).toThrow('absent or ambiguous');
  });
  it.each(['danger-full-access', 'unknown'])('blocks an unrenderable sandbox %s', sandbox => {
    expect(() => assertOperatorWorkerNativeArgv(adapter(), argv, selected, { ...permissions, sandbox })).toThrow('sandbox');
  });
  it.each([
    ['-s', 'read-only'], ['-s', 'danger-full-access'], ['--dangerously-bypass-approvals-and-sandbox'], ['--full-auto'],
    ['-c', 'model_reasoning_effort="high"'], ['--sandbox=read-only'], ['-sread-only'], ['-cmodel_reasoning_effort="high"'], ['-c', 'sandbox_mode="danger-full-access"'],
  ])('blocks ambiguous or overriding flags %j', (...extra) => {
    expect(() => assertOperatorWorkerNativeArgv(adapter(), [...argv, ...extra], selected, permissions)).toThrow();
  });
});
