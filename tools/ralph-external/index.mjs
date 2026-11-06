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
import { watchWorkerStatus } from './process-monitor.mjs';
import { parseWorkerLaunchArgs, workerFinalFailureMessage } from './lib/worker-launch-cli.mjs';
export { parseWorkerLaunchArgs } from './lib/worker-launch-cli.mjs';

/** Strict status-only grammar, before provider probes and state constructors. */
export function parseWorkerStatusArgs(args) {
  const result = { watch: false, observe: false, json: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error('DUPLICATE_STATUS_OPTION');
    seen.add(flag);
    if (['--status', '-s', '--workers'].includes(flag)) continue;
    if (['--json', '--watch', '--observe'].includes(flag)) { result[flag.slice(2)] = true; continue; }
    if (['--run-dir', '--runs-root', '--deadline-seconds'].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error('MISSING_STATUS_VALUE');
      if (flag === '--deadline-seconds') {
        if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !Number.isFinite(Number(value)) || Number(value) <= 0 || Number(value) > 86400) throw new Error('INVALID_WATCH_DEADLINE');
        result.deadlineSeconds = Number(value);
      } else result[flag === '--run-dir' ? 'runDir' : 'runsRoot'] = value;
      continue;
    }
    throw new Error('UNKNOWN_STATUS_OPTION');
  }
  if (!seen.has('--workers') || !seen.has('--status') && !seen.has('-s')) throw new Error('WORKER_STATUS_REQUIRED');
  if (!!result.runDir === !!result.runsRoot) throw new Error('EXACTLY_ONE_RUN_SCOPE_REQUIRED');
  if (result.watch && !result.deadlineSeconds || !result.watch && result.deadlineSeconds) throw new Error('FINITE_WATCH_DEADLINE_REQUIRED');
  if (result.observe && !result.watch) throw new Error('OBSERVE_REQUIRES_WATCH');
  return result;
}

/**
 * #2915 round 8 (D1.9/C1): strict grammar for the one explicit operator
 * recovery command for the per-task-chain allowance ledger --
 * `--ledger-release <taskChainDigest> <n>|correction <n>|policy --capture-root DIR`.
 * There is no age/pid/liveness inference anywhere in the ledger itself;
 * this is the only way an uncharged, stranded reservation (or, for
 * `policy`, a chain whose policy publish itself crashed and is now
 * otherwise empty) is ever freed, and it is documented (see `printHelp`)
 * as being only for a task chain with no running conductor.
 *
 * `correction <n>` (#2915 round 8 review 8, C9): the SAME refusal rules as
 * `<n>` (an attempt), for a stranded, uncharged `correction-<n>` slot --
 * refuses if `correction-<n>.charged` exists, otherwise unlinks it and
 * reports its recorded invocation id, exactly like releasing an attempt.
 */
export function parseLedgerReleaseArgs(args) {
  const idx = args.indexOf('--ledger-release');
  const usage = 'Usage: ralph-external --ledger-release <taskChainDigest> <n>|correction <n>|policy --capture-root DIR';
  if (idx === -1) throw new Error(usage);
  const taskChainDigest = args[idx + 1];
  const targetRaw = args[idx + 2];
  if (!taskChainDigest || taskChainDigest.startsWith('--') || !targetRaw || targetRaw.startsWith('--')) {
    throw new Error(usage);
  }
  let target;
  let consumed = 3;
  if (targetRaw === 'policy') {
    target = { kind: 'policy' };
  } else if (targetRaw === 'correction') {
    const correctionRaw = args[idx + 3];
    if (!correctionRaw || !/^[1-9][0-9]*$/.test(correctionRaw)) throw new Error(usage);
    const attempt = Number(correctionRaw);
    if (!Number.isSafeInteger(attempt)) throw new Error(usage);
    target = { kind: 'correction', attempt };
    consumed = 4;
  } else {
    if (!/^[1-9][0-9]*$/.test(targetRaw)) throw new Error(usage);
    const attempt = Number(targetRaw);
    if (!Number.isSafeInteger(attempt)) throw new Error(usage);
    target = { kind: 'attempt', attempt };
  }
  const result = { taskChainDigest, target, captureRoot: null };
  const rest = [...args.slice(0, idx), ...args.slice(idx + consumed)];
  const seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (seen.has(flag)) throw new Error(`Duplicate ledger-release option: ${flag}`);
    seen.add(flag);
    if (flag === '--capture-root') {
      const value = rest[++i];
      if (!value || value.startsWith('--')) throw new Error('--capture-root requires a value');
      result.captureRoot = value;
      continue;
    }
    throw new Error(`Unsupported ledger-release option: ${flag}`);
  }
  if (!result.captureRoot) throw new Error('--ledger-release requires --capture-root DIR (the persistent ledger root for this task chain)');
  return result;
}

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
    // #1450 P0: explicit pinned ID. Was 'opus' — under a 1M-context parent
    // (opus[1m]) the bare alias inherits 1M attributes, and most Claude
    // accounts (Pro, Team standard) lack 1M access. claude-sonnet-5 is the
    // standard (cost-effective) tier and much cheaper for headless dispatch.
    // See also #1442 (skill frontmatter pinning) and agent-deployment rule.
    model: 'claude-sonnet-5',
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
    provider: 'claude',           // CLI provider (claude, codex, opencode, factory, pi, omp, deepseek-harness, muse)
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

  // #1766: budget stops and the exploration quota live inside the analytics
  // subsystem, so --no-analytics silently voids every declared ceiling. The
  // coupling is documented; warn at parse time so an operator cannot believe a
  // limit applies while the loop runs uncapped.
  if (options.enableAnalytics === false) {
    const voided = Object.entries(options.budgetLimits || {})
      .filter(([, limit]) => Number.isFinite(Number(limit)) && Number(limit) > 0)
      .map(([name]) => name);
    if (options.explorationQuota && options.explorationQuota.enabled === true) {
      voided.push('exploration_quota');
    }
    if (voided.length > 0) {
      console.warn(
        `[External Ralph] --no-analytics disables the analytics subsystem, which owns budget ` +
        `enforcement and the exploration quota. Declared control(s) will NOT fire: ${voided.join(', ')}. ` +
        `Remove --no-analytics to enforce them.`
      );
    }
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

Worker status (read-only; no model call or Mission state):
  --status --workers --run-dir DIR [--json]
  --status --workers --runs-root DIR [--json]
  --status --workers --runs-root DIR --watch --deadline-seconds N [--observe]
Exactly one private run directory/root is required. Watch timeout stops watching.
--observe requires --watch and atomically writes owner scratch; concurrent or lost owners require
reconciliation. Workers without run metadata are sampled in conductor context.

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
  ralph-external --verify-worker --run-dir DIR --check JSON [--check JSON] [--json]
  ralph-external --launch-worker --invocation FILE --run-dir DIR [--retry-of-run-dir DIR [--retry-correction]] [--allow-degraded-worker]
                          Exit 0: confirmed success. Exit 1: confirmed failure
                          (error, timeout, or a confirmed stop with a
                          nonzero/signaled exit). Exit 2: uncertain
                          termination — degraded (--allow-degraded-worker)
                          runs cannot confirm descendant stop and never
                          report exit 0, even when the run looked clean.
  ralph-external --ledger-release <taskChainDigest> <n> --capture-root DIR
                          Operator recovery for the per-task-chain allowance
                          ledger. Refuses if attempt-<n> is already charged;
                          otherwise frees it and prints its recorded
                          invocation id BEFORE releasing it. There is no
                          automatic (age/pid/liveness) reclaim anywhere in
                          the ledger — this is the only way a stranded,
                          uncharged reservation is ever released. Only for
                          a task chain with no running conductor.
  ralph-external --ledger-release <taskChainDigest> correction <n> --capture-root DIR
                          The same operator recovery, for a stranded,
                          uncharged correction-<n> slot. Refuses if
                          correction-<n> is already charged; otherwise
                          frees it and prints its recorded invocation id
                          BEFORE releasing it, exactly like an attempt.
  ralph-external --ledger-release <taskChainDigest> policy --capture-root DIR
                          Removes a chain's policy file. Refuses if the
                          chain still has ANY attempt or correction entry
                          (charged or not) — only for a chain that is
                          otherwise already empty, to recover one whose
                          policy publish itself crashed. Only for a task
                          chain with no running conductor.

ARGUMENTS:
  <objective>             Task objective (required for new loop)

OPTIONS:
  -c, --completion <str>  Completion criteria (required for new loop)
  --max-iterations <n>    Maximum external iterations (default: 5)
  --model <model>         Claude model variant (default: claude-sonnet-5, pinned ID)
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
  --provider <name>       CLI provider: claude (default), codex, opencode, factory, pi, omp, deepseek-harness (dsh), muse (optional adapter, #230)
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
 * Map a `launchWorker()` result to a process exit code.
 *
 * Uncertainty must dominate: an uncertain termination is reported as exit 2
 * no matter what other error signals (`errorCode`, `timedOut`) are also
 * present on the result, because `errorCode`/`timedOut` describe *why* the
 * run is uncertain, not an independent confirmed-failure claim. Only a
 * `termination: 'confirmed'` result may resolve to 0 (clean) or 1
 * (confirmed failure/error/timeout).
 *
 * 0: confirmed success. 1: confirmed failure (error, timeout, or a
 * confirmed-stop with a nonzero/signaled exit). 2: uncertain termination —
 * most commonly a clean-looking degraded (--allow-degraded-worker) run,
 * where descendant escape via setsid cannot be ruled out and the apparent
 * exitCode:0 is therefore never reported as code 0. Callers must not treat 2
 * as either confirmed success or confirmed failure; see
 * docs/providers/worker-invocation-packaging.md#attached-one-shot-capture.
 * @param {{ termination?: string, errorCode?: string|null, timedOut?: boolean, exitCode?: number|null }} result
 * @returns {0|1|2}
 */
export function workerExitCode(result) {
  if (result?.termination !== 'confirmed') return 2;
  return result.errorCode || result.timedOut || result.exitCode !== 0 ? 1 : 0;
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--workers')) {
    try { process.exitCode = await watchWorkerStatus(parseWorkerStatusArgs(args)); }
    catch (error) {
      const code = /^[A-Z_]{1,80}$/.test(error.message) ? error.message : 'STATUS_REQUEST_FAILED';
      if (args.includes('--json')) console.log(JSON.stringify({ version: 1, sampledAt: new Date().toISOString(), scope: 'direct-conductor',
        observerCoverage: 'unobserved', workers: [], breakers: [], nextCheckAt: null, complete: false, findings: [code], exitCode: 1 }));
      else console.error(`Worker status: ${code}`);
      process.exitCode = 1;
    }
    return;
  }
  if (args.includes('--verify-worker')) {
    const { runWorkerVerificationCli } = await import('./lib/worker-verification-cli.mjs');
    process.exitCode = await runWorkerVerificationCli(args);
    return;
  }
  // Dispatch before legacy parsing, provider probing or stateful constructors.
  if (args.includes('--launch-worker')) {
    const { SessionLauncher } = await import('./session-launcher.mjs');
    const worker = parseWorkerLaunchArgs(args);
    const launcher = new SessionLauncher();
    launcher.on('recovery-transition', event => console.error(event.summary));
    // #3685 round 2: every worker process starts with the AIWG bootstrap in
    // its workdir — ensured (presence-checked, one-pass deployed when
    // missing) before the worker spawns. A failed ensure refuses with the
    // typed diagnostic envelope below, never a context-free launch.
    try {
      const result = await launcher.launchWorker({ ...worker, ensureWorkerContext: true });
      console.log(JSON.stringify(result));
      const finalFailure = workerFinalFailureMessage(result);
      if (finalFailure) console.error(finalFailure);
      process.exitCode = workerExitCode(result);
    } catch (error) {
      if (error && error.code === 'OG_WORKER_CONTEXT_UNAVAILABLE') {
        console.log(JSON.stringify({ launched: false, blocked: true, code: error.code,
          diagnostic: error.message, remedy: error.remedy ?? null,
          provider: error.provider ?? null, workdir: error.workdir ?? null }));
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    return;
  }
  // #2915 round 8 (D1.9): operator recovery for the allowance ledger --
  // read-only with respect to everything except the one uncharged slot (or
  // the otherwise-empty chain's `policy`) named, and performs no provider
  // probing, loop state or Mission work.
  if (args.includes('--ledger-release')) {
    let parsed;
    try { parsed = parseLedgerReleaseArgs(args); }
    catch (error) { console.error(error.message); process.exitCode = 1; return; }
    try {
      const { releaseLedgerSlot, releaseLedgerPolicy } = await import('./session-launcher.mjs');
      // #2915 round 8 review 8 (C11): print the recorded invocation id the
      // MOMENT it is known -- BEFORE the unlink -- never only afterward via
      // the final result line below. If the unlink itself throws (or the
      // process is killed between the two), the operator has still seen
      // what was about to be released.
      const result = parsed.target.kind === 'policy'
        ? await releaseLedgerPolicy({ captureRoot: parsed.captureRoot, taskChainDigest: parsed.taskChainDigest })
        : await releaseLedgerSlot({ captureRoot: parsed.captureRoot, taskChainDigest: parsed.taskChainDigest,
          attempt: parsed.target.attempt, kind: parsed.target.kind,
          report: ({ invocationId }) => console.log(JSON.stringify({ phase: 'identified', kind: parsed.target.kind, invocationId })) });
      console.log(JSON.stringify(result));
      process.exitCode = 0;
    } catch (error) {
      console.error(`Ledger release failed: ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }
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
    console.error(`Error: Unknown provider '${providerName}'. Available: claude, codex, opencode, factory, pi, omp, deepseek-harness (dsh), muse (optional adapter; disable: AIWG_MUSE_RALPH_ENABLED=0)`);
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
