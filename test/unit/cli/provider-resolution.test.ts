import { describe, expect, it, vi } from 'vitest';

const mockReadAiwgConfig = vi.hoisted(() => vi.fn());

vi.mock('../../../src/config/aiwg-config.js', () => ({
  readAiwgConfig: mockReadAiwgConfig,
}));

import {
  resolveActiveProvider,
  commandLooksLikeProvider,
  capabilityProviderId,
  normalizeProviderId,
  isSessionProviderResolution,
} from '../../../src/cli/provider-resolution.js';

describe('normalizeProviderId', () => {
  it('resolves provider aliases from ProviderDefinition data', () => {
    expect(normalizeProviderId('claude-code')).toBe('claude');
    expect(normalizeProviderId('openai')).toBe('codex');
    expect(normalizeProviderId('tinyhumansai')).toBe('openhuman');
    expect(normalizeProviderId('devin')).toBe('devin');
    expect(normalizeProviderId('devin-desktop')).toBe('devin');
    expect(normalizeProviderId('devin-local')).toBe('devin');
    expect(normalizeProviderId('cascade')).toBe('devin');
    expect(normalizeProviderId('pi-coding-agent')).toBe('pi');
  });

  it('returns null for unknown provider ids', () => {
    expect(normalizeProviderId('missing-provider')).toBeNull();
    expect(normalizeProviderId('')).toBeNull();
    expect(normalizeProviderId(null)).toBeNull();
  });
});

describe('capabilityProviderId', () => {
  it('uses ProviderDefinition capability ids while preserving unknown strings', () => {
    expect(capabilityProviderId('claude')).toBe('claude-code');
    expect(capabilityProviderId('openai')).toBe('codex');
    expect(capabilityProviderId('codex')).toBe('codex');
    expect(capabilityProviderId('unknown-provider')).toBe('unknown-provider');
    expect(capabilityProviderId(null)).toBeNull();
  });
});

describe('commandLooksLikeProvider (process-tree branch)', () => {
  // Process-tree detection parity for the home-dir global operators. Env-marker
  // detection (OPENHUMAN_HOME / OPENHUMAN_CORE_TOKEN) resolves OpenHuman first,
  // but this gives full parity with the other 8 providers when markers are
  // absent and only the ancestor command name is available (handoff nit).
  it('resolves openhuman from an openhuman-named ancestor command', () => {
    expect(
      commandLooksLikeProvider('/home/u/.local/opt/openhuman/OpenHuman_0.57.39_amd64.AppImage --ozone-platform=x11'),
    ).toBe('openhuman');
  });

  it('keeps openclaw distinct from openhuman (no "open*" cross-match)', () => {
    expect(commandLooksLikeProvider('/usr/bin/openclaw serve')).toBe('openclaw');
    expect(commandLooksLikeProvider('/usr/bin/opencode')).toBe('opencode');
  });

  it('returns null for a non-provider command', () => {
    expect(commandLooksLikeProvider('/usr/bin/bash -c "echo hi"')).toBeNull();
  });

  it('detects Pi only from an exact pi command marker', () => {
    expect(commandLooksLikeProvider('/usr/local/bin/pi --mode rpc')).toBe('pi');
    expect(commandLooksLikeProvider('/usr/bin/pico README.md')).toBeNull();
    expect(commandLooksLikeProvider('/work/happi/bin/server')).toBeNull();
  });
});

describe('resolveActiveProvider', () => {
  it('detects runtime env markers from ProviderDefinition data', async () => {
    const resolution = await resolveActiveProvider({
      cwd: '/mock/project',
      env: { OPENHUMAN_HOME: '/tmp/openhuman-home' },
      detectProcess: false,
    });

    expect(resolution.provider).toBe('openhuman');
    expect(resolution.source).toBe('runtime-env');
    expect(resolution.reason).toBe('runtime environment marker');
  });

  it('detects Codex from process ancestry when Codex env markers are absent', async () => {
    mockReadAiwgConfig.mockResolvedValue({
      version: '1',
      providers: ['claude', 'codex'],
      installed: {},
      scripts: {},
    });

    const resolution = await resolveActiveProvider({
      cwd: '/mock/project',
      env: { AIWG_TEST_PROCESS_PROVIDER: 'codex' },
      detectProcess: true,
    });

    expect(resolution.provider).toBe('codex');
    expect(resolution.source).toBe('process');
  });

  it('returns ambiguous instead of selecting the first configured provider in mixed workspaces', async () => {
    mockReadAiwgConfig.mockResolvedValue({
      version: '1',
      providers: ['claude', 'codex'],
      installed: {},
      scripts: {},
    });

    const resolution = await resolveActiveProvider({
      cwd: '/mock/project',
      env: { AIWG_DISABLE_PROCESS_PROVIDER_DETECTION: '1' },
      detectProcess: true,
    });

    expect(resolution.provider).toBeNull();
    expect(resolution.source).toBe('ambiguous');
    expect(resolution.candidates).toEqual(['claude', 'codex']);
  });
});

describe('isSessionProviderResolution', () => {
  it('accepts only signals from the running session', () => {
    for (const source of ['explicit', 'env', 'runtime-env', 'process']) {
      expect(isSessionProviderResolution({ provider: 'claude', source })).toBe(true);
    }
  });

  it('rejects project state: a project configured or deployed for a provider is not a session inside it', () => {
    for (const source of ['config', 'deployment', 'default', 'ambiguous']) {
      expect(isSessionProviderResolution({ provider: 'claude', source })).toBe(false);
    }
    expect(isSessionProviderResolution({ provider: null, source: 'runtime-env' })).toBe(false);
  });
});
