// Check the shared Factory renderer contract without launching a worker CLI.
import { describe, expect, it } from 'vitest';
import { FactoryAdapter } from '../../../tools/ralph-external/lib/factory-adapter.mjs';
import { assertOperatorWorkerNativeArgv, loadProviderModelCapabilities,
  WORKER_OPERATOR_APPROVAL } from '../../../src/models/provider-policy.js';

const adapter = new FactoryAdapter();
const metadata = structuredClone(loadProviderModelCapabilities().providers.factory.workerHealthAdapter!);
metadata.qualification = { status: 'qualified', evidenceRef: WORKER_OPERATOR_APPROVAL,
  fixtureDigest: `sha256:${'1'.repeat(64)}`, verifiedAt: '2026-11-10T00:00:00Z' };
const custom = { model: 'custom:Synthetic', effort: { support: 'not-applicable', value: null } };
const builtin = { model: 'synthetic-model', effort: { support: 'explicit', value: 'high' } };
const invocation = (selected: unknown) => ({ selected, cwd: '/synthetic/work', brief: 'Synthetic brief' });
const tail = ['--cwd', '/synthetic/work', '--output-format', 'stream-json'];

describe('Factory custom-model effort rendering', () => {
  it.each(['read-only', 'workspace-write'] as const)('omits effort only for a custom model with no effort support (%s)', sandbox => {
    const args = adapter.buildWorkerArgs(invocation(custom), {}, { sandbox });
    expect(args).toEqual(['exec', ...(sandbox === 'workspace-write' ? ['--auto', 'low'] : []),
      '-m', custom.model, ...tail]);
    expect(args).not.toContain('-r');
    expect(() => assertOperatorWorkerNativeArgv(metadata, ['droid', ...args], custom, { sandbox })).not.toThrow();
  });

  it.each([builtin, { ...builtin, model: custom.model },
    { model: custom.model, effort: { support: 'not-applicable', value: 'low' } }])(
    'preserves explicit effort for %j', selected => {
      const args = adapter.buildWorkerArgs(invocation(selected), {}, {});
      expect(args).toEqual(['exec', '--auto', 'low', '-m', selected.model, '-r', selected.effort.value, ...tail]);
      expect(() => assertOperatorWorkerNativeArgv(metadata, ['droid', ...args], selected)).not.toThrow();
    });

  it.each([
    { model: custom.model },
    { model: custom.model, effort: {} },
    { model: custom.model, effort: { support: 'explicit', value: null } },
    { model: custom.model, effort: { support: 'unknown', value: null } },
    { model: custom.model, effort: { support: 'not-applicable', value: 'invalid' } },
    { model: builtin.model, effort: { support: 'not-applicable', value: null } },
    { model: builtin.model, effort: { support: 'explicit', value: 'invalid' } },
  ])('rejects absent or invalid effort without the custom-model exception: %j', selected => {
    expect(() => adapter.buildWorkerArgs(invocation(selected), {}, {})).toThrow('explicit qualified reasoning effort');
  });
});

describe('Factory native argv validation', () => {
  const argv = ['droid', 'exec', '-m', custom.model, ...tail];
  it.each([{ sandbox: 'external' }, { sandbox: 'read-only', approval: 'ask' }])(
    'rejects unsupported direct permissions %j', permissions => {
      expect(() => assertOperatorWorkerNativeArgv(metadata, argv, custom, permissions))
        .toThrow('Factory direct worker requires native sandbox and never approval');
    });

  it.each([
    ['missing cwd', argv.filter(value => value !== '--cwd' && value !== '/synthetic/work')],
    ['missing cwd value', [...argv.slice(0, 4), '--output-format', 'stream-json', '--cwd']],
    ['relative cwd', argv.map(value => value === '/synthetic/work' ? 'relative' : value)],
    ['NUL in cwd', argv.map(value => value === '/synthetic/work' ? '/synthetic/\0work' : value)],
  ])('rejects %s', (_label, args) => {
    expect(() => assertOperatorWorkerNativeArgv(metadata, args, custom, { sandbox: 'read-only' }))
      .toThrow('Factory direct worker requires an absolute workspace');
  });

  it('rejects built-in effort omission even if its argv otherwise matches', () => {
    const selected = { ...builtin, effort: { value: null } };
    expect(() => assertOperatorWorkerNativeArgv(metadata, ['droid', 'exec', '-m', builtin.model, ...tail],
      selected, { sandbox: 'read-only' })).toThrow('Factory built-in models require explicit effort');
  });

  it('rejects reordered controls with the correct length and pairs', () => {
    expect(() => assertOperatorWorkerNativeArgv(metadata,
      ['droid', 'exec', ...tail, '-m', custom.model], custom, { sandbox: 'read-only' }))
      .toThrow('Factory native worker controls could be overridden');
  });
});
