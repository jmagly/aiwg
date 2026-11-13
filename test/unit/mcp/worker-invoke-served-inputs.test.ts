// The MCP server's default worker-input loader must not hand the host-resource
// sampler a bare `resolve` subcommand (#4148).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { servedWorkerInputsContext } from '../../../src/mcp/tools/worker-invoke.mjs';
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
