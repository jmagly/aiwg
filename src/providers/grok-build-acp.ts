/** Grok Build ACP stdio client. Separate from one-shot headless execution. */
import { signalChild } from '../process/signal-child.mjs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { redactGrokOutput } from './grok-build-headless.js';

export interface GrokAcpOptions {
  cwd: string;
  command?: string;
  /** Test-only prefix before Grok's fixed ACP argv. */
  prefixArgs?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxStderrBytes?: number;
  onUpdate?: (update: Record<string, unknown>) => void;
  /** @deprecated Accepted for compatibility; AIWG always prohibits native fan-out. */
  disableSubagents?: boolean;
  /** Called when the child process has actually exited. */
  onExit?: () => void | Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export class GrokAcpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly maxStderrBytes: number;
  private readonly cwd: string;
  private readonly onUpdate?: (update: Record<string, unknown>) => void;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private closed = false;
  private terminated = false;
  private sessionId?: string;
  private text = '';

  constructor(options: GrokAcpOptions) {
    for (const key of ['timeoutMs', 'maxStderrBytes'] as const) {
      if (options[key] !== undefined && (!Number.isFinite(options[key]) || options[key]! <= 0)) {
        throw new Error(`Grok ACP ${key} must be a positive finite number`);
      }
    }
    this.env = options.env ?? process.env;
    this.cwd = options.cwd;
    this.timeoutMs = Math.min(Math.max(options.timeoutMs ?? 30_000, 1), 120_000);
    this.maxStderrBytes = Math.min(options.maxStderrBytes ?? 1024 * 1024, 8 * 1024 * 1024);
    this.onUpdate = options.onUpdate;
    this.child = spawn(options.command ?? 'grok', [...(options.prefixArgs ?? []), '--no-auto-update', '--allow', 'Bash(aiwg discover *)', '--no-subagents', '--disallowed-tools', 'workflow,scheduler_create,scheduler_list,scheduler_delete', 'agent', 'stdio'], {
      cwd: options.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    this.child.on('error', error => this.failAll(new Error(`Grok ACP launch failed: ${error.message}`)));
    this.child.on('close', code => {
      this.failAll(new Error(`Grok ACP closed (exit ${code ?? 'signal'})`));
      void options.onExit?.();
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.receive(chunk));
    this.child.stderr.on('data', (chunk: string) => {
      if (this.closed) return;
      if (Buffer.byteLength(this.stderrBuffer) + Buffer.byteLength(chunk) > this.maxStderrBytes) {
        this.failAll(new Error('Grok ACP stderr limit exceeded'));
        this.close();
        return;
      }
      this.stderrBuffer += chunk;
    });
  }

  get stderr(): string { return redactGrokOutput(this.stderrBuffer, this.env); }

  private failAll(error: Error): void {
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private receive(chunk: string): void {
    if (this.closed) return;
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer) > 8 * 1024 * 1024) {
      this.failAll(new Error('Grok ACP stdout limit exceeded'));
      this.close();
      return;
    }
    let end: number;
    while ((end = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, end).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(end + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isRecord(parsed)) throw new Error('Invalid frame');
        message = parsed;
      }
      catch { this.failAll(new Error('Invalid Grok ACP JSON-RPC message')); this.close(); return; }
      if (message.method === 'session/update' || message.method === '_x.ai/session_notification') {
        const params = isRecord(message.params) ? message.params : undefined;
        if (this.sessionId && params?.sessionId !== undefined && params.sessionId !== this.sessionId) continue;
        const update = params?.update;
        if (isRecord(update)) {
          const safe = JSON.parse(redactGrokOutput(JSON.stringify(update), this.env)) as Record<string, unknown>;
          const content = safe.content as Record<string, unknown> | undefined;
          if (safe.sessionUpdate === 'agent_message_chunk' && typeof content?.text === 'string') this.text += content.text;
          try { this.onUpdate?.(safe); }
          catch (cause) {
            const detail = cause instanceof Error ? cause.message : String(cause);
            this.failAll(new Error(`Grok ACP update callback failed: ${redactGrokOutput(detail, this.env)}`));
            this.close();
            return;
          }
        }
        continue;
      }
      if (typeof message.method === 'string') continue;
      const id = message.id;
      if (typeof id !== 'number') continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      const error = message.error as Record<string, unknown> | undefined;
      if (error) pending.reject(new Error(`Grok ACP request failed: ${redactGrokOutput(String(error.message ?? 'provider error'), this.env)}`));
      else pending.resolve((message.result && typeof message.result === 'object' ? message.result : {}) as Record<string, unknown>);
    }
  }

  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error('Grok ACP connection is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Grok ACP ${method} timed out`));
        this.close();
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error(`Grok ACP ${method} write failed`));
        }
      });
    });
  }

  async initialize(): Promise<{ authMethod: string; sessionId: string }> {
    const init = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const methods = Array.isArray(init.authMethods)
      ? init.authMethods.map(item => (item as Record<string, unknown>).id) : [];
    const authMethod = this.env.XAI_API_KEY && methods.includes('xai.api_key') ? 'xai.api_key'
      : methods.includes('cached_token') ? 'cached_token' : null;
    if (!authMethod) {
      const reason = methods.includes('grok.com')
        ? 'grok.com interactive authentication is not qualified for AIWG ACP'
        : 'no supported non-interactive method was offered';
      throw new Error(`Grok ACP authentication unavailable: ${reason}`);
    }
    // Captured 1.0.77 advertises the active cached login in initialize; it
    // proceeds straight to session/new without an authenticate round trip.
    const meta = init._meta as Record<string, unknown> | undefined;
    if (authMethod !== 'cached_token' || meta?.defaultAuthMethodId !== 'cached_token') {
      await this.request('authenticate', { methodId: authMethod, _meta: { headless: true } });
    }
    const session = await this.request('session/new', { cwd: this.cwd, mcpServers: [] });
    if (typeof session.sessionId !== 'string' || !session.sessionId) throw new Error('Grok ACP session/new returned no sessionId');
    this.sessionId = session.sessionId;
    return { authMethod, sessionId: session.sessionId };
  }

  async prompt(prompt: string, signal?: AbortSignal): Promise<{ text: string; stopReason?: string; _meta?: Record<string, unknown> }> {
    if (!this.sessionId) throw new Error('Grok ACP session is not initialized');
    if (!prompt.trim()) throw new Error('Grok ACP prompt is required');
    const aborted = (): Error => Object.assign(new Error('Grok ACP prompt aborted'), { name: 'AbortError' });
    // A pre-aborted request never starts a provider turn, so there is nothing
    // to cancel. Sending session/cancel here could cancel an unrelated turn.
    if (signal?.aborted) throw aborted();
    this.text = '';
    let abortRequested = false;
    const onAbort = (): void => { abortRequested = true; this.cancel(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await this.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text: prompt }] });
      // Grok can deliver final session/update chunks immediately after the
      // completion response; give the pipe a bounded settling window.
      await new Promise(resolve => setTimeout(resolve, 150));
      if (abortRequested || signal?.aborted) throw aborted();
      const meta = result._meta && typeof result._meta === 'object' && !Array.isArray(result._meta)
        ? JSON.parse(redactGrokOutput(JSON.stringify(result._meta), this.env)) as Record<string, unknown> : undefined;
      return { text: this.text.trim(), ...(typeof result.stopReason === 'string' ? { stopReason: result.stopReason } : {}),
        ...(meta ? { _meta: meta } : {}) };
    } catch (error) {
      if (abortRequested || signal?.aborted) throw aborted();
      throw error;
    } finally { signal?.removeEventListener('abort', onAbort); }
  }

  cancel(): void {
    if (this.closed || !this.sessionId) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.sessionId } })}\n`);
  }

  close(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.failAll(new Error('Grok ACP connection closed'));
    this.child.stdin.end();
    if (!signalChild(this.child, 'SIGTERM')) return;
    const forceTimer = setTimeout(() => signalChild(this.child, 'SIGKILL'), 2_000);
    forceTimer.unref();
    this.child.once('close', () => clearTimeout(forceTimer));
  }
}
