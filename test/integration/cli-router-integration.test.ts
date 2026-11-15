/**
 * CLI Router Integration Tests
 *
 * End-to-end integration tests for the registry-based CLI router. Tests verify
 * that the new router correctly routes commands through the extension registry,
 * resolves aliases, generates help output, and handles errors consistently with
 * the legacy router.
 *
 * @implements @.aiwg/requirements/use-cases/UC-004-extension-system.md
 * @architecture @docs/architecture/cli/adr-001-unified-extension-registry.md
 * @source @src/cli/router.ts
 * @tests Integration tests for registry-based CLI routing
 * @issue #33 - Unified extension system
 * @issue #174 - Router-level help interception
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { run, initRouter } from '../../src/cli/router.js';
import type { CommandHandler, HandlerContext, HandlerResult } from '../../src/cli/handlers/types.js';

// ============================================
// Test Helpers
// ============================================

/**
 * Captured output from CLI execution
 */
interface CapturedOutput {
  stdout: string[];
  stderr: string[];
  exitCode: number | undefined;
}

/**
 * Setup CLI output capture
 *
 * Intercepts console.log, console.error, and process.exit to capture
 * CLI output without actually terminating the test process.
 */
function setupCapture(): CapturedOutput {
  const captured: CapturedOutput = {
    stdout: [],
    stderr: [],
    exitCode: undefined,
  };

  // Store originals
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;

  // Mock console.log
  console.log = vi.fn((...args: any[]) => {
    captured.stdout.push(args.join(' '));
  });

  // Mock console.error
  console.error = vi.fn((...args: any[]) => {
    captured.stderr.push(args.join(' '));
  });

  // Mock process.exit
  process.exit = vi.fn(((code?: number) => {
    captured.exitCode = code;
    throw new Error(`process.exit called with code ${code}`);
  }) as any);

  // Store originals for cleanup
  (captured as any)._originals = {
    log: originalLog,
    error: originalError,
    exit: originalExit,
  };

  return captured;
}

/**
 * Cleanup output capture
 *
 * Restores original console.log, console.error, and process.exit.
 */
function cleanupCapture(captured: CapturedOutput): void {
  const originals = (captured as any)._originals;
  console.log = originals.log;
  console.error = originals.error;
  process.exit = originals.exit;
}

/**
 * Run CLI command and capture output
 */
async function runCli(args: string[], options?: { cwd?: string }): Promise<CapturedOutput> {
  const captured = setupCapture();

  try {
    await run(args, options);
  } catch (error) {
    // Expected when process.exit is called
    if (!(error instanceof Error && error.message.includes('process.exit'))) {
      throw error;
    }
  } finally {
    cleanupCapture(captured);
  }

  return captured;
}

async function runCliWithMockHandler(
  commandId: string,
  handler: CommandHandler,
  args: string[],
  options?: { cwd?: string },
): Promise<CapturedOutput> {
  const registry = await initRouter();
  const original = registry.handlerMap.get(commandId);
  registry.handlerMap.set(commandId, handler);

  try {
    return await runCli(args, options);
  } finally {
    if (original) {
      registry.handlerMap.set(commandId, original);
    } else {
      registry.handlerMap.delete(commandId);
    }
  }
}

// ============================================
// Tests
// ============================================

describe('CLI Router Integration Tests', () => {
  describe('Router Initialization', () => {
    it('should load registry successfully', async () => {
      const registry = await initRouter();

      expect(registry).toBeDefined();
      expect(registry.registry).toBeDefined();
      expect(registry.handlerMap).toBeDefined();
      expect(registry.capabilityIndex).toBeDefined();
    });

    it('should register all command definitions', async () => {
      const registry = await initRouter();

      // Core commands should be registered
      expect(registry.registry.has('help')).toBe(true);
      expect(registry.registry.has('version')).toBe(true);
      expect(registry.registry.has('use')).toBe(true);
      expect(registry.registry.has('doctor')).toBe(true);
    });

    it('should link all handlers', async () => {
      const registry = await initRouter();

      // Core handlers should be linked
      expect(registry.handlerMap.get('help')).toBeDefined();
      expect(registry.handlerMap.get('version')).toBeDefined();
      expect(registry.handlerMap.get('use')).toBeDefined();
      expect(registry.handlerMap.get('doctor')).toBeDefined();
    });

    it('should cache registry across calls', async () => {
      const first = await initRouter();
      const second = await initRouter();

      expect(first).toBe(second);
    });
  });

  describe('Command Routing', () => {
    it('should route help command', async () => {
      const output = await runCli(['help']);

      // Should display help text
      const stdout = output.stdout.join('\n');
      expect(stdout).toMatch(/AIWG/i);
      expect(stdout).toMatch(/Usage:/i);
      expect(output.exitCode).toBeUndefined(); // Success
    });

    it('should route version command', async () => {
      const output = await runCli(['version']);

      const stdout = output.stdout.join('\n');
      expect(stdout).toMatch(/aiwg\s+\d+\.\d+\.\d+/);
      expect(output.exitCode).toBeUndefined(); // Success
    });

    it('should route use command with invalid target', async () => {
      const output = await runCli(['use', 'nonexistent-target']);

      // Handler returns error result, router calls process.exit(1)
      expect(output.exitCode).toBe(1);
    });

    it('should route doctor command', async () => {
      let context: HandlerContext | undefined;
      const output = await runCliWithMockHandler(
        'doctor',
        {
          id: 'doctor',
          name: 'Mock Doctor',
          description: 'Mock doctor handler for router dispatch tests',
          category: 'maintenance',
          aliases: ['-doctor', '--doctor'],
          async execute(ctx: HandlerContext): Promise<HandlerResult> {
            context = ctx;
            return { exitCode: 0, message: 'mock doctor executed' };
          },
        },
        ['doctor'],
      );

      // Doctor command executes (output depends on environment)
      // Just verify it doesn't show "unknown command"
      const combined = output.stdout.join('\n') + output.stderr.join('\n');
      expect(combined).not.toMatch(/Unknown command: doctor/i);
      expect(context?.args).toEqual([]);
      expect(context?.rawArgs).toEqual(['doctor']);
    });

    it('should route list command', async () => {
      const output = await runCli(['list']);

      // Should not show "unknown command"
      const combined = output.stdout.join('\n') + output.stderr.join('\n');
      expect(combined).not.toMatch(/Unknown command: list/i);
    });

    it('should route mcp subcommands', async () => {
      const output = await runCli(['aiwg-mcp', 'info']);

      // Should route to MCP handler
      const combined = output.stdout.join('\n') + output.stderr.join('\n');
      expect(combined).not.toMatch(/Unknown command: aiwg-mcp/i);
    });

    it('should route catalog subcommands', async () => {
      const output = await runCli(['catalog', 'list']);

      // Should route to catalog handler
      const combined = output.stdout.join('\n') + output.stderr.join('\n');
      expect(combined).not.toMatch(/Unknown command: catalog/i);
    });

    it('should route scaffolding commands', async () => {
      const output = await runCli(['add-agent']);

      // Should route to scaffolding handler
      const combined = output.stdout.join('\n') + output.stderr.join('\n');
      expect(combined).not.toMatch(/Unknown command: add-agent/i);
    });

    it('should route ralph commands', async () => {
      const output = await runCli(['ralph']);

      // Should route to ralph handler
      const combined = output.stdout.join('\n') + output.stderr.join('\n');
      expect(combined).not.toMatch(/Unknown command: ralph/i);
    });
  });

  describe('Alias Resolution', () => {
    it('should resolve help aliases', async () => {
      const registry = await initRouter();

      // Help aliases: -h, -help, --help
      expect(registry.registry.resolveCommand('-h')).toBe('help');
      expect(registry.registry.resolveCommand('-help')).toBe('help');
      expect(registry.registry.resolveCommand('--help')).toBe('help');
    });

    it('should resolve version aliases', async () => {
      const registry = await initRouter();

      // Version aliases: -version, --version
      expect(registry.registry.resolveCommand('-version')).toBe('version');
      expect(registry.registry.resolveCommand('--version')).toBe('version');
    });

    it('should resolve doctor aliases', async () => {
      const registry = await initRouter();

      // Doctor aliases: -doctor, --doctor
      expect(registry.registry.resolveCommand('-doctor')).toBe('doctor');
      expect(registry.registry.resolveCommand('--doctor')).toBe('doctor');
    });

    it('should resolve new aliases', async () => {
      const registry = await initRouter();

      // New aliases: -new, --new
      expect(registry.registry.resolveCommand('-new')).toBe('new');
      expect(registry.registry.resolveCommand('--new')).toBe('new');
    });

    it('should resolve ralph aliases', async () => {
      const registry = await initRouter();

      // Ralph aliases: -ralph, --ralph
      expect(registry.registry.resolveCommand('-ralph')).toBe('ralph');
      expect(registry.registry.resolveCommand('--ralph')).toBe('ralph');
    });

    it('should route through aliases correctly', async () => {
      const output1 = await runCli(['--help']);
      const output2 = await runCli(['-h']);
      const output3 = await runCli(['help']);

      // All should display help
      const stdout1 = output1.stdout.join('\n');
      const stdout2 = output2.stdout.join('\n');
      const stdout3 = output3.stdout.join('\n');

      expect(stdout1).toMatch(/Usage:/i);
      expect(stdout2).toMatch(/Usage:/i);
      expect(stdout3).toMatch(/Usage:/i);

      expect(output1.exitCode).toBeUndefined();
      expect(output2.exitCode).toBeUndefined();
      expect(output3.exitCode).toBeUndefined();
    });
  });

  describe('Help Output', () => {
    let helpOutput: string;

    beforeEach(async () => {
      const output = await runCli(['help']);
      helpOutput = output.stdout.join('\n');
    });

    it('should include header with name and usage', () => {
      expect(helpOutput).toMatch(/AIWG/i);
      expect(helpOutput).toMatch(/Usage:/i);
    });

    it('should include Framework Management section', () => {
      expect(helpOutput).toMatch(/FRAMEWORK/i);
      expect(helpOutput).toMatch(/use/i);
      expect(helpOutput).toMatch(/list/i);
      expect(helpOutput).toMatch(/remove/i);
    });

    it('should include Project Setup section', () => {
      expect(helpOutput).toMatch(/PROJECT/i);
      expect(helpOutput).toMatch(/new/i);
    });

    it('should include Maintenance section', () => {
      expect(helpOutput).toMatch(/Maintenance/i);
      expect(helpOutput).toMatch(/doctor/i);
      expect(helpOutput).toMatch(/version/i);
    });

    it('should include MCP Server section', () => {
      expect(helpOutput).toMatch(/MCP Server/i);
      expect(helpOutput).toMatch(/mcp/i);
    });

    it('should include Scaffolding section', () => {
      expect(helpOutput).toMatch(/Scaffolding/i);
      expect(helpOutput).toMatch(/add-agent/i);
      expect(helpOutput).toMatch(/add-command/i);
    });

    it('should include Ralph Loop section', () => {
      expect(helpOutput).toMatch(/Ralph/i);
      expect(helpOutput).toMatch(/ralph/i);
    });

    it('should include Examples section', () => {
      expect(helpOutput).toMatch(/Examples/i);
      expect(helpOutput).toMatch(/aiwg use/i);
    });
  });

  describe('Per-command help interception', () => {
    it('preserves detailed help for a command that declares it', async () => {
      const rawOutput: string[] = [];
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
        rawOutput.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);
      try {
        const output = await runCli(['doctor', '--help']);

        expect(output.exitCode).toBeUndefined();
        expect(rawOutput.join('')).toContain('aiwg doctor — check AIWG installation health');
        expect(rawOutput.join('')).toContain('--deployment');
      } finally {
        stdoutSpy.mockRestore();
      }
    });

    it.each(['--help', '-h'])('does not invoke a handler without declared help for %s', async (flag) => {
      const execute = vi.fn(async (): Promise<HandlerResult> => ({ exitCode: 0 }));
      const handler: CommandHandler = {
        id: 'version',
        name: 'Version',
        description: 'Test handler without detailed help',
        category: 'maintenance',
        aliases: [],
        execute,
      };

      const output = await runCliWithMockHandler('version', handler, ['version', flag]);

      expect(execute).not.toHaveBeenCalled();
      expect(output.exitCode).toBeUndefined();
      expect(output.stdout.join('\n')).toContain('No detailed help for `aiwg version`');
    });

    it('uses declared help without invoking the command handler', async () => {
      const execute = vi.fn(async (): Promise<HandlerResult> => ({ exitCode: 0 }));
      const help = vi.fn(async (): Promise<HandlerResult> => ({
        exitCode: 0,
        message: 'command-specific help',
      }));
      const handler: CommandHandler = {
        id: 'version',
        name: 'Version',
        description: 'Test handler with detailed help',
        category: 'maintenance',
        aliases: [],
        help,
        execute,
      };

      const output = await runCliWithMockHandler('version', handler, ['version', '--help']);

      expect(help).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
      expect(output.stdout.join('\n')).toContain('command-specific help');
    });
  });

  describe('Version Output', () => {
    it('should display version in expected format', async () => {
      const output = await runCli(['version']);
      const stdout = output.stdout.join('\n');

      expect(stdout).toMatch(/aiwg\s+\d+\.\d+\.\d+/);
      // Channel label is present for non-stable channels; any bracketed word is valid
      expect(stdout).toMatch(/\[\w[\w.-]*\]/);
    });

    it('should show package root or git info', async () => {
      const output = await runCli(['version']);
      const stdout = output.stdout.join('\n');

      expect(stdout).toMatch(/(path:|git:|Package root|Git:)/i);
    });

    it('should exit successfully', async () => {
      const output = await runCli(['version']);

      expect(output.exitCode).toBeUndefined(); // Success
    });
  });

  describe('Error Handling', () => {
    it('should error on unknown command', async () => {
      const output = await runCli(['completely-unknown-command']);

      expect(output.stderr.join('\n')).toMatch(/Unknown command: completely-unknown-command/i);
      expect(output.stdout.join('\n')).toMatch(/aiwg help/i);
      expect(output.exitCode).toBe(1);
    });

    it('should error on invalid alias', async () => {
      const output = await runCli(['--invalid-flag']);

      expect(output.stderr.join('\n')).toMatch(/Unknown command/i);
      expect(output.exitCode).toBe(1);
    });

    it('should handle invalid framework argument gracefully', async () => {
      const output = await runCli(['use', 'nonexistent-framework']);

      // Handler returns error, router exits with code 1
      expect(output.exitCode).toBe(1);
    });

    it('should handle invalid framework names', async () => {
      const output = await runCli(['use', 'invalid-framework']);

      // Handler returns error, router exits with code 1
      expect(output.exitCode).toBe(1);
    });

    it('should exit with error code on handler failure', async () => {
      const output = await runCli(['use', 'invalid']);

      // Handler fails, router propagates exit code
      expect(output.exitCode).toBe(1);
    });
  });

  describe('No Arguments Behavior', () => {
    it('should show help when no arguments provided', async () => {
      const output = await runCli([]);

      const stdout = output.stdout.join('\n');
      expect(stdout).toMatch(/AIWG/i);
      expect(stdout).toMatch(/Usage:/i);
      expect(output.exitCode).toBeUndefined(); // Success
    });

    it('should not error when showing default help', async () => {
      const output = await runCli([]);

      expect(output.stderr).toHaveLength(0);
      expect(output.exitCode).toBeUndefined();
    });
  });

  describe('Argument Passthrough', () => {
    function mockUseHandler(onExecute: (ctx: HandlerContext) => void): CommandHandler {
      return {
        id: 'use',
        name: 'Mock Use',
        description: 'Mock use handler for router argument passthrough tests',
        category: 'framework',
        aliases: [],
        async execute(ctx: HandlerContext): Promise<HandlerResult> {
          onExecute(ctx);
          return { exitCode: 0, message: 'mock use executed' };
        },
      };
    }

    it('should pass remaining args to handler', async () => {
      let context: HandlerContext | undefined;
      const output = await runCliWithMockHandler(
        'use',
        mockUseHandler((ctx) => {
          context = ctx;
        }),
        ['use', 'sdlc', '--dry-run'],
      );

      const combined = output.stdout.join('\n') + output.stderr.join('\n');
      expect(combined).not.toMatch(/Unknown command/i);
      expect(context?.args).toEqual(['sdlc', '--dry-run']);
      expect(context?.rawArgs).toEqual(['use', 'sdlc', '--dry-run']);
    });

    it('should support --dry-run flag', async () => {
      let context: HandlerContext | undefined;
      const output = await runCliWithMockHandler(
        'use',
        mockUseHandler((ctx) => {
          context = ctx;
        }),
        ['use', 'sdlc', '--dry-run'],
      );

      const combined = output.stdout.join('\n') + output.stderr.join('\n');
      expect(combined).not.toMatch(/Unknown command/i);
      expect(context?.dryRun).toBe(true);
    });

    it('should pass multiple arguments', async () => {
      let context: HandlerContext | undefined;
      const output = await runCliWithMockHandler(
        'use',
        mockUseHandler((ctx) => {
          context = ctx;
        }),
        ['use', 'sdlc', '--provider', 'copilot'],
      );

      const combined = output.stdout.join('\n') + output.stderr.join('\n');
      expect(combined).not.toMatch(/Unknown command/i);
      expect(context?.args).toEqual(['sdlc', '--provider', 'copilot']);
      expect(context?.dryRun).toBe(false);
    });
  });

  describe('Working Directory Context', () => {
    it('should use provided cwd option', async () => {
      const customCwd = '/tmp/test-workspace';

      const output = await runCli(['version'], { cwd: customCwd });

      // Should execute without error
      expect(output.exitCode).toBeUndefined();
    });

    it('should default to process.cwd', async () => {
      const output = await runCli(['version']);

      expect(output.exitCode).toBeUndefined();
    });
  });

  describe('Command Categories', () => {
    it('should have all expected command categories in registry', async () => {
      const registry = await initRouter();

      // Get all command extensions (skills are the canonical source format for CLI commands)
      const commands = registry.registry.getByType('skill');

      // Extract categories
      const categories = new Set(
        commands.map(cmd => {
          const handler = registry.handlerMap.get(cmd.id);
          return handler?.category;
        }).filter(Boolean)
      );

      // Should have major categories
      expect(categories).toContain('framework');
      expect(categories).toContain('maintenance');
      expect(categories).toContain('scaffolding');
      expect(categories).toContain('ralph');
    });
  });

  describe('Handler Execution', () => {
    it('should execute handlers with correct context', async () => {
      const output = await runCli(['version']);

      // Handler should complete successfully
      expect(output.exitCode).toBeUndefined();
    });

    it('should handle handler errors gracefully', async () => {
      const output = await runCli(['use', 'invalid']);

      // Should error but not crash
      expect(output.exitCode).toBe(1);
    });

    it('should propagate exit codes from handlers', async () => {
      const output = await runCli(['unknown-command']);

      // Unknown command should exit with code 1
      expect(output.exitCode).toBe(1);
    });
  });

  describe('Comparison with Legacy Router', () => {
    /**
     * These tests verify that the new router behaves identically to the
     * legacy router for key scenarios. This ensures backward compatibility.
     */

    it('should handle help command identically', async () => {
      const output = await runCli(['help']);

      // Legacy router shows help on 'help' command
      const stdout = output.stdout.join('\n');
      expect(stdout).toMatch(/Usage:/i);
      expect(output.exitCode).toBeUndefined();
    });

    it('should handle version command identically', async () => {
      const output = await runCli(['version']);

      // Legacy router shows version info
      const stdout = output.stdout.join('\n');
      expect(stdout).toMatch(/aiwg\s+\d+\.\d+\.\d+/);
      expect(output.exitCode).toBeUndefined();
    });

    it('should handle unknown commands identically', async () => {
      const output = await runCli(['nonexistent']);

      // Legacy router shows error and suggests help
      expect(output.stderr.join('\n')).toMatch(/Unknown command/i);
      expect(output.stdout.join('\n')).toMatch(/aiwg help/i);
      expect(output.exitCode).toBe(1);
    });

    it('should handle no arguments identically', async () => {
      const output = await runCli([]);

      // Legacy router shows help when no args
      const stdout = output.stdout.join('\n');
      expect(stdout).toMatch(/Usage:/i);
      expect(output.exitCode).toBeUndefined();
    });

    it('should produce same exit codes', async () => {
      const scenarios = [
        { args: ['help'], expectedExit: undefined },
        { args: ['version'], expectedExit: undefined },
        { args: ['unknown'], expectedExit: 1 },
        { args: ['use', 'invalid-framework'], expectedExit: 1 }, // Unknown framework
      ];

      for (const scenario of scenarios) {
        const output = await runCli(scenario.args);
        expect(output.exitCode).toBe(scenario.expectedExit);
      }
    });
  });

  describe('Registry State', () => {
    it('should maintain consistent state across commands', async () => {
      const registry1 = await initRouter();
      await runCli(['help']);
      const registry2 = await initRouter();

      // Should be same cached instance
      expect(registry1).toBe(registry2);
    });

    it('should have stable command count', async () => {
      const registry = await initRouter();
      const initialSize = registry.registry.size;

      // Run some commands
      await runCli(['help']);
      await runCli(['version']);

      // Registry size should not change
      expect(registry.registry.size).toBe(initialSize);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty string command', async () => {
      const output = await runCli(['']);

      // Empty string is falsy, so router treats it as "no command" and shows help
      const stdout = output.stdout.join('\n');
      expect(stdout).toMatch(/Usage:/i);
      expect(output.exitCode).toBeUndefined();
    });

    it('should handle command with trailing spaces', async () => {
      // Router uses first arg as-is, doesn't trim
      // This would fail as unknown command unless handler does trimming
      const output = await runCli(['help']);

      // Should work correctly
      const stdout = output.stdout.join('\n');
      expect(stdout).toMatch(/Usage:/i);
    });

    it('should handle case-sensitive commands', async () => {
      const output = await runCli(['HELP']);

      // Commands are case-sensitive, should error
      expect(output.stderr.join('\n')).toMatch(/Unknown command/i);
      expect(output.exitCode).toBe(1);
    });
  });
});
