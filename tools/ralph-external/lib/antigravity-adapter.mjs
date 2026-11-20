/**
 * Antigravity CLI (`agy`) direct-worker driver (B-OG-43, roctinam/aiwg#2908).
 *
 * Fix round 1 (conductor-run LIVE argument-parse probes against the real
 * installed `agy` 1.3.3 on host 'noodle' 2026-10-11 — no login exists
 * there, so nothing reached a model; only the CLI's own argv/stream
 * parser ran):
 *
 *   A) `agy --print --output-format bogus-format </dev/null` ->
 *      "Error: --print took \"--output-format\" as its prompt, so the
 *      intended prompt was left as an argument and ignored. Attach the
 *      prompt to the flag (--print='your prompt') and move --output-format
 *      elsewhere on the command line."
 *   B) `agy --output-format bogus-format --print </dev/null` ->
 *      "flag needs an argument: -print"
 *   C) `echo probe | agy --print= --output-format stream-json` ->
 *      "error: Error: empty prompt. Usage: agy --print \"your prompt
 *      here\"" AND a real stdout event:
 *      {"event":"result","result":{"conversation_id":"","status":"ERROR",
 *      "response":"","error":"Error: empty prompt. Usage: agy --print
 *      \"your prompt here\""}}
 *   D) `echo probe | agy --input-format stream-json --output-format
 *      stream-json` -> passes argument parsing, stops at "Error:
 *      authentication required. Run 'agy' to log in, then retry." /
 *      "error: authentication failed or timed out"
 *   E) `echo probe | agy --output-format stream-json` (no --print) -> the
 *      same authentication stop
 *   F) `agy --print=x --input-format bogus --output-format stream-json` ->
 *      "Error: unknown --input-format \"bogus\" (want text or
 *      stream-json)" (flag validation happens before auth)
 *
 * (A)/(B) prove `--print` REQUIRES a value and swallows the following
 * argv token when none is attached; an EMPTY `--print` does not fall back
 * to stdin (C) — it is a hard error. This BLOCKS the round-0 argv, which
 * emitted a bare `--print`. (D)/(E) prove `--input-format stream-json
 * --output-format stream-json` passes argument validation and reaches
 * execution WITHOUT any `--print` flag at all, so this profile now emits
 * NEITHER `--print` nor a prompt value: the brief travels as exactly one
 * NDJSON message on stdin (module doc below), never on argv.
 *
 * (C) is also the first LIVE (not `strings`/help) observation of this
 * version's `result` event shape: `event:"result"`, nested
 * `result.conversation_id`/`result.status`/`result.response`/
 * `result.error`. It is an ERROR-status terminal with NO preceding `init`
 * event (the argument/prompt validation failed before any conversation
 * started), so this profile's strict parser does NOT require `init`
 * before a non-`SUCCESS` terminal — only before an affirmative `SUCCESS`
 * one, where the existing `antigravity-transport.mjs`/`worker-health.mjs`
 * evidence requires the documented `init` -> `step_update` -> `result`
 * sequence. The quoted (C) error text proves the shape but proves NEITHER
 * exit code 0 NOR a `SUCCESS` terminal; it is quoted as grammar evidence
 * only, and this profile's own parser still rejects it (`status !==
 * 'SUCCESS'`).
 *
 * #4348 (agy 1.5.10): the earlier string-valued message is rejected as
 * StreamInputUserMessage, and Gemini models reject --effort. The supplied
 * `agy models` observation lists gemini-4-{neon,argon,hydrogen} effort ids.
 * Resolve the requested effort into those ids; refuse other models until
 * their effort contract is evidenced. Never guess --effort support.
 *
 * The candidate nested message {content: brief} below is isolated in the
 * envelope builder. The installed offline binary is 1.2.12; its help does
 * not establish 1.5.10's message fields. This candidate needs the exact
 * live probe in docs/providers/antigravity-direct.md before qualification.
 * Framing tests establish byte safety, not vendor acceptance.
 *
 * Only read-only sandbox requests are accepted; --sandbox and
 * --disable-slash-commands are always emitted. No --print, permission
 * bypass, remote control, or unverified write-approval flag is emitted.
 *
 * Auth: no environment-variable credential path is evidenced for this
 * CLI. Probes (D)/(E) show a bare, unauthenticated run stops at "Error:
 * authentication required. Run 'agy' to log in, then retry." — this is an
 * interactive Google-account login (`agy` with no args walks through
 * sign-in), not an API-key flag or env var. `GEMINI_API_KEY` in the
 * registry `envAllowlist` (round 0) was a `strings`-sourced GUESS and is
 * NOT confirmed to authenticate this CLI; it is kept in the allowlist
 * (harmless if absent/unused) but the docs now say plainly that the
 * manual smoke run is BLOCKED until an operator completes an interactive
 * `agy` login on the target host, and that no CLI-documented env-key path
 * was found.
 *
 * Installed-module shape unchanged from round 0: static `interfaceVersion`
 * and `register` exports (`installed:antigravity`); direct-only, no
 * legacy Ralph-loop session; `getName()` returns `'antigravity'` so the
 * inherited `ProviderAdapter.observeHealthEvent` keeps using the existing,
 * already-wired `observeProviderHealthEvent('antigravity', ...)` branch in
 * `./worker-health.mjs` (shared, not edited).
 */
import { ProviderAdapter, registerProvider } from './provider-adapter.mjs';

export const interfaceVersion = 1;
export const ANTIGRAVITY_SUPPORTED_VERSIONS = Object.freeze(['>=1.5.10 <1.6.0']);
/** AIWG effort inputs; the 1.5.10 Gemini mapping below refuses max. */
export const ANTIGRAVITY_DIRECT_EFFORT_VALUES = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
/** One adapter-supplied NDJSON user line, then EOF. */
export const ANTIGRAVITY_DIRECT_STDIN = 'adapter-frame';
/** Only the sandboxed, non-write contract is accepted: `--mode accept-edits`
 * is never emitted (module doc above), so a 'workspace-write' request is
 * refused rather than silently downgraded to read-only. */
export const ANTIGRAVITY_DIRECT_SANDBOX_MODES = Object.freeze(['read-only']);
/** Case-insensitive refusal: no documented "let it pick" token exists for
 * this CLI, but these common auto-selection sentinels are refused defensively
 * exactly like other profiles refuse them absent CLI-side confirmation. */
const ANTIGRAVITY_AUTO_MODEL_SPELLINGS = Object.freeze(['auto', 'default']);
/** Generic Ralph-loop role aliases are never a valid direct-profile model. */
const ANTIGRAVITY_GENERIC_ALIASES = Object.freeze(['opus', 'sonnet', 'haiku']);
/** See module doc: the exact stderr text for a soft-denied tool permission
 * request is not evidenced; only the shared stderr classifier can see it and
 * it is not confirmed to match this CLI's wording. The quoted soft-deny
 * changelog text establishes NEITHER exit code 0 NOR a SUCCESS terminal by
 * itself. */
export const ANTIGRAVITY_SOFT_DENY_RISK_NOTE = 'Soft-denied tool permission (exit 0, stderr notice) is not independently '
  + 'detectable from parseWorkerFinal/parseOutput (stderr is not passed to either); relies on the shared #2896 stderr '
  + 'classifier matching unconfirmed wording. Marked unverified, never invented.';

/** Control characters (incl. NUL, CR, LF, TAB) are never valid inside a single argv token. */
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;
/** Whitespace (incl. tab/newline, already in CONTROL_CHAR_PATTERN, plus plain space). */
const WHITESPACE_PATTERN = /\s/;

/** Guards a value this adapter emits as its own argv token (model, effort)
 * against becoming a new option: a real argv parser treats a "-"-prefixed
 * token as the start of a new flag regardless of which preceding flag it
 * followed — exactly the swallow bug live probe (A) proves `--print`
 * itself suffers from on this CLI when its own value is omitted. */
function assertSingleTokenValue(value, label) {
  if (typeof value !== 'string' || !value || CONTROL_CHAR_PATTERN.test(value) || WHITESPACE_PATTERN.test(value)) {
    throw new Error(`Antigravity worker ${label} must be a non-empty single token with no whitespace or control characters`);
  }
  if (value.startsWith('-')) {
    throw new Error(`Antigravity worker ${label} must not look like a CLI option; option-prefixed values are refused: ${value}`);
  }
}

/**
 * Candidate agy 1.5.10 structured message, one NDJSON line then EOF.
 * The nested content field needs live confirmation (see module doc).
 * JSON encoding keeps embedded newlines inside the single user turn.
 * @param {string|Uint8Array} brief
 * @returns {Buffer}
 */
export function buildAntigravityStdinFrame(brief) {
  const text = Buffer.isBuffer(brief) || brief instanceof Uint8Array
    ? new TextDecoder('utf-8', { fatal: true }).decode(brief) : brief;
  if (typeof text !== 'string' || !text || text.includes('\0')) {
    throw new Error('Antigravity worker requires a non-empty brief to frame as an NDJSON user message');
  }
  return Buffer.from(`${JSON.stringify({ event: 'user', message: { content: text } })}\n`);
}

export class AntigravityAdapter extends ProviderAdapter {
  /** @returns {string} */
  getBinary() { return 'agy'; }

  /** @returns {string} */
  getName() { return 'antigravity'; }

  /** @returns {import('./provider-adapter.mjs').ProviderCapabilities} */
  getCapabilities() {
    return {
      streamJson: true, sessionResume: false, budgetControl: false, systemPrompt: false,
      agentMode: false, mcpConfig: false, maxTurns: false,
    };
  }

  /**
   * Driver-owned argv after the binary for the version-bound direct-shell
   * profile (module doc above, fix round 1). NO `--print` flag is ever
   * emitted (live probes A/B/C prove it is unsafe: it requires a value,
   * swallows the next argv token when omitted, and still hard-errors on an
   * explicit empty value). The brief travels as the one stdin NDJSON frame
   * (`buildAntigravityStdinFrame`). Every other control is explicit: exact
   * model with reasoning-effort suffix, the one accepted (`read-only`)
   * sandbox contract, and slash-command/skill expansion disabled.
   *
   * @param {{ selected?: { model?: unknown, effort?: { value?: unknown } }, cwd?: unknown, brief?: unknown }} invocation
   * @param {unknown} _profile
   * @param {{ sandbox?: unknown }} [permissions]
   * @returns {string[]}
   */
  buildWorkerArgs(invocation, _profile, permissions = {}) {
    const model = invocation?.selected?.model;
    if (typeof model !== 'string' || !model || model.includes('\0')) {
      throw new Error('Antigravity worker requires an explicit model');
    }
    assertSingleTokenValue(model, 'model');
    if (ANTIGRAVITY_AUTO_MODEL_SPELLINGS.includes(model.toLowerCase())) {
      throw new Error(`Antigravity worker requires an explicit model, never '${model.toLowerCase()}'`);
    }
    if (ANTIGRAVITY_GENERIC_ALIASES.includes(model.toLowerCase())) {
      throw new Error(`Antigravity worker requires an exact observed model, not the generic alias '${model}'`);
    }
    const effort = invocation?.selected?.effort?.value ?? null;
    if (effort === null || !ANTIGRAVITY_DIRECT_EFFORT_VALUES.includes(effort)) {
      throw new Error('Antigravity worker requires an explicit qualified reasoning effort (never a CLI default)');
    }
    assertSingleTokenValue(effort, 'reasoning effort');
    // 1.5.10 lists effort-suffixed Gemini ids; --effort is rejected.
    const family = /^(gemini-4-(?:neon|argon|hydrogen))(?:-(?:low|medium|high|xhigh))?$/.exec(model);
    if (!family || effort === 'max') {
      throw new Error(`Antigravity worker model/effort mapping is not evidenced: ${model} / ${effort}`);
    }
    const selectedModel = `${family[1]}-${effort}`;
    const sandbox = permissions?.sandbox ?? 'read-only';
    if (!ANTIGRAVITY_DIRECT_SANDBOX_MODES.includes(sandbox)) {
      throw new Error(`Antigravity worker sandbox is not a qualified direct mode (write is unavailable: no verified `
        + `non-blanket write-approval flag is evidenced): ${String(sandbox)}`);
    }
    if (typeof invocation?.cwd !== 'string' || !invocation.cwd.startsWith('/') || invocation.cwd.includes('\0')) {
      throw new Error('Antigravity worker requires an absolute workspace');
    }
    const brief = invocation?.brief;
    // Resolution supplies brief text; installed rechecks carry only its path.
    // Neither form contributes prompt bytes to argv.
    if (brief !== undefined ? typeof brief !== 'string' || !brief || brief.includes('\0')
      : typeof invocation?.briefPath !== 'string' || !invocation.briefPath.startsWith('/') || invocation.briefPath.includes('\0')) {
      throw new Error('Antigravity worker requires a non-empty brief or an absolute brief path');
    }

    return [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--model', selectedModel,
      '--sandbox',
      '--disable-slash-commands',
    ];
  }

  buildWorkerStdinFrame(brief) { return buildAntigravityStdinFrame(brief); }

  /** No documented stdin abort channel; cancellation stays with owned process control. */
  getAbortInput() { return null; }

  /**
   * Candidate (unverified) synchronous extraction for the installed driver's
   * `extractFinal` hook. Delegates to the strict `parseDirectFinal` so a
   * non-affirmative or malformed stream can never be mistaken for success.
   * @param {string} stdout
   * @returns {{ status: 'SUCCESS', response: string }|null}
   */
  parseOutput(stdout) {
    return this.parseDirectFinal(stdout);
  }

  /**
   * Strict final extraction from the captured `--output-format stream-json`
   * stdout stream (module doc above). Fails closed on its own: a malformed
   * line, an unknown event name, an invalid `step_update.state`, any event
   * observed after the terminal `result` line, a second `result` line, a
   * non-`SUCCESS` status, or an empty `response` rejects the whole stream.
   * `init` is required before an affirmative `SUCCESS` terminal (the
   * documented `init -> step_update -> result` success sequence, carried
   * forward from the existing `antigravity-transport.mjs`/
   * `worker-health.mjs` evidence) but is NOT required before a non-`SUCCESS`
   * terminal — live probe (C) proves an early `ERROR`-status `result` can
   * arrive with no preceding `init` at all. `result` is still structurally
   * the sole terminal: any line after the first `result` line — including a
   * second, differently-shaped `result` — is itself a contract violation
   * and fails the parse; a later success never repairs an earlier failure
   * and trailing content is never tolerated after a clean one.
   * @param {string} stdout
   * @returns {{ status: 'SUCCESS', response: string }|null}
   */
  parseDirectFinal(stdout) {
    if (typeof stdout !== 'string' || !stdout.trim()) return null;
    let terminal = null;
    let sawInit = false;
    let seen = 0;
    for (const raw of stdout.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (terminal) return null; // anything after the terminal result (incl. a 2nd result) is a contract violation
      let event;
      try { event = JSON.parse(line); } catch { return null; }
      if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.event !== 'string') return null;
      if (!['init', 'step_update', 'result'].includes(event.event)) return null;
      if (event.event === 'init') {
        if (seen > 0) return null; // init must be the FIRST event, exactly once (no late or duplicate init)
        sawInit = true;
      }
      seen += 1;
      if (event.event === 'step_update') {
        if (!sawInit) return null; // a step before init is outside the documented sequence
        if (!event.step_update || typeof event.step_update !== 'object' || Array.isArray(event.step_update)) return null;
        if (!['ACTIVE', 'DONE'].includes(event.step_update.state)) return null;
      }
      if (event.event === 'result') {
        if (!event.result || typeof event.result !== 'object' || Array.isArray(event.result)) return null;
        if (event.result.status !== 'SUCCESS') return null; // non-SUCCESS (e.g. live-observed "ERROR") always fails closed
        if (!sawInit) return null; // SUCCESS without the documented init->step_update->result sequence fails closed
        if (typeof event.result.response !== 'string' || !event.result.response.trim()) return null;
        terminal = event;
      }
    }
    if (!terminal) return null;
    return { status: 'SUCCESS', response: terminal.result.response };
  }

  /**
   * Final-extraction hook used by the installed-module driver
   * (`extractFinal`/`parseWorkerFinal` in session-launcher.mjs ~480). The
   * base `ProviderAdapter.parseWorkerFinal` accepts any claims-shaped `{...}`
   * directly; this profile instead first unwraps the vendor stream-json
   * envelope with the strict rule above, extracts the model's own final
   * answer text, and only then forwards that text to the shared strict
   * claims parser — mirroring claude-adapter.mjs / hermes-adapter.mjs.
   * @param {string|Uint8Array} output
   * @param {{ format?: string }} [options]
   * @returns {Promise<import('../../../src/mission-protocol/types.js').WorkerClaims>}
   */
  async parseWorkerFinal(output, options = {}) {
    if (options.format === 'mcp') return super.parseWorkerFinal(output, options);
    const terminal = this.parseDirectFinal(String(output));
    if (!terminal) throw new Error('Antigravity worker did not produce a validated terminal result');
    return super.parseWorkerFinal(terminal.response, { ...options, format: 'json' });
  }

  // No legacy-style buildSessionArgs/buildAnalysisArgs/observeHealthEvent
  // overrides: this adapter did not exist before #2908 (confirmed against
  // origin/main), so there is no prior legacy contract to preserve, and
  // this profile is direct-only. buildSessionArgs()/buildAnalysisArgs()
  // intentionally fall through to ProviderAdapter's base-class defaults,
  // which throw "Not implemented" rather than ever placing brief/prompt
  // content on argv. observeHealthEvent() intentionally falls through to
  // ProviderAdapter's base-class default, which delegates to the existing,
  // already-wired observeProviderHealthEvent('antigravity', ...) branch in
  // ./worker-health.mjs (a shared module this profile does not edit).
}

// Self-register on import for the legacy Ralph loop only. The direct worker
// profile loads through the #2885 installed loader instead (see below).
registerProvider('antigravity', () => new AntigravityAdapter());

/** Installed-module registration: exactly the one approved adapter ID. */
export function register(factory) {
  factory('antigravity', () => new AntigravityAdapter());
}

export default AntigravityAdapter;
