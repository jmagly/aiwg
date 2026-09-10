/**
 * Ralph Command Handlers
 *
 * CLI command handlers for Ralph iterative execution loop.
 * Uses external Ralph supervisor for crash-resilient background execution.
 * Falls back to internal scripts when --internal flag is used.
 *
 * @implements @.aiwg/architecture/decisions/ADR-001-unified-extension-system.md
 * @implements @.aiwg/working/issue-ralph-external-completion.md
 * @tests @test/unit/cli/handlers/ralph.test.ts
 * @issue #33, #275
 */

import { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import { createScriptRunner } from './script-runner.js';
import {
  launchExternalRalph,
  getLoopStatuses,
  abortLoop,
  resumeLoop,
  attachToLoopOutput,
  RalphLaunchOptions,
} from './ralph-launcher.js';
import { handlerResultFromError } from '../errors.js';

/** Parse a complete positive decimal value without truncating counter limits. */
function parsePositiveLimit(raw: string | undefined, integer = false): number | undefined {
  if (typeof raw !== 'string' || !/^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 && (!integer || Number.isSafeInteger(value)) ? value : undefined;
}

/**
 * Parse Ralph command arguments
 */
function parseRalphArgs(args: string[]): {
  objective?: string;
  completionCriteria?: string;
  maxIterations?: number;
  model?: string;
  budget?: number;
  maxTotalTokens?: number;
  maxOutputTokens?: number;
  maxToolCalls?: number;
  maxTotalCost?: number;
  maxWallClockMinutes?: number;
  explorationQuota?: number;
  budgetStopPolicy?: 'completion-wins' | 'budget-wins';
  timeout?: number;
  mcpConfig?: string;
  giteaIssue?: boolean;
  memory?: number | string;
  crossTask?: boolean;
  enableAnalytics?: boolean;
  enableBestOutput?: boolean;
  enableEarlyStopping?: boolean;
  internal?: boolean;
  help?: boolean;
  loopId?: string;
  provider?: string;
  dangerous?: boolean;
  params?: string;
  attach?: boolean;
  verbose?: boolean;
  logFile?: string;
  /** Numeric flags present but not a positive number — dispatch must refuse (#1770) */
  invalidFlags: string[];
  /** Unrecognized --flags — refused so budget typos can't silently launch an unbounded loop (#1770) */
  unknownFlags: string[];
} {
  const result: ReturnType<typeof parseRalphArgs> = { invalidFlags: [], unknownFlags: [] };
  let i = 0;

  // Present-but-invalid numeric values are a hard usage error: an operator who
  // typed --max-total-cost expects a ceiling to exist (#1770).
  const positiveNumber = (flag: string, raw: string | undefined, integer = false): number | undefined => {
    const value = parsePositiveLimit(raw, integer);
    if (value === undefined) {
      result.invalidFlags.push(`${flag} (got '${raw ?? ''}')`);
      return undefined;
    }
    return value;
  };

  while (i < args.length) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--internal') {
      result.internal = true;
    } else if (arg === '--completion' || arg === '-c') {
      result.completionCriteria = args[++i];
    } else if (arg === '--max-iterations') {
      result.maxIterations = positiveNumber('--max-iterations', args[++i], true);
    } else if (arg === '--model') {
      result.model = args[++i];
    } else if (arg === '--budget') {
      result.budget = positiveNumber('--budget', args[++i]);
    } else if (arg === '--max-total-tokens') {
      result.maxTotalTokens = positiveNumber('--max-total-tokens', args[++i], true);
    } else if (arg === '--max-output-tokens') {
      result.maxOutputTokens = positiveNumber('--max-output-tokens', args[++i], true);
    } else if (arg === '--max-tool-calls') {
      result.maxToolCalls = positiveNumber('--max-tool-calls', args[++i], true);
    } else if (arg === '--max-total-cost') {
      result.maxTotalCost = positiveNumber('--max-total-cost', args[++i]);
    } else if (arg === '--max-wall-clock-minutes') {
      result.maxWallClockMinutes = positiveNumber('--max-wall-clock-minutes', args[++i]);
    } else if (arg === '--exploration-quota') {
      result.explorationQuota = positiveNumber('--exploration-quota', args[++i], true);
    } else if (arg === '--budget-stop-policy') {
      const policy = args[++i];
      if (policy === 'completion-wins' || policy === 'budget-wins') {
        result.budgetStopPolicy = policy;
      } else {
        result.invalidFlags.push(`--budget-stop-policy (got '${policy ?? ''}', expected completion-wins|budget-wins)`);
      }
    } else if (arg === '--timeout') {
      result.timeout = positiveNumber('--timeout', args[++i], true);
    } else if (arg === '--mcp-config') {
      result.mcpConfig = args[++i];
    } else if (arg === '--gitea-issue') {
      result.giteaIssue = true;
    } else if (arg === '--memory' || arg === '-m') {
      const memArg = args[++i];
      result.memory = isNaN(parseInt(memArg)) ? memArg : parseInt(memArg, 10);
    } else if (arg === '--cross-task') {
      result.crossTask = true;
    } else if (arg === '--no-cross-task') {
      result.crossTask = false;
    } else if (arg === '--no-analytics') {
      result.enableAnalytics = false;
    } else if (arg === '--no-best-output') {
      result.enableBestOutput = false;
    } else if (arg === '--no-early-stopping') {
      result.enableEarlyStopping = false;
    } else if (arg === '--loop-id') {
      result.loopId = args[++i];
    } else if (arg === '--provider') {
      result.provider = args[++i];
    } else if (arg === '--dangerous') {
      result.dangerous = true;
    } else if (arg === '--params') {
      result.params = args[++i];
    } else if (arg === '--attach') {
      result.attach = true;
    } else if (arg === '--verbose' || arg === '-v') {
      result.verbose = true;
    } else if (arg === '--log-file') {
      result.logFile = args[++i];
    } else if (!arg.startsWith('-') && !result.objective) {
      result.objective = arg;
    } else if (arg.startsWith('--')) {
      // Unknown flags were previously dropped silently — an operator typo on a
      // budget flag launched a detached loop with NO ceiling at all (#1770).
      result.unknownFlags.push(arg);
    }

    i++;
  }

  return result;
}

/**
 * Agent Loop Handler
 *
 * Executes iterative task loops with automatic completion detection.
 * By default, launches as a detached background process that survives terminal closure.
 * Use --internal flag for the legacy foreground execution.
 */
export class RalphHandler implements CommandHandler {
  id = 'ralph';
  name = 'Agent Loop';
  description = 'Execute iterative task loop with automatic completion detection';
  category = 'ralph' as const;
  aliases = ['ralph', '-ralph', '--ralph'];

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const parsed = parseRalphArgs(ctx.args);

    // Show help
    if (parsed.help) {
      return {
        exitCode: 0,
        message: this.getHelpText(),
      };
    }

    // Use internal (foreground) mode if requested
    if (parsed.internal) {
      const runner = createScriptRunner(ctx.frameworkRoot);
      return runner.run('tools/ralph/ralph-cli.mjs', ctx.args.filter((a) => a !== '--internal'));
    }

    // Validate required arguments
    if (!parsed.objective) {
      return {
        exitCode: 1,
        message: 'Error: Objective is required.\n\nUsage: aiwg ralph "<objective>" --completion "<criteria>"',
      };
    }

    if (!parsed.completionCriteria) {
      return {
        exitCode: 1,
        message: 'Error: Completion criteria is required.\n\nUsage: aiwg ralph "<objective>" --completion "<criteria>"',
      };
    }

    // Refuse rather than launch a loop that is missing controls the operator
    // believes are active (#1770)
    if (parsed.invalidFlags.length > 0) {
      return {
        exitCode: 1,
        message: `Error: Invalid numeric flag value(s): ${parsed.invalidFlags.join(', ')}. Budget/quota flags require positive numbers. Loop not launched.`,
      };
    }
    if (parsed.unknownFlags.length > 0) {
      return {
        exitCode: 1,
        message: `Error: Unknown flag(s): ${parsed.unknownFlags.join(', ')}. See 'aiwg ralph --help'. Loop not launched.`,
      };
    }

    // Launch external Ralph as detached background process
    try {
      const options: RalphLaunchOptions = {
        objective: parsed.objective,
        completionCriteria: parsed.completionCriteria,
        maxIterations: parsed.maxIterations,
        model: parsed.model,
        budget: parsed.budget,
        maxTotalTokens: parsed.maxTotalTokens,
        maxOutputTokens: parsed.maxOutputTokens,
        maxToolCalls: parsed.maxToolCalls,
        maxTotalCost: parsed.maxTotalCost,
        maxWallClockMinutes: parsed.maxWallClockMinutes,
        explorationQuota: parsed.explorationQuota,
        budgetStopPolicy: parsed.budgetStopPolicy,
        timeout: parsed.timeout,
        mcpConfig: parsed.mcpConfig,
        giteaIssue: parsed.giteaIssue,
        memory: parsed.memory,
        crossTask: parsed.crossTask,
        enableAnalytics: parsed.enableAnalytics,
        enableBestOutput: parsed.enableBestOutput,
        enableEarlyStopping: parsed.enableEarlyStopping,
        loopId: parsed.loopId,
        provider: parsed.provider,
        dangerous: parsed.dangerous,
        params: parsed.params,
        verbose: parsed.verbose,
        logFile: parsed.logFile,
      };

      const result = await launchExternalRalph(ctx.frameworkRoot, process.cwd(), options);

      if (parsed.attach) {
        process.stdout.write(
          `✓ ${result.message}\n  PID: ${result.pid}\n  Loop ID: ${result.loopId}\n\n` +
          `Attaching to output... Press Ctrl+C to detach (loop keeps running).\n\n`
        );
        await attachToLoopOutput(process.cwd(), result.loopId);
        return { exitCode: 0, message: '' };
      }

      return {
        exitCode: 0,
        message: `✓ ${result.message}\n  PID: ${result.pid}\n  Loop ID: ${result.loopId}`,
      };
    } catch (error) {
        const result = handlerResultFromError(error);
        return { ...result, message: `Failed to launch Ralph: ${result.message}` };
      }
  }

  private getHelpText(): string {
    return `
Agent Loop - Crash-resilient iterative task execution

USAGE:
  aiwg ralph "<objective>" --completion "<criteria>" [options]
  aiwg ralph-status [--all]
  aiwg ralph-abort [--loop-id <id>]
  aiwg ralph-resume [--loop-id <id>]

ARGUMENTS:
  <objective>             Task objective (required)

OPTIONS:
  -c, --completion <str>  Completion criteria (required)
  --max-iterations <n>    Maximum iterations (default: 5)
  --model <model>         Claude model (default: claude-sonnet-4-6)
  --budget <usd>          Budget per iteration in USD (default: 5.0)
  --timeout <min>         Timeout per iteration in minutes (default: 60)

LFD LOOP CONTROLS (hard cumulative ceilings; loop stops with a best-output report):
  --max-total-tokens <n>      Hard total-token ceiling (when provider reports usage)
  --max-output-tokens <n>     Hard output-token ceiling (when provider reports usage)
  --max-tool-calls <n>        Hard tool-call ceiling (when provider reports usage)
  --max-total-cost <usd>      Hard cumulative spend ceiling (when provider reports cost)
  --max-wall-clock-minutes <m>  Hard cumulative wall-clock ceiling (always observable)
  --exploration-quota <k>     Require a structural strategy variant after k flat
                              (non-improving) cycles. OFF unless declared — there
                              is no default k; each loop declares its own.
  --budget-stop-policy <p>    completion-wins (default): a task completing on the
                              ceiling-crossing iteration reports success with the
                              crossing annotated. budget-wins: exhaustion always
                              terminates as budget_exhausted.
  --mcp-config <json>     MCP server configuration JSON
  --gitea-issue           Create/link Gitea issue for tracking
  --loop-id <id>          Use specific loop ID
  --provider <name>       Agent system to use (default: claude)
                          Spawnable: claude, opencode, codex, hermes
  --dangerous             Enable unrestricted mode for the selected provider.
                          Passes the provider's native flag (e.g. --dangerously-skip-permissions
                          for claude/opencode,
                          --dangerously-bypass-approvals-and-sandbox for codex). No effect if the
                          provider doesn't have a dangerous mode flag.
  --params "<args>"       Pass arbitrary args verbatim to the agent binary.
                          Appended after all other flags. Quoted segments preserved.
  --attach                Stay attached to the loop's output after launch.
                          Press Ctrl+C to detach (loop keeps running in background).
  -v, --verbose           Enable verbose per-iteration detail in the daemon output:
                          assessment results, planned strategy, and prompt preview.
  --log-file <path>       Write a timestamped copy of all daemon output to <path>
                          (in addition to the per-loop daemon-output.log). Useful
                          for capturing a single readable log across all iterations.
                          Use 'aiwg ralph-attach' to re-attach later.

RESEARCH-BACKED OPTIONS (REF-015, REF-021):
  -m, --memory <n>        Memory capacity Ω (default: 3)
  --cross-task            Enable cross-task learning (default: true)
  --no-cross-task         Disable cross-task learning
  --no-analytics          Disable iteration analytics
  --no-best-output        Disable best output selection
  --no-early-stopping     Disable early stopping on high confidence

FLAGS:
  --internal              Run in foreground (legacy mode)
  -h, --help              Show this help message

EXAMPLES:
  # Start background loop
  aiwg ralph "Fix all failing tests" --completion "npm test passes"

  # Check status
  aiwg ralph-status

  # Abort running loop
  aiwg ralph-abort
`;
  }
}

/**
 * Ralph Status Handler
 *
 * Shows current Agent loop status and iteration history.
 * Works across terminal sessions by reading from the loop registry.
 */
export class RalphStatusHandler implements CommandHandler {
  id = 'ralph-status';
  name = 'Ralph Status';
  description = 'Show Agent loop status and iteration history';
  category = 'ralph' as const;
  aliases = ['ralph-status'];

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const showAll = ctx.args.includes('--all') || ctx.args.includes('-a');
    const statuses = getLoopStatuses(process.cwd());

    if (statuses.length === 0) {
      return {
        exitCode: 0,
        message: 'No Agent loops found.',
      };
    }

    // Sort by most recent first
    statuses.sort((a, b) => new Date(b.lastUpdate).getTime() - new Date(a.lastUpdate).getTime());

    // Filter to running only unless --all
    const displayed = showAll ? statuses : statuses.filter((s) => s.status === 'running');

    if (displayed.length === 0) {
      return {
        exitCode: 0,
        message: 'No running Agent loops. Use --all to see completed/failed loops.',
      };
    }

    const lines: string[] = ['Agent Loop Status', '=================', ''];

    for (const loop of displayed) {
      const statusIcon =
        loop.status === 'running'
          ? '🔄'
          : loop.status === 'completed'
            ? '✅'
            : loop.status === 'aborted'
              ? '⏹️'
              : '❌';

      lines.push(`${statusIcon} ${loop.loopId}`);
      lines.push(`   Status: ${loop.status.toUpperCase()}`);
      lines.push(`   Progress: ${loop.iteration}/${loop.maxIterations} iterations`);
      lines.push(`   Objective: ${loop.objective.slice(0, 60)}${loop.objective.length > 60 ? '...' : ''}`);
      lines.push(`   Started: ${loop.startedAt}`);
      if (loop.status === 'running') {
        lines.push(`   PID: ${loop.pid}`);
      }
      if (loop.outputFile) {
        lines.push(`   Daemon log: ${loop.outputFile}`);
      }
      if (loop.sessionStdoutFile) {
        lines.push(`   Session stdout: ${loop.sessionStdoutFile}`);
      }
      if (loop.sessionStderrFile) {
        lines.push(`   Session stderr: ${loop.sessionStderrFile}`);
      }
      lines.push('');
    }

    if (!showAll && statuses.length > displayed.length) {
      lines.push(`(${statuses.length - displayed.length} completed/failed loops hidden. Use --all to show.)`);
    }

    return {
      exitCode: 0,
      message: lines.join('\n'),
    };
  }
}

/**
 * Ralph Abort Handler
 *
 * Aborts currently running Agent loop by killing the background process.
 * Works across terminal sessions.
 */
export class RalphAbortHandler implements CommandHandler {
  id = 'ralph-abort';
  name = 'Ralph Abort';
  description = 'Abort currently running Agent loop';
  category = 'ralph' as const;
  aliases = ['ralph-abort'];

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    // Parse --loop-id if provided
    let loopId: string | undefined;
    const loopIdIndex = ctx.args.indexOf('--loop-id');
    if (loopIdIndex !== -1 && ctx.args[loopIdIndex + 1]) {
      loopId = ctx.args[loopIdIndex + 1];
    }

    const result = abortLoop(process.cwd(), loopId);

    return {
      exitCode: result.success ? 0 : 1,
      message: result.message,
    };
  }
}

/**
 * Ralph Resume Handler
 *
 * Resumes previously interrupted Agent loop as a new background process.
 * Works across terminal sessions.
 */
export class RalphResumeHandler implements CommandHandler {
  id = 'ralph-resume';
  name = 'Ralph Resume';
  description = 'Resume previously aborted Agent loop';
  category = 'ralph' as const;
  aliases = ['ralph-resume'];

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    // Parse arguments
    let loopId: string | undefined;
    let maxIterations: number | undefined;

    for (let i = 0; i < ctx.args.length; i++) {
      const arg = ctx.args[i];
      if (arg === '--loop-id' && ctx.args[i + 1]) {
        loopId = ctx.args[++i];
      } else if (arg === '--max-iterations') {
        maxIterations = parsePositiveLimit(ctx.args[++i], true);
        if (maxIterations === undefined) {
          return { exitCode: 1, message: 'Error: --max-iterations requires a positive safe integer. Loop not resumed.' };
        }
      }
    }

    try {
      const result = await resumeLoop(ctx.frameworkRoot, process.cwd(), loopId, { maxIterations });

      return {
        exitCode: 0,
        message: `✓ ${result.message}\n  PID: ${result.pid}\n  Loop ID: ${result.loopId}`,
      };
    } catch (error) {
        const result = handlerResultFromError(error);
        return { ...result, message: `Failed to resume: ${result.message}` };
      }
  }
}

/**
 * Create Ralph handler instance
 */
export function createRalphHandler(): CommandHandler {
  return new RalphHandler();
}

/**
 * Create Ralph Status handler instance
 */
export function createRalphStatusHandler(): CommandHandler {
  return new RalphStatusHandler();
}

/**
 * Create Ralph Abort handler instance
 */
export function createRalphAbortHandler(): CommandHandler {
  return new RalphAbortHandler();
}

/**
 * Create Ralph Resume handler instance
 */
export function createRalphResumeHandler(): CommandHandler {
  return new RalphResumeHandler();
}

/**
 * Ralph External handler
 *
 * Crash-resilient external loop with full state persistence.
 * Equivalent to `ralph` with crash-recovery enabled by default.
 */
export const ralphExternalHandler: CommandHandler = {
  id: 'agent-loop-ext',
  name: 'Agent Loop External',
  description: 'Crash-resilient external loop with state persistence and CI/CD integration',
  category: 'ralph',
  aliases: ['ralph-external', '--ralph-external', '--agent-loop-ext'],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const runner = createScriptRunner(ctx.frameworkRoot);
    // Delegate to the external Ralph supervisor script
    return runner.run('tools/ralph-external/index.mjs', ctx.args);
  },
};

/**
 * Ralph Memory handler
 *
 * Manage semantic memory entries for Agent loop learning.
 */
export const ralphMemoryHandler: CommandHandler = {
  id: 'ralph-memory',
  name: 'Ralph Memory',
  description: 'Manage Ralph semantic memory entries (list, query, clear)',
  category: 'ralph',
  aliases: ['--ralph-memory'],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const runner = createScriptRunner(ctx.frameworkRoot);
    return runner.run('tools/ralph-external/memory-manager.mjs', ['--cli', ...ctx.args]);
  },
};

/**
 * Ralph Config handler
 *
 * View and set Agent loop configuration values.
 */
export const ralphConfigHandler: CommandHandler = {
  id: 'ralph-config',
  name: 'Ralph Config',
  description: 'View and configure Agent loop settings (show, set, reset, preset)',
  category: 'ralph',
  aliases: ['--ralph-config'],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const runner = createScriptRunner(ctx.frameworkRoot);
    return runner.run('tools/ralph-external/orchestrator.mjs', ['--config', ...ctx.args]);
  },
};

/**
 * Ralph Attach Handler
 *
 * Re-attaches to a running Agent loop's live output stream.
 * Press Ctrl+C to detach — loop continues running in background.
 */
export class RalphAttachHandler implements CommandHandler {
  id = 'ralph-attach';
  name = 'Ralph Attach';
  description = 'Attach to a running Agent loop\'s live output stream';
  category = 'ralph' as const;
  aliases = ['ralph-attach'];

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    let loopId: string | undefined;
    const loopIdIndex = ctx.args.indexOf('--loop-id');
    if (loopIdIndex !== -1 && ctx.args[loopIdIndex + 1]) {
      loopId = ctx.args[loopIdIndex + 1];
    }

    try {
      process.stdout.write(
        `Attaching to loop output${loopId ? ` (${loopId})` : ''}...\n` +
        `Press Ctrl+C to detach (loop keeps running in background).\n\n`
      );
      await attachToLoopOutput(process.cwd(), loopId);
      return { exitCode: 0, message: '' };
    } catch (error) {
        const result = handlerResultFromError(error);
        return { ...result, message: `Failed to attach: ${result.message}` };
      }
  }
}

/**
 * Export handler instances
 */
export const ralphHandler = new RalphHandler();
export const ralphStatusHandler = new RalphStatusHandler();
export const ralphAbortHandler = new RalphAbortHandler();
export const ralphResumeHandler = new RalphResumeHandler();
export const ralphAttachHandler = new RalphAttachHandler();

/**
 * Export all Ralph handlers as array for easy registration
 */
export const ralphHandlers: CommandHandler[] = [
  ralphHandler,
  ralphStatusHandler,
  ralphAbortHandler,
  ralphResumeHandler,
  ralphAttachHandler,
  ralphExternalHandler,
  ralphMemoryHandler,
  ralphConfigHandler,
];
