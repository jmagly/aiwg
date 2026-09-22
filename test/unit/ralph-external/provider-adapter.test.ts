/**
 * Unit tests for Provider Adapter system
 *
 * Tests the base class, factory, Claude adapter, Codex adapter,
 * OpenCode adapter, and Factory adapter for the external Ralph loop
 * multi-provider support.
 *
 * @source @tools/ralph-external/lib/provider-adapter.mjs
 * @source @tools/ralph-external/lib/claude-adapter.mjs
 * @source @tools/ralph-external/lib/codex-adapter.mjs
 * @source @tools/ralph-external/lib/opencode-adapter.mjs
 * @source @tools/ralph-external/lib/factory-adapter.mjs
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CODEX_ADAPTER_MODELS,
  FLAGSHIP_MODELS,
  OPENCODE_ADAPTER_MODEL,
  FACTORY_ADAPTER_MODELS,
} from '../../fixtures/models.js';

// Dynamic imports for .mjs modules
let ProviderAdapter: any;
let createProvider: any;
let registerProvider: any;
let listProviders: any;
let hasProvider: any;
let ensureProvidersRegistered: any;
let ClaudeAdapter: any;
let CodexAdapter: any;
let OpenCodeAdapter: any;
let FactoryAdapter: any;
let PiAdapter: any;

beforeEach(async () => {
  const adapterMod = await import('../../../tools/ralph-external/lib/provider-adapter.mjs');
  ProviderAdapter = adapterMod.ProviderAdapter;
  createProvider = adapterMod.createProvider;
  registerProvider = adapterMod.registerProvider;
  listProviders = adapterMod.listProviders;
  hasProvider = adapterMod.hasProvider;
  ensureProvidersRegistered = adapterMod.ensureProvidersRegistered;

  const claudeMod = await import('../../../tools/ralph-external/lib/claude-adapter.mjs');
  ClaudeAdapter = claudeMod.ClaudeAdapter;

  const codexMod = await import('../../../tools/ralph-external/lib/codex-adapter.mjs');
  CodexAdapter = codexMod.CodexAdapter;

  const opencodeMod = await import('../../../tools/ralph-external/lib/opencode-adapter.mjs');
  OpenCodeAdapter = opencodeMod.OpenCodeAdapter;

  const factoryMod = await import('../../../tools/ralph-external/lib/factory-adapter.mjs');
  FactoryAdapter = factoryMod.FactoryAdapter;
  PiAdapter = (await import('../../../tools/ralph-external/lib/pi-adapter.mjs')).PiAdapter;
});

// ============================================================================
// Base Class Tests
// ============================================================================

describe('ProviderAdapter (base class)', () => {
  it('cannot be instantiated directly', () => {
    expect(() => new ProviderAdapter()).toThrow('abstract');
  });

  it('subclass can be instantiated', () => {
    class TestAdapter extends ProviderAdapter {
      getBinary() { return 'test'; }
      getName() { return 'test'; }
      getCapabilities() { return {}; }
      buildSessionArgs() { return []; }
      buildAnalysisArgs() { return []; }
      mapModel(m: string) { return m; }
    }
    expect(() => new TestAdapter()).not.toThrow();
  });
});

// ============================================================================
// Registry & Factory Tests
// ============================================================================

describe('Provider Registry', () => {
  it('has all core providers registered', () => {
    const providers = ['claude', 'codex', 'opencode', 'factory', 'pi'];
    for (const provider of providers) {
      expect(hasProvider(provider)).toBe(true);
    }

    const providerList = listProviders();
    for (const provider of providers) {
      expect(providerList).toContain(provider);
    }
  });

  it('creates correct adapter instances via factory', () => {
    const tests = [
      { name: 'claude', Class: ClaudeAdapter, caseName: 'Claude' },
      { name: 'codex', Class: CodexAdapter, caseName: 'CODEX' },
      { name: 'opencode', Class: OpenCodeAdapter, caseName: 'OpenCode' },
      { name: 'factory', Class: FactoryAdapter, caseName: 'Factory' },
      { name: 'pi', Class: PiAdapter, caseName: 'PI' },
    ];

    for (const { name, Class, caseName } of tests) {
      const adapter = createProvider(name);
      expect(adapter).toBeInstanceOf(Class);
      expect(adapter.getName()).toBe(name);

      // Test case-insensitivity
      const caseAdapter = createProvider(caseName);
      expect(caseAdapter).toBeInstanceOf(Class);
    }
  });

  it('throws on unknown provider', () => {
    expect(() => createProvider('nonexistent')).toThrow('Unknown provider');
    expect(() => createProvider('nonexistent')).toThrow('Available providers');
  });

  // Regression test for race condition bug in tools/ralph-external/index.mjs
  it('requires ensureProvidersRegistered() before hasProvider() returns accurate results', async () => {
    // Import a fresh copy of the provider-adapter module to test registration flow
    const freshMod = await import('../../../tools/ralph-external/lib/provider-adapter.mjs?t=' + Date.now());
    const freshHasProvider = freshMod.hasProvider;
    const freshEnsureProvidersRegistered = freshMod.ensureProvidersRegistered;

    // BEFORE ensureProvidersRegistered(), hasProvider() may return false
    // because registration is async and might not have completed yet
    const beforeRegistration = freshHasProvider('claude');

    // AFTER ensureProvidersRegistered(), hasProvider('claude') MUST return true
    await freshEnsureProvidersRegistered();
    const afterRegistration = freshHasProvider('claude');

    // The bug was calling hasProvider() before awaiting ensureProvidersRegistered(),
    // which caused a race condition. After the fix, awaiting ensures providers are registered.
    expect(afterRegistration).toBe(true);

    // Note: We can't reliably assert beforeRegistration === false because in test
    // environment the registration might complete synchronously. The key invariant is:
    // after ensureProvidersRegistered(), hasProvider() MUST work correctly.
  });
});

describe('PiAdapter', () => {
  it('uses strict headless JSON, explicit trust denial, and preserves model/thinking/session', () => {
    const args = new PiAdapter().buildSessionArgs({ prompt: 'task', model: 'openrouter/code',
      thinking: 'high', sessionId: '/tmp/session.jsonl', tools: ['read', 'bash'] });
    expect(args).toEqual(['--mode', 'json', '--no-approve', '--model', 'openrouter/code',
      '--thinking', 'high', '--session', '/tmp/session.jsonl', '--tools', 'read,bash', 'task']);
  });
  it('rejects malformed JSONL and distinguishes agent settlement', () => {
    const adapter = new PiAdapter();
    expect(adapter.parseOutput('{"type":"agent_end"}\r\n{"type":"agent_settled"}\r\n')).toMatchObject({ settled: true });
    expect(adapter.parseOutput('{bad}\n')).toBeNull();
  });
});

// ============================================================================
// Claude Adapter Tests
// ============================================================================

describe('ClaudeAdapter', () => {
  let adapter: any;

  beforeEach(() => {
    adapter = new ClaudeAdapter();
  });

  describe('identity', () => {
    it('returns correct binary and name', () => {
      expect(adapter.getBinary()).toBe('claude');
      expect(adapter.getName()).toBe('claude');
    });
  });

  describe('capabilities', () => {
    it('supports all capabilities', () => {
      const caps = adapter.getCapabilities();
      const expectedCaps = [
        'streamJson',
        'sessionResume',
        'budgetControl',
        'systemPrompt',
        'agentMode',
        'mcpConfig',
        'maxTurns',
      ];

      for (const cap of expectedCaps) {
        expect(caps[cap]).toBe(true);
        expect(adapter.hasCapability(cap)).toBe(true);
      }
    });
  });

  describe('model mapping', () => {
    it('passes through all model names unchanged', () => {
      const models = ['opus', 'sonnet', 'haiku', 'claude-3.5-sonnet', 'arbitrary-model'];
      for (const model of models) {
        expect(adapter.mapModel(model)).toBe(model);
      }
    });
  });

  describe('buildSessionArgs', () => {
    it('includes required flags', () => {
      const args = adapter.buildSessionArgs({ prompt: 'test task' });
      expect(args).toContain('--dangerously-skip-permissions');
      expect(args).toContain('--print');
      expect(args).toContain('--output-format');
      expect(args).toContain('stream-json');
      expect(args[args.length - 1]).toBe('test task');
    });

    it('handles all optional parameters correctly', () => {
      const mcpConfig = { servers: { test: { command: 'test' } } };
      const optionTests = [
        { option: { sessionId: 'abc-123' }, flag: '--session-id', value: 'abc-123' },
        { option: { model: 'opus' }, flag: '--model', value: 'opus' },
        { option: { budget: 2.5 }, flag: '--max-budget-usd', value: '2.5' },
        { option: { maxTurns: 50 }, flag: '--max-turns', value: '50' },
        { option: { verbose: true }, flag: '--verbose', value: null },
        { option: { mcpConfig }, flag: '--mcp-config', value: JSON.stringify(mcpConfig) },
        { option: { systemPrompt: 'You are helpful' }, flag: '--append-system-prompt', value: 'You are helpful' },
      ];

      for (const { option, flag, value } of optionTests) {
        const args = adapter.buildSessionArgs({ prompt: 'task', ...option });
        expect(args).toContain(flag);
        if (value !== null) {
          expect(args).toContain(value);
        }
      }
    });

    it('puts prompt last', () => {
      const args = adapter.buildSessionArgs({
        prompt: 'my task',
        model: 'opus',
        budget: 5,
        verbose: true,
      });
      expect(args[args.length - 1]).toBe('my task');
    });
  });

  describe('buildAnalysisArgs', () => {
    it('includes required flags', () => {
      const args = adapter.buildAnalysisArgs({ prompt: 'analyze this' });
      expect(args).toContain('--dangerously-skip-permissions');
      expect(args).toContain('--print');
      expect(args).toContain('--output-format');
      expect(args).toContain('json');
      expect(args[args.length - 1]).toBe('analyze this');
    });

    it('includes optional parameters when provided', () => {
      const optionTests = [
        { option: { model: 'sonnet' }, flag: '--model', value: 'sonnet' },
        { option: { agent: 'ralph-output-analyzer' }, flag: '--agent', value: 'ralph-output-analyzer' },
      ];

      for (const { option, flag, value } of optionTests) {
        const args = adapter.buildAnalysisArgs({ prompt: 'analyze', ...option });
        expect(args).toContain(flag);
        expect(args).toContain(value);
      }
    });
  });

  describe('environment overrides', () => {
    const originalDisable1m = process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;

    afterEach(() => {
      if (originalDisable1m === undefined) delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
      else process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = originalDisable1m;
    });

    it('sets CI=true and disables Claude 1M context by default', () => {
      delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
      expect(adapter.getEnvOverrides()).toEqual({ CI: 'true', CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' });
    });

    it('preserves an explicit Claude 1M context setting', () => {
      process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '0';
      expect(adapter.getEnvOverrides()).toEqual({ CI: 'true' });
    });
  });

  describe('transcript path', () => {
    it('returns Claude transcript path', () => {
      const path = adapter.getTranscriptPath('session-123', '/my/project');
      expect(path).toContain('.claude');
      expect(path).toContain('projects');
      expect(path).toContain('session-123.jsonl');
    });
  });

  describe('output parsing', () => {
    it('handles all parsing scenarios', () => {
      const tests = [
        { input: 'Some text {"key": "value"} more text', expected: { key: 'value' } },
        { input: 'no json here', expected: null },
        { input: '', expected: null },
      ];

      for (const { input, expected } of tests) {
        expect(adapter.parseOutput(input)).toEqual(expected);
      }
    });
  });
});

// ============================================================================
// Codex Adapter Tests
// ============================================================================

describe('CodexAdapter', () => {
  let adapter: any;

  beforeEach(() => {
    adapter = new CodexAdapter();
  });

  describe('identity', () => {
    it('returns correct binary and name', () => {
      expect(adapter.getBinary()).toBe('codex');
      expect(adapter.getName()).toBe('codex');
    });
  });

  describe('capabilities', () => {
    it('reports limited capabilities', () => {
      const caps = adapter.getCapabilities();
      const unsupportedCaps = [
        'streamJson',
        'sessionResume',
        'budgetControl',
        'systemPrompt',
        'agentMode',
        'mcpConfig',
        'maxTurns',
      ];

      for (const cap of unsupportedCaps) {
        expect(caps[cap]).toBe(false);
        expect(adapter.hasCapability(cap)).toBe(false);
      }
    });
  });

  describe('model mapping', () => {
    it('maps generic aliases to the tier-equivalent codex model', () => {
      const mappings = [
        { input: 'opus',   expected: CODEX_ADAPTER_MODELS.opus },
        { input: 'sonnet', expected: CODEX_ADAPTER_MODELS.sonnet },
        { input: 'haiku',  expected: CODEX_ADAPTER_MODELS.haiku },
        { input: 'OPUS',   expected: CODEX_ADAPTER_MODELS.opus },
        { input: 'Sonnet', expected: CODEX_ADAPTER_MODELS.sonnet },
      ];

      for (const { input, expected } of mappings) {
        expect(adapter.mapModel(input)).toBe(expected);
      }
    });

    it('never maps an alias to the user-elected flagship', () => {
      for (const alias of ['opus', 'sonnet', 'haiku']) {
        expect(adapter.mapModel(alias)).not.toBe(FLAGSHIP_MODELS.openai);
      }
      expect(adapter.mapModel(FLAGSHIP_MODELS.openai)).toBe(FLAGSHIP_MODELS.openai);
    });

    it('passes through unknown model names', () => {
      const models = [CODEX_ADAPTER_MODELS.opus, 'custom-model'];
      for (const model of models) {
        expect(adapter.mapModel(model)).toBe(model);
      }
    });
  });

  describe('buildSessionArgs', () => {
    it('uses exec subcommand with dangerous mode and skip-git-repo-check', () => {
      const args = adapter.buildSessionArgs({ prompt: 'task' });
      expect(args[0]).toBe('exec');
      expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(args).toContain('--skip-git-repo-check');
      expect(args).not.toContain('--full-auto');
      expect(args).not.toContain('--print');
      expect(args).not.toContain('--output-format');
    });

    it('maps model names', () => {
      const args = adapter.buildSessionArgs({
        prompt: 'task',
        model: 'opus',
      });
      expect(args).toContain('--model');
      expect(args).toContain(CODEX_ADAPTER_MODELS.opus);
    });

    it('injects system prompt into main prompt', () => {
      const args = adapter.buildSessionArgs({
        prompt: 'my task',
        systemPrompt: 'Be helpful',
      });
      const lastArg = args[args.length - 1];
      expect(lastArg).toContain('Be helpful');
      expect(lastArg).toContain('my task');
      expect(lastArg).toContain('[System Context]');
    });

    it('puts prompt last', () => {
      const args = adapter.buildSessionArgs({ prompt: 'do stuff' });
      expect(args[args.length - 1]).toBe('do stuff');
    });

    it('warns on unsupported features', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      adapter.buildSessionArgs({ prompt: 'task', budget: 5 });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Budget control'));

      warnSpy.mockClear();
      adapter.buildSessionArgs({ prompt: 'task', mcpConfig: {} });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('MCP configuration'));

      warnSpy.mockRestore();
    });
  });

  describe('buildAnalysisArgs', () => {
    it('uses exec subcommand with dangerous mode and skip-git-repo-check', () => {
      const args = adapter.buildAnalysisArgs({ prompt: 'analyze' });
      expect(args[0]).toBe('exec');
      expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(args).toContain('--skip-git-repo-check');
      expect(args).not.toContain('--full-auto');
      expect(args).not.toContain('--quiet');
    });

    it('maps model names and silently skips unsupported agent flag', () => {
      const args = adapter.buildAnalysisArgs({
        prompt: 'analyze',
        model: 'sonnet',
        agent: 'ralph-output-analyzer',
      });
      expect(args).toContain('--model');
      expect(args).toContain(CODEX_ADAPTER_MODELS.sonnet);
      expect(args).not.toContain('--agent');
    });
  });

  describe('environment overrides', () => {
    it('sets CI=true', () => {
      expect(adapter.getEnvOverrides()).toEqual({ CI: 'true' });
    });
  });

  describe('transcript path', () => {
    it('returns null (not supported)', () => {
      expect(adapter.getTranscriptPath('session-123', '/project')).toBeNull();
    });
  });

  describe('output parsing', () => {
    it('handles all parsing scenarios', () => {
      const tests = [
        { input: 'Result: {"completed": true}', expected: { completed: true } },
        { input: 'just plain text', expected: null },
      ];

      for (const { input, expected } of tests) {
        expect(adapter.parseOutput(input)).toEqual(expected);
      }
    });
  });
});

// ============================================================================
// OpenCode Adapter Tests
// ============================================================================

describe('OpenCodeAdapter', () => {
  let adapter: any;

  beforeEach(() => {
    adapter = new OpenCodeAdapter();
  });

  describe('identity', () => {
    it('returns correct binary and name', () => {
      expect(adapter.getBinary()).toBe('opencode');
      expect(adapter.getName()).toBe('opencode');
    });
  });

  describe('capabilities', () => {
    it('reports correct capabilities', () => {
      const caps = adapter.getCapabilities();
      expect(caps.streamJson).toBe(false);
      expect(caps.sessionResume).toBe(true);
      expect(caps.budgetControl).toBe(false);
      expect(caps.systemPrompt).toBe(false);
      expect(caps.agentMode).toBe(true);
      expect(caps.mcpConfig).toBe(false);
      expect(caps.maxTurns).toBe(false);
    });
  });

  describe('model mapping', () => {
    it('maps generic model names to opencode model (free tier default)', () => {
      const mappings = [
        { input: 'opus',   expected: OPENCODE_ADAPTER_MODEL },
        { input: 'sonnet', expected: OPENCODE_ADAPTER_MODEL },
        { input: 'haiku',  expected: OPENCODE_ADAPTER_MODEL },
        { input: 'OPUS',   expected: OPENCODE_ADAPTER_MODEL },
      ];

      for (const { input, expected } of mappings) {
        expect(adapter.mapModel(input)).toBe(expected);
      }
    });

    it('passes through unknown model names', () => {
      expect(adapter.mapModel('anthropic/custom-model')).toBe('anthropic/custom-model');
    });
  });

  describe('buildSessionArgs', () => {
    it('uses run subcommand with --format json', () => {
      const args = adapter.buildSessionArgs({ prompt: 'task' });
      expect(args[0]).toBe('run');
      expect(args).toContain('--format');
      expect(args).toContain('json');
      expect(args).not.toContain('--dangerously-skip-permissions');
    });

    it('maps model names with -m flag', () => {
      const args = adapter.buildSessionArgs({ prompt: 'task', model: 'sonnet' });
      expect(args).toContain('-m');
      expect(args).toContain(OPENCODE_ADAPTER_MODEL);
    });

    it('supports session resume via -s flag', () => {
      const args = adapter.buildSessionArgs({ prompt: 'task', sessionId: 'abc-123' });
      expect(args).toContain('-s');
      expect(args).toContain('abc-123');
    });

    it('injects system prompt into main prompt', () => {
      const args = adapter.buildSessionArgs({
        prompt: 'my task',
        systemPrompt: 'Be helpful',
      });
      const lastArg = args[args.length - 1];
      expect(lastArg).toContain('Be helpful');
      expect(lastArg).toContain('my task');
      expect(lastArg).toContain('[System Context]');
    });

    it('puts prompt last', () => {
      const args = adapter.buildSessionArgs({ prompt: 'do stuff' });
      expect(args[args.length - 1]).toBe('do stuff');
    });

    it('warns on unsupported features', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      adapter.buildSessionArgs({ prompt: 'task', budget: 5 });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Budget control'));

      warnSpy.mockClear();
      adapter.buildSessionArgs({ prompt: 'task', mcpConfig: {} });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('MCP configuration'));

      warnSpy.mockRestore();
    });
  });

  describe('buildAnalysisArgs', () => {
    it('uses run subcommand with --format json', () => {
      const args = adapter.buildAnalysisArgs({ prompt: 'analyze' });
      expect(args[0]).toBe('run');
      expect(args).toContain('--format');
      expect(args).toContain('json');
    });

    it('supports agent flag', () => {
      const args = adapter.buildAnalysisArgs({
        prompt: 'analyze',
        agent: 'ralph-output-analyzer',
      });
      expect(args).toContain('--agent');
      expect(args).toContain('ralph-output-analyzer');
    });

    it('maps model names', () => {
      const args = adapter.buildAnalysisArgs({ prompt: 'analyze', model: 'haiku' });
      expect(args).toContain('-m');
      expect(args).toContain(OPENCODE_ADAPTER_MODEL);
    });
  });

  describe('environment overrides', () => {
    it('sets CI=true', () => {
      expect(adapter.getEnvOverrides()).toEqual({ CI: 'true' });
    });
  });

  describe('transcript path', () => {
    it('returns null (not supported)', () => {
      expect(adapter.getTranscriptPath('session-123', '/project')).toBeNull();
    });
  });

  describe('parseOutput', () => {
    it('extracts text from newline-delimited JSON event stream', () => {
      const stdout = [
        JSON.stringify({ type: 'step_start', timestamp: 1234, sessionID: 's1', part: {} }),
        JSON.stringify({ type: 'text', timestamp: 1235, sessionID: 's1', part: { type: 'text', text: 'Hello ' } }),
        JSON.stringify({ type: 'text', timestamp: 1236, sessionID: 's1', part: { type: 'text', text: 'world' } }),
        JSON.stringify({ type: 'step_finish', timestamp: 1237, sessionID: 's1', part: { reason: 'stop' } }),
      ].join('\n');

      const result = adapter.parseOutput(stdout);
      expect(result).not.toBeNull();
      expect(result.text).toBe('Hello world');
    });

    it('returns null when no text events present', () => {
      const stdout = JSON.stringify({ type: 'step_start', part: {} });
      expect(adapter.parseOutput(stdout)).toBeNull();
    });

    it('passes through anthropic/* model IDs unchanged', () => {
      const namespacedModel = 'anthropic/claude-sonnet-4-6';
      expect(adapter.mapModel(namespacedModel)).toBe(namespacedModel);
    });
  });
});

// ============================================================================
// Factory (Droid) Adapter Tests
// ============================================================================

describe('FactoryAdapter', () => {
  let adapter: any;

  beforeEach(() => {
    adapter = new FactoryAdapter();
  });

  describe('identity', () => {
    it('returns correct binary and name', () => {
      expect(adapter.getBinary()).toBe('droid');
      expect(adapter.getName()).toBe('factory');
    });
  });

  describe('capabilities', () => {
    it('reports correct capabilities', () => {
      const caps = adapter.getCapabilities();
      expect(caps.streamJson).toBe(true);
      expect(caps.sessionResume).toBe(true);
      expect(caps.budgetControl).toBe(false);
      expect(caps.systemPrompt).toBe(false);
      expect(caps.agentMode).toBe(false);
      expect(caps.mcpConfig).toBe(false);
      expect(caps.maxTurns).toBe(false);
    });
  });

  describe('model mapping', () => {
    it('maps generic model names to Factory model IDs', () => {
      const mappings = [
        { input: 'opus', expected: FACTORY_ADAPTER_MODELS.opus },
        { input: 'sonnet', expected: FACTORY_ADAPTER_MODELS.sonnet },
        { input: 'haiku', expected: FACTORY_ADAPTER_MODELS.haiku },
        { input: 'HAIKU', expected: FACTORY_ADAPTER_MODELS.haiku },
      ];

      for (const { input, expected } of mappings) {
        expect(adapter.mapModel(input)).toBe(expected);
      }
    });

    it('passes through unknown model names', () => {
      const unknownModel = 'gpt-5.1';
      expect(adapter.mapModel(unknownModel)).toBe(unknownModel);
    });
  });

  describe('buildSessionArgs', () => {
    it('uses exec subcommand with --skip-permissions-unsafe', () => {
      const args = adapter.buildSessionArgs({ prompt: 'task' });
      expect(args[0]).toBe('exec');
      expect(args).toContain('--skip-permissions-unsafe');
      expect(args).toContain('--output-format');
      expect(args).toContain('stream-json');
      expect(args).not.toContain('--dangerously-skip-permissions');
    });

    it('maps model names with -m flag', () => {
      const args = adapter.buildSessionArgs({ prompt: 'task', model: 'opus' });
      expect(args).toContain('-m');
      expect(args).toContain(FACTORY_ADAPTER_MODELS.opus);
    });

    it('supports session resume via -s flag', () => {
      const args = adapter.buildSessionArgs({ prompt: 'task', sessionId: 'sess-456' });
      expect(args).toContain('-s');
      expect(args).toContain('sess-456');
    });

    it('injects system prompt into main prompt', () => {
      const args = adapter.buildSessionArgs({
        prompt: 'my task',
        systemPrompt: 'Be careful',
      });
      const lastArg = args[args.length - 1];
      expect(lastArg).toContain('Be careful');
      expect(lastArg).toContain('my task');
      expect(lastArg).toContain('[System Context]');
    });

    it('puts prompt last', () => {
      const args = adapter.buildSessionArgs({ prompt: 'do stuff' });
      expect(args[args.length - 1]).toBe('do stuff');
    });

    it('warns on unsupported features', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      adapter.buildSessionArgs({ prompt: 'task', budget: 5 });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Budget control'));

      warnSpy.mockClear();
      adapter.buildSessionArgs({ prompt: 'task', maxTurns: 50 });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Max turns'));

      warnSpy.mockRestore();
    });
  });

  describe('buildAnalysisArgs', () => {
    it('uses exec subcommand with text output (read-only)', () => {
      const args = adapter.buildAnalysisArgs({ prompt: 'analyze' });
      expect(args[0]).toBe('exec');
      expect(args).toContain('--output-format');
      expect(args).toContain('text');
      expect(args).not.toContain('--skip-permissions-unsafe');
    });

    it('maps model names', () => {
      const args = adapter.buildAnalysisArgs({ prompt: 'analyze', model: 'sonnet' });
      expect(args).toContain('-m');
      expect(args).toContain(FACTORY_ADAPTER_MODELS.sonnet);
    });

    it('silently skips unsupported agent flag', () => {
      const args = adapter.buildAnalysisArgs({
        prompt: 'analyze',
        agent: 'ralph-output-analyzer',
      });
      expect(args).not.toContain('--agent');
    });
  });

  describe('environment overrides', () => {
    it('sets CI=true', () => {
      expect(adapter.getEnvOverrides()).toEqual({ CI: 'true' });
    });
  });

  describe('transcript path', () => {
    it('returns null (not supported)', () => {
      expect(adapter.getTranscriptPath('session-123', '/project')).toBeNull();
    });
  });
});

// ============================================================================
// Cross-Provider Consistency Tests
// ============================================================================

describe('Cross-Provider Consistency', () => {
  let adapters: Record<string, any>;

  beforeEach(() => {
    adapters = {
      claude: new ClaudeAdapter(),
      codex: new CodexAdapter(),
      opencode: new OpenCodeAdapter(),
      factory: new FactoryAdapter(),
    };
  });

  it('all implement required methods', () => {
    const methods = [
      'getBinary', 'getName', 'getCapabilities',
      'buildSessionArgs', 'buildAnalysisArgs', 'mapModel',
      'isAvailable', 'getVersion', 'parseOutput',
      'getEnvOverrides', 'getTranscriptPath',
    ];
    for (const [name, adapter] of Object.entries(adapters)) {
      for (const method of methods) {
        expect(typeof adapter[method]).toBe('function');
      }
    }
  });

  it('all produce prompt as last argument', () => {
    const promptTests = [
      { method: 'buildSessionArgs', prompt: 'test' },
      { method: 'buildAnalysisArgs', prompt: 'analyze' },
    ];

    for (const { method, prompt } of promptTests) {
      for (const [name, adapter] of Object.entries(adapters)) {
        const args = adapter[method]({ prompt });
        expect(args[args.length - 1]).toBe(prompt);
      }
    }
  });

  it('all handle the same generic model names', () => {
    const models = ['opus', 'sonnet', 'haiku'];
    for (const [name, adapter] of Object.entries(adapters)) {
      for (const model of models) {
        expect(typeof adapter.mapModel(model)).toBe('string');
      }
    }
  });
});
