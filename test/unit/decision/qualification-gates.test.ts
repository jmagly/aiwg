import { describe, expect, it } from 'vitest';
import { DECISION_RELEASE_GATES, evaluateQualification } from '../../../src/decision/qualification/gates.js';
import { expectedQualificationCaseIds } from '../../../src/decision/qualification/manifest.js';
import type { QualificationCase, QualificationRunManifest } from '../../../src/decision/qualification/types.js';

const oneCase: QualificationCase = { id: 'C01', kind: 'baseline', mandatory: true, candidateTests: [] };
const base: QualificationRunManifest = {
  schemaVersion: 'decision-qualification-run/v1', mode: 'offline', runId: 'unit', generatedAt: '2026-09-22T00:00:00.000Z',
  sourceCommit: 'abc', dirty: false, cases: [oneCase], evidence: [], evidenceFlags: {},
};

describe('decision qualification gate evaluator', () => {
  it('requires a real artifact and digest for an executable passing case', () => {
    const report = evaluateQualification({ ...base, evidence: [{ caseId: 'C01', executable: true, outcome: 'pass', artifact: null, digest: null }] });
    expect(report.gates[0]).toMatchObject({ status: 'fail' });
    expect(report.gates[0]?.missing).toContain('case:C01');
    expect(report.decision).toBe('HOLD');
  });

  it('promotes only when every mandatory gate has complete passing evidence', () => {
    const evidenceFlags = Object.fromEntries(DECISION_RELEASE_GATES.flatMap(gate => gate.requiredEvidence).map(key => [key, true]));
    const cases = expectedQualificationCaseIds().map(id => ({ ...oneCase, id, kind: id.startsWith('TV') ? 'vendor' as const : 'baseline' as const }));
    const evidence = cases.map(({ id }) => ({
      caseId: id, executable: true, outcome: 'pass' as const, artifact: `${id}.json`, digest: `sha256:${'a'.repeat(64)}` as const,
    }));
    const report = evaluateQualification({ ...base, cases, evidenceFlags, evidence });
    expect(report.gates.every(gate => gate.status === 'pass')).toBe(true);
    expect(report.decision).toBe('PROMOTE');
  });

  it.each([
    ['privacy-denied', 'G2'],
    ['execution-uncertain', 'G1'],
    ['calibration-data-missing', 'G3'],
    ['p0-correctness-failed', 'G1'],
  ])('does not waive %s with positive checks', (finding, affectedGate) => {
    const cases = expectedQualificationCaseIds().map(id => ({ ...oneCase, id, kind: id.startsWith('TV') ? 'vendor' as const : 'baseline' as const }));
    const evidence = cases.map(({ id }) => ({
      caseId: id, executable: true, outcome: 'pass' as const, artifact: `${id}.json`, digest: `sha256:${'a'.repeat(64)}` as const,
    }));
    const evidenceFlags = Object.fromEntries(DECISION_RELEASE_GATES.flatMap(gate => gate.requiredEvidence).map(key => [key, true]));
    evidenceFlags[finding] = true;
    const report = evaluateQualification({ ...base, cases, evidence, evidenceFlags });
    expect(report.decision).toBe('HOLD');
    expect(report.gates.find(gate => gate.id === affectedGate)).toMatchObject({ status: 'fail', failed: [`finding:${finding}`] });
    expect(report.gates.find(gate => gate.id === 'G6')?.failed).toContain(`finding:${finding}`);
  });

  it('rejects duplicate and invented evidence even if the last duplicate passes', () => {
    const cases = expectedQualificationCaseIds().map(id => ({ ...oneCase, id, kind: id.startsWith('TV') ? 'vendor' as const : 'baseline' as const }));
    const evidence = cases.map(({ id }) => ({
      caseId: id, executable: true, outcome: 'pass' as const, artifact: `${id}.json`, digest: `sha256:${'a'.repeat(64)}` as const,
    }));
    const evidenceFlags = Object.fromEntries(DECISION_RELEASE_GATES.flatMap(gate => gate.requiredEvidence).map(key => [key, true]));
    const report = evaluateQualification({ ...base, cases, evidenceFlags, evidence: [
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
