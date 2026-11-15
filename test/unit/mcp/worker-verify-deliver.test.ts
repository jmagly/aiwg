import { describe, it, expect, vi } from 'vitest';
import { registerWorkerVerifyDeliverTool } from '../../../src/mcp/tools/worker-verify-deliver.mjs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { remoteToolPolicy } from '../../../src/mcp/http-tools.mjs';

describe('T-OG-04 MCP verify and deliver', () => {
  const request = { run_dir: '/served/runs/one', artifact_path: '/served/worker/final', deliverable_path: '/served/deliver/final', checks: [{ id: 'unit', command: '/bin/sh', args: ['-c', 'exit 0'] }] };
  async function setup(status: string) {
    let handler: any;
    const verify = vi.fn(async () => ({ status, deliveryRecord: status === 'accepted' ? { recordHash: 'signed' } : undefined }));
    await registerWorkerVerifyDeliverTool({ registerTool: (_n: any, _s: any, h: any) => { handler = h; } }, { projectRoot: '/served', assertPath: async (p: string) => { if (!p.startsWith('/served/')) throw Error('outside'); return p; }, verify });
    return { handler, verify };
  }
  it.each(['accepted', 'blocked', 'rejected'])('returns the authoritative %s result from verifyWorkerRun', async status => {
    const { handler, verify } = await setup(status);
    const result = await handler(request);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ status });
    expect(verify).toHaveBeenCalledWith({ projectDir: '/served', runDir: request.run_dir, artifactPath: request.artifact_path, deliverablePath: request.deliverable_path, checks: request.checks });
  });
  it('rejects worker-supplied authority overrides and duplicate protected check IDs', async () => {
    const { handler, verify } = await setup('accepted');
    for (const input of [{ ...request, allow_degraded: true }, { ...request, checks: [request.checks[0], request.checks[0]] }, { ...request, checks: [] }, { ...request, checks: [{ id: 'bad', command: 'sh' }] }]) {
      expect((await handler(input)).isError).toBe(true);
    }
    expect(verify).not.toHaveBeenCalled();
  });
  it('rejects paths outside the served root before invoking verification', async () => {
    const { handler, verify } = await setup('accepted');
    expect((await handler({ ...request, deliverable_path: '/outside' })).isError).toBe(true);
    expect(verify).not.toHaveBeenCalled();
  });
  const stop = { status: 'denied', code: 'POLICY_DENIED', blocking_rule: 'Policy forbids this launch.', launch_count: 0 };
  it('dispatches a zero-worker stop through the same installed verifier', async () => {
    const { handler, verify } = await setup('accepted');
    expect(JSON.parse((await handler({ deliverable_path: request.deliverable_path, typed_stop: stop })).content[0].text)).toMatchObject({ status: 'accepted' });
    expect(verify).toHaveBeenCalledWith({ projectDir: '/served', deliverablePath: request.deliverable_path, typedStop: stop });
  });
  it.each([
    { ...stop, status: 'accepted' }, { ...stop, code: 'ab' }, { ...stop, code: 'AB' }, { ...stop, code: 'A'.repeat(65) },
    { ...stop, launch_count: 1 }, { ...stop, launch_count: '0' }, { ...stop, blocking_rule: ' ' },
    { ...stop, blocking_rule: 'x'.repeat(2001) }, { ...stop, reason: 'x'.repeat(4001) },
    { ...stop, uncertainty_statement: false }, { ...stop, uncertainty_statement: 'x'.repeat(4001) },
    { ...stop, launch_count: undefined }, { ...stop, surprise: true }, null,
  ])('returns TYPED_STOP_INVALID for invalid stop %#', async typed_stop => {
    const { handler, verify } = await setup('accepted');
    const response = await handler({ deliverable_path: request.deliverable_path, typed_stop });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text)).toMatchObject({ errorCode: 'TYPED_STOP_INVALID' });
    expect(verify).not.toHaveBeenCalled();
  });
  it.each(['run_dir', 'artifact_path', 'checks'])('rejects mixed requests containing %s', async key => {
    const { handler, verify } = await setup('accepted');
    const response = await handler({ deliverable_path: request.deliverable_path, typed_stop: stop, [key]: request[key] });
    expect(JSON.parse(response.content[0].text)).toMatchObject({ errorCode: 'TYPED_STOP_INVALID' });
    expect(verify).not.toHaveBeenCalled();
  });
  it('advertises both strict shapes and validates them through the actual MCP SDK', async () => {
    const server = new McpServer({ name: 'publication-fixture', version: '1' });
    const client = new Client({ name: 'publication-client', version: '1' });
    const verify = vi.fn(async () => ({ status: 'accepted' }));
    const policy = remoteToolPolicy('/served', undefined, { verifiedDeliveryOnly: true });
    registerWorkerVerifyDeliverTool({ registerTool(name, config, handler) {
      const projected = policy.configureTool(name, config, handler)!;
      server.registerTool(name, projected.config, projected.handler);
    } }, { projectRoot: '/served', assertPath: async p => p, verify });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(b); await client.connect(a);
      const advertised = (await client.listTools()).tools.find(tool => tool.name === 'worker-verify-deliver')!;
      expect(advertised.inputSchema.anyOf).toHaveLength(2);
      expect(advertised.inputSchema.anyOf).toEqual(expect.arrayContaining([expect.objectContaining({ additionalProperties: false, required: ['deliverable_path', 'typed_stop'] })]));
      await client.callTool({ name: advertised.name, arguments: request });
      await client.callTool({ name: advertised.name, arguments: { deliverable_path: request.deliverable_path, typed_stop: stop } });
      expect(verify).toHaveBeenCalledTimes(2);
      for (const input of [{ ...request, typed_stop: stop }, { ...request, project_dir: '/outside' }, { deliverable_path: request.deliverable_path, typed_stop: { ...stop, launch_count: 1 } }]) {
        const refused = await client.callTool({ name: advertised.name, arguments: input });
        expect(refused).toMatchObject({ isError: true, content: [expect.objectContaining({ text: expect.stringContaining('TYPED_STOP_INVALID') })] });
      }
      expect(verify).toHaveBeenCalledTimes(2);
    } finally { await client.close(); await server.close(); }
  });
});
