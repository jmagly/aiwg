import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DecisionResultCache, FileResultCacheStore, RESULT_CACHE_KEY_VERSION } from '../../../src/decision/result-cache/index.js';
import type { ResultCacheSemanticIdentity } from '../../../src/decision/result-cache/index.js';
const dir = process.argv[2]!;
const sha = (c: string) => `sha256:${c.repeat(64)}` as const;
const pin = (c: string) => ({ id: c, version: '1', digest: sha(c) });
const identity: ResultCacheSemanticIdentity = { keyVersion: RESULT_CACHE_KEY_VERSION, definition: pin('a'), ruleset: pin('b'), binding: pin('c'),
  adapter: { id: 'adapter', version: '1' }, promptDigest: sha('d'), acceptancePolicyDigest: sha('e'),
  calibrationDigest: sha('f'), runtimePolicyDigest: sha('0'), backend: 'fixture', requestedModel: 'model',
  modelCompatibility: { mode: 'pinned', actualModel: 'model' }, primitive: 'choice', projectedInput: { subject: 'fixture' },
  subjectIdentityDigest: sha('1'), projectionPolicyDigest: sha('2'), egressPolicyDigest: sha('3'), capabilityMode: 'choice' };
const cache = new DecisionResultCache(new FileResultCacheStore(join(dir, 'cache')));
const result = await cache.evaluate({ actor: { tenantId: 't', projectId: 'p', workspaceId: 'w', subjectId: 'subject', permissions: ['read', 'write', 'invalidate'] },
  policy: { enabled: true, sideEffectFree: true, policyVersion: '1', ttlMs: 30_000, scope: 'workspace', sensitivity: 'internal' },
  identity, callerInvocationId: process.argv[3]! }, async () => {
    await appendFile(join(dir, 'calls'), 'call\n');
    await new Promise(resolve => setTimeout(resolve, 200));
    return { result: { answer: true }, resultDigest: sha('9'), sourceInvocationId: process.argv[3]!, sourceReceiptId: 'receipt',
      evaluatedAtEpochMs: Date.now(), actualModel: 'model', uncertainty: null, calibrationStatus: 'approved', durationMs: 200,
      usage: { inputTokens: 10, outputTokens: 2, costUsd: null }, status: 'success' as const, failureReason: 'none' as const };
  });
process.stdout.write(JSON.stringify(result.receipt));
