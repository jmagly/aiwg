import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { importImpl } from '../_resolve-impl.mjs';
const { signalChild } = await importImpl(import.meta.url, 'process/signal-child.mjs');

const { positiveTimeoutMs } = await importImpl(import.meta.url, 'process/bounded-child-process.mjs');

/** Preserve process identity and state: zombies still fail the cleanup gate. */
export async function inspectOmpProcess({ pid, startTime }) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { pid, present: false };
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { pid, state: fields[0], parentPid: Number(fields[1]), processGroup: Number(fields[2]), startTime: fields[19], present: !startTime || startTime === fields[19], identityChanged: Boolean(startTime && startTime !== fields[19]) };
  } catch (error) {
    if (process.platform === 'linux' && error.code === 'ENOENT') return { pid, present: false };
    try { process.kill(pid, 0); return { pid, present: true, state: 'unknown' }; }
    catch (probe) { return { pid, present: probe.code !== 'ESRCH', state: probe.code === 'ESRCH' ? undefined : 'unknown' }; }
  }
}

export async function waitForOmpProcessCleanup(processes, { timeoutMs = 3000 } = {}) {
  const started = Date.now();
  const initial = await Promise.all(processes.map(inspectOmpProcess));
  let final = initial;
  while (final.some(item => item.present) && Date.now() - started < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, timeoutMs - (Date.now() - started)))));
    final = await Promise.all(processes.map(inspectOmpProcess));
  }
  return { initial, final, elapsedMs: Date.now() - started, complete: final.every(item => !item.present) };
}


export const MAX_FRAME = 1024 * 1024;
export const MAX_MESSAGE = 64 * MAX_FRAME;
function parseFrameJson(text) { try { return JSON.parse(text); } catch { throw new Error('Malformed OMP JSON frame'); } }
/** Bounded physical JSONL frames and ordered OMP v2 chunk reassembly. */
export class OmpFrameDecoder {
  constructor({ frameLimit = MAX_FRAME, messageLimit = MAX_MESSAGE } = {}) {
    this.frameLimit = frameLimit; this.messageLimit = messageLimit; this.buffer = Buffer.alloc(0); this.pending = null;
  }
  push(chunk) {
    const frames = [];
    // Split incoming data before buffering to keep individual frame allocations bounded.
    for (const part of Buffer.from(chunk).toString('binary').split('\n').entries()) {
      const [index, value] = part;
      if (index) { if (this.buffer.length) { const frame = this.decode(parseFrameJson(new TextDecoder('utf-8', { fatal: true }).decode(this.buffer))); if (frame) frames.push(frame); } this.buffer = Buffer.alloc(0); }
      const bytes = Buffer.from(value, 'binary');
      if (this.buffer.length + bytes.length + 1 > this.frameLimit) throw new Error('OMP physical frame limit exceeded');
      this.buffer = Buffer.concat([this.buffer, bytes]);
    }
    return frames;
  }
  decode(frame) {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('OMP frame must be an object');
    if (frame.type !== 'rpc_chunk') { if (this.pending) throw new Error('OMP chunk sequence interrupted'); return frame; }
    const { chunkId, count, index, byteLength, data } = frame;
    if (typeof chunkId !== 'string' || !chunkId || chunkId.length > 128 || !Number.isSafeInteger(count) || count < 2 || count > 256 || !Number.isSafeInteger(index) || index < 0 || index >= count || !Number.isSafeInteger(byteLength) || byteLength < MAX_FRAME || byteLength > this.messageLimit || typeof data !== 'string' || !data || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error('Invalid OMP chunk metadata');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.toString('base64') !== data || bytes.length > 256 * 1024) throw new Error('Invalid OMP chunk payload');
    if (!this.pending) this.pending = { chunkId, count, byteLength, next: 0, size: 0, parts: [] };
    const p = this.pending;
    if (p.chunkId !== chunkId || p.count !== count || p.byteLength !== byteLength || p.next !== index) throw new Error('OMP chunk sequence mismatch');
    p.size += bytes.length; p.next++; p.parts.push(bytes);
    if (p.size > byteLength) throw new Error('OMP chunk declared size exceeded');
    if (p.next < count) return;
    if (p.size !== byteLength) throw new Error('OMP chunk size mismatch');
    this.pending = null;
    const result = parseFrameJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(p.parts)));
    if (!result || typeof result !== 'object' || Array.isArray(result) || result.type === 'rpc_chunk') throw new Error('Invalid OMP logical frame');
    return result;
  }
  end() { if (this.buffer.length || this.pending) throw new Error('Truncated OMP JSONL output'); }
}

export function summarizeOmpEvents(events, { exitCode = 0 } = {}) {
  let terminal = false, failed = false, aborted = false, assistant = null, elided = false;
  for (const event of events) {
    if (/elided for RPC frame|rpcFrameElidedKeys/.test(JSON.stringify(event))) elided = true;
    if (event.type === 'agent_start' || (event.type === 'agent_end' && event.willContinue === true)) terminal = false;
    if (event.type === 'agent_end' && event.willContinue !== true) terminal = true;
    if (event.type === 'rpc_frame_error' || event.type === 'error' || (event.type === 'tool_execution_end' && event.isError)) failed = true;
    for (const message of [...(event.messages ?? []), ...(event.message ? [event.message] : [])]) {
      if (message.role === 'assistant') assistant = message;
      if (message.stopReason === 'error') failed = true;
      if (message.stopReason === 'aborted') aborted = true;
    }
  }
  const text = (assistant?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  return { events, settled: terminal, success: terminal && Boolean(assistant) && !failed && !aborted && !elided && exitCode === 0, failed, aborted, elided, text };
}

/** Owns one native RPC process. Commands correlate by id; prompt ack is never completion. */
export class OmpRpcClient {
  // `readyTimeoutMs` bounds only the initial RPC-readiness wait; `timeoutMs` keeps bounding every
  // command and prompt after that, so widening the first-start budget (#2999) never also widens
  // this client's ordinary command/prompt deadlines.
  constructor({ binary = process.env.AIWG_OMP_BIN || 'omp', args = [], cwd, env = process.env, timeoutMs = 30000, readyTimeoutMs = timeoutMs,
    eventLimit = 16 * MAX_FRAME, closeGraceMs = 5000 } = {}) {
    this.closeGraceMs = closeGraceMs; this.timeoutMs = timeoutMs; this.events = []; this.eventBytes = 0; this.eventLimit = eventLimit; this.pending = new Map(); this.counter = 0; this.protocolVersion = 1;
    this.child = spawn(binary, ['--mode', 'rpc', ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    this.decoder = new OmpFrameDecoder(); this.stderr = '';
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.ready.catch(() => {});
    this.readyTimer = setTimeout(() => this.fail(new Error('OMP RPC ready timeout')), readyTimeoutMs);
    this.closed = new Promise(resolve => this.child.once('close', (code) => { this.isClosed = true; try { this.decoder.end(); } catch (e) { this.fail(e); } this.fail(new Error(`OMP RPC exited ${code}`)); resolve(code); }));
    this.child.on('error', e => this.fail(e)); this.child.stdin.on('error', e => this.fail(e));
    this.child.stderr.on('data', b => { this.stderr = (this.stderr + b.toString()).slice(-4096); });
    this.child.stdout.on('data', b => { try { for (const frame of this.decoder.push(b)) this.receive(frame); } catch (e) { this.fail(e); } });
  }
  receive(frame) {
    if (frame.type === 'ready') { clearTimeout(this.readyTimer); this.readyResolve(frame); return; }
    if (frame.type === 'response') {
      const pending = this.pending.get(frame.id);
      if (pending) { this.pending.delete(frame.id); clearTimeout(pending.timer); if (frame.command !== pending.type) pending.reject(new Error('OMP response command mismatch')); else if (!frame.success) pending.reject(new Error(`OMP ${pending.type} failed`)); else pending.resolve(frame.data); }
      return;
    }
    const size = Buffer.byteLength(JSON.stringify(frame));
    if ((this.eventBytes += size) > this.eventLimit) throw new Error('OMP event retention limit exceeded');
    this.events.push(frame); this.onEvent?.(frame);
  }
  async connect() { const ready = await this.ready; if (ready.supportedProtocolVersions?.includes(2)) { await this.command('negotiate_protocol', { protocolVersion: 2 }); this.protocolVersion = 2; } return this; }
  async command(type, data = {}) {
    if (this.failure || this.isClosed) throw this.failure ?? new Error('OMP closed');
    const id = `aiwg-${++this.counter}`;
    const line = JSON.stringify({ ...data, type, id }) + '\n';
    if (Buffer.byteLength(line) > MAX_FRAME) throw new Error('OMP command frame limit exceeded');
    const response = new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`OMP ${type} timeout`)); void this.close(); }, this.timeoutMs); this.pending.set(id, { resolve, reject, timer, type }); });
    // Awaiting write's callback applies backpressure and catches pipe failure.
    await new Promise((resolve, reject) => this.child.stdin.write(line, error => error ? reject(error) : resolve())).catch(error => this.fail(error));
    return response;
  }
  async prompt(message, { signal } = {}) {
    if (this.running) throw new Error('OMP client permits one in-flight prompt');
    this.running = true; this.events = []; this.eventBytes = 0;
    try {
      const terminal = new Promise((resolve, reject) => {
        this.promptReject = reject;
        this.onEvent = frame => { if (frame.type === 'agent_end' && frame.willContinue !== true) resolve(); };
      });
      terminal.catch(() => {});
      const abort = () => { this.promptReject?.(new Error('OMP prompt aborted')); void this.close(); };
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, this.timeoutMs);
      try { if (signal?.aborted) abort(); await this.command('prompt', { message }); await terminal; const state = await this.command('get_state'); if (state?.isStreaming || state?.queuedMessageCount > 0 || state?.isCompacting) throw new Error('OMP terminal event preceded pending work'); return summarizeOmpEvents(this.events); }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.onEvent = null; this.promptReject = null; }
    } catch (error) { await this.close(); throw error; } finally { this.running = false; }
  }
  fail(error) { if (this.failure) return; this.failure = error; clearTimeout(this.readyTimer); this.readyReject(error); this.promptReject?.(error); for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); if (!this.isClosed) this.kill('SIGKILL'); }
  kill(signal) { try { if (process.platform !== 'win32' && Number.isSafeInteger(this.child.pid) && this.child.pid > 0) process.kill(-this.child.pid, signal); else signalChild(this.child, signal); } catch { /* already exited */ } }
  async close() {
    if (this.isClosed) return this.closed;
    if (this.closing) return this.closing;
    this.closing = (async () => {
      // Native EOF drains accepted commands and disposes sessions/MCP clients.
      // Signalling the whole group first can orphan children before OMP reaps them.
      if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded)
        this.child.stdin.end(JSON.stringify({ type: 'abort', id: 'aiwg-close' }) + '\n');
      let killTimer;
      const termTimer = setTimeout(() => {
        this.kill('SIGTERM');
        killTimer = setTimeout(() => this.kill('SIGKILL'), 500);
      }, this.closeGraceMs);
      try { return await this.closed; }
      finally { clearTimeout(termTimer); clearTimeout(killTimer); this.kill('SIGKILL'); }
    })();
    return this.closing;
  }
}

/**
 * #2999: a pinned native binary's first cold start competes with whatever else the host is
 * running (e.g. another CI job) for CPU and page cache, so a fixed RPC-readiness wait can fail
 * even though the binary is healthy. `warmArgs` touches the binary once, strictly before the RPC
 * process starts, outside the readiness window (default `--version`, matching the warm-up
 * `omp-conformance.mjs` already performs) so most of that cold-start cost lands on `warmedMs`
 * instead of the RPC `readyMs` budget. Callers pass a larger `readyTimeoutMs` (never `timeoutMs`,
 * which would also widen every later command/prompt deadline on the returned client) for the
 * first-start budget. All three durations/outcomes are returned so a caller can record them: a
 * slow start then shows up as a growing number in a conformance report, not only as a timeout.
 */
export async function warmAndConnectOmpRpcClient({ binary, cwd, env, warmArgs = ['--version'], warmTimeoutMs = 15000, ...clientOptions }) {
  const warmStarted = Date.now();
  // warmTimeoutMs is caller-controlled; clamp it so a caller passing 0 (or
  // anything else non-positive) can't disable the bound (#3062 B/C finding 8).
  const warmup = spawnSync(binary, warmArgs, { cwd, env, encoding: 'utf8', timeout: positiveTimeoutMs(warmTimeoutMs, 15000), killSignal: 'SIGKILL' });
  const warmedMs = Date.now() - warmStarted;
  const warmupResult = { status: warmup.status ?? null, signal: warmup.signal ?? null, error: warmup.error ? String(warmup.error.message ?? warmup.error) : null };
  const readyStarted = Date.now();
  const client = new OmpRpcClient({ binary, cwd, env, ...clientOptions });
  try { await client.connect(); }
  catch (error) { await client.close(); throw error; }
  return { client, warmup: warmupResult, warmedMs, readyMs: Date.now() - readyStarted };
}
