/**
 * Grok Build CLI direct-worker driver (B-OG-41, roctinam/aiwg#2906).
 *
 * Version-bound to the real installed `grok` 1.0.50 (c58f321264ba, stable)
 * root `--help` (help/version syntax only; captured on host 'noodle'
 * 2026-10-10, see .aiwg/working/s1-scratch/cli-help/grok-1.0.50.txt; never a
 * live prompted run) plus the CLI's own bundled docs/strings (read via
 * `strings` on the installed binary, never executed with a prompt):
 *
 *   grok --prompt-file ${briefPath} -m ${model} --reasoning-effort ${effort} \
 *     --permission-mode dontAsk --sandbox ${sandbox} --cwd ${workspace} \
 *     --output-format streaming-json --no-subagents --disallowed-tools workflow --no-plan \
 *     --no-alt-screen --disable-web-search \
 *     [--allow <rule> ...] [--deny <rule> ...]
 *
 * Brief transport: `--prompt-file <PATH>` is "Single-turn prompt from a
 * file" (root `--help`); it starts a single-turn headless run on its own,
 * so the brief never enters argv or stdin (`stdin: 'closed'`). `-p/--single
 * <PROMPT>` (argv text) and `--prompt-json <JSON>` are refused: a brand-new
 * adapter must never add an argv-prompt path.
 *
 * Model/effort: `-m, --model <MODEL>` is always an exact observed model
 * (root `--help` documents no enum; 'auto'/'default' and the generic
 * Ralph-loop aliases opus/sonnet/haiku are refused). `--reasoning-effort
 * <EFFORT>` (alias `--effort`, never emitted under that alias) is always
 * explicit; the installed binary's own error text names the full value set
 * ("invalid reasoning effort: ... (expected one of: none, minimal, low,
 * medium, high, xhigh, max)").
 *
 * Permission mode: root `--help` lists `--permission-mode <MODE>`
 * `[possible values: default, acceptEdits, auto, dontAsk, bypassPermissions,
 * plan]`. The bundled permission-modes doc (read via `strings`, not
 * invented) is explicit about each: `default` prompts interactively and
 * would hang headless; `acceptEdits` only covers file edits, other tool
 * calls may still prompt; `plan` is a planning mode (unverified); `bypassPermissions`
 * ("always-approve") is the blanket-bypass mode this profile must never
 * select (equivalent to `--always-approve`, itself also never emitted).
 * `dontAsk` ("Only pre-approved tools and built-in read-only handling" /
 * "Strict CI allowlists" / "`dontAsk` mode denies whatever it would have to
 * prompt for") is the one non-prompting, non-bypass value, so it is the
 * only permission mode this profile emits. Because `dontAsk` denies
 * anything not pre-approved, a write-capable run needs explicit
 * `--allow`/`--deny` rules (compat aliases `--allowedTools`/
 * `--disallowedTools` are never emitted) from the resolved permission
 * tuple; `assertPlainToolPattern` below refuses a leading `-`, control
 * characters and the CLI's own blanket bypass spellings so a rule value can
 * never become a new option or an unscoped allow-all.
 *
 * Sandbox: root `--help` lists `--sandbox <PROFILE>` (env `GROK_SANDBOX`);
 * the bundled sandbox doc (`strings`-read) names the built-in profiles as
 * "off, workspace, devbox, read-only, strict; or a custom profile name" and
 * states the default with no flag is `off` (no sandbox) via the documented
 * resolution order (`--sandbox`/`GROK_SANDBOX` > config `[sandbox] profile`
 * > `off`), so this profile always emits `--sandbox` explicitly for every
 * mode, including read-only. `read-only` maps to the CLI's own `read-only`
 * profile ("read everything but can only write to `~/.grok/` ... and temp
 * directories"); `workspace-write` maps to the CLI's `workspace` profile
 * ("recommended profile for everyday development ... can only write to the
 * current working directory, `~/.grok/`, and temp directories"). `devbox`
 * (near-unrestricted write) and `off` (no sandbox) are never emitted.
 *
 * Untrusted-surface denial: `--disable-web-search` ("Disable web search and
 * web fetch tools") removes the one evidenced built-in external-network
 * tool so the AIWG `worker-invoke` bridge remains the one MCP/tool route
 * this profile authorizes; `--no-subagents --disallowed-tools workflow`
 * closes the captured 1.0.77 workflow bypass of --no-subagents (ADR-OG-09).
 * Combined live enforcement remains unverified; `--no-plan` keeps the run in direct
 * execution rather than plan-only mode. `--no-alt-screen` is also emitted
 * per the conductor's headless invariant list even though single-turn
 * `--prompt-file` runs never open the TUI.
 *
 * No `--no-ask-user`-equivalent flag is listed in the captured ROOT
 * `--help` (an internal `no-ask-user`/`NO_ASK_USER` arg name exists in the
 * compiled binary's own strings, but is not in the printed help text for
 * this version, so it is never emitted here per the help-listed-spellings
 * rule). Whether an `ask_user_question` tool call blocks indefinitely under
 * `dontAsk` in a truly non-interactive run is therefore NOT evidenced and
 * stays an open risk, not invented away.
 *
 * `--no-auto-update` (used by the separate, legacy
 * `src/providers/grok-build-headless.ts` transport) is likewise absent from
 * this version's root `--help` and is never emitted by this profile.
 *
 * Output: `--output-format streaming-json` is "NDJSON: one ACP session
 * update per line, the agent's native format" (root `--help`). The CLI's
 * own bundled output-format doc (`strings`-read, not invented) gives the
 * exact event vocabulary: `text`, `thought`, `tool_call` (`toolCallId`,
 * `toolName`, `kind`, `status`, `rawInput`, `content`, `locations`),
 * `tool_call_update` (`status`, `rawOutput`, `content`, `locations`),
 * `usage` (`messageId`, `stopReason`, `usage`, `signature`), `plan`
 * (`entries`), `available_commands` (`tools`, `commands`), `end` (always
 * the last event; carries `stopReason`: `end_turn`, `max_tokens`,
 * `max_turn_requests`, `refusal`, `cancelled`) and `error` (`message`).
 * "On failure, Grok emits an error object (process exit non-zero)."
 * `observeHealthEvent` and `parseDirectFinal` below both treat only
 * `stopReason === 'end_turn'` as success; any `error` event, or any
 * `tool_call`/`tool_call_update` with `status === 'failed'`, fails the run
 * even if it exits zero or is followed by a clean `end` (a later success
 * never repairs an earlier failure).
 *
 * Installed-module shape: static `interfaceVersion` and `register` exports
 * so the #2885 loader can approve this file by digest under
 * `installed:grok-build` (mirroring #2911 openhuman-adapter.mjs /
 * #2901 copilot-adapter.mjs). Grok has no existing qualified Ralph-loop
 * session in this registry, so this is a standalone class (not a
 * `ProviderAdapter` subclass, not registered in the legacy Ralph-loop
 * registry) exactly like Copilot: only the direct worker profile surface is
 * shipped, with no new argv-prompt (`buildSessionArgs`/`buildAnalysisArgs`)
 * path.
 */

import { classifyWorkerHealthFailure, healthEventMatchesBinding } from './worker-health.mjs';
import { ProviderAdapter } from './provider-adapter.mjs';

export const interfaceVersion = 1;

export const GROK_BUILD_SUPPORTED_VERSIONS = Object.freeze(['1.0.50']);
export const GROK_BUILD_DIRECT_EFFORT_VALUES = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
/** Brief transport: a prompt file, never argv text and never stdin. */
export const GROK_BUILD_DIRECT_STDIN = 'closed';
/** The CLI's own non-prompting, non-bypass permission mode ("Strict CI allowlists"). */
export const GROK_BUILD_PERMISSION_MODE = 'dontAsk';
/** Semantic sandbox modes this profile accepts; mapped to the CLI's own profile names below. */
export const GROK_BUILD_DIRECT_SANDBOX_MODES = Object.freeze(['read-only', 'workspace-write']);
const GROK_BUILD_SANDBOX_TO_NATIVE = Object.freeze({ 'read-only': 'read-only', 'workspace-write': 'workspace' });
/** Case-insensitive refusal: the CLI's own "let it pick" words, never selected here. */
const GROK_BUILD_AUTO_MODEL_SPELLINGS = Object.freeze(['auto', 'default']);
/** Generic Ralph-loop aliases are never a valid direct-profile model (no mapping is evidenced). */
const GROK_BUILD_GENERIC_ALIASES = Object.freeze(['opus', 'sonnet', 'haiku']);
/** Blanket bypass flags/words this profile must never emit via a permission-rule pattern. */
const GROK_BUILD_BANNED_RULE_PATTERNS = Object.freeze(['--always-approve', 'bypassPermissions', '--allow-all', '--yolo', '*']);

/** Control characters (incl. NUL, CR, LF, TAB) are never valid inside a single rule token. */
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

/** Whitespace (incl. tab/newline, already in CONTROL_CHAR_PATTERN, plus plain space) inside a single argv token value. */
const WHITESPACE_PATTERN = /\s/;

/**
 * Guards every value this adapter emits as its OWN argv token (model,
 * effort) against becoming a new option: a real argv parser treats a
 * "-"-prefixed token as the start of a new flag regardless of which
 * preceding flag it followed, so a value like `--always-approve` or
 * `--permission-mode=bypassPermissions` passed as `model` would otherwise
 * ride straight through as a second, attacker-controlled flag.
 */
function assertSingleTokenValue(value, label) {
  if (typeof value !== 'string' || !value || CONTROL_CHAR_PATTERN.test(value) || WHITESPACE_PATTERN.test(value)) {
    throw new Error(`Grok Build worker ${label} must be a non-empty single token with no whitespace or control characters`);
  }
  if (value.startsWith('-')) {
    throw new Error(`Grok Build worker ${label} must not look like a CLI option; option-prefixed values are refused: ${value}`);
  }
}

function assertPlainToolPattern(value, label) {
  if (typeof value !== 'string' || !value.trim() || CONTROL_CHAR_PATTERN.test(value)) {
    throw new Error(`Grok Build worker ${label} rule must be a non-empty single-line string with no control characters`);
  }
  if (GROK_BUILD_BANNED_RULE_PATTERNS.includes(value)) {
    throw new Error(`Grok Build worker ${label} rule must be scoped, never a blanket bypass: ${value}`);
  }
  // A real variadic/positional parser treats any "-"-prefixed token as the
  // START of a new option, not a value for --allow/--deny. Refuse these
  // here so a caller can never smuggle an option token through the rule
  // slot (e.g. --always-approve, --permission-mode, --sandbox).
  if (value.startsWith('-')) {
    throw new Error(`Grok Build worker ${label} rule must not look like a CLI option; option-prefixed tokens are refused: ${value}`);
  }
}

export class GrokBuildAdapter extends ProviderAdapter {
  getBinary() { return 'grok'; }
  getName() { return 'grok-build'; }
  getCapabilities() {
    return {
      streamJson: true, sessionResume: false, budgetControl: false, systemPrompt: false,
      agentMode: true, mcpConfig: false, maxTurns: false,
    };
  }
  /** No legacy Ralph-loop session exists for Grok Build in this registry; ship only the direct profile surface. */
  buildSessionArgs() { throw new Error('Grok Build has no qualified Ralph loop session; use the direct worker profile'); }
  buildAnalysisArgs() { return this.buildSessionArgs(); }

  /**
   * Driver-owned argv after the binary for the version-bound direct-shell
   * profile. Every control is explicit: exact model (never 'auto'/
   * 'default' or a generic alias), explicit reasoning effort, the fixed
   * non-prompting `dontAsk` permission mode, an explicit sandbox profile
   * for every mode, the workspace via `--cwd`, the brief as a prompt file
   * (never argv/stdin content), the ACP-derived streaming-json event
   * stream, the untrusted-surface/no-fan-out denials, and only scoped
   * `--allow`/`--deny` rule tokens — never `--always-approve` or
   * `--permission-mode bypassPermissions`.
   *
   * @param {{ selected?: { model?: unknown, effort?: { value?: unknown } }, cwd?: unknown, briefPath?: unknown }} invocation
   * @param {unknown} _profile
   * @param {{ sandbox?: unknown, allowRules?: unknown, denyRules?: unknown }} [permissions]
   * @returns {string[]}
   */
  buildWorkerArgs(invocation, _profile, permissions) {
    const model = invocation?.selected?.model;
    if (typeof model !== 'string' || !model || model.includes('\0')) {
      throw new Error('Grok Build worker requires an explicit model');
    }
    assertSingleTokenValue(model, 'model');
    if (GROK_BUILD_AUTO_MODEL_SPELLINGS.includes(model.toLowerCase())) {
      throw new Error(`Grok Build worker requires an explicit model, never '${model.toLowerCase()}'`);
    }
    if (GROK_BUILD_GENERIC_ALIASES.includes(model.toLowerCase())) {
      throw new Error(`Grok Build worker requires an exact observed model, not the generic alias '${model}'`);
    }
    const effort = invocation?.selected?.effort?.value ?? null;
    if (effort === null || !GROK_BUILD_DIRECT_EFFORT_VALUES.includes(effort)) {
      throw new Error('Grok Build worker requires an explicit qualified reasoning effort (never a CLI default)');
    }
    assertSingleTokenValue(effort, 'reasoning effort');
    const cwd = invocation?.cwd;
    if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.includes('\0')) {
      throw new Error('Grok Build worker requires an absolute workspace');
    }
    const briefPath = invocation?.briefPath;
    if (typeof briefPath !== 'string' || !briefPath.startsWith('/') || briefPath.includes('\0')) {
      throw new Error('Grok Build worker requires an absolute prompt-file path');
    }
    const sandbox = permissions?.sandbox;
    if (!GROK_BUILD_DIRECT_SANDBOX_MODES.includes(sandbox)) {
      throw new Error(`Grok Build worker sandbox is not a qualified direct mode: ${String(sandbox)}`);
    }
    const allowRules = permissions?.allowRules ?? [];
    if (!Array.isArray(allowRules)) throw new Error('Grok Build worker allowRules must be an array when present');
    for (const pattern of allowRules) assertPlainToolPattern(pattern, '--allow');
    const denyRules = permissions?.denyRules ?? [];
    if (!Array.isArray(denyRules)) throw new Error('Grok Build worker denyRules must be an array when present');
    for (const pattern of denyRules) assertPlainToolPattern(pattern, '--deny');
    const args = [
      '--prompt-file', briefPath,
      '-m', model,
      '--reasoning-effort', effort,
      '--permission-mode', GROK_BUILD_PERMISSION_MODE,
      '--sandbox', GROK_BUILD_SANDBOX_TO_NATIVE[sandbox],
      '--cwd', cwd,
      '--output-format', 'streaming-json',
      '--no-subagents',
      '--disallowed-tools', 'workflow',
      '--no-plan',
      '--no-alt-screen',
      '--disable-web-search',
      '--allow', 'Bash(aiwg discover *)',
    ];
    for (const pattern of allowRules) args.push('--allow', pattern);
    for (const pattern of denyRules) args.push('--deny', pattern);
    return args;
  }

  /** No evidenced stdin abort channel; stdin is not used by this profile at all (the brief rides on `--prompt-file`). */
  getAbortInput() { return null; }

  /**
   * ACP-derived `streaming-json` grammar (module doc above; grade H,
   * sourced from the captured `--help` plus the installed binary's own
   * bundled output-format documentation, never live-observed).
   * `end`/`error` are the only terminal-proof events; a standalone `error`
   * anywhere, or a `tool_call`/`tool_call_update` with `status: 'failed'`,
   * is fatal exactly like a non-`end_turn` `end`, so a later clean `end`
   * can never paper over it. `text`/`thought`/`usage`/`plan`/
   * `available_commands` are activity-only; `tool_call`/`tool_call_update`
   * correlate progress by `toolCallId` when present.
   * @returns {import('./worker-health.mjs').HealthObservation | null}
   */
  observeHealthEvent(event, source, binding) {
    if (source?.kind !== 'stdout' || !event || typeof event !== 'object' || typeof event.type !== 'string') return null;
    const correlated = { sessionId: event.sessionId, requestId: event.requestId };
    if (!healthEventMatchesBinding(correlated, binding)) return null;
    if (event.type === 'error') {
      return { ...classifyWorkerHealthFailure({ type: 'error', message: event.message }, { source, provider: 'grok-build' }), fatal: true };
    }
    if (event.type === 'tool_call' || event.type === 'tool_call_update') {
      if (event.status === 'failed') {
        return { ...classifyWorkerHealthFailure({ type: 'error', message: `tool call ${event.toolCallId ?? 'unknown'} failed` },
          { source, provider: 'grok-build' }), fatal: true };
      }
      const id = event.toolCallId;
      return typeof id === 'string' && id ? { kind: 'progress', key: id } : { kind: 'activity' };
    }
    if (event.type === 'text' || event.type === 'thought' || event.type === 'usage'
      || event.type === 'plan' || event.type === 'available_commands') {
      return { kind: 'activity' };
    }
    if (event.type === 'end') {
      return { kind: 'terminal', success: event.stopReason === 'end_turn', key: event.stopReason ?? 'end' };
    }
    return null;
  }

  /**
   * Final-extraction hook used by the installed-module driver
   * (`extractFinal` in src/models/worker-installation.mjs). The base class
   * accepts any `{...}` it can find; this profile instead applies the strict
   * direct rule, so malformed, trailing or unsuccessful output can never be
   * extracted as a final. This is the gate that keeps a run from reporting
   * completed when output continues past a claimed terminal success.
   * @param {string} stdout
   * @returns {Object|null}
   */
  parseOutput(stdout) {
    return this.parseDirectFinal(stdout);
  }

  /**
   * Strict final extraction from the captured `--output-format
   * streaming-json` stdout stream (module doc above). Fails closed on its
   * own, without relying on the health observer: a malformed line (or any
   * trailing non-empty content, JSON or not), any `error` event, or any
   * `tool_call`/`tool_call_update` with `status: 'failed'` rejects the
   * whole stream. `end` is documented as always the last event, so this is
   * enforced structurally: ANY event observed after the first `end`
   * (including a second, differently-shaped `end`) is itself a contract
   * violation and fails the parse. A non-`end_turn` `end.stopReason`
   * (`max_tokens`, `max_turn_requests`, `refusal`, `cancelled`) latches
   * failure permanently — once set, nothing later can flip it back to
   * success, so `text -> end(refusal) -> end(end_turn)` and
   * `text -> end(end_turn) -> text` both fail closed.
   *
   * #2995 round 4 (item 2): concatenating every `text` event's `data` is
   * correct ONLY within one model response -- docs/providers/
   * grok-build-cli-evidence.md ~l.183 documents `usage` as "Per-response
   * boundary ..., one per model response", i.e. the evidenced response
   * boundary marker, and separately documents `tool_call`/
   * `tool_call_update` as distinct event types from `text` (the field
   * table). A multi-response turn therefore looks like
   * `text* -> usage -> tool_call -> tool_call_update -> text* -> usage ->
   * end`: `usage` CLOSES the response that just produced the accumulated
   * text (the text is kept as that response's candidate, not discarded —
   * the evidenced single-response fixture ends `... text -> usage ->
   * end` and must still resolve with that text), but marks the
   * accumulator closed; a `tool_call`/`tool_call_update`, OR the next
   * `text` event arriving after a close, both mean a NEW response is
   * starting and discard whatever was accumulated before it, so text
   * from an earlier response (or text emitted before a tool call) is
   * never part of the final answer. Text chunks WITHIN one still-open
   * response still concatenate (no evidence of a sub-response text
   * boundary), so `tool_call -> text(chunk1) -> text(chunk2) -> end`
   * still resolves with chunk1+chunk2.
   * @param {string} stdout
   * @returns {{ text: string, stopReason: string, sessionId: string | null } | null}
   */
  parseDirectFinal(stdout) {
    if (typeof stdout !== 'string' || !stdout.trim()) return null;
    let text = '';
    let responseClosed = false;
    let endEvent = null;
    let failed = false;
    for (const raw of stdout.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { return null; }
      if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') return null;
      // `end` is documented as always the last event: anything observed
      // after one already seen — even another `end` — breaks that
      // contract and permanently fails the parse.
      if (endEvent) failed = true;
      if (event.type === 'error') failed = true;
      if ((event.type === 'tool_call' || event.type === 'tool_call_update') && event.status === 'failed') failed = true;
      // Response-boundary resets (module doc above): a tool call
      // intervening discards any text accumulated before it (a new
      // response is starting); `usage` only closes the current response
      // without discarding its text.
      if (event.type === 'tool_call' || event.type === 'tool_call_update') { text = ''; responseClosed = false; }
      if (event.type === 'usage') responseClosed = true;
      if (event.type === 'text' && typeof event.data === 'string') {
        // A text event arriving after a response already closed starts a
        // NEW response: the previous response's text is never part of
        // a later response's final answer.
        if (responseClosed) { text = ''; responseClosed = false; }
        text += event.data;
      }
      if (event.type === 'end') {
        endEvent = event;
        // Latched: a bad stopReason here can never be repaired by
        // anything that follows (and nothing legitimately follows anyway
        // per the rule above).
        if (event.stopReason !== 'end_turn') failed = true;
      }
    }
    if (failed || !endEvent) return null;
    if (!text.trim()) return null;
    return { text, stopReason: endEvent.stopReason, sessionId: typeof endEvent.sessionId === 'string' ? endEvent.sessionId : null };
  }

  /**
   * #2995: production marks a run `completed` only when `parseWorkerFinal`
   * succeeds (src/models/worker-installation.mjs ~l.733,
   * tools/ralph-external/session-launcher.mjs ~l.477). Grok Build's final
   * answer lives inside its own ACP-derived `streaming-json` stdout, so the
   * base `ProviderAdapter.parseWorkerFinal` (which expects a bare claims
   * document) can never validate it on its own. This override keeps the
   * shared path for MCP envelopes and otherwise re-validates the stream
   * with this profile's OWN strict rule (`parseDirectFinal`, above — never
   * a second, looser rule), extracts the settled answer text, and hands
   * that text to the shared strict `workerClaims` parser. There is no
   * legacy Ralph-loop registration for this standalone adapter to
   * preserve (no `registerProvider('grok-build', ...)` below), so no
   * generic-envelope fallback is needed: a stream that fails the strict
   * rule, or a final that is not a valid claims document, stays invalid.
   * @param {string|Uint8Array} output
   * @param {Object} [options]
   * @returns {Promise<import('../../../src/mission-protocol/types.js').WorkerClaims>}
   */
  async parseWorkerFinal(output, options = {}) {
    if (options.format === 'mcp') return super.parseWorkerFinal(output, options);
    const text = typeof output === 'string' ? output : Buffer.from(output).toString('utf8');
    const final = this.parseDirectFinal(text);
    if (!final) throw new Error('Grok Build worker stream did not produce a successful final result');
    return super.parseWorkerFinal(final.text, { ...options, format: 'json' });
  }
}

/** Installed-module registration: exactly the one approved adapter ID. */
export function register(factory) {
  factory('grok-build', () => new GrokBuildAdapter());
}

export default GrokBuildAdapter;
