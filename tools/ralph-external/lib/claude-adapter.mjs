/**
 * Claude CLI Provider Adapter for External Ralph Loop
 *
 * Extracts existing Claude-specific spawn logic into the ProviderAdapter
 * interface. Direct workers use the version-bound stdin profile below.
 * Legacy Ralph calls retain their prompt transport but deny permission prompts.
 *
 * @implements Plan: Multi-Provider Support for External Ralph Loop
 */

import { join } from 'path';
import { homedir } from 'os';
import { ProviderAdapter, registerProvider } from './provider-adapter.mjs';
import { classifyWorkerHealthFailure, healthEventMatchesBinding } from './worker-health.mjs';

/** Help-only evidence: /home/roctinam/.local/bin/claude 2.1.319, 2026-11-07.
 * Exact help excerpts and unavailable controls: docs/providers/claude-direct.md.
 * No inference or credential inspection was performed to establish this syntax.
 */
export const interfaceVersion = 1;
export const CLAUDE_SUPPORTED_VERSIONS = Object.freeze(['>=2.1.295 <2.2.0']);
export const CLAUDE_DIRECT_EFFORT_VALUES = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
// Named aliases --help documents (opus/sonnet/fable) plus other known moving
// pointers: 'default', 'haiku', and the Max-plan 'opusplan' alias. None of
// these pin an exact snapshot.
const CLAUDE_MOVING_ALIASES = Object.freeze(['opus', 'sonnet', 'haiku', 'fable', 'default', 'opusplan']);
const CLAUDE_DATED_SNAPSHOT = /-\d{8}$/;
// A bare `claude-<family>-<version numbers>` id (e.g. "claude-sonnet-4-5")
// still resolves to whatever snapshot is currently latest for that family;
// only a trailing YYYYMMDD date pins an exact, non-moving release.
const CLAUDE_DATELESS_FAMILY_ID = /^claude-[a-z]+(-\d+)+$/i;
/** True for any alias or alias-shaped model string that is not a single,
 * exact, non-moving model identifier: named aliases, bracketed modifiers
 * such as "sonnet[1m]", `-latest` suffixes, and dateless `claude-<family>-<version>`
 * pointers. */
function isClaudeMovingModelPointer(model) {
  return CLAUDE_MOVING_ALIASES.includes(model.toLowerCase()) || /[[\]]/.test(model)
    || /-latest$/i.test(model)
    || (CLAUDE_DATELESS_FAMILY_ID.test(model) && !CLAUDE_DATED_SNAPSHOT.test(model));
}
const FILE_TOOLS = Object.freeze({
  'read-only': 'Read,Glob,Grep',
  'workspace-write': 'Read,Glob,Grep,Edit,Write',
});

/** Reject duplicate keys before vendor-envelope normalization can hide them.
 * JSON.parse first checks syntax; the token walk checks object keys and depth.
 */
function strictEvent(line) {
  const value = JSON.parse(line);
  const tokens = line.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]/g) ?? [];
  const stack = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '{' || token === '[') {
      stack.push(token === '{' ? new Set() : null);
      if (stack.length > 16) throw new Error('Claude event nesting exceeds bound');
    } else if (token === '}' || token === ']') stack.pop();
    else if (token.startsWith('"') && tokens[i + 1] === ':') {
      const key = JSON.parse(token), keys = stack.at(-1);
      if (!keys || keys.has(key)) throw new Error('Duplicate Claude JSON member');
      keys.add(key);
    }
  }
  return value;
}

/** Extract exactly one successful Claude result envelope from JSONL stdout.
 * This establishes vendor terminal syntax only; trusted exit/stop observation
 * and AIWG claims validation remain required by parseWorkerFinal.
 */
export function parseClaudeTerminal(output, maxOutputBytes = 10 * 1024 * 1024) {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 10 * 1024 * 1024) {
    throw new Error('Invalid Claude stream bound');
  }
  if (typeof output !== 'string' && !(output instanceof Uint8Array)) throw new Error('Claude output must be bytes or text');
  if (typeof output === 'string' && !output.isWellFormed()) throw new Error('Malformed Claude UTF-8');
  const bytes = typeof output === 'string' ? Buffer.from(output) : output;
  if (bytes.byteLength > maxOutputBytes) throw new Error('Claude stream exceeds byte bound');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  let terminal, sessionId;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (terminal) throw new Error('Double or trailing Claude terminal');
    const event = strictEvent(line);
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') {
      throw new Error('Malformed Claude event');
    }
    if (event.session_id !== undefined) {
      if (typeof event.session_id !== 'string' || !event.session_id || (sessionId && sessionId !== event.session_id)) {
        throw new Error('Claude session mismatch');
      }
      sessionId = event.session_id;
    }
    if (event.type === 'error' || event.is_error === true) throw new Error('Claude error event');
    if (!['system', 'assistant', 'user', 'stream_event', 'result'].includes(event.type)) throw new Error('Unknown Claude event');
    if (event.type === 'result') {
      if (event.subtype !== 'success' || event.is_error !== false || typeof event.session_id !== 'string' || !sessionId) throw new Error('Claude terminal failed');
      if (event.structured_output !== undefined) {
        if (!event.structured_output || typeof event.structured_output !== 'object' || Array.isArray(event.structured_output)) {
          throw new Error('Malformed Claude structured output');
        }
      } else if (typeof event.result !== 'string' || !event.result.trim()) throw new Error('Missing Claude final output');
      terminal = event;
    }
  }
  if (!terminal) throw new Error('Missing Claude terminal');
  return terminal;
}

export class ClaudeAdapter extends ProviderAdapter {
  observeHealthEvent(event, source, binding) {
    if (source.kind === 'stderr' || !event || typeof event !== 'object') return null;
    if (!healthEventMatchesBinding({ sessionId: event.session_id }, binding)) return null;
    if (source.kind === 'session-log' && (!binding.sessionId || event.session_id !== binding.sessionId)) return null;
    if (event.type === 'system' && event.subtype === 'init') {
      return { kind: 'setup', sessionId: event.session_id };
    }
    // A full assistant message demonstrates accepted model work. Setup and
    // partial token frames alone do not. Completed tools advance progress.
    if (event.type === 'assistant' && event.message?.role === 'assistant') {
      return { kind: 'accepted', key: event.message.id };
    }
    if (event.type === 'user' && Array.isArray(event.message?.content)) {
      const results = event.message.content.filter(part => part.type === 'tool_result' && typeof part.tool_use_id === 'string');
      if (results.some(part => part.is_error === true)) return { kind: 'error', reasonCode: 'tool-failed' };
      if (results.length) return { kind: 'progress', key: results.map(part => part.tool_use_id).sort().join(':') };
    }
    if (event.type === 'stream_event') return { kind: 'activity' };
    if (event.type === 'error') return { ...classifyWorkerHealthFailure(event, { source, provider: 'claude' }), fatal: true };
    if (event.type === 'result') {
      if (event.is_error === true || (typeof event.subtype === 'string' && event.subtype !== 'success')) {
        return { ...classifyWorkerHealthFailure({ type: 'error', message: event.errors?.join(' ') ?? event.result }, { source, provider: 'claude' }), fatal: true };
      }
      if (event.subtype === 'success') return { kind: 'terminal', success: true, key: event.uuid ?? 'result' };
    }
    return null;
  }
  /** Direct workers accept only fixed non-prompting, non-bypass controls.
   * --restricted confines file tools; an external OS sandbox remains required.
   * Commands/code, child agents, customizations and inherited MCP are disabled.
   */
  buildWorkerArgs(invocation, _profile, permissions = {}) {
    const model = invocation?.selected?.model;
    if (typeof model !== 'string' || !model || model.startsWith('-') || model.includes('\0')) {
      throw new Error('Claude worker requires an explicit model');
    }
    if (isClaudeMovingModelPointer(model)) {
      throw new Error('Claude worker requires an exact model identifier, not a moving alias');
    }
    const effort = invocation?.selected?.effort?.value;
    if (!CLAUDE_DIRECT_EFFORT_VALUES.includes(effort)) throw new Error('Claude worker requires an explicit effort');
    const sandbox = permissions.sandbox ?? 'workspace-write';
    if (!Object.hasOwn(FILE_TOOLS, sandbox)) throw new Error('Unavailable Claude sandbox mode');
    if (!['never', 'dontAsk'].includes(permissions.approval ?? 'never')) throw new Error('Claude worker denies prompting or bypass approval modes');
    if (typeof invocation.cwd !== 'string' || !invocation.cwd.startsWith('/') || invocation.cwd.includes('\0')) {
      throw new Error('Claude worker requires an absolute workspace');
    }
    if (typeof invocation.brief !== 'string' || !invocation.brief || invocation.brief.includes('\0')) {
      throw new Error('Claude worker requires a non-empty brief');
    }
    const tools = FILE_TOOLS[sandbox];
    return ['--print', '--input-format', 'text', '--output-format', 'stream-json', '--verbose',
      '--model', model, '--effort', effort, '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
      '--restricted', '--safe-mode', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--tools', tools, '--allowedTools', tools, '--disallowedTools', 'Agent,Task,Bash,PowerShell,REPL,WebFetch',
      '--disable-slash-commands', '--no-chrome', '--no-session-persistence'];
  }

  /** @returns {string} */
  getBinary() {
    return 'claude';
  }

  /** @returns {string} */
  getName() {
    return 'claude';
  }

  /**
   * Claude supports all capabilities.
   * @returns {import('./provider-adapter.mjs').ProviderCapabilities}
   */
  getCapabilities() {
    return {
      streamJson: true,
      sessionResume: true,
      budgetControl: true,
      systemPrompt: true,
      agentMode: true,
      mcpConfig: true,
      maxTurns: true,
    };
  }

  /**
   * Build args for the main headless session (async spawn).
   *
   * Reproduces the exact argument construction from SessionLauncher.buildArgs().
   *
   * @param {import('./provider-adapter.mjs').SessionArgs} options
   * @returns {string[]}
   */
  buildSessionArgs(options) {
    const args = [
      '--permission-mode', 'dontAsk',
      '--permission-prompts', 'none',
      '--print',
      '--output-format', 'stream-json',
      // stream-json always requires --verbose (CLI enforces this)
      '--verbose',
    ];

    // Session tracking
    if (options.resumeSession || options.sessionId) {
      args.push(options.resumeSession ? '--resume' : '--session-id', options.resumeSession || options.sessionId);
    }

    // Model selection (Claude passes through directly)
    if (options.model) {
      args.push('--model', this.mapModel(options.model));
    }

    // Budget control
    if (options.budget) {
      args.push('--max-budget-usd', String(options.budget));
    }

    // Max turns control
    if (options.maxTurns) {
      args.push('--max-turns', String(options.maxTurns));
    }

    // MCP configuration
    if (options.mcpConfig) {
      const configJson = typeof options.mcpConfig === 'string'
        ? options.mcpConfig
        : JSON.stringify(options.mcpConfig);
      args.push('--mcp-config', configJson);
    }

    // System prompt injection
    if (options.systemPrompt) {
      args.push('--append-system-prompt', options.systemPrompt);
    }

    // The prompt itself (must be last)
    args.push(options.prompt);

    return args;
  }

  /**
   * Build args for short analysis calls (spawnSync).
   *
   * Used by OutputAnalyzer, StateAssessor, and ClaudePromptGenerator.
   *
   * @param {import('./provider-adapter.mjs').AnalysisArgs} options
   * @returns {string[]}
   */
  buildAnalysisArgs(options) {
    const args = [
      '--permission-mode', 'dontAsk',
      '--permission-prompts', 'none',
      '--print',
      '--output-format', 'json',
    ];

    // Model selection
    if (options.model) {
      args.push('--model', this.mapModel(options.model));
    }

    // Agent flag (for specialized analysis agents)
    if (options.agent) {
      args.push('--agent', options.agent);
    }

    // The analysis prompt (must be last)
    args.push(options.prompt);

    return args;
  }

  /**
   * Claude model names pass through directly.
   * opus/sonnet/haiku are native Claude model aliases.
   *
   * @param {string} genericModel
   * @returns {string}
   */
  mapModel(genericModel) {
    // Claude accepts opus, sonnet, haiku natively
    return genericModel;
  }

  /**
   * Environment overrides for headless Claude sessions.
   * @returns {Object<string, string>}
   */
  getEnvOverrides() {
    const overrides = {
      CI: 'true',
    };
    if (process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT === undefined) {
      overrides.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1';
    }
    return overrides;
  }

  /**
   * Get Claude session transcript path.
   *
   * Claude stores transcripts at:
   *   ~/.claude/projects/{encoded-path}/{session-id}.jsonl
   *
   * Path encoding: Replace `/` with `-`, prepend `-`
   * Example: /foo/bar → -foo-bar
   *
   * @param {string} sessionId
   * @param {string} workingDir
   * @returns {string}
   */
  getTranscriptPath(sessionId, workingDir) {
    const encodedPath = workingDir.replace(/\//g, '-');
    return join(
      homedir(),
      '.claude',
      'projects',
      encodedPath,
      `${sessionId}.jsonl`
    );
  }
}

/** Direct candidate extraction is separate from legacy regex analysis parsing.
 * Only the direct worker profile enforces Claude's real stream-json terminal
 * shape (subtype/is_error/session_id). Legacy `claude` callers, including
 * Ralph's existing analysis/session paths and the generic cross-provider
 * worker-finals contract, keep the shared, provider-agnostic strict parser
 * inherited from ProviderAdapter.
 */
export class ClaudeDirectAdapter extends ClaudeAdapter {
  getName() { return 'claude-direct'; }

  async parseWorkerFinal(output, options = {}) {
    // MCP envelopes retain the shared strict parser. Every other input must be
    // Claude's own stream-json transcript with a validated terminal result: the
    // direct worker never writes a separate final file, so a bare claims
    // document (e.g. a worker-written final file handed over as 'json') is
    // rejected instead of bypassing terminal validation.
    if (options.format === 'mcp') return super.parseWorkerFinal(output, options);
    const terminal = parseClaudeTerminal(output, options.maxOutputBytes);
    const final = terminal.structured_output === undefined ? terminal.result : JSON.stringify(terminal.structured_output);
    return super.parseWorkerFinal(final, { ...options, format: 'json' });
  }

  /** Synchronous candidate extraction for the installed driver's existing hook.
   * Strict completion always reparses original bytes via parseWorkerFinal.
   * Single normalized claims files also pass through this hook.
   */
  parseOutput(stdout) {
    try {
      const text = String(stdout).trim();
      if (!text.includes('\n')) {
        const value = strictEvent(text);
        if (value && typeof value === 'object' && !Array.isArray(value) && value.type === undefined) return value;
      }
      const terminal = parseClaudeTerminal(stdout);
      if (terminal.structured_output !== undefined) return terminal.structured_output;
      try {
        const claims = strictEvent(terminal.result);
        if (claims && typeof claims === 'object' && !Array.isArray(claims)) return claims;
      } catch { /* Legacy analysis results may contain plain text. */ }
      return terminal;
    } catch { return null; }
  }
}

// Legacy imports register in Ralph under claude; installed workers use the
// distinct claude-direct factory so either load order is safe. Digest-addressed
// imports register only through the loader's approved factory.
if (!new URL(import.meta.url).searchParams.has('sha256')) {
  registerProvider('claude', () => new ClaudeAdapter());
}

export function register(factory) {
  factory('claude-direct', () => new ClaudeDirectAdapter());
}

export default ClaudeAdapter;
