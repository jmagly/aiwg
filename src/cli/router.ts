/**
 * CLI Router - Registry-Based Command Dispatch with Hook Support
 *
 * Main CLI entry point using the extension registry for command routing.
 * Replaces the monolithic switch/case with O(1) handler lookup.
 * Integrates hook system for lifecycle events.
 *
 * @implements @.aiwg/requirements/use-cases/UC-004-extension-system.md
 * @architecture @.aiwg/architecture/decisions/ADR-001-unified-extension-system.md
 * @tests @test/unit/cli/router.test.ts
 * @issue #33
 * @issue #58
 * @issue #174
 */

import { loadRegistry, type LoadedRegistry } from '../extensions/loader.js';
import { getFrameworkRoot } from '../channel/manager.mjs';
import type { HandlerContext } from './handlers/types.js';
import { HookRegistry, HookExecutor } from './hooks/index.js';
import type { HookContext } from './hooks/index.js';
import { activityLogPostCommandHook } from './hooks/builtin/activity-log-hook.js';
import { tryExecuteCliExtension } from './cli-extension-loader.js';
import * as ui from './ui.js';
import { maybeCelebrateMilestone } from '../community/milestones.js';
import { maybeAppendCommandLog } from './command-log.js';
import { maybeAppendSkillUsage } from './skill-usage.js';

// Cached loaded registry
let cachedRegistry: LoadedRegistry | null = null;

// Global hook registry and executor. Register built-in hooks at module
// load time so they fire for every command without per-handler wiring.
const hookRegistry = new HookRegistry();
const hookExecutor = new HookExecutor(hookRegistry);
hookRegistry.register(activityLogPostCommandHook);

/**
 * Initialize the CLI router
 *
 * Loads the extension registry with capability indexing and caches it
 * for subsequent calls.
 *
 * @returns Loaded registry with handlers
 */
export async function initRouter(): Promise<LoadedRegistry> {
  if (!cachedRegistry) {
    cachedRegistry = await loadRegistry({ indexCapabilities: true });
  }
  return cachedRegistry;
}

/**
 * Get the global hook registry
 *
 * Allows external code to register hooks.
 *
 * @returns Global hook registry
 */
export function getHookRegistry(): HookRegistry {
  return hookRegistry;
}

/**
 * Main CLI entry point - registry-based routing with hooks
 *
 * Routes commands to handlers via the extension registry. Handles alias
 * resolution, unknown commands, and help display. Executes hooks at
 * appropriate lifecycle points.
 *
 * @param args - Command line arguments
 * @param options - Execution options
 *
 * @example
 * ```typescript
 * // Route 'use' command
 * await run(['use', 'sdlc']);
 *
 * // Handle alias
 * await run(['--help']);
 *
 * // Show help when no args
 * await run([]);
 * ```
 */
export async function run(
  args: string[],
  options: { cwd?: string; signal?: AbortSignal } = {},
): Promise<void> {
  // Scheduled index maintenance has no hooks, telemetry, or deployment side effects.
  if (args[0] === 'index' && args[1] === 'refresh'
    && !args.includes('--help') && !args.includes('-h')) {
    const { runIndexRefresh } = await import('../artifacts/index-refresh.js');
    const report = await runIndexRefresh(args.slice(2), options.cwd ?? process.cwd(), options.signal);
    if (report.totals.errors) process.exit(1);
    return;
  }
  const started = process.hrtime.bigint();
  const registry = await initRouter();
  // Normalize `help <command>` into the same non-executing help path.
  const routedArgs = args[0] === 'help' && args[1] && !args[1].startsWith('-')
    ? [args[1], ...args.slice(2), '--help']
    : args;
  const [rawCommand, ...commandArgs] = routedArgs;

  // No command - show help
  if (!rawCommand) {
    const helpHandler = registry.handlerMap.get('help');
    if (helpHandler) {
      const ctx = await buildContext([], args, options);
      await helpHandler.execute(ctx);
    }
    return;
  }

  // Resolve command (handles aliases)
  const commandId = registry.registry.resolveCommand(rawCommand);

  if (!commandId) {
    // Fallthrough: check for addon-contributed CLI extensions
    const cwd = options.cwd || process.cwd();
    const frameworkRoot = await getFrameworkRoot();
    const extResult = await tryExecuteCliExtension(rawCommand, commandArgs, cwd, frameworkRoot);
    if (extResult) {
      if (extResult.message) {
        if (extResult.exitCode !== 0) {
          ui.error(extResult.message);
        } else {
          ui.info(extResult.message);
        }
      }
      if (rawCommand === 'flow-release') {
        maybeCelebrateMilestone(cwd, 'first_release');
      } else if (rawCommand === 'flow-deploy-to-production') {
        maybeCelebrateMilestone(cwd, 'first_production_deploy');
      } else if (/^flow-[a-z0-9-]+-to-[a-z0-9-]+$/.test(rawCommand)) {
        maybeCelebrateMilestone(cwd, 'first_phase_transition');
      }
      await logCommandInvocation({
        command: rawCommand,
        args: commandArgs,
        cwd,
        frameworkRoot,
        started,
        exitStatus: extResult.exitCode,
      });
      if (extResult.exitCode !== 0) {
        process.exit(extResult.exitCode);
      }
      return;
    }

    ui.error(`Unknown command: ${rawCommand}`);
    ui.info('Run `aiwg help` for usage information.');
    process.exit(1);
  }

  // Get handler
  const handler = registry.handlerMap.get(commandId);

  if (!handler) {
    ui.error(`No handler found for command: ${commandId}`);
    process.exit(1);
  }

  // Help must be intercepted before hooks and the normal handler path. Some
  // commands mutate project or installation state, so passing an unrecognised
  // help flag through to execute() is unsafe (#174).
  if (commandArgs.includes('--help') || commandArgs.includes('-h')) {
    const ctx = await buildContext(commandArgs, args, options);
    if (handler.help) {
      const result = await handler.help(ctx);
      if (result.message) {
        if (result.rawOutput) {
          process.stdout.write(result.message.endsWith('\n') ? result.message : `${result.message}\n`);
        } else if (result.exitCode !== 0) {
          ui.error(result.message);
        } else {
          ui.info(result.message);
        }
      }
      if (result.exitCode !== 0) process.exit(result.exitCode);
    } else {
      ui.info(`No detailed help for \`aiwg ${commandId}\`. Run \`aiwg help\` for the command overview.`);
    }
    return;
  }

  // Build context for handler and hooks
  const ctx = await buildContext(commandArgs, args, options);

  // Build hook context
  const hookCtx: HookContext = {
    event: 'pre-command',
    command: commandId,
    args: commandArgs,
    cwd: ctx.cwd,
    frameworkRoot: ctx.frameworkRoot,
  };

  try {
    // Execute pre-command hooks
    const preResult = await hookExecutor.execute('pre-command', hookCtx);

    // Check if execution was blocked
    if (preResult.blocked) {
      ui.error(preResult.message || `Command blocked by hook: ${preResult.blockingHook}`);
      await logCommandInvocation({
        command: commandId,
        args: commandArgs,
        cwd: ctx.cwd,
        frameworkRoot: ctx.frameworkRoot,
        started,
        exitStatus: 1,
      });
      process.exit(1);
    }

    // Report hook errors (but don't block execution)
    if (preResult.errors.length > 0) {
      for (const { hook, error: hookError } of preResult.errors) {
        ui.warn(`Hook ${hook} failed: ${hookError.message}`);
      }
    }

    // Apply modifications to context if any
    if (Object.keys(preResult.modifications).length > 0) {
      // Hooks can modify args, but we keep the handler context simple
      // Modifications are available in hookCtx.data for post-command hooks
      hookCtx.data = preResult.modifications;
    }

    // Execute handler
    const result = await handler.execute(ctx);

    if (commandId === 'use' && result.exitCode === 0 && !ctx.dryRun) {
      const targetIdx = commandArgs.findIndex((arg) => arg === '--target');
      const projectDir = targetIdx >= 0 && commandArgs[targetIdx + 1] ? commandArgs[targetIdx + 1] : ctx.cwd;
      maybeCelebrateMilestone(projectDir, 'first_deploy');
    }

    // Execute post-command hooks
    const postHookCtx: HookContext = {
      event: 'post-command',
      command: commandId,
      args: commandArgs,
      cwd: ctx.cwd,
      frameworkRoot: ctx.frameworkRoot,
      data: {
        ...hookCtx.data,
        exitCode: result.exitCode,
        message: result.message,
      },
    };

    const postResult = await hookExecutor.execute('post-command', postHookCtx);

    // Report post-command hook errors
    if (postResult.errors.length > 0) {
      for (const { hook, error: hookError } of postResult.errors) {
        ui.warn(`Post-command hook ${hook} failed: ${hookError.message}`);
      }
    }

    // Output message if present
    if (result.message) {
      if (result.rawOutput) {
        process.stdout.write(result.message.endsWith('\n') ? result.message : `${result.message}\n`);
      } else if (result.exitCode !== 0) {
        ui.error(result.message);
      } else {
        ui.info(result.message);
      }
    }

    await logCommandInvocation({
      command: commandId,
      args: commandArgs,
      cwd: ctx.cwd,
      frameworkRoot: ctx.frameworkRoot,
      started,
      exitStatus: result.exitCode,
    });

    if (result.exitCode !== 0) {
      process.exit(result.exitCode);
    }
  } catch (error) {
    // Execute on-error hooks
    const errorHookCtx: HookContext = {
      event: 'on-error',
      command: commandId,
      args: commandArgs,
      cwd: ctx.cwd,
      frameworkRoot: ctx.frameworkRoot,
      error: error instanceof Error ? error : new Error(String(error)),
    };

    await hookExecutor.execute('on-error', errorHookCtx);
    await logCommandInvocation({
      command: commandId,
      args: commandArgs,
      cwd: ctx.cwd,
      frameworkRoot: ctx.frameworkRoot,
      started,
      exitStatus: 1,
    });

    // Re-throw error
    throw error;
  }
}

async function logCommandInvocation(input: {
  command: string;
  args: string[];
  cwd: string;
  frameworkRoot: string;
  started: bigint;
  exitStatus: number;
}): Promise<void> {
  const durationMs = Number(process.hrtime.bigint() - input.started) / 1_000_000;
  try {
    await maybeAppendCommandLog({
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      frameworkRoot: input.frameworkRoot,
      durationMs,
      exitStatus: input.exitStatus,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ui.warn(`command-log append failed: ${msg}`);
  }

  try {
    await maybeAppendSkillUsage({
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      frameworkRoot: input.frameworkRoot,
      durationMs,
      exitStatus: input.exitStatus,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ui.warn(`skill-usage append failed: ${msg}`);
  }
}

/**
 * Build handler context
 *
 * Constructs the context object passed to command handlers, including
 * command arguments, working directory, and framework root path.
 *
 * @param args - Command arguments (after command name)
 * @param rawArgs - Raw arguments including command name
 * @param options - Execution options
 * @returns Handler context
 */
async function buildContext(
  args: string[],
  rawArgs: string[],
  options: { cwd?: string; signal?: AbortSignal }
): Promise<HandlerContext> {
  const frameworkRoot = await getFrameworkRoot({ createIfMissing: !args.includes('--dry-run') });
  const ctx: HandlerContext = {
    args,
    rawArgs,
    cwd: options.cwd || process.cwd(),
    frameworkRoot,
    dryRun: args.includes('--dry-run'),
  };
  // Only attach signal when one is supplied (keeps the field optional for
  // test fixtures that construct bare contexts).
  if (options.signal) ctx.signal = options.signal;
  return ctx;
}

// Export for testing
export { cachedRegistry };
