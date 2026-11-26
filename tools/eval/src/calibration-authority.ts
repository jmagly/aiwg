// Name the executable checks that keep authority, and refuse a reliability claim without the missing evidence.
import type { CalibrationStudy, Criterion } from './calibration-types.js';

export const EXECUTABLE_AUTHORITY = [
  { id: 'corpus', keepsAuthority: true, check: 'Source and value match the hidden vector.' },
  { id: 'coding', keepsAuthority: true, check: 'Hidden functional cases pass in the bounded VM.' },
  { id: 'security', keepsAuthority: true, check: 'Functional result, permissions, one effect and the start/verified/complete path match the hidden vector.' },
] as const;

export function nonExecutableCriteria(criteria: Criterion[]) {
  return criteria.map(criterion => ({
    id: criterion.id, version: criterion.version, type: criterion.type,
    decidableFromExecutableChecks: false as const,
  }));
}

export function reliabilityRefusal(study: Pick<CalibrationStudy, 'humans' | 'adjudications'>): string[] {
  const reasons = ["Insufficient evidence; #3315's claim gate stays blocked."];
  const panel = study.adjudications.length > 0 && study.adjudications.every(adjudication => {
    const labels = study.humans.filter(human => human.episode_id === adjudication.episode_id && human.criterion_id === adjudication.criterion_id);
    return labels.length === 2 && new Set(labels.map(human => human.annotator)).size === 2 && labels.every(human => human.annotator !== adjudication.adjudicator);
  });
  reasons.push(panel
    ? 'Reliability claim refused: acceptance thresholds are not predeclared.'
    : 'Reliability claim refused: two blinded human annotators and an independent adjudicator are absent.');
  return reasons;
}

export const MEASUREMENT_RECOMMENDATION = "Insufficient evidence; #3315's claim gate stays blocked. Retain executable checks and human assessment. No reliability claim is made.";
