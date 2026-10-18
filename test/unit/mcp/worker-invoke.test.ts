/**
 * MCP worker-invoke bridge tests (#2892; T-OG-17).
 *
 * Covers the negative tests the brief requires for each defect found in the
 * #2896 reference bridge (path escape/symlink, client degraded attempt,
 * 200-run no-lockout, `all` wildcard exclusion) plus a real fake-stdio-MCP
 * and fake-CLI run/status/cancel lifecycle, PLUS the fix-2892-r1 round
 * (B1-B3, M1-M5, D1-D2 — see .aiwg/working/s1-scratch/fix-2892-r1.md).
 *
 * @source @src/mcp/tools/worker-invoke.mjs
 */
import { createHash } from 'node:crypto';
import { spawnSync, spawn as nodeSpawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workerConfigDigest } from '../../../src/config/aiwg-config.js';
import { resolveWorkerInvocation, type WorkerInvocationDriver } from '../../../src/serve/worker-invocation.js';
import { assertValidWorkerPayload } from '../../../src/mission-protocol/index.js';
import { buildShellStopControl, waitForUnitTermination } from '../../../src/mcp/tools/worker-shell-control.mjs';
import { loadRecoveryModuleGraph } from '../../helpers/recovery-module-graph.mjs';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { systemdClientFixture } from '../../fixtures/systemd-client.js';
import { workerInputSchema, workerOutputSchema } from '../../fixtures/ralph-worker-protocol.mjs';
import { parseToolsets, registerOptInToolsets, KNOWN_TOOLSETS } from '../../../src/mcp/tools/subsystems.mjs';

import { ScopedFailureBreaker } from '../../../tools/ralph-external/lib/consecutive-failure-circuit-breaker.mjs';
// Frozen 8c812250d6 reference -- see that file's own header. Baseline
// equivalence tests only; never a production import.
// @ts-expect-error — .mjs untyped
import * as workerInvokeBaseline from '../../fixtures/ralph-recovery-baseline/worker-invoke.mjs';

/** These lifecycle fixtures start at canary execution. Complete the required
 * relevant preliminary probe explicitly before entering that phase. */
function completeSyntheticPreliminaryProbe(breaker: any, invocationId: string) {
  const probe = breaker.admit({ invocationId, scopeKeys: ['installation:codex'], purpose: 'probe' });
  expect(probe.ok).toBe(true);
  expect(breaker.beginDispatch(probe.token, { invocationId, selectionDigest: null }).ok).toBe(true);
  expect(breaker.commitDispatch(probe.token).ok).toBe(true);
  breaker.settle(probe.token, { kind: 'succeeded', relevant: true, evidenceSource: 'launcher', confirmedStop: true });
}

let recoveryGraph = await loadRecoveryModuleGraph();
let { workerInvoke, launcher: sessionLauncherModule, isolation: workerIsolation } = recoveryGraph;
let { registerWorkerRecoveryCapabilities } = recoveryGraph.installation;
let { resetInProcessAllowanceLedger } = sessionLauncherModule;
let {
  createInvocationRegistry, resolveServerAllowDegraded, resolveServedProjectRoot,
  registerWorkerInvokeToolset: registerProductionToolset,
  WORKERS_TOOLSET_NAME, withServerQueue, __testOnlyMcpServerQueueCount,
  ChildProcessTransport, MAX_MCP_FRAME_BYTES,
} = workerInvoke as any;

// The bridge imports readers lazily. A reset in an earlier test invalidates
// their private WeakMaps even when a top-level namespace is still retained.
// Reacquire registration, readers and cleanup together before building drivers.
beforeEach(async () => {
  recoveryGraph = await loadRecoveryModuleGraph();
  ({ workerInvoke, launcher: sessionLauncherModule, isolation: workerIsolation } = recoveryGraph);
  ({ registerWorkerRecoveryCapabilities } = recoveryGraph.installation);
  ({ resetInProcessAllowanceLedger } = sessionLauncherModule);
  ({ createInvocationRegistry, resolveServerAllowDegraded, resolveServedProjectRoot,
    registerWorkerInvokeToolset: registerProductionToolset, WORKERS_TOOLSET_NAME,
    withServerQueue, __testOnlyMcpServerQueueCount } = workerInvoke);
});

/** A fixed, generous `readLiveHostResources()`-shaped sample (see
 * `tools/scripts/resource-preflight.mjs`), injected via the real
 * `registerWorkerInvokeToolset({ gateInputs: { live } })` test-only seam
 * (forwarded to `planDirectWorkerLaunch` → `checkWorkerDispatch`) so the
 * REAL dispatch gate still runs — on fixed synthetic signals instead of
 * this host's actual load/memory/PSI/disk — making these transport tests
 * deterministic under load. Comfortably clears every default threshold
 * (`DEFAULT_DISPATCH_HOST_THRESHOLDS`: 8GB avail mem, load ratio <= 1.0,
 * mem PSI avg10 <= 30 / avg60 <= 10, 2GB free disk). */
const HEALTHY_GATE_LIVE = Object.freeze({
  supported: true, availMemGb: 64, load1: 0.1, cores: 8, loadRatio: 0.05,
  memPsiAvg10: 0, memPsiAvg60: 0, memPsiAvg300: 0, workers: 0, freeDiskGb: 100,
});

/** Register the toolset the way every test in this file should: with the
 * dispatch gate pinned to `HEALTHY_GATE_LIVE`. The real gate reads this
 * host's load and memory, so a test that launches a worker without pinning
 * it is refused on a busy CI runner and then times out waiting for a worker
 * that never started (#3026). A test that passes its own `gateInputs`, for
 * example to prove a failing signal still refuses, overrides the default. */
function registerWorkerInvokeToolset(server: any, options: Record<string, unknown> = {}) {
  return registerProductionToolset(server, { gateInputs: { live: HEALTHY_GATE_LIVE }, ...options });
}

async function registerRecoveryCapabilities(driver: object, capabilities: { canVerifyAttempt?: boolean }) {
  return registerWorkerRecoveryCapabilities(driver, capabilities);
}

const digest = (v: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(v)).digest('hex')}`;
const roots: string[] = [];
// Some sandbox hosts refuse native child stdio pipes (EPERM). Framing unit
// tests still run there; the supervised-process check needs actual pipes.
const supportsCapturedWorkerStdio = spawnSync(process.execPath, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8', timeout: 10000 }).stdout === 'ok';
// #2915 review 6 (finding 3): `run()` now actually debits the shared
// in-process allowance ledger (previously it only reserved, never
// charged), so distinct test cases that resolve to the SAME task-chain
// digest (same role/task/group/brief content) would otherwise accumulate
// real charges against each other across this file's many gated runs —
// reset between tests so each test's own admission/allowance assertions
// stay independent, exactly like `roots` is cleaned up below.
afterEach(async () => { vi.unstubAllEnvs(); resetInProcessAllowanceLedger(); for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });

async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-worker-invoke-'));
  roots.push(root);
  return root;
}

async function transportFixture({ start = true, terminate }: { start?: boolean; terminate?: () => unknown } = {}) {
  const child: any = new EventEmitter();
  child.stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  child.stdin = Object.assign(new EventEmitter(), { destroy: vi.fn(), write: vi.fn(() => true) });
  child.stderr = { resume: vi.fn() };
  child.pid = 54321;
  child.kill = vi.fn(() => true);
  const transport = new ChildProcessTransport(child, terminate ? { terminate } : {});
  transport.onerror = vi.fn();
  transport.onclose = vi.fn();
  transport.onmessage = vi.fn();
  if (start) await transport.start();
  return { child, transport, emit: (chunk: Buffer) => child.stdout.emit('data', chunk) };
}

describe('worker MCP stdout byte budgets', () => {
  it('rejects a split unterminated frame before concatenating the overflow bytes', async () => {
    const { child, transport, emit } = await transportFixture();
    emit(Buffer.alloc(MAX_MCP_FRAME_BYTES, 120));
    expect(transport._buffer.length).toBe(MAX_MCP_FRAME_BYTES);
    const concat = vi.spyOn(Buffer, 'concat');
    try {
      emit(Buffer.from('x'));
      expect(concat).not.toHaveBeenCalled();
    } finally { concat.mockRestore(); }
    expect(transport.onerror).toHaveBeenCalledWith(expect.objectContaining({ code: 'OG_WORKER_MCP_FRAME_TOO_LARGE' }));
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(child.stdout.destroy).toHaveBeenCalled();
    expect(transport._buffer).toBeUndefined();
    expect(transport._rawResponses.size).toBe(0);
    emit(Buffer.from('still writing\n'));
    child.emit('close');
    expect(transport.onerror).toHaveBeenCalledTimes(1);
    expect(transport.onclose).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized newline-terminated frame in one chunk before parsing it', async () => {
    const { child, transport, emit } = await transportFixture();
    emit(Buffer.from(`${'x'.repeat(MAX_MCP_FRAME_BYTES + 1)}\n`));
    expect(transport.onerror).toHaveBeenCalledWith(expect.objectContaining({ code: 'OG_WORKER_MCP_FRAME_TOO_LARGE' }));
    expect(transport.onmessage).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(transport._buffer).toBeUndefined();
  });

  it('counts UTF-8 bytes, including a split multibyte character', async () => {
    const { transport, emit } = await transportFixture();
    const bytes = Buffer.from('é'.repeat(MAX_MCP_FRAME_BYTES / 2 + 1));
    emit(bytes.subarray(0, MAX_MCP_FRAME_BYTES - 1));
    emit(bytes.subarray(MAX_MCP_FRAME_BYTES - 1));
    expect(transport.onerror).toHaveBeenCalledWith(expect.objectContaining({ code: 'OG_WORKER_MCP_FRAME_TOO_LARGE' }));
  });

  it('accepts exact-limit frames and drains multiple frames across chunk boundaries', async () => {
    const { transport, emit } = await transportFixture();
    const message = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/test' }));
    const frame = Buffer.alloc(MAX_MCP_FRAME_BYTES, 32);
    message.copy(frame);
    emit(frame.subarray(0, 15));
    emit(Buffer.concat([frame.subarray(15), Buffer.from('\n'), message.subarray(0, 10)]));
    emit(Buffer.concat([message.subarray(10), Buffer.from('\r\n'), message, Buffer.from('\n')]));
    expect(transport.onerror).not.toHaveBeenCalled();
    expect(transport.onmessage).toHaveBeenCalledTimes(3);
    expect(transport._buffer).toBeUndefined();
  });

  it('accepts more than 20 MiB of individually bounded frames on a long-lived transport', async () => {
    const { child, transport, emit } = await transportFixture();
    const frame = Buffer.alloc(2048, 32);
    Buffer.from('{"jsonrpc":"2.0","method":"notifications/test"}').copy(frame);
    frame[frame.length - 1] = 10;
    const count = 21 * 1024 * 1024 / frame.length;
    for (let i = 0; i < count; i++) emit(frame);
    expect(transport.onerror).not.toHaveBeenCalled();
    expect(transport._buffer).toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
    expect(transport.onmessage).toHaveBeenCalledTimes(count);
  });

  it('applies the frame bound to malformed data after earlier malformed frames', async () => {
    const { transport, emit } = await transportFixture();
    const frame = Buffer.alloc(1024 * 1024, 120);
    frame[frame.length - 1] = 10;
    for (let i = 0; i < 21; i++) emit(frame);
    expect(transport._failure).toBeUndefined();
    emit(Buffer.alloc(MAX_MCP_FRAME_BYTES + 1, 120));
    expect(transport._failure.code).toBe('OG_WORKER_MCP_FRAME_TOO_LARGE');
  });

  it.each([true, false, undefined])('normalizes a terminator returning %s to uncertain evidence', async result => {
    const { transport, emit } = await transportFixture({ terminate: () => result });
    emit(Buffer.alloc(MAX_MCP_FRAME_BYTES + 1, 120));
    expect(await transport._termination).toEqual({ termination: 'uncertain', diagnostic: 'OG_WORKER_MCP_STOP_UNCONFIRMED' });
  });

  it('records overflow before a racing child close while termination proof is pending', async () => {
    let finish!: (result: unknown) => void;
    const stopped = new Promise(resolve => { finish = resolve; });
    const terminate = vi.fn(() => {
      expect(transport._failure.code).toBe('OG_WORKER_MCP_FRAME_TOO_LARGE');
      child.emit('close');
      return stopped;
    });
    const { child, transport, emit } = await transportFixture({ terminate });
    emit(Buffer.alloc(MAX_MCP_FRAME_BYTES + 1, 120));
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(transport.onerror).toHaveBeenCalledWith(transport._failure);
    expect(transport.onclose).toHaveBeenCalledTimes(1);
    await expect(transport.send({ jsonrpc: '2.0', method: 'notifications/test' })).rejects.toBe(transport._failure);
    finish({ termination: 'confirmed' });
    expect(await transport._termination).toEqual({ termination: 'confirmed' });
  });

  it.each(['throw', 'reject'])('preserves a %s from the stop authority as unconfirmed termination', async failure => {
    const terminate = () => {
      if (failure === 'throw') throw new Error('stop refused');
      return Promise.reject(new Error('stop refused'));
    };
    const { transport, emit } = await transportFixture({ terminate });
    emit(Buffer.alloc(MAX_MCP_FRAME_BYTES + 1, 120));
    expect(await transport._termination).toEqual({ termination: 'uncertain', diagnostic: 'OG_WORKER_MCP_STOP_FAILED' });
    expect(transport._failure.code).toBe('OG_WORKER_MCP_FRAME_TOO_LARGE');
  });

  it('rejects a pending SDK request immediately and invokes the worker stop authority', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const terminate = vi.fn(async () => {});
    const { transport, emit, child } = await transportFixture({ start: false, terminate });
    const client = new Client({ name: 'frame-budget-test', version: '1' }, { capabilities: {} });
    const connected = client.connect(transport);
    const rejected = expect(connected).rejects.toThrow(/Connection closed/);
    await waitFor(() => transport.lastRequestId !== null);
    emit(Buffer.alloc(MAX_MCP_FRAME_BYTES + 1, 120));
    await rejected;
    expect(transport._failure.code).toBe('OG_WORKER_MCP_FRAME_TOO_LARGE');
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
    await client.close();
  });
});

function captureTool(server: any, options: Record<string, unknown> = {}) {
  const tools = new Map<string, any>();
  const register = registerWorkerInvokeToolset(
    server ?? { registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); } },
    options,
  );
  return Promise.resolve(register).then(() => tools);
}

/** Poll until `predicate()` is true, for assertions on internal async state
 * (e.g. a `control` handle only registered once a real launch completes)
 * that must not depend on a fixed number of event-loop ticks. */
async function waitFor(predicate: () => boolean, { timeoutMs = 5000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor: predicate never became true');
}

// ---------------------------------------------------------------------------
// Defect 4: `all` must never silently enable `workers`.
// ---------------------------------------------------------------------------
describe('toolset wildcard exclusion (#2892 defect 4)', () => {
  it('registers under its own explicit opt-in name, excluded from the all wildcard', () => {
    expect(KNOWN_TOOLSETS).toContain(WORKERS_TOOLSET_NAME);
    expect(parseToolsets('all').has(WORKERS_TOOLSET_NAME)).toBe(false);
    expect(parseToolsets(WORKERS_TOOLSET_NAME).has(WORKERS_TOOLSET_NAME)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Defect 2: no client-facing degraded switch.
// ---------------------------------------------------------------------------
describe('degraded isolation is a server-side-only opt-in (#2892 defect 2)', () => {
  it('the tool input schema has no allow_degraded or project_dir field', async () => {
    const root = await tempRoot();
    const tools = await captureTool(undefined, { projectRoot: root });
    const shape = tools.get('worker-invoke').config.inputSchema.shape;
    expect(Object.keys(shape)).not.toContain('allow_degraded');
    expect(Object.keys(shape)).not.toContain('project_dir');
  });
  it('resolveServerAllowDegraded reads only the server environment, default false', () => {
    expect(resolveServerAllowDegraded({})).toBe(false);
    expect(resolveServerAllowDegraded({ AIWG_MCP_WORKER_ALLOW_DEGRADED: '1' })).toBe(true);
    expect(resolveServerAllowDegraded({ AIWG_MCP_WORKER_ALLOW_DEGRADED: 'true' })).toBe(true);
    expect(resolveServerAllowDegraded({ AIWG_MCP_WORKER_ALLOW_DEGRADED: 'yes' })).toBe(false);
  });
  it('a run request cannot flip allowDegraded even if it tries to smuggle the field in', async () => {
    const root = await tempRoot();
    const tools = await captureTool(undefined, { projectRoot: root });
    const parsed = tools.get('worker-invoke').config.inputSchema.safeParse({
      operation: 'run', request_id: 'r1', role: 'coding', task: 'implementation', group: 'workers',
      brief: path.join(root, 'brief.md'), workdir: root, final_output: path.join(root, 'final.json'),
      allow_degraded: true,
    });
    expect(parsed.success).toBe(false); // .strict() schema rejects the unknown field outright
  });
});

// ---------------------------------------------------------------------------
// Defect 1: hard path containment beneath the served project root.
// ---------------------------------------------------------------------------
describe('served-root path containment (#2892 defect 1)', () => {
  it('rejects a brief/workdir/final_output outside the served root', async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    const tools = await captureTool(undefined, { projectRoot: root });
    const call = tools.get('worker-invoke').handler;
    await mkdir(path.join(root, 'work'));
    await writeFile(path.join(outside, 'brief.md'), 'hi');
    const result = await call({
      operation: 'run', request_id: 'escape-1', role: 'coding', task: 'implementation', group: 'workers',
      brief: path.join(outside, 'brief.md'), workdir: path.join(root, 'work'), final_output: path.join(root, 'work', 'final.json'),
      transport: 'shell',
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/escapes the served project root/);
  });

  it('rejects a symlink that resolves outside the served root (no symlink escape)', async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await writeFile(path.join(outside, 'secret.md'), 'ssh-private-key-shaped-content');
    const link = path.join(root, 'brief.md');
    await symlink(path.join(outside, 'secret.md'), link);
    await mkdir(path.join(root, 'work'));
    const tools = await captureTool(undefined, { projectRoot: root });
    const call = tools.get('worker-invoke').handler;
    const result = await call({
      operation: 'run', request_id: 'escape-2', role: 'coding', task: 'implementation', group: 'workers',
      brief: link, workdir: path.join(root, 'work'), final_output: path.join(root, 'work', 'final.json'), transport: 'shell',
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/symlink/);
  });

  it('rejects relative paths outright', async () => {
    const root = await tempRoot();
    const tools = await captureTool(undefined, { projectRoot: root });
    const call = tools.get('worker-invoke').handler;
    const result = await call({
      operation: 'run', request_id: 'escape-3', role: 'coding', task: 'implementation', group: 'workers',
      brief: 'brief.md', workdir: root, final_output: path.join(root, 'final.json'), transport: 'shell',
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/absolute/);
  });

  it('resolveServedProjectRoot canonicalizes and rejects a missing root', async () => {
    const root = await tempRoot();
    await expect(resolveServedProjectRoot(root)).resolves.toBe(await (await import('node:fs/promises')).realpath(root));
    await expect(resolveServedProjectRoot(path.join(root, 'does-not-exist'))).rejects.toThrow();
  });

  it('resolveServedProjectRoot refuses when no explicit candidate is given — never falls back to process.cwd() (#2892 B1)', async () => {
    await expect(resolveServedProjectRoot(undefined)).rejects.toThrow(/explicit root/);
    await expect(resolveServedProjectRoot('')).rejects.toThrow(/explicit root/);
  });
});

// ---------------------------------------------------------------------------
// #2892 B1: the served root is pinned ONCE, at registration, through the
// PRODUCTION registration path (registerOptInToolsets -> worker-invoke) —
// never re-resolved from a later process.cwd().
// ---------------------------------------------------------------------------
describe('production registration path pins the served root at registration time (#2892 B1)', () => {
  it('refuses to register at all when no explicit project root is supplied', async () => {
    const registerTool = vi.fn();
    await registerOptInToolsets({ registerTool }, new Set([WORKERS_TOOLSET_NAME]), {});
    expect(registerTool).not.toHaveBeenCalled();
  });

  it('registerOptInToolsets -> worker-invoke resolves the root ONCE; a later chdir never changes it', async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work');
    await mkdir(work);
    await writeFile(path.join(root, 'brief.md'), 'hello');
    const tools = new Map<string, any>();
    await registerOptInToolsets({ registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); } },
      new Set([WORKERS_TOOLSET_NAME]), {
        projectRoot: root, workerWorktreesRoot: work,
        loadWorkerInputs: async () => { throw new Error('stop-before-real-project-load'); },
      });
    expect(tools.has('worker-invoke')).toBe(true);
    // `process.chdir()` is unavailable in this test runner's worker threads;
    // stub `process.cwd()` instead — the same observable signal a lazy
    // `resolveServedProjectRoot(process.cwd())` call would have picked up
    // had the root not been pinned at registration.
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/nonexistent-cwd-must-never-be-used');
    try {
      const call = tools.get('worker-invoke').handler;
      const result = await call({
        operation: 'run', request_id: 'chdir-1', role: 'coding', task: 'implementation', group: 'workers',
        brief: path.join(root, 'brief.md'), workdir: work, final_output: path.join(work, 'final.json'), transport: 'shell',
      });
      const body = JSON.parse(result.content[0].text);
      // Path validation succeeded against ROOT (the pinned served root), not
      // against the stubbed `process.cwd()` (what a lazy resolution at first
      // request would have used) — resolution proceeds all the way to the
      // injected stop point instead of failing on path containment.
      //
      // The audited main baseline treats `loadWorkerInputs` throwing here as a
      // PROVEN pre-spawn failure -- nothing launched, so capacity is freed
      // (`blocked`), never left LIVE as `uncertain` forever.
      expect(body.status).toBe('blocked');
      expect(body.termination).toBe('confirmed');
      expect(body.diagnostics).toContain('stop-before-real-project-load');
    } finally {
      cwdSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// #2892 B3: workdir/final_output scope, and the O_NOFOLLOW/fd-containment
// hardening on the final-output read.
// ---------------------------------------------------------------------------
describe('workdir and final_output scope (#2892 B3)', () => {
  it('rejects the served root itself as workdir', async () => {
    const root = await tempRoot();
    const tools = await captureTool(undefined, { projectRoot: root });
    const call = tools.get('worker-invoke').handler;
    const result = await call({
      operation: 'run', request_id: 'scope-root', role: 'coding', task: 'implementation', group: 'workers',
      brief: path.join(root, 'brief.md'), workdir: root, final_output: path.join(root, 'final.json'), transport: 'shell',
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/strict subdirectory/);
  });

  it('rejects .git and .aiwg as workdir', async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, '.git'));
    await mkdir(path.join(root, '.aiwg'));
    const tools = await captureTool(undefined, { projectRoot: root });
    const call = tools.get('worker-invoke').handler;
    for (const reserved of ['.git', '.aiwg']) {
      const result = await call({
        operation: 'run', request_id: `scope-${reserved}`, role: 'coding', task: 'implementation', group: 'workers',
        brief: path.join(root, 'brief.md'), workdir: path.join(root, reserved), final_output: path.join(root, reserved, 'final.json'),
        transport: 'shell',
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).error).toMatch(/reserved/);
    }
  });

  it('rejects a final_output outside the validated workdir, even when still inside the served root', async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work);
    const sibling = path.join(root, 'sibling'); await mkdir(sibling);
    const tools = await captureTool(undefined, { projectRoot: root, workerWorktreesRoot: work });
    const call = tools.get('worker-invoke').handler;
    const result = await call({
      operation: 'run', request_id: 'scope-sibling', role: 'coding', task: 'implementation', group: 'workers',
      brief: path.join(root, 'brief.md'), workdir: work, final_output: path.join(sibling, 'final.json'), transport: 'shell',
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/inside workdir/);
  });

  it('refuses a pre-existing final_output path rather than silently truncating/reusing it', async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work);
    await writeFile(path.join(root, 'brief.md'), 'hello');
    const finalPath = path.join(work, 'final.json');
    await writeFile(finalPath, 'pre-existing content from an earlier run');
    const tools = await captureTool(undefined, { projectRoot: root, workerWorktreesRoot: work });
    const call = tools.get('worker-invoke').handler;
    const result = await call({
      operation: 'run', request_id: 'scope-preexisting', role: 'coding', task: 'implementation', group: 'workers',
      brief: path.join(root, 'brief.md'), workdir: work, final_output: finalPath, transport: 'shell',
    });
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe('blocked');
    expect(body.diagnostics.join(' ')).toMatch(/already exists/);
  });

  it('refuses to read the final output through a symlink swapped in after reservation (TOCTOU, #2892 B3)', async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work);
    const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'hello');
    const finalPath = path.join(work, 'final.json');
    const secretPath = path.join(work, 'secret.json');
    await writeFile(secretPath, JSON.stringify({ type: 'result', result: { version: 1, status: 'completed', summary: 'LEAKED-SECRET-MARKER', claims: [], artifacts: [], checks: [], limitations: [] } }));
    const f = buildFixture(root, 'shell');
    const tools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); } }, {
      projectRoot: root, workerWorktreesRoot: work,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }),
      launchShellWorker: async () => {
        // Simulate a racing/compromised worker swapping the reserved output
        // path for a symlink to an unrelated file AFTER path validation and
        // the exclusive-create reservation both already succeeded.
        await rm(finalPath, { force: true });
        await symlink(secretPath, finalPath);
        return { launched: true, mode: 'degraded', child: closingChild(0) };
      },
      now: () => new Date(f.now),
    });
    const call = tools.get('worker-invoke').handler;
    const result = await call({
      operation: 'run', request_id: 'symlink-swap-1', role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalPath, transport: 'shell',
    });
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe('failed');
    expect(JSON.stringify(body)).not.toContain('LEAKED-SECRET-MARKER');
  });
});

// ---------------------------------------------------------------------------
// #2892 M1: atomic admission — request_id required, capacity+identity
// reservation synchronous (no await between the checks and the reservation).
// ---------------------------------------------------------------------------
describe('atomic admission under concurrency (#2892 M1)', () => {
  it('requires request_id for a run operation', async () => {
    const root = await tempRoot();
    const tools = await captureTool(undefined, { projectRoot: root });
    const call = tools.get('worker-invoke').handler;
    const result = await call({
      operation: 'run', role: 'coding', task: 'implementation', group: 'workers',
      brief: path.join(root, 'brief.md'), workdir: path.join(root, 'work'), final_output: path.join(root, 'work', 'final.json'), transport: 'shell',
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/request_id/);
  });

  it('admits exactly ONE of many concurrent DISTINCT requests when maxActive=1 (probe: 12 identical requests were admitted before the fix)', async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work);
    await writeFile(path.join(root, 'brief.md'), 'hello');
    const tools = await captureTool(undefined, {
      projectRoot: root, maxActive: 1, workerWorktreesRoot: work,
      loadWorkerInputs: async () => { throw new Error('stop-here'); },
    });
    const call = tools.get('worker-invoke').handler;
    const attempts = await Promise.all(Array.from({ length: 12 }, (_, i) => call({
      operation: 'run', request_id: `distinct-${i}`, role: 'coding', task: 'implementation', group: 'workers',
      brief: path.join(root, 'brief.md'), workdir: work, final_output: path.join(work, `final-${i}.json`), transport: 'shell',
    })));
    const admitted = attempts.filter(r => !r.isError);
    const refused = attempts.filter(r => r.isError);
    expect(admitted.length).toBe(1);
    expect(refused.length).toBe(11);
    for (const r of refused) expect(JSON.parse(r.content[0].text).error).toMatch(/capacity/);
  });

  it('admits exactly ONE of many concurrent requests sharing the SAME request_id, never a blind replay', async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work);
    await writeFile(path.join(root, 'brief.md'), 'hello');
    const tools = await captureTool(undefined, {
      projectRoot: root, maxActive: 12, workerWorktreesRoot: work,
      loadWorkerInputs: async () => { throw new Error('stop-here'); },
    });
    const call = tools.get('worker-invoke').handler;
    const attempts = await Promise.all(Array.from({ length: 12 }, () => call({
      operation: 'run', request_id: 'same-id', role: 'coding', task: 'implementation', group: 'workers',
      brief: path.join(root, 'brief.md'), workdir: work, final_output: path.join(work, 'final.json'), transport: 'shell',
    })));
    expect(attempts.filter(r => !r.isError).length).toBe(1);
    for (const r of attempts.filter(r => r.isError)) {
      expect(JSON.parse(r.content[0].text).error).toMatch(/already used/);
    }
  });
});

// ---------------------------------------------------------------------------
// #2892 M2: uncertain runs stay LIVE (capacity held); cancel actually
// delivers a stop signal; a completion after cancel is recorded as
// cancelled, never completed.
// ---------------------------------------------------------------------------
describe('cancellation and uncertain-run capacity (#2892 M2)', () => {
  it('an uncertain shell run stays LIVE — a second run is refused, not admitted, until disposed', async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work);
    await writeFile(path.join(root, 'brief.md'), 'hello');
    const f = buildFixture(root, 'shell');
    f.snapshot.config.parallelism!.health = { hardTimeoutSeconds: 1 };
    const tools = new Map<string, any>();
    const registry = createInvocationRegistry({ maxActive: 1 });
    await registerWorkerInvokeToolset({ registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); } }, {
      projectRoot: root, registry, workerWorktreesRoot: work,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }),
      launchShellWorker: async () => ({ launched: true, mode: 'degraded', child: fakeNeverClosingChild() }),
      shellStopGraceMs: 20, now: () => new Date(f.now),
    });
    const call = tools.get('worker-invoke').handler;
    const result = await call({
      operation: 'run', request_id: 'uncertain-m2', role: 'coding', task: 'implementation', group: 'workers',
      brief: path.join(root, 'brief.md'), workdir: work, final_output: path.join(work, 'final.json'), transport: 'shell',
    });
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe('uncertain');
    expect(registry.canStart()).toBe(false); // capacity still held, not freed by markTerminal
  });

  // #2892 F2 (fix-2892-r2): a thrown MCP transport error used to be
  // reported `uncertain` via `markTerminal` — freeing the capacity
  // reservation with ZERO stop proof, exactly the hole M2 closed for the
  // timeout/disconnect paths. `update` must keep it LIVE instead.
  it('a thrown MCP transport error stays LIVE — capacity is held, never freed (#2892 F2)', async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
    const briefPath = path.join(root, 'brief.md');
    const finalOutput = path.join(work, 'final.json');
    const f = buildFixture(root, 'mcp');
    await buildStructuredBrief(f, { role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp' });
    const registry = createInvocationRegistry({ maxActive: 1 });
    const tools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); } }, {
      projectRoot: root, registry, workerWorktreesRoot: work,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }),
      callMcpWorker: async () => { throw new Error('synthetic: transport layer threw rather than resolving an outcome'); },
      now: () => new Date(f.now),
    });
    const call = tools.get('worker-invoke').handler;
    const result = await call({
      operation: 'run', request_id: 'f2-thrown', role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp',
    });
    const body = JSON.parse(result.content[0].text);
    expect(body.status, JSON.stringify(body)).toBe('uncertain');
    expect(registry.canStart()).toBe(false); // capacity still held — NOT freed via markTerminal
  });

  // #2915 P0: a pre-spawn exception from the scoped-recovery admission path
  // (bad breaker state, a thrown import, a malformed `canLaunch` result) is
  // NOT an uncertain worker outcome — no worker ever ran. It must fail
  // CLOSED as an ordinary blocked/refused launch, freeing the capacity
  // reservation, never falling through to the generic uncertain/LIVE path
  // (#2915 review: a thrown admission error produced `status:'uncertain'`
  // with one live slot retained and `canStart:false`, despite no launch).
  it('a pre-spawn scoped-recovery admission error fails CLOSED and frees capacity, never leaking a live slot (#2915 P0)', async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
    const briefPath = path.join(root, 'brief.md');
    const finalOutput = path.join(work, 'final.json');
    const f = buildFixture(root, 'mcp');
    await buildStructuredBrief(f, { role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp' });
    const registry = createInvocationRegistry({ maxActive: 1 });
    const throwingBreaker = { canLaunch: () => { throw new Error('synthetic: admission exploded'); } };
    const tools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); } }, {
      projectRoot: root, registry, workerWorktreesRoot: work, scopedBreaker: throwingBreaker,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }),
      now: () => new Date(f.now),
    });
    const call = tools.get('worker-invoke').handler;
    const result = await call({
      operation: 'run', request_id: 'p0-admission-throw', role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp',
    });
    const body = JSON.parse(result.content[0].text);
    expect(body.status, JSON.stringify(body)).toBe('blocked');
    expect(body.termination).toBe('confirmed');
    // Capacity was FREED (markTerminal), not leaked as a live "uncertain" slot.
    expect(registry.canStart()).toBe(true);
  });

  // No worker exists yet: release both capacity and the private output reservation.
  it('a pre-prefix-decision exception matches current main (blocked/confirmed, capacity released)', async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
    const briefPath = path.join(root, 'brief.md');
    const finalOutput = path.join(work, 'final.json');
    const f = buildFixture(root, 'mcp');
    await buildStructuredBrief(f, { role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp' });
    const registry = createInvocationRegistry({ maxActive: 1 });
    const tools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); } }, {
      projectRoot: root, registry, workerWorktreesRoot: work,
      // Throws well before the recovery gate is decided -- the data run()
      // needs to even compute `recoveryGateEnabled` is never loaded.
      loadWorkerInputs: async () => { throw new Error('synthetic: pre-admission data load failure'); },
      now: () => new Date(f.now),
    });
    const call = tools.get('worker-invoke').handler;
    const result = await call({
      operation: 'run', request_id: 'p2b-prespawn-throw', role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp',
    });
    const body = JSON.parse(result.content[0].text);
    expect(body.status, JSON.stringify(body)).toBe('blocked');
    expect(body.termination).toBe('confirmed');
    expect(registry.canStart()).toBe(true);
    expect(existsSync(finalOutput)).toBe(false);
  });

  // #2915 final (step 6, disabled-dispatch-is-inert): with
  // `parallelism.worker_dispatch` off (or absent), `admitDirectWorker` must
  // be completely inert — byte-for-byte what dispatch looked like before
  // this feature existed — even with an injected breaker whose `admit`
  // would throw if ever reached. Enabled, the same breaker IS reached and
  // its admission result is honored.
  it('disabled-dispatch-is-inert: admitDirectWorker never constructs/consults the breaker when the global flag is false or unset', async () => {
    const sessionLauncher = await import('../../../tools/ralph-external/session-launcher.mjs');
    const throwingBreaker = { admit: () => { throw new Error('must never be reached while disabled'); } };
    const invocation = { selected: { cli: 'codex', inferenceProvider: 'openai' } };
    const off = await sessionLauncher.admitDirectWorker({ gateEnabled: false, config: { parallelism: { worker_dispatch: false } },
      invocation, invocationId: 'inv-1', scopedBreaker: throwingBreaker });
    expect(off).toEqual({ gated: false });
    const absent = await sessionLauncher.admitDirectWorker({ gateEnabled: false, config: undefined,
      invocation, invocationId: 'inv-2', scopedBreaker: throwingBreaker });
    expect(absent).toEqual({ gated: false });
    const refusingBreaker = { nowMs: () => Date.now(), admit: () => ({ ok: false, blockedBy: ['installation:codex'] }) };
    const on = await sessionLauncher.admitDirectWorker({ gateEnabled: true, config: { parallelism: { worker_dispatch: true } },
      invocation, invocationId: 'inv-3', scopedBreaker: refusingBreaker });
    expect(on).toMatchObject({ gated: true, refused: { blockedBy: ['installation:codex'] } });
  });

  // #2915 follow-up: a CLI whose adapter can never verify a final (Warp,
  // Copilot — `canVerifyAttempt: false`) is never eligible for
  // recovery-breaker gating, even with dispatch enabled and a breaker that
  // would otherwise admit.
  it('a CLI that cannot verify any final is never eligible for recovery-breaker gating (not-gated)', async () => {
    const sessionLauncher = await import('../../../tools/ralph-external/session-launcher.mjs');
    const admittingBreaker = { admit: () => { throw new Error('must never be reached: this CLI is not-gated'); } };
    const invocation = { selected: { cli: 'warp', inferenceProvider: 'warp' } };
    const result = await sessionLauncher.admitDirectWorker({ gateEnabled: true, config: { parallelism: { worker_dispatch: true } },
      invocation, invocationId: 'inv-warp-1', scopedBreaker: admittingBreaker, drivers: { warp: registerWorkerRecoveryCapabilities({}, { canVerifyAttempt: false }) } });
    expect(result).toEqual({ gated: false, reason: 'cli-cannot-verify-final' });
  });

  // #2915 step 4: `retry_of` has no server-owned capture-root
  // configuration on this bridge yet; it must refuse explicitly, before
  // any capacity is reserved, rather than silently ignoring the conductor's
  // retry declaration.
  it('retry_of refuses explicitly before any capacity is reserved (MCP capture-root not yet configured)', async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
    const briefPath = path.join(root, 'brief.md');
    const finalOutput = path.join(work, 'final.json');
    const f = buildFixture(root, 'mcp');
    await buildStructuredBrief(f, { role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp' });
    const registry = createInvocationRegistry({ maxActive: 1 });
    const tools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); } }, {
      projectRoot: root, registry, workerWorktreesRoot: work,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }),
      now: () => new Date(f.now),
    });
    const call = tools.get('worker-invoke').handler;
    const result = await call({
      operation: 'run', request_id: 'retry-of-refused', role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp',
      retry_of: '11111111-1111-1111-1111-111111111111',
    });
    expect(result.isError).toBe(true);
    expect(registry.canStart()).toBe(true); // no capacity was ever reserved
  });

  // #2915 review 4 (finding 9), review 5 (finding 1c): the transport byte
  // bound must be enforced BEFORE parsing -- an unterminated frame past the
  // bound must refuse, never grow the buffer without limit -- AND the
  // design's literal 10 MiB value, not merely "some bound". Review 5 found
  // the prior bound was 11 MiB (one full MiB unbounded) and that overflow
  // was not terminal: a later well-formed frame on the same connection still
  // drained and reached `onmessage` normally.
  it('ChildProcessTransport refuses an unterminated frame past the MCP transport byte bound, at the literal 10 MiB design value, terminally', async () => {
    const { __testOnlyChildProcessTransport: ChildProcessTransport, __testOnlyMcpTransportMaxBufferBytes: maxBytes } =
      await import('../../../src/mcp/tools/worker-invoke.mjs');
    // The design value is 10 MiB exactly -- not "whatever the constant
    // currently says". A regression back to 11 MiB (or any other value)
    // must fail this assertion, not just whatever `maxBytes` happens to be.
    expect(maxBytes).toBe(10 * 1024 * 1024);
    const fakeStderr: any = new EventEmitter(); fakeStderr.resume = () => {};
    const fakeChild: any = {
      pid: 54321,
      stdout: Object.assign(new EventEmitter(), { destroy: vi.fn() }), stderr: fakeStderr,
      stdin: Object.assign(new EventEmitter(), { destroy: vi.fn() }), kill: vi.fn(() => true),
      once(event: string, _handler: any) { return this; },
    };
    const transport = new (ChildProcessTransport as any)(fakeChild);
    const errors: Error[] = [];
    const messages: any[] = [];
    transport.onerror = (error: Error) => errors.push(error);
    transport.onmessage = (message: any) => messages.push(message);
    await transport.start();
    // One unterminated chunk already past the bound -- never newline-framed.
    fakeChild.stdout.emit('data', Buffer.alloc(maxBytes + 1, 0x41));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'OG_WORKER_MCP_FRAME_TOO_LARGE' });
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGKILL');
    expect(fakeChild.stdout.destroy).toHaveBeenCalledOnce();
    expect(transport._buffer).toBeUndefined(); // never retained past the bound
    // Terminal, not transient: a SUBSEQUENT, perfectly well-formed
    // newline-terminated JSON-RPC response arriving on the SAME connection
    // must never reach `onmessage` -- the overflow refusal must outlive the
    // one oversized chunk, closing off this transport for good rather than
    // silently resuming on the next clean frame.
    fakeChild.stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`));
    expect(messages).toHaveLength(0);
    expect(errors).toHaveLength(1); // terminal refusal reports once, even after more bytes
  });

  // #2892 F2: cancellation must reference the worker's OWN actual in-flight
  // JSON-RPC request id (captured at the transport layer), never a
  // caller-supplied value with no relationship to the wire protocol
  // (`mcpBinding.requestId` was never even populated — always `null`).
  it.skipIf(!supportsCapturedWorkerStdio || process.platform !== 'linux')('cancel sends notifications/cancelled with the ACTUAL in-flight request id, never null (#2892 F2)', async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
    const briefPath = path.join(root, 'brief.md');
    const finalOutput = path.join(work, 'final.json');
    const recordPath = path.join(root, 'record.jsonl');
    const configPath = path.join(root, 'fixture-config.json');
    await writeFile(configPath, JSON.stringify({ recordPath, scenario: 'stall' }));
    const f = buildFixture(root, 'mcp');
    f.drivers.codex.mcpRegistry = {
      get: async () => ({ name: 'fixture-server', type: 'stdio' as const, command: process.execPath,
        args: [path.resolve('test/fixtures/ralph-worker-mcp.mjs')], env: { AIWG_FAKE_WORKER_CONFIG: configPath } }),
    };
    await buildStructuredBrief(f, { role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp' });
    const registry = createInvocationRegistry();
    const tools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); } }, {
      projectRoot: root, registry, allowDegraded: true, workerWorktreesRoot: work,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }), now: () => new Date(f.now),
    });
    const call = tools.get('worker-invoke').handler;
    const runPromise = call({
      operation: 'run', request_id: 'f2-reqid', role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp',
    });
    const [pendingEntry] = registry.values().filter((e: any) => e.requestId === 'f2-reqid');
    // `control` becomes non-null as soon as the transport is constructed —
    // well BEFORE the SDK has actually sent `tools/call` (connect/listTools
    // happen first). Wait for the fixture's own 'call' record instead, so
    // cancel() races against an ACTUAL in-flight tools/call request, not an
    // as-yet-unsent one.
    await waitFor(() => {
      try {
        const lines = readFileSync(recordPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        return lines.some((l: any) => l.event === 'call');
      } catch { return false; }
    });
    await call({ operation: 'cancel', invocation_id: pendingEntry.invocationId });
    await waitFor(() => {
      try {
        const lines = readFileSync(recordPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        return lines.some((l: any) => l.event === 'cancel-delivered');
      } catch { return false; }
    });
    const lines = (await readFile(recordPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const callEvent = lines.find((l: any) => l.event === 'call');
    const cancelEvent = lines.find((l: any) => l.event === 'cancel-delivered');
    expect(callEvent.requestId).not.toBeNull();
    expect(typeof callEvent.requestId === 'number' || typeof callEvent.requestId === 'string').toBe(true);
    // The ACTUAL in-flight tools/call request id, not a caller-opaque value.
    expect(cancelEvent.requestId).toBe(callEvent.requestId);
    expect(cancelEvent.requestId).not.toBeNull();
  });

  it('cancel delivers a real stop signal, and a later completion is recorded cancelled, never completed', async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work);
    const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'hello');
    const finalPath = path.join(work, 'final.json');
    const f = buildFixture(root, 'shell');
    const tools = new Map<string, any>();
    const registry = createInvocationRegistry();
    let killed = false;
    const child: any = new EventEmitter();
    child.pid = 123456;
    child.kill = () => { killed = true; return true; };
    await registerWorkerInvokeToolset({ registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); } }, {
      projectRoot: root, registry, workerWorktreesRoot: work,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }),
      launchShellWorker: async () => ({ launched: true, mode: 'degraded', child }),
      now: () => new Date(f.now),
    });
    const call = tools.get('worker-invoke').handler;
    const runPromise = call({
      operation: 'run', request_id: 'cancel-m2', role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalPath, transport: 'shell',
    });
    const [pendingEntry] = registry.values().filter((e: any) => e.requestId === 'cancel-m2');
    const invocationId = pendingEntry.invocationId;
    await waitFor(() => registry.get(invocationId)?.control != null);
    const cancelResult = await call({ operation: 'cancel', invocation_id: invocationId });
    const cancelBody = JSON.parse(cancelResult.content[0].text);
    expect(cancelBody.cancelRequested).toBe(true);
    expect(cancelBody.cancelDelivered).toBe(true);
    expect(killed).toBe(true);
    // The worker keeps running despite the (unconfirmed-stop) cancel signal
    // and eventually reports a normal completed claim.
    const claims = { version: 1, status: 'completed', summary: 'ok', claims: [], artifacts: [], checks: [], limitations: [] };
    await writeFile(finalPath, `${JSON.stringify({ type: 'result', result: claims })}\n`);
    child.emit('close', 0);
    const runResult = await runPromise;
    const runBody = JSON.parse(runResult.content[0].text);
    expect(runBody.status).toBe('cancelled');
    expect(runBody.termination).toBe('confirmed');
  });

  it('cancel on an invocation with no live control handle still marks the run cancelled, not completed', async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work);
    const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'hello');
    const finalPath = path.join(work, 'final.json');
    const f = buildFixture(root, 'shell');
    const tools = new Map<string, any>();
    const registry = createInvocationRegistry();
    const child: any = new EventEmitter();
    child.pid = 123456;
    child.kill = () => true;
    let releaseLaunch: () => void = () => {};
    let launchCalled = false;
    await registerWorkerInvokeToolset({ registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); } }, {
      projectRoot: root, registry, workerWorktreesRoot: work,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }),
      // The launch itself does not resolve until released, so `cancel` is
      // invoked BEFORE any `control` handle has been registered.
      launchShellWorker: () => { launchCalled = true; return new Promise(resolve => { releaseLaunch = () => resolve({ launched: true, mode: 'degraded', child }); }); },
      now: () => new Date(f.now),
    });
    const call = tools.get('worker-invoke').handler;
    const runPromise = call({
      operation: 'run', request_id: 'cancel-no-control', role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalPath, transport: 'shell',
    });
    await waitFor(() => launchCalled);
    const [pendingEntry] = registry.values().filter((e: any) => e.requestId === 'cancel-no-control');
    const cancelResult = await call({ operation: 'cancel', invocation_id: pendingEntry.invocationId });
    const cancelBody = JSON.parse(cancelResult.content[0].text);
    expect(cancelBody.cancelRequested).toBe(true);
    expect(cancelBody.cancelDelivered).toBe(false); // nothing live to deliver to yet
    // Only write the final-output content once the launch has actually been
    // reached (proving reserveFinalOutput's own exclusive create already
    // succeeded) — writing any earlier races the bridge's own reservation.
    await waitFor(() => launchCalled);
    const claims = { version: 1, status: 'completed', summary: 'ok', claims: [], artifacts: [], checks: [], limitations: [] };
    await writeFile(finalPath, `${JSON.stringify({ type: 'result', result: claims })}\n`);
    releaseLaunch();
    // Resolving `releaseLaunch`'s promise only schedules run()'s own
    // continuation (which attaches the `close` listener) as a microtask —
    // wait for that listener to actually be attached before emitting, or
    // the event is lost with nothing yet subscribed.
    await waitFor(() => child.listenerCount('close') > 0);
    child.emit('close', 0);
    const runBody = JSON.parse((await runPromise).content[0].text);
    expect(runBody.status, JSON.stringify(runBody)).toBe('cancelled');
  });
});

// ---------------------------------------------------------------------------
// #2915 round 8 review 8 (C3): cancellation requested while admission/
// preparation is still in flight must prevent the spawn, enforced at TWO
// independent layers -- `defaultCallMcpWorkerGated`'s own pre-launch
// `isCancelled()` check, AND the `dispatchGuard` (`{ deadlineAtMs, nowMs,
// isCancelled }`) threaded all the way into the REAL `planDirectWorkerLaunch`
// -> `launchIsolatedWorker` dispatch-commit hook. Verified directly (by
// temporarily disabling each independently) that EITHER layer alone
// catches this probe; the test below exercises the real pipeline end to
// end, never a unit test of `checkDispatchGuard` in isolation.
// ---------------------------------------------------------------------------
describe('dispatch-commit hook enforces cancellation via dispatchGuard through the real launch pipeline (#2915 round 8 review 8, C3)', () => {
  // MCP transport (attached, degraded-or-systemd-unit both fine -- the
  // native MCP launch path always resolves a `memoryMaxGb` default, unlike
  // the shell path, so this is host-isolation-mode-independent): proves the
  // real pipeline refused the spawn, not merely that the outward result
  // happens to read 'cancelled' -- the fixture worker's own record file is
  // asserted to never exist at all, meaning the worker process was never
  // started, not merely that its response was discarded.
  it('cancellation requested while admission/preparation is still in flight prevents the real worker process from ever being spawned', async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
    const briefPath = path.join(root, 'brief.md');
    const finalOutput = path.join(work, 'final.json');
    const recordPath = path.join(root, 'record.jsonl');
    const configPath = path.join(root, 'fixture-config.json');
    await writeFile(configPath, JSON.stringify({ recordPath, scenario: 'success' }));
    const f = buildFixture(root, 'mcp');
    f.drivers.codex.mcpRegistry = {
      get: async () => ({ name: 'fixture-server', type: 'stdio' as const, command: process.execPath,
        args: [path.resolve('test/fixtures/ralph-worker-mcp.mjs')], env: { AIWG_FAKE_WORKER_CONFIG: configPath } }),
    };
    await buildStructuredBrief(f, { role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp' });
    const registry = createInvocationRegistry();
    const tools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); } }, {
      projectRoot: root, registry, allowDegraded: true, workerWorktreesRoot: work,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }), now: () => new Date(f.now),
      gateInputs: { live: HEALTHY_GATE_LIVE },
      // No `callMcpWorker` override -- this exercises the REAL
      // `defaultCallMcpWorkerGated` -> `defaultLaunchMcpWorkerProcess` ->
      // `planDirectWorkerLaunch` -> `launchIsolatedWorker` pipeline,
      // including its dispatch-commit hook.
    });
    const call = tools.get('worker-invoke').handler;
    const runPromise = call({
      operation: 'run', request_id: 'dispatchguard-cancel-1', role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp',
    });
    const [pendingEntry] = registry.values().filter((e: any) => e.requestId === 'dispatchguard-cancel-1');
    // Races the real admission/brief-preparation chain (several real awaits:
    // validatedRequest, loadWorkerInputs, resolveWorkerInvocation, the
    // ledger reserve inside admitDirectWorker, the MCP structured-brief
    // read/validate) with this single, nearly synchronous `cancel()` call --
    // by the time the leaf dispatch-commit hook actually runs, deep inside
    // the real `launchIsolatedWorker`, `cancelRequested` is already true.
    await call({ operation: 'cancel', invocation_id: pendingEntry.invocationId });
    const runBody = JSON.parse((await runPromise).content[0].text);
    // 'blocked' with this exact diagnostic is the dispatch-commit hook's
    // own refusal shape (`checkDispatchGuard` -> `_runDispatchCommit`'s
    // `{ launched: false, blocked: true, failures: [{ signal:
    // 'dispatch-commit', ... }] }` -> `describeGateFailures`) -- proving
    // this was caught AT the leaf dispatch boundary, not merely that the
    // outward result happened to read non-'completed' for some unrelated
    // reason.
    expect(runBody.status, JSON.stringify(runBody)).toBe('blocked');
    expect(runBody.diagnostics.join(' ')).toMatch(/cancelled before process start/);
    expect(runBody.cancelRequested).toBe(true);
    // The real fixture worker process was never spawned at all -- it would
    // have recorded at least a 'call' event into this file otherwise.
    await expect(readFile(recordPath, 'utf8')).rejects.toThrow();
  }, 20000);
});

// ---------------------------------------------------------------------------
// #2892 M4: seenRequestIds (replay protection) is bounded, never evicting a
// request id whose invocation is still live/uncertain/retained-terminal.
// ---------------------------------------------------------------------------
describe('bounded replay-protection memory (#2892 M4)', () => {
  it('seenRequestIds stays bounded by maxRetained once invocations are pruned away', () => {
    let clock = 0;
    const registry = createInvocationRegistry({ maxActive: 1000, maxRetained: 5, ttlMs: Number.MAX_SAFE_INTEGER, now: () => clock });
    for (let i = 0; i < 50; i++) {
      const entry = registry.create({ requestId: `req-${i}` });
      registry.markTerminal(entry.invocationId, { status: 'completed', termination: 'confirmed' });
      clock += 1;
    }
    expect(registry.size).toBeLessThanOrEqual(5);
    expect(registry.seenCount).toBeLessThanOrEqual(5);
  });

  it('never evicts a request id while its invocation is still live, even past maxRetained', () => {
    let clock = 0;
    const registry = createInvocationRegistry({ maxActive: 1000, maxRetained: 3, ttlMs: Number.MAX_SAFE_INTEGER, now: () => clock });
    const live = registry.create({ requestId: 'live-req' }); // never terminal
    for (let i = 0; i < 20; i++) {
      const entry = registry.create({ requestId: `term-${i}` });
      registry.markTerminal(entry.invocationId, { status: 'completed', termination: 'confirmed' });
      clock += 1;
    }
    expect(registry.claimRequestId('live-req')).toBe(live.invocationId);
  });
});

// ---------------------------------------------------------------------------
// #2892 D1: default maxActive honors the project's own parallelism policy.
// ---------------------------------------------------------------------------
describe('default concurrency cap honors project parallelism policy (#2892 D1)', () => {
  it('caps the default maxActive at aiwg.config parallelism.max_parallel_subagents when lower than the code default', async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, '.aiwg'), { recursive: true });
    await writeFile(path.join(root, '.aiwg', 'aiwg.config'), JSON.stringify({
      version: '1', providers: ['claude'], parallelism: { max_parallel_subagents: 2 },
    }));
    const work = path.join(root, 'work'); await mkdir(work);
    await writeFile(path.join(root, 'brief.md'), 'hello');
    const tools = await captureTool(undefined, {
      projectRoot: root, workerWorktreesRoot: work,
      loadWorkerInputs: async () => { throw new Error('stop-here'); },
    });
    const call = tools.get('worker-invoke').handler;
    const attempts = await Promise.all(Array.from({ length: 3 }, (_, i) => call({
      operation: 'run', request_id: `cap-${i}`, role: 'coding', task: 'implementation', group: 'workers',
      brief: path.join(root, 'brief.md'), workdir: work, final_output: path.join(work, `final-${i}.json`), transport: 'shell',
    })));
    expect(attempts.filter(r => !r.isError).length).toBe(2);
    expect(attempts.filter(r => r.isError).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Defect 3: TTL + live-only bounded invocation registry — never a permanent
// lockout.
// ---------------------------------------------------------------------------
describe('invocation registry (#2892 defect 3)', () => {
  it('capacity is checked against LIVE runs only; terminal accumulation never blocks new runs', () => {
    let clock = 0;
    const registry = createInvocationRegistry({ maxActive: 2, maxRetained: 128, ttlMs: 10 * 60 * 1000, now: () => clock });
    // 200 sequential completed runs, each terminal before the next starts.
    for (let i = 0; i < 200; i++) {
      expect(registry.canStart()).toBe(true);
      const entry = registry.create({ requestId: `req-${i}` });
      registry.markTerminal(entry.invocationId, { status: 'completed', termination: 'confirmed' });
      clock += 1000;
    }
    expect(registry.canStart()).toBe(true);
    expect(registry.size).toBeLessThanOrEqual(128);
  });

  it('bounds retained entries by evicting oldest-terminal first, never a live one', () => {
    let clock = 0;
    const registry = createInvocationRegistry({ maxActive: 50, maxRetained: 5, ttlMs: Number.MAX_SAFE_INTEGER, now: () => clock });
    const live = registry.create({ requestId: 'live-1' });
    for (let i = 0; i < 20; i++) {
      const entry = registry.create({ requestId: `term-${i}` });
      registry.markTerminal(entry.invocationId, { status: 'completed', termination: 'confirmed' });
      clock += 1;
    }
    expect(registry.size).toBeLessThanOrEqual(5);
    expect(registry.get(live.invocationId)).toBeDefined(); // the live entry is never evicted
  });

  it('evicts terminal entries once their TTL elapses', () => {
    let clock = 0;
    const registry = createInvocationRegistry({ maxActive: 10, maxRetained: 128, ttlMs: 1000, now: () => clock });
    const entry = registry.create({ requestId: 'ttl-1' });
    registry.markTerminal(entry.invocationId, { status: 'completed', termination: 'confirmed' });
    clock = 500;
    expect(registry.get(entry.invocationId)).toBeDefined();
    clock = 1500;
    expect(registry.get(entry.invocationId)).toBeUndefined();
  });

  // #2915 round 8 review 8 (C7): "reconciliation neither completes
  // capacity cleanup nor survives registry eviction" -- the mapping from
  // invocation id to its breaker must be retained while the breaker still
  // reports an unresolved stop for it, independent of the ordinary
  // terminal TTL/over-capacity sweep, so `status`/`reconcile_stopped`
  // never answer "Unknown invocation_id" for a marker that demonstrably
  // still exists.
  it('retains a terminal entry past its TTL while its breaker still reports an unresolved stop, and evicts it once resolved', () => {
    let clock = 0;
    const registry = createInvocationRegistry({ maxActive: 10, maxRetained: 128, ttlMs: 1000, now: () => clock });
    let unresolved = true;
    const fakeBreaker = { hasUnresolvedStop: (_id: string) => unresolved };
    const entry = registry.create({ requestId: 'unresolved-ttl-1' });
    registry.update(entry.invocationId, { recoveryBreaker: fakeBreaker });
    registry.markTerminal(entry.invocationId, { status: 'uncertain', termination: 'uncertain' });
    clock = 1500; // past the TTL
    expect(registry.get(entry.invocationId), 'retained while unresolved, past its own TTL').toBeDefined();
    unresolved = false; // reconciled
    expect(registry.get(entry.invocationId), 'evicted once resolved and past TTL').toBeUndefined();
  });

  it('retains an unresolved entry even when it would otherwise be the oldest evicted under maxRetained pressure', () => {
    let clock = 0;
    const registry = createInvocationRegistry({ maxActive: 50, maxRetained: 3, ttlMs: Number.MAX_SAFE_INTEGER, now: () => clock });
    const fakeBreaker = { hasUnresolvedStop: () => true };
    const unresolvedEntry = registry.create({ requestId: 'unresolved-capacity-1' });
    registry.update(unresolvedEntry.invocationId, { recoveryBreaker: fakeBreaker });
    registry.markTerminal(unresolvedEntry.invocationId, { status: 'uncertain', termination: 'uncertain' });
    clock += 1;
    // Fill past maxRetained with ordinary (resolved) terminal entries --
    // the unresolved entry above is strictly the OLDEST, so it would be
    // the very first evicted by the ordinary oldest-terminal-first sweep.
    for (let i = 0; i < 10; i++) {
      const entry = registry.create({ requestId: `ordinary-${i}` });
      registry.markTerminal(entry.invocationId, { status: 'completed', termination: 'confirmed' });
      clock += 1;
    }
    expect(registry.get(unresolvedEntry.invocationId), 'the unresolved entry survives despite being the oldest').toBeDefined();
    expect(registry.size).toBeLessThanOrEqual(3 + 1); // the exemption is bounded to the one unresolved entry
  });

  it('refuses to start when live concurrency is at maxActive, independent of history', () => {
    const registry = createInvocationRegistry({ maxActive: 1 });
    registry.create({ requestId: 'live-only' });
    expect(registry.canStart()).toBe(false);
  });

  it('never blind-replays a request_id, live or terminal', () => {
    const registry = createInvocationRegistry();
    const entry = registry.create({ requestId: 'dup' });
    expect(registry.claimRequestId('dup')).toBe(entry.invocationId);
    registry.markTerminal(entry.invocationId, { status: 'completed', termination: 'confirmed' });
    expect(registry.claimRequestId('dup')).toBe(entry.invocationId);
  });
});

// ---------------------------------------------------------------------------
// Defect 5: no scratch/plan directory is ever created in the first place
// (the #2896 reference bridge's leak source), so an uncertain run leaves
// nothing behind to clean up.
// ---------------------------------------------------------------------------
describe('no scratch directory is created, even on an uncertain run (#2892 defect 5)', () => {
  it('leaves tmpdir unchanged when a run ends uncertain', async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work');
    await mkdir(work);
    await writeFile(path.join(root, 'brief.md'), 'hello');
    const f = buildFixture(root, 'shell');
    f.snapshot.config.parallelism!.health = { hardTimeoutSeconds: 1 };
    const tools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); } }, {
      projectRoot: root, workerWorktreesRoot: work,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }),
      launchShellWorker: async () => (
        // Simulate a launch whose process never terminates confirmedly.
        { launched: true, mode: 'degraded', child: fakeNeverClosingChild() }
      ),
      waitForUnitTermination: async () => ({ termination: 'uncertain', exitCode: null }),
      shellStopGraceMs: 20, now: () => new Date(f.now),
    });
    const call = tools.get('worker-invoke').handler;
    const { readdir } = await import('node:fs/promises');
    const before = new Set(await readdir(os.tmpdir()));
    const result = await call({
      operation: 'run', request_id: 'uncertain-1', role: 'coding', task: 'implementation', group: 'workers',
      brief: path.join(root, 'brief.md'), workdir: work, final_output: path.join(work, 'final.json'),
      transport: 'shell',
    });
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe('uncertain');
    const after = await readdir(os.tmpdir());
    // Other test files share this OS tmpdir and run concurrently, so assert
    // only that THIS module never created an `aiwg-mcp-worker-*` scratch dir
    // — not that the shared tmpdir is otherwise untouched.
    const created = after.filter(name => !before.has(name) && name.startsWith('aiwg-mcp-worker-'));
    expect(created).toEqual([]);
  }, 10000);
});

/** A pid-bearing child whose observation fails and whose close is unknown. */
function fakeNeverClosingChild() {
  const child: any = new EventEmitter();
  child.pid = 123456;
  child.kill = () => true;
  setImmediate(() => child.emit('error', new Error('synthetic: worker process unobservable')));
  return child;
}

/** Minimal #2887 fixture + driver wiring, closely modeled on the CLI's own
 * `models-direct-invocation.test.ts` fixture builder — reused shape, not a
 * parallel contract. */
function buildFixture(root: string, transport: 'shell' | 'mcp') {
  const f = workerResolutionFixture();
  // The shared fixture's synthetic model observation has a tiny 4096-token context window
  // (test/conformance/mission-v1/fixtures/worker-contracts/shared-vectors.json
  // "observation-no-effort"). Admission (resolveWorkerInvocation, src/serve/worker-invocation.ts)
  // estimates `briefTokens` as the raw byte length of the structured WorkerDirectBrief, which
  // embeds this test's absolute workdir/final_output paths (built under TMPDIR via
  // `tempRoot()`/os.tmpdir()). With the default short /tmp this fits; with a longer TMPDIR (for
  // example a `/var/tmp/<name>` override) the extra path bytes alone were enough to push the
  // estimate over the 4096-token budget — every launch was then refused as 'blocked' with
  // `plan.selected === null`, whose per-candidate `OG_MODEL_UNAPPROVED /worker/contextTokens`
  // reason lives only in `plan.exclusions`, never in the diagnostics this test observes. Widen
  // the window so admission in this file is independent of the host's TMPDIR path length; no
  // assertion here depends on the specific 4096/1024 figures.
  for (const model of f.snapshot.catalog.discovery!.instances!.codex.models) {
    model.worker!.contextTokens = 200000;
    model.worker!.maxOutputTokens = 32000;
  }
  const adapter = f.snapshot.registry.providers.codex.workerAdapter!;
  adapter.id = 'codex';
  const binding = f.snapshot.installations.codex;
  binding.boundary = { kind: 'os', identity: 'fixture:enforcing-boundary', digest: digest('boundary'), controls: ['sandbox'] };
  const profile = adapter.invocationProfiles[binding.profile];
  profile.transport = transport;
  profile.envAllowlist = ['AIWG_FAKE_WORKER_CONFIG'];
  const inputSchema = structuredClone(workerInputSchema);
  const outputSchema = structuredClone(workerOutputSchema);
  let buildInvocation: any;
  if (transport === 'mcp') {
    profile.mcp = { serverRef: 'fixture-server', tool: 'fixture-worker', inputSchemaDigest: digest(inputSchema),
      outputSchemaDigest: digest(outputSchema), sessionIsolation: 'per-call', cancel: 'uncertain' };
    binding.mcp = profile.mcp;
    buildInvocation = async (input: any) => ({ mcp: { serverRef: profile.mcp.serverRef, tool: profile.mcp.tool,
      inputSchemaDigest: profile.mcp.inputSchemaDigest, outputSchemaDigest: profile.mcp.outputSchemaDigest,
      sessionIsolation: profile.mcp.sessionIsolation, timeoutSeconds: 30,
      arguments: { invocationId: 'fixture-task', workspace: input.cwd,
        selection: { provider: input.selected.inferenceProvider, model: input.selected.model, effort: input.selected.effort.value },
        brief: input.brief } } });
  } else {
    buildInvocation = async (input: any) => ({
      argv: [process.execPath, path.resolve('test/fixtures/ralph-worker-cli.mjs'), '--model', input.selected.model,
        '--effort', input.selected.effort.value, '--sandbox', input.permissions.sandbox, '--approval', input.permissions.approval,
        '--final-output', input.finalPath],
      stdin: 'brief-text' as const, envNames: profile.envAllowlist,
    });
  }
  const drivers: Record<string, WorkerInvocationDriver> = { codex: { qualification: {
    adapter, adapterId: 'codex', cliVersion: '1.0.0', boundary: binding.boundary,
    ...(transport === 'mcp' ? { mcp: binding.mcp, mcpSchemas: { input: inputSchema, output: outputSchema } } : {}),
  }, buildInvocation,
    mcpRegistry: { get: async (name: string) => ({ name, type: 'stdio' as const, command: 'fixture-only' }) },
    mcpProfile: { servers: ['fixture-server'] } } };
  f.snapshot.config.parallelism!.groups!.workers.execution = { transport };
  if (transport === 'mcp') {
    // #2892 F4: the mcp transport now REQUIRES a structured WorkerDirectBrief
    // whose `intent.dataClass` must resolve against a KNOWN data class
    // (src/models/provider-policy.ts workerRouteDataPolicy) — the fixture's
    // own merged policy defines none by default, so any value would be
    // denied as OG_DATA_POLICY. 'local-only' here is used consistently by
    // `buildStructuredBrief` below.
    f.snapshot.models.defaults.workerSelection!.dataClasses = { 'local-only': {} };
  }
  return { ...f, drivers, adapter, binding, profile, now: f.request.now };
}

/**
 * #2892 F4: build a WorkerDirectBrief that matches both the given request's
 * own fields AND the exact selected tuple / policy / catalog digests THIS
 * fixture's resolver would compute for it. Two-pass: probe-resolve once
 * with a placeholder (plain-text) brief to learn those values (never
 * hand-guessed), then write a real structured, schema-valid brief using
 * them, pinning `intent.pins` to the already-resolved tuple so the SECOND
 * (real) resolution — now recognizing the brief as structured — reaches
 * the identical selection deterministically rather than diverging.
 * Required because the mcp transport now REQUIRES a structured brief at
 * admission (#2892 F4); every mcp-transport test that previously wrote a
 * plain-text brief needs one of these instead.
 */
async function buildStructuredBrief(f: ReturnType<typeof buildFixture>, request: {
  role: 'efficiency' | 'coding' | 'reasoning'; task: string; group: string;
  brief: string; workdir: string; final_output: string; transport: 'mcp';
}) {
  await writeFile(request.brief, 'placeholder-before-structured-brief');
  const probe = await resolveWorkerInvocation(f.snapshot, request as any, f.drivers, new Date(f.now).toISOString());
  if (probe.invocation?.readiness !== 'launchable') {
    throw new Error(`buildStructuredBrief probe did not launch: ${JSON.stringify(probe.diagnostics)}`);
  }
  const inv = probe.invocation;
  const brief = {
    version: 1,
    invocationId: 'fixture-brief-1',
    intent: {
      version: 1, taskId: 'fixture-task', requestId: 'fixture-request',
      objective: 'Synthetic fixture task for #2892 MCP transport tests',
      taskClass: request.task, role: request.role,
      inputs: [] as unknown[], ownership: [] as string[], requiredTools: [] as string[],
      dataClass: 'local-only', group: request.group,
      pins: { member: inv.selected.member, model: inv.selected.model, effort: inv.selected.effort },
      allowFallback: false,
      limits: { tokens: inv.limits.tokens, costUsd: inv.limits.costUsd, wallSeconds: inv.limits.wallSeconds, maxAttempts: inv.limits.maxAttempts },
      acceptance: [{ id: 'AC1', criterion: 'Synthetic fixture acceptance', checkRef: 'protected:fixture' }],
      verification: { runnerRef: null, independentReview: 'advisory', differentFamily: 'prefer', controlledContext: 'fixture-only' },
    },
    intentDigest: `sha256:${'a'.repeat(64)}`,
    policyDigest: inv.policyDigest,
    catalogDigest: inv.catalogDigest,
    selected: inv.selected,
    workspace: { path: request.workdir, baseRevision: null },
    authorizationRefs: [] as string[],
    delegationAllowance: 0,
    output: { schemaRef: 'https://aiwg.io/schemas/mission.aiwg.io/v1#/$defs/workerClaims', resultPath: request.final_output },
    mode: 'direct',
  };
  assertValidWorkerPayload('workerDirectBrief', brief);
  await writeFile(request.brief, JSON.stringify(brief));
  return brief;
}

// ---------------------------------------------------------------------------
// End-to-end run/status/cancel through the real resolve pipeline, using
// injected launch/mcp-call so the test does not depend on a live systemd
// user manager (CI runs as root with none) or a real provider installation.
// ---------------------------------------------------------------------------
describe('run/status/cancel lifecycle (shell transport, injected launch)', () => {
  it('resolves, launches, parses the fixture CLI final, and reports completed', async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work);
    const briefPath = path.join(root, 'brief.md');
    await writeFile(briefPath, 'hello worker');
    const finalPath = path.join(work, 'final.json');
    const f = buildFixture(root, 'shell');
    const claims = { version: 1, status: 'completed', summary: 'ok', claims: [], artifacts: [], checks: [], limitations: [] };
    const tools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); } }, {
      projectRoot: root, workerWorktreesRoot: work,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }),
      launchShellWorker: async invocation => {
        // Simulate the worker producing its final output sometime during
        // the run (never ahead of validation/reservation).
        await writeFile(invocation.finalPath, `${JSON.stringify({ type: 'result', result: claims })}\n`);
        return { launched: true, mode: 'degraded', child: closingChild(0) };
      },
      now: () => new Date(f.now),
    });
    const call = tools.get('worker-invoke').handler;
    const result = await call({
      operation: 'run', request_id: 'ok-1', role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalPath, transport: 'shell',
    });
    const body = JSON.parse(result.content[0].text);
    expect(body.status, JSON.stringify(body)).toBe('completed');
    expect(body.termination).toBe('confirmed');
  });

  it('status/cancel on an unknown invocation_id errors instead of inventing state', async () => {
    const root = await tempRoot();
    const tools = await captureTool(undefined, { projectRoot: root });
    const call = tools.get('worker-invoke').handler;
    for (const operation of ['status', 'cancel']) {
      const result = await call({ operation, invocation_id: '00000000-0000-4000-8000-000000000000' });
      expect(result.isError).toBe(true);
    }
  });
});

function closingChild(exitCode: number) {
  const child: any = new EventEmitter();
  child.kill = () => true;
  setImmediate(() => child.emit('close', exitCode));
  return child;
}

// #2915 review 6 (finding 3, "MCP and standalone planner never debit"):
// `run()` previously reserved allowance through `admitDirectWorker` but
// never called `debitDirectWorkerAllowance` — five fresh requests for the
// same task chain with `maxAttempts: 1` each dispatched and completed
// through the real queue/admission/launch pipeline. These regression
// tests drive the real `run()` handler (via `registerWorkerInvokeToolset`)
// end to end, proving only the first of five requests for the SAME task
// chain actually reaches the injected launcher on both transports this
// bridge supports.
describe('allowance ledger debits at the actual dispatch boundary (#2915 review 6, finding 3)', () => {
  it('five fresh shell-transport requests with maxAttempts 1 dispatch exactly one', async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work);
    const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'hello worker');
    const f = buildFixture(root, 'shell');
    f.snapshot.config.parallelism.retry = { maxAttempts: 1 };
    const claims = { version: 1, status: 'completed', summary: 'ok', claims: [], artifacts: [], checks: [], limitations: [] };
    let dispatches = 0;
    const tools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); } }, {
      projectRoot: root, workerWorktreesRoot: work,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }),
      // #2915 round 8 (D2): this stub stands in for the WHOLE
      // `defaultLaunchShellWorker` -> `planDirectWorkerLaunch` ->
      // `launchIsolatedWorker` chain, so it must itself drive the same
      // `beginDispatch` -> debit -> `commitDispatch` bracket the real D2
      // dispatch-commit hook performs immediately before a real process
      // would start — otherwise this test's own replacement silently
      // bypasses the ledger entirely, proving nothing about debiting at
      // the real dispatch boundary.
      launchShellWorker: async (invocation: any, options: any) => {
        const admission = options?.admission;
        if (admission?.gated) {
          const began = admission.breaker.beginDispatch(admission.token,
            { invocationId: admission.invocationId, selectionDigest: admission.selectionDigest });
          if (!began.ok) return { launched: false, blocked: true, diagnostic: began.reason };
          if (admission.ledger) {
            const sessionLauncher = await import('../../../tools/ralph-external/session-launcher.mjs');
            await sessionLauncher.debitDirectWorkerAllowance(admission.ledger);
          }
          admission.breaker.commitDispatch(admission.token);
        }
        dispatches += 1;
        await writeFile(invocation.finalPath, `${JSON.stringify({ type: 'result', result: claims })}\n`);
        return { launched: true, mode: 'degraded', child: closingChild(0) };
      },
      now: () => new Date(f.now),
    });
    const call = tools.get('worker-invoke').handler;
    const bodies: any[] = [];
    for (let n = 0; n < 5; n += 1) {
      const finalPath = path.join(work, `final-shell-${n}.json`);
      // Same role/task/group/brief every time -- the same task-chain digest,
      // exactly the "same task, retried" shape the allowance ledger governs.
      const result = await call({
        operation: 'run', request_id: `ledger-shell-${n}`, role: 'coding', task: 'implementation', group: 'workers',
        brief: briefPath, workdir: work, final_output: finalPath, transport: 'shell',
      });
      bodies.push(JSON.parse(result.content[0].text));
    }
    expect(dispatches).toBe(1);
    expect(bodies[0].status, JSON.stringify(bodies[0])).toBe('completed');
    for (const body of bodies.slice(1)) {
      expect(body.status, JSON.stringify(body)).toBe('blocked');
      expect(body.diagnostics.join(' ')).toMatch(/ALLOWANCE_EXHAUSTED/);
    }
  });

  it('five fresh native-MCP requests with maxAttempts 1 dispatch exactly one', async () => {
    const root = await tempRoot();
    const config = path.join(root, 'fixture-config.json');
    await writeFile(config, JSON.stringify({ recordPath: path.join(root, 'record.jsonl'), scenario: 'success' }));
    const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
    const briefPath = path.join(root, 'brief.md');
    const f = buildFixture(root, 'mcp');
    f.snapshot.config.parallelism!.retry = { maxAttempts: 1 };
    f.drivers.codex.mcpRegistry = {
      get: async () => ({ name: 'fixture-server', type: 'stdio' as const, command: process.execPath,
        args: [path.resolve('test/fixtures/ralph-worker-mcp.mjs')], env: { AIWG_FAKE_WORKER_CONFIG: config } }),
    };
    // `resolveWorkerInvocation` itself refuses (OG_PIN_MISMATCH) unless a
    // structured brief's own `output.resultPath` equals the REQUEST's
    // `final_output` exactly -- so, unlike the shell-transport test above,
    // every one of these 5 calls must reuse the SAME `final_output` (the
    // SAME brief bytes, hence the SAME task-chain digest). `reserveFinalOutput`
    // exclusively creates that path on request 1 and is never released on a
    // 'completed' run (mcp transport never writes through `finalPath`
    // itself); removing the empty placeholder before each later call
    // isolates the one thing this test actually probes -- ledger admission
    // -- from that unrelated path-reservation mechanism.
    const finalOutput = path.join(work, 'final.json');
    await buildStructuredBrief(f, { role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp' });
    const tools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, cfg: any, handler: any) { tools.set(name, { config: cfg, handler }); } }, {
      projectRoot: root, allowDegraded: true, workerWorktreesRoot: work,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }), now: () => new Date(f.now),
      gateInputs: { live: HEALTHY_GATE_LIVE },
    });
    const call = tools.get('worker-invoke').handler;
    const bodies: any[] = [];
    for (let n = 0; n < 5; n += 1) {
      if (n > 0) await rm(finalOutput, { force: true });
      const result = await call({
        operation: 'run', request_id: `ledger-mcp-${n}`, role: 'coding', task: 'implementation', group: 'workers',
        brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp',
      });
      bodies.push(JSON.parse(result.content[0].text));
    }
    expect(bodies[0].status, JSON.stringify(bodies[0])).toBe('completed');
    for (const body of bodies.slice(1)) {
      expect(body.status, JSON.stringify(body)).toBe('blocked');
      expect(body.diagnostics.join(' ')).toMatch(/ALLOWANCE_EXHAUSTED/);
    }
  }, 20000);
});

// ---------------------------------------------------------------------------
// T-OG-17: real fake stdio MCP worker — success, isError, disconnect, and
// two concurrent tasks sharing no model/workspace/output state. Routed
// through the SAME gate-then-launch pipeline as shell (#2892 B2):
// `allowDegraded: true` mirrors an operator who set
// `AIWG_MCP_WORKER_ALLOW_DEGRADED=1`, needed on hosts with no reachable
// systemd --user manager (CI runs as root with none). `worker_dispatch`
// stays true (workerResolutionFixture's default), so the REAL launch-time
// gate (`checkWorkerDispatch`) still runs on every `invoke()` call here —
// but against the fixed, generous `HEALTHY_GATE_LIVE` sample injected via
// `gateInputs`, not this host's actual load/memory/PSI/disk, so these
// transport/schema/env-allowlist/cancellation tests are deterministic
// regardless of host load (CI flake: a busy runner's real signals could
// legitimately trip the gate and refuse the launch before transport was
// ever exercised). A dedicated test below ('still refuses a launch when an
// injected signal fails the gate') proves the gate is still consulted, not
// bypassed, by injecting a deliberately failing sample.
// ---------------------------------------------------------------------------
describe('mcp transport against the real fake stdio worker (T-OG-17)', () => {
  function mcpFixture(root: string, config: string) {
    const f = buildFixture(root, 'mcp');
    // `worker_dispatch` stays true (workerResolutionFixture's default): the
    // models RESOLVER itself treats `worker_dispatch: false` as "disabled",
    // producing no plan at all (src/models/resolver.ts) — it is not merely
    // this bridge's own launch-time resource gate. The launch-time gate
    // (`checkWorkerDispatch`) therefore still runs on every call below; see
    // `HEALTHY_GATE_LIVE` / `gateInputs` for how its live signals are pinned.
    f.drivers.codex.mcpRegistry = {
      get: async () => ({ name: 'fixture-server', type: 'stdio' as const, command: process.execPath,
        args: [path.resolve('test/fixtures/ralph-worker-mcp.mjs')], env: { AIWG_FAKE_WORKER_CONFIG: config } }),
    };
    return f;
  }
  async function prepareInvocation(root: string, config: string, extra: Record<string, unknown> = {}, registerOverrides: Record<string, unknown> = {}) {
    const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
    const briefPath = path.join(root, 'brief.md');
    const finalOutput = path.join(work, 'final.json');
    const f = mcpFixture(root, config);
    // #2892 F4: a plain-text brief is no longer accepted on the mcp
    // transport — build a matching structured one (see buildStructuredBrief).
    await buildStructuredBrief(f, { role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp' });
    const tools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, cfg: any, handler: any) { tools.set(name, { config: cfg, handler }); } }, {
      projectRoot: root, allowDegraded: true, workerWorktreesRoot: work,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }), now: () => new Date(f.now),
      // CI determinism (see describe-block comment above): the REAL gate
      // still runs, on this fixed healthy sample, unless a test overrides it.
      gateInputs: { live: HEALTHY_GATE_LIVE },
      ...registerOverrides,
    });
    const call = tools.get('worker-invoke').handler;
    return { call, input: { operation: 'run', request_id: `mcp-${Math.random()}`, role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp', ...extra } };
  }
  async function invoke(root: string, config: string, extra: Record<string, unknown> = {}, registerOverrides: Record<string, unknown> = {}) {
    const { call, input } = await prepareInvocation(root, config, extra, registerOverrides);
    return call(input);
  }

  it.each(['overflow-load', 'client-constructor'])('does not launch when pre-launch setup fails (%s)', async failure => {
    const root = await tempRoot();
    const launch = vi.fn(() => ({ launched: false, diagnostic: 'unexpected launch' }));
    vi.doMock('../../../tools/ralph-external/session-launcher.mjs', async () => ({
      ...await vi.importActual('../../../tools/ralph-external/session-launcher.mjs'), planDirectWorkerLaunch: launch,
    }));
    if (failure === 'overflow-load') {
      vi.doMock('../../../tools/ralph-external/lib/worker-overflow.mjs', () => { throw new Error('overflow module unavailable'); });
    } else {
      vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
        Client: class { constructor() { throw new Error('client construction failed'); } },
      }));
    }
    try {
      const body = JSON.parse((await invoke(root, '')).content[0].text);
      expect(body.status, JSON.stringify(body)).toBe('blocked');
      expect(body.termination).toBe('confirmed');
      expect(body.diagnostics.join('; ')).toMatch(failure === 'overflow-load' ? /mocking a module|overflow module unavailable/ : /client construction failed/);
      expect(launch).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('../../../tools/ralph-external/session-launcher.mjs');
      vi.doUnmock('../../../tools/ralph-external/lib/worker-overflow.mjs');
      vi.doUnmock('@modelcontextprotocol/sdk/client/index.js');
    }
  });

  it('stops a launch if registering its control throws before connecting', async () => {
    const root = await tempRoot();
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(), stdin: { destroy: vi.fn() }, stdout: { destroy: vi.fn() } });
    const launched = { launched: true, mode: 'degraded', child };
    const stop = vi.fn(async () => ({ termination: 'uncertain' }));
    const close = vi.fn(async () => {});
    const connect = vi.fn();
    vi.doMock('../../../tools/ralph-external/session-launcher.mjs', async () => ({
      ...await vi.importActual('../../../tools/ralph-external/session-launcher.mjs'), planDirectWorkerLaunch: () => launched,
    }));
    vi.doMock('../../../tools/ralph-external/lib/worker-overflow.mjs', () => ({ stopOverflowWorker: stop }));
    vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
      Client: class { close = close; connect = connect; async notification() {} },
    }));
    const registry = createInvocationRegistry();
    const update = registry.update;
    registry.update = (id: string, patch: any) => {
      if (patch.control) throw new Error('control registration failed');
      return update(id, patch);
    };
    try {
      const body = JSON.parse((await invoke(root, '', {}, { registry })).content[0].text);
      expect(body.status).toBe('uncertain');
      expect(stop).toHaveBeenCalledWith(launched);
      expect(connect).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalled();
    } finally {
      vi.doUnmock('../../../tools/ralph-external/session-launcher.mjs');
      vi.doUnmock('../../../tools/ralph-external/lib/worker-overflow.mjs');
      vi.doUnmock('@modelcontextprotocol/sdk/client/index.js');
    }
  });

  it.skipIf(process.platform !== 'linux' || !supportsCapturedWorkerStdio)('retains capacity and control after each unconfirmed degraded overflow', async () => {
    const root = await tempRoot();
    const script = path.join(root, 'hostile-worker.mjs');
    const pidPath = path.join(root, 'worker.pid');
    await writeFile(script, `import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], String(process.pid));
process.on('SIGTERM', () => {});
process.stdout.write(Buffer.alloc(12 * 1024 * 1024, 120));
setInterval(() => {}, 1000);
`);
    const f = mcpFixture(root, path.join(root, 'unused-config.json'));
    f.drivers.codex.mcpRegistry = {
      get: async () => ({ name: 'fixture-server', type: 'stdio' as const, command: process.execPath, args: [script, pidPath] }),
    };
    for (let i = 0; i < 6; i++) {
      resetInProcessAllowanceLedger();
      const registry = createInvocationRegistry({ maxActive: 1 });
      let pid: number | undefined;
      try {
        const result = await invoke(root, '', {}, { registry, loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }) });
        pid = Number(await readFile(pidPath, 'utf8'));
        const body = JSON.parse(result.content[0].text);
        expect(body.status, JSON.stringify(body)).toBe('uncertain');
        expect(body.termination).toBe('uncertain');
        expect(body.diagnostics.join('; ')).toContain('OG_WORKER_MCP_FRAME_TOO_LARGE');
        const [entry] = registry.values();
        expect(entry.terminalAt).toBeNull();
        expect(entry.control?.stop).toBeTypeOf('function');
        expect(registry.canStart()).toBe(false);
        // SIGKILL delivery precedes process exit and reaping.
        await vi.waitFor(() => {
          expect(() => process.kill(pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
        }, { timeout: 2000, interval: 25 });
        await rm(path.join(root, 'work', 'final.json'), { force: true });
      } finally {
        pid ??= Number(await readFile(pidPath, 'utf8').catch(() => '0'));
        if (pid > 0) { try { process.kill(pid, 'SIGKILL'); } catch { /* already reaped */ } }
      }
    }
  }, 30000);

  it.each(['confirmed', 'uncertain'])('awaits %s overflow evidence and releases capacity only with proof repeatedly', async termination => {
    const root = await tempRoot();
    const registry = createInvocationRegistry({ maxActive: 1 });
    for (let i = 0; i < 6; i++) {
      let confirm!: (value: any) => void;
      let stopStarted = false;
      const proof = new Promise(resolve => { confirm = resolve; });
      const stop = vi.fn(async () => ({ termination: 'confirmed', delivered: true }));
      const { call, input } = await prepareInvocation(root, '', {}, { registry, callMcpWorker: async (_binding: any, _server: any, options: any) => {
        options.registerControl({ stop });
        const { transport, emit } = await transportFixture({ terminate: () => { stopStarted = true; return proof; } });
        emit(Buffer.alloc(MAX_MCP_FRAME_BYTES + 1, 120));
        const evidence = await transport._termination;
        return { outcome: 'disconnected', ...evidence, diagnostic: [transport._failure.code, evidence.diagnostic].filter(Boolean).join('; ') };
      } });
      const run = call(input);
      await waitFor(() => stopStarted);
      expect(registry.values().filter((entry: any) => entry.terminalAt === null)).toHaveLength(1);
      confirm({ termination, ...(termination === 'uncertain' ? { diagnostic: 'OG_WORKER_MCP_STOP_FAILED' } : {}) });
      const body = JSON.parse((await run).content[0].text);
      expect(body.status, JSON.stringify(body)).toBe(termination === 'confirmed' ? 'failed' : 'uncertain');
      expect(body.termination).toBe(termination);
      if (termination === 'uncertain') expect(body.diagnostics.join('; ')).toContain('OG_WORKER_MCP_STOP_FAILED');
      if (termination === 'uncertain') {
        expect(registry.canStart()).toBe(false);
        const blocked = JSON.parse((await call({ ...input, request_id: `blocked-${i}` })).content[0].text);
        expect(blocked.error).toContain('capacity is reserved');
        const cancelled = JSON.parse((await call({ operation: 'cancel', invocation_id: body.invocationId })).content[0].text);
        expect(cancelled.termination).toBe('confirmed');
        expect(stop).toHaveBeenCalledOnce();
      }
      expect(registry.values().filter((entry: any) => entry.terminalAt === null)).toHaveLength(0);
      expect(registry.canStart()).toBe(true);
      await rm(path.join(root, 'work', 'final.json'), { force: true });
    }
  });

  it.each(['failed', 'unconfirmed', 'confirmed', 'inactive-after-failed-stop'])('retains usable overflow control through MCP finalization (%s)', async initial => {
    const root = await tempRoot();
    const registry = createInvocationRegistry({ maxActive: 1 });
    const { child } = await transportFixture({ start: false });
    const launch = { launched: true, mode: 'systemd-unit', unit: 'fixture-overflow.service', child };
    let stopOk = initial !== 'failed' && initial !== 'inactive-after-failed-stop';
    let active = initial === 'failed' || initial === 'unconfirmed';
    const stopUnit = vi.fn(() => ({ ok: stopOk }));
    const unitStatus = vi.fn(() => ({ active }));
    const realStop = (await vi.importActual<any>('../../../tools/ralph-external/lib/worker-overflow.mjs')).stopOverflowWorker;
    const stop = vi.fn((ownedLaunch: any) => realStop(ownedLaunch, { stopUnit, unitStatus, deadlineMs: 0 }));
    const close = vi.fn(async () => {});
    const notification = vi.fn(async () => { throw new Error('connection closed'); });
    const launchPlan = vi.fn(() => launch);
    vi.doMock('../../../tools/ralph-external/session-launcher.mjs', async () => ({
      ...await vi.importActual('../../../tools/ralph-external/session-launcher.mjs'), planDirectWorkerLaunch: launchPlan,
    }));
    vi.doMock('../../../tools/ralph-external/lib/worker-overflow.mjs', () => ({ stopOverflowWorker: stop }));
    vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => ({
      Client: class {
        close = close;
        notification = notification;
        async connect(transport: any) {
          transport.onerror = () => {};
          await transport.start();
          child.stdout.emit('data', Buffer.alloc(MAX_MCP_FRAME_BYTES + 1, 120));
          throw transport._failure;
        }
      },
    }));
    try {
      const { call, input } = await prepareInvocation(root, '', {}, { registry });
      const body = JSON.parse((await call(input)).content[0].text);
      const entry = registry.get(body.invocationId);
      expect(close).toHaveBeenCalledOnce();
      expect(child.stdout.destroy).toHaveBeenCalledOnce();
      expect(child.stdin.destroy).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledOnce(); // finalization adds no automatic retry
      if (!active) {
        expect(body.status).toBe('failed');
        expect(body.termination).toBe('confirmed');
        expect(entry.control).toBeNull();
        expect(entry.terminalAt).not.toBeNull();
      } else {
        expect(body.status).toBe('uncertain');
        expect(body.terminalAt).toBeNull();
        const control = entry.control;
        expect(control.stop).toBeTypeOf('function');
        const blocked = JSON.parse((await call({ ...input, request_id: 'blocked-before-cancel' })).content[0].text);
        expect(blocked.error).toContain('capacity is reserved');
        expect(launchPlan).toHaveBeenCalledOnce();
        // Delivery alone cannot release the slot, even when the explicit retry succeeds.
        stopOk = true;
        const pending = JSON.parse((await call({ operation: 'cancel', invocation_id: body.invocationId })).content[0].text);
        expect(pending.cancelDelivered).toBe(true);
        expect(pending.termination).toBe('uncertain');
        expect(entry.control).toBe(control);
        expect(registry.canStart()).toBe(false);
        const stillBlocked = JSON.parse((await call({ ...input, request_id: 'blocked-after-delivery' })).content[0].text);
        expect(stillBlocked.error).toContain('capacity is reserved');
        expect(launchPlan).toHaveBeenCalledOnce();
        active = false;
        const stopped = JSON.parse((await call({ operation: 'cancel', invocation_id: body.invocationId })).content[0].text);
        expect(stopped.status).toBe('cancelled');
        expect(stopped.termination).toBe('confirmed');
        expect(entry.control).toBeNull();
        expect(entry.terminalAt).not.toBeNull();
        expect(stop).toHaveBeenCalledTimes(3);
        expect(child.kill).not.toHaveBeenCalled(); // owned unit authority survives pipe closure
      }
      expect(registry.canStart()).toBe(true);
      await rm(input.final_output, { force: true });
      active = false;
      const replacement = JSON.parse((await call({ ...input, request_id: 'replacement-after-proof' })).content[0].text);
      expect(replacement.termination).toBe('confirmed');
      expect(launchPlan).toHaveBeenCalledTimes(2);
    } finally {
      vi.doUnmock('../../../tools/ralph-external/session-launcher.mjs');
      vi.doUnmock('../../../tools/ralph-external/lib/worker-overflow.mjs');
      vi.doUnmock('@modelcontextprotocol/sdk/client/index.js');
    }
  });

  it.skipIf(!supportsCapturedWorkerStdio || process.platform !== 'linux')('success scenario: completed, confirmed termination', async () => {
    const root = await tempRoot();
    const config = path.join(root, 'fixture-config.json');
    await writeFile(config, JSON.stringify({ recordPath: path.join(root, 'record.jsonl'), scenario: 'success' }));
    const result = await invoke(root, config);
    const body = JSON.parse(result.content[0].text);
    expect(body.status, JSON.stringify(body)).toBe('completed');
    expect(body.termination).toBe('confirmed');
  }, 20000);

  // #2915 review 5 ("Production/ownership/fault tests"): the former
  // disabled-dispatch test called `admitDirectWorker` directly -- a unit
  // test of the helper, never proving anything about the real `run()`
  // bridge. Both `worker_dispatch: false` and `clis[cli].enabled: false`
  // ALSO disable the models RESOLVER itself for that CLI (confirmed:
  // probing `resolveWorkerInvocation` directly with this exact config
  // returns "Installation is disabled" exclusions, never a launchable
  // plan) -- so `run()` refuses at the resolver stage, well BEFORE it ever
  // reaches admission. That is itself the proof this test names: the
  // throwing breaker is unreachable not by luck, but because the SAME
  // config field both the resolver and `admitDirectWorker`'s own per-CLI
  // check consult keeps this CLI out of candidate selection entirely.
  it('per-CLI disabled dispatch refuses at the resolver stage through the real run() bridge, never touching the recovery breaker', async () => {
    const root = await tempRoot();
    const config = path.join(root, 'fixture-config.json');
    await writeFile(config, JSON.stringify({ recordPath: path.join(root, 'record.jsonl'), scenario: 'success' }));
    const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
    const briefPath = path.join(root, 'brief.md');
    const finalOutput = path.join(work, 'final.json');
    const f = mcpFixture(root, config);
    f.snapshot.config.parallelism!.clis = { codex: { enabled: false,
      adapter: 'providers:codex', accountScope: 'fixture-account', quotaScope: 'fixture-quota' } };
    await writeFile(briefPath, 'placeholder-before-structured-brief');
    const throwingBreaker = { admit: () => { throw new Error('must never be reached: codex is per-CLI disabled'); } };
    const tools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, cfg: any, handler: any) { tools.set(name, { config: cfg, handler }); } }, {
      projectRoot: root, allowDegraded: true, workerWorktreesRoot: work,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }), now: () => new Date(f.now),
      gateInputs: { live: HEALTHY_GATE_LIVE }, scopedBreaker: throwingBreaker,
    });
    const call = tools.get('worker-invoke').handler;
    const result = await call({ operation: 'run', request_id: `mcp-percli-${Math.random()}`, role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp' });
    const body = JSON.parse(result.content[0].text);
    // Blocked at the resolver, not by a caught admission exception: if the
    // throwing breaker HAD been reached, `admitDirectWorker`'s own
    // try/catch would surface "recovery admission failed closed: ..." in
    // diagnostics instead of the resolver's own unresolved-plan diagnostic.
    expect(body.status, JSON.stringify(body)).toBe('blocked');
    expect(JSON.stringify(body.diagnostics ?? [])).not.toMatch(/recovery admission failed closed/);
  }, 20000);

  it.skipIf(!supportsCapturedWorkerStdio || process.platform !== 'linux')('isError scenario: failed, confirmed termination (never parsed as success)', async () => {
    const root = await tempRoot();
    const config = path.join(root, 'fixture-config.json');
    await writeFile(config, JSON.stringify({ recordPath: path.join(root, 'record.jsonl'), scenario: 'isError' }));
    const result = await invoke(root, config);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe('failed');
    expect(body.termination).toBe('confirmed');
  }, 20000);

  it.skipIf(!supportsCapturedWorkerStdio || process.platform !== 'linux')('disconnect scenario: uncertain, never a blind replay', async () => {
    const root = await tempRoot();
    const config = path.join(root, 'fixture-config.json');
    await writeFile(config, JSON.stringify({ recordPath: path.join(root, 'record.jsonl'), scenario: 'disconnect' }));
    const result = await invoke(root, config);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe('uncertain');
    expect(body.termination).toBe('uncertain');
  }, 20000);

  it.skipIf(!supportsCapturedWorkerStdio || process.platform !== 'linux')('truncation scenario: never accepted as completed (SDK refuses the malformed response before this bridge ever parses it)', async () => {
    const root = await tempRoot();
    const config = path.join(root, 'fixture-config.json');
    await writeFile(config, JSON.stringify({ recordPath: path.join(root, 'record.jsonl'), scenario: 'truncation' }));
    const result = await invoke(root, config);
    const body = JSON.parse(result.content[0].text);
    // #2892 F3 (fix-2892-r2): now that the qualified tool advertises an
    // outputSchema, the REAL MCP SDK's own Client.callTool() refuses a
    // response shaped like 'truncation' (outputSchema present, isError
    // false, no structuredContent) BEFORE this bridge's own strict JSON
    // parsing ever sees the truncated content text — caught by this
    // bridge's own transport-error handling (M2), which keeps the run
    // uncertain (never silently 'completed') rather than the earlier
    // 'failed' outcome from parseWorkerFinal's own strict scanner.
    expect(body.status, JSON.stringify(body)).toBe('uncertain');
    expect(body.status).not.toBe('completed');
  }, 20000);

  it.skipIf(!supportsCapturedWorkerStdio || process.platform !== 'linux')('two concurrent tasks against distinct workspaces share no model/workspace/output state', async () => {
    const rootA = await tempRoot();
    const rootB = await tempRoot();
    const configA = path.join(rootA, 'fixture-config.json');
    const configB = path.join(rootB, 'fixture-config.json');
    await writeFile(configA, JSON.stringify({ recordPath: path.join(rootA, 'record.jsonl'), scenario: 'success' }));
    await writeFile(configB, JSON.stringify({ recordPath: path.join(rootB, 'record.jsonl'), scenario: 'success' }));
    const [a, b] = await Promise.all([invoke(rootA, configA), invoke(rootB, configB)]);
    const bodyA = JSON.parse(a.content[0].text);
    const bodyB = JSON.parse(b.content[0].text);
    expect(bodyA.status).toBe('completed');
    expect(bodyB.status).toBe('completed');
    expect(bodyA.invocationId).not.toBe(bodyB.invocationId);
  }, 30000);

  // #2892 B2: the MCP worker SERVER process must go through the SAME
  // gate-then-launch pipeline as a shell worker — never a bare SDK
  // StdioClientTransport, which always merges its own `getDefaultEnvironment()`
  // (HOME/LOGNAME/PATH/SHELL/TERM/USER from the CONDUCTOR's own `process.env`)
  // into whatever `env` is supplied, silently widening the qualified allowlist.
  it.skipIf(!supportsCapturedWorkerStdio || process.platform !== 'linux')('the spawned MCP worker process receives exactly the allowlisted environment, never the conductor\'s own inherited env', async () => {
    const root = await tempRoot();
    const config = path.join(root, 'fixture-config.json');
    const recordPath = path.join(root, 'record.jsonl');
    await writeFile(config, JSON.stringify({ recordPath, scenario: 'success' }));
    const result = await invoke(root, config);
    const body = JSON.parse(result.content[0].text);
    expect(body.status, JSON.stringify(body)).toBe('completed');
    const lines = (await readFile(recordPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const call = lines.find((l: any) => l.event === 'call');
    expect(call.envNames).toContain('AIWG_FAKE_WORKER_CONFIG');
    // The exact set the SDK's own getDefaultEnvironment() would otherwise
    // have merged in, regardless of qualification — none of these are
    // allowlisted by this fixture's profile.
    for (const name of ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER']) {
      expect(call.envNames).not.toContain(name);
    }
  }, 20000);

  // #2892 M3: a live tools/list schema-digest mismatch refuses before any
  // brief is sent — the fixture's own 'schema-change' scenario changes the
  // advertised digest without ever reaching tools/call.
  it.skipIf(!supportsCapturedWorkerStdio || process.platform !== 'linux')('refuses before any brief is sent when the live tool schema has drifted from the qualified pin', async () => {
    const root = await tempRoot();
    const config = path.join(root, 'fixture-config.json');
    const recordPath = path.join(root, 'record.jsonl');
    await writeFile(config, JSON.stringify({ recordPath, scenario: 'schema-change' }));
    const result = await invoke(root, config);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe('blocked');
    expect(body.diagnostics.join(' ')).toMatch(/schema/i);
    await expect(readFile(recordPath, 'utf8')).rejects.toThrow(); // tools/call was never reached
  }, 20000);

  // #2892 F3 (fix-2892-r2, formerly M3 FAIL): the SDK's own zod validation
  // of `tools/list` silently drops a schema member literally named
  // `__proto__` (`ToolSchema`'s `z.record()` rebuild uses bracket
  // assignment, which for that key name invokes the inherited prototype
  // SETTER rather than creating an own property) — two schemas differing
  // ONLY in that member digest IDENTICALLY once compared via the
  // zod-parsed object, so the drift was invisible and the brief was sent.
  // The fixture's 'schema-proto-drift' scenario advertises exactly that
  // drift; comparing against the RAW wire JSON must still catch it.
  it.skipIf(!supportsCapturedWorkerStdio || process.platform !== 'linux')('refuses a __proto__-only schema variant that the SDK\'s own zod parsing would silently erase (#2892 F3)', async () => {
    const root = await tempRoot();
    const config = path.join(root, 'fixture-config.json');
    const recordPath = path.join(root, 'record.jsonl');
    await writeFile(config, JSON.stringify({ recordPath, scenario: 'schema-proto-drift' }));
    const result = await invoke(root, config);
    const body = JSON.parse(result.content[0].text);
    expect(body.status, JSON.stringify(body)).toBe('blocked');
    expect(body.diagnostics.join(' ')).toMatch(/schema/i);
    await expect(readFile(recordPath, 'utf8')).rejects.toThrow(); // tools/call was never reached
  }, 20000);

  // #2892 F3: a qualified descriptor that records an output schema is
  // never satisfied by a worker that stops advertising one at all — missing
  // must refuse exactly like a digest mismatch, not be silently skipped.
  it.skipIf(!supportsCapturedWorkerStdio || process.platform !== 'linux')('refuses when the live tool stops advertising an output schema the qualified descriptor requires (#2892 F3)', async () => {
    const root = await tempRoot();
    const config = path.join(root, 'fixture-config.json');
    const recordPath = path.join(root, 'record.jsonl');
    await writeFile(config, JSON.stringify({ recordPath, scenario: 'schema-missing-output' }));
    const result = await invoke(root, config);
    const body = JSON.parse(result.content[0].text);
    expect(body.status, JSON.stringify(body)).toBe('blocked');
    expect(body.diagnostics.join(' ')).toMatch(/output schema/i);
    await expect(readFile(recordPath, 'utf8')).rejects.toThrow(); // tools/call was never reached
  }, 20000);

  // #2915 round 8 review 8 (C2, "stop evidence remains incorrectly
  // classified across production paths"): the reviewer's exact probe --
  // schema drift discovered AFTER a real MCP worker SERVER process was
  // spawned (connect + tools/list both completed) must never be reported
  // as a confirmed stop merely because the RESULT LABEL is 'blocked'. The
  // process really was dispatched; `resolveStopEvidence` must be consulted
  // for real evidence (degraded isolation: never confirmed), not a
  // hardcoded `confirmedStop: true`. Proven two ways: (1) the settled
  // reservation is left with an unresolved stop marker
  // (`breaker.hasUnresolvedStop`), and (2) with the scope already open
  // (so this attempt is the half-open canary), a SECOND canary admission
  // over the same scope is refused rather than being let through over the
  // still-unconfirmed first attempt's descendants.
  it('a post-spawn schema-drift refusal never confirms stop evidence, so a second canary is refused over the unresolved execution (#2915 round 8 review 8, C2)', async () => {
    const root = await tempRoot();
    const config = path.join(root, 'fixture-config.json');
    const recordPath = path.join(root, 'record.jsonl');
    await writeFile(config, JSON.stringify({ recordPath, scenario: 'schema-change' }));
    // Build a REAL breaker whose 'installation:codex' scope is already
    // OPEN (one trusted failure, past its cooldown) before this attempt --
    // exactly `openedCanaryReservation`'s own opening step, below, so the
    // schema-drift attempt below is admitted as the half-open CANARY
    // (`token.canaryKeys.length > 0`), not an ordinary admission. A
    // deterministic injected clock avoids any real wall-clock wait.
    const breaker = new ScopedFailureBreaker({ policy: { cooldownMs: 1, distinctThreshold: 1, maxJitterMs: 0 } });
    let clockNow = 1_000_000;
    (breaker as any).nowMs = () => clockNow;
    const opening = breaker.admit({ invocationId: 'opener-schema-drift', scopeKeys: ['installation:codex'] });
    expect(opening.ok).toBe(true);
    breaker.settle((opening as any).token, { kind: 'failed', reasonCode: 'AUTH', evidenceSource: 'resolver', cli: 'codex' });
    clockNow += 1000; // past the (jitter-free) 1ms cooldown; the scope is now due
    completeSyntheticPreliminaryProbe(breaker, 'preliminary-schema-drift');
    const result = await invoke(root, config, {}, { scopedBreaker: breaker, allowDegraded: true });
    const body = JSON.parse(result.content[0].text);
    expect(body.status, JSON.stringify(body)).toBe('blocked');
    expect(body.diagnostics.join(' ')).toMatch(/schema/i);
    // Minimal fix proof: the reservation is retained, UNRESOLVED -- never
    // released as a confirmed stop merely because the outcome label was
    // 'blocked'.
    expect(breaker.hasUnresolvedStop(body.invocationId)).toBe(true);
    // The exact reviewer probe: a second canary admission over the SAME
    // scope is refused by the blocking marker, never admitted over the
    // still-unresolved first attempt's descendants.
    const second = breaker.admit({ invocationId: 'second-canary-schema-drift', scopeKeys: ['installation:codex'] });
    expect(second.ok).toBe(false);
    expect((second as any).blockedBy).toContain('installation:codex');
  }, 20000);

  // Proves `gateInputs` makes the gate deterministic, not absent: the REAL
  // `checkWorkerDispatch` still runs on every call above (see the
  // describe-block comment); this overrides `HEALTHY_GATE_LIVE` with one
  // deliberately failing signal and confirms the launch is still refused,
  // with a diagnostic naming the specific signal that failed, and that the
  // worker process is never reached (no record of a tools/call).
  it('still refuses a launch when an injected signal fails the gate', async () => {
    const root = await tempRoot();
    const config = path.join(root, 'fixture-config.json');
    const recordPath = path.join(root, 'record.jsonl');
    await writeFile(config, JSON.stringify({ recordPath, scenario: 'success' }));
    const failingLive = { ...HEALTHY_GATE_LIVE, availMemGb: 0.1 }; // < default min_avail_mem_gb (8GB)
    const result = await invoke(root, config, {}, { gateInputs: { live: failingLive } });
    const body = JSON.parse(result.content[0].text);
    expect(body.status, JSON.stringify(body)).toBe('blocked');
    expect(body.diagnostics.join(' ')).toMatch(/avail-mem/);
    await expect(readFile(recordPath, 'utf8')).rejects.toThrow(); // worker process was never launched
  }, 20000);

  // #2915 review 5 ("a second worker over unresolved execution"): native
  // MCP previously always received the resolved invocation's full
  // `mcp.timeoutSeconds` (observed 900s in production), regardless of
  // whether this attempt is the breaker's own bounded canary -- a hung
  // canary's MCP call could then run arbitrarily long past the 300s window
  // the breaker itself uses to decide a canary is overdue.
  it('clips the native MCP call timeout to the admitted canary deadline instead of the full task timeoutSeconds', async () => {
    const root = await tempRoot();
    const config = path.join(root, 'fixture-config.json');
    await writeFile(config, JSON.stringify({ recordPath: path.join(root, 'record.jsonl'), scenario: 'success' }));
    let capturedTimeoutSeconds: number | undefined;
    const fakeBreaker: any = {
      nowMs: () => Date.now(),
      admit: () => ({ ok: true, token: { id: 'fake-canary', breaker: fakeBreaker, invocationId: 'fake-inv',
        coveringKeys: ['installation:codex'], canaryKeys: ['installation:codex'],
        mintedAtMs: Date.now(), deadlineMs: Date.now() + 50 } }),
      settle: () => ({ ok: true }),
    };
    const result = await invoke(root, config, {}, {
      scopedBreaker: fakeBreaker,
      callMcpWorker: async (mcpBinding: any) => { capturedTimeoutSeconds = mcpBinding.timeoutSeconds; return { outcome: 'blocked', diagnostic: 'test-capture-only' }; },
    });
    const body = JSON.parse(result.content[0].text);
    expect(body.status, JSON.stringify(body)).toBe('blocked');
    // The fixture's own uncapped `mcp.timeoutSeconds` is 30 (buildFixture);
    // a ~50ms-remaining canary must clip it to roughly 0.05s, never 30.
    expect(capturedTimeoutSeconds).toBeDefined();
    expect(capturedTimeoutSeconds!).toBeLessThan(1);
    expect(capturedTimeoutSeconds!).toBeGreaterThanOrEqual(0);
  }, 20000);

  // #2915 round 8 critique (D5) / review 7 finding 4's last bullet: "run()
  // clips the duration to remaining canary time, then defaultCallMcpWorker()
  // adds that shortened duration to the original mint time, subtracting
  // preparation time twice." The ONE absolute `deadlineAtMs` threaded to
  // `callMcpWorker` must equal the canary token's own `deadlineMs` exactly —
  // never re-derived (and thereby shrunk again) from `mintedAtMs` plus an
  // already-clipped duration.
  it('the ONE absolute deadline passed to callMcpWorker equals the canary token deadline exactly -- no double subtraction of preparation time', async () => {
    const root = await tempRoot();
    const config = path.join(root, 'fixture-config.json');
    await writeFile(config, JSON.stringify({ recordPath: path.join(root, 'record.jsonl'), scenario: 'success' }));
    let capturedDeadlineAtMs: number | undefined;
    const fixedDeadlineMs = Date.now() + 50;
    const fakeBreaker: any = {
      nowMs: () => Date.now(),
      admit: () => ({ ok: true, token: { id: 'fake-canary-nodouble', breaker: fakeBreaker, invocationId: 'fake-inv',
        coveringKeys: ['installation:codex'], canaryKeys: ['installation:codex'],
        mintedAtMs: Date.now(), deadlineMs: fixedDeadlineMs } }),
      settle: () => ({ ok: true }),
    };
    const result = await invoke(root, config, {}, {
      scopedBreaker: fakeBreaker,
      callMcpWorker: async (_mcpBinding: any, _server: any, options: any) => {
        capturedDeadlineAtMs = options.deadlineAtMs;
        return { outcome: 'blocked', diagnostic: 'test-capture-only' };
      },
    });
    const body = JSON.parse(result.content[0].text);
    expect(body.status, JSON.stringify(body)).toBe('blocked');
    expect(capturedDeadlineAtMs).toBe(fixedDeadlineMs);
  }, 20000);

  // #2915 review 5: a serialized/per-instance MCP queue may hold an
  // already-admitted call long enough that its canary reservation's own
  // deadline has since passed -- an expired admission must never launch,
  // even though the registry-definition requalification (F5, above) alone
  // would have let it through.
  it('refuses a queued launch whose admission expired while waiting, instead of launching on a stale reservation', async () => {
    const root = await tempRoot();
    const config = path.join(root, 'fixture-config.json');
    const recordPath = path.join(root, 'record.jsonl');
    await writeFile(config, JSON.stringify({ recordPath, scenario: 'success' }));
    const fakeBreaker: any = {
      nowMs: () => 1_000_000,
      admit: () => ({ ok: true, token: { id: 'already-expired', breaker: fakeBreaker, invocationId: 'fake-inv',
        coveringKeys: ['installation:codex'], canaryKeys: ['installation:codex'],
        mintedAtMs: 500_000, deadlineMs: 700_000 } }),
      settle: () => ({ ok: true }),
    };
    const result = await invoke(root, config, {}, { scopedBreaker: fakeBreaker });
    const body = JSON.parse(result.content[0].text);
    expect(body.status, JSON.stringify(body)).toBe('blocked');
    expect(body.diagnostics.join(' ')).toMatch(/admission expired while queued/);
    await expect(readFile(recordPath, 'utf8')).rejects.toThrow(); // worker process was never launched
  }, 20000);

  // #2915 review 6 (finding 4, "stop evidence on every settlement"): the
  // same expired-while-queued admission above used to settle `uncertain`
  // with no `confirmedStop` evidence at all -- for a CANARY reservation
  // that already passed its own deadline (exactly this scenario), that
  // leaves a PERMANENT blocking marker behind for an attempt that launched
  // zero workers. Reproduced and fixed by passing `confirmedStop: true`
  // from this exact "never launched" settlement.
  it('settles with confirmedStop: true, proving zero dispatch for the same expired-while-queued admission', async () => {
    const root = await tempRoot();
    const config = path.join(root, 'fixture-config.json');
    const recordPath = path.join(root, 'record.jsonl');
    await writeFile(config, JSON.stringify({ recordPath, scenario: 'success' }));
    const settledOutcomes: any[] = [];
    const fakeBreaker: any = {
      nowMs: () => 1_000_000,
      admit: () => ({ ok: true, token: { id: 'expired-queued-4', breaker: fakeBreaker, invocationId: 'fake-inv',
        coveringKeys: ['installation:codex'], canaryKeys: ['installation:codex'],
        mintedAtMs: 500_000, deadlineMs: 700_000 } }),
      settle: (_token: any, outcome: any) => { settledOutcomes.push(outcome); return { ok: true }; },
    };
    const result = await invoke(root, config, {}, { scopedBreaker: fakeBreaker });
    const body = JSON.parse(result.content[0].text);
    expect(body.status, JSON.stringify(body)).toBe('blocked');
    expect(body.diagnostics.join(' ')).toMatch(/admission expired while queued/);
    expect(settledOutcomes).toHaveLength(1);
    expect(settledOutcomes[0]).toMatchObject({ kind: 'uncertain', confirmedStop: true });
  }, 20000);
});

// ---------------------------------------------------------------------------
// #2892 F4 (fix-2892-r2, formerly part of M5): the mcp transport REQUIRES a
// structured WorkerDirectBrief, validated at admission BEFORE any launch;
// a non-structured or changed brief refuses. Exception diagnostics are
// bounded, fixed-vocabulary codes, never the raw parser/validator message.
// ---------------------------------------------------------------------------
describe('mcp transport requires a structured WorkerDirectBrief (#2892 F4)', () => {
  it('refuses a plain-text brief at admission, before any launch is attempted', async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
    const briefPath = path.join(root, 'brief.md');
    await writeFile(briefPath, 'hello worker'); // plain text, never a structured WorkerDirectBrief
    const finalOutput = path.join(work, 'final.json');
    const recordPath = path.join(root, 'record.jsonl');
    const configPath = path.join(root, 'fixture-config.json');
    await writeFile(configPath, JSON.stringify({ recordPath, scenario: 'success' }));
    const f = buildFixture(root, 'mcp');
    f.drivers.codex.mcpRegistry = {
      get: async () => ({ name: 'fixture-server', type: 'stdio' as const, command: process.execPath,
        args: [path.resolve('test/fixtures/ralph-worker-mcp.mjs')], env: { AIWG_FAKE_WORKER_CONFIG: configPath } }),
    };
    const tools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); } }, {
      projectRoot: root, allowDegraded: true, workerWorktreesRoot: work,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }), now: () => new Date(f.now),
    });
    const call = tools.get('worker-invoke').handler;
    const result = await call({
      operation: 'run', request_id: 'f4-plaintext', role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp',
    });
    const body = JSON.parse(result.content[0].text);
    expect(body.status, JSON.stringify(body)).toBe('blocked');
    expect(body.diagnostics).toEqual(['OG_BRIEF_NOT_STRUCTURED']);
    await expect(stat(finalOutput)).rejects.toMatchObject({ code: 'ENOENT' });
    const retry = JSON.parse((await call({ operation: 'run', request_id: 'f4-plaintext-retry',
      role: 'coding', task: 'implementation', group: 'workers', brief: briefPath, workdir: work,
      final_output: finalOutput, transport: 'mcp' })).content[0].text);
    expect(retry.diagnostics).toEqual(['OG_BRIEF_NOT_STRUCTURED']);
    await expect(readFile(recordPath, 'utf8')).rejects.toThrow(); // tools/call (the launch) was never reached
  });

  it('exception diagnostics expose only a fixed code, never the raw parser message or a planted marker', async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
    const briefPath = path.join(root, 'brief.md');
    const marker = 'LEAKED-PLANTED-MARKER-9f3a';
    // Malformed JSON (unterminated string) containing the marker — if the
    // raw JSON.parse/validator error message were ever forwarded, it would
    // typically echo a slice of the offending input back out. Deliberately
    // does NOT start with '{' — #2887's OWN resolver (src/serve/worker-
    // invocation.ts) only attempts its own JSON.parse of the brief when it
    // does, and this test is specifically about THIS bridge's own
    // diagnostic mapping, not #2887's (already-hardened) one.
    await writeFile(briefPath, `not-json ${marker} {"unterminated`);
    const finalOutput = path.join(work, 'final.json');
    const f = buildFixture(root, 'mcp');
    const tools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); } }, {
      projectRoot: root, allowDegraded: true, workerWorktreesRoot: work,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }), now: () => new Date(f.now),
    });
    const call = tools.get('worker-invoke').handler;
    const result = await call({
      operation: 'run', request_id: 'f4-marker', role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp',
    });
    expect(JSON.stringify(result)).not.toContain(marker);
    const body = JSON.parse(result.content[0].text);
    expect(body.status, JSON.stringify(body)).toBe('blocked');
    expect(body.diagnostics).toEqual(['OG_BRIEF_NOT_STRUCTURED']);
  });

  it('refuses when a JSON brief is swapped to plain text between launch and result assembly (never silently completes)', async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
    const briefPath = path.join(root, 'brief.md');
    const finalOutput = path.join(work, 'final.json');
    const f = buildFixture(root, 'mcp');
    await buildStructuredBrief(f, { role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp' });
    const claims = { version: 1, status: 'completed', summary: 'ok', claims: [], artifacts: [], checks: [], limitations: [] };
    const tools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); } }, {
      projectRoot: root, workerWorktreesRoot: work,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }),
      callMcpWorker: async () => {
        // Simulate a racing/compromised writer swapping the already-admitted
        // (structured, digest-pinned) brief for plain text AFTER admission
        // validated it but BEFORE the result is assembled.
        await writeFile(briefPath, 'swapped-to-plaintext-after-admission');
        return {
          outcome: 'responded',
          response: { isError: false, content: [{ type: 'text', text: JSON.stringify(claims) }], structuredContent: claims },
        };
      },
      now: () => new Date(f.now),
    });
    const call = tools.get('worker-invoke').handler;
    const result = await call({
      operation: 'run', request_id: 'f4-swap', role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp',
    });
    const body = JSON.parse(result.content[0].text);
    // Never silently 'completed' on claims alone once the brief was swapped
    // out from under an admission that proved it structured.
    expect(body.status, JSON.stringify(body)).toBe('failed');
    expect(body.diagnostics).toEqual(['OG_BRIEF_EVIDENCE_CONFLICT']);
  });

  // #2915 round 8 review 8 (A/D2 leftovers): a PRE-DISPATCH exit (here, the
  // OG_BRIEF_NOT_STRUCTURED refusal above, which settles the admission
  // before any launch) must still AWAIT `settleDirectWorker`'s returned
  // promise and fold any diagnostic it carries into the result --
  // `run()`'s own `captureSettlementPromise`/wrapper mechanism, verified
  // here by spying on the real `settleDirectWorker` to resolve a
  // synthetic refund-failure diagnostic string.
  it('a pre-dispatch exit awaits settlement and surfaces its diagnostic in the result', async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
    const briefPath = path.join(root, 'brief.md');
    await writeFile(briefPath, 'hello worker'); // plain text -- OG_BRIEF_NOT_STRUCTURED, pre-dispatch
    const finalOutput = path.join(work, 'final.json');
    const f = buildFixture(root, 'mcp');
    const settle = vi.spyOn(sessionLauncherModule, 'settleDirectWorker')
      .mockResolvedValue('synthetic allowance refund failed: injected for this test');
    const tools = new Map<string, any>();
    try {
      await registerWorkerInvokeToolset({ registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); } }, {
        projectRoot: root, allowDegraded: true, workerWorktreesRoot: work,
        loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }), now: () => new Date(f.now),
      });
      const call = tools.get('worker-invoke').handler;
      const result = await call({
        operation: 'run', request_id: 'f4-settlement-diagnostic', role: 'coding', task: 'implementation', group: 'workers',
        brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp',
      });
      const body = JSON.parse(result.content[0].text);
      expect(body.status, JSON.stringify(body)).toBe('blocked');
      expect(settle).toHaveBeenCalledTimes(1);
      expect(body.diagnostics).toEqual(['OG_BRIEF_NOT_STRUCTURED', 'synthetic allowance refund failed: injected for this test']);
    } finally {
      settle.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// #2892 D2/D3: the per-serverRef serialized queue is bounded and rechecks
// qualification before each launch; two tasks against the SAME registered
// server share no model/workspace/output state.
// ---------------------------------------------------------------------------
describe('serialized per-server MCP queue — requalified before each launch, no crossover (#2892 D2/D3)', () => {
  it.skipIf(!supportsCapturedWorkerStdio || process.platform !== 'linux')('two tasks on the SAME registered serialized server both complete independently, with the qualification rechecked before each launch', async () => {
    const root = await tempRoot();
    const workA = path.join(root, 'work-a'); await mkdir(workA, { recursive: true });
    const workB = path.join(root, 'work-b'); await mkdir(workB, { recursive: true });
    const briefA = path.join(root, 'brief-a.md');
    const briefB = path.join(root, 'brief-b.md');
    const recordPath = path.join(root, 'record.jsonl');
    const configPath = path.join(root, 'fixture-config.json');
    await writeFile(configPath, JSON.stringify({ recordPath, scenario: 'success' }));
    const f = buildFixture(root, 'mcp');
    f.profile.mcp.serverRef = 'fixture-server-d2d3';
    f.profile.mcp.sessionIsolation = 'serialized';
    f.drivers.codex.mcpProfile = { servers: ['fixture-server-d2d3'] };
    let getCalls = 0;
    f.drivers.codex.mcpRegistry = {
      get: async () => {
        getCalls += 1;
        return { name: 'fixture-server-d2d3', type: 'stdio' as const, command: process.execPath,
          args: [path.resolve('test/fixtures/ralph-worker-mcp.mjs')], env: { AIWG_FAKE_WORKER_CONFIG: configPath } };
      },
    };
    // #2892 F4: build structured briefs AFTER the serverRef/sessionIsolation/
    // mcpProfile/mcpRegistry overrides above, so the probe resolution inside
    // buildStructuredBrief resolves against the SAME driver wiring the real
    // calls below will use.
    await buildStructuredBrief(f, { role: 'coding', task: 'implementation', group: 'workers',
      brief: briefA, workdir: workA, final_output: path.join(workA, 'final.json'), transport: 'mcp' });
    await buildStructuredBrief(f, { role: 'coding', task: 'implementation', group: 'workers',
      brief: briefB, workdir: workB, final_output: path.join(workB, 'final.json'), transport: 'mcp' });
    const tools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); } }, {
      projectRoot: root, allowDegraded: true, workerWorktreesRoot: root,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }), now: () => new Date(f.now),
      // CI determinism: see `HEALTHY_GATE_LIVE` — the REAL dispatch gate
      // still runs for both concurrent launches below, on a fixed sample.
      gateInputs: { live: HEALTHY_GATE_LIVE },
    });
    const call = tools.get('worker-invoke').handler;
    const buildInput = (brief: string, work: string, requestId: string) => ({
      operation: 'run', request_id: requestId, role: 'coding', task: 'implementation', group: 'workers',
      brief, workdir: work, final_output: path.join(work, 'final.json'), transport: 'mcp',
    });
    const [a, b] = await Promise.all([
      call(buildInput(briefA, workA, 'd2d3-a')),
      call(buildInput(briefB, workB, 'd2d3-b')),
    ]);
    const bodyA = JSON.parse(a.content[0].text);
    const bodyB = JSON.parse(b.content[0].text);
    expect(bodyA.status, JSON.stringify(bodyA)).toBe('completed');
    expect(bodyB.status, JSON.stringify(bodyB)).toBe('completed');
    expect(bodyA.invocationId).not.toBe(bodyB.invocationId);
    // D2: qualification was rechecked for EACH launch (at least once per
    // task), not just once at admission time.
    expect(getCalls).toBeGreaterThanOrEqual(2);
    const lines = (await readFile(recordPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const calls = lines.filter((l: any) => l.event === 'call');
    expect(calls.length).toBe(2);
    const workspaces = new Set(calls.map((c: any) => c.worker.workspace));
    expect(workspaces.size).toBe(2); // no crossover between the two tasks' workspaces
  }, 30000);

  it('exports a positive, finite bound on the per-serverRef serialized queue depth', () => {
    // The full saturation path (spawning >MAX_MCP_SERVER_QUEUE_DEPTH real
    // fixture processes to hit the exact refusal boundary) is exercised
    // manually/in load testing rather than this unit suite, to keep this
    // suite's runtime bounded; the bound itself, and that it is consulted
    // at all (`withServerQueue`), is covered by this constant's existence
    // and by the serialized-queue test above exercising the queue path.
    expect(Number.isInteger(workerInvoke.MAX_MCP_SERVER_QUEUE_DEPTH)).toBe(true);
    expect(workerInvoke.MAX_MCP_SERVER_QUEUE_DEPTH).toBeGreaterThan(0);
  });

  // #2892 F5 (fix-2892-r2, formerly D2): the pre-existing `enabled` check is
  // not requalification — a registry edit that changes command/args/env
  // while leaving `enabled: true` must still be caught before a QUEUED
  // launch uses the stale, admission-time server definition.
  it('refuses a queued launch when the registry definition changed since qualification, even though enabled stays true (#2892 F5)', async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
    const briefPath = path.join(root, 'brief.md');
    const finalOutput = path.join(work, 'final.json');
    const configPath = path.join(root, 'fixture-config.json');
    await writeFile(configPath, JSON.stringify({ recordPath: path.join(root, 'record.jsonl'), scenario: 'success' }));
    const f = buildFixture(root, 'mcp');
    // Force the SERIALIZED path (sessionIsolation !== 'per-call') so the
    // real call's own launch is held behind this test's manually-occupied
    // queue — giving a deterministic window to flip `changed` between
    // admission (unaffected by queuing) and the queued requalification
    // fetch, rather than depending on fragile internal call-count ordering.
    f.profile.mcp.sessionIsolation = 'serialized';
    let changed = false;
    let getCalls = 0;
    f.drivers.codex.mcpRegistry = {
      get: async () => {
        getCalls += 1;
        return {
          name: 'fixture-server', type: 'stdio' as const, enabled: true,
          command: changed ? '/changed/after-qualification' : process.execPath,
          args: [path.resolve('test/fixtures/ralph-worker-mcp.mjs')], env: { AIWG_FAKE_WORKER_CONFIG: configPath },
        };
      },
    };
    await buildStructuredBrief(f, { role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp' });
    const tools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); } }, {
      projectRoot: root, allowDegraded: true, workerWorktreesRoot: work,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }), now: () => new Date(f.now),
    });
    const call = tools.get('worker-invoke').handler;
    let releaseHold: () => void = () => {};
    const holdPromise = new Promise<void>(resolve => { releaseHold = resolve; });
    // Occupy the SAME serverRef's queue directly (module-level, shared with
    // the production `withServerQueue` call this run will make).
    const held = withServerQueue('fixture-server', () => holdPromise);
    const baselineCalls = getCalls; // buildStructuredBrief's own probe already ran
    const resultPromise = call({
      operation: 'run', request_id: 'f5-requalify', role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp',
    });
    // Wait for run()'s own (unqueued) admission path to actually fetch the
    // server TWICE more (#2887's own resolveWorkerInvocation mcp-profile
    // check, then this bridge's own explicit admission fetch that pins
    // `qualifiedServerDigest`) — a fixed wall-clock delay is unreliable
    // here (module-loading/fs overhead on the first resolve can exceed
    // 100ms) — before releasing the hold so the QUEUED task's own
    // requalification fetch sees the CHANGED definition.
    await waitFor(() => getCalls >= baselineCalls + 2);
    changed = true;
    releaseHold();
    await held;
    const result = await resultPromise;
    const body = JSON.parse(result.content[0].text);
    expect(body.status, JSON.stringify(body)).toBe('blocked');
    expect(body.diagnostics.join(' ')).toMatch(/definition changed/);
  });

  // #2892 F5: idle per-serverRef queue entries must be pruned once nothing
  // is pending against them — otherwise every DISTINCT serverRef ever seen
  // (e.g. 100 one-off completed servers) permanently retains a Map entry.
  it('prunes idle per-serverRef queue entries — 100 distinct completed servers do not retain 100 entries (#2892 F5)', async () => {
    for (let i = 0; i < 100; i += 1) {
      await withServerQueue(`fixture-server-idle-${i}`, async () => 'done');
    }
    expect(__testOnlyMcpServerQueueCount()).toBe(0);
  });
});

// Regression coverage for shell deadlines, stop proof, and pre-launch reservations.
describe('shell worker termination and launch preparation', () => {
  async function harness(options: Record<string, unknown> = {}) {
    const root = await tempRoot();
    const work = path.join(root, 'work');
    await mkdir(work);
    const brief = path.join(root, 'brief.md');
    await writeFile(brief, 'private worker brief');
    const f = buildFixture(root, 'shell');
    f.snapshot.config.parallelism!.health = { hardTimeoutSeconds: 1 };
    const registry = createInvocationRegistry({ maxActive: 1 });
    const tools = await captureTool(undefined, {
      projectRoot: root, workerWorktreesRoot: work, registry,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }),
      now: () => new Date(f.now), shellStopGraceMs: 20, stdinRuntimeRoot: path.join(root, 'runtime'), ...options,
    });
    const call = tools.get('worker-invoke').handler;
    const input = { operation: 'run', request_id: 'regression', role: 'coding', task: 'implementation',
      group: 'workers', brief, workdir: work, final_output: path.join(work, 'final.json'), transport: 'shell' };
    const run = async () => JSON.parse((await call(input)).content[0].text);
    return { root, work, f, registry, call, input, run };
  }

  it('stops a systemd unit on deadline and releases capacity only after confirmed termination', async () => {
    let stopped = false;
    let h: Awaited<ReturnType<typeof harness>>;
    const stop = vi.fn(async () => {
      expect(h.registry.canStart()).toBe(false);
      expect(h.registry.values()[0].control).not.toBeNull();
      stopped = true;
      return { ok: true };
    });
    const kill = vi.fn();
    h = await harness({
      launchShellWorker: async () => ({ launched: true, mode: 'systemd-unit', unit: 'test.service' }),
      waitForUnitTermination: async () => stopped ? { termination: 'confirmed', exitCode: 0 }
        : { termination: 'uncertain', exitCode: null, timedOut: true },
      stopWorkerUnit: stop, killWorkerUnit: kill,
    });
    const result = await h.run();
    expect(stop).toHaveBeenCalledWith('test.service', expect.objectContaining({ signal: expect.any(AbortSignal), timeout: expect.any(Number) }));
    expect(kill).not.toHaveBeenCalled();
    expect(result.status).toBe('failed'); // even an exit-zero deadline is a failure
    expect(result.termination).toBe('confirmed');
    expect(h.registry.canStart()).toBe(true);
    expect(h.registry.values()[0].control).toBeNull();
  });

  it('escalates an active unit to SIGKILL and requires stop proof', async () => {
    let killed = false;
    const stop = vi.fn(async () => ({ ok: true }));
    const kill = vi.fn(async () => { killed = true; return { ok: true }; });
    const h = await harness({
      launchShellWorker: async () => ({ launched: true, mode: 'systemd-unit', unit: 'test.service' }),
      waitForUnitTermination: async () => killed ? { termination: 'confirmed', exitCode: 137 }
        : { termination: 'uncertain', exitCode: null, timedOut: true },
      stopWorkerUnit: stop, killWorkerUnit: kill,
    });
    expect((await h.run()).termination).toBe('confirmed');
    expect(stop).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith('test.service', expect.objectContaining({ signal: expect.any(AbortSignal), timeout: expect.any(Number) }));
    expect(h.registry.canStart()).toBe(true);
  });

  it.each(['unavailable', 'throws', 'stalled'])('stops independently when unit observation %s', async failure => {
    let stopped = false;
    const stop = vi.fn(async () => { stopped = true; return { ok: true }; });
    const h = await harness({
      launchShellWorker: async () => ({ launched: true, mode: 'systemd-unit', unit: 'test.service' }),
      waitForUnitTermination: async () => {
        if (stopped) return { termination: 'confirmed', exitCode: 0 };
        if (failure === 'throws') throw new Error('manager unavailable');
        if (failure === 'stalled') return new Promise(() => {});
        return { termination: 'uncertain', exitCode: null }; // no timedOut flag
      },
      stopWorkerUnit: stop, killWorkerUnit: vi.fn(),
    });
    const result = await h.run();
    expect(stop).toHaveBeenCalledOnce();
    expect(result.status).toBe('failed');
    expect(result.termination).toBe('confirmed');
    expect(h.registry.canStart()).toBe(true);
  });

  it('automatically releases an uncertain unit after late stop proof', async () => {
    let confirmed = false;
    const cleanup = vi.fn(async () => {});
    const stop = vi.fn(async () => ({ ok: true }));
    const kill = vi.fn(async () => ({ ok: true }));
    let observations = 0;
    const observe = vi.fn(async () => {
      // A single stalled background probe must not prevent later checks.
      if (++observations === 4) return new Promise(() => {});
      return confirmed ? { termination: 'confirmed', exitCode: 1 } : { termination: 'uncertain', exitCode: null };
    });
    const h = await harness({
      launchShellWorker: async () => ({ launched: true, mode: 'systemd-unit', unit: 'test.service', cleanup }),
      waitForUnitTermination: observe, stopWorkerUnit: stop, killWorkerUnit: kill,
    });
    const result = await h.run();
    expect(result.status).toBe('uncertain');
    expect(h.registry.canStart()).toBe(false);
    await waitFor(() => observations >= 4);
    confirmed = true;
    await waitFor(() => h.registry.canStart());
    expect(h.registry.get(result.invocationId)).toMatchObject({ status: 'failed', termination: 'confirmed', control: null });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledOnce();
    const completedObservations = observe.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(observe).toHaveBeenCalledTimes(completedObservations);
  });

  it('finishes a cancelled unit even while the initial status query is stalled', async () => {
    let stopped = false;
    const h = await harness({
      launchShellWorker: async () => ({ launched: true, mode: 'systemd-unit', unit: 'test.service' }),
      waitForUnitTermination: async () => stopped ? { termination: 'confirmed', exitCode: 0 } : new Promise(() => {}),
      stopWorkerUnit: async () => { stopped = true; return { ok: true }; }, killWorkerUnit: vi.fn(),
    });
    const pending = h.run();
    await waitFor(() => h.registry.values()[0]?.control != null);
    const entry = h.registry.values()[0];
    await h.call({ operation: 'cancel', invocation_id: entry.invocationId });
    const result = await pending;
    expect(result).toMatchObject({ status: 'cancelled', termination: 'confirmed' });
    expect(h.registry.canStart()).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('rechecks descendants after their degraded leader closed and both stop attempts were uncertain', async () => {
    const child: any = new EventEmitter();
    child.pid = 987654321;
    let gone = false;
    const kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (gone) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      return true;
    }) as typeof process.kill);
    const h = await harness({ launchShellWorker: async () => ({ launched: true, mode: 'degraded', child, ownedGroup: true }) });
    try {
      const pending = h.run();
      await waitFor(() => h.registry.values()[0]?.control != null);
      child.emit('close', 0);
      child.emit('error', new Error('leader closed; descendants remain'));
      const result = await pending;
      expect(result.status).toBe('uncertain');
      expect(h.registry.canStart()).toBe(false);
      expect(kill.mock.calls.every(call => call[0] === -child.pid)).toBe(true);
      expect(kill.mock.calls.some(call => call[1] === 'SIGKILL')).toBe(true);
      gone = true;
      await waitFor(() => h.registry.canStart());
      expect(h.registry.get(result.invocationId).termination).toBe('confirmed');
      expect(child.listenerCount('close')).toBe(0);
      expect(child.listenerCount('error')).toBe(0);
    } finally { gone = true; kill.mockRestore(); }
  });

  it('retains control after an unconfirmed timeout so a later cancel can stop the unit', async () => {
    let confirmed = false;
    const stop = vi.fn(async () => ({ ok: true }));
    const h = await harness({
      launchShellWorker: async () => ({ launched: true, mode: 'systemd-unit', unit: 'test.service' }),
      waitForUnitTermination: async () => confirmed ? { termination: 'confirmed', exitCode: 1 }
        : { termination: 'uncertain', exitCode: null, timedOut: true },
      stopWorkerUnit: stop, killWorkerUnit: async () => ({ ok: true }),
    });
    const result = await h.run();
    expect(result.status).toBe('uncertain');
    expect(h.registry.canStart()).toBe(false); // successful signal delivery alone is insufficient
    expect(h.registry.get(result.invocationId).control).not.toBeNull();
    confirmed = true;
    const cancel = JSON.parse((await h.call({ operation: 'cancel', invocation_id: result.invocationId })).content[0].text);
    expect(cancel.cancelDelivered).toBe(true);
    await waitFor(() => h.registry.canStart());
    expect(stop).toHaveBeenCalledTimes(2);
    expect(h.registry.get(result.invocationId).status).toBe('cancelled');
    expect(h.registry.get(result.invocationId).termination).toBe('confirmed');
    expect(h.registry.get(result.invocationId).control).toBeNull();
  });

  it.each(['deadline', 'cancel'])('escalates a degraded worker on %s, then releases its slot on close', async trigger => {
    const child: any = new EventEmitter();
    child.pid = 123456;
    child.kill = vi.fn((signal: string) => {
      if (signal === 'SIGKILL') setImmediate(() => child.emit('close', null));
      return true;
    });
    const h = await harness({ launchShellWorker: async () => ({ launched: true, mode: 'degraded', child }) });
    const pending = h.run();
    await waitFor(() => h.registry.values()[0]?.control != null);
    if (trigger === 'cancel') {
      await h.call({ operation: 'cancel', invocation_id: h.registry.values()[0].invocationId });
      expect(h.registry.canStart()).toBe(false);
    }
    const result = await pending;
    expect(child.kill.mock.calls.map((c: any[]) => c[0])).toEqual(['SIGTERM', 'SIGKILL']);
    expect(result.status).toBe(trigger === 'cancel' ? 'cancelled' : 'failed');
    expect(result.termination).toBe('confirmed');
    expect(h.registry.canStart()).toBe(true);
    expect(child.listenerCount('close')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
  });

  it.each(['close', 'error'])('clears the degraded deadline timer on %s', async event => {
    const child: any = new EventEmitter();
    child.pid = 123456;
    child.kill = vi.fn(() => false);
    const h = await harness({ launchShellWorker: async () => ({ launched: true, mode: 'degraded', child }) });
    const setTimer = vi.spyOn(globalThis, 'setTimeout');
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout');
    try {
      const pending = h.run();
      await waitFor(() => h.registry.values()[0]?.control != null);
      // Preparation consumes part of the one-second absolute budget.
      // Identify its longest pending timer, allowing fractional remaining ms.
      const timerCalls = setTimer.mock.calls.map((call, index) => ({ ms: Number(call[1]), index }))
        .filter(call => call.ms > 0 && call.ms <= 1000);
      expect(timerCalls.length).toBeGreaterThan(0);
      const timerIndex = timerCalls.reduce((longest, call) => call.ms > longest.ms ? call : longest).index;
      child.emit(event, event === 'error' ? new Error('lost observation') : 0);
      if (event === 'error') expect(child.kill).not.toHaveBeenCalled();
      const result = await pending;
      expect(clearTimer).toHaveBeenCalledWith(setTimer.mock.results[timerIndex].value);
      expect(child.kill.mock.calls.map((c: any[]) => c[0])).toEqual(event === 'error' ? ['SIGTERM', 'SIGKILL'] : []);
      if (event === 'error') {
        expect(result.status).toBe('uncertain');
        expect(h.registry.canStart()).toBe(false);
        const cancel = JSON.parse((await h.call({ operation: 'cancel', invocation_id: result.invocationId })).content[0].text);
        expect(cancel.cancelDelivered).toBe(false);
        child.emit('close', null);
        await waitFor(() => h.registry.canStart());
        expect(h.registry.get(result.invocationId).status).toBe('cancelled');
      }
    } finally { setTimer.mockRestore(); clearTimer.mockRestore(); }
  });

  it('releases capacity and removes the reserved output after a proven pre-launch exception', async () => {
    const h = await harness({ loadWorkerInputs: async () => { throw new Error('qualification unavailable'); } });
    for (const requestId of ['first', 'retry']) {
      h.input.request_id = requestId;
      const result = await h.run();
      expect(result.status).toBe('blocked');
      expect(result.termination).toBe('confirmed');
      expect(result.diagnostics).toEqual(['qualification unavailable']);
      expect(h.registry.canStart()).toBe(true);
      await expect(stat(h.input.final_output)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('keeps the blocked result when reservation cleanup is denied', async () => {
    let h: Awaited<ReturnType<typeof harness>>;
    h = await harness({ loadWorkerInputs: async () => {
      await chmod(h.work, 0);
      throw new Error('qualification unavailable');
    } });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await h.run()).toMatchObject({ status: 'blocked', termination: 'confirmed', diagnostics: ['qualification unavailable'] });
      expect(log).toHaveBeenCalledWith('[worker-invoke] output reservation cleanup failed');
      expect(h.registry.canStart()).toBe(true);
    } finally { await chmod(h.work, 0o700); log.mockRestore(); }
  });

  it.skipIf(process.platform === 'win32')('creates a private output and removes it on launch refusal, permitting a retry', async () => {
    const launch = vi.fn(async (invocation: any) => {
      expect((await stat(invocation.finalPath)).mode & 0o777).toBe(0o600);
      return { launched: false, diagnostic: 'gate refusal' };
    });
    const h = await harness({ launchShellWorker: launch });
    for (const requestId of ['first', 'retry']) {
      h.input.request_id = requestId;
      expect((await h.run()).diagnostics).toEqual(['gate refusal']);
      await expect(stat(h.input.final_output)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('removes output on qualification refusal without ever launching', async () => {
    const launch = vi.fn();
    const h = await harness({ launchShellWorker: launch });
    delete h.f.drivers.codex;
    expect((await h.run()).status).toBe('blocked');
    expect(h.registry.canStart()).toBe(true);
    expect(launch).not.toHaveBeenCalled();
    await expect(stat(h.input.final_output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  async function installJsonWorker(h: Awaited<ReturnType<typeof harness>>) {
    const script = path.join(h.root, 'worker.mjs');
    await writeFile(script, `import { readFileSync, writeFileSync, readlinkSync } from 'node:fs';
const params = JSON.parse(readFileSync(0, 'utf8'));
writeFileSync(process.argv[2], JSON.stringify({ type: 'result', result: { version: 1, status: 'completed',
summary: JSON.stringify({ params, stdinPath: process.platform === 'linux' ? readlinkSync('/proc/self/fd/0') : null }), claims: [], artifacts: [], checks: [], limitations: [] } }) + '\\n');`);
    h.f.drivers.codex.buildInvocation = async (input: any) => ({
      argv: [process.execPath, script, input.finalPath], stdin: 'brief-json', envNames: [],
    });
  }

  it.skipIf(process.platform !== 'linux')('uses the production degraded launcher with conductor-framed brief-json stdin', async () => {
    const h = await harness({ allowDegraded: true,
      gateInputs: { live: HEALTHY_GATE_LIVE, isolation: { mode: 'degraded', reason: 'test' } } });
    await installJsonWorker(h);
    const result = await h.run();
    expect(result.status, JSON.stringify(result)).toBe('completed');
    expect(result.termination).toBe('confirmed');
    const frame = JSON.parse(result.result.claims.summary);
    expect(frame.params).toEqual({ message: 'private worker brief', model_override: 'synthetic/a%b', cwd: h.work });
    expect((await stat(h.input.final_output)).mode & 0o777).toBe(0o600);
    expect(frame.stdinPath.startsWith(h.work + path.sep)).toBe(false);
    await expect(stat(frame.stdinPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(path.join(h.root, 'runtime'))).toEqual([]);
    expect(h.registry.canStart()).toBe(true);
  });

  it.skipIf(process.platform === 'win32').each(['deadline', 'cancel'])('stops a real production degraded process group on %s', async trigger => {
    let child: ReturnType<typeof nodeSpawn> | undefined;
    const h = await harness({ allowDegraded: true, shellStopGraceMs: 150,
      gateInputs: { live: HEALTHY_GATE_LIVE, isolation: { mode: 'degraded', reason: 'test' },
        spawnAsync: (...args: Parameters<typeof nodeSpawn>) => { child = nodeSpawn(...args); return child; } } });
    const marker = path.join(h.root, 'started');
    const script = path.join(h.root, 'stubborn.mjs');
    await writeFile(script, `import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
process.on('SIGTERM', () => {});
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 20)'], { stdio: 'ignore' });
grandchild.once('spawn', () => writeFileSync(process.argv[2], String(grandchild.pid)));
setInterval(() => {}, 20);`);
    h.f.drivers.codex.buildInvocation = async () => ({
      argv: [process.execPath, script, marker], stdin: 'closed', envNames: [],
    });
    try {
      const pending = h.run();
      await waitFor(() => !!child && (() => { try { return Number(readFileSync(marker, 'utf8')) > 0; } catch { return false; } })());
      if (trigger === 'cancel') await h.call({ operation: 'cancel', invocation_id: h.registry.values()[0].invocationId });
      const result = await pending;
      const grandchildPid = Number(await readFile(marker, 'utf8'));
      expect(() => process.kill(grandchildPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
      expect(child!.spawnargs[1]).toBe(script);
      expect(child!.signalCode).toBe('SIGKILL');
      expect(result.status).toBe(trigger === 'cancel' ? 'cancelled' : 'failed');
      expect(result.termination).toBe('confirmed');
      expect(h.registry.canStart()).toBe(true);
    } finally {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already stopped */ }
      }
    }
  });

  it('supplies a memory ceiling and private framed stdin to the production systemd launcher', async () => {
    const client = systemdClientFixture();
    roots.push(client.root);
    vi.stubEnv('PATH', client.root);
    let stdinPath = '';
    let h: Awaited<ReturnType<typeof harness>>;
    const spawn = vi.fn((command: string, args: string[], _options: any) => {
      if (command === client.binary) {
        expect(args).toContain('MemoryMax=2G');
        const property = args.find(arg => arg.startsWith('StandardInputFile='))!;
        stdinPath = property.slice('StandardInputFile='.length);
        const frame = JSON.parse(readFileSync(stdinPath, 'utf8'));
        expect(frame).toEqual({ message: 'private worker brief', model_override: 'synthetic/a%b', cwd: h.work });
        expect(args.join(' ')).not.toContain('private worker brief');
        expect(readFileSync(stdinPath).length).toBeGreaterThan(0);
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: args.includes('show-environment') ? '' : '123\n', stderr: '' };
    });
    h = await harness({ gateInputs: { live: HEALTHY_GATE_LIVE, isolation: { mode: 'systemd-unit' }, spawn },
      waitForUnitTermination: async () => ({ termination: 'confirmed', exitCode: 0 }) });
    await installJsonWorker(h);
    const result = await h.run();
    expect(result.termination).toBe('confirmed');
    expect(spawn.mock.calls.filter(c => c[0] === client.binary)).toHaveLength(1);
    // Launcher exceptions become outcomes; a swallowed assertion must fail here.
    expect(spawn.mock.results[spawn.mock.calls.findIndex(c => c[0] === client.binary)])
      .toEqual({ type: 'return', value: { status: 0, stdout: '', stderr: '' } });
    expect(spawn).toHaveBeenCalledWith(client.binary, expect.arrayContaining(['MemoryMax=2G']),
      expect.objectContaining({ env: expect.objectContaining({ PATH: client.root }) }));
    expect(spawn).toHaveBeenCalledWith(client.systemctl, ['--user', 'show-environment'],
      expect.objectContaining({ env: expect.objectContaining({ PATH: client.root }) }));
    expect(stdinPath).not.toBe('');
    await expect(stat(stdinPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(h.registry.canStart()).toBe(true);
  });

  it.each(['nonzero', 'timeout', 'throws'])('retains framed stdin and output after an attempted systemd launch %s until stopped', async failure => {
    const client = systemdClientFixture();
    roots.push(client.root);
    vi.stubEnv('PATH', client.root);
    let stdinPath = '';
    let unit = '';
    let confirmed = false;
    let h: Awaited<ReturnType<typeof harness>>;
    const spawn = vi.fn((binary: string, args: string[]) => {
      if (binary !== client.binary) return { status: 0, stdout: '', stderr: '' };
      stdinPath = args.find(arg => arg.startsWith('StandardInputFile='))!.slice('StandardInputFile='.length);
      unit = args.find(arg => arg.startsWith('--unit='))!.slice('--unit='.length);
      if (failure === 'throws') throw new Error('client failed after unit acceptance');
      return { status: 1, error: failure === 'timeout' ? new Error('ETIMEDOUT') : undefined, stderr: 'client failed' };
    });
    const stop = vi.fn(async (name: string) => {
      expect(name).toBe(unit);
      expect(h.registry.canStart()).toBe(false);
      expect(existsSync(stdinPath)).toBe(true);
      expect(existsSync(h.input.final_output)).toBe(true);
      return { ok: true };
    });
    const kill = vi.fn(async () => ({ ok: true }));
    h = await harness({ gateInputs: { live: HEALTHY_GATE_LIVE, isolation: { mode: 'systemd-unit' }, spawn },
      waitForUnitTermination: async () => confirmed ? { termination: 'confirmed', exitCode: 1 }
        : { termination: 'uncertain', exitCode: null }, stopWorkerUnit: stop, killWorkerUnit: kill });
    await installJsonWorker(h);
    const result = await h.run();
    expect(result.status).toBe('blocked');
    expect(result.termination).toBe('uncertain');
    expect(h.registry.get(result.invocationId).terminalAt).toBeNull();
    expect(h.registry.get(result.invocationId).control).not.toBeNull();
    expect(spawn.mock.calls.filter(c => c[0] === client.binary)).toHaveLength(1);
    expect(unit).not.toBe('');
    expect(stdinPath).not.toBe('');
    expect(stop).toHaveBeenCalledOnce();
    await expect(stop.mock.results[0].value).resolves.toEqual({ ok: true });
    expect(kill).toHaveBeenCalledWith(unit, expect.objectContaining({ signal: expect.any(AbortSignal), timeout: expect.any(Number) }));
    expect(h.registry.canStart()).toBe(false);
    expect(existsSync(stdinPath)).toBe(true);
    expect(existsSync(h.input.final_output)).toBe(true);
    confirmed = true;
    await waitFor(() => h.registry.canStart() && !existsSync(stdinPath) && !existsSync(h.input.final_output));
    expect(h.registry.get(result.invocationId)).toMatchObject({ status: 'failed', termination: 'confirmed', control: null });
  });

  it.each(['throws', 'ENOENT'])('releases every pre-launch resource on degraded spawn %s', async failure => {
    const spawnAsync = vi.fn((...args: Parameters<typeof nodeSpawn>) => {
      if (failure === 'throws') throw new Error('synchronous spawn refused');
      return nodeSpawn(...args);
    });
    const h = await harness({ allowDegraded: true,
      gateInputs: { live: HEALTHY_GATE_LIVE, isolation: { mode: 'degraded', reason: 'test' }, spawnAsync } });
    h.f.drivers.codex.buildInvocation = async () => ({
      argv: [path.join(h.root, 'missing-executable')], stdin: 'brief-json', envNames: [],
    });
    for (const requestId of ['first', 'retry']) {
      h.input.request_id = requestId;
      const result = await h.run();
      expect(result).toMatchObject({ status: 'blocked', termination: 'confirmed' });
      expect(h.registry.canStart()).toBe(true);
      expect(h.registry.get(result.invocationId).control).toBeUndefined();
      await expect(stat(h.input.final_output)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readdir(path.join(h.root, 'runtime'))).toEqual([]);
    }
    expect(spawnAsync).toHaveBeenCalledTimes(2);
  });

  it('keeps a successful run successful when post-close cleanup throws', async () => {
    const cleanup = vi.fn(async () => { throw new Error('cleanup unavailable'); });
    const h = await harness({ launchShellWorker: async (invocation: any) => {
      await writeFile(invocation.finalPath, JSON.stringify({ type: 'result', result: { version: 1,
        status: 'completed', summary: 'done', claims: [], artifacts: [], checks: [], limitations: [] } }) + '\n');
      return { launched: true, mode: 'degraded', child: closingChild(0), cleanup };
    } });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await h.run()).toMatchObject({ status: 'completed', termination: 'confirmed' });
      expect(h.registry.canStart()).toBe(true);
      expect(cleanup).toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  it('releases capacity when the production launcher cannot open output before spawning', async () => {
    const spawnAsync = vi.fn();
    const h = await harness({ allowDegraded: true,
      gateInputs: { live: HEALTHY_GATE_LIVE, isolation: { mode: 'degraded', reason: 'test' }, spawnAsync } });
    h.f.drivers.codex.buildInvocation = async () => ({
      argv: [process.execPath, path.join(h.root, 'unused.mjs')], stdin: 'closed', envNames: [],
    });
    const blockedOutput = `${h.input.final_output}.stdout`;
    await mkdir(blockedOutput);
    const result = await h.run();
    expect(result.status).toBe('blocked');
    expect(result.termination).toBe('confirmed');
    expect(spawnAsync).not.toHaveBeenCalled();
    expect(h.registry.canStart()).toBe(true);
    await expect(stat(h.input.final_output)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(blockedOutput)).isDirectory()).toBe(true);
  });

  it('releases the reservation when production stdin preparation fails before spawn', async () => {
    const spawnAsync = vi.fn();
    const h = await harness({ shellWorkerMemoryMaxGb: 0, allowDegraded: true,
      gateInputs: { live: HEALTHY_GATE_LIVE, isolation: { mode: 'degraded', reason: 'test' }, spawnAsync } });
    await installJsonWorker(h);
    const result = await h.run();
    expect(result.status).toBe('blocked');
    expect(result.termination).toBe('confirmed');
    expect(result.diagnostics.join(' ')).toMatch(/positive memoryMaxGb/);
    expect(spawnAsync).not.toHaveBeenCalled();
    expect(h.registry.canStart()).toBe(true);
    await expect(stat(h.input.final_output)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

// ---------------------------------------------------------------------------
// #2915 review 5 ("a second worker over unresolved execution"): a hung
// canary's execution must actually be stopped at its own deadline, never
// merely reported as an unconfirmed timeout while it keeps running.
// ---------------------------------------------------------------------------
describe('bounded stop escalation on canary-deadline timeout (#2915 review 5)', () => {
  it('terminateChildWithGrace resolves confirmed without SIGKILL when SIGTERM alone stops the child', async () => {
    const sessionLauncher = await import('../../../tools/ralph-external/session-launcher.mjs');
    const signals: string[] = [];
    const child: any = new EventEmitter();
    child.pid = 54321;
    child.exitCode = null; child.signalCode = null;
    child.kill = (sig: string) => {
      signals.push(sig);
      if (sig === 'SIGTERM') { child.exitCode = 0; child.signalCode = null; queueMicrotask(() => child.emit('exit')); }
      return true;
    };
    const result = await sessionLauncher.terminateChildWithGrace(child, { graceMs: 20 });
    expect(result).toEqual({ terminated: true });
    expect(signals).toEqual(['SIGTERM']);
  });

  it('terminateChildWithGrace escalates to SIGKILL after the bounded grace window when SIGTERM alone does not stop the child', async () => {
    const sessionLauncher = await import('../../../tools/ralph-external/session-launcher.mjs');
    const signals: string[] = [];
    const child: any = new EventEmitter();
    child.pid = 54321;
    child.exitCode = null; child.signalCode = null;
    child.kill = (sig: string) => {
      signals.push(sig);
      if (sig === 'SIGKILL') { child.exitCode = null; child.signalCode = 'SIGKILL'; }
      return true;
    };
    const result = await sessionLauncher.terminateChildWithGrace(child, { graceMs: 10 });
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(result).toEqual({ terminated: true });
  });

  it('terminateChildWithGrace reports not terminated when neither signal produced an observable exit', async () => {
    const sessionLauncher = await import('../../../tools/ralph-external/session-launcher.mjs');
    const child: any = new EventEmitter();
    child.pid = 54321;
    child.exitCode = null; child.signalCode = null;
    child.kill = () => true;
    const result = await sessionLauncher.terminateChildWithGrace(child, { graceMs: 10 });
    expect(result).toEqual({ terminated: false });
  });

  it('shell stop control issues a stop and re-checks status once the deadline elapses, instead of returning an unconfirmed timeout unattended', async () => {
    const { buildShellStopControl } = await import('../../../src/mcp/tools/worker-shell-control.mjs');
    let active = true;
    let stopCalls = 0;
    const killUnit = vi.fn();
    const control = buildShellStopControl({ launched: true, mode: 'systemd-unit', unit: 'fake-unit' }, {
      graceMs: 10, recheckMaxAttempts: 0,
      waitForUnit: async () => active ? { termination: 'uncertain', exitCode: null, timedOut: true }
        : { termination: 'confirmed', exitCode: 0 },
      stopUnit: async () => { stopCalls += 1; active = false; return { ok: true }; },
      killUnit,
    });
    try {
      const result = await control.wait(10);
      expect(stopCalls).toBe(1);
      expect(killUnit).not.toHaveBeenCalled();
      expect(result).toMatchObject({ termination: 'confirmed', timedOut: true });
    } finally { control.dispose(); }
  });

  it('shell stop control reports uncertain when the stop escalation does not actually stop the unit', async () => {
    const { buildShellStopControl } = await import('../../../src/mcp/tools/worker-shell-control.mjs');
    let stopCalls = 0;
    const killUnit = vi.fn(async () => ({ ok: false }));
    const control = buildShellStopControl({ launched: true, mode: 'systemd-unit', unit: 'fake-unit' }, {
      graceMs: 10, recheckMaxAttempts: 0,
      waitForUnit: async () => ({ termination: 'uncertain', exitCode: null, timedOut: true }),
      stopUnit: async () => { stopCalls += 1; return { ok: false }; },
      killUnit,
    });
    try {
      const result = await control.wait(10);
      expect(stopCalls).toBe(1);
      expect(killUnit).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ termination: 'uncertain', timedOut: true });
    } finally { control.dispose(); }
  });
});

// ---------------------------------------------------------------------------
// #2915 review 6 ("MCP-path findings"): false recovery after timeout, a
// pre-spawn capacity leak on native-MCP requalification, one absolute MCP
// deadline, stop evidence on every settlement, and disabled-dispatch
// equivalence with origin/main.
// ---------------------------------------------------------------------------

describe('timeout is never treated as success, independent of exit status (#2915 review 6, finding 1)', () => {
  it('a systemd-unit worker force-stopped at its own deadline with exitCode 0 settles failed, never completed, even with a strictly valid final claim', async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
    const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'hello');
    const finalPath = path.join(work, 'final.json');
    const f = buildFixture(root, 'shell');
    const claims = { version: 1, status: 'completed', summary: 'ok', claims: [], artifacts: [], checks: [], limitations: [] };
    const tools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); } }, {
      projectRoot: root, workerWorktreesRoot: work,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }),
      launchShellWorker: async invocation => {
        // The worker legitimately finished writing its final output right
        // before the forced stop fired -- this is exactly the scenario a
        // naive exitCode-based completion check would misclassify as a
        // genuine success.
        await writeFile(invocation.finalPath, `${JSON.stringify({ type: 'result', result: claims })}\n`);
        return { launched: true, mode: 'systemd-unit', unit: 'fake-unit-false-recovery' };
      },
      // Simulates the real `waitForUnitTermination`'s own deadline-stop
      // escalation outcome: the unit was force-stopped at the deadline, and
      // its retained systemd state happens to report a clean exit.
      waitForUnitTermination: async () => ({ termination: 'confirmed', exitCode: 0, timedOut: true }),
      now: () => new Date(f.now),
    });
    const call = tools.get('worker-invoke').handler;
    const result = await call({
      operation: 'run', request_id: 'false-recovery-timeout', role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalPath, transport: 'shell',
    });
    const body = JSON.parse(result.content[0].text);
    expect(body.status, JSON.stringify(body)).not.toBe('completed');
    expect(body.status, JSON.stringify(body)).toBe('failed');
  });

  // #2915 round 8 review 8 (C4): `timedOut` is a LATCH, set synchronously
  // the instant the deadline timer fires, BEFORE starting the (async) stop
  // escalation -- every completion path (including the `close` handler,
  // which can race the escalation it triggered) must read this latched
  // value, never recompute `now >= deadlineAt` from the clock. Reproduces
  // review 7 finding 3 exactly: with the timeout callback already
  // executing (SIGTERM already sent), a BACKWARD clock movement followed
  // by a clean child `close` must still settle `failed`, never `completed`.
  it('a degraded-mode timeout latch is immune to a backward clock step during stop escalation (#2915 round 8 review 8, C4)', async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
    const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'hello');
    const finalPath = path.join(work, 'final.json');
    const f = buildFixture(root, 'shell');
    const claims = { version: 1, status: 'completed', summary: 'ok', claims: [], artifacts: [], checks: [], limitations: [] };
    // A short-fused canary deadline (30ms) stands in for the task deadline
    // so the timer fires almost immediately in real wall-clock time --
    // `admission.token.deadlineMs` is the SMALLEST deadline candidate
    // `continueGated` folds in (see its own doc comment), so this governs
    // `deadlineMs` regardless of the fixture's much larger default task
    // wallSeconds.
    const breaker = new ScopedFailureBreaker({ policy: { canaryTimeoutMs: 30, cooldownMs: 1, distinctThreshold: 1, maxJitterMs: 0 } });
    let clockNow = 1_000_000;
    (breaker as any).nowMs = () => clockNow;
    const opening = breaker.admit({ invocationId: 'opener-c4-latch', scopeKeys: ['installation:codex'] });
    breaker.settle((opening as any).token, { kind: 'failed', reasonCode: 'AUTH', evidenceSource: 'resolver', cli: 'codex' });
    clockNow += 1000; // past the (jitter-free) 1ms cooldown; the scope is now due
    completeSyntheticPreliminaryProbe(breaker, 'preliminary-c4-latch');
    // The instant SIGTERM is delivered (the stop escalation genuinely
    // starting), simulate the backward wall-clock movement and then a
    // clean close racing the escalation -- both happen synchronously
    // inside this one `kill()` call, so the test needs no extra real-time
    // wait for a 5s grace window that never actually needs to elapse.
    const signalsSent: string[] = [];
    const child: any = new EventEmitter();
    child.pid = 54321;
    child.exitCode = null; child.signalCode = null;
    child.kill = (sig: string) => {
      signalsSent.push(sig);
      if (sig === 'SIGTERM') {
        clockNow -= 500_000;
        // Matches real Node `ChildProcess` semantics: `exitCode` is set
        // before `close` fires, so a LATER `terminateChildWithGrace` call
        // against this same already-exited child (the descendant-stop
        // evidence resolution below also attempts termination,
        // best-effort) short-circuits immediately via its own `exited()`
        // check instead of sending a real second SIGTERM/SIGKILL round.
        queueMicrotask(() => { child.exitCode = 0; child.emit('close', 0); });
      }
      return true;
    };
    const tools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); } }, {
      projectRoot: root, workerWorktreesRoot: work, scopedBreaker: breaker,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }),
      launchShellWorker: async (invocation: any) => {
        await writeFile(invocation.finalPath, `${JSON.stringify({ type: 'result', result: claims })}\n`);
        return { launched: true, mode: 'degraded', child };
      },
      now: () => new Date(f.now),
    });
    const call = tools.get('worker-invoke').handler;
    const result = await call({
      operation: 'run', request_id: 'c4-backward-clock-latch', role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalPath, transport: 'shell',
    });
    const runBody = JSON.parse(result.content[0].text);
    expect(signalsSent).toEqual(['SIGTERM']);
    expect(runBody.status, JSON.stringify(runBody)).not.toBe('completed');
    expect(runBody.status, JSON.stringify(runBody)).toBe('failed');
  });
});

describe('native MCP pre-spawn requalification never leaks registry capacity (#2915 review 6, finding 2)', () => {
  it.each(['never-began', undefined])('cleans the private output reservation after a pre-launch refusal (%s)', async dispatchState => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work);
    const brief = path.join(root, 'brief.md');
    const finalOutput = path.join(work, 'final.json');
    const f = buildFixture(root, 'mcp');
    f.snapshot.models.defaults.workerSelection!.dataClasses = { 'local-only': {} };
    f.drivers.codex.mcpRegistry = { get: async () => ({ name: 'fixture-server', type: 'stdio', command: 'never-launched' }) };
    await buildStructuredBrief(f, { role: 'coding', task: 'implementation', group: 'workers', brief,
      workdir: work, final_output: finalOutput, transport: 'mcp' });
    const registry = createInvocationRegistry({ maxActive: 1 });
    const callMcpWorker = vi.fn(async (_binding: any, _server: any, _options: any) => ({ outcome: 'blocked', diagnostic: 'pre-launch queue refusal', dispatchState }));
    const tools = await captureTool(undefined, {
      projectRoot: root, workerWorktreesRoot: work, registry, callMcpWorker,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }), now: () => new Date(f.now),
    });
    const result = await tools.get('worker-invoke').handler({ operation: 'run', request_id: 'queue-refusal',
      role: 'coding', task: 'implementation', group: 'workers', brief, workdir: work, final_output: finalOutput, transport: 'mcp' });
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({ status: 'blocked', termination: 'confirmed', diagnostics: ['pre-launch queue refusal'] });
    expect(callMcpWorker).toHaveBeenCalledOnce();
    expect(callMcpWorker.mock.calls[0][2].admission.gated).toBe(true);
    expect(registry.canStart()).toBe(true);
    expect(existsSync(finalOutput)).toBe(false);
  });

  it('a thrown mcpRegistry.get during requalification fails CLOSED (blocked) and frees capacity, instead of leaking a live uncertain slot', async () => {
    const root = await tempRoot();
    const config = path.join(root, 'fixture-config.json');
    await writeFile(config, JSON.stringify({ recordPath: path.join(root, 'record.jsonl'), scenario: 'success' }));
    const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
    const briefPath = path.join(root, 'brief.md');
    const finalOutput = path.join(work, 'final.json');
    const f = buildFixture(root, 'mcp');
    f.snapshot.models.defaults.workerSelection!.dataClasses = { 'local-only': {} };
    let calls = 0;
    let failFromCall = Infinity;
    f.drivers.codex.mcpRegistry = {
      get: async () => {
        calls += 1;
        if (calls > failFromCall) throw new Error('synthetic: registry lookup exploded during requalification');
        return { name: 'fixture-server', type: 'stdio' as const, command: process.execPath,
          args: [path.resolve('test/fixtures/ralph-worker-mcp.mjs')], env: { AIWG_FAKE_WORKER_CONFIG: config } };
      },
    };
    await buildStructuredBrief(f, { role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp' });
    // `resolveWorkerInvocation`'s own mcp-profile check, then this bridge's
    // own explicit admission fetch (`const mcpServer = await mcpRegistry.get(...)`
    // in `run()`), must both succeed — only the THIRD call, native MCP's own
    // requalification fetch inside `defaultCallMcpWorker`, throws.
    failFromCall = calls + 2;
    const registry = createInvocationRegistry({ maxActive: 1 });
    const tools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, cfg: any, handler: any) { tools.set(name, { config: cfg, handler }); } }, {
      projectRoot: root, registry, allowDegraded: true, workerWorktreesRoot: work,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }), now: () => new Date(f.now),
      gateInputs: { live: HEALTHY_GATE_LIVE },
    });
    const call = tools.get('worker-invoke').handler;
    const result = await call({ operation: 'run', request_id: 'leak-2-requalify', role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp' });
    const body = JSON.parse(result.content[0].text);
    expect(body.status, JSON.stringify(body)).toBe('blocked');
    // Capacity was FREED (markTerminal), not leaked as a live 'uncertain' slot.
    expect(registry.canStart()).toBe(true);
    expect(existsSync(finalOutput)).toBe(false);
  }, 20000);
});

describe('one absolute MCP deadline across queue wait, connect, list and call (#2915 review 6, finding 3)', () => {
  it('a native MCP call stage recomputes its timeout from the time actually remaining after a serialized queue wait, instead of a stale pre-queue snapshot', async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
    const briefPath = path.join(root, 'brief.md');
    const finalOutput = path.join(work, 'final.json');
    const configPath = path.join(root, 'fixture-config.json');
    // The worker never answers tools/call -- a stale/overlong timeout would
    // make this test hang for that full stale duration instead of the
    // freshly-recomputed, much smaller remaining budget.
    await writeFile(configPath, JSON.stringify({ recordPath: path.join(root, 'record.jsonl'), scenario: 'stall' }));
    const f = buildFixture(root, 'mcp');
    f.snapshot.models.defaults.workerSelection!.dataClasses = { 'local-only': {} };
    f.profile.mcp.sessionIsolation = 'serialized';
    let getCalls = 0;
    f.drivers.codex.mcpRegistry = {
      get: async () => {
        getCalls += 1;
        return { name: 'fixture-server', type: 'stdio' as const, command: process.execPath,
          args: [path.resolve('test/fixtures/ralph-worker-mcp.mjs')], env: { AIWG_FAKE_WORKER_CONFIG: configPath } };
      },
    };
    await buildStructuredBrief(f, { role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp' });
    // A canary admission minted at logical ms 0 with a 5000ms absolute
    // canary window. The outer clip (computed BEFORE queueing, unaffected by
    // this fix) reads `nowMs()` as 0 and so clips `mcpBinding.timeoutSeconds`
    // to the full 5s remaining -- the STALE snapshot. While the real request
    // is queued behind this test's own held task, the logical clock jumps to
    // 4700: only ~300ms of the SAME absolute deadline remains by actual
    // dispatch time, far less than the 5s stale snapshot and far less than
    // the fixture's own 30s task timeout or the SDK's 60s connect/list
    // default.
    let nowValue = 0;
    const fakeBreaker: any = {
      nowMs: () => nowValue,
      admit: () => ({ ok: true, token: { id: 'one-deadline-canary', breaker: fakeBreaker, invocationId: 'fake-inv',
        coveringKeys: ['installation:codex'], canaryKeys: ['installation:codex'],
        mintedAtMs: 0, deadlineMs: 5000 } }),
      settle: () => ({ ok: true }),
    };
    const tools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, cfg: any, handler: any) { tools.set(name, { config: cfg, handler }); } }, {
      projectRoot: root, allowDegraded: true, workerWorktreesRoot: work, scopedBreaker: fakeBreaker,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }), now: () => new Date(f.now),
      gateInputs: { live: HEALTHY_GATE_LIVE },
    });
    const call = tools.get('worker-invoke').handler;
    let releaseHold: () => void = () => {};
    const holdPromise = new Promise<void>(resolve => { releaseHold = resolve; });
    const held = withServerQueue('fixture-server', () => holdPromise);
    const baselineCalls = getCalls; // buildStructuredBrief's own probe already ran
    const startedAt = Date.now();
    const resultPromise = call({
      operation: 'run', request_id: 'one-deadline-3', role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp',
    });
    // Wait for the OUTER admission phase (resolver's own mcp-profile check,
    // then this bridge's explicit admission fetch) to complete -- the outer
    // clip has by now already read `nowMs()` at 0 -- before simulating the
    // queue-wait's elapsed time and releasing the hold.
    await waitFor(() => getCalls >= baselineCalls + 2);
    nowValue = 4700;
    releaseHold();
    await held;
    const result = await resultPromise;
    const elapsedMs = Date.now() - startedAt;
    const body = JSON.parse(result.content[0].text);
    expect(elapsedMs, JSON.stringify(body)).toBeLessThan(3000);
    expect(body.status, JSON.stringify(body)).toBe('uncertain');
  }, 20000);
});

describe('stop evidence on every settlement — zero-dispatch and confirmed-termination settlements never leave a permanent blocking marker (#2915 review 6, finding 4)', () => {
  // #2915 round 8 review 8 (C2): degraded direct-child close is UNRESOLVED
  // for descendants -- the shared `resolveStopEvidence` never treats a
  // confirmed exit of this bridge's own direct child (degraded isolation
  // has no cgroup to prove any descendant process it spawned has also
  // stopped) as sufficient stop evidence, even though the attempt itself
  // settles `failed` normally. This replaces the PRE-round-8 assumption
  // (reflected in this test's own former name) that any confirmed close
  // implied `confirmedStop: true` -- that was exactly the review 8 defect
  // ("degraded direct-child close becomes confirmedStop:true").
  it('a confirmed DEGRADED shell completion with an invalid final claim settles failed with confirmedStop: false (never confirms descendant stop without a cgroup)', async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
    const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'hello');
    const finalPath = path.join(work, 'final.json');
    const f = buildFixture(root, 'shell');
    const settledOutcomes: any[] = [];
    const fakeBreaker: any = {
      nowMs: () => Date.now(),
      admit: () => ({ ok: true, token: { id: 'confirmed-invalid-claim', breaker: fakeBreaker, invocationId: 'fake-inv',
        coveringKeys: ['installation:codex'], canaryKeys: [], mintedAtMs: Date.now(), deadlineMs: Infinity } }),
      settle: (_token: any, outcome: any) => { settledOutcomes.push(outcome); return { ok: true }; },
    };
    const tools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); } }, {
      projectRoot: root, workerWorktreesRoot: work, scopedBreaker: fakeBreaker,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }),
      launchShellWorker: async invocation => {
        // Malformed final output -- the strict JSONL parser must reject it
        // even though the process itself exited cleanly and confirmed.
        await writeFile(invocation.finalPath, 'not-valid-json-or-jsonl\n');
        return { launched: true, mode: 'degraded', child: closingChild(0) };
      },
      now: () => new Date(f.now),
    });
    const call = tools.get('worker-invoke').handler;
    const result = await call({
      operation: 'run', request_id: 'confirmed-invalid-claim', role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalPath, transport: 'shell',
    });
    const body = JSON.parse(result.content[0].text);
    expect(body.status, JSON.stringify(body)).toBe('failed');
    expect(settledOutcomes).toHaveLength(1);
    expect(settledOutcomes[0]).toMatchObject({ kind: 'failed', confirmedStop: false });
  });
});

describe('disabled-dispatch equivalence with origin/main on the MCP-path recovery mechanisms (#2915 review 6, section C)', () => {
  it('disabled systemd timeout uses current main stop escalation and abortable observation', async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
    await writeFile(path.join(root, 'brief.md'), 'hello');
    const f = buildFixture(root, 'shell');
    // A CLI whose adapter can never verify a final is never eligible for
    // recovery-breaker gating (`admitDirectWorker` returns `{ gated: false }`)
    // WITHOUT disabling the models resolver itself (unlike
    // `worker_dispatch: false` / `clis[cli].enabled: false`, both of which
    // the resolver ALSO treats as "disabled", producing no launchable plan
    // at all) -- so this is the one deterministic way to reach a genuinely
    // not-gated `run()` while still exercising the real launch/wait path.
    registerWorkerRecoveryCapabilities(f.drivers.codex, { canVerifyAttempt: false });
    let capturedOptions: any;
    const tools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); } }, {
      projectRoot: root, workerWorktreesRoot: work,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }),
      launchShellWorker: async () => ({ launched: true, mode: 'systemd-unit', unit: 'fake-unit-disabled' }),
      waitForUnitTermination: async (_unit, _deadlineMs, options) => { capturedOptions = options; return { termination: 'uncertain', exitCode: null, timedOut: true }; },
      now: () => new Date(f.now),
    });
    const call = tools.get('worker-invoke').handler;
    await call({
      operation: 'run', request_id: '6a-systemd-disabled', role: 'coding', task: 'implementation', group: 'workers',
      brief: path.join(root, 'brief.md'), workdir: work, final_output: path.join(work, 'final.json'), transport: 'shell',
    });
    // Both continuations use cancellable observations from the audited control.
    expect(capturedOptions.signal).toBeInstanceOf(AbortSignal);
    expect(capturedOptions.signal.aborted).toBe(true);
  });

  it('degraded TERM-then-KILL escalation protects both disabled and gated dispatch', async () => {
    for (const gated of [false, true]) {
      const child: any = new EventEmitter();
      child.pid = 12345; child.exitCode = null;
      child.kill = vi.fn((signal: string) => {
        if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', 0));
        return true;
      });
      const control = buildShellStopControl({ launched: true, mode: 'degraded', child }, { graceMs: 1 });
      const result = await control.wait(0, gated ? { deadlineAtMs: 0, nowMs: () => 0 } : undefined);
      expect(child.kill.mock.calls.map((args: any[]) => args[0])).toEqual(['SIGTERM', 'SIGKILL']);
      expect(result).toMatchObject({ termination: 'confirmed', exitCode: 0, timedOut: true });
      control.dispose();
    }
  });

  it('the audited 10 MiB frame bound also stops disabled-dispatch connections', async () => {
    const { __testOnlyChildProcessTransport: ChildProcessTransport, __testOnlyMcpTransportMaxBufferBytes: maxBytes } =
      await import('../../../src/mcp/tools/worker-invoke.mjs');
    const fakeStderr: any = new EventEmitter(); fakeStderr.resume = () => {};
    const fakeChild: any = {
      pid: 54321,
      stdout: new EventEmitter(), stderr: fakeStderr, stdin: new EventEmitter(),
      once(_event: string, _handler: any) { return this; },
    };
    const transport = new (ChildProcessTransport as any)(fakeChild, { terminate: () => ({ termination: 'uncertain' }) });
    fakeChild.stdout.destroy = vi.fn(); fakeChild.stdin.destroy = vi.fn();
    const errors: Error[] = [];
    await transport.start();
    transport.onerror = (error: Error) => errors.push(error);
    // Recovery eligibility cannot disable the audited stdout byte budget.
    fakeChild.stdout.emit('data', Buffer.alloc(maxBytes + 1, 0x41));
    expect(errors).toHaveLength(1);
    expect((errors[0] as any).code).toBe('OG_WORKER_MCP_FRAME_TOO_LARGE');
    expect(transport._buffer).toBeUndefined();
    fakeChild.stdout.emit('data', Buffer.from('another frame\n'));
    expect(errors).toHaveLength(1);
  });

  it('disabled-dispatch pre-launch failure releases capacity and output like current main', async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
    const briefPath = path.join(root, 'brief.md');
    const finalOutput = path.join(work, 'final.json');
    const f = buildFixture(root, 'mcp');
    f.snapshot.models.defaults.workerSelection!.dataClasses = { 'local-only': {} };
    // Not gated (see the systemd test above for why `canVerifyAttempt: false`
    // is the deterministic route), but `admission` IS still reached and set
    // to `{ gated: false }` before this throw -- unlike the pre-existing
    // "pre-spawn exception before any launch attempt" test (#2915 review 5,
    // finding 2b), which throws before `admission` is ever assigned at all
    // and correctly keeps its own blocked/uncertain split.
    registerWorkerRecoveryCapabilities(f.drivers.codex, { canVerifyAttempt: false });
    // `resolveWorkerInvocation` itself calls `mcpRegistry.get` once (its own
    // mcp-profile check, `src/serve/worker-invocation.ts`), BEFORE `run()`
    // ever reaches admission — that call, and `buildStructuredBrief`'s own
    // probe-resolve, must both succeed. Only the SECOND call within the
    // real request — `run()`'s own explicit
    // `mcpServer = await mcpRegistry.get(...)` fetch, strictly BEFORE
    // `spawnAttempted` is set — must throw, so this reaches the generic
    // catch-all with `admission` already resolved to `{ gated: false }`.
    let calls = 0;
    let failFromCall = Infinity;
    f.drivers.codex.mcpRegistry = {
      get: async () => {
        calls += 1;
        if (calls > failFromCall) throw new Error('synthetic: registry.get exploded before any launch');
        return { name: 'fixture-server', type: 'stdio' as const, command: 'fixture-only' };
      },
    };
    await buildStructuredBrief(f, { role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp' });
    failFromCall = calls + 1;
    const registry = createInvocationRegistry({ maxActive: 1 });
    const tools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, cfg: any, handler: any) { tools.set(name, { config: cfg, handler }); } }, {
      projectRoot: root, registry, allowDegraded: true, workerWorktreesRoot: work,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }), now: () => new Date(f.now),
    });
    const call = tools.get('worker-invoke').handler;
    const result = await call({ operation: 'run', request_id: '6c-disabled', role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp' });
    const body = JSON.parse(result.content[0].text);
    expect(body.status, JSON.stringify(body)).toBe('blocked');
    expect(body.termination).toBe('confirmed');
    expect(registry.canStart()).toBe(true);
    expect(existsSync(finalOutput)).toBe(false);
  });

  it('injected launch/call callbacks receive no admission property when not gated, matching origin/main (#2915 review 6, finding 6d)', async () => {
    const rootShell = await tempRoot();
    const workShell = path.join(rootShell, 'work'); await mkdir(workShell, { recursive: true });
    await writeFile(path.join(rootShell, 'brief.md'), 'hello');
    const fShell = buildFixture(rootShell, 'shell');
    registerWorkerRecoveryCapabilities(fShell.drivers.codex, { canVerifyAttempt: false });
    let capturedShellOptions: any;
    const shellTools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, config: any, handler: any) { shellTools.set(name, { config, handler }); } }, {
      projectRoot: rootShell, workerWorktreesRoot: workShell,
      loadWorkerInputs: async () => ({ snapshot: fShell.snapshot, drivers: fShell.drivers }),
      launchShellWorker: async (_invocation, options) => { capturedShellOptions = options; return { launched: true, mode: 'degraded', child: closingChild(0) }; },
      now: () => new Date(fShell.now),
    });
    await shellTools.get('worker-invoke').handler({
      operation: 'run', request_id: '6d-shell', role: 'coding', task: 'implementation', group: 'workers',
      brief: path.join(rootShell, 'brief.md'), workdir: workShell, final_output: path.join(workShell, 'final.json'), transport: 'shell',
    });
    expect(capturedShellOptions).toBeDefined();
    expect('admission' in capturedShellOptions).toBe(false);

    const rootMcp = await tempRoot();
    const workMcp = path.join(rootMcp, 'work'); await mkdir(workMcp, { recursive: true });
    const briefMcp = path.join(rootMcp, 'brief.md');
    const finalMcp = path.join(workMcp, 'final.json');
    const fMcp = buildFixture(rootMcp, 'mcp');
    fMcp.snapshot.models.defaults.workerSelection!.dataClasses = { 'local-only': {} };
    registerWorkerRecoveryCapabilities(fMcp.drivers.codex, { canVerifyAttempt: false });
    fMcp.drivers.codex.mcpRegistry = { get: async () => ({ name: 'fixture-server', type: 'stdio' as const, command: 'fixture-only' }) };
    await buildStructuredBrief(fMcp, { role: 'coding', task: 'implementation', group: 'workers',
      brief: briefMcp, workdir: workMcp, final_output: finalMcp, transport: 'mcp' });
    let capturedMcpOptions: any;
    const mcpTools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, cfg: any, handler: any) { mcpTools.set(name, { config: cfg, handler }); } }, {
      projectRoot: rootMcp, allowDegraded: true, workerWorktreesRoot: workMcp,
      loadWorkerInputs: async () => ({ snapshot: fMcp.snapshot, drivers: fMcp.drivers }),
      callMcpWorker: async (_binding, _server, options) => { capturedMcpOptions = options; return { outcome: 'blocked', diagnostic: 'test-capture-only' }; },
      now: () => new Date(fMcp.now),
    });
    await mcpTools.get('worker-invoke').handler({
      operation: 'run', request_id: '6d-mcp', role: 'coding', task: 'implementation', group: 'workers',
      brief: briefMcp, workdir: workMcp, final_output: finalMcp, transport: 'mcp',
    });
    expect(capturedMcpOptions).toBeDefined();
    expect('admission' in capturedMcpOptions).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #2915 round 8 (D6): disabled dispatch equals main through the REAL launch
// pipeline -- never through an injected `launchShellWorker`/`callMcpWorker`
// test double, which would hide exactly the defect being regression-tested
// (review 7 finding 13's second bullet names `defaultLaunchMcpWorkerProcess`
// and `planDirectWorkerLaunch` directly: "omitting the disabled admission
// loses CLI identity before the flat planner. It performs a new admission").
// ---------------------------------------------------------------------------
describe('disabled dispatch equals main through the real launch pipeline (#2915 round 8, D6)', () => {
  it('canVerifyAttempt:false completes through the REAL defaultLaunchMcpWorkerProcess/planDirectWorkerLaunch pipeline, never consulting the recovery breaker (review 7 finding 13, second bullet)', async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
    const briefPath = path.join(root, 'brief.md');
    const finalOutput = path.join(work, 'final.json');
    const recordPath = path.join(root, 'record.jsonl');
    const configPath = path.join(root, 'fixture-config.json');
    await writeFile(configPath, JSON.stringify({ recordPath, scenario: 'success' }));
    const f = buildFixture(root, 'mcp');
    registerWorkerRecoveryCapabilities(f.drivers.codex, { canVerifyAttempt: false });
    f.drivers.codex.mcpRegistry = {
      get: async () => ({ name: 'fixture-server', type: 'stdio' as const, command: process.execPath,
        args: [path.resolve('test/fixtures/ralph-worker-mcp.mjs')], env: { AIWG_FAKE_WORKER_CONFIG: configPath } }),
    };
    await buildStructuredBrief(f, { role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp' });
    // Before the fix, `planDirectWorkerLaunch`'s STANDALONE admission branch
    // independently re-derived eligibility with no knowledge of
    // `canVerifyAttempt`, and called `admit()` on whatever breaker is in
    // scope -- at reservation capacity, that returned `blocked` where
    // baseline always launched. This breaker THROWS if `admit` is ever
    // called at all, so reaching it (even successfully) would still fail
    // this run with a different diagnostic ("recovery admission failed
    // closed"), proving the standalone admission path is never entered.
    const throwingBreaker = { admit: () => { throw new Error('must never be reached: canVerifyAttempt:false is not-gated'); } };
    const tools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, cfg: any, handler: any) { tools.set(name, { config: cfg, handler }); } }, {
      projectRoot: root, allowDegraded: true, workerWorktreesRoot: work,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }), now: () => new Date(f.now),
      scopedBreaker: throwingBreaker,
    });
    const call = tools.get('worker-invoke').handler;
    const result = await call({ operation: 'run', request_id: `d6-mcp-${Math.random()}`, role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp' });
    const body = JSON.parse(result.content[0].text);
    expect(body.status, JSON.stringify(body)).toBe('completed');
    expect(body.termination).toBe('confirmed');
  }, 20000);

  // #2915 round 8 critique (D6) / review 7 finding 13 third bullet, M:1079:
  // "the new unconditional catch changes the same status/capacity behavior
  // and diagnostic, even globally disabled." A thrown `mcpRegistry.get()`
  // from `defaultCallMcpWorker`'s OWN pre-launch requalification recheck
  // must propagate exactly like origin/main when this attempt is not
  // gated -- settling `uncertain`/`uncertain` through this bridge's own
  // outer catch-all, never converted to a fail-closed `blocked` result.
  it('a thrown mcpRegistry.get() during the pre-launch requalification recheck propagates as a rejection when not gated, never converted to a blocked outcome', async () => {
    const { __testOnlyDefaultCallMcpWorker: defaultCallMcpWorker } = await import('../../../src/mcp/tools/worker-invoke.mjs');
    const mcpRegistry = { get: async () => { throw new Error('synthetic: registry requalification exploded'); } };
    // `admission` omitted entirely (matching how `run()` calls this when
    // `!admission?.gated`) -- `defaultCallMcpWorker` must take the literal
    // baseline branch (no try/catch around the requalification check) and
    // let the rejection propagate, exactly like origin/main's own
    // unconditional `if (mcpRegistry) { ... }` with no surrounding catch.
    await expect(defaultCallMcpWorker({ serverRef: 'fixture-server', tool: 'fixture-worker', timeoutSeconds: 1, sessionIsolation: 'per-call' },
      { type: 'stdio', command: 'unused-never-spawned' }, { mcpRegistry, sessionIsolation: 'per-call' }))
      .rejects.toThrow(/registry requalification exploded/);
  });

  it('the SAME thrown mcpRegistry.get() is fail-closed (converted to a blocked outcome) when this call is gated', async () => {
    const { __testOnlyDefaultCallMcpWorker: defaultCallMcpWorker } = await import('../../../src/mcp/tools/worker-invoke.mjs');
    const mcpRegistry = { get: async () => { throw new Error('synthetic: registry requalification exploded'); } };
    const breaker: any = { nowMs: () => Date.now() };
    const admission = { gated: true, breaker, token: { deadlineMs: Infinity } };
    const result = await defaultCallMcpWorker({ serverRef: 'fixture-server', tool: 'fixture-worker', timeoutSeconds: 1, sessionIsolation: 'per-call' },
      { type: 'stdio', command: 'unused-never-spawned' }, { mcpRegistry, admission, sessionIsolation: 'per-call' });
    expect(result).toMatchObject({ outcome: 'blocked', diagnostic: expect.stringMatching(/pre-spawn requalification failed/) });
  });

  // #2915 round 8 (D5) / review 7 finding 9: "a rejected stop helper
  // escapes as an unhandled timer rejection and leaves the run unresolved."
  it('degraded stop signal errors resolve uncertain without an unhandled timer rejection', async () => {
    const child: any = new EventEmitter(); child.pid = 12345; child.exitCode = null;
    child.kill = vi.fn(() => { throw new Error('synthetic: stop escalation exploded'); });
    const control = buildShellStopControl({ launched: true, mode: 'degraded', child }, { graceMs: 1 });
    const result = await control.wait(0);
    expect(result).toMatchObject({ termination: 'uncertain', exitCode: null, timedOut: true });
    expect(child.kill.mock.calls.map((args: any[]) => args[0])).toEqual(['SIGTERM', 'SIGKILL']);
    control.dispose();
  });
});

// ---------------------------------------------------------------------------
// #2915 round 8 (D5): the absolute deadline is enforced at the transport
// write boundary too -- AFTER the dynamic `serializeMessage` import -- with
// stop/cancel cleanup traffic exempt.
// ---------------------------------------------------------------------------
describe('absolute MCP deadline enforced at the transport write boundary (#2915 round 8, D5)', () => {
  function fakeTransportChild(writes: string[]) {
    const fakeStdin: any = new EventEmitter();
    fakeStdin.write = (data: string) => { writes.push(data); return true; };
    const fakeStderr: any = new EventEmitter(); fakeStderr.resume = () => {};
    return { stdin: fakeStdin, stdout: new EventEmitter(), stderr: fakeStderr, once() { return this; } };
  }

  it('send() refuses once the deadline has passed', async () => {
    const { __testOnlyChildProcessTransport: ChildProcessTransport } = await import('../../../src/mcp/tools/worker-invoke.mjs');
    const writes: string[] = [];
    const fakeChild: any = fakeTransportChild(writes);
    let now = 1000;
    const transport = new (ChildProcessTransport as any)(fakeChild, { deadlineAtMs: 1000, now: () => now });
    await transport.start();
    now = 1001; // one ms past the deadline
    await expect(transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} })).rejects.toThrow(/deadline/);
    expect(writes).toHaveLength(0);
  });

  it('send() exempts notifications/cancelled stop/cleanup traffic from the deadline check', async () => {
    const { __testOnlyChildProcessTransport: ChildProcessTransport } = await import('../../../src/mcp/tools/worker-invoke.mjs');
    const writes: string[] = [];
    const fakeChild: any = fakeTransportChild(writes);
    const transport = new (ChildProcessTransport as any)(fakeChild, { deadlineAtMs: 1000, now: () => 5000 });
    await transport.start();
    await transport.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1, reason: 'operator-cancel' } });
    expect(writes).toHaveLength(1);
  });

  it('send() allows a write before the deadline', async () => {
    const { __testOnlyChildProcessTransport: ChildProcessTransport } = await import('../../../src/mcp/tools/worker-invoke.mjs');
    const writes: string[] = [];
    const fakeChild: any = fakeTransportChild(writes);
    const transport = new (ChildProcessTransport as any)(fakeChild, { deadlineAtMs: 5000, now: () => 1000 });
    await transport.start();
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} });
    expect(writes).toHaveLength(1);
  });

  it('a disabled-dispatch (not gated) transport never enforces a deadline at all -- deadlineAtMs defaults to null', async () => {
    const { __testOnlyChildProcessTransport: ChildProcessTransport } = await import('../../../src/mcp/tools/worker-invoke.mjs');
    const writes: string[] = [];
    const fakeChild: any = fakeTransportChild(writes);
    const transport = new (ChildProcessTransport as any)(fakeChild, { enforceTransportBound: false });
    await transport.start();
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} });
    expect(writes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// #2915 round 8 (D4): the `reconcile_stopped` operation on this SAME
// `worker-invoke` status/cancel handler. Accepted only for an invocation
// whose stored reservation is `dispatched` with `stop: 'unresolved'`,
// applied to that invocation's actual breaker, idempotent.
// ---------------------------------------------------------------------------
describe('reconcile_stopped operator reconciliation (#2915 round 8, D4)', () => {
  function toolHandler(tools: Map<string, any>) {
    return tools.get('worker-invoke').handler;
  }

  /**
   * Build a REAL breaker with a `dispatched` reservation whose canary
   * deadline has already passed unresolved (`stop: 'unresolved'`) — the
   * exact precondition `reconcile_stopped`/`hasUnresolvedStop` must check.
   * A brand-new scope's FIRST admission is never a canary (`canaryKeys: []`,
   * `deadlineMs: Infinity`, never swept) — the scope must first be opened
   * by a trusted (`resolver`/`launcher`) failure so the NEXT admission is
   * admitted as the half-open canary with a real, finite deadline.
   */
  function openedCanaryReservation(invocationId: string, { startAtMs = 1_000_000 } = {}) {
    const breaker = new ScopedFailureBreaker({ policy: { canaryTimeoutMs: 100, cooldownMs: 1, distinctThreshold: 1, maxJitterMs: 0 } });
    let clockNow = startAtMs;
    (breaker as any).nowMs = () => clockNow;
    const opening = breaker.admit({ invocationId: `${invocationId}-opener`, scopeKeys: ['installation:codex'] });
    breaker.settle((opening as any).token, { kind: 'failed', reasonCode: 'AUTH', evidenceSource: 'resolver', cli: 'codex' });
    clockNow += 1000; // past the (jitter-free) 1ms cooldown; the scope is now due
    completeSyntheticPreliminaryProbe(breaker, `${invocationId}-preliminary`);
    const admitted = breaker.admit({ invocationId, scopeKeys: ['installation:codex'] });
    expect(admitted.ok).toBe(true);
    const token = (admitted as any).token;
    expect(token.canaryKeys.length).toBeGreaterThan(0); // genuinely the canary, not an ordinary admission
    expect(breaker.beginDispatch(token, { invocationId, selectionDigest: null }).ok).toBe(true);
    expect(breaker.commitDispatch(token).ok).toBe(true);
    clockNow = token.deadlineMs + 1; // past the canary's own bounded window
    breaker.expireStaleReservations();
    expect(breaker.hasUnresolvedStop(invocationId)).toBe(true);
    return breaker;
  }

  it('reconciles an invocation whose dispatched reservation has an unresolved stop marker, then is idempotent on a second call', async () => {
    const root = await tempRoot();
    const breaker = openedCanaryReservation('inv-reconcile-1');

    // Exercises the reconciliation surface against an explicit registry
    // seeded directly, in isolation from a full run() admission (which
    // would require a real worker dispatch) -- the registry/breaker
    // plumbing being tested is the same either way (see `registry.update(
    // entry.invocationId, { recoveryBreaker: admission.breaker })` in
    // `run()` itself).
    const registry = createInvocationRegistry();
    const tools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, cfg: any, handler: any) { tools.set(name, { config: cfg, handler }); } }, {
      projectRoot: root, registry,
    });
    const entry = registry.create({ requestId: 'req-reconcile-1', transport: 'mcp', status: 'uncertain', termination: 'uncertain', invocationId: 'inv-reconcile-1' });
    registry.update(entry.invocationId, { recoveryBreaker: breaker });

    const handler = toolHandler(tools);
    // #2915 round 8 review 8 (C7): before reconciliation, this invocation
    // still occupies a LIVE registry capacity slot (never marked
    // terminal) -- applying the confirmed stop must finalize that
    // capacity too, not just the breaker's own reservation table.
    expect(registry.get('inv-reconcile-1')?.terminalAt).toBeNull();
    const first = await handler({ operation: 'reconcile_stopped', invocation_id: 'inv-reconcile-1' });
    const firstBody = JSON.parse(first.content[0].text);
    expect(firstBody.reconciled).toBe(true);
    expect(breaker.hasUnresolvedStop('inv-reconcile-1')).toBe(false);
    // Capacity is finalized with a TRUTHFUL terminal state: `terminalAt`
    // is now set, but `status` is never flipped to an invented success --
    // it stays exactly the 'uncertain' this bridge actually observed.
    const finalized = registry.get('inv-reconcile-1');
    expect(finalized?.terminalAt).not.toBeNull();
    expect(finalized?.status).toBe('uncertain');
    expect(firstBody.status).toBe('uncertain');

    const second = await handler({ operation: 'reconcile_stopped', invocation_id: 'inv-reconcile-1' });
    const secondBody = JSON.parse(second.content[0].text);
    expect(secondBody.reconciled).toBe(false);
    expect(secondBody.reconcileReason).toMatch(/no dispatched reservation/);
  });

  it('refuses to reconcile an invocation with no tracked gated reservation', async () => {
    const root = await tempRoot();
    const registry = createInvocationRegistry();
    const tools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, cfg: any, handler: any) { tools.set(name, { config: cfg, handler }); } }, {
      projectRoot: root, registry,
    });
    registry.create({ requestId: 'req-no-breaker', transport: 'mcp', status: 'uncertain', termination: 'uncertain', invocationId: 'inv-no-breaker' });
    const handler = toolHandler(tools);
    const result = await handler({ operation: 'reconcile_stopped', invocation_id: 'inv-no-breaker' });
    const body = JSON.parse(result.content[0].text);
    expect(body.reconciled).toBe(false);
    expect(body.reconcileReason).toMatch(/no tracked gated reservation/);
  });

  it('requires invocation_id and refuses an unknown invocation_id', async () => {
    const root = await tempRoot();
    const tools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, cfg: any, handler: any) { tools.set(name, { config: cfg, handler }); } }, {
      projectRoot: root,
    });
    const handler = toolHandler(tools);
    const missingId = await handler({ operation: 'reconcile_stopped' });
    expect(missingId.isError).toBe(true);
    const unknownId = await handler({ operation: 'reconcile_stopped', invocation_id: '00000000-0000-4000-8000-000000000000' });
    expect(unknownId.isError).toBe(true);
  });

  it("ordinary status with no invocation_id lists invocations with unresolved stop evidence, and never mutates them", async () => {
    const root = await tempRoot();
    const breaker = openedCanaryReservation('inv-list-1', { startAtMs: 2_000_000 });

    const registry = createInvocationRegistry();
    const tools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, cfg: any, handler: any) { tools.set(name, { config: cfg, handler }); } }, {
      projectRoot: root, registry,
    });
    const entry = registry.create({ requestId: 'req-list-1', transport: 'mcp', status: 'uncertain', termination: 'uncertain', invocationId: 'inv-list-1' });
    registry.update(entry.invocationId, { recoveryBreaker: breaker });

    const handler = toolHandler(tools);
    const result = await handler({ operation: 'status' });
    const body = JSON.parse(result.content[0].text);
    expect(body.unresolvedReservations).toHaveLength(1);
    expect(body.unresolvedReservations[0].invocationId).toBe('inv-list-1');
    expect(body.unresolvedReservations[0].scopes).toContain('installation:codex');
    expect(typeof body.unresolvedReservations[0].ageMs).toBe('number');
    // Read-only: the marker is still there after a plain status call.
    expect(breaker.hasUnresolvedStop('inv-list-1')).toBe(true);
  });

  it("the reservation-capacity refusal names the reconcile_stopped operation when blocked by unresolved markers", async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
    const briefPath = path.join(root, 'brief.md');
    const finalOutput = path.join(work, 'final.json');
    const f = buildFixture(root, 'mcp');
    await buildStructuredBrief(f, { role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp' });
    const refusingBreaker: any = {
      nowMs: () => Date.now(),
      admit: () => ({ ok: false, blockedBy: ['reservation-capacity', 'blocking-markers:3'], nextEligibleAt: Date.now() }),
    };
    const tools = new Map<string, any>();
    await registerWorkerInvokeToolset({ registerTool(name: string, cfg: any, handler: any) { tools.set(name, { config: cfg, handler }); } }, {
      projectRoot: root, allowDegraded: true, workerWorktreesRoot: work,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }), now: () => new Date(f.now),
      scopedBreaker: refusingBreaker,
    });
    const handler = toolHandler(tools);
    const result = await handler({ operation: 'run', request_id: `d4-capacity-${Math.random()}`, role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp' });
    const body = JSON.parse(result.content[0].text);
    expect(body.status, JSON.stringify(body)).toBe('blocked');
    expect(body.diagnostics.join(' ')).toMatch(/blocking-markers:3/);
    expect(body.diagnostics.join(' ')).toMatch(/reconcile_stopped/);
  }, 20000);
});

describe('review 9 bounded recovery regressions', () => {
  const claims = { version: 1, status: 'completed', summary: 'synthetic review probe', claims: [], artifacts: [], checks: [], limitations: [] };

  async function probe(transport: 'shell' | 'mcp', extra: Record<string, any> = {}) {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work);
    const f = buildFixture(root, transport);
    const input = { operation: 'run', request_id: 'review-9-probe', role: 'coding', task: 'implementation', group: 'workers',
      brief: path.join(root, 'brief.json'), workdir: work, final_output: path.join(work, 'final.json'), transport };
    if (transport === 'mcp') await buildStructuredBrief(f, input as any);
    else await writeFile(input.brief, 'synthetic review probe');
    const registry = createInvocationRegistry({ maxActive: 1 });
    const breaker = extra.scopedBreaker ?? new ScopedFailureBreaker({ nowMs: () => 0, jitterMs: () => 0 });
    const tools = await captureTool(undefined, { projectRoot: root, registry, scopedBreaker: breaker, workerWorktreesRoot: work,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }), now: () => new Date(f.now), ...extra });
    return { call: tools.get('worker-invoke').handler, input, registry, breaker, f };
  }

  function commit(options: any) {
    const { admission } = options;
    const began = admission.breaker.beginDispatch(admission.token, { invocationId: admission.invocationId, selectionDigest: admission.selectionDigest });
    expect(began).toEqual({ ok: true });
    return sessionLauncherModule.debitDirectWorkerAllowance(admission.ledger).then(() => {
      expect(admission.breaker.commitDispatch(admission.token)).toEqual({ ok: true });
    });
  }

  // This speaks real JSON-RPC to the real SDK client and strict transport.
  // The substituted process can ignore both signals while dropping its tool.
  function stdioChild(advertise: boolean, closeOnEnd: boolean) {
    const child: any = new EventEmitter();
    child.pid = 987654; child.exitCode = null; child.signalCode = null;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    child.stdin.on('data', (bytes: Buffer) => {
      const message = JSON.parse(bytes.toString());
      if (message.id === undefined) return;
      let result: any;
      if (message.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } };
      else if (message.method === 'tools/list') result = { tools: advertise ? [{ name: 'fixture-worker', inputSchema: workerInputSchema, outputSchema: workerOutputSchema }] : [] };
      else if (message.method === 'tools/call') result = { content: [{ type: 'text', text: JSON.stringify(claims) }], structuredContent: claims, isError: false };
      else return;
      queueMicrotask(() => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`));
    });
    if (closeOnEnd) child.stdin.on('finish', () => { child.exitCode = 0; child.emit('close', 0); });
    return child;
  }

  it('B2: native success reconciles terminal evidence after the first follow-up, with a fixed observation bound', async () => {
    let terminal = false;
    const timers: Array<() => Promise<void>> = [];
    const recovery = await import('../../../tools/ralph-external/session-launcher.mjs');
    const observeLate = recovery.observeLateStopEvidence;
    const observer = vi.spyOn(recovery, 'observeLateStopEvidence').mockImplementation((observe: any) => observeLate(observe, {
      setTimer: (fn: any) => { timers.push(fn); return { unref() {} }; },
    }));
    const status = vi.fn(() => ({ active: !terminal, execMainCode: terminal ? 1 : 0 }));
    const launch = vi.spyOn(workerIsolation, 'launchIsolatedWorker').mockImplementation(async (options: any) => {
      await options.onDispatchCommit();
      return { launched: true, mode: 'systemd-unit', unit: 'r10-native-late', child: stdioChild(true, true) };
    });
    let p: any;
    try {
      p = await probe('mcp', { isolationStatus: status });
      const body = JSON.parse((await p.call(p.input)).content[0].text);
      expect(body.status, JSON.stringify(body)).toBe('completed');
      expect(timers).toHaveLength(1);
      await timers.shift()!(); // sole old follow-up: still nonterminal
      expect(p.breaker.hasUnresolvedStop(body.invocationId)).toBe(true);
      expect(timers).toHaveLength(1);
      terminal = true;
      await timers.shift()!();
      expect(p.breaker.snapshot().reservationsOutstanding).toBe(0);
      expect(p.registry.liveCount()).toBe(0);
      expect(p.registry.get(body.invocationId).status).toBe('completed');
      expect(timers).toHaveLength(0);
      p.breaker.destroy();
      resetInProcessAllowanceLedger();
      terminal = false;
      p = await probe('mcp', { isolationStatus: status });
      const retained = JSON.parse((await p.call(p.input)).content[0].text);
      const atSettlement = status.mock.calls.length;
      for (let i = 0; i < 3; i += 1) { expect(timers).toHaveLength(1); await timers.shift()!(); }
      expect(status.mock.calls.length - atSettlement).toBe(3);
      expect(timers).toHaveLength(0);
      expect(p.breaker.hasUnresolvedStop(retained.invocationId)).toBe(true);
      const reconciled = JSON.parse((await p.call({ operation: 'reconcile_stopped', invocation_id: retained.invocationId })).content[0].text);
      expect(reconciled.reconciled).toBe(true);
    } finally { observer.mockRestore(); launch.mockRestore(); p?.breaker.destroy(); }
  });

  // 24 owners (6x maxRetained) prove the bound; 200 timed out under full CI load (run 83861).
  it('B3: 24 independent breakers cannot grow one maxRetained:4 registry or replace its reconciliation owner', async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work);
    const brief = path.join(root, 'brief.md'); await writeFile(brief, 'owner-bound probe');
    const f = buildFixture(root, 'shell');
    const registry = createInvocationRegistry({ maxRetained: 4, maxActive: 8, now: () => 0 });
    const breakers: any[] = [];
    const launch = vi.fn(async (inv: any, options: any) => {
      await commit(options);
      await writeFile(inv.finalPath, `${JSON.stringify({ type: 'result', result: claims })}\n`);
      return { launched: true, mode: 'degraded', child: closingChild(0) };
    });
    let firstId: string = '';
    let lastHandler: any;
    try {
      for (let i = 0; i < 24; i += 1) {
        const breaker = new ScopedFailureBreaker({ nowMs: () => 0, jitterMs: () => 0 });
        breakers.push(breaker);
        const tools = await captureTool(undefined, { projectRoot: root, workerWorktreesRoot: work, registry, scopedBreaker: breaker,
          loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }), now: () => new Date(f.now), launchShellWorker: launch });
        lastHandler = tools.get('worker-invoke').handler;
        const body = JSON.parse((await lastHandler({ operation: 'run', request_id: `owner-${i}`, role: 'coding', task: 'implementation', group: 'workers',
          brief, workdir: work, final_output: path.join(work, `final-${i}.json`), transport: 'shell' })).content[0].text);
        if (i === 0) {
          expect(body.status).toBe('completed'); firstId = body.invocationId;
          expect(breaker.hasUnresolvedStop(firstId)).toBe(true);
        } else {
          expect(body).toMatchObject({ status: 'blocked', termination: 'confirmed' });
          expect(body.diagnostics.join(' ')).toMatch(/already has a recovery breaker owner/);
          expect(breaker.snapshot().reservationsOutstanding).toBe(0);
        }
        expect(registry.size).toBeLessThanOrEqual(4);
        expect(registry.seenCount).toBeLessThanOrEqual(4);
      }
      expect(launch).toHaveBeenCalledOnce();
      expect(registry.get(firstId).recoveryBreaker).toBe(breakers[0]);
      expect(registry.claimRequestId('owner-0')).toBe(firstId);
      const reconciled = JSON.parse((await lastHandler({ operation: 'reconcile_stopped', invocation_id: firstId })).content[0].text);
      expect(reconciled.reconciled).toBe(true);
      expect(breakers[0].snapshot().reservationsOutstanding).toBe(0);
    } finally { for (const breaker of breakers) breaker.destroy(); }
  }, 60_000);

  it('review 9 item 1: real native post-spawn refusal and shell submission uncertainty retain live registry capacity', async () => {
    const child = stdioChild(false, false);
    const launch = vi.spyOn(workerIsolation, 'launchIsolatedWorker').mockImplementation(async (options: any) => {
      await options.onDispatchCommit();
      return { launched: true, mode: 'degraded', child };
    });
    let native: any;
    let shell: any;
    try {
      native = await probe('mcp', { allowDegraded: true, terminateChildWithGrace: async () => ({ terminated: false }) });
      const body = JSON.parse((await native.call(native.input)).content[0].text);
      expect(body).toMatchObject({ status: 'blocked', termination: 'uncertain' });
      expect(body.diagnostics.join(' ')).toMatch(/no longer advertised/);
      expect(child.kill.mock.calls.map((args: any[]) => args[0])).toEqual(['SIGTERM', 'SIGKILL']);
      expect(native.registry.canStart()).toBe(false);
      expect(native.registry.get(body.invocationId).terminalAt).toBeNull();
      expect(native.breaker.hasUnresolvedStop(body.invocationId)).toBe(true);
      shell = await probe('shell', {
        isolationStatus: () => ({ active: true, execMainCode: 0 }),
        waitForUnitTermination: async () => ({ termination: 'uncertain', exitCode: null, timedOut: true }),
        stopWorkerUnit: async () => ({ ok: true }), killWorkerUnit: async () => ({ ok: true }),
        launchShellWorker: async (_inv: any, options: any) => {
        await commit(options);
          return { launched: false, mode: 'systemd-unit', unit: 'submission-unit', dispatchState: 'submission-uncertain' };
        } });
      const shellBody = JSON.parse((await shell.call(shell.input)).content[0].text);
      expect(shellBody).toMatchObject({ status: 'blocked', termination: 'uncertain' });
      expect(shell.registry.canStart()).toBe(false);
      expect(shell.registry.get(shellBody.invocationId).terminalAt).toBeNull();
      expect(shell.breaker.hasUnresolvedStop(shellBody.invocationId)).toBe(true);
    } finally { launch.mockRestore(); native?.breaker.destroy(); shell?.breaker.destroy(); }
  });

  it('review 9 item 2b: clean degraded close exactly at the monotonic deadline beats its timer but still fails', async () => {
    let monotonic = 0;
    const breaker = new ScopedFailureBreaker({ nowMs: () => monotonic, jitterMs: () => 0 });
    const child: any = new EventEmitter(); child.exitCode = null;
    const p = await probe('shell', { scopedBreaker: breaker, launchShellWorker: async (inv: any, options: any) => {
      await commit(options);
      await writeFile(inv.finalPath, `${JSON.stringify({ type: 'result', result: claims })}\n`);
      // Listener registration signals that preparation is finished; no timer
      // has had an opportunity to fire before this queued completion.
      const once = child.once.bind(child);
      child.once = (event: string, listener: any) => {
        once(event, listener);
        if (event === 'close') queueMicrotask(() => { monotonic = options.dispatchGuard.deadlineAtMs; child.exitCode = 0; child.emit('close', 0); });
        return child;
      };
      return { launched: true, mode: 'degraded', child };
    } });
    try {
      const body = JSON.parse((await p.call(p.input)).content[0].text);
      expect(body.status, JSON.stringify(body)).toBe('failed');
      expect(breaker.hasUnresolvedStop(body.invocationId)).toBe(true);
    } finally { breaker.destroy(); }
  });

  it('a never-executed systemd unit releases breaker and invocation reservations after stop plus fresh status', async () => {
    const client = systemdClientFixture();
    roots.push(client.root);
    vi.stubEnv('PATH', client.root);
    let monotonic = 0;
    const breaker = new ScopedFailureBreaker({ nowMs: () => monotonic, jitterMs: () => 0 });
    const stop = vi.fn(async () => ({ ok: true }));
    const kill = vi.fn();
    const exec = vi.fn(async () => ({ stdout: 'LoadState=loaded\nActiveState=inactive\nResult=resources\nExecMainStatus=0\nExecMainCode=0\nMainPID=0\n' }));
    const p = await probe('shell', { scopedBreaker: breaker,
      launchShellWorker: async (_inv: any, options: any) => {
        await commit(options);
        return { launched: true, mode: 'systemd-unit', unit: 'never-exec-unit' };
      },
      isolationStatus: () => ({ active: false, execMainCode: 0, result: 'resources', execMainStatus: 0 }),
      stopWorkerUnit: stop, killWorkerUnit: kill,
      waitForUnitTermination: (unit: string, duration: number, options: any) => waitForUnitTermination(unit, duration, {
        ...options, exec, pollIntervalMs: 300_000, sleep: async (ms: number) => { monotonic += ms; },
      }),
    });
    try {
      const body = JSON.parse((await p.call(p.input)).content[0].text);
      expect(body).toMatchObject({ status: 'failed', termination: 'confirmed' });
      expect(stop).toHaveBeenCalledOnce();
      expect(exec.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(kill).not.toHaveBeenCalled();
      expect(breaker.snapshot().reservationsOutstanding).toBe(0);
      expect(p.registry.liveCount()).toBe(0);
    } finally { breaker.destroy(); }
  });

  it('review 9 item 2c: real run passes an absolute monotonic systemd deadline despite a backward wall-clock step', async () => {
    const client = systemdClientFixture();
    roots.push(client.root);
    vi.stubEnv('PATH', client.root);
    let monotonic = 0;
    let wall = 100_000;
    const wallClock = vi.spyOn(Date, 'now').mockImplementation(() => wall);
    const breaker = new ScopedFailureBreaker({ nowMs: () => monotonic, jitterMs: () => 0 });
    let active = true;
    const stop = vi.fn(async () => { active = false; return { ok: true }; });
    const kill = vi.fn(async () => ({ ok: true }));
    const polls: { duration: number; deadlineAtMs?: number; clock: () => number }[] = [];
    const exec = vi.fn(async (binary: string, _args: string[], options: any) => {
      return { stdout: `LoadState=loaded\nActiveState=${active ? 'active' : 'inactive'}\nResult=success\nExecMainStatus=0\nExecMainCode=${active ? 0 : 1}\nMainPID=${active ? 42 : 0}\n` };
    });
    const p = await probe('shell', { scopedBreaker: breaker,
      launchShellWorker: async (_inv: any, options: any) => {
        await commit(options);
        return { launched: true, mode: 'systemd-unit', unit: 'clock-unit' };
      },
      isolationStatus: () => ({ active, execMainCode: active ? 0 : 1, result: 'success', execMainStatus: 0 }),
      stopWorkerUnit: stop, killWorkerUnit: kill,
      waitForUnitTermination: async (unit: string, duration: number, options: any) => {
        polls.push({ duration, ...options });
        return waitForUnitTermination(unit, duration, { ...options, exec,
          pollIntervalMs: 300_000, sleep: async (ms: number) => { monotonic += ms; wall -= ms * 2; } });
      },
    });
    try {
      const body = JSON.parse((await p.call(p.input)).content[0].text);
      expect(body.status, JSON.stringify(body)).toBe('failed');
      expect(stop).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledWith('clock-unit', expect.objectContaining({ signal: expect.any(AbortSignal), timeout: expect.any(Number) }));
      expect(kill).not.toHaveBeenCalled();
      expect(polls).toHaveLength(2);
      expect(polls[0].deadlineAtMs).toBeGreaterThan(0);
      expect(monotonic).toBe(polls[0].deadlineAtMs);
      expect(polls[1].duration).toBeGreaterThan(0); // fresh stop grace after the task deadline
      expect(polls[1]).not.toHaveProperty('deadlineAtMs');
      expect(polls.every(poll => poll.clock() === monotonic)).toBe(true);
      expect(exec).toHaveBeenCalledTimes(Math.ceil(polls[0].deadlineAtMs! / 300_000) + 1);
      for (const [binary, _args, options] of exec.mock.calls) {
        expect(binary).toBe(client.systemctl);
        expect(path.isAbsolute(binary)).toBe(true);
        expect(options.signal).toBeInstanceOf(AbortSignal);
        expect(options.env.PATH).toBe(client.root);
        expect(options.timeout).toBeGreaterThanOrEqual(1000);
      }
      expect(wall).toBeLessThan(100_000);
      expect(breaker.snapshot().reservationsOutstanding).toBe(0);
    } finally { wallClock.mockRestore(); breaker.destroy(); }
  });

  it('review 9 item 4: native systemd success, non-response and error query terminal owned-unit evidence before settlement', async () => {
    const child = stdioChild(true, true);
    const launch = vi.spyOn(workerIsolation, 'launchIsolatedWorker').mockImplementation(async (options: any) => {
      await options.onDispatchCommit();
      return { launched: true, mode: 'systemd-unit', unit: 'native-success-unit', child };
    });
    const status = vi.fn(() => ({ active: false, execMainCode: 1 }));
    const stop = vi.fn();
    const success = await probe('mcp', { isolationStatus: status, stopUnit: stop });
    try {
      const body = JSON.parse((await success.call(success.input)).content[0].text);
      expect(body.status, JSON.stringify(body)).toBe('completed');
      expect(status).toHaveBeenCalledWith('native-success-unit');
      expect(stop).not.toHaveBeenCalled();
      expect(success.breaker.snapshot().reservationsOutstanding).toBe(0);
      for (const outcome of ['timeout', 'isError', 'error']) {
        resetInProcessAllowanceLedger();
        const p = await probe('mcp', { isolationStatus: status, stopUnit: stop,
          callMcpWorker: async (_binding: any, _server: any, options: any) => {
            await commit(options);
            const evidence = { dispatchState: 'dispatched', isolationMode: 'systemd-unit', unitName: `native-${outcome}-unit` };
            return outcome !== 'isError' ? { outcome, ...evidence }
              : { outcome: 'responded', response: { isError: true }, ...evidence };
          },
        });
        try {
          const result = JSON.parse((await p.call(p.input)).content[0].text);
          expect(result.status).toBe(outcome === 'isError' ? 'failed' : 'uncertain');
          expect(status).toHaveBeenCalledWith(`native-${outcome}-unit`);
          expect(p.breaker.snapshot().reservationsOutstanding).toBe(0);
          expect(p.registry.canStart()).toBe(true);
        } finally { p.breaker.destroy(); }
      }
    } finally { launch.mockRestore(); success.breaker.destroy(); }
  });

  it('review 9 item 5: a retained stop promise reconciles ownership and registry capacity after the outward result', async () => {
    let terminal = false;
    let resolveStop: () => void = () => {};
    const stopping = new Promise<void>(resolve => { resolveStop = resolve; });
    const p = await probe('mcp', { isolationStatus: () => ({ active: !terminal, execMainCode: terminal ? 1 : 0 }),
      callMcpWorker: async (_binding: any, _server: any, options: any) => {
        await commit(options);
        const evidence = { isolationMode: 'systemd-unit', unitName: 'late-stop-unit', dispatchState: 'dispatched' };
        options.observeStop(stopping, evidence);
        return { outcome: 'timeout', ...evidence };
      },
    });
    try {
      const body = JSON.parse((await p.call(p.input)).content[0].text);
      expect(body).toMatchObject({ status: 'uncertain', termination: 'uncertain' });
      expect(p.registry.canStart()).toBe(false);
      expect(p.breaker.hasUnresolvedStop(body.invocationId)).toBe(true);
      terminal = true;
      resolveStop();
      await waitFor(() => p.registry.canStart());
      expect(p.breaker.snapshot().reservationsOutstanding).toBe(0);
      expect(p.registry.get(body.invocationId).terminalAt).not.toBeNull();
      expect(p.registry.get(body.invocationId).status).toBe('uncertain');
      const repeated = JSON.parse((await p.call({ operation: 'reconcile_stopped', invocation_id: body.invocationId })).content[0].text);
      expect(repeated.reconciled).toBe(false);
    } finally { resolveStop(); p.breaker.destroy(); }
  });
});

// ---------------------------------------------------------------------------
// #2915 round 8 (D6): equivalence tests. The frozen `8c812250d6` fixture
// (`test/fixtures/ralph-recovery-baseline/worker-invoke.mjs`) has NO
// admission/breaker/ledger concept at all; the current branch's `run()`,
// with dispatch disabled (`canVerifyAttempt: false`), must behave the same
// from an equivalent starting state: same result shape, same diagnostics,
// same callMcpWorker call count and call shape (modulo the `admission` key,
// which the current branch OMITS entirely when not gated -- proven
// separately by the "injected launch/call callbacks receive no admission
// property when not gated" test above).
//
// This covers a representative subset of the full scenario matrix the
// design calls for (success/non-zero/timeout/cancellation/early-error/
// resolver-error/native-throw/launch-refusal/oversized-transport/queue-
// contention, plus gated<->disabled interleavings) -- blocked (server not
// registered), isError, and an early resolver/validation error. The
// remaining scenarios (timeout, cancellation, native requalification throw,
// oversized-whitespace transport, queue contention, and gated->disabled
// interleavings on one server instance) are NOT covered here; see the
// final report.
// ---------------------------------------------------------------------------
describe('baseline equivalence (#2915 round 8, D6): frozen 8c812250d6 vs current branch with dispatch disabled', () => {
  async function runOnce(registerFn: any, callMcpWorker: any, { throwOnLoad = false }: { throwOnLoad?: boolean } = {}) {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
    const briefPath = path.join(root, 'brief.md');
    const finalOutput = path.join(work, 'final.json');
    const f = buildFixture(root, 'mcp');
    registerWorkerRecoveryCapabilities(f.drivers.codex, { canVerifyAttempt: false }); // meaningless/ignored by the baseline fixture; disables gating on the branch
    if (!throwOnLoad) {
      // `buildFixture`'s own default `mcpRegistry.get()` (a valid stdio
      // entry) is what the resolver PROBE below needs to succeed; swap in
      // the "not registered" double only AFTER the brief is built.
      await buildStructuredBrief(f, { role: 'coding', task: 'implementation', group: 'workers',
        brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp' });
      f.drivers.codex.mcpRegistry = { get: async () => null };
    } else {
      await writeFile(briefPath, 'placeholder');
    }
    const calls: any[] = [];
    const tools = new Map<string, any>();
    await registerFn({ registerTool(name: string, cfg: any, handler: any) { tools.set(name, { config: cfg, handler }); } }, {
      projectRoot: root, allowDegraded: true, workerWorktreesRoot: work,
      loadWorkerInputs: throwOnLoad
        ? async () => { throw new Error('synthetic: resolver/input failure'); }
        : async () => ({ snapshot: f.snapshot, drivers: f.drivers }),
      now: () => new Date(f.now),
      callMcpWorker: async (...args: any[]) => { calls.push(args); return callMcpWorker(...args); },
    });
    const handler = tools.get('worker-invoke').handler;
    const result = await handler({ operation: 'run', request_id: `equiv-${Math.random()}`, role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp' });
    const body = JSON.parse(result.content[0].text);
    return { body, calls };
  }

  it('scenario: mcp server not registered -- blocked/confirmed, identical diagnostic text', async () => {
    const neverCalled = async () => { throw new Error('must never be called: no server registered'); };
    const baseline = await runOnce(workerInvokeBaseline.registerWorkerInvokeToolset, neverCalled);
    const branch = await runOnce(registerProductionToolset, neverCalled);
    expect(branch.body.status).toBe(baseline.body.status);
    expect(branch.body.termination).toBe(baseline.body.termination);
    expect(branch.body.diagnostics).toEqual(baseline.body.diagnostics);
    expect(baseline.body.status).toBe('blocked');
    expect(baseline.calls).toHaveLength(0);
    expect(branch.calls).toHaveLength(0);
  }, 20000);

  it('scenario: isError response -- failed/confirmed, identical diagnostic text, one call each, no admission key either side', async () => {
    async function registerWithServer(registerFn: any) {
      const callMcpWorker = async () => ({ outcome: 'responded', response: { isError: true, content: [{ type: 'text', text: 'Synthetic worker failure' }] } });
      const root = await tempRoot();
      const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
      const briefPath = path.join(root, 'brief.md');
      const finalOutput = path.join(work, 'final.json');
      const f = buildFixture(root, 'mcp');
      registerWorkerRecoveryCapabilities(f.drivers.codex, { canVerifyAttempt: false });
      f.drivers.codex.mcpRegistry = { get: async () => ({ name: 'fixture-server', type: 'stdio' as const, command: 'unused-never-spawned' }) };
      await buildStructuredBrief(f, { role: 'coding', task: 'implementation', group: 'workers',
        brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp' });
      const calls: any[] = [];
      const tools = new Map<string, any>();
      await registerFn({ registerTool(name: string, cfg: any, handler: any) { tools.set(name, { config: cfg, handler }); } }, {
        projectRoot: root, allowDegraded: true, workerWorktreesRoot: work,
        loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }), now: () => new Date(f.now),
        callMcpWorker: async (...args: any[]) => { calls.push(args); return callMcpWorker(...args); },
      });
      const handler = tools.get('worker-invoke').handler;
      const result = await handler({ operation: 'run', request_id: `equiv-isError-${Math.random()}`, role: 'coding', task: 'implementation', group: 'workers',
        brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp' });
      return { body: JSON.parse(result.content[0].text), calls };
    }
    const baseline = await registerWithServer(workerInvokeBaseline.registerWorkerInvokeToolset);
    const branch = await registerWithServer(registerProductionToolset);
    expect(branch.body.status).toBe(baseline.body.status);
    expect(branch.body.termination).toBe(baseline.body.termination);
    expect(branch.body.diagnostics).toEqual(baseline.body.diagnostics);
    expect(baseline.body.status).toBe('failed');
    expect(baseline.calls).toHaveLength(1);
    expect(branch.calls).toHaveLength(1);
    // The call's own 3rd argument is the options object `callMcpWorker` receives.
    expect('admission' in baseline.calls[0][2]).toBe(false);
    expect('admission' in branch.calls[0][2]).toBe(false);
  }, 20000);

  // Proven pre-dispatch failures release capacity and private output on both sides.
  it('scenario: a thrown loadWorkerInputs (early resolver/input error) -- byte-equivalent to baseline (round 8, D6)', async () => {
    const neverCalled = async () => { throw new Error('must never be called: never reaches a launch'); };
    const baseline = await runOnce(workerInvokeBaseline.registerWorkerInvokeToolset, neverCalled, { throwOnLoad: true });
    const branch = await runOnce(registerProductionToolset, neverCalled, { throwOnLoad: true });
    expect(baseline.body.status).toBe('blocked');
    expect(baseline.body.termination).toBe('confirmed');
    expect(branch.body.status).toBe(baseline.body.status);
    expect(branch.body.termination).toBe(baseline.body.termination);
    expect(branch.body.diagnostics).toEqual(baseline.body.diagnostics);
  }, 20000);
});

// ---------------------------------------------------------------------------
// #2915 round 8 (D6): the FULL equivalence scenario matrix the design calls
// for (design-round8-2915.md D6; crit-round8-2915.md D6's fixture-pinning
// requirement), driven through the frozen 8c812250d6 fixture's own run() AND
// the branch's run(), from an equivalent starting state, with recovery not
// gated. Two independent ways to reach "not gated" are exercised:
// `global-off` (`parallelism.worker_dispatch: false` -- `admission` is set
// to `{ gated: false }` directly; `admitDirectWorker` is never even called,
// see `runInner`'s decision point in worker-invoke.mjs) and
// `cli-cannot-verify` (`drivers.codex.canVerifyAttempt: false` --
// `admitDirectWorker` IS called and returns `{ gated: false }` before ever
// touching the breaker or ledger, per its own documented eligibility order;
// this is also the ONLY one of the two that still reaches a genuinely
// launchable plan through the REAL resolver, so it is the one used for
// every scenario below that needs to exercise `continueBaseline`'s
// transport-specific branches end-to-end -- see the "mcp transport against
// the real fake stdio worker" describe block's own comment for why).
//
// A third knob, `clis.codex.enabled: false` (the literal "per-CLI switch"),
// is covered once, explicitly, in its own test below: it disables the
// models RESOLVER itself for that CLI (not merely this bridge's own
// admission), so every scenario collapses to the SAME PREFIX-level
// "blocked at the resolver" outcome on both sides regardless of which
// scenario's doubles are wired up -- a real equivalence proof, but a
// degenerate one (it cannot reach `continueBaseline` at all, so repeating
// it across all ten scenarios would just re-prove the same fact ten times).
// That same fact is already covered, non-degenerately, by the shared-PREFIX
// equivalence tests above ("a pre-prefix-decision exception matches
// origin/main", "a thrown loadWorkerInputs... byte-equivalent to baseline").
// ---------------------------------------------------------------------------
describe('disabled dispatch equals main through the full #2915 round 8 (D6) scenario matrix', () => {
  type Gating = 'global-off' | 'cli-cannot-verify';

  function applyGating(f: any, gating: Gating) {
    if (gating === 'global-off') {
      f.snapshot.config.parallelism!.worker_dispatch = false;
    } else {
      registerWorkerRecoveryCapabilities(f.drivers.codex, { canVerifyAttempt: false });
    }
  }

  /** Spies proving the recovery module's LEDGER primitives are never
   * consulted on the not-gated path. `admitDirectWorker` itself may still
   * be called (see the describe-block comment above), but nothing it could
   * reach past deciding `{ gated: false }` may run. */
  function spyOnLedger() {
    const reserve = vi.spyOn(sessionLauncherModule, 'reserveDirectWorkerAllowance');
    const debit = vi.spyOn(sessionLauncherModule, 'debitDirectWorkerAllowance');
    const refund = vi.spyOn(sessionLauncherModule, 'refundDirectWorkerAllowance');
    const settle = vi.spyOn(sessionLauncherModule, 'settleDirectWorker');
    return {
      assertNeverCalled() {
        expect(reserve, 'reserveDirectWorkerAllowance must never be called when not gated').not.toHaveBeenCalled();
        expect(debit, 'debitDirectWorkerAllowance must never be called when not gated').not.toHaveBeenCalled();
        expect(refund, 'refundDirectWorkerAllowance must never be called when not gated').not.toHaveBeenCalled();
        expect(settle, 'settleDirectWorker must never be called when not gated').not.toHaveBeenCalled();
      },
      restore() { reserve.mockRestore(); debit.mockRestore(); refund.mockRestore(); settle.mockRestore(); },
    };
  }
  /** A breaker that throws the instant ANY method is touched -- threaded
   * through as `scopedBreaker` so that if `admitDirectWorker`'s own
   * eligibility order ever regresses to consulting the breaker before
   * deciding `gated: false`, these tests fail loudly instead of silently
   * passing. */
  function throwingBreaker() {
    return new Proxy({}, { get(_t, prop) { return () => { throw new Error(`must never be reached: breaker.${String(prop)}() on a not-gated attempt`); }; } });
  }

  async function runShellPair(gating: Gating, buildOptions: (calls: any[]) => Record<string, unknown>, input: Record<string, unknown> = {}) {
    async function runOne(registerFn: any) {
      const calls: any[] = [];
      const root = await tempRoot();
      const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
      const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'hello');
      const finalOutput = path.join(work, 'final.json');
      const f = buildFixture(root, 'shell');
      applyGating(f, gating);
      const registry = createInvocationRegistry({ maxActive: 4 });
      const tools = new Map<string, any>();
      const ledgerSpies = spyOnLedger();
      await registerFn({ registerTool(name: string, cfg: any, handler: any) { tools.set(name, { config: cfg, handler }); } }, {
        projectRoot: root, registry, allowDegraded: true, workerWorktreesRoot: work,
        loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }),
        now: () => new Date(f.now), gateInputs: { live: HEALTHY_GATE_LIVE }, scopedBreaker: throwingBreaker(),
        ...buildOptions(calls),
      });
      const handler = tools.get('worker-invoke').handler;
      const result = await handler({ operation: 'run', request_id: `equiv-shell-${Math.random()}`, role: 'coding', task: 'implementation', group: 'workers',
        brief: briefPath, workdir: work, final_output: finalOutput, transport: 'shell', ...input });
      const body = JSON.parse(result.content[0].text);
      ledgerSpies.assertNeverCalled();
      ledgerSpies.restore();
      return { body, registry, calls };
    }
    const baseline = await runOne(workerInvokeBaseline.registerWorkerInvokeToolset);
    const branch = await runOne(registerProductionToolset);
    return { baseline, branch };
  }

  async function runMcpPair(gating: Gating, buildOptions: (calls: any[]) => Record<string, unknown>, input: Record<string, unknown> = {}) {
    async function runOne(registerFn: any) {
      const calls: any[] = [];
      const root = await tempRoot();
      const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
      const briefPath = path.join(root, 'brief.md');
      const finalOutput = path.join(work, 'final.json');
      const f = buildFixture(root, 'mcp');
      applyGating(f, gating);
      await buildStructuredBrief(f, { role: 'coding', task: 'implementation', group: 'workers',
        brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp' });
      const registry = createInvocationRegistry({ maxActive: 4 });
      const tools = new Map<string, any>();
      const ledgerSpies = spyOnLedger();
      await registerFn({ registerTool(name: string, cfg: any, handler: any) { tools.set(name, { config: cfg, handler }); } }, {
        projectRoot: root, registry, allowDegraded: true, workerWorktreesRoot: work,
        loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }),
        now: () => new Date(f.now), gateInputs: { live: HEALTHY_GATE_LIVE }, scopedBreaker: throwingBreaker(),
        ...buildOptions(calls),
      });
      const handler = tools.get('worker-invoke').handler;
      const result = await handler({ operation: 'run', request_id: `equiv-mcp-${Math.random()}`, role: 'coding', task: 'implementation', group: 'workers',
        brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp', ...input });
      const body = JSON.parse(result.content[0].text);
      ledgerSpies.assertNeverCalled();
      ledgerSpies.restore();
      return { body, registry, calls };
    }
    const baseline = await runOne(workerInvokeBaseline.registerWorkerInvokeToolset);
    const branch = await runOne(registerProductionToolset);
    return { baseline, branch };
  }

  // #2915 round 8 (D6): `global-off` (`parallelism.worker_dispatch: false`)
  // is EXCLUDED from this per-scenario loop -- empirically (confirmed via
  // the resolver-level probes elsewhere in this file, and reproduced while
  // writing this suite), the models RESOLVER itself treats
  // `worker_dispatch: false` as "disabled" and refuses to produce a
  // launchable plan AT ALL, exactly like `clis.codex.enabled: false` does.
  // Every one of the scenarios below needs a genuinely launchable plan to
  // reach `continueBaseline`'s transport-specific branches; looping
  // `global-off` through them would not re-exercise those branches, it
  // would just rediscover the SAME "blocked at the resolver" outcome ten
  // times over (the one already covered, non-degenerately, by "a
  // pre-prefix-decision exception matches origin/main" and the dedicated
  // "literal per-CLI switch off" test below). `global-off`'s own
  // equivalence is covered by its OWN dedicated test immediately after
  // this loop, parallel to the per-CLI one.
  const GATINGS: Gating[] = ['cli-cannot-verify'];

  for (const gating of GATINGS) {
    describe(`gating: ${gating}`, () => {
      it('scenario: success (confirmed exit 0, valid claims)', async () => {
        const claims = { version: 1, status: 'completed', summary: 'ok', claims: [], artifacts: [], checks: [], limitations: [] };
        const buildOptions = (calls: any[]) => ({
          launchShellWorker: async (invocation: any, options: any) => {
            calls.push({ fn: 'launchShellWorker', hasAdmission: 'admission' in options });
            await writeFile(invocation.finalPath, `${JSON.stringify({ type: 'result', result: claims })}\n`);
            return { launched: true, mode: 'degraded', child: closingChild(0) };
          },
        });
        const { baseline, branch } = await runShellPair(gating, buildOptions);
        expect(baseline.body.status, JSON.stringify(baseline.body)).toBe('completed');
        expect(branch.body.status, JSON.stringify(branch.body)).toBe(baseline.body.status);
        expect(branch.body.termination).toBe(baseline.body.termination);
        expect(branch.calls).toHaveLength(1);
        expect(baseline.calls).toHaveLength(1);
        expect(branch.calls[0].hasAdmission).toBe(false);
        expect(baseline.calls[0].hasAdmission).toBe(false);
        expect(branch.registry.canStart()).toBe(baseline.registry.canStart());
      }, 20000);

      it('scenario: non-zero exit (confirmed, failed)', async () => {
        const buildOptions = (calls: any[]) => ({
          launchShellWorker: async (invocation: any, options: any) => {
            calls.push({ fn: 'launchShellWorker', hasAdmission: 'admission' in options });
            return { launched: true, mode: 'degraded', child: closingChild(1) };
          },
        });
        const { baseline, branch } = await runShellPair(gating, buildOptions);
        expect(baseline.body.status, JSON.stringify(baseline.body)).toBe('failed');
        expect(branch.body.status, JSON.stringify(branch.body)).toBe(baseline.body.status);
        expect(branch.body.termination).toBe(baseline.body.termination);
        expect(branch.registry.canStart()).toBe(baseline.registry.canStart());
      }, 20000);

      it('scenario: systemd timeout escalates and retains capacity until termination is proven', async () => {
        const buildOptions = (calls: any[]) => ({
          launchShellWorker: async (invocation: any, options: any) => {
            calls.push({ fn: 'launchShellWorker', hasAdmission: 'admission' in options });
            return { launched: true, mode: 'systemd-unit', unit: 'fake-unit-equiv' };
          },
          waitForUnitTermination: async (_unit: any, _deadlineMs: any, options: any) => {
            calls.push({ fn: 'waitForUnitTermination', argCount: options === undefined ? 2 : 3 });
            return { termination: 'uncertain', exitCode: null, timedOut: true };
          },
        });
        const { baseline, branch } = await runShellPair(gating, buildOptions);
        expect(baseline.body.status, JSON.stringify(baseline.body)).toBe('uncertain');
        expect(branch.body.status, JSON.stringify(branch.body)).toBe(baseline.body.status);
        expect(branch.body.termination).toBe(baseline.body.termination);
        expect(branch.registry.canStart()).toBe(baseline.registry.canStart());
        // Abortable status observation remains active when recovery is disabled.
        const waitCall = (calls: any[]) => calls.find(c => c.fn === 'waitForUnitTermination');
        expect(waitCall(branch.calls)?.argCount).toBe(3);
        expect(waitCall(baseline.calls)?.argCount).toBe(3);
      }, 20000);

      it('scenario: timeout under degraded isolation, including a clean close arriving during timeout handling (literal base Promise race on both sides)', async () => {
        const buildOptions = (calls: any[]) => ({
          launchShellWorker: async (invocation: any, options: any) => {
            calls.push({ fn: 'launchShellWorker', hasAdmission: 'admission' in options });
            const child: any = new EventEmitter();
            child.kill = () => true;
            // A clean exit-0 close arrives WHILE this bridge's own deadline
            // timer is also pending -- base's literal (synchronous-resolve)
            // Promise construction means whichever fires first wins; firing
            // the close event on the very next tick (before the fixed
            // 10ms-equivalent timeout below) deterministically exercises
            // the close-wins race identically on both sides.
            setImmediate(() => child.emit('close', 0));
            return { launched: true, mode: 'degraded', child };
          },
        });
        const claims = { version: 1, status: 'completed', summary: 'ok', claims: [], artifacts: [], checks: [], limitations: [] };
        // The deadline (derived from `invocation.limits.wallSeconds`) is far
        // longer than the `setImmediate` delay above, so close always wins
        // deterministically on both sides -- this proves the LITERAL base
        // Promise race (no `finishOnce`/async indirection) is what the
        // not-gated continuation actually runs, not merely that the race
        // exists in principle.
        async function runWithFinalWrite(gatingArg: Gating) {
          async function runOne(registerFn: any) {
            const calls: any[] = [];
            const root = await tempRoot();
            const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
            const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'hello');
            const finalOutput = path.join(work, 'final.json');
            const f = buildFixture(root, 'shell');
            applyGating(f, gatingArg);
            const registry = createInvocationRegistry({ maxActive: 4 });
            const tools = new Map<string, any>();
            await registerFn({ registerTool(name: string, cfg: any, handler: any) { tools.set(name, { config: cfg, handler }); } }, {
              projectRoot: root, registry, allowDegraded: true, workerWorktreesRoot: work,
              loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }),
              now: () => new Date(f.now), gateInputs: { live: HEALTHY_GATE_LIVE }, scopedBreaker: throwingBreaker(),
              launchShellWorker: async (invocation: any, options: any) => {
                calls.push({ fn: 'launchShellWorker', hasAdmission: 'admission' in options });
                await writeFile(invocation.finalPath, `${JSON.stringify({ type: 'result', result: claims })}\n`);
                const child: any = new EventEmitter();
                child.kill = () => true;
                setImmediate(() => child.emit('close', 0));
                return { launched: true, mode: 'degraded', child };
              },
            });
            const handler = tools.get('worker-invoke').handler;
            const result = await handler({ operation: 'run', request_id: `equiv-degraded-race-${Math.random()}`, role: 'coding', task: 'implementation', group: 'workers',
              brief: briefPath, workdir: work, final_output: finalOutput, transport: 'shell' });
            return { body: JSON.parse(result.content[0].text), registry, calls };
          }
          const baselineRun = await runOne(workerInvokeBaseline.registerWorkerInvokeToolset);
          const branchRun = await runOne(registerProductionToolset);
          return { baseline: baselineRun, branch: branchRun };
        }
        const { baseline, branch } = await runWithFinalWrite(gating);
        expect(baseline.body.status, JSON.stringify(baseline.body)).toBe('completed');
        expect(branch.body.status, JSON.stringify(branch.body)).toBe(baseline.body.status);
        expect(branch.body.termination).toBe(baseline.body.termination);
      }, 20000);

      it('scenario: cancellation (cancelled, confirmed, even though the worker later claims completed)', async () => {
        async function runWithCancel(registerFn: any) {
          const calls: any[] = [];
          const root = await tempRoot();
          const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
          const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'hello');
          const finalOutput = path.join(work, 'final.json');
          const f = buildFixture(root, 'shell');
          applyGating(f, gating);
          const registry = createInvocationRegistry({ maxActive: 4 });
          const tools = new Map<string, any>();
          const claims = { version: 1, status: 'completed', summary: 'ok', claims: [], artifacts: [], checks: [], limitations: [] };
          const child: any = new EventEmitter();
          child.kill = () => true;
          let releaseLaunch: () => void = () => {};
          let launchCalled = false;
          await registerFn({ registerTool(name: string, cfg: any, handler: any) { tools.set(name, { config: cfg, handler }); } }, {
            projectRoot: root, registry, allowDegraded: true, workerWorktreesRoot: work,
            loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }),
            now: () => new Date(f.now), gateInputs: { live: HEALTHY_GATE_LIVE }, scopedBreaker: throwingBreaker(),
            // The launch itself does not resolve until `releaseLaunch` is
            // called -- `launchCalled` is the correct readiness signal (not
            // the registry entry's 'running' status, which is already true
            // from `registry.create()` well BEFORE this function is ever
            // invoked -- waiting on that instead raced `releaseLaunch`
            // against a `launchShellWorkerImpl` call that had not happened
            // yet, permanently hanging on the stale no-op default).
            launchShellWorker: (invocation: any, options: any) => {
              calls.push({ fn: 'launchShellWorker', hasAdmission: 'admission' in options });
              launchCalled = true;
              return new Promise(resolve => { releaseLaunch = () => resolve({ launched: true, mode: 'degraded', child }); });
            },
          });
          const handler = tools.get('worker-invoke').handler;
          const runPromise = handler({ operation: 'run', request_id: `equiv-cancel-${Math.random()}`, role: 'coding', task: 'implementation', group: 'workers',
            brief: briefPath, workdir: work, final_output: finalOutput, transport: 'shell' });
          await waitFor(() => launchCalled);
          const [pendingEntry] = registry.values().filter((e: any) => e.status === 'running');
          await handler({ operation: 'cancel', invocation_id: pendingEntry.invocationId });
          // Only write the final-output content once the launch has
          // actually been reached (proving `reserveFinalOutput`'s own
          // exclusive create already succeeded) -- writing any earlier
          // races the bridge's own reservation.
          await writeFile(finalOutput, `${JSON.stringify({ type: 'result', result: claims })}\n`);
          releaseLaunch();
          await waitFor(() => child.listenerCount('close') > 0);
          child.emit('close', 0);
          const result = await runPromise;
          return { body: JSON.parse(result.content[0].text), registry, calls };
        }
        const baseline = await runWithCancel(workerInvokeBaseline.registerWorkerInvokeToolset);
        const branch = await runWithCancel(registerProductionToolset);
        expect(baseline.body.status, JSON.stringify(baseline.body)).toBe('cancelled');
        expect(branch.body.status, JSON.stringify(branch.body)).toBe(baseline.body.status);
        expect(branch.body.termination).toBe(baseline.body.termination);
      }, 20000);

      it('scenario: launch refusal (dispatch gate blocked before any spawn)', async () => {
        const buildOptions = (calls: any[]) => ({
          launchShellWorker: async (invocation: any, options: any) => {
            calls.push({ fn: 'launchShellWorker', hasAdmission: 'admission' in options });
            return { launched: false, blocked: true, diagnostic: 'synthetic: dispatch gate refused' };
          },
        });
        const { baseline, branch } = await runShellPair(gating, buildOptions);
        expect(baseline.body.status, JSON.stringify(baseline.body)).toBe('blocked');
        expect(branch.body.status, JSON.stringify(branch.body)).toBe(baseline.body.status);
        expect(branch.body.termination).toBe(baseline.body.termination);
        expect(branch.body.diagnostics).toEqual(baseline.body.diagnostics);
        expect(branch.registry.canStart()).toBe(baseline.registry.canStart());
        expect(branch.registry.canStart()).toBe(true); // proven pre-spawn refusal frees capacity on both sides
      }, 20000);

      it('scenario: native MCP pre-spawn registry failure is blocked with confirmed zero dispatch', async () => {
        async function runWithThrowingRequalification(registerFn: any) {
          const root = await tempRoot();
          const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
          const briefPath = path.join(root, 'brief.md');
          const finalOutput = path.join(work, 'final.json');
          const f = buildFixture(root, 'mcp');
          applyGating(f, gating);
          // `resolveWorkerInvocation` itself calls `mcpRegistry.get` once
          // (its own mcp-profile check) BEFORE `run()` ever reaches the
          // requalification recheck inside `defaultCallMcpWorker*`; that
          // call, and `buildStructuredBrief`'s own probe-resolve, must both
          // succeed. Only the call strictly inside the real run (after this
          // test's own two probe-resolves) throws.
          let calls = 0;
          let failFromCall = Infinity;
          f.drivers.codex.mcpRegistry = {
            get: async () => {
              calls += 1;
              if (calls > failFromCall) throw new Error('synthetic: registry.get exploded before any launch');
              return { name: 'fixture-server', type: 'stdio' as const, command: 'fixture-only' };
            },
          };
          await buildStructuredBrief(f, { role: 'coding', task: 'implementation', group: 'workers',
            brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp' });
          failFromCall = calls + 1;
          const registry = createInvocationRegistry({ maxActive: 4 });
          const tools = new Map<string, any>();
          await registerFn({ registerTool(name: string, cfg: any, handler: any) { tools.set(name, { config: cfg, handler }); } }, {
            projectRoot: root, registry, allowDegraded: true, workerWorktreesRoot: work,
            loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }),
            now: () => new Date(f.now), gateInputs: { live: HEALTHY_GATE_LIVE }, scopedBreaker: throwingBreaker(),
          });
          const handler = tools.get('worker-invoke').handler;
          const result = await handler({ operation: 'run', request_id: `equiv-native-throw-${Math.random()}`, role: 'coding', task: 'implementation', group: 'workers',
            brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp' });
          return { body: JSON.parse(result.content[0].text), registry };
        }
        const baseline = await runWithThrowingRequalification(workerInvokeBaseline.registerWorkerInvokeToolset);
        const branch = await runWithThrowingRequalification(registerProductionToolset);
        expect(baseline.body.status, JSON.stringify(baseline.body)).toBe('blocked');
        expect(branch.body.status, JSON.stringify(branch.body)).toBe(baseline.body.status);
        expect(branch.body.termination).toBe(baseline.body.termination);
        expect(branch.registry.canStart()).toBe(baseline.registry.canStart());
      }, 20000);
    });
  }

  // -------------------------------------------------------------------------
  // The literal "per-CLI switch" (`clis.codex.enabled: false`) degenerate
  // case (see describe-block comment): proven ONCE, not per-scenario.
  // -------------------------------------------------------------------------
  it('scenario: audited brief-json preparation supplies a private params file on both sides', async () => {
    async function runOne(registerFn: any, isolation: any) {
      const root = await tempRoot();
      const work = path.join(root, 'work'); await mkdir(work);
      const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'private brief content');
      const finalOutput = path.join(work, 'final.json');
      const f = buildFixture(root, 'shell');
      registerWorkerRecoveryCapabilities(f.drivers.codex, { canVerifyAttempt: false });
      const originalBuildInvocation = f.drivers.codex.buildInvocation;
      f.drivers.codex.buildInvocation = async (input: any) => ({ ...(await originalBuildInvocation(input)), stdin: 'brief-json' });
      let framed: any;
      let framedPath = '';
      const launch = vi.spyOn(isolation, 'launchIsolatedWorker').mockImplementation(async (options: any) => {
        framedPath = options.stdinPath;
        framed = JSON.parse(await readFile(framedPath, 'utf8'));
        expect(options.command).not.toContain('private brief content');
        expect(JSON.stringify(options.args)).not.toContain('private brief content');
        expect((await stat(framedPath)).mode & 0o777).toBe(0o600);
        await writeFile(finalOutput, JSON.stringify({ type: 'result', result: {
          version: 1, status: 'completed', summary: 'ok', claims: [], artifacts: [], checks: [], limitations: [],
        } }) + '\n');
        return { launched: true, mode: 'degraded', child: closingChild(0) };
      });
      const tools = new Map<string, any>();
      try {
        await registerFn({ registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); } }, {
          projectRoot: root, allowDegraded: true, workerWorktreesRoot: work,
          loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }),
          now: () => new Date(f.now), gateInputs: { live: HEALTHY_GATE_LIVE }, scopedBreaker: throwingBreaker(),
        });
        const result = await tools.get('worker-invoke').handler({ operation: 'run', request_id: 'brief-json-preparation',
          role: 'coding', task: 'implementation', group: 'workers', brief: briefPath, workdir: work, final_output: finalOutput, transport: 'shell' });
        const body = JSON.parse(result.content[0].text);
        expect(body.status, JSON.stringify(body)).toBe('completed');
        expect(launch).toHaveBeenCalledOnce();
        expect(framed).toEqual({ message: 'private brief content', model_override: 'synthetic/a%b', cwd: work });
        expect(existsSync(framedPath)).toBe(false);
        return body;
      } finally { launch.mockRestore(); }
    }
    const baselineIsolation = await import('../../fixtures/ralph-recovery-baseline/worker-isolation.mjs');
    const baseline = await runOne(workerInvokeBaseline.registerWorkerInvokeToolset, baselineIsolation);
    const branch = await runOne(registerProductionToolset, workerIsolation);
    expect(branch.status).toBe(baseline.status);
    expect(branch.termination).toBe(baseline.termination);
  }, 20000);

  it('scenario: literal per-CLI switch off (clis.codex.enabled: false) collapses to the same prefix-level resolver refusal on both sides', async () => {
    async function runOne(registerFn: any) {
      const root = await tempRoot();
      const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
      const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'hello');
      const finalOutput = path.join(work, 'final.json');
      const f = buildFixture(root, 'shell');
      f.snapshot.config.parallelism!.clis = { codex: { enabled: false, adapter: 'providers:codex', accountScope: 'fixture-account', quotaScope: 'fixture-quota' } };
      const registry = createInvocationRegistry({ maxActive: 4 });
      const tools = new Map<string, any>();
      await registerFn({ registerTool(name: string, cfg: any, handler: any) { tools.set(name, { config: cfg, handler }); } }, {
        projectRoot: root, registry, allowDegraded: true, workerWorktreesRoot: work,
        loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }),
        now: () => new Date(f.now), gateInputs: { live: HEALTHY_GATE_LIVE }, scopedBreaker: throwingBreaker(),
      });
      const handler = tools.get('worker-invoke').handler;
      const result = await handler({ operation: 'run', request_id: `equiv-percli-${Math.random()}`, role: 'coding', task: 'implementation', group: 'workers',
        brief: briefPath, workdir: work, final_output: finalOutput, transport: 'shell' });
      return { body: JSON.parse(result.content[0].text), registry };
    }
    const baseline = await runOne(workerInvokeBaseline.registerWorkerInvokeToolset);
    const branch = await runOne(registerProductionToolset);
    expect(baseline.body.status, JSON.stringify(baseline.body)).toBe('blocked');
    expect(branch.body.status).toBe(baseline.body.status);
    expect(branch.body.termination).toBe(baseline.body.termination);
    expect(branch.registry.canStart()).toBe(baseline.registry.canStart());
  }, 20000);

  // -------------------------------------------------------------------------
  // The `global-off` (`parallelism.worker_dispatch: false`) degenerate case
  // -- parallel to the per-CLI one above, and excluded from the per-scenario
  // loop for the same reason (see that loop's own `GATINGS` comment): the
  // models RESOLVER treats this flag as "disabled" too, so EVERY scenario's
  // doubles would go uncalled and this collapses to the same prefix-level
  // "blocked at the resolver" outcome regardless of which scenario it is
  // wired up for.
  // -------------------------------------------------------------------------
  it('scenario: literal global switch off (parallelism.worker_dispatch: false) ALSO collapses to the same prefix-level resolver refusal on both sides', async () => {
    async function runOne(registerFn: any) {
      const root = await tempRoot();
      const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
      const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'hello');
      const finalOutput = path.join(work, 'final.json');
      const f = buildFixture(root, 'shell');
      f.snapshot.config.parallelism!.worker_dispatch = false;
      const registry = createInvocationRegistry({ maxActive: 4 });
      const tools = new Map<string, any>();
      await registerFn({ registerTool(name: string, cfg: any, handler: any) { tools.set(name, { config: cfg, handler }); } }, {
        projectRoot: root, registry, allowDegraded: true, workerWorktreesRoot: work,
        loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }),
        now: () => new Date(f.now), gateInputs: { live: HEALTHY_GATE_LIVE }, scopedBreaker: throwingBreaker(),
      });
      const handler = tools.get('worker-invoke').handler;
      const result = await handler({ operation: 'run', request_id: `equiv-globaloff-${Math.random()}`, role: 'coding', task: 'implementation', group: 'workers',
        brief: briefPath, workdir: work, final_output: finalOutput, transport: 'shell' });
      return { body: JSON.parse(result.content[0].text), registry };
    }
    const baseline = await runOne(workerInvokeBaseline.registerWorkerInvokeToolset);
    const branch = await runOne(registerProductionToolset);
    expect(baseline.body.status, JSON.stringify(baseline.body)).toBe('blocked');
    expect(branch.body.status).toBe(baseline.body.status);
    expect(branch.body.termination).toBe(baseline.body.termination);
    expect(branch.registry.canStart()).toBe(baseline.registry.canStart());
  }, 20000);

  // -------------------------------------------------------------------------
  // Oversized whitespace -- needs the REAL `ChildProcessTransport` (never an
  // injected `callMcpWorker` double, which would bypass it entirely), so it
  // runs through a real spawned stdio worker on both sides, using the
  // frozen fixture's own dependencies -- never current-branch session-
  // launcher/worker-isolation helpers pointed at by the baseline fixture's
  // own `loadRalphExternal` (that call resolves to the UNCHANGED
  // `lib/worker-isolation.mjs` `checkWorkerDispatch`/`launchIsolatedWorker`
  // exports on both sides; #2915 never modified those two functions).
  // -------------------------------------------------------------------------
  it('scenario: oversized whitespace is refused identically on both sides when recovery is disabled', async () => {
    async function runOne(registerFn: any) {
      const root = await tempRoot();
      const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
      const briefPath = path.join(root, 'brief.md');
      const finalOutput = path.join(work, 'final.json');
      const f = buildFixture(root, 'mcp');
      registerWorkerRecoveryCapabilities(f.drivers.codex, { canVerifyAttempt: false });
      f.drivers.codex.mcpRegistry = { get: async () => ({ name: 'fixture-server', type: 'stdio' as const, command: process.execPath,
        args: [path.resolve('test/fixtures/ralph-recovery-baseline/oversized-whitespace-worker.mjs')] }) };
      await buildStructuredBrief(f, { role: 'coding', task: 'implementation', group: 'workers',
        brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp' });
      const registry = createInvocationRegistry({ maxActive: 4 });
      const tools = new Map<string, any>();
      await registerFn({ registerTool(name: string, cfg: any, handler: any) { tools.set(name, { config: cfg, handler }); } }, {
        projectRoot: root, registry, allowDegraded: true, workerWorktreesRoot: work,
        loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }),
        now: () => new Date(f.now), gateInputs: { live: HEALTHY_GATE_LIVE }, scopedBreaker: throwingBreaker(),
      });
      const handler = tools.get('worker-invoke').handler;
      const result = await handler({ operation: 'run', request_id: `equiv-oversized-${Math.random()}`, role: 'coding', task: 'implementation', group: 'workers',
        brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp' });
      return { body: JSON.parse(result.content[0].text), registry };
    }
    const baseline = await runOne(workerInvokeBaseline.registerWorkerInvokeToolset);
    const branch = await runOne(registerProductionToolset);
    expect(['failed', 'uncertain'], JSON.stringify(baseline.body)).toContain(baseline.body.status);
    expect(branch.body.status, JSON.stringify(branch.body)).toBe(baseline.body.status);
    expect(branch.body.termination).toBe(baseline.body.termination);
    expect(branch.body.diagnostics.join(' ')).toContain('OG_WORKER_MCP_FRAME_TOO_LARGE');
    expect(baseline.body.diagnostics.join(' ')).toContain('OG_WORKER_MCP_FRAME_TOO_LARGE');
  }, 20000);

  // -------------------------------------------------------------------------
  // Queue contention with two requests -- `withServerQueue`'s bounded
  // per-serverRef serialization (#2892 D2) lives INSIDE `defaultCallMcpWorker*`,
  // invisible to an injected `callMcpWorker` double, so this also needs the
  // REAL launch pipeline (two real spawned workers against the SAME
  // registered serverRef, `sessionIsolation: 'serialized'`), mirroring the
  // existing "two tasks on the SAME registered serialized server both
  // complete independently" test (#2892 D2/D3) exactly, on both sides.
  // -------------------------------------------------------------------------
  it('scenario: queue contention with two requests against the same serialized serverRef -- both complete independently, with no crossover, on both sides', async () => {
    async function runOne(registerFn: any) {
      const root = await tempRoot();
      const workA = path.join(root, 'work-a'); await mkdir(workA, { recursive: true });
      const workB = path.join(root, 'work-b'); await mkdir(workB, { recursive: true });
      const briefA = path.join(root, 'brief-a.md');
      const briefB = path.join(root, 'brief-b.md');
      const recordPath = path.join(root, 'record.jsonl');
      const configPath = path.join(root, 'fixture-config.json');
      await writeFile(configPath, JSON.stringify({ recordPath, scenario: 'success' }));
      const f = buildFixture(root, 'mcp');
      registerWorkerRecoveryCapabilities(f.drivers.codex, { canVerifyAttempt: false });
      f.profile.mcp.serverRef = 'fixture-server-equiv-queue';
      f.profile.mcp.sessionIsolation = 'serialized';
      f.drivers.codex.mcpProfile = { servers: ['fixture-server-equiv-queue'] };
      f.drivers.codex.mcpRegistry = {
        get: async () => ({ name: 'fixture-server-equiv-queue', type: 'stdio' as const, command: process.execPath,
          args: [path.resolve('test/fixtures/ralph-worker-mcp.mjs')], env: { AIWG_FAKE_WORKER_CONFIG: configPath } }),
      };
      await buildStructuredBrief(f, { role: 'coding', task: 'implementation', group: 'workers',
        brief: briefA, workdir: workA, final_output: path.join(workA, 'final.json'), transport: 'mcp' });
      await buildStructuredBrief(f, { role: 'coding', task: 'implementation', group: 'workers',
        brief: briefB, workdir: workB, final_output: path.join(workB, 'final.json'), transport: 'mcp' });
      const registry = createInvocationRegistry({ maxActive: 4 });
      const tools = new Map<string, any>();
      await registerFn({ registerTool(name: string, cfg: any, handler: any) { tools.set(name, { config: cfg, handler }); } }, {
        projectRoot: root, registry, allowDegraded: true, workerWorktreesRoot: root,
        loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }),
        now: () => new Date(f.now), gateInputs: { live: HEALTHY_GATE_LIVE },
      });
      const handler = tools.get('worker-invoke').handler;
      const buildInput = (brief: string, work: string, requestId: string) => ({
        operation: 'run', request_id: requestId, role: 'coding', task: 'implementation', group: 'workers',
        brief, workdir: work, final_output: path.join(work, 'final.json'), transport: 'mcp',
      });
      const [a, b] = await Promise.all([
        handler(buildInput(briefA, workA, `equiv-queue-a-${Math.random()}`)),
        handler(buildInput(briefB, workB, `equiv-queue-b-${Math.random()}`)),
      ]);
      const bodyA = JSON.parse(a.content[0].text);
      const bodyB = JSON.parse(b.content[0].text);
      const lines = (await readFile(recordPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const calls = lines.filter((l: any) => l.event === 'call');
      return { bodyA, bodyB, registry, callCount: calls.length, workspaceCount: new Set(calls.map((c: any) => c.worker.workspace)).size };
    }
    const baseline = await runOne(workerInvokeBaseline.registerWorkerInvokeToolset);
    const branch = await runOne(registerProductionToolset);
    expect(baseline.bodyA.status, JSON.stringify(baseline.bodyA)).toBe('completed');
    expect(baseline.bodyB.status, JSON.stringify(baseline.bodyB)).toBe('completed');
    expect(branch.bodyA.status, JSON.stringify(branch.bodyA)).toBe(baseline.bodyA.status);
    expect(branch.bodyB.status, JSON.stringify(branch.bodyB)).toBe(baseline.bodyB.status);
    // Both tasks actually ran (serialized, not dropped), and never shared a
    // workspace -- no crossover -- on EITHER side.
    expect(branch.callCount).toBe(2);
    expect(baseline.callCount).toBe(2);
    expect(branch.workspaceCount).toBe(2);
    expect(baseline.workspaceCount).toBe(2);
  }, 30000);

  // -------------------------------------------------------------------------
  // Resolver error -- `resolveWorkerInvocation` itself throwing, as opposed
  // to the already-covered `loadWorkerInputs` throw. Both calls live inside
  // the exact same shared-PREFIX try block with the exact same catch (see
  // `runInner`'s own doc comment in worker-invoke.mjs), so this is provable
  // by construction without running anything -- this test exercises it
  // anyway, end-to-end, via `vi.doMock` + a scoped module-registry reset
  // (never a file-wide `vi.mock`, which would break every other test in
  // this file that depends on the REAL resolver). Placed LAST in this
  // file's test order and carefully unmocked/restored in `finally` to
  // bound the blast radius of resetting the module registry mid-suite.
  // -------------------------------------------------------------------------
  it('scenario: resolver error (resolveWorkerInvocation throws) -- byte-equivalent to baseline, same as a loadWorkerInputs throw by construction', async () => {
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    vi.doMock('../../../src/serve/worker-invocation.js', async (importOriginal) => {
      const mod = await importOriginal<any>();
      return { ...mod, resolveWorkerInvocation: async () => { throw new Error('synthetic: resolver exploded'); } };
    });
    vi.doMock('../../fixtures/ralph-recovery-baseline/src/serve/worker-invocation.ts', async (importOriginal) => {
      const mod = await importOriginal<any>();
      return { ...mod, resolveWorkerInvocation: async () => { throw new Error('synthetic: resolver exploded'); } };
    });
    vi.resetModules();
    try {
      const { workerInvoke: freshBranch } = await loadRecoveryModuleGraph();
      const freshBaseline = await import('../../fixtures/ralph-recovery-baseline/worker-invoke.mjs') as any;
      async function runOne(registerFn: any) {
        const root = await tempRoot();
        const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
        const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'hello');
        const finalOutput = path.join(work, 'final.json');
        const f = buildFixture(root, 'shell');
        const registry = freshBranch.createInvocationRegistry({ maxActive: 4 });
        const tools = new Map<string, any>();
        await registerFn({ registerTool(name: string, cfg: any, handler: any) { tools.set(name, { config: cfg, handler }); } }, {
          projectRoot: root, registry, allowDegraded: true, workerWorktreesRoot: work,
          loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }),
          now: () => new Date(f.now), gateInputs: { live: HEALTHY_GATE_LIVE },
        });
        const handler = tools.get('worker-invoke').handler;
        const result = await handler({ operation: 'run', request_id: `equiv-resolver-throw-${Math.random()}`, role: 'coding', task: 'implementation', group: 'workers',
          brief: briefPath, workdir: work, final_output: finalOutput, transport: 'shell' });
        return { body: JSON.parse(result.content[0].text), registry };
      }
      const baseline = await runOne(freshBaseline.registerWorkerInvokeToolset);
      const branch = await runOne(freshBranch.registerWorkerInvokeToolset);
      expect(baseline.body.status, JSON.stringify(baseline.body)).toBe('blocked');
      expect(baseline.body.termination).toBe('confirmed');
      expect(baseline.body.diagnostics).toEqual(['synthetic: resolver exploded']);
      expect(branch.body.status).toBe(baseline.body.status);
      expect(branch.body.termination).toBe(baseline.body.termination);
      expect(branch.registry.canStart()).toBe(baseline.registry.canStart());
    } finally {
      vi.doUnmock('../../../src/serve/worker-invocation.js');
      vi.doUnmock('../../fixtures/ralph-recovery-baseline/src/serve/worker-invocation.ts');
      vi.resetModules();
    }
  }, 20000);

  // -------------------------------------------------------------------------
  // gated<->not-gated interleaving on ONE server instance. Baseline has no
  // gating concept at all, so this is a branch-only test (there is nothing
  // for the frozen fixture to "interleave" against) -- it instead proves
  // the property the equivalence tests above cannot: that a REAL gated
  // admission/settlement on one request leaves NO observable trace that
  // changes a LATER not-gated request's outcome on the same registration,
  // including when the breaker is saturated with blocking markers.
  // -------------------------------------------------------------------------
  describe('gated<->not-gated interleavings on one server instance (branch-only; baseline has no gating concept to interleave against)', () => {
    const breakers: any[] = [];
    afterEach(() => { for (const breaker of breakers.splice(0)) breaker.destroy(); vi.restoreAllMocks(); });
    function statefulBreaker() {
      const breaker = new ScopedFailureBreaker({ nowMs: () => 0, jitterMs: () => 0,
        policy: { maxOutstandingReservations: 1 } });
      breakers.push(breaker);
      const admit = vi.spyOn(breaker, 'admit');
      const settle = vi.spyOn(breaker, 'settle');
      return { breaker, admit, settle };
    }

    async function registerInterleaved(options: Record<string, unknown>, registry: any, f: any, root: string, work: string, briefPath: string) {
      const tools = new Map<string, any>();
      await registerProductionToolset({ registerTool(name: string, cfg: any, handler: any) { tools.set(name, { config: cfg, handler }); } }, {
        projectRoot: root, registry, allowDegraded: true, workerWorktreesRoot: work,
        loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }),
        now: () => new Date(f.now), gateInputs: { live: HEALTHY_GATE_LIVE },
        ...options,
      });
      const handler = tools.get('worker-invoke').handler;
      return async () => {
        const result = await handler({ operation: 'run', request_id: `interleave-${Math.random()}`, role: 'coding', task: 'implementation', group: 'workers',
          brief: briefPath, workdir: work, final_output: path.join(work, `final-${Math.random()}.json`), transport: 'shell' });
        return JSON.parse(result.content[0].text);
      };
    }

    async function commitInterleaved(options: any) {
      if (!options.admission) {
        expect(options).not.toHaveProperty('dispatchGuard');
        return;
      }
      const a = options.admission;
      expect(a.breaker.beginDispatch(a.token, { invocationId: a.invocationId, selectionDigest: a.selectionDigest })).toEqual({ ok: true });
      await (await import('../../../tools/ralph-external/session-launcher.mjs')).debitDirectWorkerAllowance(a.ledger);
      expect(a.breaker.commitDispatch(a.token)).toEqual({ ok: true });
    }

    it('a gated run does not change what a FOLLOWING not-gated run does, including with the breaker saturated', async () => {
      const root = await tempRoot();
      const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
      const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'hello');
      const f = buildFixture(root, 'shell');
      const registry = createInvocationRegistry({ maxActive: 8 });
      const { breaker, admit, settle } = statefulBreaker();
      const claims = { version: 1, status: 'completed', summary: 'ok', claims: [], artifacts: [], checks: [], limitations: [] };
      const launchSuccess = async (invocation: any, options: any) => {
        await commitInterleaved(options);
        await writeFile(invocation.finalPath, `${JSON.stringify({ type: 'result', result: claims })}\n`);
        return { launched: true, mode: 'degraded', child: closingChild(0) };
      };

      const runOneRequest = await registerInterleaved({ scopedBreaker: breaker, launchShellWorker: launchSuccess }, registry, f, root, work, briefPath);
      // 1. A GATED run (canVerifyAttempt stays true; global switch stays
      // on): the breaker's `admit`/`settle` are genuinely consulted.
      const gatedBody = await runOneRequest();
      expect(gatedBody.status, JSON.stringify(gatedBody)).toBe('completed');
      expect(admit.mock.calls.length).toBeGreaterThan(0);
      expect(settle.mock.calls.length).toBeGreaterThan(0);

      // 2. The real breaker is saturated by the unresolved degraded run.
      expect(breaker.hasUnresolvedStop(gatedBody.invocationId)).toBe(true);
      expect(breaker.admit({ invocationId: 'capacity-probe', scopeKeys: [] }).ok).toBe(false);
      const saturatedAdmitCalls = admit.mock.calls.length;

      // 3. A NOT-GATED run on the SAME registration/registry/breaker.
      await registerRecoveryCapabilities(f.drivers.codex, { canVerifyAttempt: false });
      const notGatedBody = await runOneRequest();
      expect(notGatedBody.status, JSON.stringify(notGatedBody)).toBe('completed');
      // The saturated breaker was NEVER consulted by the not-gated run --
      // admit()/settle() call counts are unchanged since step 1.
      expect(admit.mock.calls.length).toBe(saturatedAdmitCalls);
    }, 20000);

    it('a not-gated run does not change what a FOLLOWING gated run does', async () => {
      const root = await tempRoot();
      const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
      const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'hello');
      const f = buildFixture(root, 'shell');
      await registerRecoveryCapabilities(f.drivers.codex, { canVerifyAttempt: false }); // not-gated FIRST
      const registry = createInvocationRegistry({ maxActive: 8 });
      const { breaker, admit, settle } = statefulBreaker();
      const claims = { version: 1, status: 'completed', summary: 'ok', claims: [], artifacts: [], checks: [], limitations: [] };
      const launchSuccess = async (invocation: any, options: any) => {
        await commitInterleaved(options);
        await writeFile(invocation.finalPath, `${JSON.stringify({ type: 'result', result: claims })}\n`);
        return { launched: true, mode: 'degraded', child: closingChild(0) };
      };

      const runOneRequest = await registerInterleaved({ scopedBreaker: breaker, launchShellWorker: launchSuccess }, registry, f, root, work, briefPath);
      // 1. A NOT-GATED run first -- the breaker must never be consulted.
      const notGatedBody = await runOneRequest();
      expect(notGatedBody.status, JSON.stringify(notGatedBody)).toBe('completed');
      expect(admit.mock.calls).toHaveLength(0);
      expect(settle.mock.calls).toHaveLength(0);

      // 2. Flip to gated and run again on the SAME registration/registry/
      // breaker -- it must admit/settle normally, exactly as if the prior
      // not-gated run had never happened.
      await registerRecoveryCapabilities(f.drivers.codex, { canVerifyAttempt: undefined });
      const gatedBody = await runOneRequest();
      expect(gatedBody.status, JSON.stringify(gatedBody)).toBe('completed');
      expect(admit.mock.calls.length).toBeGreaterThan(0);
      expect(settle.mock.calls.length).toBeGreaterThan(0);
    }, 20000);

    // #2915 round 8 review 8 (D3): a GATED run that times out (its own
    // deadline-stop escalation genuinely fires) must leave no dangling
    // timer or stop-control handle behind that a FOLLOWING not-gated run
    // on the SAME registration could observe or be slowed by, and the
    // registry's own capacity bookkeeping must reflect only genuinely
    // live work afterward.
    it('a gated timeout retains its stop control while a following disabled run completes independently', async () => {
      const root = await tempRoot();
      const work = path.join(root, 'work'); await mkdir(work, { recursive: true });
      const briefPath = path.join(root, 'brief.md'); await writeFile(briefPath, 'hello');
      const f = buildFixture(root, 'shell');
      const registry = createInvocationRegistry({ maxActive: 2 });
      const { breaker } = statefulBreaker();
      let monotonic = 0;
      breaker.nowMs = () => monotonic;
      // A child that never responds to any signal -- the deadline-stop
      // escalation (SIGTERM, then SIGKILL after its own bounded grace
      // window) never confirms it, so this settles genuinely `uncertain`
      // (never terminal; M2 keeps an unconfirmed-termination run LIVE).
      const neverRespondingChild = () => { const c: any = new EventEmitter(); c.exitCode = null; c.signalCode = null; c.kill = () => {}; return c; };
      let launch: any = async (_invocation: any, options: any) => {
        await commitInterleaved(options);
        monotonic = options.dispatchGuard.deadlineAtMs - 1;
        return { launched: true, mode: 'degraded', child: neverRespondingChild() };
      };
      const runOneRequest = await registerInterleaved({ scopedBreaker: breaker,
        launchShellWorker: (...args: any[]) => launch(...args), terminateChildWithGrace: async () => ({ terminated: false }),
      }, registry, f, root, work, briefPath);

      const timedOutBody = await runOneRequest();
      expect(timedOutBody.status, JSON.stringify(timedOutBody)).toBe('uncertain');
      const gatedEntry = registry.get(timedOutBody.invocationId);
      expect(gatedEntry, 'the timed-out run stays LIVE (M2); never silently dropped from the registry').toBeDefined();
      // Keep explicit stop authority while this worker still occupies capacity.
      expect(gatedEntry?.control.stop).toBeTypeOf('function');
      expect(gatedEntry?.control.pollingStopped).toBe(false);
      // Capacity reflects exactly one genuinely live run.
      expect(registry.liveCount()).toBe(1);
      expect(registry.canStart()).toBe(true); // maxActive: 2, one slot still free

      // A FOLLOWING not-gated run on the SAME registration/registry must
      // complete normally, unaffected by the first run's own leftover
      // timeout machinery (no crossed timers, no stolen control handle).
      await registerRecoveryCapabilities(f.drivers.codex, { canVerifyAttempt: false });
      const claims = { version: 1, status: 'completed', summary: 'ok', claims: [], artifacts: [], checks: [], limitations: [] };
      const launchSuccess = async (invocation: any, options: any) => {
        await commitInterleaved(options);
        await writeFile(invocation.finalPath, `${JSON.stringify({ type: 'result', result: claims })}\n`);
        return { launched: true, mode: 'degraded', child: closingChild(0) };
      };
      launch = launchSuccess;
      const notGatedBody = await runOneRequest();
      expect(notGatedBody.status, JSON.stringify(notGatedBody)).toBe('completed');
      // Capacity now reflects the first (still-live/uncertain) run plus the
      // second, now-terminal one -- exactly as if these two runs had never
      // interleaved with each other's gating state at all.
      expect(registry.liveCount()).toBe(1);
      expect(registry.get(notGatedBody.invocationId)?.terminalAt).not.toBeNull();
    }, 20000);
  });
});

describe('review 10 frozen fixture ownership', () => {
  it('C1: importing the frozen adapter and running its default input loader never loads the current installation owner', async () => {
    // The unchanged authorization helper imports current config in source mode.
    // Supply the real helper separately to isolate the frozen loader graph.
    const repoAccess = await import('../../../src/policy/repo-access.js');
    vi.resetModules();
    const currentOwnerLoaded = vi.fn(() => { throw new Error('current installation owner entered the frozen graph'); });
    vi.doMock('../../../src/models/worker-installation.mjs', currentOwnerLoaded);
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work);
    const brief = path.join(root, 'brief.md'); await writeFile(brief, 'frozen default-loading probe');
    const f = buildFixture(root, 'shell');
    const spies: any[] = [];
    try {
      const adapter = await import('../../fixtures/ralph-recovery-baseline/provider-adapter.mjs');
      const owner = await import('../../fixtures/ralph-recovery-baseline/worker-installation.mjs');
      expect(adapter.createProvider).toBe(owner.createProvider);
      await adapter.ensureProvidersRegistered();
      expect(owner.hasProvider('codex')).toBe(true);
      expect(owner.createProvider('codex')).not.toHaveProperty('parseWorkerAttemptFinal');
      expect(await adapter.workerNegativeFixtureDigest()).toMatch(/^sha256:[a-f0-9]{64}$/);
      const config = await import('../../fixtures/ralph-recovery-baseline/src/config/aiwg-config.js');
      const { ConfigLoader } = await import('../../fixtures/ralph-recovery-baseline/src/models/config-loader.js');
      const inventory = await import('../../fixtures/ralph-recovery-baseline/src/providers/provider-inventory.js');
      const discovery = await import('../../fixtures/ralph-recovery-baseline/src/models/model-discovery.js');
      // Substitute filesystem-derived inputs only. The frozen default loader,
      // resolver, adapter parser, and registered run() all execute normally.
      spies.push(vi.spyOn(config, 'readAiwgConfig').mockResolvedValue(f.snapshot.config));
      spies.push(vi.spyOn(ConfigLoader.prototype, 'load').mockResolvedValue(f.snapshot.models));
      spies.push(vi.spyOn(ConfigLoader.prototype, 'getInputDigests').mockReturnValue(f.snapshot.modelDigests));
      spies.push(vi.spyOn(inventory, 'collectProviderInventory').mockResolvedValue({} as any));
      spies.push(vi.spyOn(discovery, 'resolveDynamicModelCatalog').mockResolvedValue(f.snapshot.catalog));
      const installed = vi.spyOn(owner, 'loadRecordedWorkerInstallations').mockResolvedValue({
        registry: f.snapshot.registry, installations: f.snapshot.installations, drivers: f.drivers,
      });
      spies.push(installed);
      const baseline = await import('../../fixtures/ralph-recovery-baseline/worker-invoke.mjs');
      const tools = new Map<string, any>();
      await baseline.registerWorkerInvokeToolset({ registerTool(name: string, _config: any, handler: any) { tools.set(name, handler); } }, {
        projectRoot: root, workerWorktreesRoot: work, now: () => new Date(f.now), repoAccess,
        launchShellWorker: async (inv: any) => {
          await writeFile(inv.finalPath, `${JSON.stringify({ type: 'result', result: { version: 1, status: 'completed', summary: 'ok',
            claims: [], artifacts: [], checks: [], limitations: [] } })}\n`);
          return { launched: true, mode: 'degraded', child: closingChild(0) };
        },
      });
      const body = JSON.parse((await tools.get('worker-invoke')({ operation: 'run', request_id: 'frozen-default', role: 'coding', task: 'implementation', group: 'workers',
        brief, workdir: work, final_output: path.join(work, 'final.json'), transport: 'shell' })).content[0].text);
      expect(body.status, JSON.stringify(body)).toBe('completed');
      expect(installed).toHaveBeenCalledOnce();
      expect(currentOwnerLoaded).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
      vi.doUnmock('../../../src/models/worker-installation.mjs');
      vi.resetModules();
    }
  });
});

describe('review 11 populated default driver equivalence', () => {
  it.each(['src', 'dist'])('P2 (%s): real Codex default-loaded drivers have exactly the frozen Reflect.ownKeys and retain gated capabilities', async (side) => {
    vi.resetModules();
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', side);
    const root = await tempRoot();
    const cwd = path.join(root, 'project');
    await mkdir(cwd);
    const loaded: any[] = [];
    const disabled: any[] = [];
    const owners: any[] = [];
    try {
      const current = await loadRecoveryModuleGraph();
      for (const baseline of [true, false]) {
        const owner = baseline
          ? await import('../../fixtures/ralph-recovery-baseline/worker-installation.mjs')
          : current.installation;
        owners.push(owner);
        const f = workerResolutionFixture();
        f.snapshot.config.parallelism!.worker_dispatch = true;
        const adapter = f.snapshot.registry.providers.codex.workerAdapter!;
        adapter.id = 'codex';
        const binding = f.snapshot.installations.codex;
        // The installed executable is Node; give its fake CLI an exact version
        // response so the current loader can recheck the recorded approval.
        adapter.invocation.versionArgv = ['-e', `console.log(${JSON.stringify(binding.cliVersion)})`];
        const profile = adapter.invocationProfiles![binding.profile];
        const policy = f.snapshot.models.defaults.workerSelection;
        const { qualificationDigest } = await import('../../../src/models/qualification-digest.mjs');
        const { requiredWorkerControls } = await import('../../../src/models/provider-policy.js');
        const controls = requiredWorkerControls({ policy });
        // Synthetic host evidence and module binding only. The installed factory
        // constructs the actual current/frozen Codex adapter, with no driver stub.
        for (const control of Object.values(profile.controls)) Object.assign(control, { support: 'external', mapping: 'synthetic host boundary' });
        binding.boundary = { kind: 'os', identity: 'fixture:host', digest: qualificationDigest('fixture:host'), controls };
        const configDir = path.join(root, baseline ? 'baseline' : 'current');
        await mkdir(configDir, { mode: 0o700 });
        vi.stubEnv('AIWG_CONFIG', configDir);
        const adapterPath = path.resolve(baseline ? 'test/fixtures/ralph-recovery-baseline/codex-adapter.mjs' : 'tools/ralph-external/lib/codex-adapter.mjs');
        // Preserve the adapter body; only route its relative imports from the
        // private installed copy back to the current/frozen dependency graph.
        const source = (await readFile(adapterPath, 'utf8')).replace(
          /from '(\.[^']+)'/g, (_match, relative) => `from '${pathToFileURL(path.resolve(path.dirname(adapterPath), relative)).href}'`);
        await writeFile(path.join(configDir, 'driver.mjs'), source, { mode: 0o600 });
        await writeFile(path.join(configDir, 'package.json'), JSON.stringify({ name: 'fixture-codex', version: adapter.adapterVersion, type: 'module' }), { mode: 0o600 });
        const installation: any = {
          adapter, profile: binding.profile, cliVersion: binding.cliVersion, policy,
          cwd, workerWritableRoots: [cwd], boundary: binding.boundary,
          effectiveConfigDigest: qualificationDigest(policy), accountScope: binding.accountScope,
          executable: process.execPath, runtimeFiles: [path.join(configDir, 'driver.mjs')], environment: {},
          modules: [{ reference: adapter.runtimeDriver, packageRoot: configDir, packageName: 'fixture-codex',
            packageVersion: adapter.adapterVersion, modulePath: 'driver.mjs', interfaceVersion: 1,
            sha256: `sha256:${createHash('sha256').update(source).digest('hex')}`, adapterIds: ['codex'], platforms: ['linux'] }],
        };
        // Inspection needs only the identity for this external-control fixture;
        // defer importing the real adapter until the installation loader does so.
        const scope = await owner.inspectWorkerInstallation({ getName: () => 'codex' }, installation);
        profile.installationQualification = { scopeDigest: scope.scopeDigest, fixtureDigest: await owner.workerNegativeFixtureDigest(),
          verifiedAt: new Date().toISOString(), evidenceRef: 'fixture:synthetic-host-only' };
        installation.evidence = { ...profile.installationQualification,
          cases: Object.fromEntries(Object.keys(owner.workerNegativeFixtureSuite.cases).map(name => [name, 'passed'])) };
        await writeFile(path.join(configDir, 'worker-installations.json'), JSON.stringify({ version: 1,
          registrations: [{ cli: 'codex', binding, adapter, installation }] }), { mode: 0o600 });
        const config = baseline ? await import('../../fixtures/ralph-recovery-baseline/src/config/aiwg-config.js') : current.config;
        const { ConfigLoader } = baseline ? await import('../../fixtures/ralph-recovery-baseline/src/models/config-loader.js') : current.configLoader;
        const inventory = baseline ? await import('../../fixtures/ralph-recovery-baseline/src/providers/provider-inventory.js') : current.inventory;
        const discovery = baseline ? await import('../../fixtures/ralph-recovery-baseline/src/models/model-discovery.js') : current.discovery;
        const spies = [
          vi.spyOn(config, 'readAiwgConfig').mockResolvedValue(f.snapshot.config),
          vi.spyOn(ConfigLoader.prototype, 'load').mockResolvedValue(f.snapshot.models),
          vi.spyOn(ConfigLoader.prototype, 'getInputDigests').mockReturnValue(f.snapshot.modelDigests),
          vi.spyOn(inventory, 'collectProviderInventory').mockResolvedValue({} as any),
          vi.spyOn(discovery, 'resolveDynamicModelCatalog').mockResolvedValue(f.snapshot.catalog),
        ];
        try {
          const { loadWorkerInputs } = baseline ? await import('../../fixtures/ralph-recovery-baseline/src/cli/handlers/models.js') : current.models;
          loaded.push(await loadWorkerInputs({ cwd, frameworkRoot: process.cwd(), args: [], rawArgs: [] } as any));
          f.snapshot.config.parallelism!.worker_dispatch = false;
          disabled.push(await loadWorkerInputs({ cwd, frameworkRoot: process.cwd(), args: [], rawArgs: [] } as any));
          f.snapshot.config.parallelism!.worker_dispatch = true;
        } finally { for (const spy of spies) spy.mockRestore(); }
      }
      expect(Object.keys(loaded[0].drivers)).toEqual(['codex']);
      expect(Object.keys(loaded[1].drivers)).toEqual(['codex']);
      const driver = loaded[1].drivers.codex;
      expect(Reflect.ownKeys(driver)).toEqual(Reflect.ownKeys(loaded[0].drivers.codex));
      expect(Reflect.ownKeys(driver)).not.toContain('parseWorkerAttemptFinal');
      expect(Reflect.ownKeys(driver)).not.toContain('canVerifyAttempt');
      const capabilities = owners[1].getWorkerRecoveryCapabilities(driver);
      expect(capabilities.canVerifyAttempt).toBe(true);
      expect(owners[1].getWorkerRecoveryCapabilities({ ...driver })).toBeNull();
      const launcher = current.launcher;
      const eligibility = { invocation: { selected: { cli: 'codex' } }, drivers: loaded[1].drivers, config: loaded[1].snapshot.config };
      expect(launcher.directRecoveryEligibility({ ...eligibility, gateEnabled: false }).gated).toBe(false);
      expect(launcher.directRecoveryEligibility({ ...eligibility, gateEnabled: true }).gated).toBe(true);
      const claims = { version: 1, status: 'completed', summary: 'ok', claims: [], artifacts: [], checks: [], limitations: [] };
      await expect(capabilities.parseWorkerAttemptFinal(JSON.stringify(claims), { format: 'json',
        observation: { transport: 'shell', status: 'completed', attemptOutcome: 'succeeded', exitCode: 0 } })).resolves.toEqual(claims);
      // Disabled loading has its own equivalence assertion. Populated-driver
      // coverage above does not depend on disabled loading returning drivers.
      expect(Reflect.ownKeys(disabled[1].drivers)).toEqual(Reflect.ownKeys(disabled[0].drivers));
      for (const cli of Reflect.ownKeys(disabled[0].drivers)) {
        expect(Reflect.ownKeys(disabled[1].drivers[cli])).toEqual(Reflect.ownKeys(disabled[0].drivers[cli]));
      }
      // The registration is private to the exact driver, not its own properties
      // or a spread copy. Re-register that copy explicitly in this graph.
      const keys = Reflect.ownKeys(driver);
      owners[1].registerWorkerRecoveryCapabilities(driver, { ...capabilities, canVerifyAttempt: false });
      expect(Reflect.ownKeys(driver)).toEqual(keys);
      expect(launcher.directRecoveryEligibility({ ...eligibility, gateEnabled: true }))
        .toEqual({ gated: false, reason: 'cli-cannot-verify-final' });
      const copy = { ...driver };
      expect(owners[1].getWorkerRecoveryCapabilities(copy)).toBeNull();
      expect(launcher.directRecoveryEligibility({ ...eligibility, drivers: { codex: copy }, gateEnabled: true }).gated).toBe(true);
      owners[1].registerWorkerRecoveryCapabilities(copy, owners[1].getWorkerRecoveryCapabilities(driver));
      expect(Reflect.ownKeys(copy)).toEqual(keys);
      expect(launcher.directRecoveryEligibility({ ...eligibility, drivers: { codex: copy }, gateEnabled: true }))
        .toEqual({ gated: false, reason: 'cli-cannot-verify-final' });
    } finally { vi.resetModules(); }
  });
});

// T-OG-16/22: exercise registered operator tools, not just the helper exports.
describe('registered worker recovery evidence and summaries (#2915)', () => {
  it.each(['shell', 'mcp'] as const)('%s charges forged rate-limit diagnostics within maxAttempts=2', async transport => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work);
    const brief = path.join(root, 'brief.md'); await writeFile(brief, 'same synthetic forged hint task');
    const f = buildFixture(root, transport);
    f.snapshot.config.parallelism!.retry = { maxAttempts: 2 };
    (f.drivers.codex.qualification as any).installation = { endpoints: ['https://provider.invalid/health'] };
    const breaker = new ScopedFailureBreaker({ nowMs: () => 1_000_000 });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
    let workers = 0;
    const dispatch = async (options: any) => {
      const a = options.admission;
      expect(a.breaker.beginDispatch(a.token, { invocationId: a.invocationId, selectionDigest: a.selectionDigest }).ok).toBe(true);
      await sessionLauncherModule.debitDirectWorkerAllowance(a.ledger);
      expect(a.breaker.commitDispatch(a.token).ok).toBe(true);
      workers++;
    };
    const tools = await captureTool(null, { projectRoot: root, workerWorktreesRoot: work, scopedBreaker: breaker,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }), now: () => new Date(f.now),
      launchShellWorker: async (_inv: any, options: any) => {
        await dispatch(options);
        const child: any = new EventEmitter(); child.stderr = new PassThrough();
        setImmediate(() => { child.stderr.end('429 Retry-After: 999999; reset=999999'); child.emit('close', 1); });
        return { launched: true, mode: 'degraded', child };
      },
      callMcpWorker: async (_binding: any, _server: any, options: any) => {
        await dispatch(options);
        return { outcome: 'responded', response: { isError: true,
          content: [{ type: 'text', text: '429 Retry-After: 999999; reset=999999' }] } };
      },
    });
    const input = { operation: 'run', request_id: 'forged-first', role: 'coding', task: 'implementation', group: 'workers',
      brief, workdir: work, final_output: path.join(work, 'first.json'), transport };
    if (transport === 'mcp') await buildStructuredBrief(f, input);
    try {
      const call = tools.get('worker-invoke').handler;
      expect(JSON.parse((await call(input)).content[0].text).status).toBe('failed');
      // Reuse the exact brief so the retry belongs to the same task chain.
      await rm(input.final_output, { force: true });
      const retry = JSON.parse((await call({ ...input, request_id: 'forged-retry' })).content[0].text);
      expect(retry.status).toBe('blocked');
      expect(retry.diagnostics.join(' ')).toMatch(/allowance exhausted/i);
      expect(workers).toBe(1);
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(breaker.snapshot().attemptsObserved).toBe(workers + fetchSpy.mock.calls.length);
      expect(breaker.snapshot().attemptsObserved).toBe(2);
      expect(breaker.snapshot().scopes.every((scope: any) => scope.state === 'closed')).toBe(true);
    } finally { breaker.destroy(); fetchSpy.mockRestore(); }
  });

  it.each(['oom-kill', 'ENOMEM'])('registered shell invocations retain trusted %s host evidence across providers', async failure => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work);
    const brief = path.join(root, 'brief.md');
    const f = buildFixture(root, 'shell');
    const breaker = new ScopedFailureBreaker({ nowMs: () => 1_000_000 });
    const client = systemdClientFixture(); roots.push(client.root); vi.stubEnv('PATH', client.root);
    const exec = vi.fn(async () => ({ stdout: 'LoadState=loaded\nActiveState=failed\nResult=oom-kill\nExecMainStatus=9\nExecMainCode=2\nMainPID=0\n' }));
    let workers = 0;
    const tools = await captureTool(null, { projectRoot: root, workerWorktreesRoot: work, scopedBreaker: breaker,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }), now: () => new Date(f.now),
      isolationStatus: () => ({ active: false, execMainCode: 2, execMainStatus: 9, result: 'oom-kill' }),
      waitForUnitTermination: (unit: string, duration: number, options: any) => waitForUnitTermination(unit, duration, { ...options, exec }),
      launchShellWorker: async (_inv: any, options: any) => {
        const a = options.admission;
        expect(a.breaker.beginDispatch(a.token, { invocationId: a.invocationId, selectionDigest: a.selectionDigest }).ok).toBe(true);
        await sessionLauncherModule.debitDirectWorkerAllowance(a.ledger);
        expect(a.breaker.commitDispatch(a.token).ok).toBe(true);
        workers++;
        if (failure === 'oom-kill') return { launched: true, mode: 'systemd-unit', unit: `oom-${workers}` };
        const child = new EventEmitter();
        setImmediate(() => child.emit('error', Object.assign(new Error('synthetic spawn failure'), { code: 'ENOMEM' })));
        return { launched: true, mode: 'degraded', child };
      },
    });
    const call = tools.get('worker-invoke').handler;
    try {
      for (const [n, provider] of ['one', 'two', 'three'].entries()) {
        for (const model of f.snapshot.catalog.discovery!.instances!.codex.models) model.llmProvider = provider;
        await writeFile(brief, `independent synthetic host failure ${n}`);
        const result = JSON.parse((await call({ operation: 'run', request_id: `host-${n}`, role: 'coding', task: 'implementation',
          group: 'workers', brief, workdir: work, final_output: path.join(work, `host-${n}.json`), transport: 'shell' })).content[0].text);
        expect(result.status, JSON.stringify(result)).toBe('failed');
        expect(breaker.getState('host:local').state).toBe(n === 2 ? 'open' : 'closed');
      }
      expect(workers).toBe(3);
      if (failure === 'oom-kill') expect(exec).toHaveBeenCalledTimes(3);
    } finally { breaker.destroy(); }
  });

  it.each(['shell', 'mcp'] as const)('%s failures confirm quota evidence and report transitions once', async transport => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work);
    const brief = path.join(root, 'brief.md'); await writeFile(brief, 'synthetic upstream failure');
    const f = buildFixture(root, transport);
    f.snapshot.config.parallelism!.retry = { maxAttempts: 2 };
    const installation = { accountScope: 'shared-quota', endpoints: ['https://provider.invalid/health'] };
    (f.drivers.codex.qualification as any).installation = installation;
    let time = 1_000_000;
    let recovering = false;
    const claims = { version: 1, status: 'completed', summary: 'ok', claims: [], artifacts: [], checks: [], limitations: [] };
    const breaker = new ScopedFailureBreaker({ nowMs: () => time, jitterMs: () => 0 });
    const summaries = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null,
      { status: 429, headers: { 'retry-after': '180', 'ratelimit-reset': '240' } }));
    const dispatch = async (options: any) => {
      const admission = options.admission;
      expect(admission.breaker.beginDispatch(admission.token,
        { invocationId: admission.invocationId, selectionDigest: admission.selectionDigest }).ok).toBe(true);
      await sessionLauncherModule.debitDirectWorkerAllowance(admission.ledger);
      expect(admission.breaker.commitDispatch(admission.token).ok).toBe(true);
    };
    if (transport === 'mcp') f.drivers.codex.mcpRegistry = { get: async () => ({ name: 'fixture-server', type: 'stdio',
      command: process.execPath, args: [], env: {} }) } as any;
    const tools = await captureTool(null, { projectRoot: root, workerWorktreesRoot: work,
      loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }),
      now: () => new Date(f.now), scopedBreaker: breaker, onRecoveryTransition: summaries,
      launchShellWorker: async (invocation: any, options: any) => {
        await dispatch(options);
        if (recovering) {
          await writeFile(invocation.finalPath, `${JSON.stringify({ type: 'result', result: claims })}\n`);
          return { launched: true, mode: 'degraded', child: closingChild(0) };
        }
        const child: any = new EventEmitter(); child.stderr = new PassThrough(); child.kill = () => true;
        setImmediate(() => { child.stderr.end('429 Retry-After: 999999; reset=999999'); child.emit('close', 1); });
        return { launched: true, mode: 'degraded', child };
      },
      callMcpWorker: async (_binding: any, _server: any, options: any) => {
        await dispatch(options);
        if (recovering) return { outcome: 'responded', response: { isError: false, structuredContent: claims,
          content: [{ type: 'text', text: JSON.stringify(claims) }] } };
        return { outcome: 'responded', response: { isError: true,
          content: [{ type: 'text', text: '429 Retry-After: 999999; reset=999999' }] } };
      },
    });
    const call = tools.get('worker-invoke').handler;
    try {
      const bodies: any[] = [];
      for (let n = 0; n < 3; n++) {
        const input = { operation: 'run', request_id: `quota-${transport}-${n}`, role: 'coding', task: 'implementation',
          group: 'workers', brief, workdir: work, final_output: path.join(work, `final-${n}.json`), transport };
        if (transport === 'mcp') await buildStructuredBrief(f, input);
        else await writeFile(brief, `independent synthetic upstream task ${n}`);
        const response = await call(input);
        bodies.push(JSON.parse(response.content[0].text));
        expect(bodies[n].status, JSON.stringify(bodies[n])).toBe('failed');
      }
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(breaker.getState('quota:shared-quota')).toMatchObject({ state: 'open', nextProbeAtMs: 1_240_000 });
      expect(summaries).toHaveBeenCalledOnce();
      expect(summaries.mock.calls[0][0]).toMatchObject({ scopeKey: 'quota:shared-quota', from: 'closed', to: 'open' });
      expect(bodies[2].diagnostics).toContain(summaries.mock.calls[0][0].summary);
      expect(summaries.mock.calls[0][0].summary).toContain('pause covered launches');
      for (let n = 0; n < 3; n++) {
        await call({ operation: 'status' }); breaker.snapshot();
      }
      expect(summaries).toHaveBeenCalledOnce();
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      recovering = true;
      time = 1_240_000;
      fetchSpy.mockResolvedValue(new Response(null));
      const input = { operation: 'run', request_id: `canary-${transport}`, role: 'coding', task: 'implementation', group: 'workers',
        brief, workdir: work, final_output: path.join(work, 'canary.json'), transport };
      if (transport === 'mcp') await buildStructuredBrief(f, input);
      else await writeFile(brief, 'independent synthetic canary');
      const response = JSON.parse((await call(input)).content[0].text);
      expect(response.status, JSON.stringify(response)).toBe('completed');
      expect(breaker.getState('quota:shared-quota').state).toBe('closed');
      expect(summaries.mock.calls.map(([event]) => event.to)).toEqual(['open', 'half-open', 'canary-ready', 'canary', 'closed']);
      expect(response.diagnostics).toEqual(expect.arrayContaining(summaries.mock.calls.slice(1).map(([event]) => event.summary)));
      expect(fetchSpy).toHaveBeenCalledTimes(4);
      // If a later outage has no relevant probe, the registered operator
      // surface must preserve the reason and the required repair action.
      for (const invocation of [...bodies, response]) {
        await call({ operation: 'reconcile_stopped', invocation_id: invocation.invocationId });
      }
      installation.endpoints = [];
      for (let n = 0; n < 3; n++) {
        const { token } = breaker.admit({ invocationId: `no-profile-${n}`, scopeKeys: ['quota:shared-quota'] });
        breaker.settle(token, { kind: 'failed', reasonCode: 'RATE_LIMIT', evidenceSource: 'launcher',
          quotaAccount: 'shared-quota', confirmedStop: true });
      }
      time = breaker.getState('quota:shared-quota').nextProbeAtMs;
      input.request_id = `operator-${transport}`;
      input.final_output = path.join(work, 'operator.json');
      if (transport === 'mcp') await buildStructuredBrief(f, input);
      else await writeFile(brief, 'independent synthetic operator intervention task');
      const blocked = JSON.parse((await call(input)).content[0].text);
      expect(blocked.status).toBe('blocked');
      expect(blocked.diagnostics.join(' ')).toContain('probe-profile-unavailable; restore a qualified scope-relevant probe');
      expect(breaker.getState('quota:shared-quota').state).toBe('operator-intervention');
      expect(fetchSpy).toHaveBeenCalledTimes(4);
      expect(summaries.mock.calls.at(-1)?.[0]).toMatchObject({ scopeKey: 'quota:shared-quota', to: 'operator-intervention',
        summary: expect.stringContaining('then reset this scope') });
      const status = JSON.parse((await call({ operation: 'status' })).content[0].text);
      expect(status.unresolvedReservations).toEqual([]);
      expect(status.interventionScopes).toEqual([{
        scopeId: 'quota:shared-quota', reason: expect.stringContaining('probe-profile-unavailable'),
        resetInstruction: { operation: 'reset_recovery_scope', scope_id: 'quota:shared-quota' },
      }]);
      expect(tools.get('worker-invoke').config.inputSchema.parse(status.interventionScopes[0].resetInstruction))
        .toMatchObject(status.interventionScopes[0].resetInstruction);
      const reset = () => call(status.interventionScopes[0].resetInstruction).then((result: any) => JSON.parse(result.content[0].text));
      expect(await reset()).toMatchObject({ ok: true, scopeId: 'quota:shared-quota' });
      expect(await reset()).toMatchObject({ ok: true });
      expect(JSON.parse((await call({ operation: 'status' })).content[0].text).interventionScopes).toEqual([]);
      input.request_id = `operator-resumed-${transport}`;
      input.final_output = path.join(work, 'resumed.json');
      if (transport === 'mcp') await buildStructuredBrief(f, input);
      else await writeFile(brief, 'independent synthetic operator resumed task');
      const resumed = JSON.parse((await call(input)).content[0].text);
      expect(resumed.status, JSON.stringify(resumed)).toBe('completed');
      await call({ operation: 'reconcile_stopped', invocation_id: resumed.invocationId });
      expect(await reset()).toMatchObject({ ok: true });
      // The same brief remains the same chain: reset must never restore its
      // two-attempt allowance, even across repeated successful resets.
      for (let n = 0; n < 2; n++) {
        await rm(input.final_output, { force: true });
        const retry = JSON.parse((await call({ ...input, request_id: `after-reset-${transport}-${n}` })).content[0].text);
        expect(retry.status).toBe(n === 0 ? 'completed' : 'blocked');
        if (n === 1) expect(retry.diagnostics.join(' ')).toMatch(/allowance exhausted/i);
      }
      expect(breaker.getState('quota:shared-quota').state).toBe('closed');
      expect(fetchSpy).toHaveBeenCalledTimes(4);
    } finally { breaker.destroy(); fetchSpy.mockRestore(); }
  });
});

describe('registered recovery reset and cancellation guards (#2915 final review)', () => {
  it('scoped reset refuses active and unresolved executions, survives registry pruning, and requires a scope', async () => {
    const root = await tempRoot();
    let time = 1_000_000;
    const breaker = new ScopedFailureBreaker({ nowMs: () => time, jitterMs: () => 0,
      policy: { distinctThreshold: 1, cooldownMs: 1 } });
    const registry = createInvocationRegistry({ maxRetained: 0 });
    const entry = registry.create({ recoveryBreaker: breaker, requestId: 'reset-owner' });
    const tools = await captureTool(null, { projectRoot: root, registry });
    const call = tools.get('worker-invoke').handler;
    const reset = async () => JSON.parse((await call({ operation: 'reset_recovery_scope', scope_id: 'installation:codex' })).content[0].text);
    try {
      expect((await call({ operation: 'reset_recovery_scope' })).isError).toBe(true);
      const first = breaker.admit({ invocationId: 'active-task', scopeKeys: ['installation:codex'] });
      expect(first.ok).toBe(true);
      expect(await reset()).toMatchObject({ ok: false, reason: expect.stringContaining('active or unresolved') });
      breaker.settle(first.token, { kind: 'failed', reasonCode: 'AUTH', cli: 'codex', evidenceSource: 'resolver', confirmedStop: true });
      time += 100;
      completeSyntheticPreliminaryProbe(breaker, 'reset-probe');
      const canary = breaker.admit({ invocationId: entry.invocationId, scopeKeys: ['installation:codex'] });
      expect(breaker.beginDispatch(canary.token, { invocationId: entry.invocationId, selectionDigest: null }).ok).toBe(true);
      expect(breaker.commitDispatch(canary.token).ok).toBe(true);
      breaker.settle(canary.token, { kind: 'uncertain', confirmedStop: false });
      expect(await reset()).toMatchObject({ ok: false });
      await call({ operation: 'reconcile_stopped', invocation_id: entry.invocationId });
      expect(registry.size).toBe(0);
      breaker.requireOperatorIntervention(['installation:codex'], 'probe-profile-unavailable');
      expect(JSON.parse((await call({ operation: 'status' })).content[0].text).interventionScopes).toHaveLength(1);
      expect(await reset()).toMatchObject({ ok: true });
      expect(await reset()).toMatchObject({ ok: true });
    } finally { breaker.destroy(); }
  });

  it.each(['before-admission', 'before-probe-debit', 'canary'] as const)(
    'live cancellation at %s spends only dispatched requests and does not increase cooldown', async cancelAt => {
      const root = await tempRoot();
      const work = path.join(root, 'work'); await mkdir(work);
      const brief = path.join(root, 'brief.md'); await writeFile(brief, 'cancelled recovery task');
      const f = buildFixture(root, 'shell');
      f.snapshot.config.parallelism!.retry = { maxAttempts: 2 };
      (f.drivers.codex.qualification as any).installation = { endpoints: ['https://provider.invalid/health'] };
      let time = 1_000_000;
      const breaker = new ScopedFailureBreaker({ nowMs: () => time, jitterMs: () => 0,
        policy: { distinctThreshold: 1, cooldownMs: 1 } });
      const opening = breaker.admit({ invocationId: 'opening', scopeKeys: ['installation:codex'] });
      breaker.settle(opening.token, { kind: 'failed', reasonCode: 'AUTH', cli: 'codex', evidenceSource: 'resolver', confirmedStop: true });
      time += 100;
      const initialCooldown = breaker.getState('installation:codex').episodeCooldownMs;
      const registry = createInvocationRegistry();
      let call: any;
      let shouldCancel = true;
      const cancel = () => call({ operation: 'cancel', invocation_id: registry.values().find((entry: any) => entry.terminalAt === null).invocationId });
      const begin = breaker.beginDispatch.bind(breaker);
      vi.spyOn(breaker, 'beginDispatch').mockImplementation((token: any, binding: any) => {
        const result = begin(token, binding);
        if (shouldCancel && cancelAt === 'before-probe-debit' && token.purpose === 'probe') void cancel();
        return result;
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
      const claims = { version: 1, status: 'completed', summary: 'ok', claims: [], artifacts: [], checks: [], limitations: [] };
      let workers = 0;
      const tools = await captureTool(null, { projectRoot: root, workerWorktreesRoot: work, registry, scopedBreaker: breaker,
        now: () => new Date(f.now),
        loadWorkerInputs: async () => {
          if (shouldCancel && cancelAt === 'before-admission') await cancel();
          return { snapshot: f.snapshot, drivers: f.drivers };
        },
        launchShellWorker: async (invocation: any, options: any) => {
          if (shouldCancel && cancelAt === 'canary') {
            await cancel();
            return { launched: false, diagnostic: 'cancelled before spawn' };
          }
          const a = options.admission;
          expect(a.breaker.beginDispatch(a.token, { invocationId: a.invocationId, selectionDigest: a.selectionDigest }).ok).toBe(true);
          await sessionLauncherModule.debitDirectWorkerAllowance(a.ledger);
          expect(a.breaker.commitDispatch(a.token).ok).toBe(true);
          workers++;
          await writeFile(invocation.finalPath, `${JSON.stringify({ type: 'result', result: claims })}\n`);
          return { launched: true, mode: 'degraded', child: closingChild(0) };
        },
      });
      call = tools.get('worker-invoke').handler;
      const input = { operation: 'run', request_id: 'cancel-recovery', role: 'coding', task: 'implementation', group: 'workers',
        brief, workdir: work, final_output: path.join(work, 'cancelled.json'), transport: 'shell' };
      try {
        const response = JSON.parse((await call(input)).content[0].text);
        expect(response.status).toMatch(/blocked|cancelled/);
        expect(workers).toBe(0);
        const expectedProbes = cancelAt === 'canary' ? 1 : 0;
        expect(fetchSpy).toHaveBeenCalledTimes(expectedProbes);
        expect(breaker.getState('installation:codex').episodeCooldownMs).toBe(initialCooldown);
        expect(breaker.snapshot().reservationsOutstanding).toBe(0);
        shouldCancel = false;
        const resumed = JSON.parse((await call({ ...input, request_id: 'cancel-recovery-resume',
          final_output: path.join(work, 'resumed.json') })).content[0].text);
        expect(resumed.status, JSON.stringify(resumed)).toBe('completed');
        expect(workers).toBe(1);
        expect(fetchSpy).toHaveBeenCalledOnce();
      } finally { breaker.destroy(); fetchSpy.mockRestore(); }
    });

  it('enforces the admission deadline before debiting or dispatching a preliminary probe', async () => {
    const root = await tempRoot();
    const work = path.join(root, 'work'); await mkdir(work);
    const brief = path.join(root, 'brief.md'); await writeFile(brief, 'expired recovery task');
    const f = buildFixture(root, 'shell');
    (f.drivers.codex.qualification as any).installation = { endpoints: ['https://provider.invalid/health'] };
    let time = 1_000_000;
    const breaker = new ScopedFailureBreaker({ nowMs: () => time, jitterMs: () => 0,
      policy: { distinctThreshold: 1, cooldownMs: 1 } });
    const opening = breaker.admit({ invocationId: 'opening', scopeKeys: ['installation:codex'] });
    breaker.settle(opening.token, { kind: 'failed', reasonCode: 'AUTH', cli: 'codex', evidenceSource: 'resolver', confirmedStop: true });
    time += 100;
    const admit = breaker.admit.bind(breaker);
    vi.spyOn(breaker, 'admit').mockImplementation((input: any) => {
      const result = admit(input);
      if (input.purpose !== 'probe') time += 1_000_000;
      return result;
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
    const launch = vi.fn();
    const tools = await captureTool(null, { projectRoot: root, workerWorktreesRoot: work, scopedBreaker: breaker,
      now: () => new Date(f.now), loadWorkerInputs: async () => ({ snapshot: f.snapshot, drivers: f.drivers }), launchShellWorker: launch });
    try {
      const response = JSON.parse((await tools.get('worker-invoke').handler({ operation: 'run', request_id: 'expired-probe',
        role: 'coding', task: 'implementation', group: 'workers', brief, workdir: work, final_output: path.join(work, 'final.json'),
        transport: 'shell' })).content[0].text);
      expect(response.status).toBe('blocked');
      expect(response.diagnostics.join(' ')).toMatch(/deadline exceeded/);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
      expect(breaker.snapshot().reservationsOutstanding).toBe(0);
    } finally { breaker.destroy(); fetchSpy.mockRestore(); }
  });
});
