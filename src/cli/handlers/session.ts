/**
 * Session Command Handler
 *
 * Starts an agentic session for a configured provider with full pre-flight:
 *   1. Version check — updates aiwg if stale
 *   2. Doctor — auto-repairs fixable issues
 *   3. Deployment check — redeploys framework files if missing/stale
 *   4. MCP inject (optional, `aiwg session mcp`)
 *   5. Launch binary (spawnable providers) or print start instructions (IDE providers)
 *
 * Usage:
 *   aiwg session                        # default provider, full pre-flight + launch
 *   aiwg session mcp                    # inject configured MCPs first, then launch
 *   aiwg session --provider codex       # explicit provider
 *   aiwg session mcp --provider cursor  # MCP inject for cursor + start instructions
 *   aiwg session --no-repair            # skip auto-repair (still check and report)
 *   aiwg session --prompt "<text>"      # headless: one-shot, bounded, exits (#3062)
 *   aiwg session --prompt-file <path>   # headless from a file instead of argv
 *   aiwg session --non-interactive      # force the non-interactive decision (#3062)
 *
 * Without a terminal attached, launching a spawnable provider with no
 * `--prompt`/`--prompt-file` would hand over a terminal that does not exist
 * and hang. `--prompt`/`--prompt-file` map to each provider's documented
 * non-interactive CLI form, delivered off argv (see
 * `HEADLESS_SESSION_TRANSPORTS` below); providers without an evidenced one
 * refuse instead of guessing. A provider with no spawnable binary at all
 * (IDE-integrated) refuses `--prompt`/`--prompt-file` outright rather than
 * discarding it. `--non-interactive` forces the same refusal even with a
 * terminal attached, taking priority over the environment-derived check.
 *
 * @issue #884
 */

import { spawnSync } from 'child_process';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { boundedSpawn, boundedSpawnSync } from '../../process/bounded-child-process.mjs';
import { existsSync } from 'node:fs';
import { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import { ensureRuntimeHome, writeProfileConfig, launchWithProfile } from '../../mcp/adapters/codex-runtime.js';
import { getFrameworkRoot } from '../../channel/manager.mjs';
import { forceUpdateCheck } from '../../update/checker.mjs';
import { updateInstallation } from '../../update/service.mjs';
import { isInteractive } from '../env.js';
import {
  readAiwgConfig,
  getDeploymentSummary,
  VALID_PROVIDERS,
} from '../../config/aiwg-config.js';
import {
  getProviderConfig,
  isSpawnableProvider,
  PROVIDER_CONFIGS,
} from '../agent-spawn.js';
import { useHandler as useFrameworkHandler } from './use.js';
import { debug } from '../log.js';
import { normalizeProviderDefinitionId } from '../../providers/provider-definitions.js';
import { requireFlagValue, MissingFlagValueError, hasPositionalOrSwitch } from '../flag-parsing.js';
import { exitCodeForSpawnResult } from '../child-process-result.js';

// ── Provider resolution ──────────────────────────────────────────────────────

/**
 * Resolve which provider to target.
 * Precedence: --provider flag > project config providers[0] > 'claude'
 */
async function resolveProvider(
  explicitProvider: string | undefined,
  cwd: string,
): Promise<string> {
  if (explicitProvider) {
    const normalized = normalizeProviderDefinitionId(explicitProvider);
    if (!normalized || normalized === 'generic' || !VALID_PROVIDERS.includes(normalized as never)) {
      throw new Error(`Unsupported provider '${explicitProvider}'`);
    }
    return normalized;
  }

  const config = await readAiwgConfig(cwd);
  if (config?.providers?.[0]) {
    return config.providers[0];
  }

  return 'claude';
}

// ── Arg parsing ──────────────────────────────────────────────────────────────

interface SessionArgs {
  /** Inject MCP servers before launch */
  mcp: boolean;
  /** Target provider (undefined = resolve from config) */
  provider: string | undefined;
  /** Skip auto-repair — check only */
  noRepair: boolean;
  /** MCP profile name — launch with profile-scoped server set (#891) */
  profile: string | undefined;
  /** Persist profile injection to provider config (default: ephemeral) */
  persist: boolean;
  /** Headless prompt text (#3062) — mutually exclusive with promptFile */
  prompt: string | undefined;
  /** Headless prompt file path (#3062) — mutually exclusive with prompt */
  promptFile: string | undefined;
  /** Force the non-interactive decision regardless of TTY/CI (#3062 review item 12) */
  nonInteractive: boolean;
}

/**
 * Parse `aiwg session` flags.
 *
 * Every value-taking flag below is parsed through {@link requireFlagValue}
 * (#3062 review item 11): a flag present with no value, or immediately
 * followed by another flag, throws {@link MissingFlagValueError} rather
 * than silently resolving to "not given" — callers MUST catch it before
 * any preflight check, spawn, or write. `precedence: 'last'` matches this
 * command's own pre-#3062 behavior (a hand-rolled loop that kept scanning
 * and overwrote on every match, so a later `--provider`/`--profile` always
 * won) — the first-round shared parser silently flipped that to
 * first-wins; this restores it (#3062 second review, finding 4).
 * `--prompt`/`--prompt-file` reject an empty string: an empty prompt can
 * never be meaningful, and silently accepting one would let a mistake
 * reach either the interactive launch path or a headless launch with
 * nothing to say.
 *
 * The `mcp` positional and every boolean switch below go through
 * {@link hasPositionalOrSwitch} rather than `args.includes(...)` (#3062
 * go/no-go review, blocker 4): a plain `args.includes('mcp')` matches the
 * literal word `mcp` *anywhere* in `args`, including inside a free-text
 * `--prompt`/`--prompt-file` value (`aiwg session --prompt mcp` used to
 * set `mcp: true` and reach MCP config injection) or after a bare `--`
 * (`aiwg session -- --persist` used to still set `persist: true`).
 * {@link hasPositionalOrSwitch} excludes both: anything consumed as the
 * value of `VALUE_FLAGS` below, and anything at or after `--`.
 */
const VALUE_FLAGS = ['--provider', '--profile', '--prompt', '--prompt-file'];

function parseSessionArgs(args: string[]): SessionArgs {
  const mcp = hasPositionalOrSwitch(args, 'mcp', VALUE_FLAGS);
  const noRepair = hasPositionalOrSwitch(args, '--no-repair', VALUE_FLAGS);
  const persist = hasPositionalOrSwitch(args, '--persist', VALUE_FLAGS);
  const nonInteractive = hasPositionalOrSwitch(args, '--non-interactive', VALUE_FLAGS);
  const provider = requireFlagValue(args, { precedence: 'last' }, '--provider');
  const profile = requireFlagValue(args, { precedence: 'last' }, '--profile');
  const prompt = requireFlagValue(args, { precedence: 'last', rejectEmpty: true }, '--prompt');
  const promptFile = requireFlagValue(args, { precedence: 'last', rejectEmpty: true }, '--prompt-file');

  return { mcp, provider, noRepair, profile, persist, prompt, promptFile, nonInteractive };
}

// ── Pre-flight steps ─────────────────────────────────────────────────────────

/** Run `npm view aiwg version` and compare to current. Returns true if up-to-date. */
async function checkAndUpdateVersion(noRepair: boolean): Promise<boolean> {
  console.log('  Checking aiwg version...');
  try {
    await forceUpdateCheck();
    return true;
  } catch (err) {
    // forceUpdateCheck handles its own user-visible output — the underlying
    // error is only relevant for troubleshooting, gated behind AIWG_DEBUG.
    debug('cli:session:update', 'forceUpdateCheck failed', err);
    if (!noRepair) {
      console.log('  Version check failed — attempting sync...');
      try {
        await updateInstallation();
      } catch (updateError) {
        debug('cli:session:update', 'canonical installation update failed', updateError);
        console.warn('  WARN  Could not update aiwg — continuing with current version.');
        return false;
      }
    }
    return true;
  }
}

/**
 * Run `aiwg doctor` and return whether it passed.
 * Uses the same script runner path as doctorHandler to avoid duplication.
 */
function runDoctor(_frameworkRoot: string, cwd: string): boolean {
  // Self-invocation of the aiwg binary, not the harness launch below; bounded
  // as a long-tier call (#3062) since `aiwg doctor` can touch the network.
  const result = boundedSpawnSync(
    process.execPath,
    [process.argv[1]!, 'doctor'],
    'long',
    { stdio: 'inherit', cwd },
  );
  // #3062 review item 7: a `null` status (killed/timed out/failed to spawn)
  // already falls through to `false` below via `?? 1`; surface the bounded
  // helper's diagnostic (e.g. the enriched timeout message) instead of
  // silently dropping it.
  const { exitCode, message } = exitCodeForSpawnResult(result, 'aiwg doctor');
  if (message) debug('cli:session:doctor', message);
  return exitCode === 0;
}

/**
 * Attempt to repair a failed doctor result.
 * Strategy: `aiwg sync`; package repair remains bound to the canonical update
 * strategy and never falls through to an arbitrary npm on PATH.
 * Returns true if repair succeeded (doctor now passes).
 */
function repairInstallation(
  frameworkRoot: string,
  cwd: string,
  provider: string,
): boolean {
  // Strategy 1: sync (update + redeploy)
  console.log('\n  Attempting auto-repair via `aiwg sync`...');
  // Self-invocation of the aiwg binary; bounded as a long-tier call (#3062)
  // since `aiwg sync` updates and redeploys (network + install-shaped work).
  const syncResult = boundedSpawnSync(
    process.execPath,
    [process.argv[1]!, 'sync'],
    'long',
    { stdio: 'inherit', cwd },
  );
  // #3062 review item 7: `status === 0` already treats a `null` status
  // (timeout/signal/spawn failure) as "not repaired", falling through to
  // the manual-options message below; surface the diagnostic too.
  const syncDiagnostic = exitCodeForSpawnResult(syncResult, 'aiwg sync').message;
  if (syncDiagnostic) debug('cli:session:repair', syncDiagnostic);

  if (syncResult.status === 0) {
    // Re-check doctor
    const doctorOk = runDoctor(frameworkRoot, cwd);
    if (doctorOk) {
      console.log('  OK  Auto-repair succeeded.');
      return true;
    }
  }

  // Could not auto-repair
  console.log(`
  ✗  Auto-repair could not resolve all issues.

  Manual options:
    aiwg installation show          — inspect canonical install drift
    aiwg refresh                    — update and redeploy canonically
    aiwg use all --provider ${provider.padEnd(10)} — redeploy all frameworks

  Report this issue:
    aiwg feedback --type bug
`);
  return false;
}

/**
 * Check whether framework files are deployed for the given provider.
 * Returns list of framework names that need (re)deployment.
 */
async function checkDeployment(
  cwd: string,
  provider: string,
): Promise<string[]> {
  const config = await readAiwgConfig(cwd);
  if (!config || Object.keys(config.installed).length === 0) {
    return []; // no frameworks configured — nothing to check
  }

  const summary = getDeploymentSummary(config, provider);
  const total = summary.agents + summary.commands + summary.skills + summary.rules;

  if (total === 0) {
    // Frameworks are registered but not deployed to this provider
    return Object.keys(config.installed);
  }

  return []; // deployed OK
}

/**
 * Redeploy all given frameworks to the provider.
 */
async function redeployFrameworks(
  ctx: HandlerContext,
  frameworks: string[],
  provider: string,
): Promise<void> {
  console.log(`\n  Redeploying ${frameworks.join(', ')} to ${provider}...`);
  for (const fw of frameworks) {
    await useFrameworkHandler.execute({
      ...ctx,
      args: [fw, '--provider', provider],
    });
  }
}

// ── MCP inject ────────────────────────────────────────────────────────────────

function injectMcp(provider: string, cwd: string): boolean {
  console.log(`\n  Injecting configured MCP servers into ${provider}...`);
  // Self-invocation of the aiwg binary; bounded as a long-tier call (#3062).
  const result = boundedSpawnSync(
    process.execPath,
    [process.argv[1]!, 'mcp', 'inject', '--provider', provider],
    'long',
    { stdio: 'inherit', cwd },
  );
  if (result.status !== 0) {
    // #3062 review item 7: surface the bounded helper's diagnostic (if any)
    // alongside the existing warning.
    const { message } = exitCodeForSpawnResult(result, 'aiwg mcp inject');
    if (message) debug('cli:session:mcp-inject', message);
    console.warn(
      '  WARN  MCP inject reported issues — continuing. Run `aiwg mcp list` to check registered servers.',
    );
    return false;
  }
  return true;
}

/**
 * Profile-aware inject (#891).
 * Default is ephemeral (no persistent config mutation).
 *
 * For Claude: returns the ephemeral MCP config and permission settings paths.
 * For Codex: sets up the runtime home via the codex-runtime adapter (#892).
 * Returns null for persistent mode or on failure.
 */
interface EphemeralProfileConfig {
  mcpConfigPath: string;
  settingsPath: string | null;
}

function injectMcpProfile(
  provider: string,
  profileName: string,
  cwd: string,
  persist: boolean,
  hasClaudePermissions = false,
): EphemeralProfileConfig | null {
  console.log(`\n  Resolving profile "${profileName}" for ${provider}...`);

  if (persist) {
    // Persistent: write to provider's default config
    // Self-invocation of the aiwg binary; bounded as a long-tier call (#3062).
    const result = boundedSpawnSync(
      process.execPath,
      [process.argv[1]!, 'mcp', 'inject', '--provider', provider, '--profile', profileName],
      'long',
      { stdio: 'inherit', cwd },
    );
    if (result.status !== 0) {
      // #3062 review item 7: surface the bounded helper's diagnostic.
      const { message } = exitCodeForSpawnResult(result, 'aiwg mcp inject');
      if (provider === 'codex' || provider === 'openai' || provider === 'claude' || provider === 'claude-code') {
        throw new Error(`${provider} profile injection failed; refusing to launch.${message ? ` ${message}` : ''}`);
      }
      console.warn(`  WARN  Profile inject failed — continuing without profile.${message ? ` ${message}` : ''}`);
    }
    return null; // persistent mode, no ephemeral path
  }

  // Codex: runtime-home adapter handles ephemeral config (#892)
  // The codex launch is also handled specially in launchProvider.
  if (provider === 'codex' || provider === 'openai') {
    return null; // signal handled via runtime home (see launchProvider)
  }

  // Claude/others: generate a temp config file
  const tmpPath = `${process.env.TMPDIR ?? '/tmp'}/aiwg-mcp-${profileName}-${provider}-${Date.now()}.json`;

  // Self-invocation of the aiwg binary; bounded as a long-tier call (#3062).
  const result = boundedSpawnSync(
    process.execPath,
    [
      process.argv[1]!, 'mcp', 'inject',
      '--provider', provider,
      '--profile', profileName,
      '--ephemeral',
      '--out', tmpPath,
    ],
    'long',
    { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf-8', cwd },
  );

  if (result.stdout) process.stdout.write(result.stdout);

  if (result.status !== 0) {
    // #3062 review item 7: surface the bounded helper's diagnostic.
    const { message } = exitCodeForSpawnResult(result, 'aiwg mcp inject');
    if (provider === 'claude' || provider === 'claude-code') {
      throw new Error(`Claude profile injection failed; refusing to launch.${message ? ` ${message}` : ''}`);
    }
    console.warn(`  WARN  Ephemeral profile inject failed — launching without profile MCP config.${message ? ` ${message}` : ''}`);
    return null;
  }

  const reportedSettingsPath = result.stdout?.match(/^\s*Tool permissions: (.+)$/m)?.[1]?.trim();
  const settingsPath = reportedSettingsPath && existsSync(reportedSettingsPath) ? reportedSettingsPath : null;
  if (hasClaudePermissions && !settingsPath) {
    throw new Error('Claude profile permission settings were not generated; refusing to launch.');
  }

  return {
    mcpConfigPath: tmpPath,
    settingsPath,
  };
}

// ── Launch ────────────────────────────────────────────────────────────────────

/**
 * How each provider's headless (`--prompt`/`--prompt-file`) invocation
 * delivers the prompt text to the child process, keyed by the provider ids
 * this file compares against elsewhere (canonical ids plus the
 * `claude-code`/`openai` aliases a stored, un-normalized project config can
 * still surface — see `resolveProvider`).
 *
 * Every transport below keeps the prompt text itself off argv — it never
 * shows up in `ps`/`/proc/<pid>/cmdline` — sourced from each adapter's own
 * qualified evidence (#3062 review item 8), not guessed:
 *
 *   - claude/claude-code → `--print --input-format text`, prompt on stdin.
 *     `--input-format <format> (only works with --print)`, confirmed with a
 *     piped smoke run (docs/providers/claude-direct.md).
 *   - codex/openai       → `exec` + a trailing `-` positional, prompt on
 *     stdin. "`-` reads stdin" (docs/providers/codex-direct.md).
 *   - deepseek-harness   → `--profile headless` + a trailing `-`
 *     positional, prompt on stdin. Confirmed by a live no-model probe, not
 *     just `--help` text (docs/providers/deepseek-harness-direct.md).
 *   - opencode           → `run --format json`, prompt written to a private
 *     temp file passed via `-f`/`--file`. Binary disassembly found *no*
 *     stdin/isTTY handling at all in `run` — stdin is confirmed
 *     unsupported, not merely undocumented — so `-f` is the evidenced
 *     non-argv transport instead (opencode-adapter.mjs module doc). The
 *     positional message is fixed and content-free, matching the adapter's
 *     `OPENCODE_FIXED_MESSAGE`; the real prompt never appears on argv or as
 *     a positional.
 *
 * Providers without an evidenced non-interactive CLI form (e.g. antigravity's
 * NDJSON-over-stdin protocol) are deliberately absent — `buildHeadlessLaunch`
 * returns `null` for them rather than guessing an invocation.
 */
type HeadlessTransport =
  | { kind: 'stdin'; flags: readonly string[]; trailingArg?: string }
  | { kind: 'file'; flags: readonly string[]; fileFlag: string; fixedPositional: string };

const HEADLESS_SESSION_TRANSPORTS: Readonly<Record<string, HeadlessTransport>> = {
  claude: { kind: 'stdin', flags: ['--print', '--input-format', 'text'] },
  'claude-code': { kind: 'stdin', flags: ['--print', '--input-format', 'text'] },
  codex: { kind: 'stdin', flags: ['exec'], trailingArg: '-' },
  openai: { kind: 'stdin', flags: ['exec'], trailingArg: '-' },
  'deepseek-harness': { kind: 'stdin', flags: ['--profile', 'headless'], trailingArg: '-' },
  opencode: {
    kind: 'file',
    flags: ['run', '--format', 'json'],
    fileFlag: '-f',
    fixedPositional: 'Follow the instructions in the attached file exactly.',
  },
};

/** One headless launch's resolved argv, stdin payload, and any temp file to clean up afterward. */
interface HeadlessLaunchPlan {
  args: string[];
  /** Stdin content for the child (stdin-transport providers). */
  input?: string;
  /** Temp file holding the prompt (file-transport providers) — caller cleans it up. */
  tempDir?: string;
}

/**
 * Build the final argv (and stdin/temp-file payload) for a headless launch,
 * or `null` if the provider has no evidenced non-interactive form.
 */
function buildHeadlessLaunch(provider: string, binaryArgs: string[], prompt: string): HeadlessLaunchPlan | null {
  const transport = HEADLESS_SESSION_TRANSPORTS[provider];
  if (!transport) return null;

  if (transport.kind === 'stdin') {
    const args = [...binaryArgs, ...transport.flags, ...(transport.trailingArg ? [transport.trailingArg] : [])];
    return { args, input: prompt };
  }

  // File transport (opencode): the prompt never touches argv or stdin — it
  // is written to a private temp file only this process can read, passed
  // by path. `mkdtemp()` under the independently verified system temp
  // directory gives the
  // directory itself a private, unpredictable name owned by this process;
  // the file within it additionally gets an explicit `0600` mode via an
  // exclusive create (`flag: 'wx'` — fails rather than silently
  // overwriting if a file with that exact name already existed, which it
  // never should in a fresh `mkdtemp()` directory).
  //
  // Cleanup ownership starts the moment `mkdtemp()` returns, *before* the
  // write: a failed write must not leave the directory behind any more
  // than a failed launch would. The caller's own `finally` (in
  // `launchProvider()`, keyed off `plan.tempDir`) handles the ordinary
  // "launch ran, now clean up" path; this one exists only for the write
  // itself failing before a `plan` is ever returned to that caller.
  // os.tmpdir() trusts TMPDIR/TEMP/TMP, which can point into the project.
  // Select and validate the OS location independently of those overrides.
  const systemTemp = realpathSync(process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:/Windows', 'Temp') : '/tmp');
  const info = statSync(systemTemp);
  if (!info.isDirectory() || (process.platform !== 'win32'
      && (info.uid !== 0 && info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0))) {
    throw new Error('Unsafe system temporary directory for session prompt');
  }
  const tempDir = mkdtempSync(join(systemTemp, 'aiwg-session-prompt-'));
  try {
    const promptPath = join(tempDir, 'prompt.txt');
    writeFileSync(promptPath, prompt, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    const args = [...binaryArgs, ...transport.flags, transport.fileFlag, promptPath, transport.fixedPositional];
    return { args, tempDir };
  } catch (err) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only; the original write failure is what matters.
    }
    throw err;
  }
}

/**
 * Launch a spawnable provider binary, replacing the current process (exec-style).
 * For IDE-integrated providers, print guidance and exit.
 *
 * `prompt`, when given, selects the headless path (#3062): the provider is
 * launched with its documented non-interactive form, bounded and with stdin
 * ignored, regardless of whether a terminal is attached. Without `prompt`
 * and without a terminal, this refuses before spawning anything that would
 * hang.
 */
async function launchProvider(
  provider: string,
  mcpInjected: boolean,
  mcpConfigPath: string | null | undefined,
  profile: string | null | undefined,
  settingsPath: string | null | undefined,
  prompt: string | null | undefined,
  interactive: boolean,
): Promise<HandlerResult> {
  const cfg = getProviderConfig(provider);

  if (!isSpawnableProvider(provider)) {
    // Not spawnable — a prompt can never be delivered to a binary that does
    // not exist. Refuse explicitly instead of discarding it and printing
    // success (#3062 review item 9). `execute()` already checks this before
    // any pre-flight step runs; this is defense-in-depth for this function
    // on its own.
    if (prompt) {
      return {
        exitCode: 1,
        message:
          `Provider '${cfg.name}' has no CLI binary to spawn; --prompt/--prompt-file requires a ` +
          'spawnable provider.',
      };
    }
    // Print context-aware guidance
    const mcpNote = mcpInjected
      ? '\n  MCP servers have been injected into your provider config.\n'
      : '';
    const ephemeralNote = mcpConfigPath
      ? `\n  MCP config (ephemeral): ${mcpConfigPath}\n`
      : '';

    console.log(`
── Ready to start ${cfg.name} ──
${mcpNote}${ephemeralNote}
${cfg.guidanceMessage ?? `Open ${cfg.name} in your project directory to begin.`}
`);
    return { exitCode: 0 };
  }

  // Spawnable — hand off the terminal (or run headless, see below)
  console.log(`\n── Launching ${cfg.name} ──\n`);

  // Codex + profile: use runtime-home adapter (#892)
  if ((provider === 'codex' || provider === 'openai') && profile) {
    console.log(`  Using runtime home for profile "${profile}"`);
    // Headless (#3062): the prompt travels on stdin via a trailing `-`
    // positional (docs/providers/codex-direct.md: "`-` reads stdin"),
    // never on argv (review item 8). `launchWithProfile` itself
    // bounds/refuses based on whether `extraArgs` is a non-interactive form
    // and whether a terminal is attached — see its own doc comment.
    const extraArgs = prompt ? ['exec', '-'] : [];
    const result = launchWithProfile(profile, extraArgs, prompt ? { input: prompt, interactive } : { interactive });
    const { exitCode, message } = exitCodeForSpawnResult(result, 'codex');
    return message ? { exitCode, message } : { exitCode };
  }

  // Claude: load both the ephemeral MCP config and any permission settings.
  const binaryArgs: string[] = [];
  if (mcpConfigPath && (provider === 'claude' || provider === 'claude-code')) {
    binaryArgs.push('--mcp-config', mcpConfigPath);
    console.log(`  Using ephemeral MCP config: ${mcpConfigPath}`);
    if (settingsPath) {
      binaryArgs.push('--settings', settingsPath);
      console.log(`  Using ephemeral permission settings: ${settingsPath}`);
    }
  }

  if (prompt) {
    const plan = buildHeadlessLaunch(provider, binaryArgs, prompt);
    if (!plan) {
      return {
        exitCode: 1,
        message:
          `Provider '${cfg.name}' has no evidenced non-interactive CLI form; --prompt/--prompt-file ` +
          `is not supported for it. Run \`aiwg session --provider ${provider}\` from a terminal instead.`,
      };
    }
    try {
      // Bounded (#3062): a headless run never hands over the terminal, so
      // it is safe to bound. The prompt never rides on argv (review item
      // 8); stdin-transport providers get it via `input` (never inherited
      // from the parent), file-transport providers get it via a private
      // temp file path already baked into `plan.args`.
      const launchOptions: import('node:child_process').SpawnSyncOptions = {
        stdio: plan.input !== undefined ? ['pipe', 'inherit', 'inherit'] : ['ignore', 'inherit', 'inherit'],
        env: process.env as Record<string, string>,
        ...(plan.input !== undefined ? { input: plan.input } : {}),
      };
      const result = plan.tempDir
        ? await boundedSpawn(cfg.binary!, plan.args, 'long', { ...launchOptions, stdio: ['ignore', 'inherit', 'inherit'] },
          () => rmSync(plan.tempDir!, { recursive: true, force: true }))
        : boundedSpawnSync(cfg.binary!, plan.args, 'long', launchOptions);
      const { exitCode, message } = exitCodeForSpawnResult(result, cfg.binary!);
      return message ? { exitCode, message } : { exitCode };
    } finally {
      if (plan.tempDir) {
        try {
          rmSync(plan.tempDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup only; a leftover temp file is not fatal.
        }
      }
    }
  }

  if (!interactive) {
    return {
      exitCode: 1,
      message:
        'aiwg session requires an interactive terminal to launch a provider without a prompt. ' +
        'Pass --prompt <text> or --prompt-file <path> to run headless.',
    };
  }

  // sync-spawn: interactive harness-launch — hands the terminal to the
  // provider binary the user is meant to talk to, when no --prompt/
  // --prompt-file was supplied (see tools/testing/sync-spawn-allowlist.json).
  // Reached only when `interactive` is true (#3062) — the headless and
  // no-terminal paths above are handled before this point. Not a candidate
  // for a bounded timeout.
  const result = spawnSync(cfg.binary!, binaryArgs, {
    stdio: 'inherit',
    env: process.env as Record<string, string>,
  });

  const { exitCode, message } = exitCodeForSpawnResult(result, cfg.binary!);
  return message ? { exitCode, message } : { exitCode };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const sessionHandler: CommandHandler = {
  id: 'session',
  name: 'Session',
  description:
    'Start an agentic session — pre-flight check, auto-repair, optional MCP inject, then launch',
  category: 'project',
  aliases: [],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    let parsed: ReturnType<typeof parseSessionArgs>;
    try {
      parsed = parseSessionArgs(ctx.args);
    } catch (err) {
      // #3062 review item 11: a value-taking flag present without a usable
      // value is a usage error, reported before any preflight/spawn/write.
      if (err instanceof MissingFlagValueError) {
        return { exitCode: 2, message: `aiwg session: ${err.message}.` };
      }
      throw err;
    }
    const {
      mcp, provider: explicitProvider, noRepair, profile, persist,
      prompt: promptArg, promptFile, nonInteractive,
    } = parsed;
    const cwd = ctx.cwd || process.cwd();
    // #3062 review item 12: the one shared interactive decision, taking
    // this command's own explicit `--non-interactive` flag as input instead
    // of only ever checking the environment.
    const interactive = isInteractive(nonInteractive);

    // ── Resolve headless prompt (#3062) — before any pre-flight spawn ──────
    if (promptArg && promptFile) {
      return { exitCode: 2, message: 'aiwg session: pass only one of --prompt or --prompt-file.' };
    }
    let prompt: string | undefined = promptArg;
    if (!prompt && promptFile) {
      let fileText: string;
      try {
        fileText = await readFile(promptFile, 'utf-8');
      } catch (err) {
        return {
          exitCode: 1,
          message: `aiwg session: could not read --prompt-file '${promptFile}': ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      prompt = fileText.trim();
      if (!prompt) {
        return { exitCode: 1, message: `aiwg session: --prompt-file '${promptFile}' is empty.` };
      }
    }

    // ── Resolve provider ─────────────────────────────────────────
    const provider = await resolveProvider(explicitProvider, cwd);
    const providerCfg = PROVIDER_CONFIGS[provider];

    // An unsupported (non-spawnable) provider can never run a supplied
    // prompt — it has no binary to hand it to. Validate this before any
    // pre-flight step runs a child process (#3062 review item 9): the old
    // behavior silently discarded the prompt and printed IDE guidance at
    // exit 0.
    if (prompt && !isSpawnableProvider(provider)) {
      const unsupportedCfg = getProviderConfig(provider);
      return {
        exitCode: 1,
        message:
          `Provider '${unsupportedCfg.name}' has no CLI binary to spawn; --prompt/--prompt-file ` +
          'requires a spawnable provider. Run `aiwg session --provider ' + provider +
          '` from a terminal for IDE-integrated usage instead.',
      };
    }

    // A spawnable provider with no evidenced non-interactive CLI form
    // (e.g. antigravity) can never run a supplied prompt either — check
    // this in the same early spot as the non-spawnable case above (#3062
    // second review, finding 6): the old behavior deferred this to
    // `buildHeadlessLaunch()` inside `launchProvider()`, reached only
    // after the version-check/doctor/deployment/mcp-inject pre-flight
    // already ran. The codex-profile launch path is exempt — it always
    // uses `codex exec -`, never `HEADLESS_SESSION_TRANSPORTS`.
    if (prompt && isSpawnableProvider(provider) && !HEADLESS_SESSION_TRANSPORTS[provider]
      && !((provider === 'codex' || provider === 'openai') && profile)) {
      const unsupportedTransportCfg = getProviderConfig(provider);
      return {
        exitCode: 1,
        message:
          `Provider '${unsupportedTransportCfg.name}' has no evidenced non-interactive CLI form; ` +
          `--prompt/--prompt-file is not supported for it. Run \`aiwg session --provider ${provider}\` ` +
          'from a terminal instead.',
      };
    }

    // Without a terminal, a spawnable provider launched with no prompt would
    // hand over a terminal that does not exist and hang. Fail fast, before
    // any pre-flight step runs a child process (#3062). IDE-integrated
    // providers only ever print guidance — never spawn — so they don't need
    // a prompt to stay safe headless.
    if (!prompt && isSpawnableProvider(provider) && !interactive) {
      return {
        exitCode: 1,
        message:
          `aiwg session requires --prompt <text> or --prompt-file <path> when no interactive terminal is ` +
          `attached (provider '${provider}' launches a binary that would otherwise hand over the terminal ` +
          'and hang).',
      };
    }

    const profileSuffix = profile ? ` · profile: ${profile}` : '';
    console.log(`\n── aiwg session ── provider: ${providerCfg?.name ?? provider}${profileSuffix} ──\n`);

    const frameworkRoot = await getFrameworkRoot();

    // ── Step 1: Version check ─────────────────────────────────────
    if (!noRepair) {
      await checkAndUpdateVersion(noRepair);
    }

    // ── Step 2: Doctor ────────────────────────────────────────────
    console.log('\n  Running health checks...');
    const doctorOk = runDoctor(frameworkRoot, cwd);

    if (!doctorOk && !noRepair) {
      const repaired = repairInstallation(frameworkRoot, cwd, provider);
      if (!repaired) {
        // Repair failed — still continue (user was already informed)
      }
    } else if (!doctorOk && noRepair) {
      console.log(
        '\n  WARN  Health checks found issues. Run without --no-repair to auto-fix, or `aiwg feedback` to report.',
      );
    }

    // ── Step 3: Deployment check ──────────────────────────────────
    const undeployed = await checkDeployment(cwd, provider);
    if (undeployed.length > 0 && !noRepair) {
      console.log(
        `\n  Frameworks not deployed to ${provider}: ${undeployed.join(', ')}`,
      );
      await redeployFrameworks(ctx, undeployed, provider);
    }

    // ── Step 4: MCP inject ────────────────────────────────────────
    let mcpInjected = false;
    let mcpConfigPath: string | null = null;
    let settingsPath: string | null = null;

    if (profile) {
      // Profile-aware injection (#891) — ephemeral by default

      // Codex profiles must pass policy and setup before any launch (#892)
      if (provider === 'codex' || provider === 'openai') {
        try {
          console.log(`\n  Setting up Codex ${persist ? 'persistent config' : 'runtime home'} for profile "${profile}"...`);
          // Import server list for this profile
          const { McpProfileRegistry } = await import('../../mcp/profiles.js');
          const { McpServerRegistry } = await import('../../mcp/registry.js');
          const profiles = new McpProfileRegistry();
          const registry = new McpServerRegistry();
          const resolvedServers = await profiles.resolveServers(profile, registry) as import('../../mcp/registry.js').McpServerDefinition[];
          const { resolveToolFilters } = await import('../../mcp/tool-filters.mjs');
          const { assertCredentialPolicy, resolveCredentialPolicy } = await import('../../mcp/credentials.mjs');
          const registryPolicy = await registry.getCredentialPolicy();
          const floorPolicy = await registry.getCredentialPolicyFloor();
          const floorSource = await registry.getCredentialPolicyFloorSource();
          let credentialPolicy;
          try {
            credentialPolicy = resolveCredentialPolicy({ registryPolicy, floorPolicy, floorSource });
            assertCredentialPolicy(resolvedServers, credentialPolicy);
          } catch (err) {
            console.error(`  ${err instanceof Error ? err.message : String(err)}`);
            return { exitCode: 1 };
          }
          if (persist) {
            injectMcpProfile(provider, profile, cwd, true);
          } else {
            await ensureRuntimeHome(profile);
            // writeProfileConfig re-resolves and re-enforces the floor itself (so a
            // direct API call cannot bypass it); passing it here too keeps this
            // call's diagnostics consistent with the one already performed above.
            const warnings = await writeProfileConfig(profile, resolvedServers, {
              credentialPolicy, floorPolicy,
              toolFilters: resolveToolFilters(await profiles.resolve(profile), 'codex'),
            });
            for (const warning of warnings) console.warn(`  WARN  codex: ${warning}`);
            console.log(`  Runtime home ready. Profile servers: ${resolvedServers.map((s) => s.name).join(', ') || '(none)'}`);
          }
          mcpInjected = true;
        } catch (err) {
          console.warn(`  WARN  Codex runtime home setup failed: ${err instanceof Error ? err.message : String(err)}`);
          return { exitCode: 1 };
        }
      } else {
        try {
          let hasClaudePermissions = false;
          if (provider === 'claude' || provider === 'claude-code') {
            const { McpProfileRegistry } = await import('../../mcp/profiles.js');
            const { McpServerRegistry } = await import('../../mcp/registry.js');
            const { resolveToolFilters, planToolFilters } = await import('../../mcp/tool-filters.mjs');
            const profiles = new McpProfileRegistry();
            const servers = await profiles.resolveServers(profile, new McpServerRegistry()) as
              import('../../mcp/registry.js').McpServerDefinition[];
            const plan = planToolFilters(provider, servers.map(server => server.name),
              resolveToolFilters(await profiles.resolve(profile), provider));
            hasClaudePermissions = plan.claudePermissions !== null;
          }
          const ephemeral = injectMcpProfile(provider, profile, cwd, persist, hasClaudePermissions);
          mcpConfigPath = ephemeral?.mcpConfigPath ?? null;
          settingsPath = ephemeral?.settingsPath ?? null;
          mcpInjected = ephemeral !== null || persist;
        } catch (err) {
          console.error(`  ${err instanceof Error ? err.message : String(err)}`);
          return { exitCode: 1 };
        }
      }
    } else if (mcp) {
      mcpInjected = injectMcp(provider, cwd);
    }

    // ── Step 5: Launch ────────────────────────────────────────────
    return launchProvider(provider, mcpInjected, mcpConfigPath,
      persist && (provider === 'codex' || provider === 'openai') ? null : profile, settingsPath, prompt,
      interactive);
  },
};
