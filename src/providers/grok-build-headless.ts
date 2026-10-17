/** Bounded Grok Build headless transport. The caller owns task authorization. */
import { signalChild } from '../process/signal-child.mjs';
import { spawn } from 'node:child_process';

export type GrokOutputFormat = 'plain' | 'json' | 'streaming-json';
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
  text: string;
  events: Record<string, unknown>[];
  exitCode: number;
  stderr: string;
}

const MAX_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;
// grok 1.0.50 --output-format streaming-json: ACP session updates.
// See docs/providers/grok-build-cli-evidence.md; json is a separate result object.
const STREAM_EVENT_TYPES = new Set(['text', 'thought', 'tool_call', 'tool_call_update',
  'usage', 'plan', 'available_commands', 'end', 'error']);

export function redactGrokOutput(value: string, env: NodeJS.ProcessEnv = process.env): string {
  let redacted = value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, '$1[REDACTED]')
    .replace(/\b(xai-[A-Za-z0-9_-]{8,})\b/g, '[REDACTED]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|authorization)\s*[:=]\s*)[^\s,}"']+/gi, '$1[REDACTED]');
  for (const key of ['XAI_API_KEY', 'GROK_CODE_XAI_API_KEY']) {
    const secret = env[key];
    if (secret && secret.length >= 4) redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}

function scrubEvent(event: Record<string, unknown>, env: NodeJS.ProcessEnv): Record<string, unknown> {
  // JSON roundtrip scrubs nested provider event payloads before any callback.
  return JSON.parse(redactGrokOutput(JSON.stringify(event), env)) as Record<string, unknown>;
}

function isTerminal(event: Record<string, unknown>): boolean {
  return event.type === 'end' || event.type === 'error';
}

function isError(event: Record<string, unknown>): boolean {
  return event.type === 'error' || event.is_error === true || event.error != null
    || (event.type === 'end' && event.stopReason !== 'end_turn')
    || (['tool_call', 'tool_call_update'].includes(String(event.type)) && event.status === 'failed');
}

function stopProcess(child: ReturnType<typeof spawn>): void {
  if (Number.isSafeInteger(child.pid) && child.pid! > 0 && process.platform !== 'win32') {
    try { process.kill(-child.pid!, 'SIGTERM'); return; } catch { /* process already exited */ }
  }
  signalChild(child, 'SIGTERM');
}

export async function runGrokHeadless(options: GrokHeadlessOptions): Promise<GrokHeadlessResult> {
  if (!options.prompt.trim()) throw new Error('Grok Build prompt is required');
  const format = options.format ?? 'streaming-json';
  if (!['plain', 'json', 'streaming-json'].includes(format)) throw new Error(`Unsupported Grok output format: ${format}`);
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1), MAX_TIMEOUT_MS);
  const maxBytes = Math.min(Math.max(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT, 1024), DEFAULT_MAX_OUTPUT);
  const env = options.env ?? process.env;
  const args = [...(options.prefixArgs ?? []), ...(options.disableSubagents ? ['--no-subagents'] : []), '-p', options.prompt, '--output-format', format];
  return new Promise((resolve, reject) => {
    const child = spawn(options.command ?? 'grok', args, {
      cwd: options.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let pending = '';
    let bytes = 0;
    let settled = false;
    let terminalSeen = false;
    let terminalError = false;
    const events: Record<string, unknown>[] = [];
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, code = 0): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      options.signal?.removeEventListener('abort', abort);
      if (error) { stopProcess(child); reject(error); return; }
      const cleanStdout = redactGrokOutput(stdout, env);
      const cleanStderr = redactGrokOutput(stderr, env);
      if (code !== 0 || terminalError) {
        reject(new Error(`Grok Build headless failed (exit ${code}): ${cleanStderr || 'provider error event'}`));
        return;
      }
      if (format === 'streaming-json' && !terminalSeen) {
        reject(new Error('Grok Build streaming-json ended without a terminal event'));
        return;
      }
      if (format === 'json') {
        try {
          const parsed = JSON.parse(cleanStdout) as Record<string, unknown>;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
            || typeof parsed.text !== 'string' || isError(parsed)
            || parsed.stopReason !== 'end_turn') throw new Error('Grok Build returned a JSON error result');
          events.push(parsed);
        } catch (cause) {
          reject(cause instanceof Error ? cause : new Error('Invalid Grok Build JSON result'));
          return;
        }
      }
      resolve({ format, text: cleanStdout, events, exitCode: code, stderr: cleanStderr });
    };
    const abort = (): void => finish(new Error('Grok Build headless aborted'));
    const timer = setTimeout(() => finish(new Error(`Grok Build headless timed out after ${timeoutMs}ms`)), timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.on('error', error => finish(new Error(`Grok Build headless launch failed: ${error.message}`)));
    const acceptEvent = (event: Record<string, unknown>): void => {
      if (settled) return;
      if (!event || typeof event !== 'object' || Array.isArray(event)
        || typeof event.type !== 'string' || !STREAM_EVENT_TYPES.has(event.type)) {
        finish(new Error('Invalid Grok Build streaming-json event')); return;
      }
      // ACP end is always last. Failure is latched across the whole stream.
      if (terminalSeen) { finish(new Error('Grok Build event after terminal event')); return; }
      const safe = scrubEvent(event, env);
      events.push(safe);
      options.onEvent?.(safe);
      if (isError(safe)) terminalError = true;
      if (isTerminal(safe)) {
        terminalSeen = true;
        // Some builds leave background work attached after end. Allow a
        // short drain, then terminate the process group.
        drainTimer ??= setTimeout(() => {
          if (pending.trim()) { finish(new Error('Invalid trailing Grok Build streaming-json event')); return; }
          stopProcess(child); finish(undefined, terminalError ? 1 : 0);
        }, 300);
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) { finish(new Error(`Grok Build headless output exceeded ${maxBytes} bytes`)); return; }
      const part = chunk.toString('utf8');
      stdout += part;
      if (format !== 'streaming-json') return;
      pending += part;
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end).trim();
        pending = pending.slice(end + 1);
        if (!line) continue;
        let event: Record<string, unknown>;
        try { event = JSON.parse(line) as Record<string, unknown>; }
        catch { finish(new Error('Invalid Grok Build streaming-json event')); return; }
        acceptEvent(event);
        if (settled) return;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (Buffer.byteLength(stderr) > maxBytes) finish(new Error(`Grok Build stderr exceeded ${maxBytes} bytes`));
    });
    child.on('close', code => {
      if (format === 'streaming-json' && pending.trim()) {
        try {
          acceptEvent(JSON.parse(pending) as Record<string, unknown>);
        } catch { finish(new Error('Invalid trailing Grok Build streaming-json event')); return; }
      }
      finish(undefined, code ?? 1);
    });
  });
}
