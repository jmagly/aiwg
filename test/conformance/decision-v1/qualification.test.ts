import { describe, expect, it } from 'vitest';
import { evaluateQualification } from '../../../src/decision/qualification/gates.js';
import { expectedQualificationCaseIds, stableManifestDigest, validateCaseInventory } from '../../../src/decision/qualification/manifest.js';
import type { QualificationEvidence, QualificationRunManifest } from '../../../src/decision/qualification/types.js';
import { DECISION_CASE_COVERAGE } from './coverage-map.js';

const generatedAt = '2026-09-22T00:00:00.000Z';
const evidence = (caseId: string): QualificationEvidence => ({
  caseId, executable: true, outcome: 'pass', artifact: `test-results/decision/${caseId}.json`,
  digest: `sha256:${'a'.repeat(64)}`,
});
const manifest = (overrides: Partial<QualificationRunManifest> = {}): QualificationRunManifest => ({
  schemaVersion: 'decision-qualification-run/v1', mode: 'offline', runId: 'offline-foundation', generatedAt,
  sourceCommit: '0123456789abcdef', dirty: false, cases: DECISION_CASE_COVERAGE, evidence: [], evidenceFlags: {}, ...overrides,
});

describe('decision qualification conformance foundation', () => {
  it('inventories exactly C01-C42 and TV01-TV25 without duplicate or invented IDs', () => {
    expect(validateCaseInventory(DECISION_CASE_COVERAGE)).toEqual([]);
    expect(DECISION_CASE_COVERAGE.map(item => item.id)).toEqual(expectedQualificationCaseIds());
    expect(DECISION_CASE_COVERAGE.filter(item => item.kind === 'baseline')).toHaveLength(42);
    expect(DECISION_CASE_COVERAGE.filter(item => item.kind === 'vendor')).toHaveLength(25);
  });

  it('keeps candidate test paths separate from executable evidence', () => {
    expect(DECISION_CASE_COVERAGE.filter(item => item.kind === 'baseline').every(item => item.candidateTests.length > 0)).toBe(true);
    expect(DECISION_CASE_COVERAGE.filter(item => /^C(?:1[1-8])$/.test(item.id))
      .every(item => item.candidateTests.includes('test/conformance/decision-v1/runtime-vectors.test.ts'))).toBe(true);
    expect(DECISION_CASE_COVERAGE.filter(item => /^C(?:19|2[0-3])$/.test(item.id))
      .every(item => item.candidateTests.includes('test/conformance/decision-v1/rule-vectors.test.ts'))).toBe(true);
    expect(DECISION_CASE_COVERAGE.filter(item => /^C2[4-8]$/.test(item.id))
      .every(item => item.candidateTests.includes('test/conformance/decision-v1/state-vectors.test.ts'))).toBe(true);
    for (const [path, ids] of [
      ['security-vectors.test.ts', ['C29', 'C30', 'C32', 'C34', 'C36', 'C39']],
      ['operational-vectors.test.ts', ['C35', 'C41']],
      ['rule-vectors.test.ts', ['C40']],
      ['state-vectors.test.ts', ['C37', 'C38', 'C42']],
    ] as const) {
      expect(DECISION_CASE_COVERAGE.filter(item => new Set<string>(ids).has(item.id))
        .every(item => item.candidateTests.includes(`test/conformance/decision-v1/${path}`))).toBe(true);
    }
    expect(DECISION_CASE_COVERAGE.filter(item => ['TV03', 'TV04', 'TV05', 'TV11'].includes(item.id))
      .every(item => item.candidateTests.includes('test/conformance/decision-v1/acceptance-evidence.test.ts'))).toBe(true);
    expect(DECISION_CASE_COVERAGE.filter(item => item.kind === 'vendor'
      && !['TV03', 'TV04', 'TV05', 'TV11'].includes(item.id)).every(item => item.candidateTests.length === 0)).toBe(true);
    const report = evaluateQualification(manifest());
    expect(report.decision).toBe('HOLD');
    expect(report.gates.find(gate => gate.id === 'G0')).toMatchObject({ status: 'fail' });
    expect(report.gates.find(gate => gate.id === 'G0')?.missing).toContain('case:C01');
    expect(report.gates.find(gate => gate.id === 'G0')?.missing).toContain('case:TV25');
  });

  it('fails every mandatory gate closed when evidence is absent', () => {
    const report = evaluateQualification(manifest());
    expect(report.gates).toHaveLength(7);
    expect(report.gates.every(gate => gate.status === 'fail')).toBe(true);
    expect(report.gates.every(gate => gate.status !== 'skip')).toBe(true);
  });

  it('does not accept skipped, non-executable, undigested, or failed case evidence', () => {
    const bad = [
      { ...evidence('C01'), outcome: 'skip' as const },
      { ...evidence('C02'), executable: false },
      { ...evidence('C03'), digest: null },
      { ...evidence('C04'), outcome: 'fail' as const },
    ];
    const gate = evaluateQualification(manifest({ evidence: bad })).gates[0]!;
    expect(gate.status).toBe('fail');
    expect(gate.failed).toEqual(['case:C01:skip', 'case:C04:fail']);
    expect(gate.missing).toEqual(expect.arrayContaining(['case:C02', 'case:C03']));
  });

  it('rejects malformed evidence digests rather than treating labels as hashes', () => {
    const malformed = { ...evidence('C01'), digest: `sha256:${'z'.repeat(64)}` as `sha256:${string}` };
    expect(evaluateQualification(manifest({ evidence: [malformed] })).gates[0]?.missing).toContain('case:C01');
  });

  it('produces a stable digest independent of case, evidence, and flag insertion order', () => {
    const left = manifest({ evidence: [evidence('TV25'), evidence('C01')], evidenceFlags: { beta: true, alpha: false } });
    const right = manifest({ cases: [...DECISION_CASE_COVERAGE].reverse(), evidence: [evidence('C01'), evidence('TV25')], evidenceFlags: { alpha: false, beta: true } });
    expect(stableManifestDigest(left)).toBe(stableManifestDigest(right));
  });
});
