// Creates synthetic projects and signed grants for executable process consumers.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyConfig } from '../../../src/config/aiwg-config.js';
import { effectSession, openLedger } from '../../../src/effects/host.js';
import { recordAuthorizationGrant } from '../../../src/effects/authorization-store.js';
import { grantFixture } from '../effects/build-grant-fixtures.js';
import { hitlDigest } from '../../../src/policy/hitl.js';
import type { HitlPromptEnvelope } from '../../../src/a2a/hitl.js';

export const pendingAction = () => ({ category: 'repo.read', repo: 'example/repo', environment: 'local',
  resources: ['src/index.ts'], reversible: true, impact: 'low' as const });
export const approvalPrompt = (): HitlPromptEnvelope => ({
  prompt_id: 'ad0eac57-f070-4464-855a-46b60455704b', prompt: 'Approve this read?',
  response_schema: { type: 'object', properties: { approve: { type: 'boolean' } }, required: ['approve'], additionalProperties: false },
});
export const boundApproval = (prompt = approvalPrompt()) => ({ taskId: 'task', contextId: 'context',
  promptId: prompt.prompt_id, promptDigest: hitlDigest(prompt), action: pendingAction(), response: { approve: true } });
export async function processProject() {
  const dir = await mkdtemp(join(tmpdir(), 'aiwg-process-authorization-'));
  await mkdir(join(dir, '.aiwg'));
  await writeFile(join(dir, '.aiwg/aiwg.config'), JSON.stringify(emptyConfig()));
  return dir;
}
export async function processGrant(dir: string) {
  const grant = grantFixture();
  grant.scope = { categories: ['repo.read'], targets: ['repo:example/repo', `workspace:${dir}`],
    environments: ['local'], resources: ['src/**'], verbs: ['read'] };
  grant.constraints.conditions = []; delete grant.constraints.maxUses;
  grant.createdAt = new Date(Date.now() - 1000).toISOString(); grant.expiresAt = 'until-revoked';
  await recordAuthorizationGrant(openLedger(await effectSession(dir, 'custom')), grant);
  return grant;
}
