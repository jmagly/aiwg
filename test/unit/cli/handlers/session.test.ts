/**
 * Unit tests for session.ts handler
 *
 * @issue #885
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from '../../../helpers/temp-dir.js';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import type { HandlerContext } from '../../../../src/cli/handlers/types.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

const {
  mockSpawn,
  mockSpawnSync,
  mockExistsSync,
  mockForceUpdateCheck,
  mockUpdateInstallation,
  mockReadAiwgConfig,
  mockGetDeploymentSummary,
  mockGetProviderConfig,
  mockIsSpawnableProvider,
  mockGetFrameworkRoot,
  mockUseExecute,
  mockResolveServers,
  mockResolveProfile,
  mockCredentialPolicy,
  mockCredentialPolicyFloor,
  mockCredentialPolicyFloorSource,
  mockEnsureRuntimeHome,
  mockWriteProfileConfig,
  mockLaunchWithProfile,
  mockIsInteractive,
  writeFileSyncCalls,
} = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockSpawnSync: vi.fn(),
  mockExistsSync: vi.fn(),
  mockForceUpdateCheck: vi.fn().mockResolvedValue(undefined),
  mockUpdateInstallation: vi.fn().mockResolvedValue({ status: 'updated' }),
  mockReadAiwgConfig: vi.fn().mockResolvedValue(null),
  mockGetDeploymentSummary: vi.fn().mockReturnValue({ agents: 1, commands: 1, skills: 1, rules: 1 }),
  mockGetProviderConfig: vi.fn().mockReturnValue({
    name: 'Claude Code',
    binary: 'claude',
    guidanceMessage: null,
  }),
  mockIsSpawnableProvider: vi.fn().mockReturnValue(true),
  mockGetFrameworkRoot: vi.fn().mockResolvedValue('/mock/framework/root'),
  mockUseExecute: vi.fn().mockResolvedValue({ exitCode: 0 }),
  mockResolveServers: vi.fn(),
  mockResolveProfile: vi.fn(),
  mockCredentialPolicy: vi.fn(),
  mockCredentialPolicyFloor: vi.fn().mockResolvedValue(undefined),
  mockCredentialPolicyFloorSource: vi.fn().mockResolvedValue(undefined),
  mockEnsureRuntimeHome: vi.fn(),
  mockWriteProfileConfig: vi.fn(),
  mockLaunchWithProfile: vi.fn(),
  // Defaults to an attached terminal (#3062) so pre-existing tests that
  // exercise pre-flight/launch logic unrelated to headlessness keep their
  // original behavior. The dedicated headless/no-terminal describe block
  // below overrides this per test.
  mockIsInteractive: vi.fn().mockReturnValue(true),
  writeFileSyncCalls: [] as Array<{ path: string; options: unknown }>,
}));

vi.mock('../../../../src/mcp/profiles.js', () => ({
  McpProfileRegistry: class { resolveServers = mockResolveServers; resolve = mockResolveProfile; },
}));
vi.mock('../../../../src/mcp/registry.js', () => ({
  McpServerRegistry: class {
    getCredentialPolicy = mockCredentialPolicy;
    getCredentialPolicyFloor = mockCredentialPolicyFloor;
    getCredentialPolicyFloorSource = mockCredentialPolicyFloorSource;
  },
}));
vi.mock('../../../../src/mcp/adapters/codex-runtime.js', () => ({
  ensureRuntimeHome: mockEnsureRuntimeHome,
  writeProfileConfig: mockWriteProfileConfig,
  launchWithProfile: mockLaunchWithProfile,
}));

vi.mock('../../../../src/cli/env.js', () => ({
  isInteractive: mockIsInteractive,
}));

vi.mock('child_process', () => ({
  spawnSync: mockSpawnSync,
  spawn: mockSpawn,
}));

vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    existsSync: (path: import('node:fs').PathLike) => mockExistsSync(path) ?? original.existsSync(path),
    // Spy-through (#3062 second review, finding 10): records every call's
    // path/options so tests can assert the prompt file's mode/flag, then
    // still performs the real write so the rest of the code (including
    // its own cleanup) behaves exactly as in production.
    writeFileSync: (path: import('node:fs').PathOrFileDescriptor, data: unknown, options?: unknown) => {
      writeFileSyncCalls.push({ path: String(path), options });
      return original.writeFileSync(path as never, data as never, options as never);
    },
  };
});

vi.mock('../../../../src/update/checker.mjs', () => ({
  forceUpdateCheck: mockForceUpdateCheck,
}));

vi.mock('../../../../src/update/service.mjs', () => ({
  updateInstallation: mockUpdateInstallation,
}));

vi.mock('../../../../src/config/aiwg-config.js', () => ({
  readAiwgConfig: mockReadAiwgConfig,
  getDeploymentSummary: mockGetDeploymentSummary,
  VALID_PROVIDERS: ['claude', 'codex', 'openai', 'cursor', 'windsurf', 'copilot', 'opencode', 'factory', 'antigravity', 'warp', 'openclaw', 'hermes'],
}));

vi.mock('../../../../src/cli/agent-spawn.js', () => ({
  getProviderConfig: mockGetProviderConfig,
  isSpawnableProvider: mockIsSpawnableProvider,
  PROVIDER_CONFIGS: {
    claude: { name: 'Claude Code', binary: 'claude', guidanceMessage: null },
    codex: { name: 'Codex', binary: 'codex', guidanceMessage: null },
    cursor: { name: 'Cursor', binary: null, guidanceMessage: 'Open Cursor in your project.' },
  },
}));

vi.mock('../../../../src/channel/manager.mjs', () => ({
  getFrameworkRoot: mockGetFrameworkRoot,
}));

vi.mock('../../../../src/cli/handlers/use.js', () => ({
  useHandler: { execute: mockUseExecute },
}));

import { resolveProfileExtends } from '../../../../src/mcp/config-layers.mjs';
import { sessionHandler } from '../../../../src/cli/handlers/session.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCtx(args: string[] = []): HandlerContext {
  return {
    args,
    rawArgs: ['session', ...args],
    cwd: '/mock/cwd',
    frameworkRoot: '/mock/framework/root',
  };
}

/** Default doctor + sync return: both succeed */
function setupHappyPath(): void {
  mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
    // doctor call
    if (args?.includes('doctor')) return { status: 0 };
    // sync call
    if (args?.includes('sync')) return { status: 0 };
    // provider launch
    return { status: 0 };
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('sessionHandler Claude profile permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsInteractive.mockReturnValue(true);
    setupHappyPath();
    mockReadAiwgConfig.mockResolvedValue(null);
    mockGetProviderConfig.mockReturnValue({ name: 'Claude Code', binary: 'claude', guidanceMessage: null });
    mockIsSpawnableProvider.mockReturnValue(true);
    mockResolveServers.mockResolvedValue([{ name: 'git', type: 'stdio', command: 'git-mcp' }]);
    mockResolveProfile.mockResolvedValue({ providerOverrides: { claude: { toolDeny: ['git__delete'] } } });
    mockExistsSync.mockReturnValue(undefined);
  });

  it('launches with the generated MCP config and permission settings sidecar', async () => {
    mockExistsSync.mockImplementation(path => String(path).includes('aiwg-mcp-') ? true : undefined);
    mockSpawnSync.mockImplementation((_command, args) => {
      if (args?.includes('inject')) {
        const outputPath = args[args.indexOf('--out') + 1];
        return { status: 0, stdout: `  Tool permissions: ${outputPath.replace(/\.json$/, '.settings.json')}\n` };
      }
      return { status: 0 };
    });
    const result = await sessionHandler.execute(makeCtx(['--provider', 'claude', '--profile', 'safe', '--no-repair']));
    expect(result.exitCode).toBe(0);
    const injection = mockSpawnSync.mock.calls.find(([, args]) => args?.includes('inject'));
    const outputPath = injection![1][injection![1].indexOf('--out') + 1];
    expect(mockSpawnSync).toHaveBeenCalledWith('claude', [
      '--mcp-config', outputPath,
      '--settings', outputPath.replace(/\.json$/, '.settings.json'),
    ], expect.any(Object));
  });

  it('uses the settings path reported by injection even when it differs from the MCP filename', async () => {
    mockExistsSync.mockImplementation(path => path === '/generated/actual-permissions.json' ? true : undefined);
    mockSpawnSync.mockImplementation((_command, args) => ({
      status: 0,
      stdout: args?.includes('inject') ? '  Tool permissions: /generated/actual-permissions.json\n' : '',
    }));
    const result = await sessionHandler.execute(makeCtx(['--profile', 'safe', '--no-repair']));
    expect(result.exitCode).toBe(0);
    expect(mockSpawnSync).toHaveBeenCalledWith('claude', [
      '--mcp-config', expect.any(String), '--settings', '/generated/actual-permissions.json',
    ], expect.any(Object));
  });

  it.each([undefined, '  Tool permissions: /missing/settings.json\n'])(
    'refuses launch when expected permission settings are missing (stdout: %s)', async stdout => {
      mockSpawnSync.mockImplementation((_command, args) => ({
        status: 0, stdout: args?.includes('inject') ? stdout : '',
      }));
      const refusal = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const result = await sessionHandler.execute(makeCtx(['--profile', 'safe', '--no-repair']));
        expect(result.exitCode).toBe(1);
        expect(refusal).toHaveBeenCalledWith(expect.stringContaining('permission settings were not generated'));
        expect(mockSpawnSync.mock.calls.some(([command]) => command === 'claude')).toBe(false);
      } finally {
        refusal.mockRestore();
      }
    },
  );

  it('omits missing reported settings when the plan does not expect permission rules', async () => {
    mockResolveProfile.mockResolvedValue({});
    mockSpawnSync.mockImplementation((_command, args) => ({
      status: 0, stdout: args?.includes('inject') ? '  Tool permissions: /missing/settings.json\n' : '',
    }));
    const result = await sessionHandler.execute(makeCtx(['--profile', 'unfiltered', '--no-repair']));
    expect(result.exitCode).toBe(0);
    const launch = mockSpawnSync.mock.calls.find(([command]) => command === 'claude');
    expect(launch![1]).toEqual(['--mcp-config', expect.any(String)]);
  });

  it('omits --settings when the profile has no Claude permission rules', async () => {
    mockResolveProfile.mockResolvedValue({});
    await sessionHandler.execute(makeCtx(['--profile', 'unfiltered', '--no-repair']));
    const launch = mockSpawnSync.mock.calls.find(([command]) => command === 'claude');
    expect(launch![1]).toEqual(['--mcp-config', expect.any(String)]);
  });

  it.each([false, true])('refuses Claude toolAllow before %s persistent injection or launch', async persist => {
    mockResolveProfile.mockResolvedValue({ providerOverrides: { claude: { toolAllow: ['git__list'] } } });
    const refusal = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const args = ['--profile', 'restricted', '--no-repair'];
      if (persist) args.push('--persist');
      const result = await sessionHandler.execute(makeCtx(args));
      expect(result.exitCode).toBe(1);
      expect(refusal.mock.calls.flat().join(' ')).toContain('git__list');
      expect(mockSpawnSync.mock.calls.some(([, spawnArgs]) => spawnArgs?.includes('inject'))).toBe(false);
      expect(mockSpawnSync.mock.calls.some(([command]) => command === 'claude')).toBe(false);
    } finally {
      refusal.mockRestore();
    }
  });

  it.each([false, true])('refuses Claude launch if %s persistent profile injection fails', async persist => {
    mockSpawnSync.mockImplementation((_command, args) => ({ status: args?.includes('inject') ? 1 : 0 }));
    const args = ['--profile', 'safe', '--no-repair'];
    if (persist) args.push('--persist');
    const result = await sessionHandler.execute(makeCtx(args));
    expect(result.exitCode).toBe(1);
    expect(mockSpawnSync.mock.calls.some(([command]) => command === 'claude')).toBe(false);
  });

  it('launches persistent Claude profiles using their persistent settings', async () => {
    const result = await sessionHandler.execute(makeCtx(['--profile', 'safe', '--persist', '--no-repair']));
    expect(result.exitCode).toBe(0);
    expect(mockSpawnSync).toHaveBeenCalledWith('claude', [], expect.any(Object));
    const injection = mockSpawnSync.mock.calls.find(([, args]) => args?.includes('inject'));
    expect(injection![1]).not.toContain('--ephemeral');
  });
});

describe('sessionHandler Codex profile credential policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsInteractive.mockReturnValue(true);
    setupHappyPath();
    mockGetProviderConfig.mockReturnValue({ name: 'Codex', binary: 'codex', guidanceMessage: null });
    mockIsSpawnableProvider.mockReturnValue(true);
    mockGetDeploymentSummary.mockReturnValue({ agents: 1, commands: 1, skills: 1, rules: 1 });
    mockCredentialPolicy.mockResolvedValue('references');
    mockResolveServers.mockResolvedValue([{ name: 'leaky', type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'session-secret' } }]);
    mockEnsureRuntimeHome.mockResolvedValue('/existing/runtime/with/old/config.toml');
    mockResolveProfile.mockResolvedValue({ providerOverrides: { codex: {
      toolAllow: ['safe__list'], toolDeny: ['safe__delete'],
    } } });
    mockWriteProfileConfig.mockResolvedValue([]);
    mockLaunchWithProfile.mockReturnValue({ status: 0 });
  });

  it.each(['codex', 'openai'])('refuses %s before setup or launch, even with an existing runtime', async provider => {
    const refusal = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await sessionHandler.execute(makeCtx(['--provider', provider, '--profile', 'test', '--no-repair']));
    expect(result.exitCode).toBe(1);
    expect(refusal).toHaveBeenCalledWith(expect.stringContaining('Refusing to render MCP servers'));
    expect(refusal.mock.calls.flat().join(' ')).not.toContain('session-secret');
    expect(mockEnsureRuntimeHome).not.toHaveBeenCalled();
    expect(mockWriteProfileConfig).not.toHaveBeenCalled();
    expect(mockLaunchWithProfile).not.toHaveBeenCalled();
    expect(mockSpawnSync.mock.calls.some(([command]) => command === 'codex')).toBe(false);
  });

  it('passes inherited denies from a resolved profile into Codex runtime rendering', async () => {
    mockResolveServers.mockResolvedValue([{ name: 'safe', type: 'stdio', command: 'safe' }]);
    mockResolveProfile.mockResolvedValue(resolveProfileExtends('test', {
      base: { servers: ['safe'], providerOverrides: { '*': { toolDeny: ['safe__delete'] } } },
      test: { servers: [], extends: ['base'], providerOverrides: {} },
    }));
    const result = await sessionHandler.execute(makeCtx(['--provider', 'codex', '--profile', 'test', '--no-repair']));
    expect(result.exitCode).toBe(0);
    expect(mockResolveProfile).toHaveBeenCalledWith('test');
    expect(mockWriteProfileConfig).toHaveBeenCalledWith('test', expect.any(Array), {
      credentialPolicy: 'references', toolFilters: { allow: [], deny: ['safe__delete'] },
    });
  });

  it('sets up and launches an allowed profile with tool filters', async () => {
    mockResolveServers.mockResolvedValue([{ name: 'safe', type: 'stdio', command: 'safe' }]);
    const result = await sessionHandler.execute(makeCtx(['--provider', 'codex', '--profile', 'test', '--no-repair']));
    expect(result.exitCode).toBe(0);
    expect(mockEnsureRuntimeHome).toHaveBeenCalledWith('test');
    expect(mockResolveProfile).toHaveBeenCalledWith('test');
    expect(mockWriteProfileConfig).toHaveBeenCalledWith('test', expect.any(Array), {
      credentialPolicy: 'references',
      toolFilters: { allow: ['safe__list'], deny: ['safe__delete'] },
    });
    // #3062 review item 12: the resolved `interactive` decision threads
    // through to `launchWithProfile` even with no prompt.
    expect(mockLaunchWithProfile).toHaveBeenCalledWith('test', [], { interactive: true });
  });

  it.each(['codex', 'openai'].flatMap(provider =>
    ['lookup', 'home', 'write'].map(stage => ({ provider, stage }))))(
    'refuses $provider launch after a $stage setup failure', async ({ provider, stage }) => {
      mockResolveServers.mockResolvedValue([{ name: 'safe', type: 'stdio', command: 'safe' }]);
      const failure = new Error('runtime setup failed');
      if (stage === 'lookup') mockResolveServers.mockRejectedValue(failure);
      if (stage === 'home') mockEnsureRuntimeHome.mockRejectedValue(failure);
      if (stage === 'write') mockWriteProfileConfig.mockRejectedValue(failure);
      const result = await sessionHandler.execute(makeCtx(['--provider', provider, '--profile', 'test', '--no-repair']));
      expect(result.exitCode).toBe(1);
      expect(mockLaunchWithProfile).not.toHaveBeenCalled();
      expect(mockSpawnSync.mock.calls.some(([command]) => command === 'codex')).toBe(false);
    });

  it.each(['codex', 'openai'])('checks policy for persistent %s profiles before injection or launch', async provider => {
    const result = await sessionHandler.execute(makeCtx(['--provider', provider, '--profile', 'test', '--persist', '--no-repair']));
    expect(result.exitCode).toBe(1);
    expect(mockLaunchWithProfile).not.toHaveBeenCalled();
    expect(mockSpawnSync.mock.calls.some(([, args]) => args?.includes('inject'))).toBe(false);
  });

  it.each([0, 1])('persistent Codex injection with status %s never reuses a runtime config', async status => {
    mockResolveServers.mockResolvedValue([{ name: 'safe', type: 'stdio', command: 'safe' }]);
    mockSpawnSync.mockImplementation((_command, args) => ({ status: args?.includes('inject') ? status : 0 }));
    const result = await sessionHandler.execute(makeCtx(['--provider', 'codex', '--profile', 'test', '--persist', '--no-repair']));
    expect(result.exitCode).toBe(status);
    expect(mockLaunchWithProfile).not.toHaveBeenCalled();
    expect(mockEnsureRuntimeHome).not.toHaveBeenCalled();
    expect(mockWriteProfileConfig).not.toHaveBeenCalled();
    expect(mockSpawnSync.mock.calls.some(([command]) => command === 'codex')).toBe(status === 0);
  });

});

describe('sessionHandler metadata', () => {
  it('has correct id, category, and description', () => {
    expect(sessionHandler.id).toBe('session');
    expect(sessionHandler.category).toBe('project');
    expect(sessionHandler.description).toMatch(/session/i);
    expect(sessionHandler.aliases).toEqual([]);
    expect(typeof sessionHandler.execute).toBe('function');
  });
});

describe('sessionHandler.execute — provider resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsInteractive.mockReturnValue(true);
    setupHappyPath();
    mockGetProviderConfig.mockReturnValue({ name: 'Claude Code', binary: 'claude', guidanceMessage: null });
    mockIsSpawnableProvider.mockReturnValue(true);
    mockGetDeploymentSummary.mockReturnValue({ agents: 1, commands: 1, skills: 1, rules: 1 });
    mockForceUpdateCheck.mockResolvedValue(undefined);
  });

  it('defaults to claude when no flag and no config', async () => {
    mockReadAiwgConfig.mockResolvedValue(null);
    await sessionHandler.execute(makeCtx([]));
    // PROVIDER_CONFIGS['claude'] should be used
    expect(mockGetProviderConfig).toHaveBeenCalledWith('claude');
  });

  it('respects --provider flag', async () => {
    mockGetProviderConfig.mockReturnValue({ name: 'Codex', binary: 'codex', guidanceMessage: null });
    await sessionHandler.execute(makeCtx(['--provider', 'codex']));
    expect(mockGetProviderConfig).toHaveBeenCalledWith('codex');
  });

  it('uses project config providers[0] when no flag', async () => {
    mockReadAiwgConfig.mockResolvedValue({
      providers: ['opencode'],
      installed: {},
    });
    mockGetProviderConfig.mockReturnValue({ name: 'OpenCode', binary: 'opencode', guidanceMessage: null });
    await sessionHandler.execute(makeCtx([]));
    expect(mockGetProviderConfig).toHaveBeenCalledWith('opencode');
  });

  it('fails closed for an unknown --provider value', async () => {
    await expect(sessionHandler.execute(makeCtx(['--provider', 'doesnotexist'])))
      .rejects.toThrow("Unsupported provider 'doesnotexist'");
    expect(mockGetProviderConfig).not.toHaveBeenCalled();
  });
});

describe('sessionHandler.execute — arg parsing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsInteractive.mockReturnValue(true);
    setupHappyPath();
    mockGetProviderConfig.mockReturnValue({ name: 'Claude Code', binary: 'claude', guidanceMessage: null });
    mockIsSpawnableProvider.mockReturnValue(true);
    mockGetDeploymentSummary.mockReturnValue({ agents: 1, commands: 1, skills: 1, rules: 1 });
    mockForceUpdateCheck.mockResolvedValue(undefined);
    mockReadAiwgConfig.mockResolvedValue(null);
  });

  it('detects mcp subcommand', async () => {
    // With mcp subcommand, injectMcp should be called (via spawnSync with 'mcp inject')
    await sessionHandler.execute(makeCtx(['mcp']));
    const calls = mockSpawnSync.mock.calls.map((c: unknown[]) => c[1]);
    const mcpCall = calls.find((args: unknown) =>
      Array.isArray(args) && args.includes('mcp') && args.includes('inject'),
    );
    expect(mcpCall).toBeDefined();
  });

  it('does not inject MCP without mcp subcommand', async () => {
    await sessionHandler.execute(makeCtx([]));
    const calls = mockSpawnSync.mock.calls.map((c: unknown[]) => c[1]);
    const mcpCall = calls.find((args: unknown) =>
      Array.isArray(args) && args.includes('inject'),
    );
    expect(mcpCall).toBeUndefined();
  });

  it('parses --no-repair flag', async () => {
    // With --no-repair, version check and auto-repair should be skipped
    await sessionHandler.execute(makeCtx(['--no-repair']));
    // forceUpdateCheck should NOT be called when --no-repair is set
    expect(mockForceUpdateCheck).not.toHaveBeenCalled();
  });
});

describe('sessionHandler.execute — version check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsInteractive.mockReturnValue(true);
    setupHappyPath();
    mockGetProviderConfig.mockReturnValue({ name: 'Claude Code', binary: 'claude', guidanceMessage: null });
    mockIsSpawnableProvider.mockReturnValue(true);
    mockGetDeploymentSummary.mockReturnValue({ agents: 1, commands: 1, skills: 1, rules: 1 });
    mockReadAiwgConfig.mockResolvedValue(null);
  });

  it('calls forceUpdateCheck during normal run', async () => {
    mockForceUpdateCheck.mockResolvedValue(undefined);
    await sessionHandler.execute(makeCtx([]));
    expect(mockForceUpdateCheck).toHaveBeenCalled();
  });

  it('skips forceUpdateCheck when --no-repair is passed', async () => {
    await sessionHandler.execute(makeCtx(['--no-repair']));
    expect(mockForceUpdateCheck).not.toHaveBeenCalled();
  });

  it('uses the canonical update service when forceUpdateCheck throws', async () => {
    mockForceUpdateCheck.mockRejectedValue(new Error('network error'));
    await sessionHandler.execute(makeCtx([]));
    expect(mockUpdateInstallation).toHaveBeenCalled();
    expect(mockSpawnSync.mock.calls.some((c: unknown[]) => c[0] === 'npm')).toBe(false);
  });
});

describe('sessionHandler.execute — doctor and repair', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsInteractive.mockReturnValue(true);
    mockGetProviderConfig.mockReturnValue({ name: 'Claude Code', binary: 'claude', guidanceMessage: null });
    mockIsSpawnableProvider.mockReturnValue(true);
    mockGetDeploymentSummary.mockReturnValue({ agents: 1, commands: 1, skills: 1, rules: 1 });
    mockForceUpdateCheck.mockResolvedValue(undefined);
    mockReadAiwgConfig.mockResolvedValue(null);
  });

  it('runs doctor as part of pre-flight', async () => {
    mockSpawnSync.mockReturnValue({ status: 0 });
    await sessionHandler.execute(makeCtx([]));
    const doctorCall = mockSpawnSync.mock.calls.find(
      (c: unknown[]) => Array.isArray(c[1]) && c[1].includes('doctor'),
    );
    expect(doctorCall).toBeDefined();
  });

  it('attempts repair when doctor fails', async () => {
    mockSpawnSync.mockImplementation((_cmd: string, args: string[]) => {
      if (Array.isArray(args) && args.includes('doctor')) return { status: 1 };
      return { status: 0 };
    });
    mockReadAiwgConfig.mockResolvedValue({ providers: ['claude'], installed: { 'sdlc-complete': {} } });

    await sessionHandler.execute(makeCtx([]));

    // sync should be attempted as repair strategy
    const syncCall = mockSpawnSync.mock.calls.find(
      (c: unknown[]) => Array.isArray(c[1]) && c[1].includes('sync'),
    );
    expect(syncCall).toBeDefined();
  });

  it('does not bypass a failed canonical sync with npm from PATH', async () => {
    let doctorCallCount = 0;
    mockSpawnSync.mockImplementation((_cmd: string, args: string[]) => {
      if (Array.isArray(args) && args.includes('doctor')) {
        doctorCallCount++;
        return { status: 1 }; // always fails
      }
      if (Array.isArray(args) && args.includes('sync')) return { status: 0 };
      return { status: 0 };
    });
    mockReadAiwgConfig.mockResolvedValue({ providers: ['claude'], installed: {} });

    await sessionHandler.execute(makeCtx([]));

    expect(mockSpawnSync.mock.calls.some((c: unknown[]) => c[0] === 'npm')).toBe(false);
  });

  it('warns but continues when --no-repair and doctor fails', async () => {
    mockSpawnSync.mockImplementation((_cmd: string, args: string[]) => {
      if (Array.isArray(args) && args.includes('doctor')) return { status: 1 };
      return { status: 0 };
    });
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await sessionHandler.execute(makeCtx(['--no-repair']));

    // Should not attempt sync repair
    const syncCall = mockSpawnSync.mock.calls.find(
      (c: unknown[]) => Array.isArray(c[1]) && c[1].includes('sync'),
    );
    expect(syncCall).toBeUndefined();
    warnSpy.mockRestore();
  });
});

describe('sessionHandler.execute — deployment check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsInteractive.mockReturnValue(true);
    mockGetProviderConfig.mockReturnValue({ name: 'Claude Code', binary: 'claude', guidanceMessage: null });
    mockIsSpawnableProvider.mockReturnValue(true);
    mockForceUpdateCheck.mockResolvedValue(undefined);
    mockSpawnSync.mockReturnValue({ status: 0 });
  });

  it('redeploys frameworks when deployment summary is zero', async () => {
    mockReadAiwgConfig.mockResolvedValue({
      providers: ['claude'],
      installed: { 'sdlc-complete': {}, 'aiwg-utils': {} },
    });
    mockGetDeploymentSummary.mockReturnValue({ agents: 0, commands: 0, skills: 0, rules: 0 });

    await sessionHandler.execute(makeCtx([]));

    expect(mockUseExecute).toHaveBeenCalled();
  });

  it('skips redeployment when deployment summary is non-zero', async () => {
    mockReadAiwgConfig.mockResolvedValue({
      providers: ['claude'],
      installed: { 'sdlc-complete': {} },
    });
    mockGetDeploymentSummary.mockReturnValue({ agents: 5, commands: 3, skills: 2, rules: 8 });

    await sessionHandler.execute(makeCtx([]));

    expect(mockUseExecute).not.toHaveBeenCalled();
  });

  it('skips deployment check when no frameworks are installed', async () => {
    mockReadAiwgConfig.mockResolvedValue({
      providers: ['claude'],
      installed: {},
    });

    await sessionHandler.execute(makeCtx([]));

    expect(mockUseExecute).not.toHaveBeenCalled();
  });
});

describe('sessionHandler.execute — launch behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsInteractive.mockReturnValue(true);
    mockForceUpdateCheck.mockResolvedValue(undefined);
    mockReadAiwgConfig.mockResolvedValue(null);
    mockGetDeploymentSummary.mockReturnValue({ agents: 1, commands: 1, skills: 1, rules: 1 });
    mockSpawnSync.mockReturnValue({ status: 0 });
  });

  // #3062 second review, finding 4: `aiwg session` historically let a
  // *later* repeated flag win (a hand-rolled loop that kept overwriting
  // on every match); the first-round shared parser silently flipped that
  // to first-wins. This restores and locks in the original precedence.
  it('--provider repeated resolves to the last occurrence (restored pre-#3062 precedence)', async () => {
    mockGetProviderConfig.mockReturnValue({ name: 'Codex', binary: 'codex', guidanceMessage: null });
    await sessionHandler.execute(makeCtx(['--provider', 'claude', '--provider', 'codex']));
    expect(mockGetProviderConfig).toHaveBeenCalledWith('codex');
  });

  it('spawns provider binary for spawnable providers', async () => {
    mockGetProviderConfig.mockReturnValue({ name: 'Claude Code', binary: 'claude', guidanceMessage: null });
    mockIsSpawnableProvider.mockReturnValue(true);

    const result = await sessionHandler.execute(makeCtx([]));

    const launchCall = mockSpawnSync.mock.calls.find(
      (c: unknown[]) => c[0] === 'claude',
    );
    expect(launchCall).toBeDefined();
    expect(result.exitCode).toBe(0);
  });

  it('prints guidance for non-spawnable (IDE) providers', async () => {
    mockGetProviderConfig.mockReturnValue({
      name: 'Cursor',
      binary: null,
      guidanceMessage: 'Open Cursor in your project directory.',
    });
    mockIsSpawnableProvider.mockReturnValue(false);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await sessionHandler.execute(makeCtx(['--provider', 'cursor']));

    expect(result.exitCode).toBe(0);
    // Should have printed guidance, not launched binary
    const launchCalls = mockSpawnSync.mock.calls.filter(
      (c: unknown[]) => c[0] === 'cursor',
    );
    expect(launchCalls).toHaveLength(0);
    logSpy.mockRestore();
  });

  it('forwards provider binary exit code', async () => {
    mockGetProviderConfig.mockReturnValue({ name: 'Claude Code', binary: 'claude', guidanceMessage: null });
    mockIsSpawnableProvider.mockReturnValue(true);
    mockSpawnSync.mockImplementation((cmd: string) => {
      if (cmd === 'claude') return { status: 42 };
      return { status: 0 };
    });

    const result = await sessionHandler.execute(makeCtx([]));
    expect(result.exitCode).toBe(42);
  });

  it('returns a non-zero exit code (never 0) when provider launch returns null status (#3062 review item 7)', async () => {
    mockGetProviderConfig.mockReturnValue({ name: 'Claude Code', binary: 'claude', guidanceMessage: null });
    mockIsSpawnableProvider.mockReturnValue(true);
    mockSpawnSync.mockImplementation((cmd: string) => {
      if (cmd === 'claude') return { status: null };
      return { status: 0 };
    });

    const result = await sessionHandler.execute(makeCtx([]));
    expect(result.exitCode).not.toBe(0);
  });

  it('reports the bounded helper error and exits non-zero on a killed/timed-out headless run (#3062 review item 7)', async () => {
    mockGetProviderConfig.mockReturnValue({ name: 'Claude Code', binary: 'claude', guidanceMessage: null });
    mockIsSpawnableProvider.mockReturnValue(true);
    mockIsInteractive.mockReturnValue(false);
    mockSpawnSync.mockImplementation((cmd: string) => {
      if (cmd === 'claude') {
        return {
          status: null,
          signal: 'SIGKILL',
          error: Object.assign(new Error("`claude --print --input-format text` exceeded the 'long' tier bound of 600000ms and was killed (SIGKILL)."), { code: 'ETIMEDOUT' }),
        };
      }
      return { status: 0 };
    });

    const result = await sessionHandler.execute(makeCtx(['--prompt', 'hi']));
    expect(result.exitCode).not.toBe(0);
    expect(result.message).toMatch(/exceeded the 'long' tier bound/);
  });
});

describe('sessionHandler.execute — headless prompt (#3062)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyPath();
    mockGetProviderConfig.mockReturnValue({ name: 'Claude Code', binary: 'claude', guidanceMessage: null });
    mockIsSpawnableProvider.mockReturnValue(true);
    mockGetDeploymentSummary.mockReturnValue({ agents: 1, commands: 1, skills: 1, rules: 1 });
    mockForceUpdateCheck.mockResolvedValue(undefined);
    mockReadAiwgConfig.mockResolvedValue(null);
    writeFileSyncCalls.length = 0;
  });

  it('refuses a spawnable provider with no terminal and no prompt, spawning nothing', async () => {
    mockIsInteractive.mockReturnValue(false);
    const result = await sessionHandler.execute(makeCtx([]));
    expect(result.exitCode).not.toBe(0);
    expect(result.message).toMatch(/--prompt/);
    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(mockForceUpdateCheck).not.toHaveBeenCalled();
  });

  it('runs headless (bounded, prompt on stdin — never argv) when --prompt is given with no terminal', async () => {
    mockIsInteractive.mockReturnValue(false);
    const result = await sessionHandler.execute(makeCtx(['--prompt', 'hello there']));
    expect(result.exitCode).toBe(0);
    const launch = mockSpawnSync.mock.calls.find(([command]) => command === 'claude');
    expect(launch).toBeDefined();
    // #3062 review item 8: claude's headless form is `--print --input-format
    // text`, with the prompt fed over stdin — it never appears on argv.
    expect(launch![1]).toEqual(['--print', '--input-format', 'text']);
    expect(launch![1]).not.toContain('hello there');
    expect(launch![2]).toMatchObject({
      timeout: expect.any(Number),
      stdio: ['pipe', 'inherit', 'inherit'],
      input: 'hello there',
    });
  });

  it('runs headless when --prompt is given even with a terminal attached (#3062 rule 4)', async () => {
    mockIsInteractive.mockReturnValue(true);
    const result = await sessionHandler.execute(makeCtx(['--prompt', 'hi']));
    expect(result.exitCode).toBe(0);
    const launch = mockSpawnSync.mock.calls.find(([command]) => command === 'claude');
    expect(launch![1]).toEqual(['--print', '--input-format', 'text']);
    expect(launch![2]).toMatchObject({ input: 'hi' });
  });

  it('reads the prompt from --prompt-file, delivered over stdin', async () => {
    mockIsInteractive.mockReturnValue(false);
    const dir = mkdtempSync(join(tmpdir(), 'aiwg-session-prompt-'));
    const file = join(dir, 'prompt.txt');
    writeFileSync(file, '  file prompt text  \n');
    try {
      const result = await sessionHandler.execute(makeCtx(['--prompt-file', file]));
      expect(result.exitCode).toBe(0);
      const launch = mockSpawnSync.mock.calls.find(([command]) => command === 'claude');
      expect(launch![1]).toEqual(['--print', '--input-format', 'text']);
      expect(launch![2]).toMatchObject({ input: 'file prompt text' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([undefined, '/project-controlled-temp'])('opencode uses a private system temp file independently of TMPDIR=%s and cleans it after launch', async tmpOverride => {
    mockIsInteractive.mockReturnValue(false);
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    });
    mockGetProviderConfig.mockReturnValue({ name: 'OpenCode', binary: 'opencode', guidanceMessage: null });
    const oldTmpdir = process.env.TMPDIR;
    if (tmpOverride) process.env.TMPDIR = tmpOverride;
    let result;
    try { result = await sessionHandler.execute(makeCtx(['--provider', 'opencode', '--prompt', 'hello there'])); } finally {
      if (oldTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmpdir;
    }
    expect(result.exitCode).toBe(0);

    const launch = mockSpawn.mock.calls.find(([command]) => command === 'opencode');
    expect(launch).toBeDefined();
    expect(launch![1]).toEqual(
      expect.arrayContaining(['run', '--format', 'json', '-f', expect.stringContaining('prompt.txt'), 'Follow the instructions in the attached file exactly.']),
    );
    // The prompt text itself is never on argv — only the temp file path.
    expect(launch![1].join(' ')).not.toContain('hello there');

    // #3062 second review, finding 10: mkdtemp under the system temp
    // directory (never a custom location), file written with an explicit
    // 0600 mode via an exclusive create.
    const promptWrite = writeFileSyncCalls.find((call) => call.path.includes('prompt.txt'));
    expect(promptWrite).toBeDefined();
    expect(promptWrite!.options).toMatchObject({ mode: 0o600, flag: 'wx' });
    expect(promptWrite!.path.startsWith(process.platform === 'win32' ? join(process.env.SystemRoot!, 'Temp') : '/tmp/')).toBe(true);

    // Removed after the launch — every exit path cleans it up.
    const promptPath = (launch![1] as string[]).find((arg) => arg.includes('prompt.txt'))!;
    expect(existsSync(dirname(promptPath))).toBe(false);
  });

  it('cleans the prompt on SIGTERM before forwarding termination, then removes handlers', async () => {
    mockIsInteractive.mockReturnValue(false);
    mockGetProviderConfig.mockReturnValue({ name: 'OpenCode', binary: 'opencode', guidanceMessage: null });
    const listenerCount = process.listenerCount('SIGTERM');
    const kill = vi.fn();
    let promptPath: string;
    mockSpawn.mockImplementation((_command, args) => {
      promptPath = args.find((arg: string) => arg.includes('prompt.txt'));
      const child = Object.assign(new EventEmitter(), { pid: 12345, kill });
      queueMicrotask(() => { process.emit('SIGTERM'); child.emit('close', null, 'SIGKILL'); });
      return child;
    });
    const terminate = vi.spyOn(process, 'kill').mockImplementation(() => {
      expect(existsSync(promptPath)).toBe(false);
      return true;
    });
    try {
      const result = await sessionHandler.execute(makeCtx(['--provider', 'opencode', '--prompt', 'private text']));
      expect(result.exitCode).toBe(1);
      expect(kill).toHaveBeenCalledWith('SIGKILL');
      expect(terminate).toHaveBeenCalledWith(process.pid, 'SIGTERM');
      expect(process.listenerCount('SIGTERM')).toBe(listenerCount);
    } finally { terminate.mockRestore(); }
  });

  // Go/no-go review blocker 4: `args.includes('mcp')` matched the literal
  // word `mcp` anywhere in argv, including a free-text `--prompt`/
  // `--prompt-file` value or anything after a bare `--` terminator — see
  // `hasPositionalOrSwitch()`'s own doc comment (src/cli/flag-parsing.ts).
  it('a --prompt whose text is literally "mcp" does not trigger MCP injection', async () => {
    mockIsInteractive.mockReturnValue(false);
    const result = await sessionHandler.execute(makeCtx(['--prompt', 'mcp']));
    expect(result.exitCode).toBe(0);
    const launch = mockSpawnSync.mock.calls.find(([command]) => command === 'claude');
    expect(launch![2]).toMatchObject({ input: 'mcp' });
    const mcpInjectCall = mockSpawnSync.mock.calls.find(
      ([, args]) => Array.isArray(args) && args.includes('mcp') && args.includes('inject'),
    );
    expect(mcpInjectCall).toBeUndefined();
  });

  // Confirmatory, not itself a regression pin: `mcp`/`persist`/etc. are
  // decided from argv in `parseSessionArgs()` before the prompt file is
  // even read, so the file's *content* was never reachable from
  // `args.includes(...)` in the first place, old code or new. Kept to
  // pin that this stays true as the implementation evolves.
  it('a --prompt-file whose entire content is "mcp" does not trigger MCP injection', async () => {
    mockIsInteractive.mockReturnValue(false);
    const dir = mkdtempSync(join(tmpdir(), 'aiwg-session-prompt-'));
    const file = join(dir, 'prompt.txt');
    writeFileSync(file, 'mcp\n');
    try {
      const result = await sessionHandler.execute(makeCtx(['--prompt-file', file]));
      expect(result.exitCode).toBe(0);
      const launch = mockSpawnSync.mock.calls.find(([command]) => command === 'claude');
      expect(launch![2]).toMatchObject({ input: 'mcp' });
      const mcpInjectCall = mockSpawnSync.mock.calls.find(
        ([, args]) => Array.isArray(args) && args.includes('mcp') && args.includes('inject'),
      );
      expect(mcpInjectCall).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--persist after a bare -- terminator is positional data, not honored as a flag', async () => {
    mockIsInteractive.mockReturnValue(false);
    mockResolveServers.mockResolvedValue([{ name: 'git', type: 'stdio', command: 'git-mcp' }]);
    mockResolveProfile.mockResolvedValue({ providerOverrides: {} });
    // `persist`'s one observable effect is whether the self-invoked `mcp
    // inject` call carries `--ephemeral`: present when NOT persisting
    // (the normal, correct outcome here, since `--persist` is after `--`),
    // absent when persisting (the bug this pins against).
    const result = await sessionHandler.execute(makeCtx(['--profile', 'safe', '--prompt', 'hello', '--', '--persist']));
    expect(result.exitCode).toBe(0);
    const injection = mockSpawnSync.mock.calls.find(([, args]) => Array.isArray(args) && args.includes('inject'));
    expect(injection).toBeDefined();
    expect(injection![1]).toContain('--ephemeral');
  });

  it('the legitimate positional "mcp" subcommand still triggers MCP injection alongside --prompt', async () => {
    mockIsInteractive.mockReturnValue(false);
    const result = await sessionHandler.execute(makeCtx(['mcp', '--prompt', 'hello there']));
    expect(result.exitCode).toBe(0);
    const mcpInjectCall = mockSpawnSync.mock.calls.find(
      ([, args]) => Array.isArray(args) && args.includes('mcp') && args.includes('inject'),
    );
    expect(mcpInjectCall).toBeDefined();
  });

  it('rejects --prompt and --prompt-file together, spawning nothing', async () => {
    const result = await sessionHandler.execute(makeCtx(['--prompt', 'a', '--prompt-file', '/tmp/aiwg-3062-unused']));
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/only one of/);
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('errors for a missing --prompt-file without spawning anything', async () => {
    mockIsInteractive.mockReturnValue(false);
    const result = await sessionHandler.execute(makeCtx(['--prompt-file', '/does/not/exist-aiwg-3062.txt']));
    expect(result.exitCode).toBe(1);
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('refuses a spawnable provider with no evidenced headless CLI form, before any pre-flight step (review items 9 and 6b)', async () => {
    // antigravity (review item 9): genuinely spawnable (binary: 'agy') but
    // absent from HEADLESS_SESSION_TRANSPORTS — unlike the fictional
    // "spawnable Factory" this test used to mock, which masked the real
    // bug below (Factory's actual config has binary: null).
    mockGetProviderConfig.mockReturnValue({ name: 'Google Antigravity CLI', binary: 'agy', guidanceMessage: null });
    const result = await sessionHandler.execute(makeCtx(['--provider', 'antigravity', '--prompt', 'hi']));
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/no evidenced non-interactive/);
    // #3062 second review, finding 6: checked before any pre-flight step
    // runs — not just before the eventual `agy` launch attempt.
    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(mockForceUpdateCheck).not.toHaveBeenCalled();
  });

  it('refuses an unsupported (non-spawnable) provider given --prompt, naming the provider, before any pre-flight spawn (review item 9)', async () => {
    mockIsSpawnableProvider.mockReturnValue(false);
    mockGetProviderConfig.mockReturnValue({
      name: 'Factory AI',
      binary: null,
      guidanceMessage: 'Factory AI is cloud-based and cannot be spawned from the CLI.',
    });
    const result = await sessionHandler.execute(makeCtx(['--provider', 'factory', '--prompt', 'do the thing']));
    expect(result.exitCode).not.toBe(0);
    expect(result.message).toMatch(/Factory AI/);
    expect(result.message).toMatch(/no CLI binary to spawn/);
    // Validated before any pre-flight step — nothing was spawned at all,
    // not even the version-check/doctor self-invocations.
    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(mockForceUpdateCheck).not.toHaveBeenCalled();
  });

  it('never requires a prompt for an IDE-integrated (non-spawnable) provider', async () => {
    mockIsInteractive.mockReturnValue(false);
    mockIsSpawnableProvider.mockReturnValue(false);
    mockGetProviderConfig.mockReturnValue({ name: 'Cursor', binary: null, guidanceMessage: 'Open Cursor in your project.' });
    const result = await sessionHandler.execute(makeCtx(['--provider', 'cursor']));
    expect(result.exitCode).toBe(0);
  });

  it('maps codex exec with a profile through launchWithProfile', async () => {
    mockIsInteractive.mockReturnValue(false);
    mockGetProviderConfig.mockReturnValue({ name: 'Codex', binary: 'codex', guidanceMessage: null });
    mockLaunchWithProfile.mockReturnValue({ status: 0 });
    mockResolveServers.mockResolvedValue([]);
    mockResolveProfile.mockResolvedValue({});
    mockCredentialPolicy.mockResolvedValue('references');
    mockWriteProfileConfig.mockResolvedValue([]);
    const result = await sessionHandler.execute(
      makeCtx(['--provider', 'codex', '--profile', 'test', '--prompt', 'do the thing', '--no-repair']),
    );
    expect(result.exitCode).toBe(0);
    // #3062 review item 8: the prompt travels on stdin via the `-`
    // positional, never on argv.
    expect(mockLaunchWithProfile).toHaveBeenCalledWith('test', ['exec', '-'], { input: 'do the thing', interactive: false });
  });
});

describe('sessionHandler.execute — MCP injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsInteractive.mockReturnValue(true);
    mockGetProviderConfig.mockReturnValue({ name: 'Claude Code', binary: 'claude', guidanceMessage: null });
    mockIsSpawnableProvider.mockReturnValue(true);
    mockGetDeploymentSummary.mockReturnValue({ agents: 1, commands: 1, skills: 1, rules: 1 });
    mockForceUpdateCheck.mockResolvedValue(undefined);
    mockReadAiwgConfig.mockResolvedValue(null);
    mockSpawnSync.mockReturnValue({ status: 0 });
  });

  it('injects MCP when mcp subcommand present', async () => {
    await sessionHandler.execute(makeCtx(['mcp']));
    const injectCall = mockSpawnSync.mock.calls.find(
      (c: unknown[]) => Array.isArray(c[1]) && c[1].includes('inject'),
    );
    expect(injectCall).toBeDefined();
  });

  it('passes --provider to mcp inject', async () => {
    mockGetProviderConfig.mockReturnValue({ name: 'Codex', binary: 'codex', guidanceMessage: null });
    await sessionHandler.execute(makeCtx(['mcp', '--provider', 'codex']));
    const injectCall = mockSpawnSync.mock.calls.find(
      (c: unknown[]) => Array.isArray(c[1]) && c[1].includes('inject'),
    );
    expect(injectCall).toBeDefined();
    expect(injectCall![1]).toContain('codex');
  });

  it('warns but continues when mcp inject fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSpawnSync.mockImplementation((_cmd: string, args: string[]) => {
      if (Array.isArray(args) && args.includes('inject')) return { status: 1 };
      return { status: 0 };
    });

    const result = await sessionHandler.execute(makeCtx(['mcp']));
    expect(result.exitCode).toBe(0); // still exits 0 from provider launch
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('MCP inject'));
    warnSpy.mockRestore();
  });
});
