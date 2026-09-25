import { readFile } from 'node:fs/promises';
import {
  CalibrationRegistry, calibrationArtifactDigest, calibrationIdentityDigest, validateCalibrationGovernanceReceipt,
  type CalibrationArtifact, type CalibrationIdentity, type QualificationCaseExecutor,
} from '../../../../src/decision/index.js';

export const CASE_IDS = ['TV10'] as const;
export const CROSS_PRODUCT_FIXTURE = 'test/fixtures/decision/calibration-compatibility-cross-product-v1.json';

export const hash = (value: string) => `sha256:${value.repeat(64)}` as const;
export const policy = { unknown: 'defer', incompatible: 'fail', shadowRequired: 'shadow', unusableCalibration: 'require-approval' } as const;

export const identity: CalibrationIdentity = {
  provider: 'jev', backend: 'api', actualModel: 'jev-1.13.0', primitive: 'choice', definitionDigest: hash('a'), adapterVersion: 'prompt-v1',
  dataset: { id: 'workflow-held-out-v1', hash: hash('b') }, slice: { id: 'high-risk', hash: hash('c') },
  calibrator: { id: 'isotonic', version: '1', parametersDigest: hash('d') },
};
export function artifact(overrides: Partial<Omit<CalibrationArtifact, 'digest'>> = {}): CalibrationArtifact {
  const payload: Omit<CalibrationArtifact, 'digest'> = {
    schemaVersion: 'decision-calibration-artifact/v1', id: 'calibration:jev-1.13.0:fixture', identity,
    splitProvenance: { id: 'split-v1', hash: hash('e'), holdoutAccessedAt: '2026-09-22T11:00:00.000Z' },
    profile: { minimumTotalSamples: 100, minimumPerSliceSamples: 40, powerRule: null,
      confidenceInterval: { method: 'bootstrap-bca', level: 0.95 }, maximumCalibrationError: 0.08,
      maximumSelectiveRisk: 0.05, expiresAfterDays: 30 },
    metrics: { totalSamples: 200, perSliceSamples: 80, calibrationError: 0.04, selectiveRisk: 0.02,
      confidenceIntervals: { ece: { lower: 0.02, upper: 0.06 } } },
    effectiveAt: '2026-09-22T00:00:00.000Z', limitations: ['Synthetic fixture only; not product-quality evidence.'],
    approval: { state: 'approved', reference: 'approval:fixture-review-17' }, ...overrides,
  };
  return { ...payload, digest: calibrationArtifactDigest(payload) };
}

interface CrossProductFixture { dimensions: Array<{ evidenceId: string; path: string; replacement: string }> }
const crossProduct = async (): Promise<CrossProductFixture> =>
  JSON.parse(await readFile(CROSS_PRODUCT_FIXTURE, 'utf8')) as CrossProductFixture;

/** Named CAL/DRF evidence proven by the TV10 executor, derived from the checked-in dimension fixture. */
export async function calibrationEvidenceIds(): Promise<string[]> {
  const fixture = await crossProduct();
  return ['CAL-EXACT-01', ...fixture.dimensions.map(item => item.evidenceId), 'CAL-EXPIRY-01',
    'CAL-APPROVAL-01', 'CAL-SAMPLES-01', 'CAL-PROVENANCE-01', 'CAL-RAW-DERIVED-01',
    'DRF-ALIAS-01', 'DRF-SHADOW-01', 'DRF-ACTIVE-PIN-01', 'DRF-PROMOTE-01', 'DRF-ROLLBACK-01', 'DRF-RETIRE-01'];
}

export const executors: Record<(typeof CASE_IDS)[number], QualificationCaseExecutor> = {
  TV10: async () => {
    const fixture = await crossProduct();
    const registry = new CalibrationRegistry(); const calibrated = registry.registerArtifact(artifact());
    registry.observeAlias('jev-latest', identity, '2026-09-22T00:00:00.000Z');
    const exact = registry.resolve({ runId: 'exact', requestedAlias: 'jev-latest', actualIdentity: identity,
      calibrationArtifactId: calibrated.id, at: '2026-09-23T00:00:00.000Z' }, policy);
    if (exact.state !== 'exact' || exact.action !== 'allow') return { outcome: 'fail' as const };
    const envelope = registry.evidence(exact,
      { probability: 0.8, confidence: 0.7, distribution: { yes: 0.8, no: 0.2 }, provider: 'jev', actualModel: identity.actualModel },
      { value: 0.03, metric: 'calibrated-risk', calibrationArtifactId: calibrated.id,
        calibrationArtifactDigest: calibrated.digest, derivedAt: '2026-09-23T00:00:00.000Z' });
    if (envelope.raw.probability === envelope.calibrated?.value) return { outcome: 'fail' as const };
    for (const [index, dimension] of fixture.dimensions.entries()) {
      const mutationRegistry = new CalibrationRegistry();
      mutationRegistry.registerArtifact(calibrated);
      mutationRegistry.observeAlias('jev-latest', identity, '2026-09-22T00:00:00.000Z');
      const changed = structuredClone(identity) as unknown as Record<string, unknown>;
      const parts = dimension.path.split('.'); let cursor = changed;
      for (const part of parts.slice(0, -1)) cursor = cursor[part] as Record<string, unknown>;
      cursor[parts.at(-1)!] = dimension.replacement;
      const decision = mutationRegistry.resolve({ runId: `mutation-${index}`, requestedAlias: 'jev-latest',
        actualIdentity: changed as unknown as CalibrationIdentity, calibrationArtifactId: calibrated.id,
        at: '2026-09-23T00:00:00.000Z' }, policy);
      if (decision.state !== 'unknown' || decision.action !== 'defer') return { outcome: 'fail' as const };
    }
    for (const [name, altered, at, expectedReason] of [
      ['expiry', artifact(), '2026-10-23T00:00:00.000Z', 'calibration-expired'],
      ['approval', artifact({ approval: { state: 'observed', reference: null } }), '2026-09-23T00:00:00.000Z', 'calibration-observed'],
      ['samples', artifact({ metrics: { totalSamples: 20, perSliceSamples: 5, calibrationError: 0.04,
        selectiveRisk: 0.02, confidenceIntervals: { ece: { lower: 0.02, upper: 0.06 } } } }), '2026-09-23T00:00:00.000Z', 'insufficient-total-samples'],
    ] as const) {
      const evidenceRegistry = new CalibrationRegistry(); evidenceRegistry.registerArtifact(altered);
      const decision = evidenceRegistry.resolve({ runId: name, requestedAlias: 'jev-latest', actualIdentity: identity,
        calibrationArtifactId: altered.id, at }, policy);
      if (decision.action !== 'require-approval' || !decision.reasons.includes(expectedReason)) return { outcome: 'fail' as const };
    }
    const driftRegistry = new CalibrationRegistry(); driftRegistry.registerArtifact(calibrated);
    driftRegistry.observeAlias('jev-latest', identity, '2026-09-22T00:00:00.000Z');
    const next = { ...identity, actualModel: 'jev-1.14.0' };
    const pinned = driftRegistry.resolve({ runId: 'active', requestedAlias: 'jev-latest', actualIdentity: identity,
      calibrationArtifactId: calibrated.id, at: '2026-09-23T00:00:00.000Z' }, policy);
    driftRegistry.observeAlias('jev-latest', next, '2026-09-24T00:00:00.000Z');
    const stillPinned = driftRegistry.resolve({ runId: 'active', requestedAlias: 'jev-latest', actualIdentity: next,
      calibrationArtifactId: calibrated.id, at: '2026-09-24T00:00:00.000Z' }, policy);
    if (driftRegistry.driftEvents().length !== 1 || JSON.stringify(pinned) !== JSON.stringify(stillPinned)) return { outcome: 'fail' as const };
    const shadowRegistry = new CalibrationRegistry(); shadowRegistry.registerArtifact(calibrated);
    shadowRegistry.registerRelation({ id: 'shadow:fixture', fromIdentityDigest: calibrationIdentityDigest(identity),
      toIdentityDigest: calibrationIdentityDigest(next), state: 'shadow-required', evidenceReference: 'qualification:fixture',
      approvalReference: null, effectiveAt: '2026-09-23T00:00:00.000Z', expiresAt: null });
    const shadow = shadowRegistry.resolve({ runId: 'shadow', requestedAlias: 'jev-latest', actualIdentity: next,
      calibrationArtifactId: calibrated.id, at: '2026-09-24T00:00:00.000Z' }, policy);
    if (shadow.state !== 'shadow-required' || shadow.action !== 'shadow') return { outcome: 'fail' as const };
    const governance = new CalibrationRegistry(); const champion = governance.observeAlias('jev-latest', identity, '2026-09-22T00:00:00.000Z');
    governance.recordPromotionEligibility({ id: 'eligibility:fixture', alias: 'jev-latest',
      candidateIdentityDigest: calibrationIdentityDigest(next), candidateActualModel: next.actualModel,
      evaluationIntegrityReport: { id: 'qualification:fixture', digest: hash('9') }, approvalReference: 'approval:fixture',
      rollbackTarget: { aliasRevision: champion.revision, identityDigest: champion.actualIdentityDigest },
      eligible: true, reasons: [], recordedAt: '2026-09-24T00:00:00.000Z' });
    governance.promoteAlias('eligibility:fixture', '2026-09-25T00:00:00.000Z');
    governance.rollbackAlias('jev-latest', 1, 'approval:rollback', '2026-09-26T00:00:00.000Z');
    governance.retireAlias('jev-latest', 'approval:retire', '2026-09-27T00:00:00.000Z');
    if (governance.aliasHistory('jev-latest').map(event => event.kind).join(',') !== 'observed,promoted,rolled-back,retired') return { outcome: 'fail' as const };
    const promotion = JSON.parse(await readFile('docs/decision/evidence/calibration-governance-v1/000000000001.json', 'utf8'));
    const rollback = JSON.parse(await readFile('docs/decision/evidence/calibration-governance-v1/000000000002.json', 'utf8'));
    validateCalibrationGovernanceReceipt(promotion); validateCalibrationGovernanceReceipt(rollback);
    return { outcome: 'pass' as const, details: { requestedAlias: 'jev-latest', actualModel: 'jev-1.13.0',
      laterActualModel: 'jev-1.14.0', exactPin: exact.pinId, dimensions: fixture.dimensions.length } };
  },
};
