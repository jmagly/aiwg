/**
 * OpenCode CLI Provider Adapter for External Ralph Loop
 *
 * Provides support for OpenCode as a provider for
 * autonomous task execution in Ralph loops.
 *
 * OpenCode CLI differences from Claude:
 * - Binary: `opencode` instead of `claude`
 * - Headless mode: `opencode run` subcommand
 * - Format flag: `--format json` instead of `--output-format stream-json`
 * - No --dangerously-skip-permissions (no permission bypass needed)
 * - No --print flag (run subcommand is already non-interactive)
 * - No --append-system-prompt (inject into main prompt)
 * - No --max-budget-usd flag
 * - No --max-turns flag
 * - No --mcp-config flag
 * - Session resume via -s/--session instead of --session-id
 * - Model format: provider/model (e.g., opencode/big-pickle, anthropic/claude-sonnet-5)
 * - Agent flag: --agent
 * - JSON output: newline-delimited events, text in type="text" events
 *
 * Model tiers:
 * - Free tier (default): opencode/* models (opencode/big-pickle, etc.)
 * - Anthropic account: anthropic/claude-* models available after `opencode auth add`
 *
 * @implements Plan: Multi-Provider Support for External Ralph Loop
 */

/**
 * Version-bound direct-worker surface (roctinam/aiwg#2904, B-OG-39).
 * npm 1.x uses separate --variant (1.19.0 help, titan, 2026-11-15);
 * installer 2.x uses #variant. Other flags and qualification stay unchanged.
 *
 * Qualified against OpenCode CLI 2.0.26 `opencode --help` / `opencode run
 * --help` (help/version syntax captured on host 'noodle' 2026-10-10; see
 * .aiwg/working/s1-scratch/cli-help/opencode-2.0.26.txt) plus one live
 * smoke run and binary disassembly (.aiwg/working/s1-scratch/
 * smoke-opencode.jsonl, 2026-10-10) that redefine final-output validity
 * below; that live evidence is scoped to `parseOutput`'s rule and never
 * promotes the registry's `qualification.status` beyond `unqualified`:
 *
 *   opencode run --format json -m M[#E] -f F "Follow the instructions in
 *     the attached file exactly."
 *
 * Stdin is confirmed unsupported, not merely undocumented: the conductor
 * disassembled the installed v2.0.26 binary on host 'noodle' and the
 * compiled chunk implementing `run` has no stdin/isTTY handling at all.
 * `run [flags] [<message...>]` takes the message as a trailing positional
 * argument, but `--file`/`-f` ("File to attach to the message") lets the
 * brief ride as an attached file instead: this adapter writes the brief to
 * `briefPath` and passes it via `-f`, so brief bytes never enter argv. The
 * trailing positional is a fixed, content-free instruction
 * (`OPENCODE_FIXED_MESSAGE`) that never carries brief text; `buildWorkerArgs`
 * refuses anything else in that position. `-m/--model` takes
 * `provider/model#variant`; binary disassembly resolves what `#variant`
 * means: the installed CLI builds each model's variant list with a
 * function (minified as `qU(model, manual)`) that maps
 * `model.capabilities.supports.reasoning_effort` (a model-declared string
 * list, e.g. low/medium/high) directly onto variant ids via
 * `{ id: value, settings: { reasoningEffort: value, ... } }`, or — for
 * extended-thinking models exposing `max_thinking_budget` instead — onto
 * two fixed ids, `"max"` and `"high"`. So `#variant` IS a reasoning-effort
 * selector, but the valid id set is per-model (drawn from that model's own
 * catalog capability), not a fixed global enum; `buildWorkerArgs` appends
 * an explicit effort as `#<effort>`. Whether the real CLI refuses an id a
 * model does not expose, or silently falls back to default reasoning, is
 * unverified, so the effort control stays unqualified. There is no `--dir`/`--cwd`
 * flag on `run`: the shared renderer's `cd ${workspace}` sets the process
 * working directory instead. The only permission-adjacent flag is `--auto`
 * ("Auto-approve permissions that are not explicitly denied"), a blanket
 * bypass this profile never emits. What happens to a permission request
 * when `--auto` is absent in non-interactive `run` is not fully resolved:
 * disassembly shows a shared `permission.asked` -> `permission.replied`
 * protocol where an unanswered/unselected request resolves to a `"reject"`
 * outcome (`_==="once"||_==="always"?_:"reject"`, with
 * `requestPermission(...).catch(()=>{return})` on no responder) — this is
 * evidence of reject-on-no-answer rather than an indefinite hang, but it is
 * traced through the ACP/session-protocol layer, not independently
 * reproduced against the plain `run` subcommand, so approval stays
 * `unqualified`/unavailable rather than asserted. `opencode serve` is an
 * HTTP API (not MCP) and `opencode mcp` manages MCP *clients* the agent can
 * call out to, not a worker-serving endpoint, so the AIWG `worker-invoke`
 * bridge remains the MCP route (native `mcp-server`-style hosting is not
 * advertised).
 *
 * Installed-module shape: static `interfaceVersion` and `register` exports
 * so the #2885 installed loader can approve this file by digest under
 * `installed:opencode` (mirroring #2897 codex-adapter.mjs / #2911
 * openhuman-adapter.mjs). The bottom self-registration targets the legacy
 * Ralph-loop registry only; the direct worker profile loads through the
 * installed loader.
 */
import { ProviderAdapter, registerProvider } from './provider-adapter.mjs';
import { classifyWorkerHealthFailure, healthEventMatchesBinding } from './worker-health.mjs';

import { importImpl } from '../../_resolve-impl.mjs';
const { opencodeWorkerModelArgs, OPENCODE_SUPPORTED_VERSIONS } = await importImpl(import.meta.url, 'models/opencode-worker-model.mjs');
export { OPENCODE_SUPPORTED_VERSIONS };
/** Stdin is confirmed unsupported by the compiled v2.0.26 `run` chunk (see
 * module doc); the brief travels via `-f`/`--file` instead. */
export const OPENCODE_DIRECT_STDIN = 'closed';
/** Fixed, content-free positional message: never the brief, so brief bytes
 * never reach argv even though `-f` carries the real content. */
export const OPENCODE_FIXED_MESSAGE = 'Follow the instructions in the attached file exactly.';
/** No scoped sandbox flag is evidenced; `--auto` is a blanket bypass and is
 * never emitted, so the direct profile only accepts externally-enforced
 * sandboxing. */
export const OPENCODE_DIRECT_SANDBOX_MODES = Object.freeze(['external']);
/** Generic Ralph-loop aliases resolve through MODEL_MAP below; the direct
 * profile requires an exact observed catalog model instead. */
const OPENCODE_GENERIC_ALIASES = Object.freeze(['opus', 'sonnet', 'haiku']);

/**
 * Model mapping from generic names to OpenCode provider/model format.
 *
 * Free tier uses opencode/* models. Users who have connected an Anthropic
 * account via `opencode auth add` can pass anthropic/* IDs directly
 * (e.g., --model anthropic/claude-sonnet-5) and they pass through unchanged
 * because mapModel() only substitutes known generic aliases.
 */
const MODEL_MAP = {
  'opus':   'opencode/big-pickle',
  'sonnet': 'opencode/big-pickle',
  'haiku':  'opencode/big-pickle',
};

export class OpenCodeAdapter extends ProviderAdapter {
  /**
   * Own JSONL grammar observed from `opencode run --format json`
   * (test/fixtures/providers/opencode/health/stream.ndjson, #2896):
   * `step_start` (a model step began), `text` (streamed answer text in
   * `part.text`) and `step_finish` (the step ended, `part.reason` carries
   * `"stop"` on a clean finish). Handshake stays `process-only`: these are
   * step-scoped events inside one run, not an independently-evidenced
   * session-establishment signal, so only identity correlation (`setup`)
   * and the terminal/error outcome are reported; accepted-start and
   * distinct-item progress remain unavailable pending qualification.
   *
   * `step_start`/`step_finish` are BOTH OPTIONAL (roctinam/aiwg#2904
   * follow-up, live 2.0.26 smoke run + binary disassembly, host 'noodle',
   * 2026-10-10): the run command's event loop returns silently on
   * `session.execution.succeeded` with no JSON event of any kind, and a
   * live run that never produced a `session.step.*` pair emitted a single
   * `text` event and nothing else — confirmed success, not a truncation.
   * Their absence is therefore never treated as failure here; see
   * `parseOutput` for the strict final-validity rule this implies.
   */
  observeHealthEvent(event, source, binding) {
    if (source.kind !== 'stdout' || !event || typeof event !== 'object') return null;
    if (!healthEventMatchesBinding({ sessionId: event.sessionID }, binding)) return null;
    if (event.type === 'step_start') return { kind: 'setup', sessionId: event.sessionID };
    // --format json is JSONL despite the legacy streamJson=false boolean.
    if (event.type === 'text' && typeof event.part?.text === 'string') {
      return { kind: 'activity', key: event.part.id };
    }
    if (event.type === 'step_finish') {
      if (event.part?.reason === 'stop') return { kind: 'terminal', success: true, key: event.part?.id ?? 'step_finish' };
      return { ...classifyWorkerHealthFailure({ type: 'error', message: event.part?.reason }, { source, provider: 'opencode' }),
        reasonCode: 'PROVIDER_ERROR', fatal: true };
    }
    return null;
  }
  /** @returns {string} */
  getBinary() {
    return 'opencode';
  }

  /** @returns {string} */
  getName() {
    return 'opencode';
  }

  /**
   * OpenCode has limited capabilities compared to Claude.
   * Supports session resume, model selection, agent mode, and JSON output.
   * @returns {import('./provider-adapter.mjs').ProviderCapabilities}
   */
  getCapabilities() {
    return {
      streamJson: false,
      sessionResume: true,
      budgetControl: false,
      systemPrompt: false,
      agentMode: true,
      mcpConfig: false,
      maxTurns: false,
    };
  }

  /**
   * Driver-owned argv after the binary for the version-bound direct-shell
   * profile. Every control is explicit: exact observed model via `-m`
   * (with effort as `--variant` on 1.x or `#<variant>` on 2.x),
   * `--format json` for the evidenced JSONL stream, and the brief as an
   * attached file via `-f` (no stdin transport is evidenced; see the
   * module doc comment) — the positional argument is always the fixed,
   * content-free instruction, never brief text. A sandbox mode other than
   * externally-enforced is refused rather than guessed, since it has no
   * evidenced CLI mapping.
   *
   * @param {{ cliVersion?: string, selected?: { model?: unknown, effort?: { value?: unknown } }, cwd?: unknown, briefPath?: unknown }} invocation
   * @param {unknown} _profile
   * @param {{ sandbox?: unknown }} [permissions]
   * @returns {string[]}
   */
  buildWorkerArgs(invocation, _profile, permissions) {
    const model = invocation?.selected?.model;
    if (typeof model !== 'string' || !model || model.includes('\0')) {
      throw new Error('OpenCode worker requires an explicit model');
    }
    if (OPENCODE_GENERIC_ALIASES.includes(model.toLowerCase())) {
      throw new Error(`OpenCode worker requires an exact observed model, not the generic alias '${model}'`);
    }
    // #variant (2.x) / --variant (1.x) selects reasoning effort (see module
    // doc), but the valid id set is model-specific and not enumerated here,
    // so a syntactically valid id is appended. Whether the real CLI refuses
    // an undeclared id or silently falls back is unverified (effort stays
    // unqualified).
    const effort = invocation?.selected?.effort?.value ?? null;
    if (effort !== null) {
      if (typeof effort !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(effort)) {
        throw new Error('OpenCode worker effort must be a plain variant id (no "#", "/", whitespace or control characters)');
      }
    }
    const sandbox = permissions?.sandbox ?? 'external';
    if (!OPENCODE_DIRECT_SANDBOX_MODES.includes(sandbox)) {
      throw new Error(`OpenCode worker sandbox is not a qualified direct mode: ${String(sandbox)}`);
    }
    const cwd = invocation?.cwd;
    if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.includes('\0')) {
      throw new Error('OpenCode worker requires an absolute workspace');
    }
    // Stdin is confirmed unsupported (binary disassembly; see module doc),
    // so the brief rides on `-f`/`--file` as a path, never as argv content.
    const briefPath = invocation?.briefPath;
    if (typeof briefPath !== 'string' || !briefPath.startsWith('/') || briefPath.includes('\0')) {
      throw new Error('OpenCode worker requires an absolute brief-file path');
    }
    return ['run', '--format', 'json', ...opencodeWorkerModelArgs(model, effort, invocation.cliVersion), '-f', briefPath, OPENCODE_FIXED_MESSAGE];
  }

  /** No evidenced stdin abort channel for `opencode run`. */
  getAbortInput() {
    return null;
  }

  /**
   * Build args for the main headless session.
   *
   * OpenCode uses `opencode run --format json` for headless operation.
   *
   * @param {import('./provider-adapter.mjs').SessionArgs} options
   * @returns {string[]}
   */
  buildSessionArgs(options) {
    const args = [
      'run',
      '--format', 'json',
    ];

    // Model selection (map generic to OpenCode provider/model format)
    if (options.model) {
      args.push('-m', this.mapModel(options.model));
    }

    // Session resume via -s flag
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

    // MCP configuration not supported
    if (options.mcpConfig) {
      this.warnUnsupported('mcpConfig', 'MCP configuration (--mcp-config)');
    }

    // System prompt: OpenCode doesn't support --append-system-prompt,
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
   * @param {import('./provider-adapter.mjs').AnalysisArgs} options
   * @returns {string[]}
   */
  buildAnalysisArgs(options) {
    const args = [
      'run',
      '--format', 'json',
    ];

    // Model selection
    if (options.model) {
      args.push('-m', this.mapModel(options.model));
    }

    // Agent flag supported by OpenCode
    if (options.agent) {
      args.push('--agent', options.agent);
    }

    // The analysis prompt (must be last)
    args.push(options.prompt);

    return args;
  }

  /**
   * Map generic model names to OpenCode provider/model format.
   *
   * @param {string} genericModel
   * @returns {string}
   */
  mapModel(genericModel) {
    const mapped = MODEL_MAP[genericModel.toLowerCase()];
    if (mapped) return mapped;
    // Pass through if already an OpenCode model name or unknown
    return genericModel;
  }

  /**
   * Environment overrides for headless OpenCode sessions.
   * @returns {Object<string, string>}
   */
  getEnvOverrides() {
    return {
      CI: 'true',
    };
  }

  /**
   * OpenCode does not store session transcripts in a known location.
   * @returns {null}
   */
  getTranscriptPath() {
    return null;
  }

  /**
   * Parse OpenCode output — extracts text from newline-delimited JSON
   * events under a strict, binary-evidenced final-validity rule
   * (roctinam/aiwg#2904 follow-up, 2026-10-10).
   *
   * There is NO positive session-terminal event in this stream in ANY
   * mode: disassembly of the installed `opencode` 2.0.26 binary shows the
   * `run` command's event loop returns silently on
   * `session.execution.succeeded` ("...if(t.type==="session.execution.
   * succeeded")return}") — no JSON line is ever written for it. A live
   * 2.0.26 smoke run confirmed this empirically: a successful,
   * single-turn reply produced exactly one `text` event and nothing
   * else — no `step_start`, no `step_finish`
   * (.aiwg/working/s1-scratch/smoke-opencode.jsonl). `step_start`/
   * `step_finish` ARE still evidenced for streams that have them (older
   * CLI, or a turn that does produce discrete `session.step.*` events):
   * `step_finish`'s `part.reason` is unconditionally written from
   * `t.data.finish` whenever a step actually ends, so when one IS present
   * it stays authoritative and a non-`"stop"` reason (or an `error`
   * event, emitted from `session.step.failed`/`session.execution.failed`/
   * a non-user `session.execution.interrupted`) still fails the run even
   * at exit 0.
   *
   * The resulting rule, since no positive whole-run terminal exists:
   * reject a malformed/unparseable line, an unrecognized event type, any
   * `error` event, a present `step_finish` whose reason is not `"stop"`,
   * or trailing content after a `step_finish`. Otherwise accept only if
   * at least one `text` part completed (`part.time.end` present and
   * finite) OR a `step_finish` with reason `"stop"` was seen — a `text`
   * event with no recorded `time.end` (e.g. a dropped mid-stream
   * connection) does not count on its own.
   *
   * Residual risk, stated plainly: a provider that truncates the stream
   * right after flushing one complete `text` part, before any further
   * content or an error event, is indistinguishable from a genuine
   * single-part success — there is no stronger signal available from
   * this CLI's `run --format json` output to rule that out.
   *
   * @param {string} stdout
   * @returns {{ text: string }|null}
   */
  parseOutput(stdout) {
    if (typeof stdout !== 'string' || !stdout.trim()) return null;
    let text = '';
    let sawCompleteText = false;
    let stepFinishStop = null; // null: none seen; otherwise true/false
    let terminalSeen = false;
    for (const raw of stdout.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (terminalSeen) return null; // trailing content after step_finish
      let event;
      try { event = JSON.parse(line); } catch { return null; } // malformed frame: fail closed
      if (!event || typeof event !== 'object' || typeof event.type !== 'string') return null;
      if (event.type === 'step_start') continue;
      else if (event.type === 'text') {
        if (typeof event.part?.text !== 'string') return null;
        text += event.part.text;
        if (Number.isFinite(event.part?.time?.end)) sawCompleteText = true;
      } else if (event.type === 'step_finish') { stepFinishStop = event.part?.reason === 'stop'; terminalSeen = true; }
      else if (event.type === 'error') return null; // binary-evidenced failure event (session.step/execution.failed)
      else return null; // unrecognized event type: never invented, never ignored
    }
    if (stepFinishStop === false) return null;
    if (!sawCompleteText && stepFinishStop !== true) return null; // no positive signal at all
    return { text };
  }

  /**
   * #2995 round 4 (item 1): strict direct-worker-profile final, separate
   * from the legacy `parseOutput` candidate above (left byte-for-byte
   * unchanged: it is also the legacy Ralph-loop group-mode candidate,
   * `registerProvider('opencode', ...)` below, and `test/unit/
   * ralph-external/worker-finals.test.ts` depends on it falling back to
   * the generic envelope).
   *
   * `step_finish.part.reason` is NOT a two-valued stop/fail field: a
   * multi-step run (tool use, then an answer) ends EACH intermediate step
   * with its own `step_finish`, whose reason names why that step itself
   * ended, not the whole run. The 2.0.26 binary (conductor strings read on
   * noodle, 2026-10-11) normalizes finish reasons to `stop`, `length`,
   * `tool-calls`, `content-filter`, `error`, `other` and `unknown`, and its
   * own UI code treats exactly `tool-calls` (and `unknown`) as not final:
   * `T.finish && !["tool-calls","unknown"].includes(T.finish)`. So
   * `tool-calls` is the one evidenced "this step ended because the model
   * called a tool; another step follows" reason. Every other reason,
   * including `unknown` and any unrecognized value, fails closed:
   * CONTINUE_REASONS is the only carve-out from "non-stop fails".
   *
   * Algorithm: track one candidate per OPEN step (`step_start` always
   * resets it — an earlier step's text is never the final answer).
   * Within a step, a later COMPLETE (`time.end` present) `text` part
   * REPLACES the candidate (no evidence of a within-step text boundary
   * requiring concatenation); an INCOMPLETE `text` part arriving after a
   * complete candidate already exists corrupts that step's candidate
   * permanently (a dropped/truncated stream is never trusted over an
   * earlier value). A `step_finish` with reason `"stop"` is terminal
   * ONLY when nothing legitimately follows it (enforced structurally,
   * same as before) and requires a non-corrupted, non-empty candidate
   * from THAT step. A `step_finish` with a CONTINUE_REASONS reason is not
   * terminal and not a failure: the run proceeds (the next `step_start`
   * resets the candidate as normal). Any other `step_finish` reason, or
   * an `error` event, fails closed. When the stream has no step markers
   * at all (the live 2.0.26 shape evidenced in .aiwg/working/s1-scratch/
   * smoke-opencode.jsonl — a single `text` event and nothing else), the
   * same replace/corrupt rule applies to the whole stream's standalone
   * `text` events.
   * @param {string} stdout
   * @returns {{ text: string }|null}
   */
  parseDirectFinal(stdout) {
    if (typeof stdout !== 'string' || !stdout.trim()) return null;
    const CONTINUE_REASONS = ['tool-calls'];
    let sawAnyStep = false;
    let stepText = null;
    let stepCorrupted = false;
    let finalStepText = null;
    let terminal = false;
    let failed = false;
    for (const raw of stdout.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (terminal) return null; // nothing may follow a terminal step_finish(stop)
      let event;
      try { event = JSON.parse(line); } catch { return null; }
      if (!event || typeof event !== 'object' || typeof event.type !== 'string') return null;
      if (event.type === 'step_start') {
        // A new step begins: any earlier step's candidate is never the final answer.
        sawAnyStep = true; stepText = null; stepCorrupted = false;
      } else if (event.type === 'text') {
        if (typeof event.part?.text !== 'string') return null;
        if (Number.isFinite(event.part?.time?.end)) {
          stepText = event.part.text; // a later complete part REPLACES, never concatenates
        } else {
          // An incomplete part after an established candidate corrupts it
          // permanently; an incomplete part with no prior candidate is
          // simply "no positive signal yet" (handled by the end-of-stream
          // checks below).
          if (stepText !== null) stepCorrupted = true;
        }
      } else if (event.type === 'step_finish') {
        sawAnyStep = true;
        const reason = event.part?.reason;
        if (reason === 'stop') {
          terminal = true;
          finalStepText = stepCorrupted ? null : stepText;
        } else if (!CONTINUE_REASONS.includes(reason)) {
          failed = true; // a recognized-failure or unrecognized reason fails closed
        }
        // CONTINUE_REASONS: not terminal, not a failure; the next step_start resets the candidate.
      } else if (event.type === 'error') return null;
      // The 2.0.26 run emitter writes exactly six event types: error, reasoning, step_finish, step_start, text and
      // tool_use (conductor strings read on noodle, 2026-10-11). tool_use and reasoning are legitimate non-answer
      // events: they never contribute answer text. Anything else is outside the emitter's vocabulary and rejects.
      else if (event.type !== 'tool_use' && event.type !== 'reasoning') return null;
    }
    if (failed) return null;
    if (sawAnyStep) {
      if (!terminal || finalStepText === null || !finalStepText.trim()) return null;
      return { text: finalStepText };
    }
    if (stepCorrupted || stepText === null || !stepText.trim()) return null;
    return { text: stepText };
  }
}

// Self-register on import for the legacy Ralph loop only. The direct worker
// profile loads through the #2885 installed loader instead (see below).
registerProvider('opencode', () => new OpenCodeAdapter());

/**
 * #2995 round 3: `OpenCodeDirectAdapter` is the Claude-precedent `-direct`
 * subclass, registered under its OWN id (`opencode-direct`, never the
 * bare `opencode` legacy id above) so loading this installed module
 * cannot overwrite the legacy registration in-process (src/models/
 * worker-installation.mjs ~l.550). `parseOutput` here is the strict,
 * last-step-only `parseDirectFinal` rule (never the loose, concatenating,
 * generic-accepting legacy candidate), and `parseWorkerFinal` is strict
 * with no generic-envelope fallback: this class is never reachable from
 * the legacy bare id, so the legacy group-mode contract (test/unit/
 * ralph-external/worker-finals.test.ts) never sees it.
 */
export class OpenCodeDirectAdapter extends OpenCodeAdapter {
  // #2995 round 4 (item 3): production resolves the installed adapter by
  // `adapter.id` (now `opencode-direct`, item B) and src/models/
  // worker-installation.mjs's `inspectWorkerInstallation` requires
  // `adapter.id === instance.getName()`. `getBinary()` and the
  // `provider: 'opencode'` literal inside `observeHealthEvent` are
  // untouched.
  getName() { return 'opencode-direct'; }

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
    if (!final || typeof final.text !== 'string' || !final.text.trim()) {
      throw new Error('OpenCode worker stream did not produce a successful final answer');
    }
    return super.parseWorkerFinal(final.text, { ...options, format: 'json' });
  }
}

/** Installed-module interface version (mirrors #2897 codex-adapter.mjs). */
export const interfaceVersion = 1;

/** Installed-module registration: exactly the one approved adapter ID. */
export function register(factory) {
  factory('opencode-direct', () => new OpenCodeDirectAdapter());
}

export default OpenCodeAdapter;
