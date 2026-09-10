#!/usr/bin/env node

/**
 * External Ralph Loop CLI
 *
 * Entry point for the external Ralph supervisor that provides
 * crash-resilient, long-running iterative task execution.
 *
 * Usage:
 *   node index.mjs "objective" --completion "criteria" [options]
 *   node index.mjs --resume [--max-iterations N]
 *   node index.mjs --status
 *   node index.mjs --abort
 *
 * @implements @.aiwg/requirements/design-ralph-external.md
 */

import { resolve, join } from 'path';
import { createWriteStream, existsSync, readFileSync } from 'fs';
import { Orchestrator } from './orchestrator.mjs';
import { StateManager } from './state-manager.mjs';
import { isClaudeAvailable, getClaudeVersion } from './session-launcher.mjs';
import { createProvider, hasProvider, ensureProvidersRegistered } from './lib/provider-adapter.mjs';
import { MemoryManager } from './memory-manager.mjs';
import { BestOutputTracker } from './best-output-tracker.mjs';
import { IterationAnalytics } from './iteration-analytics.mjs';
import { EarlyStopping } from './early-stopping.mjs';
import { CrossTaskLearner } from './cross-task-learner.mjs';

/**
 * Parse command line arguments
 * @param {string[]} args
 * @returns {Object}
 */
function parseArgs(args) {
  const options = {
    objective: null,
    completionCriteria: null,
    maxIterations: 5,
    // #1450 P0: explicit 500K-context variant. Was 'opus' — under a 1M-context
    // parent (claude-opus-4-7[1m]) the bare alias inherits 1M attributes, and
    // most Claude accounts (Pro, Team standard) lack 1M access. claude-sonnet-4-6
    // is broadly available and dramatically cheaper for headless dispatch.
    // See also #1442 (skill frontmatter pinning) and agent-deployment rule.
    model: 'claude-sonnet-4-6',
    // #1450 P0: cache-creation cost alone for a fresh claude headless session
    // is ~$1.60 sonnet / ~$3.90 opus. $2.0 per-iter was smaller than the cache
    // creation itself, causing every mission to abort at iteration 1.
    budgetPerIteration: 5.0,
    budgetLimits: {},
    // Declared-K policy (#1770, operator decision 2026-07-11): the exploration
    // quota is OFF unless a loop explicitly declares its K via
    // --exploration-quota. There is no default K.
    explorationQuota: { enabled: false },
    // Stop-semantics policy (#1767): completion-wins (default) reports success
    // when the completing iteration also crosses a budget ceiling;
    // budget-wins keeps the strict exhaustion-terminates ordering.
    budgetStopPolicy: 'completion-wins',
    // Eval harness (LFD Track 3, #1776): opt-in via --eval-harness <path>.
    evalHarness: null,
    timeoutMinutes: 60,
    mcpConfig: null,
    giteaIssue: false,
    resume: false,
    status: false,
    abort: false,
    help: false,
    // New research-backed options (#149, #154, #167, #168, #170)
    memory: 3,                    // Memory capacity Ω (#170)
    crossTask: true,              // Cross-task learning (#154)
    enableAnalytics: true,        // Iteration analytics (#167)
    enableBestOutput: true,       // Best output tracking (#168)
    enableEarlyStopping: true,    // Early stopping (#149)
    provider: 'claude',           // CLI provider (claude, codex, opencode, factory, pi, omp, deepseek-harness)
    thinking: null,
    tools: null,
    verbose: false,               // Verbose per-iteration detail
    logFile: null,                // Optional log file path
    allowExhaustedResume: false,  // Explicitly permit resuming a budget-exhausted loop (#1765)
    // Flags the user actually typed — resume must only override persisted
    // loop config for values that were explicitly provided (#1765)
    _explicit: new Set(),
  };

  // A numeric flag that is present but not a positive number is a hard usage
  // error — NaN limits used to be accepted and then silently never fire (#1770)
  const positiveNumber = (flag, raw, { integer = false } = {}) => {
    // Consume the whole decimal value; prefix parsers silently truncate typos
    // and fractional counters. Exponents are allowed, non-decimal bases are not.
    const decimal = typeof raw === 'string' && /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw);
    const value = decimal ? Number(raw) : NaN;
    if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) {
      console.error(`Error: ${flag} requires a positive number (got '${raw}')`);
      process.exit(1);
    }
    return value;
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--resume' || arg === '-r') {
      options.resume = true;
    } else if (arg === '--status' || arg === '-s') {
      options.status = true;
    } else if (arg === '--abort') {
      options.abort = true;
    } else if (arg === '--completion' || arg === '-c') {
      options.completionCriteria = args[++i];
    } else if (arg === '--max-iterations') {
      options.maxIterations = positiveNumber('--max-iterations', args[++i], { integer: true });
      options._explicit.add('maxIterations');
    } else if (arg === '--model') {
      options.model = args[++i];
    } else if (arg === '--budget') {
      options.budgetPerIteration = positiveNumber('--budget', args[++i]);
      options._explicit.add('budgetPerIteration');
    } else if (arg === '--allow-exhausted-resume') {
      options.allowExhaustedResume = true;
    } else if (arg === '--max-total-tokens') {
      options.budgetLimits.total_tokens = positiveNumber('--max-total-tokens', args[++i], { integer: true });
    } else if (arg === '--max-output-tokens') {
      options.budgetLimits.output_tokens = positiveNumber('--max-output-tokens', args[++i], { integer: true });
    } else if (arg === '--max-tool-calls') {
      options.budgetLimits.tool_calls = positiveNumber('--max-tool-calls', args[++i], { integer: true });
    } else if (arg === '--max-total-cost') {
      options.budgetLimits.spend_usd = positiveNumber('--max-total-cost', args[++i]);
    } else if (arg === '--max-wall-clock-minutes') {
      options.budgetLimits.wall_clock_minutes = positiveNumber('--max-wall-clock-minutes', args[++i]);
    } else if (arg === '--exploration-quota') {
      options.explorationQuota = { enabled: true, k: positiveNumber('--exploration-quota', args[++i], { integer: true }) };
      options._explicit.add('explorationQuota');
    } else if (arg === '--budget-stop-policy') {
      const policy = args[++i];
      if (policy !== 'completion-wins' && policy !== 'budget-wins') {
        console.error(`Error: --budget-stop-policy must be 'completion-wins' or 'budget-wins' (got '${policy}')`);
        process.exit(1);
      }
      options.budgetStopPolicy = policy;
      options._explicit.add('budgetStopPolicy');
    } else if (arg === '--eval-harness') {
      // Path to an EvalHarnessContract JSON (LFD Track 3, #1776).
      const harnessPath = args[++i];
      try {
        options.evalHarness = JSON.parse(readFileSync(harnessPath, 'utf8'));
      } catch (err) {
        console.error(`Error: --eval-harness could not read/parse '${harnessPath}': ${err.message}`);
        process.exit(1);
      }
    } else if (arg === '--timeout') {
      options.timeoutMinutes = positiveNumber('--timeout', args[++i], { integer: true });
    } else if (arg === '--mcp-config') {
      options.mcpConfig = JSON.parse(args[++i]);
    } else if (arg === '--gitea-issue') {
      options.giteaIssue = true;
    } else if (arg === '--memory' || arg === '-m') {
      const memArg = args[++i];
      options.memory = isNaN(parseInt(memArg)) ? memArg : parseInt(memArg, 10);
    } else if (arg === '--cross-task') {
      options.crossTask = true;
    } else if (arg === '--no-cross-task') {
      options.crossTask = false;
    } else if (arg === '--no-analytics') {
      options.enableAnalytics = false;
    } else if (arg === '--no-best-output') {
      options.enableBestOutput = false;
    } else if (arg === '--no-early-stopping') {
      options.enableEarlyStopping = false;
    } else if (arg === '--provider') {
      options.provider = args[++i];
    } else if (arg === '--thinking') {
      options.thinking = args[++i];
    } else if (arg === '--tools') {
      options.tools = args[++i].split(',').map(value => value.trim()).filter(Boolean);
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--log-file') {
      options.logFile = args[++i];
    } else if (!arg.startsWith('-') && !options.objective) {
      options.objective = arg;
    }

    i++;
  }

  return options;
}

/**
 * Tee all console output to a log file with timestamps.
 * Returns a cleanup function that closes the stream.
 * @param {string} logFilePath
 * @returns {() => void}
 */
function installConsoleTee(logFilePath) {
  const stream = createWriteStream(logFilePath, { flags: 'a' });

  function writeLine(level, args) {
    const ts = new Date().toISOString();
    const msg = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    stream.write(`${ts} [${level}] ${msg}\n`);
  }

  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);

  console.log = (...args) => { origLog(...args); writeLine('LOG', args); };
  console.error = (...args) => { origError(...args); writeLine('ERR', args); };
  console.warn = (...args) => { origWarn(...args); writeLine('WRN', args); };

  return () => stream.end();
}

/**
 * Print help message
 */
function printHelp() {
  console.log(`
External Ralph Loop - Crash-resilient iterative task execution

================================================================================
                           SECURITY WARNING
================================================================================
This tool spawns Claude Code with --dangerously-skip-permissions, which
BYPASSES ALL PERMISSION PROMPTS. Sessions can:

  - Read/write ANY file without confirmation
  - Execute ANY shell command without approval
  - Run for hours without human oversight

BEFORE USING: Read docs/ralph-external-security.md

REQUIRED PRECAUTIONS:
  - Clean git state (for rollback)
  - Set budget limits (--budget)
  - Set iteration limits (--max-iterations)
  - Monitor session progress
  - Be ready to abort if needed
================================================================================

USAGE:
  ralph-external "<objective>" --completion "<criteria>" [options]
  ralph-external --resume [options]
  ralph-external --status
  ralph-external --abort

ARGUMENTS:
  <objective>             Task objective (required for new loop)

OPTIONS:
  -c, --completion <str>  Completion criteria (required for new loop)
  --max-iterations <n>    Maximum external iterations (default: 5)
  --model <model>         Claude model variant (default: claude-sonnet-4-6, 500K)
                          Bare aliases (sonnet/opus) inherit parent context;
                          pinning a specific variant is required for headless.
  --budget <usd>          Budget per iteration in USD (default: 5.0)
                          Cache-creation cost alone is ~$1.60 sonnet, ~$3.90 opus
                          per fresh headless session — set higher for non-trivial
                          tasks or expect first-iteration budget aborts.
  --max-total-tokens <n>  Hard cumulative token ceiling. Stops with best-output
                          report when observable token use reaches the limit.
  --max-output-tokens <n> Hard cumulative output-token ceiling when observable.
  --max-tool-calls <n>    Hard cumulative tool-call ceiling.
  --max-total-cost <usd>  Hard cumulative cost ceiling when provider reports cost.
  --max-wall-clock-minutes <n>
                          Hard cumulative session-runtime ceiling in minutes.
  --exploration-quota <k> Require a structural strategy variant after k flat
                          non-terminal cycles. OFF unless declared — there is
                          no default k; each loop declares its own (#1770).
  --eval-harness <path>   Path to an eval-harness contract JSON (score/lint/
                          probe/status). Each iteration is scored by the
                          harness; a lint violation VOIDs the iteration and only
                          VOID-safe aggregate feedback reaches the agent. Under
                          execution-mode holdout-isolated, holdout isolation is
                          strict (#1776).
  --timeout <min>         Timeout per iteration in minutes (default: 60)
  --mcp-config <json>     MCP server configuration JSON
  --gitea-issue           Create/link Gitea issue for tracking
  --provider <name>       CLI provider: claude (default), codex, opencode, factory, pi, omp, deepseek-harness (dsh)
  --thinking <level>      Provider thinking level (Pi: off..max)
  --tools <names>         Comma-separated provider tool allow-list

RESEARCH-BACKED OPTIONS (REF-015, REF-021):
  -m, --memory <n|preset>  Memory capacity Ω: 1-10 or preset name
                          Presets: simple(1), moderate(3), complex(5), maximum(10)
                          Default: 3 (moderate)
  --cross-task            Enable cross-task learning (default: true)
  --no-cross-task         Disable cross-task learning
  --no-analytics          Disable iteration analytics
  --no-best-output        Disable best output selection (use final)
  --no-early-stopping     Disable early stopping on high confidence
  -v, --verbose           Enable verbose per-iteration detail (assessment,
                          strategy, prompt preview)
  --log-file <path>       Write timestamped log to file (in addition to stdout)

COMMANDS:
  -r, --resume            Resume interrupted loop. Persisted budget/quota config
                          is preserved; only explicitly passed flags override it.
                          Restored usage counters still count against ceilings.
  --allow-exhausted-resume  Explicitly permit resuming a loop whose declared
                          budget ceilings are already exhausted (pair with
                          raised --max-* limits)
  -s, --status            Show current loop status
  --abort                 Abort current loop
  -h, --help              Show this help message

EXAMPLES:
  # Start new loop
  ralph-external "Fix all failing tests" --completion "npm test passes"

  # With options
  ralph-external "Migrate to TypeScript" \\
    --completion "npx tsc --noEmit exits 0" \\
    --max-iterations 10 \\
    --budget 5.0

  # Resume interrupted loop
  ralph-external --resume --max-iterations 15

  # Check status
  ralph-external --status
`);
}

function formatLimitUsage(observed, limit, formatter = value => String(value)) {
  if (typeof observed !== 'number' || !Number.isFinite(observed)) {
    return 'unknown';
  }

  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return formatter(observed);
  }

  const percent = Math.min(999, (observed / limit) * 100);
  return `${formatter(observed)} / ${formatter(limit)} (${percent.toFixed(1)}%)`;
}

function formatNumber(value, digits = 2) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toFixed(digits)
    : 'N/A';
}

function formatTokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value).toLocaleString()
    : 'N/A';
}

function formatUsd(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? `$${value.toFixed(4)}`
    : 'N/A';
}

function loadStatusAnalytics(stateManager, loopId) {
  const analyticsPath = join(stateManager.getStateDir(), 'analytics', `${loopId}.json`);

  if (!existsSync(analyticsPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(analyticsPath, 'utf8'));
  } catch (error) {
    return { error: error.message, path: analyticsPath };
  }
}

function formatLfdStatus(state, analytics) {
  const limits = state.config?.budgetLimits || {};
  const limitEntries = Object.entries(limits)
    .filter(([, value]) => value !== undefined && value !== null && value !== '' && Number(value) > 0);

  if (!analytics) {
    const limitText = limitEntries.length > 0
      ? limitEntries.map(([name, value]) => `${name}=${value}`).join(', ')
      : 'none configured';
    const controls = state.lfdControls
      ? `\nStructural Variant: ${state.lfdControls.structuralVariantRequired ? 'required' : 'not required'} (${state.lfdControls.flatCycleCount || 0}/${state.lfdControls.explorationQuotaK || 'N/A'} flat cycles)`
      : '';

    return `LFD Controls:
  Budget Limits: ${limitText}
  Budget Usage:  No analytics recorded yet${controls}`;
  }

  if (analytics.error) {
    return `LFD Controls:
  Analytics:      unreadable (${analytics.path}: ${analytics.error})`;
  }

  const usage = analytics.budget_usage || {};
  const exhausted = Array.isArray(analytics.budget_stop_report?.budgets?.exhausted)
    ? analytics.budget_stop_report.budgets.exhausted
    : [];
  const bestByToken = (analytics.iterations || [])
    .filter(it => typeof it.quality_per_1k_tokens === 'number' && Number.isFinite(it.quality_per_1k_tokens))
    .reduce((best, curr) =>
      !best || curr.quality_per_1k_tokens > best.quality_per_1k_tokens ? curr : best,
    null);
  const bestByMinute = (analytics.iterations || [])
    .filter(it => typeof it.quality_per_minute === 'number' && Number.isFinite(it.quality_per_minute))
    .reduce((best, curr) =>
      !best || curr.quality_per_minute > best.quality_per_minute ? curr : best,
    null);
  const bestRandomLift = (analytics.iterations || [])
    .filter(it => it.baseline_comparison && typeof it.baseline_comparison.quality_lift === 'number')
    .reduce((best, curr) =>
      !best || curr.baseline_comparison.quality_lift > best.baseline_comparison.quality_lift ? curr : best,
    null);
  const bestRandomTokenLift = (analytics.iterations || [])
    .filter(it => it.baseline_comparison && typeof it.baseline_comparison.token_efficiency_lift === 'number')
    .reduce((best, curr) =>
      !best || curr.baseline_comparison.token_efficiency_lift > best.baseline_comparison.token_efficiency_lift ? curr : best,
    null);
  const bestRandomSpeedLift = (analytics.iterations || [])
    .filter(it => it.baseline_comparison && typeof it.baseline_comparison.speed_efficiency_lift === 'number')
    .reduce((best, curr) =>
      !best || curr.baseline_comparison.speed_efficiency_lift > best.baseline_comparison.speed_efficiency_lift ? curr : best,
    null);

  const structuralVariant = analytics.structural_variant_required || state.lfdControls?.structuralVariantRequired;
  const flatCycleCount = analytics.flat_cycle_count ?? state.lfdControls?.flatCycleCount ?? 0;
  const quotaK = state.lfdControls?.explorationQuotaK || state.config?.explorationQuota?.k || 'N/A';

  return `LFD Controls:
  Total Tokens:   ${formatLimitUsage(usage.total_tokens, Number(limits.total_tokens), formatTokenCount)}
  Output Tokens:  ${formatLimitUsage(usage.output_tokens, Number(limits.output_tokens), formatTokenCount)}
  Tool Calls:     ${formatLimitUsage(usage.tool_calls, Number(limits.tool_calls), formatTokenCount)}
  Spend:          ${formatLimitUsage(usage.spend_usd, Number(limits.spend_usd), formatUsd)}
  Runtime:        ${formatLimitUsage(usage.wall_clock_minutes, Number(limits.wall_clock_minutes), value => `${formatNumber(value, 2)} min`)}
  Budget Stop:    ${analytics.budget_exhausted ? 'exhausted' : 'not exhausted'}${exhausted.length ? ` (${exhausted.map(item => item.name).join(', ')})` : ''}
  Best / 1K Tok:  ${bestByToken ? `iteration ${bestByToken.iteration_number} (${formatNumber(bestByToken.quality_per_1k_tokens)})` : 'N/A'}
  Best / Minute:  ${bestByMinute ? `iteration ${bestByMinute.iteration_number} (${formatNumber(bestByMinute.quality_per_minute)})` : 'N/A'}
  Random Lift:    ${bestRandomLift ? `iteration ${bestRandomLift.iteration_number} (+${formatNumber(bestRandomLift.baseline_comparison.quality_lift)})` : 'N/A'}
  Random TokLift: ${bestRandomTokenLift ? `iteration ${bestRandomTokenLift.iteration_number} (+${formatNumber(bestRandomTokenLift.baseline_comparison.token_efficiency_lift)})` : 'N/A'}
  Random SpdLift: ${bestRandomSpeedLift ? `iteration ${bestRandomSpeedLift.iteration_number} (+${formatNumber(bestRandomSpeedLift.baseline_comparison.speed_efficiency_lift)})` : 'N/A'}
  Structural Var: ${structuralVariant ? 'required' : 'not required'} (${flatCycleCount}/${quotaK} flat cycles)`;
}

/**
 * Print status
 * @param {string} projectRoot
 */
function printStatus(projectRoot) {
  const stateManager = new StateManager(projectRoot);
  const state = stateManager.load();

  if (!state) {
    console.log('No external Ralph loop found.');
    return;
  }

  const analytics = loadStatusAnalytics(stateManager, state.loopId);

  console.log(`
External Ralph Loop Status
==========================

Loop ID:        ${state.loopId}
Status:         ${state.status}
Objective:      ${state.objective}
Criteria:       ${state.completionCriteria}

Progress:       ${state.currentIteration}/${state.maxIterations} iterations
Start Time:     ${state.startTime}
Last Update:    ${state.lastUpdate}

${formatLfdStatus(state, analytics)}

Iterations:
${state.iterations.map((iter, idx) => {
    const status = iter.status || 'unknown';
    const progress = iter.analysis?.completionPercentage || 0;
    return `  ${idx + 1}. ${status} (${progress}% progress)`;
  }).join('\n') || '  None yet'}

Learnings:
${state.accumulatedLearnings ? state.accumulatedLearnings.slice(0, 500) + '...' : '  None yet'}
`);
}

/**
 * Read the reproducibility execution mode from .aiwg/execution-mode.json.
 * Under `holdout-isolated` the eval harness enforces strict holdout isolation
 * (#1776). Defaults to 'default' when unset/unreadable.
 * @param {string} projectRoot
 * @returns {string}
 */
function readExecutionMode(projectRoot) {
  try {
    const cfg = JSON.parse(readFileSync(join(projectRoot, '.aiwg', 'execution-mode.json'), 'utf8'));
    return cfg.mode || 'default';
  } catch {
    return 'default';
  }
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);
  const options = parseArgs(args);
  const projectRoot = process.cwd();

  // Install log file tee before any other output
  let cleanupLogTee = null;
  if (options.logFile) {
    cleanupLogTee = installConsoleTee(options.logFile);
    console.log(`[External Ralph] Log file: ${options.logFile}`);
  }

  // Handle help
  if (options.help) {
    printHelp();
    process.exit(0);
  }

  // Handle status
  if (options.status) {
    printStatus(projectRoot);
    process.exit(0);
  }

  // Handle abort
  if (options.abort) {
    const stateManager = new StateManager(projectRoot);
    stateManager.clear();
    console.log('External Ralph loop aborted.');
    process.exit(0);
  }

  // Check provider availability
  await ensureProvidersRegistered();
  const providerName = options.provider || 'claude';
  if (!hasProvider(providerName)) {
    console.error(`Error: Unknown provider '${providerName}'. Available: claude, codex, opencode, factory, pi, omp, deepseek-harness (dsh)`);
    process.exit(1);
  }

  const adapter = createProvider(providerName);
  const providerAvailable = await adapter.isAvailable();
  if (!providerAvailable) {
    console.error(`Error: ${providerName} CLI not found. Please install it.`);
    process.exit(1);
  }

  const version = await adapter.getVersion();
  console.log(`${providerName} CLI version: ${version}`);

  const orchestrator = new Orchestrator(projectRoot);

  // Track if shutdown is in progress to prevent double-handling
  let shutdownInProgress = false;

  // Handle signals for graceful shutdown
  process.on('SIGINT', async () => {
    if (shutdownInProgress) {
      console.log('\n[External Ralph] Force quit requested');
      process.exit(1);
    }
    shutdownInProgress = true;
    console.log('\n[External Ralph] Received SIGINT, initiating graceful shutdown...');
    try {
      await orchestrator.gracefulShutdown();
    } catch (error) {
      console.error(`[External Ralph] Shutdown error: ${error.message}`);
    }
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    if (shutdownInProgress) {
      return;
    }
    shutdownInProgress = true;
    console.log('\n[External Ralph] Received SIGTERM, initiating graceful shutdown...');
    try {
      await orchestrator.gracefulShutdown();
    } catch (error) {
      console.error(`[External Ralph] Shutdown error: ${error.message}`);
    }
    process.exit(0);
  });

  try {
    let result;

    if (options.resume) {
      // Resume existing loop. Only pass overrides the user explicitly typed —
      // passing parse-time defaults here used to silently clobber the loop's
      // persisted budget/quota configuration on every resume (#1765).
      const resumeOverrides = {
        allowExhaustedResume: options.allowExhaustedResume,
      };
      if (options._explicit.has('maxIterations')) {
        resumeOverrides.maxIterations = options.maxIterations;
      }
      if (options._explicit.has('budgetPerIteration')) {
        resumeOverrides.budgetPerIteration = options.budgetPerIteration;
      }
      if (Object.keys(options.budgetLimits).length > 0) {
        resumeOverrides.budgetLimits = options.budgetLimits;
      }
      if (options._explicit.has('explorationQuota')) {
        resumeOverrides.explorationQuota = options.explorationQuota;
      }
      if (options._explicit.has('budgetStopPolicy')) {
        resumeOverrides.budgetStopPolicy = options.budgetStopPolicy;
      }
      result = await orchestrator.resume(resumeOverrides);
    } else {
      // Start new loop
      if (!options.objective) {
        console.error('Error: Objective is required. Use --help for usage.');
        process.exit(1);
      }

      if (!options.completionCriteria) {
        console.error('Error: Completion criteria is required. Use --completion.');
        process.exit(1);
      }

      result = await orchestrator.execute({
        objective: options.objective,
        completionCriteria: options.completionCriteria,
        maxIterations: options.maxIterations,
        model: options.model,
        budgetPerIteration: options.budgetPerIteration,
        timeoutMinutes: options.timeoutMinutes,
        budgetLimits: options.budgetLimits,
        explorationQuota: options.explorationQuota,
        budgetStopPolicy: options.budgetStopPolicy,
        evalHarness: options.evalHarness,
        executionMode: readExecutionMode(projectRoot),
        mcpConfig: options.mcpConfig,
        giteaIntegration: options.giteaIssue ? { enabled: true } : null,
        provider: options.provider,
        thinking: options.thinking,
        tools: options.tools,
        verbose: options.verbose,
      });
    }

    // Print result
    console.log(`\n[External Ralph] Loop completed:`);
    console.log(`  Success: ${result.success}`);
    console.log(`  Reason: ${result.reason}`);
    console.log(`  Iterations: ${result.iterations}`);
    console.log(`  Loop ID: ${result.loopId}`);

    if (cleanupLogTee) cleanupLogTee();
    process.exit(result.success ? 0 : 1);

  } catch (error) {
    console.error(`[External Ralph] Fatal error: ${error.message}`);
    if (cleanupLogTee) cleanupLogTee();
    process.exit(1);
  }
}

// Run main() only when executed directly (node index.mjs …), NOT when imported
// as a module. Without this guard, importing index.mjs to reach its exports
// (e.g. parseArgs in the buildArgs↔parseArgs contract test, #1774) would run
// main(), fail the no-objective check, and process.exit(1) — killing the caller.
const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

// Import process reliability modules
import { ProcessMonitor } from './process-monitor.mjs';
import { RecoveryEngine } from './recovery-engine.mjs';

// Import Epic #26 modules
import { PIDController } from './pid-controller.mjs';
import { GainScheduler } from './gain-scheduler.mjs';
import { MetricsCollector } from './metrics-collector.mjs';
import { ControlAlarms } from './control-alarms.mjs';
import { ClaudePromptGenerator } from './lib/claude-prompt-generator.mjs';
import { ValidationAgent } from './lib/validation-agent.mjs';
import { StrategyPlanner } from './lib/strategy-planner.mjs';
import { SemanticMemory } from './lib/semantic-memory.mjs';
import { MemoryPromotion } from './lib/memory-promotion.mjs';
import { LearningExtractor } from './lib/learning-extractor.mjs';
import { MemoryRetrieval } from './lib/memory-retrieval.mjs';
import { Overseer } from './lib/overseer.mjs';
import { BehaviorDetector } from './lib/behavior-detector.mjs';
import { InterventionSystem } from './lib/intervention-system.mjs';
import { EscalationHandler } from './lib/escalation-handler.mjs';

// Export all modules for programmatic use
export {
  parseArgs,
  printHelp,
  printStatus,
  // Core modules
  Orchestrator,
  StateManager,
  // Research-backed modules (#149, #154, #167, #168, #170)
  MemoryManager,
  BestOutputTracker,
  IterationAnalytics,
  EarlyStopping,
  CrossTaskLearner,
  // Process reliability modules (Phase 4)
  ProcessMonitor,
  RecoveryEngine,
  // Epic #26 - PID Control Layer (#23)
  PIDController,
  GainScheduler,
  MetricsCollector,
  ControlAlarms,
  // Epic #26 - Claude Intelligence Layer (#22)
  ClaudePromptGenerator,
  ValidationAgent,
  StrategyPlanner,
  // Epic #26 - Memory Layer (#24)
  SemanticMemory,
  MemoryPromotion,
  LearningExtractor,
  MemoryRetrieval,
  // Epic #26 - Overseer Layer (#25)
  Overseer,
  BehaviorDetector,
  InterventionSystem,
  EscalationHandler,
};
