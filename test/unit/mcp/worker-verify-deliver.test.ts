import { describe, it, expect, vi } from 'vitest';
import { registerWorkerVerifyDeliverTool } from '../../../src/mcp/tools/worker-verify-deliver.mjs';

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
});
