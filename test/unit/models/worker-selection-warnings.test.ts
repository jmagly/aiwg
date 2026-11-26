// A flagship ceiling is policy input, never authority to elect a flagship worker.
import { describe, expect, it } from 'vitest';
import { workerSelectionPolicyWarnings } from '../../../src/models/worker-tier-selection.js';
describe('worker selection ceiling warnings', () => {
  it.each(['flagship', 'max-quality'] as const)('warns for %s without electing it', maxAutoTier => {
    expect(workerSelectionPolicyWarnings({ maxAutoTier })[0]).toContain('explicit user election');
  });
  it.each([undefined, 'economy', 'standard', 'premium'] as const)('accepts %s without warning', maxAutoTier => {
    expect(workerSelectionPolicyWarnings({ maxAutoTier })).toEqual([]);
  });
});
