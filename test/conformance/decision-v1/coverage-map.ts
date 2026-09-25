import type { QualificationCase } from '../../../src/decision/qualification/types.js';
import { REQUIRED_BASELINE_CASE_IDS, REQUIRED_VENDOR_CASE_IDS } from '../../../src/decision/qualification/manifest.js';

const CONFORMANCE = 'test/conformance/decision-v1';

/** The suite file whose executor proves each case. Ordinals are inclusive. */
const suiteByRange: ReadonlyArray<readonly [prefix: 'C' | 'TV', from: number, to: number, suite: string]> = [
  ['C', 1, 7, `${CONFORMANCE}/core-vectors.test.ts`],
  ['C', 8, 10, `${CONFORMANCE}/acceptance-evidence.test.ts`],
  ['C', 11, 18, `${CONFORMANCE}/runtime-vectors.test.ts`],
  ['C', 19, 23, `${CONFORMANCE}/rule-vectors.test.ts`],
  ['C', 24, 28, `${CONFORMANCE}/state-vectors.test.ts`],
];

const suiteById: Readonly<Record<string, string>> = {
  C29: `${CONFORMANCE}/security-vectors.test.ts`, C30: `${CONFORMANCE}/security-vectors.test.ts`,
  C31: `${CONFORMANCE}/boundary-vectors.test.ts`, C32: `${CONFORMANCE}/security-vectors.test.ts`,
  C33: `${CONFORMANCE}/boundary-vectors.test.ts`, C34: `${CONFORMANCE}/security-vectors.test.ts`,
  C35: `${CONFORMANCE}/operational-vectors.test.ts`, C36: `${CONFORMANCE}/security-vectors.test.ts`,
  C37: `${CONFORMANCE}/state-vectors.test.ts`, C38: `${CONFORMANCE}/state-vectors.test.ts`,
  C39: `${CONFORMANCE}/security-vectors.test.ts`, C40: `${CONFORMANCE}/rule-vectors.test.ts`,
  C41: `${CONFORMANCE}/operational-vectors.test.ts`, C42: `${CONFORMANCE}/state-vectors.test.ts`,
  TV01: `${CONFORMANCE}/batch-evidence.test.ts`, TV03: `${CONFORMANCE}/acceptance-evidence.test.ts`,
  TV04: `${CONFORMANCE}/acceptance-evidence.test.ts`, TV05: `${CONFORMANCE}/acceptance-evidence.test.ts`,
  TV08: `${CONFORMANCE}/batch-evidence.test.ts`, TV10: 'test/unit/decision/calibration-qualification-evidence.test.ts',
  TV11: `${CONFORMANCE}/acceptance-evidence.test.ts`, TV22: `${CONFORMANCE}/batch-evidence.test.ts`,
  ...Object.fromEntries(['TV02', 'TV06', 'TV07', 'TV09', 'TV12', 'TV13', 'TV14', 'TV15', 'TV16', 'TV17', 'TV18', 'TV19',
    'TV20', 'TV21', 'TV23', 'TV24', 'TV25'].map(id => [id, `${CONFORMANCE}/vendor-vectors.test.ts`])),
};

/**
 * Extra discovery hints beyond the executor suite. TV-12 (D06 context limits)
 * also has offline CTX-* boundary, runtime and qualification-gate unit tests;
 * live estimate-versus-actual comparisons are still required before it can pass.
 */
const additionalHintsById: Readonly<Record<string, readonly string[]>> = {
  TV12: ['test/unit/decision/context-plan.test.ts', 'test/unit/decision/context-qualification.test.ts',
    'test/unit/decision/batch.test.ts'],
};

/** Parses `C01`..`C42` and `TV01`..`TV25`; anything else has no ordinal. */
export function caseOrdinal(id: string): { prefix: 'C' | 'TV'; ordinal: number } | null {
  const match = /^(C|TV)(\d{2})$/.exec(id);
  return match ? { prefix: match[1] as 'C' | 'TV', ordinal: Number(match[2]) } : null;
}

/** Candidate suite paths for a case. An empty list means no executor exists in the repository yet. */
export function candidates(id: string): string[] {
  if (suiteById[id]) return [suiteById[id]!, ...(additionalHintsById[id] ?? [])];
  const parsed = caseOrdinal(id);
  if (!parsed) return [];
  const match = suiteByRange.find(([prefix, from, to]) => prefix === parsed.prefix && parsed.ordinal >= from && parsed.ordinal <= to);
  return match ? [match[3]] : [];
}

// Candidate paths are discovery hints, not executable evidence. A case passes
// only when a runner emits a separate evidence record with a digest; the
// aggregate test checks that each hinted case has a registered executor.
export const DECISION_CASE_COVERAGE: QualificationCase[] = [
  ...REQUIRED_BASELINE_CASE_IDS.map(id => ({ id, kind: 'baseline' as const, mandatory: true, candidateTests: candidates(id) })),
  ...REQUIRED_VENDOR_CASE_IDS.map(id => ({ id, kind: 'vendor' as const, mandatory: true, candidateTests: candidates(id) })),
];
