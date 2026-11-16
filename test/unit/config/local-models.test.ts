// Validate local endpoint declarations offline through the owning config API (T-OG-03/12).
import { describe, expect, it } from 'vitest';
import { resolveWorkerGroupInstallation, validateParallelismConfig,
  type ParallelismConfig } from '../../../src/config/aiwg-config.js';

function config(): ParallelismConfig {
  return { worker_dispatch: true, clis: { local: {
    adapter: 'providers:codex', accountScope: 'fixture-account', quotaScope: 'fixture-quota',
    localModels: { endpoint: 'http://127.0.0.1:1234/v1', authEnv: 'SYNTHETIC_MODEL_TOKEN',
      models: [{ id: 'fixture-model', checkpoint: 'fixture-q4-r1', family: 'fixture',
        contextTokens: 32000, maxOutputTokens: 4096, efforts: ['medium'] }] },
  } } };
}

describe('local model declaration validation (T-OG-03/12)', () => {
  it.each([
    'http://127.0.0.1:1234/v1', 'https://localhost/v1', 'http://[::1]:1234/v1',
    'https://models.fixture.invalid/v1',
  ])('accepts a valid declaration at %s without probing or resolving auth', endpoint => {
    const value = config();
    Object.assign(value.clis!.local.localModels!, { endpoint, allowedHosts: ['models.fixture.invalid'] });
    expect(validateParallelismConfig(value)).toEqual([]);
  });

  it('accepts an installation without a local source', () => {
    const value = config();
    delete value.clis!.local.localModels;
    expect(validateParallelismConfig(value)).toEqual([]);
  });

  it.each([
    'http://models.fixture.invalid/v1', 'http://user@localhost/v1',
    'http://:fixture-password@localhost/v1', 'http://localhost/v1?token=fixture',
    'http://localhost/v1#fragment',
  ])('rejects an unsafe endpoint %s with the declaration diagnostic', endpoint => {
    const value = config();
    value.clis!.local.localModels!.endpoint = endpoint;
    expect(validateParallelismConfig(value)).toEqual([
      'OG_CONFIG_REFERENCE /parallelism/clis/local/localModels/endpoint: Requires a credential-free HTTP endpoint on loopback or allowedHosts',
    ]);
  });

  it.each([
    { endpoint: 'not a URL' }, { endpoint: 'file:///tmp/fixture' }, { endpoint: '' },
    { allowedHosts: [''] }, { allowedHosts: [123] }, { allowedHosts: ['host', 'host'] },
    { authEnv: '' }, { authEnv: 'INVALID-NAME' }, { authEnv: '1INVALID' }, { authEnv: 123 },
    { timeoutMs: 0 }, { timeoutMs: 30001 }, { timeoutMs: 1.5 },
    { models: [] }, { models: [{}] }, { models: [{ id: 'fixture-model' }] },
    { models: [{ id: '', checkpoint: 'fixture' }] },
    { models: [{ id: 'fixture', checkpoint: '' }] },
    { models: [{ id: 'fixture', checkpoint: 'q4', family: '' }] },
    { models: [{ id: 'fixture', checkpoint: 'q4', contextTokens: 0 }] },
    { models: [{ id: 'fixture', checkpoint: 'q4', maxOutputTokens: 0 }] },
    { models: [{ id: 'fixture', checkpoint: 'q4', efforts: [] }] },
    { models: [{ id: 'fixture', checkpoint: 'q4', efforts: [''] }] },
    { models: [{ id: 'fixture', checkpoint: 'q4', efforts: ['low', 'low'] }] },
    { models: [{ id: 'fixture', checkpoint: 'q4', extra: true }] },
    { extra: true },
  ])('rejects malformed local source entries %j', patch => {
    const value = config();
    Object.assign(value.clis!.local.localModels!, patch);
    const errors = validateParallelismConfig(value);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every(error => error.startsWith('OG_CONFIG_REFERENCE /parallelism/clis/local/localModels'))).toBe(true);
  });

  it('rejects duplicate model IDs even when checkpoints differ', () => {
    const value = config();
    value.clis!.local.localModels!.models.push({ id: 'fixture-model', checkpoint: 'other-revision' });
    expect(validateParallelismConfig(value)).toEqual([
      'OG_CONFIG_REFERENCE /parallelism/clis/local/localModels/models: Duplicate model ID',
    ]);
  });

  it('validates disabled declarations and refuses their selection or required role coverage', () => {
    const value = config();
    value.clis!.local.enabled = false;
    expect(validateParallelismConfig(value)).toEqual([]);
    expect(() => resolveWorkerGroupInstallation(value, 'local')).toThrow('Installation is disabled');
    value.groups = { workers: { members: [{ id: 'writer', cli: 'local', model: 'fixture-model', roles: ['coding'] }],
      requiredRoles: ['coding'] } };
    expect(validateParallelismConfig(value)).toEqual([
      'OG_CONFIG_REFERENCE /parallelism/groups/workers/requiredRoles: No enabled member covers coding',
    ]);
    delete value.groups;
    value.clis!.local.localModels!.endpoint = 'http://unlisted.fixture.invalid/v1';
    expect(validateParallelismConfig(value)[0]).toContain('/clis/local/localModels/endpoint:');
  });
});
