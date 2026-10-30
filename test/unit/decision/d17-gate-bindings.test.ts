import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { integrityVariants, syntheticIntegrity } from './integrity-ceiling-fixtures.js';
import { d17CaseNames, d17GateFixture } from './d17-gate-fixtures.js';
import { d17Statistics } from '../../../src/decision/ensemble-study/statistics.js';
import { D17_ANALYSIS, validateD17Analysis } from '../../../src/decision/ensemble-study/protocol.js';
import { d17GateBinding, d17GateFindings, d17GateInput, d17StudyDecision,
  evaluateD17Statistics } from '../../../src/decision/ensemble-study/gates.js';
import { D17_PACK_ID } from '../../../src/decision/ensemble-study/gate-policy.js';
import { validateD17Artifact } from '../../../src/decision/ensemble-study/artifacts.js';
import { heldoutDigest } from '../../../src/decision/heldout/contract.js';
import { qualifyGateParameter } from '../../../src/gates/types.js';
import { evaluateGates } from '../../../src/gates/evaluate.js';
import type { QualificationIntegrityMetadata } from '../../../src/decision/qualification/release.js';
import { canonicalJson } from '../../../src/security/artifact-trust.js';

const golden = JSON.parse(readFileSync(new URL('../../fixtures/decision/ensemble/d17-gate-parity.v1.json', import.meta.url), 'utf8'));
const integrity = (decision: 'PROMOTE' | 'HOLD' | 'ROLLBACK' = 'PROMOTE', compromised = false) => syntheticIntegrity({
  release_gate: { decision, reasons: [] }, compromise_labels: compromised ? ['scorer_edit'] : [],
} as unknown as QualificationIntegrityMetadata);

describe('D17 gate binding migration', () => {
  it('preserves frozen protocol bytes and covers each retained statistical fixture', () => {
    expect(canonicalJson(D17_ANALYSIS)).toBe(canonicalJson(golden.protocol));
    expect(golden.cases.map((row: { name: string }) => row.name)).toEqual(d17CaseNames);
  });

  it.each(d17CaseNames)('reproduces the complete historical statistics and verdict for %s', name => {
    const expected = golden.cases.find((row: { name: string }) => row.name === name);
    const { pairs, ids } = d17GateFixture(name);
    const statistics = d17Statistics(pairs, ids);
    expect(heldoutDigest(statistics)).toBe(expected.statisticsDigest);
    expect('sha256:' + createHash('sha256').update(JSON.stringify(statistics)).digest('hex')).toBe(expected.serializationDigest);
    const report = evaluateD17Statistics(statistics);
    expect(d17GateFindings(report)).toEqual({ findings: expected.findings,
      statisticalGate: expected.statisticalGate, benefitSupported: expected.benefitSupported });
    expect(d17StudyDecision(report, integrity())).toBe(expected.decision);
  });

  it('uses binding threshold mutations in the statistics path while keeping the outcome diagnostic', () => {
    const { pairs, ids } = d17GateFixture('p95');
    const before = d17Statistics(pairs, ids);
    expect(before.statisticalGate).toBe('HOLD');
    const binding = d17GateBinding();
    binding.spec.parameters[qualifyGateParameter(D17_PACK_ID, 'maximumP95LatencyIncreaseMs')] = 15001;
    binding.spec.ceiling = 'PROMOTE';
    const after = d17Statistics(pairs, ids, D17_ANALYSIS, binding);
    expect(after.statisticalGate).toBe('pass');
    expect(after.findings).toEqual([]);
    expect(d17StudyDecision(evaluateD17Statistics(after, binding), integrity())).toBe('HOLD');
  });

  it('enforces its own never-PROMOTE ceiling even when all gates and the binding permit promotion', () => {
    const { pairs, ids } = d17GateFixture('benefit');
    const binding = d17GateBinding(); binding.spec.ceiling = 'PROMOTE';
    const report = evaluateD17Statistics(d17Statistics(pairs, ids), binding, integrity());
    expect(report.decision).toBe('PROMOTE'); // The raw evaluator supplies no diagnostic safeguard.
    expect(d17StudyDecision(report, integrity('PROMOTE'))).toBe('HOLD');
  });

  it.each(['PROMOTE', 'HOLD', 'ROLLBACK'] as const)('retains integrity ceilings with an upstream %s', upstream => {
    const { pairs, ids } = d17GateFixture('benefit');
    const report = evaluateD17Statistics(d17Statistics(pairs, ids));
    expect(d17StudyDecision(report, integrity(upstream))).toBe(upstream === 'ROLLBACK' ? 'ROLLBACK' : 'HOLD');
    expect(d17StudyDecision(report, integrity(upstream, true))).toBe('ROLLBACK');
    const binding = d17GateBinding(); binding.spec.ceiling = 'ROLLBACK';
    expect(d17StudyDecision(evaluateD17Statistics(d17Statistics(pairs, ids), binding), integrity(upstream))).toBe('ROLLBACK');
  });

  it.each(integrityVariants)('preserves the original study integrity policy for $name', variant => {
    const { pairs, ids } = d17GateFixture('benefit');
    const metadata = syntheticIntegrity(variant.patch);
    const report = evaluateD17Statistics(d17Statistics(pairs, ids), undefined, metadata);
    const expected = metadata.compromise_labels.length ? 'ROLLBACK' : 'HOLD';
    expect(d17StudyDecision(report, metadata)).toBe(expected);
  });

  it('lets the shipped evaluator reject changed bindings without new pins and seals', () => {
    const { pairs, ids } = d17GateFixture('unchanged');
    const context = d17GateInput(d17Statistics(pairs, ids));
    context.binding.spec.parameters[qualifyGateParameter(D17_PACK_ID, 'maximumP95LatencyIncreaseMs')] = 1;
    expect(() => evaluateGates(context)).toThrow('trusted pin');
  });

  it.each([
    ['quality', -0.03, false], ['quality', -0.030000000000000002, true],
    ['calibration', 0.02, false], ['calibration', 0.020000000000000004, true],
  ] as const)('retains the exact native %s comparison at %s', (metric, delta, failed) => {
    const { pairs, ids } = d17GateFixture('unchanged');
    const measurements = d17Statistics(pairs, ids);
    measurements.pairedDeltas.find(row => row.metric === metric)!.delta = delta;
    const findings = d17GateFindings(evaluateD17Statistics(measurements)).findings;
    expect(findings.includes(`paired-delta-failed:${metric}`)).toBe(failed);
  });

  it('governs protocol shape in the schema and rejects changed frozen thresholds at runtime', () => {
    const schema = JSON.parse(readFileSync(new URL('../../../schemas/decision/D17StudyProtocol.v1.schema.json', import.meta.url), 'utf8'));
    const validator = new Ajv2020({ strict: true }).compile(schema);
    expect(validator(golden.protocol)).toBe(true);
    expect(validator({ ...golden.protocol, minimumPairs: '1200' })).toBe(false);
    expect(validator({ ...golden.protocol, extra: true })).toBe(false);
    const changed = { ...golden.protocol, minimumPairs: 1199 };
    expect(validator(changed)).toBe(true); // Policy values are owned by the binding, not duplicated schema consts.
    expect(() => validateD17Analysis(changed)).toThrow('frozen');
    const analysis = { schemaVersion: 'decision-d17-analysis/v1', protocol: changed,
      sourceDigests: { 'fixture.ts': heldoutDigest('fixture') }, splitManifestDigest: heldoutDigest('splits'),
      nativeTemplatesDigest: heldoutDigest('native') };
    expect(() => validateD17Artifact('analysis', analysis)).toThrow('frozen');
    expect(() => validateD17Artifact('analysis', { ...analysis, protocol: golden.protocol })).not.toThrow();
  });

  it('does not let mutation of the exported projection redefine the frozen protocol', () => {
    const original = D17_ANALYSIS.minimumPairs;
    try {
      Object.assign(D17_ANALYSIS, { minimumPairs: original - 1 });
      expect(() => validateD17Analysis(D17_ANALYSIS)).toThrow('frozen');
      expect(() => validateD17Analysis(golden.protocol)).not.toThrow();
    } finally {
      Object.assign(D17_ANALYSIS, { minimumPairs: original });
    }
  });
});
