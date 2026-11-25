// Summarize offline per-criterion calibration without granting empirical acceptance.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateStudy, humanPair } from './calibration-validate.js';
import { criterionMetrics, clusteredInterval, scoreCriteria } from './calibration-metrics.js';
import type { CalibrationStudy, FixedOutput, Vote } from './calibration-types.js';
export { makeBundles, blindedPacket } from './calibration-validate.js';
export { criterionMetrics, clusteredInterval, scoreCriteria, ensembleLabel } from './calibration-metrics.js';
const divide = (a: number, b: number): number | null => b ? a / b : null;

export function calibrate(study: CalibrationStudy, records: FixedOutput[]) {
  const bundles = validateStudy(study, records);
  const held = bundles.filter(b => b.split === 'held-out');
  const targets = new Map(study.adjudications.map(a => [`${a.episode_id}:${a.criterion_id}`, a]));
  const selected = new Map<string, Vote>();
  // First completed retry is the declared selection rule; no best-of-success selection.
  for (const vote of study.votes) selected.set(`${vote.evaluator_id}:${vote.episode_id}:${vote.criterion_id}`, vote);
  const candidates = study.evaluators.map(evaluator => {
    const criteria = Object.fromEntries(study.criteria.map(c => {
      const counts = { original: held.length, retained: 0, applicable: held.length, assessed_applicable: 0, NOT_APPLICABLE: 0, CANNOT_ASSESS: 0, provider_errors: 0, partials: 0, missing: 0 };
      const pairs: [string, string][] = [], errors: { family: string; value: number }[] = [];
      const calibration: number[] = [];
      const abstention = { incorrect_na: 0, unsupported_abstention: 0, missed_insufficient_evidence: 0, labeled: 0 };
      for (const b of held) {
        const vote = selected.get(`${evaluator.id}:${b.id}:${c.id}`);
        const attempts = study.votes.filter(v => v.evaluator_id === evaluator.id && v.episode_id === b.id && v.criterion_id === c.id);
        counts.provider_errors += attempts.filter(v => v.status === 'provider-error').length;
        counts.partials += attempts.filter(v => v.status === 'partial').length;
        const target = targets.get(`${b.id}:${c.id}`);
        const predicted = !vote ? 'MISSING' : vote.status === 'completed' ? vote.label! : vote.status === 'provider-error' ? 'PROVIDER_ERROR' : 'PARTIAL';
        if (predicted === 'MISSING') counts.missing++;
        if (predicted === 'NOT_APPLICABLE') counts.NOT_APPLICABLE++;
        if (predicted === 'CANNOT_ASSESS') counts.CANNOT_ASSESS++;
        // Known human applicability governs coverage; otherwise expose predicted applicability.
        if (target?.label === 'NOT_APPLICABLE' || (!target && predicted === 'NOT_APPLICABLE')) counts.applicable--;
        if (Object.hasOwn(c.anchors, predicted)) counts.retained++;
        if (Object.hasOwn(c.anchors, predicted) && target?.label !== 'NOT_APPLICABLE') counts.assessed_applicable++;
        if (!target) continue;
        abstention.labeled++;
        if (predicted === 'NOT_APPLICABLE' && target.label !== predicted) abstention.incorrect_na++;
        if (predicted === 'CANNOT_ASSESS' && Object.hasOwn(c.anchors, target.label)) abstention.unsupported_abstention++;
        if (target.label === 'CANNOT_ASSESS' && Object.hasOwn(c.anchors, predicted)) abstention.missed_insufficient_evidence++;
        if (!Object.hasOwn(c.anchors, predicted) || !Object.hasOwn(c.anchors, target.label)) continue;
        pairs.push([target.label, predicted]);
        errors.push({ family: b.family, value: Number(target.label !== predicted) });
        if (c.type === 'binary' && vote?.confidence !== null && vote?.confidence !== undefined) calibration.push((vote.confidence - Number(target.label === 'MET')) ** 2);
      }
      return [c.id, { ...counts, coverage: divide(counts.assessed_applicable, counts.applicable), abstention,
        abstention_rate: divide(counts.CANNOT_ASSESS, counts.applicable), error_among_assessed: divide(errors.filter(x => x.value).length, errors.length),
        metrics: criterionMetrics(c, pairs), error_interval: clusteredInterval(errors, 4240),
        brier: divide(calibration.reduce((a, b) => a + b, 0), calibration.length), brier_n: calibration.length }];
    }));
    const scores = held.map(b => ({ episode_id: b.id, ...scoreCriteria(study.criteria, Object.fromEntries(study.criteria.map(c => {
      const vote = selected.get(`${evaluator.id}:${b.id}:${c.id}`);
      return [c.id, vote?.status === 'completed' ? vote.label! : vote?.status === 'partial' ? 'PARTIAL' : vote ? 'PROVIDER_ERROR' : 'MISSING'];
    }))) }));
    const attempts = study.votes.filter(v => v.evaluator_id === evaluator.id);
    return { evaluator, criteria, scores, cost_usd: attempts.reduce((n, v) => n + v.cost_usd, 0),
      total_tokens: attempts.reduce((n, v) => n + v.tokens, 0), latency_ms: attempts.reduce((n, v) => n + v.latency_ms, 0) };
  });
  const human_agreement = Object.fromEntries(study.criteria.map(c => {
    const pairs: [string, string][] = [];
    for (const b of held) {
      const labels = humanPair(study.humans, { episode_id: b.id, criterion_id: c.id }).sort((a, b) => a.annotator.localeCompare(b.annotator));
      if (labels.length === 2 && labels.every(h => Object.hasOwn(c.anchors, h.label))) pairs.push([labels[0].label, labels[1].label]);
    }
    return [c.id, criterionMetrics(c, pairs)];
  }));
  const comparisons = study.evaluators.flatMap((a, i) => study.evaluators.slice(i + 1).flatMap(b => study.criteria.map(c => {
    const deltas: { family: string; value: number }[] = [];
    let bothWrong = 0, aWrong = 0;
    for (const bundle of held) {
      const key = `${bundle.id}:${c.id}`, truth = targets.get(key)?.label;
      const av = selected.get(`${a.id}:${key}`), bv = selected.get(`${b.id}:${key}`);
      if (!truth || !Object.hasOwn(c.anchors, truth) || av?.status !== 'completed' || bv?.status !== 'completed'
        || !Object.hasOwn(c.anchors, av.label!) || !Object.hasOwn(c.anchors, bv.label!)) continue;
      const ae = Number(av.label !== truth), be = Number(bv.label !== truth);
      aWrong += ae; bothWrong += ae * be;
      deltas.push({ family: bundle.family, value: be - ae });
    }
    return { baseline: a.id, candidate: b.id, criterion: c.id, paired_n: deltas.length,
      error_difference: clusteredInterval(deltas, 4240), baseline_wrong: aWrong, both_wrong: bothWrong, conditional_shared_error: divide(bothWrong, aWrong) };
  })));
  return {
    version: study.version, status: 'insufficient-evidence' as const, rubric_commitment: study.commitment,
    provenance: study.provenance, outputs_digest: study.outputs_digest, prompt_digest: study.prompt_digest,
    criteria: study.criteria, prompt: study.prompt,
    split: { dev: bundles.length - held.length, 'held-out': held.length }, bundles,
    raw_votes: study.votes, raw_humans: study.humans, adjudications: study.adjudications,
    human_disagreements: new Set(study.humans.filter(h => new Set(humanPair(study.humans, h).map(x => x.label)).size > 1).map(h => `${h.episode_id}:${h.criterion_id}`)).size,
    human_agreement, candidates, comparisons,
    total_cost_usd: study.votes.reduce((n, v) => n + v.cost_usd, 0),
    thresholds: study.thresholds,
    recommendation: 'Retain executable checks and human assessment. No evaluator is recommended without two blinded human labels, adjudication, real judged runs and predeclared bounds.',
    limitations: ['Offline fixtures are not empirical reliability evidence.', 'Only two held-out scenario families; clustered intervals are descriptive.',
      'Artifact-only outputs lack explanation, policy, checklist and uncertainty evidence; do not infer satisfaction.',
      'No acceptance thresholds predeclared; all claims remain blocked.', 'Vendor diversity and repeated calls do not establish independent errors.'],
    claim_gate: { state: 'BLOCKED' as const, reasons: ['Insufficient qualitative calibration evidence; #3315 claim gate retained.'] },
  };
}
export type CalibrationReport = ReturnType<typeof calibrate>;
export async function loadCalibration(root: string, records: FixedOutput[]): Promise<CalibrationReport> {
  const study = JSON.parse(await readFile(path.join(root, 'calibration.v1.json'), 'utf8')) as CalibrationStudy;
  return calibrate(study, records);
}
export function calibrationMarkdown(report: CalibrationReport): string {
  return ['## Criterion calibration', `Status: ${report.status}; claim gate: ${report.claim_gate.state}.`,
    `Split: ${report.split.dev} development / ${report.split['held-out']} held-out fixed outputs.`,
    `Raw votes: ${report.raw_votes.length}; human labels: ${report.raw_humans.length}; cost USD: ${report.total_cost_usd}.`,
    report.recommendation, ...report.limitations].join('\n\n');
}
