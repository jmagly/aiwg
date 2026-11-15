/**
 * Tests for Runtime Info Command Handler
 *
 * Unit tests for runtime environment discovery and tool catalog management.
 *
 * @source @src/cli/handlers/runtime-info.ts
 * @implements @docs/architecture/cli/adr-001-unified-extension-registry.md
 * @issue #33
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { HandlerContext, HandlerResult } from '../../../../src/cli/handlers/types.js';

// Mock RuntimeDiscovery
const mockDiscovery = {
  discover: vi.fn(),
  verify: vi.fn(),
  checkTool: vi.fn(),
  getSummary: vi.fn(),
  basePath: '/mock/.aiwg/smiths/toolsmith',
};

vi.mock('../../../../src/smiths/toolsmith/runtime-discovery.mjs', () => ({
  RuntimeDiscovery: vi.fn(function RuntimeDiscoveryMock() {
    return mockDiscovery;
  }),
}));

describe('Runtime Info Command Handler', () => {
  let mockContext: HandlerContext;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Mock handler context
    mockContext = {
      args: [],
      rawArgs: ['runtime-info'],
      cwd: '/mock/project',
      frameworkRoot: '/mock/framework/root',
    };

    // Default mock implementations
    mockDiscovery.discover.mockResolvedValue({
      tools: [
        { id: 'git', name: 'Git', category: 'core' },
        { id: 'node', name: 'Node.js', category: 'languages' },
      ],
      unavailable: [
        { id: 'docker', name: 'Docker' },
      ],
    });

    mockDiscovery.verify.mockResolvedValue({
      total: 2,
      valid: 2,
      failed: [],
    });

    mockDiscovery.checkTool.mockResolvedValue({
      available: true,
      version: '2.42.0',
      path: '/usr/bin/git',
      lastVerified: '2026-01-22T10:00:00Z',
    });

    mockDiscovery.getSummary.mockResolvedValue({
      environment: {
        os: 'Linux',
        osVersion: '6.14.0-37-generic',
        arch: 'x64',
        shell: '/bin/bash',
      },
      resources: {
        memoryAvailableGb: 16.5,
        memoryTotalGb: 32.0,
        diskFreeGb: 250.5,
        cpuCores: 8,
      },
      toolCounts: {
        core: 5,
        languages: 3,
        utilities: 7,
        custom: 2,
      },
      totalTools: 17,
      lastDiscovery: '2026-01-22T09:00:00Z',
      catalogPath: '/mock/.aiwg/smiths/toolsmith/runtime.json',
    });
  });

  describe('handler metadata', () => {
    it('should have correct metadata', async () => {
      const { runtimeInfoHandler } = await import('../../../../src/cli/handlers/runtime-info.js');

      expect(runtimeInfoHandler.id).toBe('runtime-info');
      expect(runtimeInfoHandler.name).toBe('Runtime Info');
      expect(runtimeInfoHandler.description.toLowerCase()).toContain('runtime environment');
      expect(runtimeInfoHandler.category).toBe('toolsmith');
      expect(runtimeInfoHandler.aliases).toEqual([]);
    });
  });

  describe('--discover flag', () => {
    it('passes --force through to discovery', async () => {
      const { runtimeInfoHandler } = await import('../../../../src/cli/handlers/runtime-info.js');
      mockContext.args = ['--discover', '--force', '--json'];
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const result = await runtimeInfoHandler.execute(mockContext);
      expect(result.exitCode).toBe(0);
      expect(mockDiscovery.discover).toHaveBeenCalledWith({ force: true });
      consoleSpy.mockRestore();
    });
    it('should perform full discovery and display results', async () => {
      const { runtimeInfoHandler } = await import('../../../../src/cli/handlers/runtime-info.js');

      mockContext.args = ['--discover'];

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await runtimeInfoHandler.execute(mockContext);

      expect(mockDiscovery.discover).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith('\nDiscovery complete!');
      expect(consoleSpy).toHaveBeenCalledWith('Discovered 2 tools');
      expect(consoleSpy).toHaveBeenCalledWith('Unavailable: 1');
      expect(result.exitCode).toBe(0);

      consoleSpy.mockRestore();
    });

    it('should output JSON when --json flag is present', async () => {
      const { runtimeInfoHandler } = await import('../../../../src/cli/handlers/runtime-info.js');

      mockContext.args = ['--discover', '--json'];

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await runtimeInfoHandler.execute(mockContext);

      expect(mockDiscovery.discover).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('"tools"')
      );
      expect(result.exitCode).toBe(0);

      consoleSpy.mockRestore();
    });
  });

  describe('--verify flag', () => {
    it('should verify existing catalog and display results', async () => {
      const { runtimeInfoHandler } = await import('../../../../src/cli/handlers/runtime-info.js');

      mockContext.args = ['--verify'];

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await runtimeInfoHandler.execute(mockContext);

      expect(mockDiscovery.verify).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith('\nVerification complete!');
      expect(consoleSpy).toHaveBeenCalledWith('Valid: 2/2');
      expect(result.exitCode).toBe(0);

      consoleSpy.mockRestore();
    });

    it('should display failed tools when verification finds issues', async () => {
      const { runtimeInfoHandler } = await import('../../../../src/cli/handlers/runtime-info.js');

      mockDiscovery.verify.mockResolvedValue({
        total: 3,
        valid: 2,
        failed: [
          { id: 'python', name: 'Python' },
        ],
      });

      mockContext.args = ['--verify'];

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await runtimeInfoHandler.execute(mockContext);

      expect(mockDiscovery.verify).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith('Valid: 2/3');
      expect(consoleSpy).toHaveBeenCalledWith('\nFailed tools:');
      expect(consoleSpy).toHaveBeenCalledWith('  - Python (python)');
      expect(result.exitCode).toBe(0);

      consoleSpy.mockRestore();
    });

    it('should output JSON when --json flag is present', async () => {
      const { runtimeInfoHandler } = await import('../../../../src/cli/handlers/runtime-info.js');

      mockContext.args = ['--verify', '--json'];

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await runtimeInfoHandler.execute(mockContext);

      expect(mockDiscovery.verify).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('"total"')
      );
      expect(result.exitCode).toBe(0);

      consoleSpy.mockRestore();
    });
  });

  describe('--check flag', () => {
    it('should check specific tool availability', async () => {
      const { runtimeInfoHandler } = await import('../../../../src/cli/handlers/runtime-info.js');

      mockContext.args = ['--check', 'git'];

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await runtimeInfoHandler.execute(mockContext);

      expect(mockDiscovery.checkTool).toHaveBeenCalledWith('git');
      expect(consoleSpy).toHaveBeenCalledWith('\nTool: git');
      expect(consoleSpy).toHaveBeenCalledWith('Status: Available');
      expect(consoleSpy).toHaveBeenCalledWith('Version: 2.42.0');
      expect(consoleSpy).toHaveBeenCalledWith('Path: /usr/bin/git');
      expect(result.exitCode).toBe(0);

      consoleSpy.mockRestore();
    });

    it('should handle unavailable tools', async () => {
      const { runtimeInfoHandler } = await import('../../../../src/cli/handlers/runtime-info.js');

      mockDiscovery.checkTool.mockResolvedValue({
        available: false,
        installHint: 'apt-get install docker.io',
      });

      mockContext.args = ['--check', 'docker'];

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await runtimeInfoHandler.execute(mockContext);

      expect(mockDiscovery.checkTool).toHaveBeenCalledWith('docker');
      expect(consoleSpy).toHaveBeenCalledWith('\nTool: docker');
      expect(consoleSpy).toHaveBeenCalledWith('Status: Not Available');
      expect(consoleSpy).toHaveBeenCalledWith('Install: apt-get install docker.io');
      expect(result.exitCode).toBe(0);

      consoleSpy.mockRestore();
    });

    it('should require tool name argument', async () => {
      const { runtimeInfoHandler } = await import('../../../../src/cli/handlers/runtime-info.js');

      mockContext.args = ['--check'];

      const result = await runtimeInfoHandler.execute(mockContext);

      // AiwgError.exitCode now propagates (#922 migration). USAGE_MISSING_VALUE
      // → exit 2. Message includes the hint appended after "— hint:".
      expect(result.exitCode).toBe(2);
      expect(result.message).toContain('--check requires a tool name');
      expect(result.message).toContain('hint:');
    });

    it('should output JSON when --json flag is present', async () => {
      const { runtimeInfoHandler } = await import('../../../../src/cli/handlers/runtime-info.js');

      mockContext.args = ['--check', 'git', '--json'];

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await runtimeInfoHandler.execute(mockContext);

      expect(mockDiscovery.checkTool).toHaveBeenCalledWith('git');
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('"available"')
      );
      expect(result.exitCode).toBe(0);

      consoleSpy.mockRestore();
    });
  });

  describe('default behavior (summary)', () => {
    it('should display runtime environment summary', async () => {
      const { runtimeInfoHandler } = await import('../../../../src/cli/handlers/runtime-info.js');

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await runtimeInfoHandler.execute(mockContext);

      expect(mockDiscovery.getSummary).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith('\nRuntime Environment Summary');
      expect(consoleSpy).toHaveBeenCalledWith('===========================');
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('OS: Linux')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Shell: /bin/bash')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Memory: 16.5 GB available / 32 GB total')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Total: 17 verified tools')
      );
      expect(result.exitCode).toBe(0);

      consoleSpy.mockRestore();
    });

    it('should output JSON when --json flag is present', async () => {
      const { runtimeInfoHandler } = await import('../../../../src/cli/handlers/runtime-info.js');

      mockContext.args = ['--json'];

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await runtimeInfoHandler.execute(mockContext);

      expect(mockDiscovery.getSummary).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('"environment"')
      );
      expect(result.exitCode).toBe(0);

      consoleSpy.mockRestore();
    });

    it('should bootstrap a missing runtime catalog before displaying summary', async () => {
      const { runtimeInfoHandler } = await import('../../../../src/cli/handlers/runtime-info.js');

      mockDiscovery.getSummary
        .mockRejectedValueOnce(new Error('No catalog found. Run discovery first.'))
        .mockResolvedValueOnce({
          environment: {
            os: 'Linux',
            osVersion: '6.14.0-37-generic',
            arch: 'x64',
            shell: '/bin/bash',
          },
          resources: {
            memoryAvailableGb: 16.5,
            memoryTotalGb: 32.0,
            diskFreeGb: 250.5,
            cpuCores: 8,
          },
          toolCounts: {
            core: 5,
            languages: 3,
            utilities: 7,
            custom: 2,
          },
          totalTools: 17,
          lastDiscovery: '2026-01-22T09:00:00Z',
          catalogPath: '/mock/.aiwg/smiths/toolsmith/runtime.json',
        });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await runtimeInfoHandler.execute(mockContext);

      expect(mockDiscovery.getSummary).toHaveBeenCalledTimes(2);
      expect(mockDiscovery.discover).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        '\nNo runtime catalog found; bootstrapping catalog...'
      );
      expect(consoleSpy).toHaveBeenCalledWith('\nRuntime Environment Summary');
      expect(result.exitCode).toBe(0);

      consoleSpy.mockRestore();
    });
  });

  it.each(['hermes', 'openhuman'])('reports indexed command access for %s in capability audits', async (provider) => {
    const { runtimeInfoHandler } = await import('../../../../src/cli/handlers/runtime-info.js');
    mockContext.args = ['--capabilities', '--provider', provider];
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await runtimeInfoHandler.execute(mockContext);
      expect(result.exitCode).toBe(0);
      expect(output.mock.calls.flat().join('\n')).toContain('commands: Indexed: aiwg discover / aiwg show command');
      if (provider === 'openhuman') {
        expect(output.mock.calls.flat().join('\n')).toContain('agents: Indexed: aiwg discover / aiwg show agent');
      }
    } finally {
      output.mockRestore();
    }
  });

  describe('scheduler backend detection (#2623 / #2627)', () => {
    // Shared provider detection reads both session markers and CODEX_HOME.
    // Clear inherited signals, including a Codex home exported by the host session,
    // so each fixture determines the active provider.
    const PROVIDER_ENV_KEYS = [
      'CLAUDE_CODE_VERSION', 'ANTHROPIC_API_KEY', 'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_DESKTOP_APP_VERSION', 'CODEX_HOME',
    ];
    const saved = new Map<string, string | undefined>();

    beforeEach(() => {
      for (const key of PROVIDER_ENV_KEYS) {
        saved.set(key, process.env[key]);
        delete process.env[key];
      }
      // Deterministic: don't let process ancestry (which may genuinely be
      // Claude Code, since that's what's running this test) decide.
      process.env.AIWG_DISABLE_PROCESS_PROVIDER_DETECTION = '1';
    });

    afterEach(() => {
      for (const key of PROVIDER_ENV_KEYS) {
        const value = saved.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      saved.clear();
      delete process.env.AIWG_DISABLE_PROCESS_PROVIDER_DETECTION;
    });

    async function runDefaultSummary(): Promise<string> {
      const { runtimeInfoHandler } = await import('../../../../src/cli/handlers/runtime-info.js');
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await runtimeInfoHandler.execute(mockContext);
        return consoleSpy.mock.calls.map(([line]) => String(line)).join('\n');
      } finally {
        consoleSpy.mockRestore();
      }
    }

    it('reports native-cron when current Claude Code markers are present', async () => {
      process.env.CLAUDECODE = '1';
      process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';

      const output = await runDefaultSummary();

      expect(output).toContain('Backend:  native-cron (CronCreate); external trigger outside agent sessions');
      expect(output).toContain('Backend:  native (Claude Code agent teams)');
    });

    it('does not report native-cron from ANTHROPIC_API_KEY alone (false-positive fix)', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-not-actually-claude-code';

      const output = await runDefaultSummary();

      expect(output).toContain('Backend:  external trigger required (system cron/systemd/CI)');
      expect(output).toContain('Backend:  aiwg mc emulation');
    });

    it('reports external trigger when neither stale nor current markers are present', async () => {
      const output = await runDefaultSummary();

      expect(output).toContain('Backend:  external trigger required (system cron/systemd/CI)');
      expect(output).toContain('Backend:  aiwg mc emulation');
    });
  });

  describe('error handling', () => {
    it('should handle "No catalog found" errors outside the default summary gracefully', async () => {
      const { runtimeInfoHandler } = await import('../../../../src/cli/handlers/runtime-info.js');

      mockContext.args = ['--verify'];
      mockDiscovery.verify.mockRejectedValue(new Error('No catalog found'));

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await runtimeInfoHandler.execute(mockContext);

      expect(mockDiscovery.discover).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith('\nNo runtime catalog found.');
      expect(consoleSpy).toHaveBeenCalledWith(
        "Run 'aiwg runtime-info --discover' to create one."
      );
      expect(result.exitCode).toBe(0);

      consoleSpy.mockRestore();
    });

    it('should return error for other exceptions', async () => {
      const { runtimeInfoHandler } = await import('../../../../src/cli/handlers/runtime-info.js');

      const testError = new Error('Unexpected error');
      mockDiscovery.getSummary.mockRejectedValue(testError);

      const result = await runtimeInfoHandler.execute(mockContext);

      expect(result.exitCode).toBe(1);
      expect(result.message).toBe('Unexpected error');
      expect(result.error).toBe(testError);
    });
  });
});
