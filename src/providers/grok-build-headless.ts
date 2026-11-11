/** Bounded Grok Build headless transport. The caller owns task authorization. */
import { signalChild } from '../process/signal-child.mjs';
import { spawn } from 'node:child_process';

export type GrokOutputFormat = 'plain' | 'json' | 'streaming-json' | 'streaming-messages-json';
export interface GrokHeadlessOptions {
  prompt: string;
  cwd: string;
  format?: GrokOutputFormat;
  command?: string;
  /** Test-only launcher prefix; production always invokes grok directly. */
  prefixArgs?: string[];
  /** Use the released CLI's explicit switch for AIWG-controlled leaf workers. */
  disableSubagents?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onEvent?: (event: Record<string, unknown>) => void;
}
export interface GrokHeadlessResult {
  format: GrokOutputFormat;
  /** Redacted raw stdout, retained for existing transport consumers. */
  text: string;
  events: Record<string, unknown>[];
  exitCode: number;
  stderr: string;
  stopReason?: string;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
  num_turns?: number;
  total_cost_usd?: number;
  total_cost_usd_ticks?: number;
}

/** Failed runs retain redacted partial output and observed accounting. */
export class GrokHeadlessError extends Error {
  constructor(message: string, readonly result: GrokHeadlessResult) {
    super(message);
    this.name = 'GrokHeadlessError';
  }
}

const MAX_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;
// Captured 1.0.77 headless events; this is not the agent-stdio ACP contract.
const STREAM_EVENT_TYPES = new Set(['text', 'thought', 'tool_call', 'tool_call_update',
  'usage', 'plan', 'available_commands', 'end', 'error']);
const MESSAGE_EVENT_TYPES = new Set(['system', 'assistant', 'user', 'result', 'error']);

export function redactGrokOutput(value: string, env: NodeJS.ProcessEnv = process.env): string {
  let redacted = value
    .replace(/("(?:api[_-]?key|access[_-]?token|authorization)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, '$1[REDACTED]')
    .replace(/\b(xai-[A-Za-z0-9_-]{8,})\b/g, '[REDACTED]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|authorization)\s*[:=]\s*)[^\s,}"']+/gi, '$1[REDACTED]');
  for (const key of ['XAI_API_KEY', 'GROK_CODE_XAI_API_KEY']) {
    const secret = env[key];
    if (secret && secret.length >= 4) {
      redacted = redacted.split(secret).join('[REDACTED]');
      redacted = redacted.split(JSON.stringify(secret).slice(1, -1)).join('[REDACTED]');
    }
  }
  return redacted;
}

function scrub(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') return redactGrokOutput(value, env);
  if (Array.isArray(value)) return value.map(item => scrub(item, env));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactGrokOutput(key, env),
      /^(?:api[_-]?key|access[_-]?token|authorization)$/i.test(key) ? '[REDACTED]' : scrub(item, env)]));
  }
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isError(event: Record<string, unknown>): boolean {
  return event.type === 'error' || event.is_error === true || event.error != null
    || (Array.isArray(event.errors) && event.errors.length > 0)
    || (event.type === 'result' && event.subtype !== 'success')
    || (['tool_call', 'tool_call_update'].includes(String(event.type)) && event.status === 'failed');
}

function signalProcess(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (Number.isSafeInteger(child.pid) && child.pid! > 0 && process.platform !== 'win32') {
    try { process.kill(-child.pid!, signal); return; } catch { /* process already exited */ }
  }
  signalChild(child, signal);
}

export async function runGrokHeadless(options: GrokHeadlessOptions): Promise<GrokHeadlessResult> {
  if (!options.prompt.trim()) throw new Error('Grok Build prompt is required');
  const format = options.format ?? 'streaming-json';
  if (!['plain', 'json', 'streaming-json', 'streaming-messages-json'].includes(format)) throw new Error(`Unsupported Grok output format: ${format}`);
  for (const key of ['timeoutMs', 'maxOutputBytes'] as const) {
    if (options[key] !== undefined && (!Number.isFinite(options[key]) || options[key]! <= 0)) {
      throw new Error(`Grok Build ${key} must be a positive finite number`);
    }
  }
  const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxBytes = Math.min(Math.max(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT, 1024), DEFAULT_MAX_OUTPUT);
  const env = options.env ?? process.env;
  // 1.0.77: workflow can spawn children even when spawn_subagent is disabled.
  const args = [...(options.prefixArgs ?? []), '--no-auto-update', '--allow', 'Bash(aiwg discover *)', ...(options.disableSubagents ? ['--no-subagents', '--disallowed-tools', 'workflow'] : []), '-p', options.prompt, '--output-format', format];
  const streaming = format === 'streaming-json' || format === 'streaming-messages-json';
  return new Promise((resolve, reject) => {
    const child = spawn(options.command ?? 'grok', args, {
      cwd: options.cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', shell: false,
    });
    // Stateful decoders preserve code points split across pipe reads.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let pending = '';
    let bytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let closed = false;
    let exitCode: number | undefined;
    let exitSignal: string | null = null;
    let terminalSeen = false;
    let terminalError = false;
    const events: Record<string, unknown>[] = [];
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, code = exitCode ?? 0): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      options.signal?.removeEventListener('abort', abort);
      if (format === 'json') {
        try {
          const parsed: unknown = JSON.parse(stdout);
          if (!record(parsed) || typeof parsed.text !== 'string') throw new Error('Invalid result');
          const safe = scrub(parsed, env) as Record<string, unknown>;
          events.push(safe);
          if (isError(safe) || safe.stopReason !== 'end_turn') error ??= new Error('Grok Build returned a JSON error result');
        } catch { error ??= new Error('Invalid Grok Build JSON error result'); }
      }
      if (code !== 0 || exitSignal || terminalError) {
        error ??= new Error(`Grok Build headless failed (exit ${code}${exitSignal ? `, signal ${exitSignal}` : ''}): ${stderr || 'provider error event'}`);
      }
      if (streaming && !terminalSeen) error ??= new Error(`Grok Build ${format} ended without a terminal event`);
      const result: GrokHeadlessResult = { format, text: redactGrokOutput(stdout, env), events,
        exitCode: code, stderr: redactGrokOutput(stderr, env) };
      // Terminal totals supersede per-turn usage; never sum cumulative frames.
      for (const event of events) {
        const reason = event.stopReason ?? event.stop_reason;
        if (typeof reason === 'string') result.stopReason = reason;
        for (const key of ['usage', 'modelUsage'] as const) {
          const value = event[key] ?? (key === 'usage' && record(event.message) ? event.message.usage : undefined);
          if (record(value)) result[key] = value;
        }
        for (const key of ['num_turns', 'total_cost_usd', 'total_cost_usd_ticks'] as const) {
          if (typeof event[key] === 'number' && Number.isFinite(event[key])) result[key] = event[key];
        }
      }
      const complete = (): void => {
        if (error) reject(new GrokHeadlessError(redactGrokOutput(error.message, env), result));
        else resolve(result);
      };
      if (closed) { complete(); return; }
      // Bound cleanup even for a child ignoring TERM or descendants holding pipes.
      signalProcess(child, 'SIGTERM');
      setTimeout(() => {
        signalProcess(child, 'SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
        complete();
      }, 150);
    };
    const abort = (): void => finish(new Error('Grok Build headless aborted'), 1);
    const timer = setTimeout(() => finish(new Error(`Grok Build headless timed out after ${timeoutMs}ms`), 1), timeoutMs);
    const drain = (): void => {
      drainTimer ??= setTimeout(() => {
        if (streaming && pending.trim()) { finish(new Error(`Invalid trailing Grok Build ${format} event`)); return; }
        finish();
      }, 300);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.on('error', error => finish(new Error(`Grok Build headless launch failed: ${error.message}`), 1));
    const acceptEvent = (event: unknown): void => {
      if (settled) return;
      const types = format === 'streaming-messages-json' ? MESSAGE_EVENT_TYPES : STREAM_EVENT_TYPES;
      if (!record(event) || typeof event.type !== 'string' || !types.has(event.type)) {
        finish(new Error(`Invalid Grok Build ${format} event`)); return;
      }
      if (terminalSeen) { finish(new Error('Grok Build event after terminal event')); return; }
      if (['assistant', 'user'].includes(event.type) && (!record(event.message) || !Array.isArray(event.message.content))) {
        finish(new Error('Invalid Grok Build message envelope')); return;
      }
      const safe = scrub(event, env) as Record<string, unknown>;
      events.push(safe);
      const terminal = event.type === 'error' || event.type === (format === 'streaming-messages-json' ? 'result' : 'end');
      if (isError(safe) || (terminal && (safe.stopReason ?? safe.stop_reason) !== 'end_turn')) terminalError = true;
      if (terminal) { terminalSeen = true; drain(); }
      try { options.onEvent?.(safe); }
      catch (cause) { finish(new Error(`Grok Build event callback failed: ${cause instanceof Error ? cause.message : String(cause)}`)); }
    };
    child.stdout.on('data', (part: string) => {
      if (settled) return;
      bytes += Buffer.byteLength(part);
      if (bytes > maxBytes) { finish(new Error(`Grok Build headless output exceeded ${maxBytes} bytes`)); return; }
      stdout += part;
      if (format === 'json') {
        // A complete result can arrive without a newline or process exit.
        try { if (record(JSON.parse(stdout))) drain(); } catch { /* wait for the remainder */ }
      }
      if (!streaming) return;
      pending += part;
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end).trim();
        pending = pending.slice(end + 1);
        if (!line) continue;
        let event: unknown;
        try { event = JSON.parse(line); }
        catch { finish(new Error(`Invalid Grok Build ${format} event`)); return; }
        acceptEvent(event);
        if (settled) return;
      }
      // Parse complete newline-free frames now so background work cannot hold us.
      if (pending.trim()) {
        let event: unknown;
        try { event = JSON.parse(pending); } catch { return; }
        pending = '';
        acceptEvent(event);
      }
    });
    child.stderr.on('data', (part: string) => {
      if (settled) return;
      stderrBytes += Buffer.byteLength(part);
      if (stderrBytes > maxBytes) { finish(new Error(`Grok Build stderr exceeded ${maxBytes} bytes`)); return; }
      stderr += part;
    });
    child.on('exit', (code, signal) => { exitCode = code ?? 1; exitSignal = signal; });
    child.on('close', code => {
      closed = true;
      if (settled) return;
      if (streaming && pending.trim()) {
        const line = pending;
        pending = '';
        try { acceptEvent(JSON.parse(line)); }
        catch { finish(new Error(`Invalid trailing Grok Build ${format} event`)); return; }
      }
      finish(undefined, code ?? 1);
    });
  });
}
