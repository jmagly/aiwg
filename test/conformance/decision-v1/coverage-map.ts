import type { QualificationCase } from '../../../src/decision/qualification/types.js';
import { REQUIRED_BASELINE_CASE_IDS, REQUIRED_VENDOR_CASE_IDS } from '../../../src/decision/qualification/manifest.js';

const candidateByRange: Array<[number, number, string[]]> = [
  [1, 12, ['test/unit/decision/runtime.test.ts', 'test/unit/decision/jev-transport.test.ts']],
  [13, 18, ['test/unit/decision/jev-transport.test.ts']],
  [19, 23, ['test/unit/decision/runtime.test.ts']],
  [24, 26, ['test/unit/decision/jev-transport.test.ts', 'test/unit/decision/runtime.test.ts']],
  [27, 28, ['test/unit/decision/receipts.test.ts']],
  [29, 36, ['test/unit/decision/runtime.test.ts', 'test/unit/decision/jev-transport.test.ts']],
  [37, 38, ['test/unit/decision/receipts.test.ts']],
  [39, 41, ['test/unit/decision/runtime.test.ts']],
  [42, 42, ['test/unit/decision/receipts.test.ts']],
];

function candidates(id: string): string[] {
  const ordinal = Number(id.slice(1));
  if (id.startsWith('C') && ordinal >= 1 && ordinal <= 7) {
    return ['test/conformance/decision-v1/core-vectors.test.ts'];
  }
  if (id === 'C08' || id === 'C09' || id === 'C10'
    || id === 'TV03' || id === 'TV04' || id === 'TV05' || id === 'TV11') {
    return ['test/conformance/decision-v1/acceptance-evidence.test.ts'];
  }
  return candidateByRange.find(([start, end]) => ordinal >= start && ordinal <= end)?.[2] ?? [];
}

// Candidate paths are discovery hints, not executable evidence. A case passes
// only when a runner emits a separate evidence record with a digest.
export const DECISION_CASE_COVERAGE: QualificationCase[] = [
  ...REQUIRED_BASELINE_CASE_IDS.map(id => ({ id, kind: 'baseline' as const, mandatory: true, candidateTests: candidates(id) })),
  ...REQUIRED_VENDOR_CASE_IDS.map(id => ({ id, kind: 'vendor' as const, mandatory: true, candidateTests: candidates(id) })),
];
