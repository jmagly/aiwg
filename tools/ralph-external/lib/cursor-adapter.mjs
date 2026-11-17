/**
 * Cursor Agent CLI Provider Adapter for External Ralph Loop
 *
 * Provides support for Cursor's `cursor-agent` CLI as a provider for
 * autonomous task execution in Ralph loops.
 *
 * @implements Plan: Multi-Provider Support for External Ralph Loop
 */

import { ProviderAdapter, registerProvider } from './provider-adapter.mjs';
import { classifyWorkerHealthFailure, healthEventMatchesBinding } from './worker-health.mjs';

/**
 * Version-bound direct-worker surface (roctinam/aiwg#2903, B-OG-38).
 *
 * Observed against cursor-agent 2026.11.13-eacade1 on 2026-11-17:
 * --help, --list-models, plain-model stdin smoke and unapproved-MCP smoke.
 * Earlier bundle analysis used 2026.10.01-e373342 on noodle. These
 * observations do not qualify dispatch; a human must review a live run:
 *
 *   cursor-agent -p --output-format stream-json --trust --sandbox enabled \
 *     [--mode ask] --workspace W --model MODEL < briefPath
 *
 * `-p/--print` is the headless entry point ("Print responses to console
 * (for scripts or non-interactive use). Has access to all tools, including
 * write and shell."); `--output-format` ("only works with --print"),
 * `--trust` ("Trust the current workspace without prompting"), `--sandbox
 * <mode>` (choices "enabled"/"disabled"), `--mode <mode>` (choices
 * "plan"/"ask"; "ask: Q&A style for explanations and questions
 * (read-only)") and `--model <model>` are all documented root-level flags
 * on the captured `--help`. The captured `--help` documents only
 * `--model`, not a `-m` short alias; the short form is never emitted.
 * `-f/--force`, `--yolo`, `--auto-review` and `--approve-mcps` are never
 * emitted: `--approve-mcps` is a bypass, not a non-approval convenience
 * (see the MCP paragraph below), and the other three can run or
 * auto-approve tool calls the profile did not explicitly request; `--yolo`
 * is documented as an alias for `--force` ("Run Everything"). `--trust` is
 * always emitted so the one remaining documented prompt (workspace trust)
 * cannot block a non-interactive run; it does not bypass a command/file
 * permission the resolved sandbox did not already grant.
 *
 * MCP servers: fix round 1 (roctinam/aiwg#2903) corrects the first pass's
 * claim that `--approve-mcps` is harmless. The installed-module bundle
 * read on noodle (`8192.index.js`) shows `--approve-mcps` sets
 * `ignoreApprovals: true` on the MCP approval source, which replaces the
 * normal `mcp-approvals.json`-backed `isServerApproved()` check with a
 * stub that always resolves `true` — i.e. it is an approval BYPASS exactly
 * like `--force`/`--yolo` (the same bundle read shows all three folded
 * into one `runEverything || approveMcps` flag upstream), not a
 * convenience that merely silences a prompt. Without `--approve-mcps`
 * (the default, and this profile's choice), an MCP server that is not
 * already recorded as approved in that project's `mcp-approvals.json`
 * fails its `load()` call with a thrown error (captured into
 * `pluginMcpLoadErrors`) and is skipped — the run continues without that
 * server's tools; it does not hang and does not silently execute anything.
 * The captured `--help` documents no flag to disable MCP outright (only
 * the `mcp` subcommand, which manages persistent project/user
 * configuration, not a per-invocation flag); omitting `--approve-mcps` is
 * the help-evidenced-by-absence safe choice, and a fresh conductor
 * workdir has no project-scoped MCP config to begin with.
 *
 * Effort has no standalone flag: select the exact catalog model ID whose
 * name encodes the desired effort (e.g. gpt-5.3-codex-high). Although
 * 2026.11.13 --help still advertises bracket overrides for parameterized
 * models, the live CLI rejects the bracket form for listed models:
 * claude-sonnet-5-thinking-high[effort=low] exits 1 with "Cannot use this
 * model" and no JSON. Never append an override to a catalog ID. Models
 * such as composer-2.5 expose no separate effort selector; the requested
 * effort remains validated metadata, not an additional CLI control.
 *
 * Sandbox: `--sandbox enabled` is emitted for BOTH sandbox contracts (the
 * bundled installed-module read on noodle shows `sandboxMode:"enabled"`
 * pairs with `approvalMode:"allowlist"`, and the default non-interactive
 * approval fallback the same read shows is `{approved:false,reason:"User
 * Rejected"}` — i.e. a denied command degrades the run rather than
 * blocking on a prompt with no TTY to answer it; `--sandbox disabled` is
 * never emitted by this profile). `read-only` additionally emits `--mode
 * ask` (`--help`'s own "(read-only)" annotation) on top of `--sandbox
 * enabled`; `workspace-write` emits `--sandbox enabled` alone (the CLI's
 * default mode). There is no `--approval-policy` flag: `--sandbox`/`--mode`
 * are this CLI's only non-`--force`/`--yolo` permission controls, so
 * `CURSOR_DIRECT_APPROVAL_POLICIES` records that the direct profile's only
 * accepted request is `never` (no approval-bypass flag is ever emitted),
 * not a CLI-level enum.
 *
 * Completion grammar (installed-module bundle read on noodle,
 * `~/.local/share/cursor-agent/versions/2026.10.01-e373342/7000.index.js`,
 * never executed): a successful run writes exactly one
 * `{"type":"result","subtype":"success","is_error":false,"result":"...",
 * "session_id":...}` line to stdout before exiting 0; before that, with
 * `--output-format stream-json`, it also writes `{"type":"system",
 * "subtype":"init",...}` once at session start and
 * `{"type":"thinking"|"tool_call",...}` lines during the turn. Critically,
 * this version's non-interactive path has **no** standalone `type:"error"`
 * terminal event — a thrown error writes a plain-text line (not JSON) and
 * exits non-zero (code 1; `SIGINT`'s own code for cancellation), with no
 * JSON result line at all. "no terminal event and exit code != 0" is a
 * failure signal the caller must use alongside this module; the parser
 * and health observer below additionally fail closed, defensively, on ANY
 * `{"type":"error",...}` line or any event carrying a non-null top-level
 * `error` field, in ANY position in the stream — including after an
 * earlier affirmative success — because a later clean-looking event must
 * never repair an earlier failure. A `{"type":"interaction_query",
 * "subtype":"request",...}` line means the CLI is waiting for an approval
 * answer this profile cannot supply (no TTY); it is treated as fatal in
 * the same position-independent way, whether it arrives before or after a
 * success line, because it is evidence of a prompt the non-interactive
 * run cannot have actually resolved cleanly.
 *
 * Installed-module shape: static `interfaceVersion` and `register` exports
 * so the #2885 installed loader can approve this file by digest under
 * `installed:cursor` (mirroring #2897 codex-adapter.mjs). The bottom
 * self-registration targets the legacy Ralph-loop registry only; the
 * direct worker profile loads through the installed loader.
 *
 * Version-pin note (SE4, `.aiwg/planning/multi-cli-orchestration/
 * 17-baseline-simplification-decision.md`): `cursor-agent --version` prints
 * the raw banner `2026.10.01-e373342` (a leading-zero day-of-month).
 * `semver.validRange`/`satisfies` (used by `inspectWorkerInvocationProfile`
 * in src/models/provider-policy.ts, shared code this profile does not
 * change) reject a leading-zero numeric identifier as invalid, so that
 * literal string can never satisfy a version range. Every version string
 * that historical profile pinned therefore used the semver-normalized
 * form `2026.10.1-e373342` (same numeric value, no leading zero). The
 * current 2026.11.13-eacade1 needs no normalization; callers strip any
 * leading zero from historical raw
 * `--version` output the same way before calling
 * `qualifyWorkerInvocationProfile`, or a correct installation is
 * unconditionally refused.
 */
export const CURSOR_SUPPORTED_VERSIONS = Object.freeze(['2026.11.13-eacade1']);
/** Validate requested effort metadata; the selected catalog model ID
 * carries any CLI-supported effort variant (module doc above). */
export const CURSOR_DIRECT_EFFORT_PATTERN = /^[A-Za-z0-9_.-]+$/;
export const CURSOR_DIRECT_SANDBOX_MODES = Object.freeze(['read-only', 'workspace-write']);
/** No approval-prompt enum is documented; the only accepted request is
 * "never emit an approval-bypass flag" (module doc above). */
export const CURSOR_DIRECT_APPROVAL_POLICIES = Object.freeze(['never']);
/** Brief transport for the direct profile: piped stdin, never argv — the
 * installed-module bundle read shows the prompt positional is read from
 * stdin to EOF only when no positional argument is supplied. */
export const CURSOR_DIRECT_STDIN = 'brief-text';
/** There is no generic Ralph-loop alias table for Cursor; any bare role
 * name is refused by the direct profile exactly like an unqualified model. */
const CURSOR_GENERIC_ALIASES = Object.freeze(['opus', 'sonnet', 'haiku']);
/** The live list includes "auto", but direct workers require an exact
 * observed model. Fix round 1 (roctinam/aiwg#2903) found probes
 * accepted the common auto-selection sentinels `auto` and `default`
 * unchecked. Refused defensively, case-insensitively, because the exact
 * model invariant must not depend on the CLI rejecting them itself. */
const CURSOR_RESERVED_MODEL_VALUES = Object.freeze(['auto', 'default']);

export class CursorAdapter extends ProviderAdapter {
  /**
   * Doc/bundle-sourced `system`/`thinking`/`tool_call`/`interaction_query`/
   * `result` vocabulary (module doc above). No `type:"error"` terminal is
   * evidenced on this version's non-interactive path, so a missing/absent
   * terminal plus a non-zero exit is the failure signal the caller must use
   * (observeHealthEvent alone cannot see the exit code). Defensively, ANY
   * `type:"error"` event or any event carrying a non-null top-level
   * `error` field is fatal regardless of position — including after an
   * earlier successful terminal — and an `interaction_query` "request" is
   * fatal the same way: both prove the run cannot be trusted as a clean
   * success, so a later (or earlier) "terminal" can never paper over them.
   * @returns {import('./worker-health.mjs').HealthObservation | null}
   */
  observeHealthEvent(event, source, binding) {
    if (source?.kind !== 'stdout' || !event || typeof event !== 'object' || Array.isArray(event)) return null;
    // An untyped object carrying an error (e.g. {"error":"boom"}) is fatal too:
    // check it before the type guard so it can never be skipped as unknown.
    if (event.error != null) {
      const message = event.message ?? (typeof event.error === 'string' ? event.error : event.error?.message);
      return { ...classifyWorkerHealthFailure({ type: 'error', message }, { source, provider: 'cursor' }), fatal: true };
    }
    if (typeof event.type !== 'string') return null;
    if (!healthEventMatchesBinding({ sessionId: event.session_id }, binding)) return null;
    if (event.type === 'error') {
      const message = event.message ?? (typeof event.error === 'string' ? event.error : event.error?.message);
      return { ...classifyWorkerHealthFailure({ type: 'error', message }, { source, provider: 'cursor' }), fatal: true };
    }
    if (event.type === 'result') {
      const hasResultContent = typeof event.result === 'string' && event.result.trim().length > 0;
      const success = event.subtype === 'success' && event.is_error === false && hasResultContent;
      return { kind: 'terminal', success, key: event.subtype ?? 'result' };
    }
    // Any interaction_query is an approval/interaction the worker cannot answer, with or without a subtype.
    if (event.type === 'interaction_query') {
      return { ...classifyWorkerHealthFailure({ type: 'interaction_query', message: `approval required: ${event.query_type ?? 'unknown'}` },
        { source, provider: 'cursor' }), fatal: true };
    }
    if (event.type === 'system' && event.subtype === 'init') return { kind: 'setup', sessionId: event.session_id };
    if (event.type === 'tool_call' && event.subtype === 'completed') {
      const id = event.call_id;
      return (typeof id === 'string' || typeof id === 'number') ? { kind: 'progress', key: String(id) } : { kind: 'activity' };
    }
    if (event.type === 'tool_call' || event.type === 'thinking' || event.type === 'system') return { kind: 'activity' };
    return null;
  }

  /** @returns {string} */
  getBinary() {
    return 'cursor-agent';
  }

  /** @returns {string} */
  getName() {
    return 'cursor';
  }

  /**
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
   * Driver-owned argv after the binary for the version-bound direct-shell
   * profile (module doc above). Every control is explicit: exact observed
   * model ID (including any effort variant), `--sandbox enabled`
   * for both sandbox contracts plus `--mode ask` for read-only (never
   * `-f/--force`/`--yolo`/`--auto-review`/`--approve-mcps`), the conductor
   * workspace as `--workspace`, `--trust` to remove the one remaining
   * documented prompt, and the `stream-json` event stream. No prompt
   * argument is emitted: the brief arrives on stdin (`stdin:
   * 'brief-text'`), so it never enters argv.
   *
   * @param {{ selected?: { model?: unknown, effort?: { value?: unknown } }, cwd?: unknown, brief?: unknown }} invocation
   * @param {unknown} _profile
   * @param {{ sandbox?: unknown, approval?: unknown }} [permissions]
   * @returns {string[]}
   */
  buildWorkerArgs(invocation, _profile, permissions) {
    const model = invocation?.selected?.model;
    if (typeof model !== 'string' || !model || model.includes('\0') || /[[\]"]/.test(model)) {
      throw new Error('Cursor worker requires an explicit model');
    }
    if (CURSOR_GENERIC_ALIASES.includes(model.toLowerCase())) {
      throw new Error(`Cursor worker requires an exact observed model, not the generic alias '${model}'`);
    }
    if (CURSOR_RESERVED_MODEL_VALUES.includes(model.toLowerCase())) {
      throw new Error(`Cursor worker requires an explicit observed model, not the CLI's own auto-selection '${model}'`);
    }
    const effort = invocation?.selected?.effort?.value ?? null;
    if (typeof effort !== 'string' || !CURSOR_DIRECT_EFFORT_PATTERN.test(effort)) {
      throw new Error('Cursor worker requires an explicit qualified reasoning effort (never a CLI default)');
    }
    const sandbox = permissions?.sandbox ?? 'workspace-write';
    if (!CURSOR_DIRECT_SANDBOX_MODES.includes(sandbox)) {
      throw new Error(`Cursor worker sandbox is not a qualified direct mode: ${String(sandbox)}`);
    }
    const approval = permissions?.approval ?? 'never';
    if (!CURSOR_DIRECT_APPROVAL_POLICIES.includes(approval)) {
      throw new Error(`Cursor worker approval is not a qualified direct policy: ${String(approval)}`);
    }
    const cwd = invocation?.cwd;
    if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.includes('\0')) {
      throw new Error('Cursor worker requires an absolute workspace');
    }
    const brief = invocation?.brief;
    if (typeof brief !== 'string' || !brief || brief.includes('\0')) {
      throw new Error('Cursor worker requires a non-empty brief');
    }
    const args = ['-p', '--output-format', 'stream-json', '--trust', '--sandbox', 'enabled'];
    if (sandbox === 'read-only') args.push('--mode', 'ask');
    args.push('--workspace', cwd, '--model', model);
    return args;
  }

  /**
   * The brief is read from stdin to EOF with no documented stdin abort
   * channel, so cancellation stays with owned process control.
   * @returns {null}
   */
  getAbortInput() {
    return null;
  }

  /**
   * Direct-profile final extraction from the captured `--output-format
   * stream-json` stdout stream (module doc above). JSONL-aware and fails
   * closed on its own: a malformed line, ANY `result` line that is not
   * the documented success shape (`subtype === 'success'`, `is_error ===
   * false`, non-empty `result`), or ANY `type:"error"`/non-null top-level
   * `error`/`interaction_query` event rejects the whole stream, in any
   * position — an earlier affirmative success is never repaired by what
   * follows, and a later one is never retroactively undone by what came
   * before, because once any disqualifying event is seen this returns
   * null immediately regardless of what else is in the stream. A missing
   * terminal is still a null (the caller must separately check the
   * process exit code). Returns the last successful `result`.
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
      if (event.type === 'error' || event.error != null || event.type === 'interaction_query') return null;
      if (event.type !== 'result') continue;
      const hasResultContent = typeof event.result === 'string' && event.result.trim().length > 0;
      if (!(event.subtype === 'success' && event.is_error === false && hasResultContent)) return null;
      final = event;
    }
    return final;
  }

  // No legacy-style buildSessionArgs/buildAnalysisArgs/parseOutput/
  // getEnvOverrides/getTranscriptPath overrides: this adapter did not
  // exist before #2903 (confirmed against origin/main), so there is no
  // prior legacy contract to preserve, and this profile is direct-only.
  // buildSessionArgs()/buildAnalysisArgs() intentionally fall through to
  // ProviderAdapter's base-class defaults, which throw "Not implemented"
  // rather than ever placing brief/prompt content on argv (fix round 1,
  // roctinam/aiwg#2903 item 6); parseOutput()/getEnvOverrides()/
  // getTranscriptPath() fall through to the base class's existing safe
  // defaults for the LEGACY class. #2995 moved parseWorkerFinal onto the
  // `-direct` subclass below: the base class's inherited
  // `parseOutput`/`parseWorkerFinal` legacy regex-and-generic behavior is
  // otherwise unchanged.
}

// Self-register on import for the legacy Ralph loop only. The direct worker
// profile loads through the #2885 installed loader instead (see below).
registerProvider('cursor', () => new CursorAdapter());

/**
 * #2995: `CursorAdapter.parseOutput` (inherited from `ProviderAdapter`, no
 * override above) is the base class's loose first-`{`-to-last-`}` regex: it
 * fails (returns null) on any realistic multi-event `stream-json` run
 * (system/thinking/tool_call lines before the final `result` line), and it
 * is loose in the other direction too (an empty-text success can still
 * parse as a truthy object). The installed-module loader's `extractFinal`
 * hook IS `instance.parseOutput` (src/models/worker-installation.mjs
 * ~l.730) and session-launcher.mjs's gate (~l.462) throws unless that hook
 * returns a non-null, non-`success:false` result — so a real direct-shell
 * run could never reach `parseWorkerFinal` at all with the base regex wired
 * to it.
 *
 * `CursorDirectAdapter` is the Claude/Hermes `-direct`-subclass pattern:
 * only `parseOutput` changes, to the ALREADY-correct `parseDirectFinal`
 * (above — one rule, never a second one), which returns null unless the
 * whole stream is a single cursor-shaped success terminal with non-empty
 * text. `parseWorkerFinal` lives here too (strict, no fallback needed:
 * Cursor has no legacy group-mode generic-envelope test to preserve,
 * confirmed against test/unit/ralph-external/worker-finals.test.ts, which
 * does not include 'cursor').
 */
export class CursorDirectAdapter extends CursorAdapter {
  // #2995 round 4 (item 3): production resolves the installed adapter by
  // `adapter.id` (now `cursor-direct`, item B) and src/models/
  // worker-installation.mjs's `inspectWorkerInstallation` requires
  // `adapter.id === instance.getName()`. `getBinary()` and the
  // `provider: 'cursor'` literals inside `observeHealthEvent` are untouched.
  getName() { return 'cursor-direct'; }

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
    if (!final) throw new Error('Cursor worker stream did not produce a successful final result');
    return super.parseWorkerFinal(final.result, { ...options, format: 'json' });
  }
}

/** Installed-module interface version (mirrors #2897 codex-adapter.mjs). */
export const interfaceVersion = 1;

/** Installed-module registration: exactly the one approved adapter ID. */
export function register(factory) {
  factory('cursor-direct', () => new CursorDirectAdapter());
}

export default CursorAdapter;
