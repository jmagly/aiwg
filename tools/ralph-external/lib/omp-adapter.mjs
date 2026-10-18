import { spawnSync } from 'node:child_process';
import { ProviderAdapter, registerProvider } from './provider-adapter.mjs';
import { OmpFrameDecoder, summarizeOmpEvents, OmpRpcClient, MAX_FRAME, MAX_MESSAGE } from '../../providers/omp-transport.mjs';
import { createWorkerHealthObserver, healthEventMatchesBinding } from './worker-health.mjs';

/**
 * Version-bound direct-worker surface (roctinam/aiwg#2910, B-OG-45).
 *
 * Qualified against `omp/18.8.7` `--help` (help/version syntax only,
 * 2026-10-09, captured on noodle; never live qualification):
 *
 *   omp --mode json --print --no-extensions --no-skills --no-rules
 *     --model M --thinking E --cwd W --approval-mode write < briefPath
 *
 * `--print`/`-p` ("Non-interactive mode: process prompt and exit") is kept
 * explicit alongside `--mode json` because OMP's own `--help` lists it as a
 * separate flag (unlike the evidenced Pi fork behavior where `--mode json`
 * alone forces non-interactive): the direct profile never depends on an
 * unverified inheritance assumption for this one invariant.
 *
 * `--approval-mode` is ALWAYS rendered explicitly and is NEVER omitted: a
 * static read of the installed omp binary (`~/.local/bin/omp` on noodle,
 * 18.8.7, noodle) shows the compiled-in default is `"yolo"`
 * (`approvalMode: Uxa(s) ? s : "yolo"`) — a full approval/sandbox bypass —
 * so an omitted flag would silently inherit the most dangerous mode, not a
 * safe one. The same binary defines the mode->tier gate explicitly:
 *   `Kxa = { "always-ask": "read", write: "write", yolo: "exec" }`
 *   `PS = { read: 0, write: 1, exec: 2 }`
 *   `Xxa(mode, toolTier) { return PS[toolTier] <= PS[Kxa[mode]]; }`
 * i.e. a tool call is auto-allowed only when its own tier rank is at or
 * below the mode's threshold tier rank; anything above resolves to a
 * `"prompt"`-required decision. `write`'s threshold is `write` (rank 1), so
 * it auto-approves `read`/`write`-tier tools but an `exec`-tier tool
 * (`bash`, the dominant tool for a coding worker) still resolves to
 * `"prompt"` required. `write` is therefore NOT a complete non-prompting
 * guarantee for this profile — it is only the least-prompting of the two
 * non-bypass values (`always-ask`'s threshold is `read`, rank 0, so it
 * prompts for `write` AND `exec`). `yolo` is never used (its threshold is
 * `exec`, rank 2: every tier auto-allowed, i.e. a full bypass). No headless
 * auto-resolution for a `"prompt"`-required decision was found in the
 * binary (the one "Cannot prompt for confirmation (no TTY)" string in the
 * binary belongs to Bun's own bundled package-install security-advisory
 * prompt, not OMP's tool-approval gate); the changelog text compiled into
 * the same binary separately describes ACP approval requests getting stuck
 * `"pending"` when the channel "cannot answer" them. Exec-tier tool calls
 * under `write` in print mode are therefore an OPEN GAP, not a qualified
 * non-prompting path: the `approval` control stays `unqualified` and this
 * gap is the reason, not a documentation placeholder. OMP has no
 * `--approve/--no-approve` trust flag like Pi; the closest documented
 * surface for unvetted project-local resources is discovery of
 * extensions/skills/rules, so the direct profile always disables all three
 * (`--no-extensions --no-skills --no-rules`) rather than trusting arbitrary
 * workspace files. `--cwd` is explicit and documented (`--help`), unlike
 * Pi, which has no such flag. There is no documented sandbox,
 * output-file, output-schema, step-cap or child-denial flag (`omp --help`,
 * 2026-10-09): those controls stay unavailable rather than invented, and
 * the final answer is extracted from the stdout event stream
 * (`parseOutput()`/`summarizeOmpEvents`), never a `-o`-style file.
 *
 * The brief travels on stdin, never argv — CONFIRMED by a static read of
 * the installed omp binary (18.8.7, noodle), not merely inherited from
 * Pi's lineage: `async function wUt()` (OMP's own `readPipedInput`) returns
 * early when `process.stdin.isTTY === true`, otherwise awaits
 * `Bun.stdin.text()` to EOF and returns the text unless it is
 * all-whitespace; it runs whenever `mode` is not `rpc`/`rpc-ui`/`acp`
 * (`--mode json` included: `const p = r === "rpc" || r === "rpc-ui" || r
 * === "acp"; const c = p ? undefined : await readPipedInput();`), and its
 * result is passed as `stdinContent` into OMP's own `buildInitialMessage`
 * (`function aso({parsed, fileText, stdinContent}) { ... }`), which
 * prefixes it onto the initial message exactly like Pi's equivalent
 * function. Unlike Pi's `readPipedStdin`, OMP's `readPipedInput` does not
 * trim the returned text (only the emptiness check is trimmed), so a brief
 * with leading/trailing whitespace is NOT altered by OMP (a difference
 * from Pi, noted since the shared fixture briefs intentionally carry
 * leading/trailing whitespace).
 */
export const OMP_DIRECT_VERSION = '18.8.7';
/** Mirrors providers.omp.effortValues in model-capabilities.v1.json (hardcoded,
 * not read via a repo-relative path: the installed-module loader copies this
 * file to an arbitrary package root, so import.meta.url-relative reads to the
 * repository are not safe here). */
export const OMP_DIRECT_EFFORT_VALUES = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh']);
/** Explicit, non-bypassing approval only (`yolo` refused; OMP's unset default is yolo). `write`
 * auto-approves read/write tools; exec-tier (bash) approvals have no confirmed headless
 * resolution, so the approval control stays unqualified. */
export const OMP_DIRECT_APPROVAL_MODES = Object.freeze(['write']);
/** Brief transport for the direct profile: piped stdin, never argv. */
export const OMP_DIRECT_STDIN = 'brief-text';

/** Oh My Pi's native flags/events intentionally differ from Pi. */
export class OmpAdapter extends ProviderAdapter {
  createHealthObserver(options = {}) {
    // Reuse OMP's owned v2 chunk grammar. Neither another CLI's framing nor
    // the strict worker-final parser is a substitute for native reassembly.
    const messageLimit = Math.min(options.maxMessageBytes ?? 4 * MAX_FRAME, MAX_MESSAGE);
    let decoder = new OmpFrameDecoder({ messageLimit });
    let lastSource = null;
    const observer = createWorkerHealthObserver({ ...options, provider: this.getName(),
      maxFrameBytes: options.maxFrameBytes ?? MAX_FRAME,
      normalizeEvent: (frame, source, binding) => {
        if (source.kind !== 'stdout') return null;
        const identity = `${source.id}:${source.generation}`;
        if (lastSource !== null && lastSource !== identity) decoder = new OmpFrameDecoder({ messageLimit });
        lastSource = identity;
        try {
          const event = decoder.decode(frame);
          return event ? this.observeHealthEvent(event, source, binding) : null;
        } catch (error) {
          decoder = new OmpFrameDecoder({ messageLimit });
          throw error;
        }
      },
    });
    const finish = observer.finish;
    observer.finish = observation => {
      try { decoder.end(); } catch { observer.gap('MALFORMED_FRAME'); }
      return finish(observation);
    };
    return observer;
  }
  observeHealthEvent(event, source, binding) {
    if (source.kind !== 'stdout' || !event || typeof event !== 'object') return null;
    if (!healthEventMatchesBinding({ sessionId: event.sessionId }, binding)) return null;
    if (event.type === 'agent_start') return { kind: 'accepted' };
    if (event.type === 'tool_execution_end') {
      if (event.isError === true) return { kind: 'error', reasonCode: 'tool-failed' };
      if (typeof event.toolCallId === 'string') return { kind: 'progress', key: event.toolCallId };
      return { kind: 'activity' };
    }
    if (event.type === 'agent_end') {
      if (Array.isArray(event.messages) && event.messages.some(message => message.stopReason === 'error' || message.stopReason === 'aborted')) return { kind: 'error', reasonCode: 'provider-failed' };
      return event.willContinue === true ? { kind: 'activity' } : { kind: 'terminal', success: true, key: 'agent_end' };
    }
    if (event.type === 'rpc_frame_error' || event.type === 'error') return { kind: 'error', reasonCode: 'provider-failed' };
    return null;
  }
  async getVersion() { const result = spawnSync(this.getBinary(), ['--version'], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536, killSignal: 'SIGKILL' }); return result.status === 0 ? result.stdout.trim() : null; }
  async isAvailable() { return Boolean(await this.getVersion()); }
  getName() { return 'omp'; }
  getBinary() { return process.env.AIWG_OMP_BIN || 'omp'; }
  getCapabilities() { return { streamJson: true, sessionResume: true, budgetControl: false, systemPrompt: true, agentMode: false, mcpConfig: false, maxTurns: false, rpcAbort: true }; }
  buildSessionArgs(options) {
    const args = ['--mode', 'json'];
    if (options.profile) args.push('--profile', options.profile);
    for (const config of options.config ?? []) args.push('--config', config);
    if (options.model) args.push('--model', this.mapModel(options.model));
    if (options.thinking) args.push('--thinking', options.thinking);
    if (options.sessionId) args.push('--session', options.sessionId);
    if (options.sessionDir) args.push('--session-dir', options.sessionDir);
    if (options.noSession) args.push('--no-session');
    if (options.noExtensions) args.push('--no-extensions');
    if (options.tools) { if (options.tools.length) args.push('--tools', options.tools.join(',')); else args.push('--no-tools'); }
    if (options.systemPrompt) args.push('--append-system-prompt', options.systemPrompt);
    for (const [option, capability] of [['budget', 'budgetControl'], ['maxTurns', 'maxTurns'], ['mcpConfig', 'mcpConfig']]) if (options[option]) this.warnUnsupported(capability, option);
    args.push('--', options.prompt);
    return args;
  }
  buildAnalysisArgs(options) { return this.buildSessionArgs(options); }

  /**
   * Driver-owned argv after the binary for the version-bound direct-shell
   * profile. Model, thinking level and workdir are always explicit (never
   * a CLI default or alias); approval is pinned explicitly to `write` (never
   * left unset, which would be yolo; exec-tier approvals stay unresolved); extension/skill/rule discovery is
   * always disabled (no `--approve`-style trust flag exists on OMP); the
   * brief is validated here but never placed in argv — it travels on
   * stdin (`stdin: 'brief-text'`).
   *
   * @param {{ selected?: { model?: unknown, effort?: { value?: unknown } }, cwd?: unknown, brief?: unknown }} invocation
   * @param {unknown} _profile
   * @param {{ approval?: unknown }} [permissions]
   * @returns {string[]}
   */
  buildWorkerArgs(invocation, _profile, permissions) {
    const model = invocation?.selected?.model;
    if (typeof model !== 'string' || !model || model.includes('\0')) {
      throw new Error('OMP worker requires an explicit model');
    }
    const effort = invocation?.selected?.effort?.value ?? null;
    if (effort === null || !OMP_DIRECT_EFFORT_VALUES.includes(effort)) {
      throw new Error('OMP worker requires an explicit qualified thinking level (never a CLI default)');
    }
    const cwd = invocation?.cwd;
    if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.includes('\0')) {
      throw new Error('OMP worker requires an absolute workspace');
    }
    // The shared resolved-permission vocabulary's 'never' ("never require
    // approval") is the only input that maps to OMP's explicit, non-bypassing
    // `write` mode (exec-tier approvals unresolved headless; see module doc); 'always'/'on-request' have no equivalent
    // without prompting or a full sandbox/approval bypass and are refused.
    const requestedApproval = permissions?.approval ?? 'never';
    if (requestedApproval !== 'never') {
      throw new Error(`OMP worker approval is not a qualified direct mode: ${String(requestedApproval)}`);
    }
    const approval = OMP_DIRECT_APPROVAL_MODES[0];
    const brief = invocation?.brief;
    if (typeof brief !== 'string' || !brief.trim() || brief.includes('\0')) {
      throw new Error('OMP worker requires a non-empty brief');
    }
    return ['--mode', 'json', '--print', '--no-extensions', '--no-skills', '--no-rules',
      '--model', model, '--thinking', effort, '--cwd', cwd, '--approval-mode', approval];
  }

  mapModel(model) { return model; }
  getEnvOverrides() { return { CI: 'true', NO_COLOR: '1' }; }
  // JSON print mode has no stdin abort protocol; runner terminates its process.
  getAbortInput() { return null; }
  createRpcClient(options = {}) { return new OmpRpcClient({ binary: this.getBinary(), ...options }); }
  getTranscriptPath(sessionId) { return sessionId?.endsWith('.jsonl') ? sessionId : null; }
  parseOutput(stdout, options = {}) {
    if (Buffer.byteLength(stdout) > MAX_MESSAGE) return null;
    try { const decoder = new OmpFrameDecoder({ frameLimit: MAX_MESSAGE }); const events = decoder.push(Buffer.from(stdout)); decoder.end(); return events.length ? summarizeOmpEvents(events, options) : null; } catch { return null; }
  }

  /**
   * #2995 round 3: strict direct-worker-profile final, separate from the
   * legacy `parseOutput`/`summarizeOmpEvents` candidate above (that SHARED
   * helper is never changed here — module doc). `summarizeOmpEvents`
   * tracks the LAST assistant message across every event with a
   * `messages`/`message` field, including `tool_execution_end.message`,
   * so it can retain a stale or tool-carried answer when the real terminal
   * `agent_end` is answerless. This rule instead: (1) only reads the
   * assistant answer from the LAST terminal `agent_end` (`willContinue !==
   * true`) itself, never from any other event type; (2) a non-terminal
   * `agent_end` (`willContinue: true`) clears any earlier candidate text,
   * since it is not the run's actual final answer; (3) ANY event observed
   * after the terminal `agent_end` fails the parse, mirroring Factory/
   * Cursor's structural "nothing follows the terminal" rule.
   * @param {string|Uint8Array} stdout
   * @returns {{ text: string, success: true } | null}
   */
  parseDirectFinal(stdout) {
    if (Buffer.byteLength(stdout) > MAX_MESSAGE) return null;
    let events;
    try {
      const decoder = new OmpFrameDecoder({ frameLimit: MAX_MESSAGE });
      events = decoder.push(Buffer.from(stdout));
      decoder.end();
    } catch { return null; }
    if (!events.length) return null;
    let terminal = null, text = null, failed = false, aborted = false, elided = false, afterTerminal = false;
    for (const event of events) {
      if (/elided for RPC frame|rpcFrameElidedKeys/.test(JSON.stringify(event))) elided = true;
      if (terminal) { afterTerminal = true; continue; }
      if (event.type === 'rpc_frame_error' || event.type === 'error') { failed = true; continue; }
      if (event.type === 'tool_execution_end' && event.isError) { failed = true; continue; }
      if (event.type === 'agent_end' && event.willContinue === true) { text = null; continue; }
      if (event.type === 'agent_end' && event.willContinue !== true) {
        terminal = event;
        const assistant = Array.isArray(event.messages) ? event.messages.filter(message => message.role === 'assistant').at(-1) : undefined;
        if (!assistant) { text = null; continue; }
        if (assistant.stopReason === 'error') failed = true;
        if (assistant.stopReason === 'aborted') aborted = true;
        text = Array.isArray(assistant.content) ? assistant.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : null;
        continue;
      }
    }
    if (!terminal || afterTerminal || failed || aborted || elided) return null;
    if (!text || !text.trim()) return null;
    return { text, success: true };
  }
}
// Self-register on import for the legacy Ralph loop only. The direct worker
// profile loads through the #2885 installed loader instead (see below).
registerProvider('omp', () => new OmpAdapter());

/**
 * #2995 round 3: `OmpDirectAdapter` is the Claude-precedent `-direct`
 * subclass, registered under its OWN id (`omp-direct`, never the bare
 * `omp` legacy id above) so loading this installed module cannot overwrite
 * the legacy registration in-process (src/models/worker-installation.mjs
 * ~l.550). `parseOutput` here is the strict `parseDirectFinal` rule (never
 * the loose, generic-accepting legacy candidate), and `parseWorkerFinal`
 * is strict with no generic-envelope fallback: this class is never
 * reachable from the legacy bare id, so the legacy group-mode contract
 * (test/unit/ralph-external/worker-finals.test.ts) never sees it.
 */
export class OmpDirectAdapter extends OmpAdapter {
  // #2995 round 4 (item 3): production resolves the installed adapter by
  // `adapter.id` (now `omp-direct`, item B) and src/models/
  // worker-installation.mjs's `inspectWorkerInstallation` requires
  // `adapter.id === instance.getName()`. `getBinary()` is untouched; the
  // inherited `createHealthObserver` override's `provider: this.getName()`
  // label changes too, but it only feeds the shared observer's stderr
  // classifier/report label -- `observeHealthEvent` below (the actual
  // event dispatch) is unaffected.
  getName() { return 'omp-direct'; }

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
    if (!final) throw new Error('OMP worker stream did not produce a successful final answer');
    return super.parseWorkerFinal(final.text, { ...options, format: 'json' });
  }
}

/** Installed-module interface version (mirrors #2897 codex-adapter.mjs). */
export const interfaceVersion = 1;

/** Installed-module registration: exactly the one approved adapter ID. */
export function register(factory) {
  factory('omp-direct', () => new OmpDirectAdapter());
}

export default OmpAdapter;
