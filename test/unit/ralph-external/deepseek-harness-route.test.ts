/** Offline patch and route regressions for #4313; no model or credentials. */
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadProviderModelCapabilities } from '../../../src/models/provider-policy.js';
import { buildInstalledWorkerTransport } from '../../../src/models/worker-artifact-binding.mjs';
import { DeepSeekHarnessDirectAdapter, buildDeepSeekHarnessPatch,
  DEEPSEEK_HARNESS_DIRECT_SANDBOX_MODES, DEEPSEEK_HARNESS_DIRECT_APPROVAL_POLICIES,
} from '../../../tools/ralph-external/lib/deepseek-harness-adapter.mjs';

const adapter = new DeepSeekHarnessDirectAdapter();
const registry = () => loadProviderModelCapabilities().providers['deepseek-harness'].workerHealthAdapter!;
const input = (inferenceProvider = 'deepseek') => ({ brief: 'offline task', cwd: '/tmp/project',
  selected: { inferenceProvider, model: inferenceProvider === 'openrouter' ? 'deepseek/deepseek-v4.1-flash' : 'deepseek-flash',
    effort: { value: 'low' } }, permissions: { sandbox: 'read-only', approval: 'never' } });
const patchConfig = (text: string) => Object.fromEntries(parse(text).map((row: any) => [row.id, row.config]));

// dsh's built-in preset table from the issue's 0.2.2-rc.1 contract. A custom
// default must exist, avoid reserved names, and match the composed defaults.
const builtin = { 'read-only': { sandbox: 'read-only', approval: 'ask' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' } };

describe('T-OG-15 DeepSeek Harness permission and OpenRouter route (#4313)', () => {
  for (const sandbox of DEEPSEEK_HARNESS_DIRECT_SANDBOX_MODES) {
    for (const approval of DEEPSEEK_HARNESS_DIRECT_APPROVAL_POLICIES) {
      it(`activates a matching named permission preset for ${sandbox}/${approval}`, () => {
        const config = patchConfig(buildDeepSeekHarnessPatch({ model: 'deepseek-flash', effort: 'low', sandbox, approval }));
        const permission = config.permission;
        expect(permission).toBeDefined();
        expect(['auto', 'custom']).not.toContain(permission.defaultPreset);
        const presets = { ...builtin, ...permission.presets };
        expect(presets[permission.defaultPreset]).toEqual({ sandbox: config['sandbox-policy'].mode,
          approval: config.approval.policy });
      });
    }
  }

  it('keeps the official route and its key as the default', () => {
    const invocation = input();
    const patch = patchConfig(adapter.buildWorkerArtifacts(invocation)[0].content);
    expect(patch['agent-default-model'].provider).toBe('deepseek-official');
    expect(patch['llm-pi-ai']).toBeUndefined();
    const profile = registry().invocationProfiles!['direct-shell'];
    expect(profile.envAllowlist).toEqual(['DEEPSEEK_API_KEY', 'PATH']);
    expect(adapter.buildWorkerArgs(invocation, profile, invocation.permissions)).toEqual([
      '--profile', 'headless', '--patch', '${artifact:dsh-patch}', '--json', '-']);
  });

  it('renders OpenRouter through the installed transport with only the selected route key', () => {
    const metadata = registry();
    const profile = metadata.invocationProfiles!['direct-shell-openrouter'];
    expect(profile).toBeDefined();
    expect(profile.envAllowlist).toEqual(['OPENROUTER_API_KEY', 'PATH']);
    expect(metadata.invocation.envAllowlist).toContain('OPENROUTER_API_KEY');
    const invocation = input('openrouter');
    const transport = buildInstalledWorkerTransport(adapter, invocation, profile, metadata.invocation,
      '/tmp/dsh', { PATH: '/usr/bin', OPENROUTER_API_KEY: 'synthetic-placeholder' });
    expect(transport.envNames).toEqual(['PATH', 'OPENROUTER_API_KEY']);
    expect(transport.argv).toEqual(['/tmp/dsh', '--profile', 'headless', '--patch', '${artifact:dsh-patch}', '--json', '-']);
    const patch = patchConfig(transport.artifacts[0].content);
    expect(patch['agent-default-model']).toEqual({ provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', reasoningEffort: 'low' });
    expect(patch['llm-pi-ai']).toEqual({ providers: { openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY' } } });
    expect(JSON.stringify(transport)).not.toContain('synthetic-placeholder');
    expect(profile.controls.model.support).toBe('unqualified');
    expect(metadata.qualification.status).toBe('unqualified');
  });

  it('rejects unknown inference routes and mismatched route profiles before rendering', () => {
    const official = registry().invocationProfiles!['direct-shell'];
    expect(() => adapter.buildWorkerArgs(input('unknown'), official, input().permissions)).toThrow(/provider/);
    expect(() => adapter.buildWorkerArgs(input('openrouter'), official, input().permissions)).toThrow(/profile/);
  });

  it('supports the standalone OpenRouter patch without changing default callers', () => {
    const selection = { model: 'deepseek/deepseek-v4.1-flash', effort: 'low', sandbox: 'read-only', approval: 'never' };
    expect(patchConfig(buildDeepSeekHarnessPatch({ ...selection, inferenceProvider: 'openrouter' }))['agent-default-model'].provider)
      .toBe('openrouter');
    expect(() => buildDeepSeekHarnessPatch({ ...selection, inferenceProvider: 'auto' })).toThrow(/provider/);
  });
});
