// Verifies real lookup-before-ask behavior at the A2A prompt delivery seam.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import * as hitlCheck from '../../../src/policy/hitl-check.js';
import { driveOnePrompt } from '../../../src/a2a/hitl-driver.js';
import { approvalPrompt, boundApproval, processGrant, processProject } from '../../fixtures/policy/process-authorization.js';

describe('host-bound A2A approval lookup', () => {
  let dir: string;
  beforeEach(async () => {
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('AIWG_EFFECT_LEDGER_TEST_KEY', 'a'.repeat(64));
    dir = await processProject();
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
  async function run(change: (opts: any) => void = () => {}) {
    const collect = vi.fn(async () => ({ approve: false }));
    const sendMessage = vi.fn(async () => ({})); const entries: any[] = [];
    const envelope = approvalPrompt();
    const options = { envelope, taskId: 'task', contextId: 'context',
      authorization: { projectDir: dir, bindings: new Map([[envelope.prompt_id, boundApproval(envelope)]]) },
      client: { sendMessage }, adapter: { name: 'test', collect }, auditLog: { append: (e: any) => { entries.push(e); } } };
    change(options);
    await driveOnePrompt(options as any);
    return { collect, sendMessage, entries };
  }
  it('skips collection only with a matching grant and records its receipt beside the response', async () => {
    const grant = await processGrant(dir); const s = await run();
    expect(s.collect).not.toHaveBeenCalled(); expect(s.sendMessage).toHaveBeenCalledOnce();
    expect(s.entries[0]).toMatchObject({ outcome: 'responded', authorization: {
      receipt: { file: expect.any(String), effectId: expect.any(String) }, authorizationGrant: { grantId: grant.grantId } } });
    expect(JSON.parse(await readFile(s.entries[0].authorization.receipt.file, 'utf8'))).toMatchObject({ action: { category: 'repo.read' } });
  });
  it('shows the original prompt when no grant exists', async () => {
    const s = await run(); expect(s.collect).toHaveBeenCalledOnce();
    expect(s.entries[0]).not.toHaveProperty('authorization');
  });
  it.each(['deny', 'escalate', 'receipt-missing', 'check-failed'])('keeps the collector for %s', async kind => {
    const check = vi.spyOn(hitlCheck, 'checkHitlAuthorization');
    if (kind === 'check-failed') check.mockRejectedValue(new Error('synthetic lookup failure'));
    else check.mockResolvedValue({ decision: kind === 'receipt-missing' ? 'auto-authorized' : kind } as any);
    const s = await run(); expect(s.collect).toHaveBeenCalledOnce();
    expect(s.entries[0]).not.toHaveProperty('authorization');
  });
  it.each(['task', 'context', 'prompt', 'schema', 'missing-binding', 'unsafe', 'expired', 'restricted', 'invalid-response'])
  ('retains review for %s even with a grant', async kind => {
    await processGrant(dir);
    const s = await run(o => {
      const b = o.authorization.bindings.get(o.envelope.prompt_id);
      if (kind === 'task') o.taskId = 'other';
      if (kind === 'context') o.contextId = 'other';
      if (kind === 'prompt') o.envelope.prompt = 'Approve a different action';
      if (kind === 'schema') o.envelope.response_schema.properties = {};
      if (kind === 'missing-binding') o.authorization.bindings.clear();
      if (kind === 'unsafe') b.action.reversible = false;
      if (kind === 'expired') o.envelope.deadline = '2000-01-01T00:00:00Z';
      if (kind === 'restricted') o.envelope.allowed_responders = ['specific:another'];
      if (kind === 'invalid-response') b.response = { unexpected: true };
    });
    if (kind !== 'restricted') expect(s.collect).toHaveBeenCalled();
    expect(s.entries[0]).not.toHaveProperty('authorization');
  });
});
