/** Grok Build ACP stdio client. Separate from one-shot headless execution. */
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
    this.env = options.env ?? process.env;
    this.cwd = options.cwd;
    this.timeoutMs = Math.min(Math.max(options.timeoutMs ?? 30_000, 1), 120_000);
    this.maxStderrBytes = options.maxStderrBytes ?? 1024 * 1024;
    this.onUpdate = options.onUpdate;
    this.child = spawn(options.command ?? 'grok', [...(options.prefixArgs ?? []), '--no-auto-update', 'agent', 'stdio'], {
      cwd: options.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    this.child.on('error', error => this.failAll(new Error(`Grok ACP launch failed: ${error.message}`)));
    this.child.on('close', code => this.failAll(new Error(`Grok ACP closed (exit ${code ?? 'signal'})`)));
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk.toString('utf8')));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrBuffer += chunk.toString('utf8');
      if (Buffer.byteLength(this.stderrBuffer) > this.maxStderrBytes) {
        this.failAll(new Error('Grok ACP stderr limit exceeded'));
        this.close();
      }
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
    this.stdoutBuffer += chunk;
    if (this.stdoutBuffer.length > 8 * 1024 * 1024) {
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
      try { message = JSON.parse(line) as Record<string, unknown>; }
      catch { this.failAll(new Error('Invalid Grok ACP JSON-RPC message')); this.close(); return; }
      if (message.method === 'session/update') {
        const params = message.params as Record<string, unknown> | undefined;
        const update = params?.update as Record<string, unknown> | undefined;
        if (update) {
          const safe = JSON.parse(redactGrokOutput(JSON.stringify(update), this.env)) as Record<string, unknown>;
          const content = safe.content as Record<string, unknown> | undefined;
          if (safe.sessionUpdate === 'agent_message_chunk' && typeof content?.text === 'string') this.text += content.text;
          this.onUpdate?.(safe);
        }
        continue;
      }
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
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    });
    const methods = Array.isArray(init.authMethods)
      ? init.authMethods.map(item => (item as Record<string, unknown>).id) : [];
    const authMethod = this.env.XAI_API_KEY && methods.includes('xai.api_key') ? 'xai.api_key'
      : methods.includes('cached_token') ? 'cached_token' : null;
    if (!authMethod) throw new Error('Grok ACP authentication unavailable; run grok login or set XAI_API_KEY');
    await this.request('authenticate', { methodId: authMethod, _meta: { headless: true } });
    const session = await this.request('session/new', { cwd: this.cwd, mcpServers: [] });
    if (typeof session.sessionId !== 'string' || !session.sessionId) throw new Error('Grok ACP session/new returned no sessionId');
    this.sessionId = session.sessionId;
    return { authMethod, sessionId: session.sessionId };
  }

  async prompt(prompt: string, signal?: AbortSignal): Promise<{ text: string; stopReason?: string }> {
    if (!this.sessionId) throw new Error('Grok ACP session is not initialized');
    if (!prompt.trim()) throw new Error('Grok ACP prompt is required');
    this.text = '';
    const onAbort = (): void => { this.cancel(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
      const result = await this.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text: prompt }] });
      // Grok can deliver final session/update chunks immediately after the
      // completion response; give the pipe a bounded settling window.
      await new Promise(resolve => setTimeout(resolve, 150));
      return { text: this.text.trim(), ...(typeof result.stopReason === 'string' ? { stopReason: result.stopReason } : {}) };
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
    this.child.kill('SIGTERM');
  }
}
