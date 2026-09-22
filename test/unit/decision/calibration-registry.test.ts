import { describe, expect, it } from 'vitest';
import {
  CalibrationRegistry, CalibrationRegistryError, calibrationArtifactDigest, calibrationIdentityDigest,
  type CalibrationArtifact, type CalibrationIdentity, type CalibrationProfile, type CompatibilityPolicy,
} from '../../../src/decision/calibration/index.js';

const hash = (character: string) => `sha256:${character.repeat(64)}` as const;
const identity = (overrides: Partial<CalibrationIdentity> = {}): CalibrationIdentity => ({
  provider: 'jev', backend: 'api', actualModel: 'jev-2026-09-01', primitive: 'choice', definitionDigest: hash('a'), adapterVersion: 'prompt-v1',
  dataset: { id: 'workflow', hash: hash('b') }, slice: { id: 'high-risk', hash: hash('c') },
  calibrator: { id: 'isotonic', version: '1', parametersDigest: hash('d') }, ...overrides,
});
const profile: CalibrationProfile = {
  minimumTotalSamples: 100, minimumPerSliceSamples: 40, powerRule: null,
  confidenceInterval: { method: 'bootstrap-bca', level: 0.95 }, maximumCalibrationError: 0.08,
  maximumSelectiveRisk: 0.05, expiresAfterDays: 30,
};
const artifact = (target = identity(), overrides: Partial<Omit<CalibrationArtifact, 'digest'>> = {}): CalibrationArtifact => {
  const payload: Omit<CalibrationArtifact, 'digest'> = {
    schemaVersion: 'decision-calibration-artifact/v1', id: 'cal-1', identity: target,
    splitProvenance: { id: 'split-1', hash: hash('e'), holdoutAccessedAt: '2026-09-02T00:00:00.000Z' }, profile,
    metrics: { totalSamples: 200, perSliceSamples: 80, calibrationError: 0.04, selectiveRisk: 0.02,
      confidenceIntervals: { ece: { lower: 0.02, upper: 0.06 } } }, effectiveAt: '2026-09-01T00:00:00.000Z',
    limitations: ['Synthetic registry fixture; not evidence for production automation.'],
    approval: { state: 'approved', reference: 'review-17' }, ...overrides,
  };
  return { ...payload, digest: calibrationArtifactDigest(payload) };
};
const policy: CompatibilityPolicy = { unknown: 'defer', incompatible: 'fail', shadowRequired: 'shadow', unusableCalibration: 'require-approval' };
const request = (runId: string, actualIdentity = identity(), at = '2026-09-10T00:00:00.000Z') => ({
  runId, requestedAlias: 'jev-latest', actualIdentity, calibrationArtifactId: 'cal-1', at,
});

describe('calibration compatibility registry', () => {
  it('allows exact compatibility only across the complete evidence identity', () => {
    const registry = new CalibrationRegistry(); registry.registerArtifact(artifact()); registry.observeAlias('jev-latest', identity(), '2026-09-01T00:00:00.000Z');
    expect(registry.resolve(request('exact'), policy)).toMatchObject({ state: 'exact', action: 'allow', artifactId: 'cal-1', actualModel: 'jev-2026-09-01' });
    const mutations: CalibrationIdentity[] = [
      identity({ provider: 'other' }), identity({ backend: 'batch' }), identity({ actualModel: 'jev-2' }), identity({ primitive: 'ordinal-score' }),
      identity({ definitionDigest: hash('f') }), identity({ adapterVersion: 'prompt-v2' }),
      identity({ dataset: { id: 'other', hash: hash('b') } }), identity({ dataset: { id: 'workflow', hash: hash('f') } }),
      identity({ slice: { id: 'other', hash: hash('c') } }), identity({ slice: { id: 'high-risk', hash: hash('f') } }),
      identity({ calibrator: { id: 'platt', version: '1', parametersDigest: hash('d') } }),
      identity({ calibrator: { id: 'isotonic', version: '2', parametersDigest: hash('d') } }),
      identity({ calibrator: { id: 'isotonic', version: '1', parametersDigest: hash('f') } }),
    ];
    for (const [index, changed] of mutations.entries()) {
      const decision = registry.resolve(request(`mutated-${index}`, changed), policy);
      expect(decision.state).toBe('unknown'); expect(decision.action).not.toBe('allow');
    }
  });

  it('requires immutable reviewed relations for compatible, shadow, and incompatible states', () => {
    const registry = new CalibrationRegistry(); const source = identity(); const approved = identity({ actualModel: 'jev-approved' });
    const shadow = identity({ actualModel: 'jev-shadow' }); const incompatible = identity({ actualModel: 'jev-incompatible' });
    registry.registerArtifact(artifact(source));
    registry.registerRelation({ id: 'relation-1', fromIdentityDigest: calibrationIdentityDigest(source), toIdentityDigest: calibrationIdentityDigest(approved),
      state: 'approved-compatible', evidenceReference: 'eval-report-2', approvalReference: 'review-22', effectiveAt: '2026-09-05T00:00:00.000Z', expiresAt: null });
    registry.registerRelation({ id: 'relation-2', fromIdentityDigest: calibrationIdentityDigest(source), toIdentityDigest: calibrationIdentityDigest(shadow),
      state: 'shadow-required', evidenceReference: 'eval-report-3', approvalReference: null, effectiveAt: '2026-09-05T00:00:00.000Z', expiresAt: null });
    registry.registerRelation({ id: 'relation-3', fromIdentityDigest: calibrationIdentityDigest(source), toIdentityDigest: calibrationIdentityDigest(incompatible),
      state: 'incompatible', evidenceReference: 'eval-report-4', approvalReference: null, effectiveAt: '2026-09-05T00:00:00.000Z', expiresAt: null });
    expect(registry.resolve(request('approved', approved), policy)).toMatchObject({ state: 'approved-compatible', action: 'allow' });
    expect(registry.resolve(request('shadow', shadow), policy)).toMatchObject({ state: 'shadow-required', action: 'shadow' });
    expect(registry.resolve(request('incompatible', incompatible), policy)).toMatchObject({ state: 'incompatible', action: 'fail' });
    expect(() => registry.registerRelation({ id: 'bad', fromIdentityDigest: hash('1'), toIdentityDigest: hash('2'), state: 'approved-compatible',
      evidenceReference: 'eval', approvalReference: null, effectiveAt: '2026-09-01T00:00:00.000Z', expiresAt: null })).toThrow(CalibrationRegistryError);
  });

  it('emits drift before reuse and pins an active run across alias changes', () => {
    const registry = new CalibrationRegistry(); registry.registerArtifact(artifact()); registry.observeAlias('jev-latest', identity(), '2026-09-01T00:00:00.000Z');
    const pinned = registry.resolve(request('active-run'), policy);
    const moved = identity({ actualModel: 'jev-2026-10-01' }); registry.observeAlias('jev-latest', moved, '2026-09-11T00:00:00.000Z');
    expect(registry.driftEvents('jev-latest')).toHaveLength(1);
    expect(registry.resolve(request('active-run', moved, '2026-09-12T00:00:00.000Z'), policy)).toEqual(pinned);
    expect(registry.resolve(request('new-run', moved, '2026-09-12T00:00:00.000Z'), policy)).toMatchObject({ state: 'unknown', action: 'defer' });
  });

  it('routes missing, expired, unapproved, and insufficient evidence deterministically', () => {
    const cases: Array<[string, Partial<Omit<CalibrationArtifact, 'digest'>>, string]> = [
      ['expired', {}, '2026-10-02T00:00:00.000Z'],
      ['unapproved', { approval: { state: 'observed', reference: null } }, '2026-09-10T00:00:00.000Z'],
      ['insufficient', { metrics: { totalSamples: 10, perSliceSamples: 5, calibrationError: 0.04, selectiveRisk: 0.02, confidenceIntervals: {} } }, '2026-09-10T00:00:00.000Z'],
    ];
    for (const [name, overrides, at] of cases) {
      const registry = new CalibrationRegistry(); registry.registerArtifact(artifact(identity(), overrides));
      const decision = registry.resolve(request(name, identity(), at), policy);
      expect(decision.action).toBe('require-approval'); expect(decision.reasons.length).toBeGreaterThan(0);
    }
    const registry = new CalibrationRegistry();
    expect(registry.resolve({ ...request('missing'), calibrationArtifactId: undefined }, policy)).toMatchObject({ action: 'require-approval', reasons: ['calibration-missing'] });
  });

  it('retains promotion/rollback/retirement history and rejects ineligible movement', () => {
    const registry = new CalibrationRegistry(); const champion = identity(); const candidate = identity({ actualModel: 'jev-next' });
    const initial = registry.observeAlias('jev-latest', champion, '2026-09-01T00:00:00.000Z');
    const eligible = registry.recordPromotionEligibility({ id: 'promotion-1', alias: 'jev-latest', candidateIdentityDigest: calibrationIdentityDigest(candidate), candidateActualModel: candidate.actualModel,
      evaluationIntegrityReport: { id: 'eval-1', digest: hash('9') }, approvalReference: 'approval-1',
      rollbackTarget: { aliasRevision: initial.revision, identityDigest: initial.actualIdentityDigest }, eligible: true, reasons: [], recordedAt: '2026-09-10T00:00:00.000Z' });
    registry.promoteAlias(eligible.id, '2026-09-11T00:00:00.000Z');
    registry.rollbackAlias('jev-latest', 1, 'approval-2', '2026-09-12T00:00:00.000Z');
    registry.retireAlias('jev-latest', 'approval-3', '2026-09-13T00:00:00.000Z');
    expect(registry.aliasHistory('jev-latest').map(event => event.kind)).toEqual(['observed', 'promoted', 'rolled-back', 'retired']);
    const denied = registry.recordPromotionEligibility({ ...eligible, id: 'denied', eligible: false, reasons: ['insufficient evidence'] });
    expect(registry.promotionHistory()).toEqual([eligible, denied]);
    expect(() => registry.promoteAlias(denied.id, '2026-09-14T00:00:00.000Z')).toThrow(CalibrationRegistryError);
  });

  it('keeps raw and calibrated evidence side-by-side with distinct provenance', () => {
    const registry = new CalibrationRegistry(); const calibration = registry.registerArtifact(artifact()); const pin = registry.resolve(request('evidence'), policy);
    const raw = { probability: 0.81, confidence: 0.7, distribution: { yes: 0.81, no: 0.19 }, provider: 'jev', actualModel: identity().actualModel };
    const derived = { value: 0.12, metric: 'calibrated-risk', calibrationArtifactId: calibration.id, calibrationArtifactDigest: calibration.digest, derivedAt: '2026-09-10T00:00:00.000Z' };
    const envelope = registry.evidence(pin, raw, derived);
    expect(envelope.raw).toEqual(raw); expect(envelope.calibrated).toEqual(derived); expect(envelope.raw.probability).not.toBe(envelope.calibrated?.value);
    expect(() => registry.evidence(pin, raw, { ...derived, calibrationArtifactId: 'other' })).toThrow(CalibrationRegistryError);
  });

  it('rejects post-hoc profiles and altered immutable artifact content', () => {
    const registry = new CalibrationRegistry(); const original = artifact(); registry.registerArtifact(original);
    expect(() => registry.registerArtifact({ ...original, limitations: ['changed after registration'] })).toThrow(CalibrationRegistryError);
    expect(() => registry.registerArtifact(artifact(identity(), { id: 'post-hoc', effectiveAt: '2026-09-03T00:00:00.000Z' }))).toThrow('preregistered');
  });
});
