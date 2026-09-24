import { describe, expect, it, vi } from 'vitest';
import {
  DECISION_LIFECYCLE_SURFACES, DECISION_LIFECYCLE_VERSION, eraseDecisionSubject,
  mayRestoreDecisionReference, placeDecisionLifecycleHold, releaseDecisionLifecycleHold, validateDecisionLifecyclePolicy,
  type DecisionLifecycleHold, type DecisionLifecyclePolicy, type DecisionLifecycleReference, type DecisionLifecycleTombstone,
} from '../../../src/decision/lifecycle.js';

const policy = (): DecisionLifecyclePolicy => ({
  version: DECISION_LIFECYCLE_VERSION,
  surfaces: Object.fromEntries(DECISION_LIFECYCLE_SURFACES.map(surface => [surface, {
    classification: 'confidential', accessScopes: ['case-worker'], retentionMs: 100,
    export: 'denied', deletion: 'erase', backup: 'expire-with-primary',
  }])) as DecisionLifecyclePolicy['surfaces'],
});
const reference = (surface: DecisionLifecycleReference['surface']): DecisionLifecycleReference => ({ surface, opaqueId: `${surface}-opaque` });

function fixture(links: DecisionLifecycleReference[] = DECISION_LIFECYCLE_SURFACES.map(reference)) {
  const tombstones: DecisionLifecycleTombstone[] = [];
  const erased: DecisionLifecycleReference[] = [];
  let holds: DecisionLifecycleHold[] = [];
  return {
    tombstones, erased, setHolds: (value: DecisionLifecycleHold[]) => { holds = value; },
    store: {
      erase: vi.fn(async (ref: DecisionLifecycleReference) => { erased.push(ref); }),
      tombstone: vi.fn(async (value: DecisionLifecycleTombstone) => { tombstones.push(value); }),
      links: vi.fn(async () => links), holds: vi.fn(async () => holds),
      recordHold: vi.fn(async (hold: DecisionLifecycleHold) => { holds.push(hold); }),
      releaseHold: vi.fn(async (hold: DecisionLifecycleHold) => { holds = holds.filter(item => item !== hold && item.subject !== hold.subject); }),
    },
  };
}

describe('common decision lifecycle', () => {
  it.each(DECISION_LIFECYCLE_SURFACES)('denies incomplete metadata for %s', surface => {
    const value = policy();
    delete (value.surfaces as Partial<DecisionLifecyclePolicy['surfaces']>)[surface];
    expect(() => validateDecisionLifecyclePolicy(value)).toThrow(/incomplete/);
    const missing = policy(); missing.surfaces[surface].accessScopes = [];
    expect(() => validateDecisionLifecyclePolicy(missing)).toThrow(/incomplete/);
  });

  it('tombstones every linked surface before erasure and denies backup resurrection', async () => {
    const f = fixture();
    const deleted = await eraseDecisionSubject('case-7', policy(), f.store, 200);
    expect(deleted).toHaveLength(DECISION_LIFECYCLE_SURFACES.length);
    expect(f.erased).toHaveLength(DECISION_LIFECYCLE_SURFACES.length);
    for (const surface of DECISION_LIFECYCLE_SURFACES) {
      const ref = reference(surface);
      expect(mayRestoreDecisionReference(ref, 150, 201, policy(), deleted)).toBe(false);
      expect(mayRestoreDecisionReference({ ...ref, opaqueId: 'other' }, 150, 201, policy(), deleted)).toBe(true);
      expect(mayRestoreDecisionReference({ ...ref, opaqueId: 'other' }, 100, 201, policy(), deleted)).toBe(false);
    }
    expect(f.store.tombstone.mock.invocationCallOrder.every((call, i) => call < f.store.erase.mock.invocationCallOrder[i]!)).toBe(true);
  });

  it('requires authorized scoped hold and blocks deletion until release or expiry', async () => {
    const f = fixture([reference('state'), reference('review')]);
    const hold: DecisionLifecycleHold = { subject: 'case-7', reason: 'incident review', scope: ['review'],
      expiresAt: 300, authorizedBy: 'privacy-owner' };
    await expect(placeDecisionLifecycleHold(hold, async () => false, f.store, 200)).rejects.toThrow(/denied/);
    expect(f.store.recordHold).not.toHaveBeenCalled();
    const placed = await placeDecisionLifecycleHold(hold, async () => true, f.store, 200);
    expect(f.store.recordHold).toHaveBeenCalledWith(placed);
    await expect(eraseDecisionSubject('case-7', policy(), f.store, 250)).rejects.toThrow(/hold/);
    expect(f.erased).toHaveLength(0);
    expect(f.tombstones).toHaveLength(0);
    await expect(releaseDecisionLifecycleHold(placed, 'operator', 'released', async () => false, f.store, 250))
      .rejects.toThrow(/denied/);
    await releaseDecisionLifecycleHold(placed, 'operator', 'released after review', async () => true, f.store, 250);
    expect(f.store.releaseHold).toHaveBeenCalledWith(placed, 'operator', 'released after review', 250);
    expect(await eraseDecisionSubject('case-7', policy(), f.store, 250)).toHaveLength(2);
    const expired = fixture([reference('review')]); expired.setHolds([placed]);
    expect(await eraseDecisionSubject('case-7', policy(), expired.store, 300)).toHaveLength(1);
  });

  it('rejects unknown surfaces and failed erasure without returning content', async () => {
    const f = fixture([{ surface: 'unknown' as 'state', opaqueId: 'x' }]);
    await expect(eraseDecisionSubject('case-7', policy(), f.store, 200)).rejects.toThrow(/reference invalid/);
    expect(f.store.erase).not.toHaveBeenCalled();
    const fail = fixture([reference('debug-sidecar')]);
    fail.store.erase.mockRejectedValueOnce(new Error('synthetic-sensitive-canary'));
    await expect(eraseDecisionSubject('case-7', policy(), fail.store, 200)).rejects.toThrow('Decision lifecycle erasure failed');
    expect(fail.tombstones).toHaveLength(1);
  });
});
