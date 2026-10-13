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
import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workerConfigDigest } from '../../../src/config/aiwg-config.js';
import { resolveWorkerInvocation, type WorkerInvocationDriver } from '../../../src/serve/worker-invocation.js';
import { assertValidWorkerPayload } from '../../../src/mission-protocol/index.js';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { workerInputSchema, workerOutputSchema } from '../../fixtures/ralph-worker-protocol.mjs';
import { parseToolsets, registerOptInToolsets, KNOWN_TOOLSETS } from '../../../src/mcp/tools/subsystems.mjs';

// @ts-expect-error — .mjs untyped
import * as workerInvoke from '../../../src/mcp/tools/worker-invoke.mjs';

const {
  createInvocationRegistry, resolveServerAllowDegraded, resolveServedProjectRoot,
  registerWorkerInvokeToolset: registerProductionToolset,
  WORKERS_TOOLSET_NAME, withServerQueue, __testOnlyMcpServerQueueCount,
} = workerInvoke as any;

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

const digest = (v: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(v)).digest('hex')}`;
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });

async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-worker-invoke-'));
  roots.push(root);
  return root;
}

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

  // #2892 F2: cancellation must reference the worker's OWN actual in-flight
  // JSON-RPC request id (captured at the transport layer), never a
  // caller-supplied value with no relationship to the wire protocol
  // (`mcpBinding.requestId` was never even populated — always `null`).
  it('cancel sends notifications/cancelled with the ACTUAL in-flight request id, never null (#2892 F2)', async () => {
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
  async function invoke(root: string, config: string, extra: Record<string, unknown> = {}, registerOverrides: Record<string, unknown> = {}) {
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
    return call({ operation: 'run', request_id: `mcp-${Math.random()}`, role: 'coding', task: 'implementation', group: 'workers',
      brief: briefPath, workdir: work, final_output: finalOutput, transport: 'mcp', ...extra });
  }

  it('success scenario: completed, confirmed termination', async () => {
    const root = await tempRoot();
    const config = path.join(root, 'fixture-config.json');
    await writeFile(config, JSON.stringify({ recordPath: path.join(root, 'record.jsonl'), scenario: 'success' }));
    const result = await invoke(root, config);
    const body = JSON.parse(result.content[0].text);
    expect(body.status, JSON.stringify(body)).toBe('completed');
    expect(body.termination).toBe('confirmed');
  }, 20000);

  it('isError scenario: failed, confirmed termination (never parsed as success)', async () => {
    const root = await tempRoot();
    const config = path.join(root, 'fixture-config.json');
    await writeFile(config, JSON.stringify({ recordPath: path.join(root, 'record.jsonl'), scenario: 'isError' }));
    const result = await invoke(root, config);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe('failed');
    expect(body.termination).toBe('confirmed');
  }, 20000);

  it('disconnect scenario: uncertain, never a blind replay', async () => {
    const root = await tempRoot();
    const config = path.join(root, 'fixture-config.json');
    await writeFile(config, JSON.stringify({ recordPath: path.join(root, 'record.jsonl'), scenario: 'disconnect' }));
    const result = await invoke(root, config);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe('uncertain');
    expect(body.termination).toBe('uncertain');
  }, 20000);

  it('truncation scenario: never accepted as completed (SDK refuses the malformed response before this bridge ever parses it)', async () => {
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

  it('two concurrent tasks against distinct workspaces share no model/workspace/output state', async () => {
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
  it('the spawned MCP worker process receives exactly the allowlisted environment, never the conductor\'s own inherited env', async () => {
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
  it('refuses before any brief is sent when the live tool schema has drifted from the qualified pin', async () => {
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
  it('refuses a __proto__-only schema variant that the SDK\'s own zod parsing would silently erase (#2892 F3)', async () => {
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
  it('refuses when the live tool stops advertising an output schema the qualified descriptor requires (#2892 F3)', async () => {
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
});

// ---------------------------------------------------------------------------
// #2892 D2/D3: the per-serverRef serialized queue is bounded and rechecks
// qualification before each launch; two tasks against the SAME registered
// server share no model/workspace/output state.
// ---------------------------------------------------------------------------
describe('serialized per-server MCP queue — requalified before each launch, no crossover (#2892 D2/D3)', () => {
  it('two tasks on the SAME registered serialized server both complete independently, with the qualification rechecked before each launch', async () => {
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
      const timerIndex = setTimer.mock.calls.findIndex(c => c[1] === 1000);
      expect(timerIndex).toBeGreaterThanOrEqual(0);
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
    let stdinPath = '';
    let h: Awaited<ReturnType<typeof harness>>;
    const spawn = vi.fn((command: string, args: string[]) => {
      if (command === 'systemd-run') {
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
    expect(spawn.mock.calls.some(c => c[0] === 'systemd-run')).toBe(true);
    await expect(stat(stdinPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(h.registry.canStart()).toBe(true);
  });

  it.each(['nonzero', 'timeout', 'throws'])('retains framed stdin and output after an attempted systemd launch %s until stopped', async failure => {
    let stdinPath = '';
    let unit = '';
    let confirmed = false;
    let h: Awaited<ReturnType<typeof harness>>;
    const spawn = vi.fn((binary: string, args: string[]) => {
      if (binary !== 'systemd-run') return { status: 0, stdout: '', stderr: '' };
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
    expect(result.status).toBe('uncertain');
    expect(stop).toHaveBeenCalledOnce();
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
