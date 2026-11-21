/**
 * Unit tests for sdlc-accelerate.ts handler
 *
 * @issue #691
 * @parent #684
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HandlerContext } from '../../../../src/cli/handlers/types.js';

// ── Mocks ────────────────────────────────────────────────────

const {
  mockSpawnOn,
  mockSpawn,
  mockParseAgentSpawnFlags,
  mockBuildAgentArgs,
  mockGetProviderConfig,
  mockIsSpawnableProvider,
  mockDangerousWarning,
  mockSpawnableProviders,
} = vi.hoisted(() => {
  const mockSpawnOn = vi.fn();
  return {
    mockSpawnOn,
    mockSpawn: vi.fn(() => ({ on: mockSpawnOn })),
    mockParseAgentSpawnFlags: vi.fn((args: string[]) => ({ opts: {}, remaining: args })),
    mockBuildAgentArgs: vi.fn((prompt: string) => ['--print', prompt]),
    mockGetProviderConfig: vi.fn((provider: string) => ({
      name: provider,
      binary: provider === 'claude' ? 'claude' : provider,
      guidanceMessage: undefined,
    })),
    mockIsSpawnableProvider: vi.fn((provider: string) => !['copilot', 'cursor', 'warp', 'devin'].includes(provider)),
    mockDangerousWarning: vi.fn(() => null),
    mockSpawnableProviders: vi.fn(() => ['claude', 'factory', 'opencode', 'codex']),
  };
});

vi.mock('child_process', () => ({
  spawn: mockSpawn,
}));

vi.mock('../../../../src/cli/agent-spawn.js', () => ({
  parseAgentSpawnFlags: mockParseAgentSpawnFlags,
  buildAgentArgs: mockBuildAgentArgs,
  getProviderConfig: mockGetProviderConfig,
  isSpawnableProvider: mockIsSpawnableProvider,
  dangerousWarning: mockDangerousWarning,
  spawnableProviders: mockSpawnableProviders,
}));

import { sdlcAccelerateHandler } from '../../../../src/cli/handlers/sdlc-accelerate.js';

// ── Helpers ───────────────────────────────────────────────────

function makeCtx(args: string[] = []): HandlerContext {
  return {
    args,
    rawArgs: ['sdlc-accelerate', ...args],
    cwd: '/mock/cwd',
    frameworkRoot: '/mock/framework/root',
  };
}

function spawnExitsWith(code: number | null): void {
  mockSpawnOn.mockImplementation((event: string, cb: (code: number | null) => void) => {
    if (event === 'close') cb(code);
  });
}

// ── Tests ─────────────────────────────────────────────────────

describe('sdlcAccelerateHandler metadata', () => {
  it('has correct id and category', () => {
    expect(sdlcAccelerateHandler.id).toBe('sdlc-accelerate');
    expect(sdlcAccelerateHandler.category).toBe('orchestration');
    expect(typeof sdlcAccelerateHandler.execute).toBe('function');
  });
});

describe('sdlcAccelerateHandler.execute — help flag', () => {
  beforeEach(() => { vi.clearAllMocks(); mockParseAgentSpawnFlags.mockReturnValue({ opts: {}, remaining: ['--help'] }); });

  it('--help exits 0 and returns help text', async () => {
    const result = await sdlcAccelerateHandler.execute(makeCtx(['--help']));
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('SDLC Accelerate');
  });
});

describe('sdlcAccelerateHandler.execute — IDE-integrated providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsSpawnableProvider.mockReturnValue(false);
    mockGetProviderConfig.mockReturnValue({
      name: 'copilot',
      binary: undefined,
      guidanceMessage: 'Use Copilot panel',
    });
    mockParseAgentSpawnFlags.mockReturnValue({ opts: { provider: 'copilot' }, remaining: [] });
  });

  it('prints guidance for non-spawnable provider and exits 0', async () => {
    const result = await sdlcAccelerateHandler.execute(makeCtx(['--provider', 'copilot']));
    expect(result.exitCode).toBe(0);
    expect(result.message).toBeDefined();
    expect(result.message).toContain('not spawnable');
  });
});

describe('sdlcAccelerateHandler.execute — spawnable provider (claude)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsSpawnableProvider.mockReturnValue(true);
    mockGetProviderConfig.mockReturnValue({ name: 'claude', binary: 'claude', guidanceMessage: undefined });
    mockParseAgentSpawnFlags.mockReturnValue({ opts: { provider: 'claude' }, remaining: ['My project'] });
    mockDangerousWarning.mockReturnValue(null);
  });

  it('spawns the agent binary with correct args', async () => {
    spawnExitsWith(0);
    const result = await sdlcAccelerateHandler.execute(makeCtx(['My project']));
    expect(mockSpawn).toHaveBeenCalledWith('claude', expect.any(Array), expect.objectContaining({ stdio: 'inherit' }));
    expect(result.exitCode).toBe(0);
  });

  it('returns exit code from spawned process', async () => {
    spawnExitsWith(1);
    const result = await sdlcAccelerateHandler.execute(makeCtx(['My project']));
    expect(result.exitCode).toBe(1);
  });

  it('null close code treated as 0', async () => {
    spawnExitsWith(null);
    const result = await sdlcAccelerateHandler.execute(makeCtx([]));
    expect(result.exitCode).toBe(0);
  });

  it('ENOENT from spawn returns exit 1 with helpful message', async () => {
    const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockSpawnOn.mockImplementation((event: string, cb: (arg: Error | number | null) => void) => {
      if (event === 'error') cb(enoentError);
    });
    const result = await sdlcAccelerateHandler.execute(makeCtx(['My project']));
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('not found');
  });
});

describe('sdlcAccelerateHandler.execute — --dangerous flag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsSpawnableProvider.mockReturnValue(true);
    mockGetProviderConfig.mockReturnValue({ name: 'claude', binary: 'claude' });
    mockParseAgentSpawnFlags.mockReturnValue({ opts: { provider: 'claude', dangerous: true }, remaining: [] });
    mockDangerousWarning.mockReturnValue(null);
  });

  it('spawns when dangerous supported and exits 0', async () => {
    spawnExitsWith(0);
    const result = await sdlcAccelerateHandler.execute(makeCtx(['--dangerous']));
    expect(result.exitCode).toBe(0);
  });

  it('warns when provider does not support --dangerous', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockDangerousWarning.mockReturnValue('This provider does not support --dangerous');
    spawnExitsWith(0);
    await sdlcAccelerateHandler.execute(makeCtx(['--dangerous']));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Warning'));
    consoleSpy.mockRestore();
  });
});

describe('sdlcAccelerateHandler.execute — prompt construction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsSpawnableProvider.mockReturnValue(true);
    mockGetProviderConfig.mockReturnValue({ name: 'claude', binary: 'claude' });
    mockDangerousWarning.mockReturnValue(null);
  });

  it('builds /sdlc-accelerate <description> prompt from positional arg', async () => {
    mockParseAgentSpawnFlags.mockReturnValue({ opts: {}, remaining: ['Customer portal'] });
    spawnExitsWith(0);
    await sdlcAccelerateHandler.execute(makeCtx(['Customer portal']));
    const buildCall = mockBuildAgentArgs.mock.calls[0][0];
    expect(buildCall).toContain('/sdlc-accelerate');
    expect(buildCall).toContain('Customer portal');
  });

  it('passes --from-codebase flag in prompt', async () => {
    mockParseAgentSpawnFlags.mockReturnValue({ opts: {}, remaining: ['--from-codebase', '.'] });
    spawnExitsWith(0);
    await sdlcAccelerateHandler.execute(makeCtx(['--from-codebase', '.']));
    const buildCall = mockBuildAgentArgs.mock.calls[0][0];
    expect(buildCall).toContain('--from-codebase');
  });
});
