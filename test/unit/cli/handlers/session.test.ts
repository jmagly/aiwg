/**
 * Unit tests for session.ts handler
 *
 * @issue #885
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HandlerContext } from '../../../../src/cli/handlers/types.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

const {
  mockSpawnSync,
  mockForceUpdateCheck,
  mockUpdateInstallation,
  mockReadAiwgConfig,
  mockGetDeploymentSummary,
  mockGetProviderConfig,
  mockIsSpawnableProvider,
  mockGetFrameworkRoot,
  mockUseExecute,
  mockResolveServers,
  mockCredentialPolicy,
  mockEnsureRuntimeHome,
  mockWriteProfileConfig,
  mockLaunchWithProfile,
} = vi.hoisted(() => ({
  mockSpawnSync: vi.fn(),
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
  mockCredentialPolicy: vi.fn(),
  mockEnsureRuntimeHome: vi.fn(),
  mockWriteProfileConfig: vi.fn(),
  mockLaunchWithProfile: vi.fn(),
}));

vi.mock('../../../../src/mcp/profiles.js', () => ({
  McpProfileRegistry: class { resolveServers = mockResolveServers; },
}));
vi.mock('../../../../src/mcp/registry.js', () => ({
  McpServerRegistry: class { getCredentialPolicy = mockCredentialPolicy; },
}));
vi.mock('../../../../src/mcp/adapters/codex-runtime.js', () => ({
  ensureRuntimeHome: mockEnsureRuntimeHome,
  writeProfileConfig: mockWriteProfileConfig,
  launchWithProfile: mockLaunchWithProfile,
}));

vi.mock('child_process', () => ({
  spawnSync: mockSpawnSync,
}));

vi.mock('../../../../src/update/checker.mjs', () => ({
  forceUpdateCheck: mockForceUpdateCheck,
}));

vi.mock('../../../../src/update/service.mjs', () => ({
  updateInstallation: mockUpdateInstallation,
}));

vi.mock('../../../../src/config/aiwg-config.js', () => ({
  readAiwgConfig: mockReadAiwgConfig,
  getDeploymentSummary: mockGetDeploymentSummary,
  VALID_PROVIDERS: ['claude', 'codex', 'openai', 'cursor', 'windsurf', 'copilot', 'opencode', 'factory', 'warp', 'openclaw', 'hermes'],
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

describe('sessionHandler Codex profile credential policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyPath();
    mockGetProviderConfig.mockReturnValue({ name: 'Codex', binary: 'codex', guidanceMessage: null });
    mockIsSpawnableProvider.mockReturnValue(true);
    mockGetDeploymentSummary.mockReturnValue({ agents: 1, commands: 1, skills: 1, rules: 1 });
    mockCredentialPolicy.mockResolvedValue('references');
    mockResolveServers.mockResolvedValue([{ name: 'leaky', type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'session-secret' } }]);
    mockEnsureRuntimeHome.mockResolvedValue('/existing/runtime/with/old/config.toml');
    mockWriteProfileConfig.mockResolvedValue(undefined);
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

  it('sets up and launches an allowed profile', async () => {
    mockResolveServers.mockResolvedValue([{ name: 'safe', type: 'stdio', command: 'safe' }]);
    const result = await sessionHandler.execute(makeCtx(['--provider', 'codex', '--profile', 'test', '--no-repair']));
    expect(result.exitCode).toBe(0);
    expect(mockEnsureRuntimeHome).toHaveBeenCalledWith('test');
    expect(mockWriteProfileConfig).toHaveBeenCalledWith('test', expect.any(Array), { credentialPolicy: 'references' });
    expect(mockLaunchWithProfile).toHaveBeenCalledWith('test');
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
    mockForceUpdateCheck.mockResolvedValue(undefined);
    mockReadAiwgConfig.mockResolvedValue(null);
    mockGetDeploymentSummary.mockReturnValue({ agents: 1, commands: 1, skills: 1, rules: 1 });
    mockSpawnSync.mockReturnValue({ status: 0 });
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

  it('returns exit code 0 when provider launch returns null status', async () => {
    mockGetProviderConfig.mockReturnValue({ name: 'Claude Code', binary: 'claude', guidanceMessage: null });
    mockIsSpawnableProvider.mockReturnValue(true);
    mockSpawnSync.mockImplementation((cmd: string) => {
      if (cmd === 'claude') return { status: null };
      return { status: 0 };
    });

    const result = await sessionHandler.execute(makeCtx([]));
    expect(result.exitCode).toBe(0);
  });
});

describe('sessionHandler.execute — MCP injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
