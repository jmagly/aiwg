/**
 * GitHub Copilot direct-worker profile, evidenced by the 1.0.106 captures
 * from 2026-11-10 (#4088). Sanitized excerpts live in
 * test/fixtures/providers/copilot/copilot-stdin-only.jsonl and copilot-stdin.jsonl.
 *
 * Pipe the brief to stdin with no -p/--prompt or --attachment. The 1.0.95
 * help-only attachment profile is superseded: 1.0.106 rejects Markdown
 * attachments, and -p causes piped stdin to be ignored. The stdin-only BYOK
 * capture produced one assistant.message, no tool requests, and isByok=true.
 *
 * The last assistant.message data.content is the answer after a terminal
 * assistant.turn_end/assistant.idle. Process exit and strict workerClaims
 * validation remain separate host-owned checks. Event-level health stays
 * process-only, with the existing conservative error-shape guard.
 *
 * Model, effort, cwd, scoped tool permissions and workspace-context denials
 * remain explicit. OS sandboxing requires an external boundary. Installed
 * packages include the shared ProviderAdapter runtime, as sibling providers do.
 */
import { ProviderAdapter } from './provider-adapter.mjs';
import { parseStrictWorkerJson } from './strict-worker-json.mjs';

export const interfaceVersion = 1;

export const COPILOT_SUPPORTED_VERSIONS = Object.freeze(['1.0.106']);
export const COPILOT_DIRECT_EFFORT_VALUES = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
/** Piped brief text, read to EOF without an inline prompt. */
export const COPILOT_DIRECT_STDIN = 'brief-text';
/** No per-call OS sandbox flag is safely evidenced (see module doc); external boundary only. */
export const COPILOT_DIRECT_SANDBOX_MODES = Object.freeze(['external']);
/** Case-insensitive refusal list: Copilot's own CLI-chosen routing, never selected here. */
const COPILOT_AUTO_MODEL_SPELLINGS = Object.freeze(['auto']);
/** Generic Ralph-loop aliases are never a valid direct-profile model. */
const COPILOT_GENERIC_ALIASES = Object.freeze(['opus', 'sonnet', 'haiku']);
/** Blanket bypass flags/words this profile must never emit via a tool pattern. */
const COPILOT_BANNED_TOOL_PATTERNS = Object.freeze(['--allow-all-tools', '--allow-all', '--yolo', '*']);

/** Control characters (incl. NUL, CR, LF, TAB) are never valid inside a single tool pattern token. */
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

function assertPlainToolPattern(value, label) {
  if (typeof value !== 'string' || !value.trim() || CONTROL_CHAR_PATTERN.test(value)) {
    throw new Error(`Copilot worker ${label} pattern must be a non-empty single-line string with no control characters`);
  }
  if (COPILOT_BANNED_TOOL_PATTERNS.includes(value)) {
    throw new Error(`Copilot worker ${label} pattern must be scoped, never a blanket bypass: ${value}`);
  }
  // A real variadic parser treats any "-"-prefixed token as the START of a
  // new option, not a value for --allow-tool/--deny-tool. Refuse these here
  // so a caller can never smuggle an option token (e.g. --allow-all-paths,
  // --allow-all-urls) through the variadic tool-pattern slot.
  if (value.startsWith('-')) {
    throw new Error(`Copilot worker ${label} pattern must not look like a CLI option; option-prefixed tokens are refused: ${value}`);
  }
}

export class CopilotAdapter extends ProviderAdapter {
  getBinary() { return 'copilot'; }
  getName() { return 'copilot'; }
  getCapabilities() {
    return {
      streamJson: false, sessionResume: false, budgetControl: false, systemPrompt: false,
      agentMode: true, mcpConfig: false, maxTurns: false,
    };
  }
  buildSessionArgs() {
    throw new Error('Copilot has no qualified Ralph loop session; use the direct worker profile');
  }
  buildAnalysisArgs() { return this.buildSessionArgs(); }

  /**
   * Driver-owned argv after the binary for the version-bound direct-shell
   * profile. Every control is explicit: exact model (never `auto` or a
   * generic alias), explicit reasoning effort, the workspace via `-C`, the
   * brief on piped stdin (never argv content), `--no-ask-user`
   * plus the untrusted-surface denials, and only scoped
   * `--allow-tool`/`--deny-tool` permission tokens — never
   * `--allow-all-tools`/`--allow-all`/`--yolo`.
   *
   * @param {{ selected?: { model?: unknown, effort?: { value?: unknown } }, cwd?: unknown, briefPath?: unknown }} invocation
   * @param {unknown} _profile
   * @param {{ allowTools?: unknown, denyTools?: unknown }} [permissions]
   * @returns {string[]}
   */
  buildWorkerArgs(invocation, _profile, permissions) {
    const model = invocation?.selected?.model;
    if (typeof model !== 'string' || !model || model.includes('\0')) {
      throw new Error('Copilot worker requires an explicit model');
    }
    if (COPILOT_AUTO_MODEL_SPELLINGS.includes(model.toLowerCase())) {
      throw new Error("Copilot worker requires an explicit model, never 'auto'");
    }
    if (COPILOT_GENERIC_ALIASES.includes(model.toLowerCase())) {
      throw new Error(`Copilot worker requires an exact observed model, not the generic alias '${model}'`);
    }
    const effort = invocation?.selected?.effort?.value ?? null;
    if (effort === null || !COPILOT_DIRECT_EFFORT_VALUES.includes(effort)) {
      throw new Error('Copilot worker requires an explicit qualified reasoning effort (never a CLI default)');
    }
    const cwd = invocation?.cwd;
    if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.includes('\0')) {
      throw new Error('Copilot worker requires an absolute workspace');
    }
    const briefPath = invocation?.briefPath;
    if (typeof briefPath !== 'string' || !briefPath.startsWith('/') || briefPath.includes('\0')) {
      throw new Error('Copilot worker requires an absolute brief-file path');
    }
    const sandbox = permissions?.sandbox ?? 'external';
    if (!COPILOT_DIRECT_SANDBOX_MODES.includes(sandbox)) {
      throw new Error(`Copilot worker sandbox is not a qualified direct mode: ${String(sandbox)}`);
    }
    const allowTools = permissions?.allowTools;
    if (!Array.isArray(allowTools) || allowTools.length === 0) {
      throw new Error('Copilot worker requires at least one explicit scoped --allow-tool pattern (never --allow-all-tools)');
    }
    for (const pattern of allowTools) assertPlainToolPattern(pattern, '--allow-tool');
    const denyTools = permissions?.denyTools ?? [];
    if (!Array.isArray(denyTools)) throw new Error('Copilot worker denyTools must be an array when present');
    for (const pattern of denyTools) assertPlainToolPattern(pattern, '--deny-tool');
    const args = [
      '--model', model,
      '--reasoning-effort', effort,
      '-C', cwd,
      '--output-format', 'json',
      '--no-ask-user',
      '--no-custom-instructions',
      '--disable-builtin-mcps',
    ];
    for (const pattern of allowTools) args.push('--allow-tool', pattern);
    for (const pattern of denyTools) args.push('--deny-tool', pattern);
    return args;
  }

  /** Stdin closes after the brief. No abort message is evidenced. */
  getAbortInput() { return null; }

  /** Process-only health until progress semantics are independently evidenced. */
  observeHealthEvent() { return null; }

  /** Candidate extraction uses the same terminal rule as strict claims parsing. */
  parseOutput(stdout) { return this.parseDirectFinal(stdout); }

  /** Extract the last settled assistant message from bounded, clean JSONL. */
  parseDirectFinal(stdout) {
    if (typeof stdout !== 'string' || !stdout.isWellFormed()
      || Buffer.byteLength(stdout) > 10 * 1024 * 1024 || !stdout.trim()) return null;
    let message = null;
    let terminal = false;
    for (const raw of stdout.split('\n')) {
      if (!raw.trim()) continue;
      let event;
      try { event = parseStrictWorkerJson(raw, 16); } catch { return null; }
      if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
      if (event.type === 'error' || (event.error !== undefined && event.error !== null)) return null;
      if (event.type === 'result' && event.exitCode !== undefined && event.exitCode !== 0) return null;
      if (event.type === 'model.call_final_result' && event.data?.result !== 'success') return null;
      if (event.type === 'assistant.message') {
        message = event.data;
        terminal = false;
      } else if (event.type === 'assistant.turn_end' || event.type === 'assistant.idle') {
        if (message && (event.type === 'assistant.idle' || event.data?.turnId === message.turnId)) terminal = true;
      } else if (['assistant.turn_start', 'assistant.message_start', 'assistant.message_delta',
        'tool.execution_start', 'user.message'].includes(event.type)) {
        message = null;
        terminal = false;
      }
    }
    if (!terminal || typeof message?.content !== 'string' || !message.content.trim()
      || !Array.isArray(message.toolRequests) || message.toolRequests.length) return null;
    return { text: message.content.trim() };
  }

  /** Use the shared strict claims parser after provider-specific extraction. */
  async parseWorkerFinal(output, options = {}) {
    if (options.format === 'mcp') throw new Error('Copilot direct profile has no evidenced MCP final transport');
    const limit = options.maxOutputBytes ?? 10 * 1024 * 1024;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10 * 1024 * 1024) throw new Error('Invalid worker stream bound');
    if (typeof output !== 'string' && !(output instanceof Uint8Array)) throw new Error('Copilot worker output must be UTF-8 bytes or text');
    if (typeof output === 'string' && !output.isWellFormed()) throw new Error('Malformed Copilot worker UTF-8');
    const bytes = typeof output === 'string' ? Buffer.from(output, 'utf8') : output;
    if (bytes.byteLength > limit) throw new Error('Copilot worker stream exceeds byte bound');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const final = this.parseDirectFinal(text);
    if (!final) throw new Error('Copilot worker stream did not produce a settled final answer');
    return super.parseWorkerFinal(final.text, { ...options, format: 'json' });
  }

}

/** Installed-module registration: exactly the one approved adapter ID. */
export function register(factory) {
  factory('copilot', () => new CopilotAdapter());
}

export default CopilotAdapter;
