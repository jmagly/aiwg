import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DecisionJobGateway } from '../../../src/decision/job-gateway.js';
import { FileJobPollLimiter } from '../../../src/decision/job-poll-limiter.js';
import { DecisionJobRuntime } from '../../../src/decision/job-runtime.js';
import { FileJobStore } from '../../../src/decision/job-store.js';
const actor = { tenantId: 't', projectId: 'p', workspaceId: 'w', principalId: 'CANARY_ACTOR_2610' };
describe('JOB durable polling backpressure', () => {
  it('shares scoped rate limits across restarted instances and bounds ledger cardinality', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'job-poll-')); let now = 20;
    try {
      const gate = () => new FileJobPollLimiter(dir, 100, 2, 3, 4, () => now);
      await Promise.all([gate().check(actor), gate().check(actor)]);
      await expect(gate().check(actor)).rejects.toThrow('throttled');
      const other = { ...actor, principalId: 'other' };
      await gate().check(other);
      await expect(gate().check(other)).rejects.toThrow('throttled');
      const alien = { ...actor, projectId: 'new' };
      await expect(gate().check(alien)).rejects.toThrow('full');
      const data = await readFile(join(dir, '.poll-ledger.json'), 'utf8');
      expect(data).not.toContain('CANARY');
      now = 121;
      await gate().check(alien);
      const gateway = new DecisionJobGateway(new DecisionJobRuntime(new FileJobStore(dir), () => now),
        Buffer.alloc(32, 1), () => now, scope => gate().check(scope));
      expect(await gateway.poll(alien, 'forged')).toBeNull();
      await expect(gateway.poll(alien, 'forged')).rejects.toThrow('throttled');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
