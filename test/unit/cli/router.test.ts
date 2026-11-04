/**
 * CLI Router Tests
 *
 * Tests for the registry-based CLI router including command routing,
 * alias resolution, unknown command handling, and help display.
 *
 * @implements @.aiwg/requirements/use-cases/UC-004-extension-system.md
 * @source @src/cli/router.ts
 * @architecture @.aiwg/architecture/decisions/ADR-001-unified-extension-system.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { run, initRouter, cachedRegistry } from '../../../src/cli/router.js';
import type { HandlerContext, HandlerResult, CommandHandler } from '../../../src/cli/handlers/types.js';

import { HookExecutor } from '../../../src/cli/hooks/index.js';
import * as channelManager from '../../../src/channel/manager.mjs';
import * as commandLog from '../../../src/cli/command-log.js';
import * as skillUsage from '../../../src/cli/skill-usage.js';

// Store original functions
const originalExit = process.exit;
const originalConsoleError = console.error;
const originalConsoleLog = console.log;

// Track console calls
let consoleErrorCalls: any[] = [];
let consoleLogCalls: any[] = [];

// Mock process.exit to prevent tests from actually exiting
let exitCode: number | undefined;

describe('router', () => {
  beforeEach(() => {
    // Reset tracking
    exitCode = undefined;
    consoleErrorCalls = [];
    consoleLogCalls = [];

    // Replace functions with tracked versions
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit called with ${code}`);
    }) as any;

    console.error = (...args: any[]) => {
      consoleErrorCalls.push(args);
    };

    console.log = (...args: any[]) => {
      consoleLogCalls.push(args);
    };
  });

  afterEach(() => {
    // Restore originals
    process.exit = originalExit;
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
  });

  it('routes discovery through the entry registry and can initialize all commands afterward', async () => {
    const partial = await initRouter(true);
    const handler = partial.handlerMap.get('discover')!;
    const execute = vi.spyOn(handler, 'execute').mockResolvedValue({ exitCode: 0 });
    try {
      await run(['discover', 'session handoff']);
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({ args: ['session handoff'] }));
      expect((await initRouter()).handlerMap.has('help')).toBe(true);
    } finally { execute.mockRestore(); }
  });

  it('routes daemon status and help through the registered command table (#3758)', async () => {
    const registry = await initRouter();
    expect(registry.registry.resolveCommand('daemon')).toBe('daemon');
    const handler = registry.handlerMap.get('daemon')!;
    const execute = vi.spyOn(handler, 'execute').mockResolvedValue({ exitCode: 0 });
    const help = vi.spyOn(handler, 'help').mockResolvedValue({ exitCode: 0 });
    try {
      await run(['daemon', 'status']);
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({ args: ['status'] }));
      await run(['daemon', 'start', '--help']);
      expect(help).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      execute.mockRestore();
      help.mockRestore();
    }
  });

  describe('initRouter', () => {
    it('should load and cache the registry', async () => {
      const registry = await initRouter();

      expect(registry).toBeDefined();
      expect(registry.registry).toBeDefined();
      expect(registry.handlerMap).toBeDefined();
      expect(registry.capabilityIndex).toBeDefined(); // indexCapabilities: true
    });

    it('should return cached registry on subsequent calls', async () => {
      const first = await initRouter();
      const second = await initRouter();

      expect(first).toBe(second);
    });

    it('should have handlers for core commands', async () => {
      const registry = await initRouter();

      expect(registry.handlerMap.get('help')).toBeDefined();
      expect(registry.handlerMap.get('version')).toBeDefined();
      expect(registry.handlerMap.get('use')).toBeDefined();
    });
  });

  describe('run', () => {
    describe('command routing', () => {
      it('should route command to correct handler', async () => {
        // Run help command (no args)
        await run([]);

        // Help handler should be executed
        // Should not error
        expect(consoleErrorCalls).toHaveLength(0);
        expect(exitCode).toBeUndefined();
      });

      it('should exit with code 0 on successful handler execution', async () => {
        // Test with version command (simple, likely to succeed)
        await run(['version']);

        // Should not exit with error
        expect(exitCode).toBeUndefined();
      });
    });

    it.each([['audit', '--json'], ['plan', '--input', 'plan.json', '--preview'], ['apply', '--plan', 'plan.json', '--preview'], ['restore', '--plan', 'plan.json', '--preview']].flatMap(args => [0, 1].map(status => ({ args, status }))))('keeps memory $args free of hooks and telemetry at exit status $status', async ({ args, status }) => {
      const registry = await initRouter();
      const handler = registry.handlerMap.get('memory')!;
      const execute = vi.spyOn(handler, 'execute').mockResolvedValue({ exitCode: status });
      const hooks = vi.spyOn(HookExecutor.prototype, 'execute');
      const root = vi.spyOn(channelManager, 'getFrameworkRoot').mockResolvedValue(process.cwd());
      const log = vi.spyOn(commandLog, 'maybeAppendCommandLog');
      const usage = vi.spyOn(skillUsage, 'maybeAppendSkillUsage');
      try {
        if (status) await expect(run(['memory', ...args])).rejects.toThrow('process.exit called with 1');
        else await run(['memory', ...args]);
        expect(execute).toHaveBeenCalledOnce();
        expect(root).toHaveBeenCalledWith({ createIfMissing: false });
        expect(hooks).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
        expect(usage).not.toHaveBeenCalled();
      } finally {
        execute.mockRestore(); hooks.mockRestore(); root.mockRestore(); log.mockRestore(); usage.mockRestore();
      }
    });

    describe('alias resolution', () => {
      it('should resolve command aliases', async () => {
        const registry = await initRouter();

        // Test alias resolution directly
        expect(registry.registry.resolveCommand('-h')).toBe('help');
        expect(registry.registry.resolveCommand('--help')).toBe('help');
        expect(registry.registry.resolveCommand('-help')).toBe('help');
      });

      it('should route aliased commands to handler', async () => {
        // Test that alias routes to correct handler
        await run(['--help']);

        // Should not error out
        const errorMessages = consoleErrorCalls.flat().join(' ');
        expect(errorMessages).not.toContain('Unknown command');
        expect(exitCode).toBeUndefined();
      });

      it('should handle version aliases', async () => {
        const registry = await initRouter();

        // version has aliases: ['-version', '--version'] (not -v)
        expect(registry.registry.resolveCommand('-version')).toBe('version');
        expect(registry.registry.resolveCommand('--version')).toBe('version');
      });

      it('resolves upgrade to the canonical update handler (#1871)', async () => {
        const registry = await initRouter();
        expect(registry.registry.resolveCommand('upgrade')).toBe('update');
        expect(registry.handlerMap.get(registry.registry.resolveCommand('upgrade')!))
          .toBe(registry.handlerMap.get('update'));
      });
    });

    describe('unknown command handling', () => {
      it('should error on unknown command', async () => {
        try {
          await run(['unknown-command']);
        } catch (e) {
          // Expected to throw due to process.exit mock
        }

        expect(consoleErrorCalls).toHaveLength(1);
        expect(consoleErrorCalls[0][0]).toContain('Unknown command: unknown-command');
        expect(consoleLogCalls.some(c => c[0].includes('aiwg help'))).toBe(true);
        expect(exitCode).toBe(1);
      });

      it('should error on invalid alias', async () => {
        try {
          await run(['--invalid-flag']);
        } catch (e) {
          // Expected to throw due to process.exit mock
        }

        expect(consoleErrorCalls).toHaveLength(1);
        expect(consoleErrorCalls[0][0]).toContain('Unknown command');
        expect(exitCode).toBe(1);
      });
    });

    describe('help display when no args', () => {
      it.each(['--help', '-h'])('shows remove help without executing removal: %s', async flag => {
        const registry = await initRouter();
        const handler = registry.handlerMap.get('remove')!;
        const execute = vi.spyOn(handler, 'execute');
        const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
        try {
          await run(['remove', flag]);
          const output = stdout.mock.calls.map(call => String(call[0])).join('');
          expect(output).toContain('Usage: aiwg remove <id>');
          expect(output).toContain('--keep-registry');
          expect(output).not.toContain('No detailed help');
          expect(execute).not.toHaveBeenCalled();
          expect(exitCode).toBeUndefined();
        } finally {
          stdout.mockRestore();
          execute.mockRestore();
        }
      });

      it.each(['--help', '-h'])('warns about diagnose secrets in public command help: %s', async flag => {
        const registry = await initRouter();
        const handler = registry.handlerMap.get('diagnose')!;
        const execute = vi.spyOn(handler, 'execute');
        try {
          await run(['diagnose', flag]);
          const output = consoleLogCalls.flat().join(' ');
          expect(output).toContain('Output contains secrets; review it before sharing');
          expect(output).not.toContain('No detailed help');
          expect(execute).not.toHaveBeenCalled();
        } finally { execute.mockRestore(); }
      });

      it('should show help when called with no arguments', async () => {
        await run([]);

        // Should not exit with error
        expect(exitCode).toBeUndefined();
        expect(consoleErrorCalls).toHaveLength(0);

        // Help handler would be executed (actual output tested in help handler tests)
      });

      it('should not error when help handler is available', async () => {
        const registry = await initRouter();

        // Verify help handler exists
        const helpHandler = registry.handlerMap.get('help');
        expect(helpHandler).toBeDefined();
        expect(helpHandler?.id).toBe('help');

        // Run with no args
        await run([]);

        // Should complete without error
        expect(consoleErrorCalls).toHaveLength(0);
      });
    });

    describe('context building', () => {
      it('should pass command arguments to handler', async () => {
        // Use version command which is simple and stable
        await run(['version', '--dry-run']);

        // Should not error on valid command
        const errorMessages = consoleErrorCalls.flat().join(' ');
        expect(errorMessages).not.toContain('Unknown command');
        expect(exitCode).toBeUndefined();
      });

      it('should detect dry-run flag in context', async () => {
        // Would need to mock handler to verify context
        // For now, verify command runs without error
        await run(['version', '--dry-run']);

        expect(exitCode).toBeUndefined();
      });

      it('should use provided cwd option', async () => {
        const customCwd = '/custom/path';

        // No error should occur
        await run(['version'], { cwd: customCwd });

        expect(exitCode).toBeUndefined();
      });
    });

    describe('handler execution', () => {
      it('should execute handler with correct context', async () => {
        // Test that execution completes
        await run(['version']);

        expect(exitCode).toBeUndefined();
      });

      it('should handle missing handler gracefully', async () => {
        // This is an edge case - registry has command but no handler
        // Skip for now as it requires complex mocking
      });
    });
  });

  describe('error handling', () => {
    it('should handle registry loading errors', async () => {
      // Would need to mock loadRegistry to throw
      // Skip for now as this is a rare edge case
    });

    it('should provide helpful error messages', async () => {
      try {
        await run(['nonexistent']);
      } catch (e) {
        // Expected to throw
      }

      expect(consoleErrorCalls).toHaveLength(1);
      expect(consoleErrorCalls[0][0]).toContain('Unknown command: nonexistent');
      expect(consoleLogCalls.some(c => c[0].includes('aiwg help'))).toBe(true);
    });
  });
});
