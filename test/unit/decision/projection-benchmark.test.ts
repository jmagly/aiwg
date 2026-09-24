import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import { dispatchProjectedDecisionState, projectDecisionState, type DecisionProjectionPolicy } from '../../../src/decision/projection.js';

const basePolicy = (): DecisionProjectionPolicy => ({ version: 'benchmark-v1', provider: 'jev', model: 'jev-1',
  origin: 'https://api.typesafe.ai', region: 'us', purpose: 'offline-triage', allowIncompleteContext: false,
  fields: [{ pointer: '/allowed', output: 'excerpt', source: 'fixture', subject: 'benchmark-subject',
    trust: 'untrusted', sensitivity: 'internal', purpose: 'offline-triage', retentionClass: 'ephemeral',
    accessScopes: ['decision-runtime'], exportPolicy: 'denied', deletionPolicy: 'erase', backupPolicy: 'not-persisted',
    allowedProviders: ['jev'], allowedModels: ['jev-1'], allowedOrigins: ['https://api.typesafe.ai'], allowedRegions: ['us'] }],
});

/** Synthetic offline matrix; time is observed, never used as an environment-dependent pass/fail threshold. */
describe('projection offline benchmark fixture', () => {
  it('holds deterministic projection identity across 55 admitted samples and denies 55 egress changes before any I/O', async () => {
    const policy = basePolicy();
    const resolveCredential = vi.fn(async () => 'fixture-credential');
    const dispatch = vi.fn(async ({ state }: { state: Readonly<Record<string, unknown>> }) => state);
    const start = performance.now();
    const digests: string[] = [];
    for (let i = 0; i < 55; i++) {
      const input = { allowed: 'fixture excerpt', adjacent: `synthetic-restricted-canary-${i}` };
      const projected = await projectDecisionState(input, policy);
      digests.push(projected.evidence.projectedDigest);
      expect(JSON.stringify(projected)).not.toContain(input.adjacent);
      await expect(dispatchProjectedDecisionState(input, { ...policy, region: 'unapproved' },
        { resolveCredential, dispatch })).rejects.toMatchObject({ reason: 'data-boundary-denied' });
    }
    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeGreaterThanOrEqual(0);
    console.info(`projection offline fixture: samples=55 denied=55 elapsedMs=${Math.round(elapsedMs)}`);
    expect(new Set(digests).size).toBe(1);
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
