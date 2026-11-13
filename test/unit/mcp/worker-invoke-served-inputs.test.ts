// The MCP server's default worker-input loader must not hand the host-resource
// sampler a bare `resolve` subcommand (#4148).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { servedWorkerInputsContext, shellFinalFormat, unobservedSystemdExit } from '../../../src/mcp/tools/worker-invoke.mjs';
import { sampleWorkerHostResources } from '../../../src/cli/handlers/models-resource-sample.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('servedWorkerInputsContext (#4148)', () => {
  it('matches the launcher loader shape: no subcommand args', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aiwg-4148-'));
    roots.push(root);
    const ctx = servedWorkerInputsContext(root);
    expect(ctx.cwd).toBe(root);
    expect(ctx.args).toEqual([]);
    expect(ctx.rawArgs).toEqual([]);
    expect(path.isAbsolute(ctx.frameworkRoot)).toBe(true);
  });

  it('lets the host-resource sampler run without a resolve request', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aiwg-4148-'));
    roots.push(root);
    expect(() => sampleWorkerHostResources(servedWorkerInputsContext(root))).not.toThrow();
  });

  it('documents the failure the old context produced', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aiwg-4148-'));
    roots.push(root);
    expect(() => sampleWorkerHostResources({ cwd: root, args: ['resolve'] })).toThrow('Missing role');
  });
});

describe('shellFinalFormat (#4151)', () => {
  const claims = { version: 1, status: 'completed', summary: 'ok', claims: [], artifacts: [], checks: [], limitations: [] };
  it('reads plain claims JSON, including pretty-printed, as json', () => {
    expect(shellFinalFormat(JSON.stringify(claims))).toBe('json');
    expect(shellFinalFormat(`${JSON.stringify(claims, null, 2)}\n`)).toBe('json');
    expect(shellFinalFormat(Buffer.from(JSON.stringify(claims)))).toBe('json');
  });
  it('keeps result streams and anything unparseable on the strict jsonl path', () => {
    expect(shellFinalFormat(`${JSON.stringify({ type: 'result', result: claims })}\n`)).toBe('jsonl');
    expect(shellFinalFormat(`${JSON.stringify({ type: 'message', text: 'x' })}\n${JSON.stringify({ type: 'result', result: claims })}\n`)).toBe('jsonl');
    expect(shellFinalFormat('not json')).toBe('jsonl');
    expect(shellFinalFormat('[1]')).toBe('jsonl');
  });
});

describe('unobservedSystemdExit (#4157)', () => {
  const systemd = { isolation: 'systemd-unit' };
  it('names the owned-capture route when a confirmed systemd unit has no observable exit status', () => {
    const d = unobservedSystemdExit(systemd, { termination: 'confirmed', exitCode: null });
    expect(d).toMatchObject({ code: 'OG_WORKER_EXIT_UNOBSERVED' });
    expect(d!.remedy).toContain('run_dir');
  });
  it('stays out of the way for observed exits, stops, timeouts, never-executed units and other isolation', () => {
    expect(unobservedSystemdExit(systemd, { termination: 'confirmed', exitCode: 0 })).toBeNull();
    expect(unobservedSystemdExit(systemd, { termination: 'confirmed', exitCode: 1 })).toBeNull();
    expect(unobservedSystemdExit(systemd, { termination: 'uncertain', exitCode: null })).toBeNull();
    expect(unobservedSystemdExit(systemd, { termination: 'confirmed', exitCode: null, timedOut: true })).toBeNull();
    expect(unobservedSystemdExit(systemd, { termination: 'confirmed', exitCode: null, stopped: true })).toBeNull();
    expect(unobservedSystemdExit(systemd, { termination: 'confirmed', exitCode: null, neverExecuted: true })).toBeNull();
    expect(unobservedSystemdExit({ isolation: 'degraded' }, { termination: 'confirmed', exitCode: null })).toBeNull();
  });
});
