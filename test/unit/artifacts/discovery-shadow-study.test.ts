import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertDiscoveryStudyRegistration, buildUnrunDiscoveryStudyReport, createDiscoveryStudyManifest,
  discoveryStudyDigest, DISCOVERY_STUDY_SLICES, validateDiscoveryStudyManifest, validateUnrunDiscoveryStudyReport,
  type DiscoveryStudyManifest } from '../../../src/artifacts/discovery-shadow-study.js';
import { syntheticIntegrity } from '../decision/integrity-ceiling-fixtures.js';
const hash = (c: string) => `sha256:${c.repeat(64)}` as const;
function input(): Omit<DiscoveryStudyManifest, 'schemaVersion' | 'digest'> {
  return JSON.parse(readFileSync(new URL('../../fixtures/decision/discovery-study-manifest.json', import.meta.url), 'utf8'));
}
const reseal = <T extends { digest: string }>(value: T): T => {
  const { digest: _digest, ...fields } = value;
  return { ...fields, digest: discoveryStudyDigest(fields) } as T;
};
describe('D27 offline study contracts', () => {
  it('pins all six slices and meaningful benefit/economics without asserting preregistration', () => {
    const m = createDiscoveryStudyManifest(input());
    expect(validateDiscoveryStudyManifest(m)).toBe(m);
    expect(() => assertDiscoveryStudyRegistration(m, m.digest, '2026-11-25T12:00:00Z')).toThrow();
    expect(m.thresholds.historicalBaseline).toEqual({ hitAt3: 1, mrr: .9875 });
  });
  it.each(['split', 'benefit', 'economics', 'slice', 'ci', 'version', 'unknown-field', 'state', 'digest'] as const)('rejects invalid %s manifest', kind => {
    const m = createDiscoveryStudyManifest(input());
    if (kind === 'split') m.dataset.holdout = m.dataset.tuning;
    if (kind === 'benefit') m.thresholds.minimumAmbiguityImprovement = 0;
    if (kind === 'economics') m.thresholds.minimumCostSavingsUsd = 0;
    if (kind === 'slice') delete (m.thresholds.minimumPerSlice as Partial<typeof m.thresholds.minimumPerSlice>)['no-match'];
    if (kind === 'ci') { m.thresholds.confidenceInterval.resamples = 200; m.thresholds.confidenceInterval.level = .99; }
    if (kind === 'version') (m as unknown as Record<string, unknown>).schemaVersion = 'other';
    if (kind === 'unknown-field') (m as unknown as Record<string, unknown>).authorize = true;
    if (kind === 'state') m.state = 'registered';
    expect(() => validateDiscoveryStudyManifest(kind === 'digest' ? { ...m, digest: hash('f') } : reseal(m))).toThrow();
  });
  it('requires an independently anchored digest and strictly earlier registration', () => {
    const m = createDiscoveryStudyManifest({ ...input(), state: 'registered', registeredAt: '2026-11-25T00:00:00Z' });
    expect(() => assertDiscoveryStudyRegistration(m, m.digest, '2026-11-25T01:00:00Z')).not.toThrow();
    for (const time of ['invalid', '2026-11-24T23:00:00Z', m.registeredAt!]) {
      expect(() => assertDiscoveryStudyRegistration(m, m.digest, time)).toThrow();
    }
    expect(() => assertDiscoveryStudyRegistration(m, hash('f'), '2026-11-25T01:00:00Z')).toThrow();
  });
  it.each(['PROMOTE', 'HOLD', 'ROLLBACK'] as const)('preserves the upstream %s ceiling without fabricating observations', upstream => {
    const report = buildUnrunDiscoveryStudyReport(createDiscoveryStudyManifest(input()), syntheticIntegrity({ release_gate: { decision: upstream, reasons: ['fixture'] } }));
    expect(report.decision).toBe(upstream === 'ROLLBACK' ? 'ROLLBACK' : 'HOLD');
    expect(report.upstreamDecision).toBe(upstream);
    expect(report.integrity!.release_gate.reasons).toEqual(['fixture']);
    expect(report.slices.map(s => s.id)).toEqual(DISCOVERY_STUDY_SLICES);
    expect(report.slices.every(s => s.sampleCount === 0 && Object.values(s.alternate).every(v => v === null))).toBe(true);
    expect(report.economics.totalCostSavingsUsd).toBeNull();
    expect(report.holdoutAccessedAt).toBeNull();
    expect(validateUnrunDiscoveryStudyReport(report)).toBe(report);
    expect(() => validateUnrunDiscoveryStudyReport(reseal({ ...report, decision: 'PROMOTE' }))).toThrow();
  });
  it('holds with absent integrity and preserves compromised rollback', () => {
    const m = createDiscoveryStudyManifest(input());
    expect(buildUnrunDiscoveryStudyReport(m).decision).toBe('HOLD');
    expect(buildUnrunDiscoveryStudyReport(m, syntheticIntegrity({ integrity_state: 'compromised' })).decision).toBe('ROLLBACK');
  });
  it.each(['metrics', 'slices', 'pricing', 'decision', 'digest'] as const)('rejects resealed report tampering: %s', kind => {
    const r = buildUnrunDiscoveryStudyReport(createDiscoveryStudyManifest(input()));
    if (kind === 'metrics') (r.metrics.alternate as unknown as Record<string, unknown>).mrr = 1;
    if (kind === 'slices') r.slices[1]!.id = r.slices[0]!.id;
    if (kind === 'pricing') r.economics.pricingDigest = hash('f');
    if (kind === 'decision') r.upstreamDecision = 'PROMOTE';
    expect(() => validateUnrunDiscoveryStudyReport(kind === 'digest' ? { ...r, digest: hash('f') } : reseal(r))).toThrow();
  });
});
