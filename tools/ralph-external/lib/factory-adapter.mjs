/**
 * Factory (Droid) CLI Provider Adapter for External Ralph Loop
 *
 * Provides support for Factory's Droid CLI as a provider for
 * autonomous task execution in Ralph loops.
 *
 * Droid CLI differences from Claude:
 * - Binary: `droid` instead of `claude`
 * - Headless mode: `droid exec` subcommand
 * - Permission bypass: `--skip-permissions-unsafe` instead of `--dangerously-skip-permissions`
 * - Output format: `--output-format text|stream-json` (supports stream-json!)
 * - Session resume: `-s/--session-id <id>` with prompt required
 * - Model selection: `-m/--model <id>` (direct model IDs, not generic)
 * - No --print flag (exec is already non-interactive)
 * - No --append-system-prompt (inject into main prompt)
 * - No --max-budget-usd flag
 * - No --max-turns flag
 * - No --mcp-config flag (but has MCP subcommand)
 * - No --agent flag
 * - Autonomy levels: --auto low|medium|high (alternative to skip-permissions)
 *
 * @implements Plan: Multi-Provider Support for External Ralph Loop
 */

import { ProviderAdapter, registerProvider } from './provider-adapter.mjs';
import { classifyWorkerHealthFailure, healthEventMatchesBinding } from './worker-health.mjs';

/** Model mapping from generic names to Factory/Droid model IDs */
const MODEL_MAP = {
  'opus': 'claude-opus-5',
  'sonnet': 'claude-sonnet-5',
  'haiku': 'claude-haiku-4-5-20251001',
};

/**
 * Version-bound direct-worker surface (roctinam/aiwg#2902, B-OG-37).
 *
 * Help-verified on titan with droid-cli 1.0.0 (2026-11-06 eval).
 * Stdin brief echoed in the first stream-json message; live result pending
 * (402 No active subscription). This is not live qualification:
 *
 *   droid exec [--auto low] -m M -r E --cwd W --output-format stream-json < briefPath
 *
 * `exec` is Droid's non-interactive mode ("Run non-interactively (for
 * scripts/automation)"); `-m/--model`, `-r/--reasoning-effort`, `--auto`,
 * `--cwd` and `-o/--output-format` are all `exec`-level flags on 1.0.0
 * `exec --help`. There is no file-output flag (`-o` selects the *format*,
 * not a destination path): the final is read from the captured stdout
 * stream instead, never a separate file. There is no positional `prompt`
 * requirement either — `exec --help`'s own Examples show
 * `echo "analyze code" | droid exec` and `cat prompt.txt | droid exec --auto
 * medium` with no `prompt` argument at all, so omitting the positional and
 * piping the brief to stdin (`stdin: 'brief-text'`) is help-evidenced, not
 * invented; the brief never enters argv. `--skip-permissions-unsafe`
 * ("Bypass all checks - DANGEROUS!") is Ralph-loop legacy
 * (`buildSessionArgs` below) and is never emitted by the direct profile.
 * The generic cross-provider sandbox contract this profile accepts is
 * `read-only`/`workspace-write`; `workspace-write` maps to `--auto low`
 * ("File creation/modification in non-system directories") and
 * `read-only` maps to no `--auto` flag at all — `exec --help`'s own
 * "Autonomy Levels" section documents the no-flags default as read-only,
 * so omitting it is the exact, help-evidenced way to request it, not an
 * inherited default. `medium`/`high` are out of this contract's scope and
 * are never emitted. `exec --help`'s "Autonomy Levels" section is also the
 * sole permission gate `exec` exposes — there is no separate
 * approval-prompt flag, because `exec` is non-interactive by construction
 * regardless of autonomy level. Reasoning-effort levels are model-dependent
 * (`exec --help`'s "Model details" lists the per-model valid sets); an
 * explicit value drawn from the observed union of every model's levels is
 * required and the CLI's per-model default is never inherited.
 *
 * `--output-format stream-json` and the terminal `json` object shape are
 * doc-sourced; stdin ingestion alone does not verify a successful
 * result: https://docs.factory.com/droid-exec/overview documents
 * `--output-format json` producing exactly one terminal object,
 * `{"type":"result","subtype":"success","is_error":false,"duration_ms":N,
 * "num_turns":N,"result":"...","session_id":"..."}`, and
 * https://docs.factory.com/sdk/typescript documents the same message
 * vocabulary the CLI's JSON-RPC/stream protocol shares across surfaces:
 * default types `assistant`, `user`, `tool_call`, `tool_result`, `hook`,
 * `error` and the terminal `result` (subtypes `success`, `interrupted`,
 * `error_during_execution`, `error_structured_output`). This grammar
 * drives `observeHealthEvent`/`parseDirectFinal` below but is explicitly
 * doc-sourced evidence (grade D), never live qualification, and the
 * registry `qualification.status` stays `unqualified`.
 *
 * Authentication travels via `FACTORY_API_KEY` in the environment
 * (`exec --help`'s "Authentication" section); `HOME` stays on the env
 * allowlist because `--worktree-dir`'s deprecation notice points at
 * `~/.factory/settings.json` for persistent settings.
 *
 * Installed-module shape: static `interfaceVersion` and `register` exports
 * so the #2885 installed loader can approve this file by digest under
 * `installed:factory` (mirroring #2897 codex-adapter.mjs / #2911
 * openhuman-adapter.mjs). The bottom self-registration targets the legacy
 * Ralph-loop registry only; the direct worker profile loads through the
 * installed loader.
 */
export const FACTORY_SUPPORTED_VERSIONS = Object.freeze(['1.0.0']);
/** Union of every reasoning-effort label observed across models in
 * `exec --help`'s "Model details" section (including `none`, the sole
 * level for "Auto Model" and one of the levels for GPT-6 Sol/Luna and
 * GPT-5.6 Sol/Sol Fast/Terra/Luna); the valid subset is model-dependent
 * and unqualified until live evidence. */
export const FACTORY_DIRECT_EFFORT_VALUES = Object.freeze(['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
/** Generic cross-provider sandbox contract this profile accepts
 * (`WorkerExecution.sandbox`). `--skip-permissions-unsafe` and the
 * `medium`/`high` `--auto` tiers are legacy/unsafe or out of this
 * contract's scope and are never emitted by the direct profile. */
export const FACTORY_DIRECT_SANDBOX_MODES = Object.freeze(['read-only', 'workspace-write']);
/** `--auto` is droid's only scoped autonomy flag: `workspace-write` maps to
 * the least-privileged writable tier (`low`, "File creation/modification
 * in non-system directories"); `read-only` maps to no `--auto` flag at
 * all, because omitting it is help-evidenced as the CLI's own read-only
 * mode (`exec --help`'s "Autonomy Levels": "DEFAULT (no flags) -
 * Read-only mode") and there is no more-explicit way to request it. */
const FACTORY_SANDBOX_TO_AUTO = Object.freeze({ 'read-only': null, 'workspace-write': 'low' });
/** `exec` has no separate approval-prompt flag: non-interactive by
 * construction, so only the no-prompt policy is ever requested. */
export const FACTORY_DIRECT_APPROVAL_POLICIES = Object.freeze(['never']);
/** Brief transport for the direct profile: piped stdin, never argv. */
export const FACTORY_DIRECT_STDIN = 'brief-text';
/** Generic Ralph-loop aliases resolve through MODEL_MAP above; the direct
 * profile requires an exact observed catalog model instead. */
const FACTORY_GENERIC_ALIASES = Object.freeze(['opus', 'sonnet', 'haiku']);
/** `exec --help`'s "Available Models" section lists `auto` as "Auto
 * Model" with "supports reasoning: No; supported: [none]" in "Model
 * details" — the CLI itself, not the resolved selection, then picks the
 * real model. `-m auto` would silently violate the explicit-model
 * invariant exactly as an omitted `-m` would (the CLI's own documented
 * default-by-omission is `gpt-6-sol`, per `exec --help`'s
 * `-m, --model <id> ... (default: gpt-6-sol)`); buildWorkerArgs already
 * refuses omission by requiring a non-empty string, and this refuses the
 * equivalent `auto` escape hatch case-insensitively. */
const FACTORY_RESERVED_MODEL_VALUES = Object.freeze(['auto']);

export class FactoryAdapter extends ProviderAdapter {
  /**
   * Doc-sourced `assistant`/`user`/`tool_call`/`tool_result`/`hook`/`error`/
   * `result` vocabulary (module doc above). No session-start event is
   * evidenced, so the handshake stays `process-only`; a standalone `error`
   * event is fatal exactly like a `result` with `is_error: true`, so a later
   * clean terminal can never paper over it. Session exports and another
   * provider's event names cannot qualify this grammar.
   *
   * Terminal `result` success requires AFFIRMATIVE markers, never an
   * absence of negative ones: this doc-sourced grammar (grade D, never
   * live-observed) is not trusted to omit fields consistently, so a bare
   * `{"type":"result"}` or any other field combination that is not
   * exactly the documented success shape — `subtype === 'success'`,
   * `is_error === false`, and a non-empty `result` string — fails closed
   * rather than defaulting to success. An `interrupted`/
   * `error_during_execution`/`error_structured_output`/unknown `subtype`,
   * a missing or non-`false` `is_error`, or an empty/missing `result` are
   * all failures even if the other fields look clean.
   * @returns {import('./worker-health.mjs').HealthObservation | null}
   */
  observeHealthEvent(event, source, binding) {
    if (source?.kind !== 'stdout' || !event || typeof event !== 'object' || typeof event.type !== 'string') return null;
    if (!healthEventMatchesBinding({ sessionId: event.session_id }, binding)) return null;
    if (event.type === 'result') {
      const hasResultContent = typeof event.result === 'string' && event.result.trim().length > 0;
      const success = event.subtype === 'success' && event.is_error === false && hasResultContent;
      return { kind: 'terminal', success, key: event.subtype ?? 'result' };
    }
    if (event.type === 'error') {
      return { ...classifyWorkerHealthFailure({ type: 'error', message: event.message ?? event.error?.message }, { source, provider: 'factory' }),
        fatal: true };
    }
    if (event.type === 'tool_result') {
      const id = event.tool_call_id ?? event.id;
      return (typeof id === 'string' || typeof id === 'number') ? { kind: 'progress', key: String(id) } : { kind: 'activity' };
    }
    if (event.type === 'tool_call' || event.type === 'assistant' || event.type === 'user' || event.type === 'hook') {
      return { kind: 'activity' };
    }
    return null;
  }

  /**
   * Driver-owned argv after the binary for the version-bound direct-shell
   * profile. Every control is explicit: exact observed model (never an
   * alias or the CLI's `gpt-6-sol` default), explicit reasoning effort
   * (never a per-model default), the scoped `--auto` autonomy level (never
   * `--skip-permissions-unsafe`), the conductor workdir as `--cwd` and the
   * `stream-json` event stream. No prompt argument is emitted: the brief
   * arrives on stdin (`stdin: 'brief-text'`), so it never enters argv.
   *
   * @param {{ selected?: { model?: unknown, effort?: { value?: unknown } }, cwd?: unknown, brief?: unknown }} invocation
   * @param {unknown} _profile
   * @param {{ sandbox?: unknown, approval?: unknown }} [permissions]
   * @returns {string[]}
   */
  buildWorkerArgs(invocation, _profile, permissions) {
    const model = invocation?.selected?.model;
    if (typeof model !== 'string' || !model || model.includes('\0')) {
      throw new Error('Factory worker requires an explicit model');
    }
    if (FACTORY_GENERIC_ALIASES.includes(model.toLowerCase())) {
      throw new Error(`Factory worker requires an exact observed model, not the generic alias '${model}'`);
    }
    if (FACTORY_RESERVED_MODEL_VALUES.includes(model.toLowerCase())) {
      throw new Error(`Factory worker requires an explicit observed model, not the CLI's own auto-selection '${model}'`);
    }
    const effort = invocation?.selected?.effort?.value ?? null;
    const customNoEffort = model.startsWith('custom:') && invocation?.selected?.effort?.support === 'not-applicable' && effort === null;
    if (!customNoEffort && (effort === null || !FACTORY_DIRECT_EFFORT_VALUES.includes(effort))) {
      throw new Error('Factory worker requires an explicit qualified reasoning effort (never a CLI default)');
    }
    const sandbox = permissions?.sandbox ?? 'workspace-write';
    if (!FACTORY_DIRECT_SANDBOX_MODES.includes(sandbox)) {
      throw new Error(`Factory worker sandbox is not a qualified direct mode: ${String(sandbox)}`);
    }
    const approval = permissions?.approval ?? 'never';
    if (!FACTORY_DIRECT_APPROVAL_POLICIES.includes(approval)) {
      throw new Error(`Factory worker approval is not a qualified direct policy: ${String(approval)}`);
    }
    const cwd = invocation?.cwd;
    if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.includes('\0')) {
      throw new Error('Factory worker requires an absolute workspace');
    }
    const brief = invocation?.brief;
    if (typeof brief !== 'string' || !brief || brief.includes('\0')) {
      throw new Error('Factory worker requires a non-empty brief');
    }
    const auto = FACTORY_SANDBOX_TO_AUTO[sandbox];
    const args = ['exec'];
    if (auto) args.push('--auto', auto);
    args.push('-m', model, ...(customNoEffort ? [] : ['-r', effort]), '--cwd', cwd, '--output-format', 'stream-json');
    return args;
  }

  /**
   * `exec` reads the brief from stdin to EOF and has no documented stdin
   * abort channel, so cancellation stays with owned process control.
   * @returns {null}
   */
  getAbortInput() {
    return null;
  }

  /**
   * Direct-profile final extraction from the captured `--output-format
   * stream-json` stdout stream (module doc above). Unlike the legacy
   * `parseOutput()` below (pinned regex-based shape, never changed here),
   * this is JSONL-aware and fails closed on its own, without relying on the
   * health observer: a malformed line, a standalone `error` event, or ANY
   * `result` line that is not the documented success shape (`subtype ===
   * 'success'`, `is_error === false`, non-empty `result`) rejects the whole
   * stream. A later success never replaces an earlier failure, and an error
   * after a success is never ignored. Returns the last successful `result`.
   * @param {string} stdout
   * @returns {Object|null}
   */
  parseDirectFinal(stdout) {
    if (typeof stdout !== 'string' || !stdout.trim()) return null;
    let final = null;
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return null;
      }
      if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
      if (event.type === 'error') return null;
      if (event.type !== 'result') continue;
      const hasResultContent = typeof event.result === 'string' && event.result.trim().length > 0;
      if (!(event.subtype === 'success' && event.is_error === false && hasResultContent)) return null;
      final = event;
    }
    return final;
  }


  /** @returns {string} */
  getBinary() {
    return 'droid';
  }

  /** @returns {string} */
  getName() {
    return 'factory';
  }

  /**
   * Factory supports stream-json output and session resume.
   * @returns {import('./provider-adapter.mjs').ProviderCapabilities}
   */
  getCapabilities() {
    return {
      streamJson: true,
      sessionResume: true,
      budgetControl: false,
      systemPrompt: false,
      agentMode: false,
      mcpConfig: false,
      maxTurns: false,
    };
  }

  /**
   * Build args for the main headless session.
   *
   * Factory uses `droid exec --skip-permissions-unsafe` for headless operation.
   *
   * @param {import('./provider-adapter.mjs').SessionArgs} options
   * @returns {string[]}
   */
  buildSessionArgs(options) {
    const args = [
      'exec',
      // SECURITY: --skip-permissions-unsafe bypasses ALL permission prompts
      // Equivalent to Claude's --dangerously-skip-permissions
      '--skip-permissions-unsafe',
      '--output-format', 'stream-json',
    ];

    // Model selection (map generic to Factory model IDs)
    if (options.model) {
      args.push('-m', this.mapModel(options.model));
    }

    // Session resume
    if (options.sessionId) {
      args.push('-s', options.sessionId);
    }

    // Budget control not supported
    if (options.budget) {
      this.warnUnsupported('budgetControl', 'Budget control (--max-budget-usd)');
    }

    // Max turns not supported
    if (options.maxTurns) {
      this.warnUnsupported('maxTurns', 'Max turns (--max-turns)');
    }

    // MCP configuration not supported via flag
    if (options.mcpConfig) {
      this.warnUnsupported('mcpConfig', 'MCP configuration (--mcp-config)');
    }

    // System prompt: Factory doesn't support --append-system-prompt,
    // so we prepend it to the main prompt
    let prompt = options.prompt;
    if (options.systemPrompt) {
      prompt = `[System Context]\n${options.systemPrompt}\n\n[Task]\n${prompt}`;
    }

    // The prompt itself (must be last)
    args.push(prompt);

    return args;
  }

  /**
   * Build args for short analysis calls (spawnSync).
   *
   * Uses read-only mode (no --skip-permissions-unsafe) since analysis
   * calls only need to read and reason, not modify files.
   *
   * @param {import('./provider-adapter.mjs').AnalysisArgs} options
   * @returns {string[]}
   */
  buildAnalysisArgs(options) {
    const args = [
      'exec',
      '--output-format', 'text',
    ];

    // Model selection
    if (options.model) {
      args.push('-m', this.mapModel(options.model));
    }

    // Agent flag not supported by Factory
    if (options.agent) {
      // Silently skip - agent context will be in the prompt itself
    }

    // The analysis prompt (must be last)
    args.push(options.prompt);

    return args;
  }

  /**
   * Map generic model names to Factory/Droid model IDs.
   *
   * @param {string} genericModel
   * @returns {string}
   */
  mapModel(genericModel) {
    const mapped = MODEL_MAP[genericModel.toLowerCase()];
    if (mapped) return mapped;
    // Pass through if already a Factory model name or unknown
    return genericModel;
  }

  /**
   * Environment overrides for headless Factory sessions.
   * @returns {Object<string, string>}
   */
  getEnvOverrides() {
    return {
      CI: 'true',
    };
  }

  /**
   * Factory does not expose session transcripts in a known file path.
   * @returns {null}
   */
  getTranscriptPath() {
    return null;
  }

  /**
   * Parse Factory output — supports stream-json or text.
   *
   * @param {string} stdout
   * @returns {Object|null}
   */
  parseOutput(stdout) {
    try {
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      return JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }
  }
}

// Self-register on import for the legacy Ralph loop only. The direct worker
// profile loads through the #2885 installed loader instead (see below).
registerProvider('factory', () => new FactoryAdapter());

/**
 * #2995: `FactoryAdapter.parseOutput` above is the legacy-pinned,
 * loose-regex candidate parser (`test/unit/ralph/factory-adapter.test.mjs`
 * and the legacy Ralph loop depend on its exact shape) — it extracts the
 * FIRST `{...}` to the LAST `}` across the whole stdout, so it fails
 * (returns null) on any realistic multi-event `stream-json` run (assistant/
 * tool_call/tool_result lines before the final `result` line), and it is
 * loose in the other direction too (a non-affirmative or empty-text result
 * can still parse as a truthy object). The installed-module loader's
 * `extractFinal` hook IS `instance.parseOutput` (src/models/
 * worker-installation.mjs ~l.730) and session-launcher.mjs's gate
 * (~l.462) throws unless that hook returns a non-null, non-`success:false`
 * result — so a real direct-shell run could never reach `parseWorkerFinal`
 * at all with the legacy parser wired to it.
 *
 * `FactoryDirectAdapter` is the Claude/Hermes `-direct`-subclass pattern:
 * only `parseOutput` changes, to the ALREADY-correct `parseDirectFinal`
 * (above — one rule, never a second one), which returns null unless the
 * whole stream is a single droid-shaped success terminal with non-empty
 * text. `parseWorkerFinal` only needs the strict version here (no
 * generic-envelope fallback): this class is never reachable through the
 * legacy bare `registerProvider('factory', ...)` id above, only through
 * the installed-module `register(factory)` export below, so the legacy
 * group-mode contract (test/unit/ralph-external/worker-finals.test.ts)
 * never sees it.
 */
export class FactoryDirectAdapter extends FactoryAdapter {
  // #2995 round 4 (item 3): production resolves the installed adapter by
  // `adapter.id` (now `factory-direct`, item B) and
  // src/models/worker-installation.mjs's `inspectWorkerInstallation`
  // requires `adapter.id === instance.getName()`. `getBinary()` (the real
  // `droid` executable) and the `provider: 'factory'` literals inside
  // `observeHealthEvent` are untouched -- only this identity label changes.
  getName() { return 'factory-direct'; }

  parseOutput(stdout) {
    return this.parseDirectFinal(stdout);
  }

  /**
   * @param {string|Uint8Array} output
   * @param {Object} [options]
   * @returns {Promise<import('../../../src/mission-protocol/types.js').WorkerClaims>}
   */
  async parseWorkerFinal(output, options = {}) {
    if (options.format === 'mcp') return super.parseWorkerFinal(output, options);
    const text = typeof output === 'string' ? output : Buffer.from(output).toString('utf8');
    const final = this.parseDirectFinal(text);
    if (!final) throw new Error('Factory worker stream did not produce a successful final result');
    return super.parseWorkerFinal(final.result, { ...options, format: 'json' });
  }
}

/** Installed-module interface version (mirrors #2897 codex-adapter.mjs). */
export const interfaceVersion = 1;

/** Installed-module registration: exactly the one approved adapter ID. */
export function register(factory) {
  factory('factory-direct', () => new FactoryDirectAdapter());
}

export default FactoryAdapter;
