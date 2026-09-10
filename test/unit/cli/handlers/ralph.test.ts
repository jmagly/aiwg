/**
 * Tests for Ralph Command Handlers
 *
 * Unit tests for Ralph loop CLI command handlers.
 * Tests the class-based handler architecture that delegates to either:
 * - External Ralph supervisor (default) via launchExternalRalph()
 * - Internal scripts (--internal flag) via createScriptRunner()
 *
 * @source @src/cli/handlers/ralph.ts
 * @implements @.aiwg/architecture/decisions/ADR-001-unified-extension-system.md
 * @issue #33, #275
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CommandHandler, HandlerContext, HandlerResult } from '../../../../src/cli/handlers/types.js';
import { ScriptRunner } from '../../../../src/cli/handlers/types.js';

// Mock dependencies
vi.mock('../../../../src/cli/handlers/script-runner.js', () => ({
  createScriptRunner: vi.fn(),
}));

vi.mock('../../../../src/cli/handlers/ralph-launcher.js', () => ({
  launchExternalRalph: vi.fn(),
  getLoopStatuses: vi.fn(),
  abortLoop: vi.fn(),
  resumeLoop: vi.fn(),
}));

vi.mock('../../../../src/channel/manager.mjs', () => ({
  getFrameworkRoot: vi.fn(() => '/mock/framework/root'),
}));

describe('Ralph Command Handlers', () => {
  let mockRunner: ScriptRunner;
  let mockContext: HandlerContext;

  beforeEach(async () => {
    // Mock script runner
    mockRunner = {
      run: vi.fn(async () => ({ exitCode: 0 })),
    };

    // Mock handler context
    mockContext = {
      args: [],
      rawArgs: [],
      cwd: '/mock/project',
      frameworkRoot: '/mock/framework/root',
    };

    // Set up createScriptRunner mock
    const { createScriptRunner } = await import('../../../../src/cli/handlers/script-runner.js');
    vi.mocked(createScriptRunner).mockReturnValue(mockRunner);

    // Set up ralph-launcher mocks
    const launcher = await import('../../../../src/cli/handlers/ralph-launcher.js');
    vi.mocked(launcher.launchExternalRalph).mockResolvedValue({
      success: true,
      loopId: 'test-loop-123',
      pid: 12345,
      message: 'Loop launched successfully',
      registryPath: '/mock/project/.aiwg/ralph-external/registry.json',
    });

    vi.mocked(launcher.getLoopStatuses).mockReturnValue([]);

    vi.mocked(launcher.abortLoop).mockReturnValue({
      success: true,
      message: 'Loop aborted successfully',
    });

    vi.mocked(launcher.resumeLoop).mockResolvedValue({
      success: true,
      loopId: 'test-loop-456',
      pid: 12346,
      message: 'Loop resumed successfully',
      registryPath: '/mock/project/.aiwg/ralph-external/registry.json',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('ralphHandler', () => {
    it('should have correct metadata', async () => {
      const { ralphHandler } = await import('../../../../src/cli/handlers/ralph.js');

      expect(ralphHandler.id).toBe('ralph');
      expect(ralphHandler.name).toBe('Agent Loop');
      expect(ralphHandler.description.toLowerCase()).toContain('iterative task loop');
      expect(ralphHandler.category).toBe('ralph');
      expect(ralphHandler.aliases).toEqual(['ralph', '-ralph', '--ralph']);
    });

    it('should show help message when --help is passed', async () => {
      const { ralphHandler } = await import('../../../../src/cli/handlers/ralph.js');

      mockContext.args = ['--help'];

      const result = await ralphHandler.execute(mockContext);

      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('Agent Loop');
      expect(result.message).toContain('USAGE');
    });

    it('should launch external Ralph by default', async () => {
      const { ralphHandler } = await import('../../../../src/cli/handlers/ralph.js');
      const launcher = await import('../../../../src/cli/handlers/ralph-launcher.js');

      mockContext.args = ['Fix tests', '--completion', 'all tests pass'];

      const result = await ralphHandler.execute(mockContext);

      expect(launcher.launchExternalRalph).toHaveBeenCalledWith(
        '/mock/framework/root',
        expect.any(String), // Uses process.cwd()
        expect.objectContaining({
          objective: 'Fix tests',
          completionCriteria: 'all tests pass',
        })
      );
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('Loop launched successfully');
      expect(result.message).toContain('PID: 12345');
      expect(result.message).toContain('Loop ID: test-loop-123');
    });

    it('forwards all six LFD loop-control flags to the launcher (#1770)', async () => {
      const { ralphHandler } = await import('../../../../src/cli/handlers/ralph.js');
      const launcher = await import('../../../../src/cli/handlers/ralph-launcher.js');

      mockContext.args = [
        'Fix tests', '--completion', 'all tests pass',
        '--max-total-tokens', '50000',
        '--max-output-tokens', '20000',
        '--max-tool-calls', '200',
        '--max-total-cost', '7.5',
        '--max-wall-clock-minutes', '90',
        '--exploration-quota', '4',
      ];

      const result = await ralphHandler.execute(mockContext);

      expect(result.exitCode).toBe(0);
      expect(launcher.launchExternalRalph).toHaveBeenCalledWith(
        '/mock/framework/root',
        expect.any(String),
        expect.objectContaining({
          maxTotalTokens: 50000,
          maxOutputTokens: 20000,
          maxToolCalls: 200,
          maxTotalCost: 7.5,
          maxWallClockMinutes: 90,
          explorationQuota: 4,
        })
      );
    });

    it('refuses to launch on invalid numeric budget values (#1770)', async () => {
      const { ralphHandler } = await import('../../../../src/cli/handlers/ralph.js');
      const launcher = await import('../../../../src/cli/handlers/ralph-launcher.js');

      mockContext.args = ['Fix tests', '--completion', 'pass', '--max-total-cost', 'abc'];

      const result = await ralphHandler.execute(mockContext);

      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('--max-total-cost');
      expect(launcher.launchExternalRalph).not.toHaveBeenCalled();
    });

    it('refuses to launch on unknown flags instead of silently dropping them (#1770)', async () => {
      const { ralphHandler } = await import('../../../../src/cli/handlers/ralph.js');
      const launcher = await import('../../../../src/cli/handlers/ralph-launcher.js');

      mockContext.args = ['Fix tests', '--completion', 'pass', '--max-total-costt', '5'];

      const result = await ralphHandler.execute(mockContext);

      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('--max-total-costt');
      expect(launcher.launchExternalRalph).not.toHaveBeenCalled();
    });

    const integerLimits = ['--max-iterations', '--max-total-tokens', '--max-output-tokens',
      '--max-tool-calls', '--exploration-quota', '--timeout'];
    const decimalLimits = ['--budget', '--max-total-cost', '--max-wall-clock-minutes'];
    for (const flag of [...integerLimits, ...decimalLimits]) {
      const invalid: Array<string | undefined> = ['1junk', '1,000', '0x10', '0', '-1', 'Infinity', '', undefined];
      if (integerLimits.includes(flag)) invalid.push('1.5', '9007199254740992');
      it.each(invalid)(`refuses ${flag}=%s before launching`, async raw => {
        const { ralphHandler } = await import('../../../../src/cli/handlers/ralph.js');
        const launcher = await import('../../../../src/cli/handlers/ralph-launcher.js');
        mockContext.args = ['Synthetic task', '--completion', 'done', flag, ...(raw === undefined ? [] : [raw])];
        const result = await ralphHandler.execute(mockContext);
        expect(result.exitCode).toBe(1);
        expect(result.message).toContain(flag);
        expect(launcher.launchExternalRalph).not.toHaveBeenCalled();
      });
    }

    it.each([['1', 1], ['1e2', 100], ['1.0', 1]] as const)('forwards exact whole numeric values %s', async (raw, expected) => {
      const { ralphHandler } = await import('../../../../src/cli/handlers/ralph.js');
      const launcher = await import('../../../../src/cli/handlers/ralph-launcher.js');
      mockContext.args = ['Synthetic task', '--completion', 'done',
        ...[...integerLimits, ...decimalLimits].flatMap(flag => [flag, raw])];
      expect((await ralphHandler.execute(mockContext)).exitCode).toBe(0);
      expect(launcher.launchExternalRalph).toHaveBeenCalledExactlyOnceWith(
        mockContext.frameworkRoot, process.cwd(), expect.objectContaining({
          maxIterations: expected, maxTotalTokens: expected, maxOutputTokens: expected,
          maxToolCalls: expected, explorationQuota: expected, timeout: expected,
          budget: expected, maxTotalCost: expected, maxWallClockMinutes: expected,
        }),
      );
    });

    it('forwards fractional cost and wall-clock limits without truncation', async () => {
      const { ralphHandler } = await import('../../../../src/cli/handlers/ralph.js');
      const launcher = await import('../../../../src/cli/handlers/ralph-launcher.js');
      mockContext.args = ['Synthetic task', '--completion', 'done', ...decimalLimits.flatMap(flag => [flag, '0.25'])];
      expect((await ralphHandler.execute(mockContext)).exitCode).toBe(0);
      expect(launcher.launchExternalRalph).toHaveBeenCalledExactlyOnceWith(
        mockContext.frameworkRoot, process.cwd(), expect.objectContaining({ budget: 0.25, maxTotalCost: 0.25, maxWallClockMinutes: 0.25 }),
      );
    });

    it('should use internal mode when --internal flag is passed', async () => {
      const { ralphHandler } = await import('../../../../src/cli/handlers/ralph.js');
      const launcher = await import('../../../../src/cli/handlers/ralph-launcher.js');

      mockContext.args = ['Fix tests', '--completion', 'all tests pass', '--internal'];

      const result = await ralphHandler.execute(mockContext);

      // Should use script runner, not external launcher
      expect(mockRunner.run).toHaveBeenCalledWith(
        'tools/ralph/ralph-cli.mjs',
        ['Fix tests', '--completion', 'all tests pass']
      );
      expect(launcher.launchExternalRalph).not.toHaveBeenCalled();
      expect(result.exitCode).toBe(0);
    });

    it('should require objective for external mode', async () => {
      const { ralphHandler } = await import('../../../../src/cli/handlers/ralph.js');

      mockContext.args = ['--completion', 'done'];

      const result = await ralphHandler.execute(mockContext);

      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('Objective is required');
    });

    it('should require completion criteria for external mode', async () => {
      const { ralphHandler } = await import('../../../../src/cli/handlers/ralph.js');

      mockContext.args = ['Fix tests'];

      const result = await ralphHandler.execute(mockContext);

      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('Completion criteria is required');
    });

    it('should handle launch failure gracefully', async () => {
      const { ralphHandler } = await import('../../../../src/cli/handlers/ralph.js');
      const launcher = await import('../../../../src/cli/handlers/ralph-launcher.js');

      vi.mocked(launcher.launchExternalRalph).mockRejectedValue(new Error('Launch failed'));

      mockContext.args = ['Fix tests', '--completion', 'all tests pass'];

      const result = await ralphHandler.execute(mockContext);

      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('Failed to launch Ralph');
      expect(result.message).toContain('Launch failed');
      expect(result.error).toBeDefined();
    });

    it('should pass all options to external launcher', async () => {
      const { ralphHandler } = await import('../../../../src/cli/handlers/ralph.js');
      const launcher = await import('../../../../src/cli/handlers/ralph-launcher.js');

      mockContext.args = [
        'Fix tests',
        '--completion',
        'all tests pass',
        '--max-iterations',
        '10',
        '--model',
        'opus',
        '--budget',
        '5.0',
        '--timeout',
        '120',
        '--memory',
        '5',
        '--cross-task',
        '--gitea-issue',
      ];

      await ralphHandler.execute(mockContext);

      expect(launcher.launchExternalRalph).toHaveBeenCalledWith(
        '/mock/framework/root',
        expect.any(String), // Uses process.cwd()
        expect.objectContaining({
          objective: 'Fix tests',
          completionCriteria: 'all tests pass',
          maxIterations: 10,
          model: 'opus',
          budget: 5.0,
          timeout: 120,
          memory: 5,
          crossTask: true,
          giteaIssue: true,
        })
      );
    });
  });

  describe('ralphStatusHandler', () => {
    it('should have correct metadata', async () => {
      const { ralphStatusHandler } = await import('../../../../src/cli/handlers/ralph.js');

      expect(ralphStatusHandler.id).toBe('ralph-status');
      expect(ralphStatusHandler.name).toBe('Ralph Status');
      expect(ralphStatusHandler.description.toLowerCase()).toContain('status');
      expect(ralphStatusHandler.category).toBe('ralph');
      expect(ralphStatusHandler.aliases).toEqual(['ralph-status']);
    });

    it('should show message when no loops found', async () => {
      const { ralphStatusHandler } = await import('../../../../src/cli/handlers/ralph.js');
      const launcher = await import('../../../../src/cli/handlers/ralph-launcher.js');

      vi.mocked(launcher.getLoopStatuses).mockReturnValue([]);

      const result = await ralphStatusHandler.execute(mockContext);

      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('No Agent loops found');
    });

    it('should display running loops by default', async () => {
      const { ralphStatusHandler } = await import('../../../../src/cli/handlers/ralph.js');
      const launcher = await import('../../../../src/cli/handlers/ralph-launcher.js');

      vi.mocked(launcher.getLoopStatuses).mockReturnValue([
        {
          loopId: 'test-loop-123',
          pid: 12345,
          objective: 'Fix all tests',
          completionCriteria: 'all tests pass',
          status: 'running',
          startedAt: '2024-01-01T10:00:00Z',
          lastUpdate: '2024-01-01T10:05:00Z',
          iteration: 2,
          maxIterations: 5,
          outputFile: '/mock/project/.aiwg/ralph-external/test-loop-123.output',
          sessionStdoutFile: '/mock/project/.aiwg/ralph-external/loops/test-loop-123/outputs/002-stdout.log',
          sessionStderrFile: '/mock/project/.aiwg/ralph-external/loops/test-loop-123/outputs/002-stderr.log',
        },
      ]);

      const result = await ralphStatusHandler.execute(mockContext);

      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('test-loop-123');
      expect(result.message).toContain('RUNNING');
      expect(result.message).toContain('Fix all tests');
      expect(result.message).toContain('2/5 iterations');
      expect(result.message).toContain('PID: 12345');
      expect(result.message).toContain('Daemon log: /mock/project/.aiwg/ralph-external/test-loop-123.output');
      expect(result.message).toContain('Session stdout: /mock/project/.aiwg/ralph-external/loops/test-loop-123/outputs/002-stdout.log');
      expect(result.message).toContain('Session stderr: /mock/project/.aiwg/ralph-external/loops/test-loop-123/outputs/002-stderr.log');
    });

    it('should display all loops when --all flag is passed', async () => {
      const { ralphStatusHandler } = await import('../../../../src/cli/handlers/ralph.js');
      const launcher = await import('../../../../src/cli/handlers/ralph-launcher.js');

      vi.mocked(launcher.getLoopStatuses).mockReturnValue([
        {
          loopId: 'test-loop-123',
          pid: 12345,
          objective: 'Fix all tests',
          completionCriteria: 'all tests pass',
          status: 'running',
          startedAt: '2024-01-01T10:00:00Z',
          lastUpdate: '2024-01-01T10:05:00Z',
          iteration: 2,
          maxIterations: 5,
          outputFile: '/mock/project/.aiwg/ralph-external/test-loop-123.output',
        },
        {
          loopId: 'test-loop-456',
          pid: 0,
          objective: 'Update docs',
          completionCriteria: 'all docs updated',
          status: 'completed',
          startedAt: '2024-01-01T09:00:00Z',
          lastUpdate: '2024-01-01T09:30:00Z',
          iteration: 3,
          maxIterations: 5,
          outputFile: '/mock/project/.aiwg/ralph-external/test-loop-456.output',
        },
      ]);

      mockContext.args = ['--all'];

      const result = await ralphStatusHandler.execute(mockContext);

      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('test-loop-123');
      expect(result.message).toContain('test-loop-456');
      expect(result.message).toContain('RUNNING');
      expect(result.message).toContain('COMPLETED');
    });
  });

  describe('ralphAbortHandler', () => {
    it('should have correct metadata', async () => {
      const { ralphAbortHandler } = await import('../../../../src/cli/handlers/ralph.js');

      expect(ralphAbortHandler.id).toBe('ralph-abort');
      expect(ralphAbortHandler.name).toBe('Ralph Abort');
      expect(ralphAbortHandler.description.toLowerCase()).toContain('abort');
      expect(ralphAbortHandler.category).toBe('ralph');
      expect(ralphAbortHandler.aliases).toEqual(['ralph-abort']);
    });

    it('should abort running loop', async () => {
      const { ralphAbortHandler } = await import('../../../../src/cli/handlers/ralph.js');
      const launcher = await import('../../../../src/cli/handlers/ralph-launcher.js');

      const result = await ralphAbortHandler.execute(mockContext);

      expect(launcher.abortLoop).toHaveBeenCalledWith(expect.any(String), undefined);
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('Loop aborted successfully');
    });

    it('should pass loop-id when specified', async () => {
      const { ralphAbortHandler } = await import('../../../../src/cli/handlers/ralph.js');
      const launcher = await import('../../../../src/cli/handlers/ralph-launcher.js');

      mockContext.args = ['--loop-id', 'test-loop-123'];

      const result = await ralphAbortHandler.execute(mockContext);

      expect(launcher.abortLoop).toHaveBeenCalledWith(expect.any(String), 'test-loop-123');
      expect(result.exitCode).toBe(0);
    });

    it('should handle abort failure', async () => {
      const { ralphAbortHandler } = await import('../../../../src/cli/handlers/ralph.js');
      const launcher = await import('../../../../src/cli/handlers/ralph-launcher.js');

      vi.mocked(launcher.abortLoop).mockReturnValue({
        success: false,
        message: 'No running loop found',
      });

      const result = await ralphAbortHandler.execute(mockContext);

      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('No running loop found');
    });
  });

  describe('ralphResumeHandler', () => {
    it.each(['1junk', '1.5', '0', '-1', 'Infinity', '9007199254740992', undefined])('refuses invalid resume iteration limit %s', async raw => {
      const { ralphResumeHandler } = await import('../../../../src/cli/handlers/ralph.js');
      const launcher = await import('../../../../src/cli/handlers/ralph-launcher.js');
      mockContext.args = ['--max-iterations', ...(raw === undefined ? [] : [raw])];
      const result = await ralphResumeHandler.execute(mockContext);
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('--max-iterations');
      expect(launcher.resumeLoop).not.toHaveBeenCalled();
    });

    it('forwards exponent resume limits as the complete numeric value', async () => {
      const { ralphResumeHandler } = await import('../../../../src/cli/handlers/ralph.js');
      const launcher = await import('../../../../src/cli/handlers/ralph-launcher.js');
      mockContext.args = ['--max-iterations', '1e2'];
      expect((await ralphResumeHandler.execute(mockContext)).exitCode).toBe(0);
      expect(launcher.resumeLoop).toHaveBeenCalledExactlyOnceWith(mockContext.frameworkRoot, process.cwd(), undefined, { maxIterations: 100 });
    });
    it('should have correct metadata', async () => {
      const { ralphResumeHandler } = await import('../../../../src/cli/handlers/ralph.js');

      expect(ralphResumeHandler.id).toBe('ralph-resume');
      expect(ralphResumeHandler.name).toBe('Ralph Resume');
      expect(ralphResumeHandler.description.toLowerCase()).toContain('resume');
      expect(ralphResumeHandler.category).toBe('ralph');
      expect(ralphResumeHandler.aliases).toEqual(['ralph-resume']);
    });

    it('should resume aborted loop', async () => {
      const { ralphResumeHandler } = await import('../../../../src/cli/handlers/ralph.js');
      const launcher = await import('../../../../src/cli/handlers/ralph-launcher.js');

      const result = await ralphResumeHandler.execute(mockContext);

      expect(launcher.resumeLoop).toHaveBeenCalledWith(
        '/mock/framework/root',
        expect.any(String), // Uses process.cwd()
        undefined,
        expect.objectContaining({})
      );
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('Loop resumed successfully');
      expect(result.message).toContain('PID: 12346');
      expect(result.message).toContain('Loop ID: test-loop-456');
    });

    it('should pass loop-id when specified', async () => {
      const { ralphResumeHandler } = await import('../../../../src/cli/handlers/ralph.js');
      const launcher = await import('../../../../src/cli/handlers/ralph-launcher.js');

      mockContext.args = ['--loop-id', 'test-loop-789'];

      const result = await ralphResumeHandler.execute(mockContext);

      expect(launcher.resumeLoop).toHaveBeenCalledWith(
        '/mock/framework/root',
        expect.any(String), // Uses process.cwd()
        'test-loop-789',
        expect.objectContaining({})
      );
      expect(result.exitCode).toBe(0);
    });

    it('should pass max-iterations when specified', async () => {
      const { ralphResumeHandler } = await import('../../../../src/cli/handlers/ralph.js');
      const launcher = await import('../../../../src/cli/handlers/ralph-launcher.js');

      mockContext.args = ['--max-iterations', '20'];

      const result = await ralphResumeHandler.execute(mockContext);

      expect(launcher.resumeLoop).toHaveBeenCalledWith(
        '/mock/framework/root',
        expect.any(String), // Uses process.cwd()
        undefined,
        expect.objectContaining({
          maxIterations: 20,
        })
      );
      expect(result.exitCode).toBe(0);
    });

    it('should handle resume failure', async () => {
      const { ralphResumeHandler } = await import('../../../../src/cli/handlers/ralph.js');
      const launcher = await import('../../../../src/cli/handlers/ralph-launcher.js');

      vi.mocked(launcher.resumeLoop).mockRejectedValue(new Error('No aborted loop found'));

      const result = await ralphResumeHandler.execute(mockContext);

      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('Failed to resume');
      expect(result.message).toContain('No aborted loop found');
      expect(result.error).toBeDefined();
    });
  });

  describe('ralphHandlers array', () => {
    it('should export all Ralph handlers', async () => {
      const { ralphHandlers } = await import('../../../../src/cli/handlers/ralph.js');

      expect(ralphHandlers).toBeDefined();
      expect(ralphHandlers).toHaveLength(8);
      expect(ralphHandlers.map((h) => h.id)).toEqual([
        'ralph',
        'ralph-status',
        'ralph-abort',
        'ralph-resume',
        'ralph-attach',
        'agent-loop-ext',
        'ralph-memory',
        'ralph-config',
      ]);
    });

    it('should contain valid CommandHandler instances', async () => {
      const { ralphHandlers } = await import('../../../../src/cli/handlers/ralph.js');

      ralphHandlers.forEach((handler: CommandHandler) => {
        expect(handler.id).toBeDefined();
        expect(handler.name).toBeDefined();
        expect(handler.description).toBeDefined();
        expect(handler.category).toBe('ralph');
        expect(handler.aliases).toBeInstanceOf(Array);
        expect(handler.execute).toBeInstanceOf(Function);
      });
    });
  });
});
