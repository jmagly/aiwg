import { describe, expect, it } from 'vitest';
import { DECISION_RELEASE_GATES, evaluateQualification } from '../../../src/decision/qualification/gates.js';
import { GATE_ARTIFACT_SCHEMAS } from '../../../src/decision/qualification/gate-evidence.js';
import type { QualificationCase, QualificationRunManifest } from '../../../src/decision/qualification/types.js';
import { syntheticCases } from './qualification-gate-fixtures.js';

const oneCase: QualificationCase = { id: 'C01', kind: 'baseline', mandatory: true, candidateTests: [] };
const base: QualificationRunManifest = {
  schemaVersion: 'decision-qualification-run/v1', mode: 'offline', runId: 'unit', generatedAt: '2026-09-22T00:00:00.000Z',
  sourceCommit: 'abc', dirty: false, cases: [oneCase], evidence: [], evidenceFlags: {},
};
const allFlags = () => Object.fromEntries(DECISION_RELEASE_GATES.flatMap(gate => gate.requiredEvidence).map(key => [key, true]));
const gateArtifacts = Object.fromEntries(Object.entries(GATE_ARTIFACT_SCHEMAS).map(([flag, schemaVersion]) => [flag,
  { artifact: `unit/gates/${flag}.json`, digest: `sha256:${'b'.repeat(64)}` as const, schemaVersion }]));
function complete() {
  const cases = syntheticCases();
  const evidence = cases.map(({ id, evidenceIds }) => ({
    caseId: id, executable: true, outcome: 'pass' as const, artifact: `${id}.json`, digest: `sha256:${'a'.repeat(64)}` as const,
    testEvidenceIds: [...(evidenceIds ?? [])],
  }));
  return { cases, evidence };
}

describe('decision qualification gate evaluator', () => {
  it('requires a real artifact and digest for an executable passing case', () => {
    const report = evaluateQualification({ ...base, evidence: [{ caseId: 'C01', executable: true, outcome: 'pass', artifact: null, digest: null }] });
    expect(report.gates[0]).toMatchObject({ status: 'fail' });
    expect(report.gates[0]?.missing).toContain('case:C01');
    expect(report.decision).toBe('HOLD');
  });

  it('promotes only when every mandatory gate has complete passing evidence', () => {
    const { cases, evidence } = complete();
    const report = evaluateQualification({ ...base, cases, evidenceFlags: { 'privacy-scan-clean': true }, evidence, gateArtifacts },
      undefined, { artifactsVerified: true });
    expect(report.gates.every(gate => gate.status === 'pass')).toBe(true);
    expect(report.decision).toBe('PROMOTE');
  });

  it('GATE-DERIVED-03 ignores caller-set derived flags and requires recorded suites, artifacts and a verification proof', () => {
    const report = evaluateQualification({ ...base, evidenceFlags: allFlags() });
    for (const gate of report.gates) expect(gate.status).toBe('fail');
    expect(report.gates.find(gate => gate.id === 'G1')?.missing).toEqual(['evidence:runtime-suite-complete']);
    expect(report.gates.find(gate => gate.id === 'G2')?.missing).toEqual(['evidence:security-suite-complete']);
    expect(report.gates.find(gate => gate.id === 'G4')?.missing).toEqual(['evidence:drift-suite-complete', 'evidence:fault-suite-complete']);
    expect(report.gates.find(gate => gate.id === 'G5')?.missing).toEqual(['evidence:load-manifest-qualified']);
    const { cases, evidence } = complete();
    const unproven = evaluateQualification({ ...base, cases, evidence, gateArtifacts, evidenceFlags: allFlags() });
    expect(unproven.gates.find(gate => gate.id === 'G6')?.missing).toEqual(['evidence:evidence-hashes-verified']);
    const noDrift = evaluateQualification({ ...base, cases, gateArtifacts, evidenceFlags: allFlags(),
      evidence: evidence.map(item => item.caseId === 'TV10' ? { ...item, testEvidenceIds: [] } : item) }, undefined, { artifactsVerified: true });
    expect(noDrift.gates.find(gate => gate.id === 'G4')?.missing).toEqual(['evidence:drift-suite-complete']);
  });

  it.each([
    ['privacy-denied', 'G2'],
    ['execution-uncertain', 'G1'],
    ['calibration-data-missing', 'G3'],
    ['p0-correctness-failed', 'G1'],
  ])('does not waive %s with positive checks', (finding, affectedGate) => {
    const { cases, evidence } = complete();
    const evidenceFlags = allFlags();
    evidenceFlags[finding] = true;
    const report = evaluateQualification({ ...base, cases, evidence, evidenceFlags, gateArtifacts }, undefined, { artifactsVerified: true });
    expect(report.decision).toBe('HOLD');
    expect(report.gates.find(gate => gate.id === affectedGate)).toMatchObject({ status: 'fail', failed: [`finding:${finding}`] });
    expect(report.gates.find(gate => gate.id === 'G6')?.failed).toContain(`finding:${finding}`);
  });

  it('rejects duplicate and invented evidence even if the last duplicate passes', () => {
    const { cases, evidence } = complete();
    const report = evaluateQualification({ ...base, cases, evidenceFlags: allFlags(), gateArtifacts, evidence: [
      { ...evidence[0]!, outcome: 'fail' }, ...evidence, { ...evidence[0]!, caseId: 'C99' },
    ] });
    expect(report.decision).toBe('HOLD');
    expect(report.gates[0]).toMatchObject({ status: 'fail', failed: ['duplicate-evidence:C01', 'unknown-evidence:C99'] });
  });

  it('preserves deterministic sorted diagnostics', () => {
    const report = evaluateQualification({ ...base, cases: [
      { ...oneCase, id: 'C02' }, oneCase,
    ] });
    expect(report.gates[0]?.missing.slice(0, 2)).toEqual(['case:C01', 'case:C02']);
  });
});
