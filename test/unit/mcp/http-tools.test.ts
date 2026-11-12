// Verify remote CLI argument policy independently of today's flat tool schemas.
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { remoteToolPolicy } from '../../../src/mcp/http-tools.mjs';

it('rejects CLI options recursively inside objects and arrays before invoking a CLI-backed handler', async () => {
  const handler = vi.fn();
  const policy = remoteToolPolicy('/fixture/project');
  const tool = policy.configureTool('fixture-show', { inputSchema: z.object({ nested: z.unknown() }) }, handler)!;
  const extra = { signal: new AbortController().signal };
  for (const nested of [{ option: '--project=/outside' }, [{ values: [['--resource-source=web']] }]]) {
    await expect(tool.handler({ nested }, extra)).rejects.toThrow('must not contain CLI options');
  }
  expect(handler).not.toHaveBeenCalled();
  expect(policy.busy()).toBe(false);
  await tool.handler({ nested: [{ values: [null, 42, 'ordinary data'] }] }, extra);
  expect(handler).toHaveBeenCalledOnce();
});

it('permits CLI-looking artifact content because artifact-write does not spawn a CLI', async () => {
  const handler = vi.fn().mockResolvedValue('written');
  const policy = remoteToolPolicy('/fixture/project');
  const tool = policy.configureTool('artifact-write', { inputSchema: z.object({ content: z.string() }) }, handler)!;
  const args = { content: '--project is literal document content' };
  const extra = { signal: new AbortController().signal };
  await expect(tool.handler(args, extra)).resolves.toBe('written');
  expect(handler).toHaveBeenCalledWith(args, extra);
});

it('exposes only verify-and-deliver from workers over HTTP and preserves check argv as data', async () => {
  const policy = remoteToolPolicy('/fixture/project');
  const handler = vi.fn().mockResolvedValue('accepted');
  const schema = z.object({ checks: z.array(z.object({ args: z.array(z.string()) })) });
  const tool = policy.configureTool('worker-verify-deliver', { inputSchema: schema }, handler);
  expect(tool).toBeDefined();
  expect(remoteToolPolicy('/fixture/project', undefined, { verifiedDeliveryOnly: true }).configureTool('artifact-write', { inputSchema: schema }, handler)).toBeUndefined();
  expect(policy.configureTool('worker-invoke', { inputSchema: schema }, handler)).toBeUndefined();
  await tool!.handler({ checks: [{ args: ['--test'] }] }, { signal: new AbortController().signal });
  expect(handler).toHaveBeenCalledOnce();
});
