// Native-sandbox branches of launchPreparedShellWorker (#4136): framed or closed stdin,
// drained pipes, owned-group authority, and the spawn-attempt error path.
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { launchPreparedShellWorker } from '../../../src/mcp/tools/worker-stdin-runtime.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const brief = Buffer.from('Task body');
const digest = `sha256:${createHash('sha256').update(brief).digest('hex')}`;

function fakeChild() {
  const stream = () => Object.assign(new EventEmitter(), { resume: vi.fn() });
  const stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
  return Object.assign(new EventEmitter(), { stdout: stream(), stderr: stream(), stdin });
}

function setup({ bytes, plan }: { bytes: Buffer | null; plan: (options: any) => Promise<any> }) {
  const root = mkdtempSync(path.join(tmpdir(), 'aiwg-stdin-native-')); roots.push(root);
  const planDirectWorkerLaunch = vi.fn(plan);
  const deps = {
    loadRalphExternal: async (relative: string) => relative === 'session-launcher.mjs' ? { planDirectWorkerLaunch }
      : import(path.resolve('tools/ralph-external', relative)),
    readBoundedFile: async () => brief,
    importImpl: async () => ({ workerStdinBytes: () => bytes }),
    describeGateFailures: () => 'gate',
  };
  const options = { memoryMaxGb: 2, stdinRuntimeRoot: root, servedRoot: root, isolation: { mode: 'systemd-unit' } };
  const invocation: any = { briefPath: path.join(root, 'brief.md'), briefDigest: digest, envNames: [], isolation: 'native-sandbox', invocationId: 'inv-1', cwd: root, selected: { group: 'codex-0-low' } };
  return { planDirectWorkerLaunch, deps, options, invocation };
}

describe('launchPreparedShellWorker native-sandbox (#4136)', () => {
  it('attaches the native CLI, frames stdin, drains pipes and keeps owned-group authority', async () => {
    const child = fakeChild();
    const bytes = Buffer.from('framed brief');
    const f = setup({ bytes, plan: async options => {
      options.onSpawnAttempt({ mode: 'native-sandbox', pid: 41, child });
      return { launched: true, mode: 'native-sandbox', pid: 41, child };
    } });
    const result = await launchPreparedShellWorker(f.invocation, f.options, f.deps);
    const planned = f.planDirectWorkerLaunch.mock.calls[0][0];
    expect(planned.isolation).toEqual({ mode: 'native-sandbox' });
    expect(planned).toMatchObject({ attached: true, stdin: 'open', ownedGroup: true });
    expect(child.stdout.resume).toHaveBeenCalled();
    expect(child.stderr.resume).toHaveBeenCalled();
    expect(child.stdin.end).toHaveBeenCalledWith(bytes);
    expect(result).toMatchObject({ launched: true, launchAttempted: true, ownedGroup: true });
    child.stdin.emit('error', new Error('EPIPE')); // ignored after the worker closes stdin
    await result.cleanup();
  });

  it('closes stdin when the profile frames no brief bytes', async () => {
    const child = fakeChild();
    const f = setup({ bytes: null, plan: async () => ({ launched: true, mode: 'native-sandbox', pid: 42, child }) });
    const result = await launchPreparedShellWorker(f.invocation, f.options, f.deps);
    expect(f.planDirectWorkerLaunch.mock.calls[0][0]).toMatchObject({ attached: true, stdin: 'closed' });
    expect(child.stdin.end).toHaveBeenCalledWith(undefined);
    expect(result.ownedGroup).toBe(true);
  });

  it('reports a native-sandbox spawn attempt that then failed as owned and attempted', async () => {
    const f = setup({ bytes: null, plan: async options => {
      options.onSpawnAttempt({ mode: 'native-sandbox', pid: 43 });
      throw new Error('spawn failed after start');
    } });
    const result = await launchPreparedShellWorker(f.invocation, f.options, f.deps);
    expect(result).toMatchObject({ launched: false, launchAttempted: true, ownedGroup: true, diagnostic: 'spawn failed after start' });
  });

  it('keeps the configured isolation and no attached stdin for non-native launches', async () => {
    const f = setup({ bytes: null, plan: async () => ({ launched: true, mode: 'systemd-unit', unit: 'u' }) });
    f.invocation.isolation = 'systemd-unit';
    const result = await launchPreparedShellWorker(f.invocation, f.options, f.deps);
    const planned = f.planDirectWorkerLaunch.mock.calls[0][0];
    expect(planned.isolation).toEqual({ mode: 'systemd-unit' });
    expect(planned.attached).toBeUndefined();
    expect(result.ownedGroup).toBe(false);
  });
});

describe('launchPreparedShellWorker brief contract (#4156)', () => {
  it('frames the stdin brief with the launcher final-output contract', async () => {
    const f = setup({ bytes: null, plan: async () => ({ launched: false, blocked: true }) });
    const seen: Buffer[] = [];
    f.deps.importImpl = async () => ({ workerStdinBytes: (_inv: any, prompt: Buffer) => { seen.push(prompt); return null; } });
    f.invocation.isolation = 'systemd-unit';
    f.invocation.finalPath = path.join(f.invocation.cwd, '.handoff', 'final.json');
    await launchPreparedShellWorker(f.invocation, f.options, f.deps);
    const text = seen[0].toString('utf8');
    expect(text).toContain('[Worker final-output contract]');
    expect(text).toContain(JSON.stringify(f.invocation.finalPath));
    expect(text).toContain('Task body');
  });

  it('gives a closed-stdin --prompt-file profile a derived brief carrying the contract', async () => {
    const { readFileSync } = await import('node:fs');
    const f = setup({ bytes: null, plan: async () => ({ launched: false, blocked: true }) });
    f.invocation.isolation = 'systemd-unit';
    f.invocation.stdin = 'closed';
    f.invocation.finalPath = path.join(f.invocation.cwd, '.handoff', 'final.json');
    f.invocation.argv = ['/usr/bin/muse', 'exec', '--prompt-file', f.invocation.briefPath];
    await launchPreparedShellWorker(f.invocation, f.options, f.deps);
    const argv: string[] = f.planDirectWorkerLaunch.mock.calls[0][0].invocation.argv;
    const derived = argv[3];
    expect(derived).not.toBe(f.invocation.briefPath);
    expect(derived.startsWith(path.join(f.invocation.cwd, '.handoff', 'worker-brief-inv-1'))).toBe(true);
    const text = readFileSync(derived, 'utf8');
    expect(text).toContain('[Worker final-output contract]');
    expect(text).toContain('Task body');
  });
});
