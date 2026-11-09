// Resuming a critical overseer pause is a safety override, never an ordinary repo action.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import * as hitlCheck from '../../../src/policy/hitl-check.js';
import { EscalationHandler } from '../../../tools/ralph-external/lib/escalation-handler.mjs';
import { processGrant, processProject } from '../../fixtures/policy/process-authorization.js';

let dir: string;
beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('AIWG_EFFECT_LEDGER_TEST_KEY', 'a'.repeat(64));
  vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src'); dir = await processProject();
});
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
it.each([true, false])('checks before escalating a critical pause and retains human review (grant=%s)', async present => {
  if (present) await processGrant(dir);
  const handler = new EscalationHandler({ projectRoot: dir, repo: 'example/repo', enableNotifications: true });
  const notify = vi.spyOn(handler, 'sendDesktopNotification').mockImplementation(() => {});
  vi.spyOn(handler, 'createIssue').mockResolvedValue({ number: 1, url: 'https://fixture.test/issues/1' });
  const result = await handler.escalate('critical', { loopId: 'loop-1', reason: 'Critical deviation',
    intervention: { level: 'pause', requiresApproval: true } });
  expect(result.authorization).toMatchObject({ decision: 'escalate', reason: 'safety-category-requires-explicit-review' });
  expect(result.authorization).not.toHaveProperty('receipt');
  expect(notify).toHaveBeenCalledOnce(); expect(result.channels).toContain('gitea_issue');
});

it('retains escalation channels when the authorization check is unavailable', async () => {
  vi.spyOn(hitlCheck, 'checkHitlAuthorization').mockRejectedValue(new Error('synthetic unavailable checker'));
  const handler = new EscalationHandler({ projectRoot: dir, enableNotifications: true });
  const notify = vi.spyOn(handler, 'sendDesktopNotification').mockImplementation(() => {});
  vi.spyOn(handler, 'createIssue').mockResolvedValue({ number: 1, url: 'https://fixture.test/issues/1' });
  expect(await handler.escalate('critical', { reason: 'Critical stop' })).toMatchObject({
    authorization: { decision: 'escalate', reason: 'authorization-check-unavailable' },
    channels: ['desktop_notification', 'gitea_issue'],
  });
  expect(notify).toHaveBeenCalledOnce();
});
