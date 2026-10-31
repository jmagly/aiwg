/**
 * Init Command Handler
 *
 * Implements `aiwg init` — the first-run wizard that creates
 * `.aiwg/aiwg.config` for the current project.
 *
 * Prompts, and the argument that answers each one directly (#3062):
 *   1. Which AI provider toolchains does this project target? → `--providers <list>`
 *   2. Would you like to add default scripts (deploy/doctor/sync)? → `--default-scripts true|false`
 *   3. Add a custom script (name + command)? → `--script <name>=<command>` (repeatable;
 *      implies yes) or `--custom-scripts true|false` (answers the question directly
 *      without supplying a script; `false` declines it outright)
 *   4. Enable direct worker dispatch? → `--worker-dispatch enable|decline`
 *
 * With a terminal attached, any of these given directly skips that
 * question — only genuinely missing values are still asked. Without one,
 * omitted inputs fall back to their documented defaults (`claude`, default
 * scripts on) rather than erroring, since those defaults are always safe to
 * apply headless. `--non-interactive`/`--yes` force the non-interactive
 * path even with a terminal attached. `--dry-run` never writes anything,
 * including the baseline config itself.
 *
 * Runs automatically on first `aiwg use` when no config exists.
 * Can also be run explicitly to reconfigure.
 *
 * @implements #621
 */

import readline from 'readline';
import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import {
  readAiwgConfig,
  writeAiwgConfig,
  emptyConfig,
  populateDeployedTo,
  VALID_PROVIDERS,
  getConfigPath,
} from '../../config/aiwg-config.js';
import * as ui from '../ui.js';
import { askString as sharedAskString, askYesNo as sharedAskYesNo, askConsent } from '../prompt-utils.js';
import { normalizeProviderDefinitionId } from '../../providers/provider-definitions.js';
import { writeNormalizedAiwgMd } from '../../smiths/context-pipeline/finalization.js';
import { ensureWorkspaceContext } from '../../smiths/context-pipeline/workspace-context.js';
import {
  detectInstalledWorkerClis,
  evaluateWorkerDispatchOffer,
  workerDispatchOfferQuestion,
  workerDispatchOfferHintWithArg,
  parseWorkerDispatchArg,
  type WorkerDispatchArgValue,
} from '../../models/worker-dispatch-offer.js';
import { EXIT_CODES } from '../errors.js';
import type { ParallelismConfig, SetupConfig } from '../../config/aiwg-config.js';
import { isInteractive } from '../env.js';
import { parseGuidedSetupFlags, runGuidedSetup } from './guided-setup.js';
import type { GuidedSetupFlags } from './guided-setup.js';
import {
  requireFlagValue,
  collectFlagValues,
  parseBooleanFlagValue,
  parseListFlagValue,
  parseKeyValueEntry,
  MissingFlagValueError,
} from '../flag-parsing.js';

/** Default project scripts installed by init and merged by guided setup apply. */
export const DEFAULT_SCRIPTS: Record<string, string> = { deploy: 'aiwg use all', doctor: 'aiwg doctor', sync: 'aiwg sync' };

const PROVIDER_LABELS: Record<string, string> = {
  antigravity: 'Google Antigravity .agents/',
  claude:    'Claude Code       .claude/',
  copilot:   'GitHub Copilot    .github/',
  cursor:    'Cursor            .cursor/',
  opencode:  'OpenCode          .opencode/',
  warp:      'Warp Terminal     .warp/',
  windsurf:  'Windsurf          AGENTS.md',
  factory:   'Factory AI        .factory/',
  codex:     'OpenAI Codex      ~/.codex/',
  openclaw:  'OpenClaw          ~/.openclaw/',
  hermes:    'Hermes (MCP)      aiwg mcp',
  omp:       'Oh My Pi         .omp/ + .agents/skills/',
  flue:      'Flue (experimental) .agents/skills/ + AGENTS.md + db.ts',
  pi:        'Pi Coding Agent   .pi/ + .agents/skills/',
};

// Local aliases for the shared prompt utilities. These preserve existing
// call sites (askYesNo/askString) while routing through a single timeout
// and unref-discipline implementation in `src/cli/prompt-utils.ts`.
// Phase 3 (#920) will replace these with @clack/prompts.

const askYesNo = sharedAskYesNo;
const askString = sharedAskString;

/**
 * Prompt for a comma-separated provider selection
 */
async function askProviders(rl: readline.Interface, signal?: AbortSignal): Promise<string[]> {
  const list = VALID_PROVIDERS.map((p, i) => `  ${i + 1}. ${PROVIDER_LABELS[p] ?? p}`).join('\n');
  console.log('');
  console.log('  Available providers:');
  console.log(list);
  console.log('');

  // Multi-select (comma-separated) — stays hand-rolled rather than adopting
  // listSelect because #926's POC targets single-select only. `signal`
  // threading is the full migration from the spike.
  const answer = await askString(
    rl,
    '  Enter provider numbers (comma-separated) or names [1]: ',
    '',
    signal,
  );

  if (!answer) return ['claude']; // default

  const parts = answer.split(',').map(s => s.trim()).filter(Boolean);
  const selected: string[] = [];

  for (const part of parts) {
    const num = parseInt(part, 10);
    if (!isNaN(num) && num >= 1 && num <= VALID_PROVIDERS.length) {
      selected.push(VALID_PROVIDERS[num - 1]);
      continue;
    }
    // Accept canonical ids and registered aliases (e.g. `dsh` for
    // `deepseek-harness`) so the picker honours the same names as `--provider`.
    const canonical = normalizeProviderDefinitionId(part);
    if (canonical && VALID_PROVIDERS.includes(canonical as typeof VALID_PROVIDERS[number])) {
      selected.push(canonical);
    } else {
      ui.warn(`  Unknown provider '${part}' — skipped`);
    }
  }

  return selected.length > 0 ? selected : ['claude'];
}

/**
 * Non-interactive / --yes / no-TTY runs never prompt and never touch the
 * config (#3050 item 2) — they only print one line naming the enable
 * command, when two or more worker CLIs are detected and dispatch is not
 * already on or declined. The hint also names `--worker-dispatch` (#3062):
 * that argument answers the same question headlessly.
 */
function renderWorkerDispatchHintIfApplicable(parallelism: ParallelismConfig | undefined, setup: SetupConfig | undefined): void {
  const offer = evaluateWorkerDispatchOffer(parallelism, setup, detectInstalledWorkerClis());
  if (offer.shouldOffer) ui.dim(`  ${workerDispatchOfferHintWithArg(offer.detected)}`);
}

/**
 * Parse the remaining wizard-input arguments (#3062 review item 10):
 * `--providers`, `--default-scripts`, and repeatable `--script`. Every one
 * is parsed through {@link requireFlagValue}/{@link collectFlagValues}
 * (review item 11) — a flag present without a usable value throws
 * {@link MissingFlagValueError} rather than silently resolving to "not
 * given".
 */
interface InitArgInputs {
  workerDispatchArg: WorkerDispatchArgValue | undefined;
  /** `--providers claude,codex` — undefined means "ask or default", matching the `--providers` flag `aiwg setup project` already uses. */
  providersArg: string[] | undefined;
  /** `--default-scripts true|false` — undefined means "ask or default". */
  defaultScriptsArg: boolean | undefined;
  /**
   * `--custom-scripts true|false` (#3062 second review, finding 5a) —
   * explicit answer to "add a custom script?", independent of
   * `--script`. `undefined` means "ask, or infer from whether `--script`
   * was given". Supplying `--script` always means yes regardless of this
   * flag; this flag exists for the case where the answer is *no* (or an
   * explicit yes with the name/command still to be asked for) and
   * `--script` itself was not given.
   */
  customScriptsArg: boolean | undefined;
  /** `--script <name>=<command>` (repeatable) — always honored regardless of `defaultScriptsArg`/`customScriptsArg`; supplying it at all answers "add a custom script?" as yes. */
  scriptPairs: Record<string, string>;
}

export function parseInitArgInputs(args: string[]): InitArgInputs {
  // #3062 second review, finding 4: `precedence: 'first'` matches this
  // command's pre-existing (and, for `--providers`/`--default-scripts`/
  // `--script`/`--custom-scripts`, only) convention — see
  // `parseInitArgInputs`'s module-level callers for why `--worker-dispatch`
  // specifically needs `rejectEmpty` (an explicit empty choice is never
  // meaningful and must not silently fall through to "not given").
  const workerDispatchArg = parseWorkerDispatchArg(requireFlagValue(args, { rejectEmpty: true }, '--worker-dispatch'));

  const rawProviders = parseListFlagValue(requireFlagValue(args, {}, '--providers'));
  const providersArg = rawProviders?.map((entry) => {
    const canonical = normalizeProviderDefinitionId(entry);
    if (!canonical || canonical === 'generic' || !VALID_PROVIDERS.includes(canonical as typeof VALID_PROVIDERS[number])) {
      throw new Error(`--providers: unknown provider '${entry}' (valid: ${VALID_PROVIDERS.join(', ')})`);
    }
    return canonical;
  });
  if (providersArg && providersArg.length === 0) {
    throw new Error('--providers requires at least one provider name');
  }

  const defaultScriptsArg = parseBooleanFlagValue(requireFlagValue(args, {}, '--default-scripts'), '--default-scripts');
  const customScriptsArg = parseBooleanFlagValue(requireFlagValue(args, {}, '--custom-scripts'), '--custom-scripts');

  const scriptPairs: Record<string, string> = {};
  for (const entry of collectFlagValues(args, {}, '--script')) {
    const [name, command] = parseKeyValueEntry(entry, '--script');
    scriptPairs[name] = command;
  }

  return { workerDispatchArg, providersArg, defaultScriptsArg, customScriptsArg, scriptPairs };
}

/** One-line description of what an explicit `--worker-dispatch` choice would write. */
function describeWorkerDispatchWrite(arg: WorkerDispatchArgValue): string {
  return arg === 'enable'
    ? 'enable parallelism.worker_dispatch'
    : 'record a worker-dispatch decline (setup.worker_dispatch_offer)';
}

/**
 * Resolve an explicit `--worker-dispatch` choice into a decision to apply to
 * a brand-new config (#3062). Under `--dry-run`, writes nothing — reports
 * what would be written instead and returns `undefined` so the caller never
 * applies it to the config it builds.
 */
function resolveWorkerDispatchDecisionForNewConfig(
  arg: WorkerDispatchArgValue,
  dryRun: boolean | undefined,
): WorkerDispatchDecision | undefined {
  if (dryRun) {
    ui.dim(`  Would ${describeWorkerDispatchWrite(arg)} (--dry-run writes nothing).`);
    return undefined;
  }
  return { kind: arg };
}

/** A decision from the worker-dispatch consent prompt, keyed to where it is recorded. */
type WorkerDispatchDecision = { kind: 'enable' } | { kind: 'decline' };

/**
 * Interactive-only: asks the one consent question (default/unanswered is
 * no, strict `y`/`yes` parsing only) when two or more worker CLIs are
 * detected and dispatch is not already on or declined. Returns the
 * decision to apply, or `undefined` when there is nothing to offer, or
 * when the prompt timed out / stdin closed without an answer — only an
 * actually-answered "no" is recorded as a persistent decline (#3050
 * review item 4).
 */
async function askWorkerDispatchOffer(
  rl: readline.Interface,
  parallelism: ParallelismConfig | undefined,
  setup: SetupConfig | undefined,
  signal?: AbortSignal,
): Promise<WorkerDispatchDecision | undefined> {
  const offer = evaluateWorkerDispatchOffer(parallelism, setup, detectInstalledWorkerClis());
  if (!offer.shouldOffer) return undefined;
  console.log('');
  const outcome = await askConsent(rl, workerDispatchOfferQuestion(offer.detected), undefined, signal);
  if (outcome.kind !== 'answered') return undefined;
  if (outcome.value) {
    ui.success('  Will enable parallelism.worker_dispatch.');
    return { kind: 'enable' };
  }
  ui.dim('  Noted — enable later with `aiwg config set --project parallelism.worker_dispatch true`.');
  return { kind: 'decline' };
}

export const initHandler: CommandHandler = {
  id: 'init',
  name: 'Init',
  description: 'Initialise the baseline .aiwg/aiwg.config for an agent-led project setup',
  category: 'project',
  aliases: [],

  async help(): Promise<HandlerResult> {
    return { exitCode: 0, rawOutput: true, message: `Usage: aiwg init [options]

  --scope project|user            Record a guided setup plan (no config writes)
  --intent code|docs|ops|mixed     Workspace usage intent
  --jev enable|decline|defer     Optional external decision service (default off)
  --region <r> --endpoint <url> --verify --remove --token-stdin  Existing Jev options
  --credential <provider>=stdin|file:PATH|store:NAME|env:NAME  Credential reference only
  --providers <list>              Provider IDs
  --default-scripts true|false    Include default scripts
  --custom-scripts true|false     Include custom scripts
  --script <name>=<command>       Custom script (repeatable)
  --worker-dispatch enable|decline  Worker dispatch choice
  --force                        Re-enter existing settings
  --non-interactive, --yes        Disable prompts
  --dry-run                      Preview without saving

The new --scope, --intent or --credential flags select guided planning.
Progress resumes from the workspace's saved plan. Apply is a separate step.
` };
  },

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const force = ctx.args.includes('--force');
    // `--non-interactive`/`--yes` are this command's own explicit flags for
    // the one shared interactive decision (#3062 review item 12) — honored
    // ahead of (and regardless of) the environment-only checks `isInteractive`
    // otherwise applies (TTY, TERM, CI). Downstream code MUST NOT re-derive
    // interactive-ness from process.stdin.isTTY again.
    const explicitNonInteractive = ctx.args.includes('--non-interactive') || ctx.args.includes('--yes');
    const nonInteractive = !isInteractive(explicitNonInteractive);
    const projectDir = ctx.cwd;

    // `--worker-dispatch enable|decline` answers the worker-dispatch offer
    // directly (#3062), with or without a terminal, and is honored even when
    // fewer than two worker CLIs are detected — an explicit choice overrides
    // the presence-only detection gate. `--providers`/`--default-scripts`/
    // `--script` answer the remaining wizard inputs the same way (review
    // item 10). Every flag is parsed strictly (review item 11): present
    // without a usable value is a usage error, raised here before any
    // preflight check, read, or write.
    let workerDispatchArg: WorkerDispatchArgValue | undefined;
    let providersArg: string[] | undefined;
    let defaultScriptsArg: boolean | undefined;
    let customScriptsArg: boolean | undefined;
    let scriptPairs: Record<string, string>;
    let guidedFlags: GuidedSetupFlags;
    try {
      guidedFlags = parseGuidedSetupFlags(ctx.args, 'init');
      ({ workerDispatchArg, providersArg, defaultScriptsArg, customScriptsArg, scriptPairs } = parseInitArgInputs(ctx.args));
    } catch (err) {
      const message = err instanceof MissingFlagValueError ? `${err.message}.` : err instanceof Error ? err.message : String(err);
      return { exitCode: EXIT_CODES.USAGE, message };
    }

    if (guidedFlags.enabled) {
      const hasScripts = defaultScriptsArg !== undefined || customScriptsArg !== undefined || Object.keys(scriptPairs).length > 0;
      return runGuidedSetup(ctx, guidedFlags, { providers: providersArg, workerDispatch: workerDispatchArg,
        ...(hasScripts ? { scripts: { defaultScripts: defaultScriptsArg ?? true,
          customScripts: customScriptsArg ?? Object.keys(scriptPairs).length > 0, scripts: scriptPairs } } : {}),
      }, !nonInteractive, projectDir);
    }

    ui.blank();
    console.log(`  ${ui.brandMark()} ${ui.bold('AIWG Baseline Config')}`);
    ui.rule();

    // Check for existing config
    const existing = await readAiwgConfig(projectDir);
    if (existing && !force) {
      ui.info(`Config already exists: ${getConfigPath(projectDir)}`);
      // #3062 review item 18: `--dry-run` must write nothing at all, not
      // just skip the worker-dispatch increment below.
      if (!ctx.dryRun) await writeNormalizedAiwgMd(projectDir);
      console.log(`  Providers: ${existing.providers.join(', ')}`);
      const scriptCount = Object.keys(existing.scripts).length;
      if (scriptCount > 0) {
        console.log(`  Scripts: ${Object.keys(existing.scripts).join(', ')}`);
      }
      ui.blank();
      ui.dim('  Ask your AIWG agent to review repo, tracker, delivery, signing, and provider policy.');
      ui.dim('  Agents may use `aiwg setup project --dry-run` as the CLI helper for that review.');
      ui.dim('  Run `aiwg init --force` only when you need to recreate the baseline config.');
      // #3050: guide users to direct worker dispatch from the setup step they
      // already run, instead of leaving it undiscoverable. `--dry-run` must
      // never prompt and never write (review item 1) — it degrades to the
      // same hint-only behavior as non-interactive runs.
      // #3062: an explicit `--worker-dispatch` argument always answers the
      // question directly (bypassing the ask/hint entirely) except under
      // `--dry-run`, which still writes nothing — it reports what would be
      // written instead.
      if (workerDispatchArg) {
        if (ctx.dryRun) {
          ui.dim(`  Would ${describeWorkerDispatchWrite(workerDispatchArg)} (--dry-run writes nothing).`);
        } else if (workerDispatchArg === 'enable') {
          await writeAiwgConfig(projectDir, { ...existing, parallelism: { ...existing.parallelism, worker_dispatch: true } });
          ui.success('  Enabled parallelism.worker_dispatch. Next: aiwg doctor --probe-workers --qualify.');
        } else {
          await writeAiwgConfig(projectDir, { ...existing, setup: { ...existing.setup, worker_dispatch_offer: 'declined' } });
          ui.success('  Recorded worker-dispatch decline (setup.worker_dispatch_offer).');
        }
      } else if (nonInteractive || ctx.dryRun) {
        renderWorkerDispatchHintIfApplicable(existing.parallelism, existing.setup);
      } else {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        try {
          const decision = await askWorkerDispatchOffer(rl, existing.parallelism, existing.setup, ctx.signal);
          if (decision?.kind === 'enable') {
            await writeAiwgConfig(projectDir, { ...existing, parallelism: { ...existing.parallelism, worker_dispatch: true } });
            ui.info('Next: aiwg doctor --probe-workers --qualify.');
          } else if (decision?.kind === 'decline') {
            await writeAiwgConfig(projectDir, { ...existing, setup: { ...existing.setup, worker_dispatch_offer: 'declined' } });
          }
        } finally {
          rl.close();
        }
      }
      ui.blank();
      return { exitCode: 0 };
    }

    let providers: string[];
    let scripts: Record<string, string> = {};
    let workerDispatchDecision: WorkerDispatchDecision | undefined;

    if (nonInteractive) {
      // Non-interactive: an explicit `--providers`/`--default-scripts`
      // answers the corresponding wizard input directly (review item 10);
      // anything not supplied keeps its prior default.
      providers = providersArg ?? ['claude'];
      const includeDefaultScripts = defaultScriptsArg ?? true;
      scripts = { ...(includeDefaultScripts ? DEFAULT_SCRIPTS : {}), ...scriptPairs };
      if (workerDispatchArg) {
        workerDispatchDecision = resolveWorkerDispatchDecisionForNewConfig(workerDispatchArg, ctx.dryRun);
      } else {
        renderWorkerDispatchHintIfApplicable(undefined, undefined);
      }
    } else {
      // Interactive wizard — skip a prompt whenever its argument already
      // answered it (review item 10/12: "with a terminal we can skip steps
      // for any params provided and only provide interaction when we are
      // missing a value").
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      try {
        // Thread ctx.signal through every prompt so Ctrl-C during the wizard
        // cancels cleanly instead of being absorbed by readline (POC #926).
        providers = providersArg ?? await askProviders(rl, ctx.signal);

        console.log('');
        const includeDefaultScripts = defaultScriptsArg !== undefined
          ? defaultScriptsArg
          : await askYesNo(rl, '  Add default scripts (deploy, doctor, sync)? [Y/n]: ', true, ctx.signal);
        scripts = includeDefaultScripts ? { ...DEFAULT_SCRIPTS } : {};

        if (Object.keys(scriptPairs).length > 0) {
          // `--script` already answered "add a custom script?" (implicit
          // yes) and its name/command sub-prompts — never ask any of the
          // three (#3062 second review, finding 5a).
          scripts = { ...scripts, ...scriptPairs };
        } else {
          // `--custom-scripts true|false` answers "add a custom script?"
          // directly when `--script` itself was not given — an explicit
          // decline (`false`) skips the question entirely, same as every
          // other already-supplied input; `true` still asks for the
          // name/command, since those were not supplied either.
          const addCustom = customScriptsArg !== undefined
            ? customScriptsArg
            : includeDefaultScripts
              ? await askYesNo(rl, '  Add a custom script? [y/N]: ', false, ctx.signal)
              : false;
          if (addCustom) {
            const name = await askString(rl, '  Script name: ', '', ctx.signal);
            const cmd = await askString(rl, '  Command: ', '', ctx.signal);
            if (name && cmd) {
              scripts[name] = cmd;
            }
          }
        }

        // #3050: offer direct worker dispatch inside the same wizard — but
        // `--dry-run` must never prompt or write anything from the offer
        // (review item 1), so it degrades to the hint instead. An explicit
        // `--worker-dispatch` argument (#3062) always answers the question
        // directly instead of asking or hinting, still subject to `--dry-run`
        // writing nothing.
        if (workerDispatchArg) {
          workerDispatchDecision = resolveWorkerDispatchDecisionForNewConfig(workerDispatchArg, ctx.dryRun);
        } else if (ctx.dryRun) {
          renderWorkerDispatchHintIfApplicable(undefined, undefined);
        } else {
          workerDispatchDecision = await askWorkerDispatchOffer(rl, undefined, undefined, ctx.signal);
        }
      } finally {
        rl.close();
      }
    }

    // Build config
    let config = emptyConfig(providers);
    config.scripts = scripts;
    if (workerDispatchDecision?.kind === 'enable') {
      config.parallelism = { ...config.parallelism, worker_dispatch: true };
    } else if (workerDispatchDecision?.kind === 'decline') {
      config.setup = { ...config.setup, worker_dispatch_offer: 'declined' };
    }

    // #3062 review item 18: `--dry-run` writes nothing at all — not even
    // the baseline config — rather than only skipping the worker-dispatch
    // increment. Report what would be written instead.
    if (ctx.dryRun) {
      ui.blank();
      ui.dim(`  Would create ${getConfigPath(projectDir)} (--dry-run writes nothing).`);
      ui.dim(`  Providers: ${providers.join(', ')}`);
      if (Object.keys(scripts).length > 0) ui.dim(`  Scripts: ${Object.keys(scripts).join(', ')}`);
      ui.blank();
      return { exitCode: 0 };
    }

    // Populate deployedTo from disk for entries with empty deployedTo (#721)
    config = await populateDeployedTo(config, projectDir);

    // Write
    await writeAiwgConfig(projectDir, config);
    if (workerDispatchDecision?.kind === 'enable') ui.info('Next: aiwg doctor --probe-workers --qualify.');
    const skipContext = ctx.args.includes('--no-context-files');
    const normalizedAiwgMdPath = skipContext ? null : await writeNormalizedAiwgMd(projectDir);
    const workspace = skipContext ? null : await ensureWorkspaceContext(projectDir);

    ui.blank();
    ui.success(`Created ${getConfigPath(projectDir)}`);
    if (normalizedAiwgMdPath) ui.success(`Created ${normalizedAiwgMdPath}`);
    if (workspace) ui.success(`${workspace.action === 'created' ? 'Created' : 'Preserved'} WORKSPACE.md`);
    ui.success(`Providers: ${providers.join(', ')}`);
    if (Object.keys(scripts).length > 0) {
      ui.success(`Scripts: ${Object.keys(scripts).join(', ')}`);
    }
    ui.blank();
    console.log('  Next steps:');
    console.log('    Ask your AIWG agent: "Help me set up this project for AIWG."');
    console.log('    The agent may use `aiwg setup project --dry-run` to preview policy choices.');
    console.log('    aiwg use sdlc                 Deploy SDLC framework to configured providers');
    console.log('    aiwg run                      List all defined scripts');
    ui.blank();

    return { exitCode: 0 };
  },
};
