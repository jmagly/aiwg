// Exercise criterion scoring and calibration on fixed outputs without live judges.
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { validateEvalContract } from '../../../tools/eval/src/contracts.js';
import { runOfflinePilot } from '../../../tools/eval/src/pilot.js';
import { digest } from '../../../tools/eval/src/pilot-files.js';

const api = () => import('../../../tools/eval/src/calibration.js');
const fixture = async () => JSON.parse(await readFile('test/fixtures/eval-pilot/calibration.v1.json', 'utf8'));
let fixed: Awaited<ReturnType<typeof runOfflinePilot>>;
async function sample() {
  fixed ??= await runOfflinePilot('tools/eval/datasets/composition-pilot.json', 'test/fixtures/eval-pilot');
  const study = await fixture();
  const { makeBundles } = await api();
  const bundle = makeBundles(fixed.pilot!.records, study).find(b => b.split === 'held-out')!;
  const config = { id: 'single', version: '1', treatment: 'single', observed_model: 'synthetic', observed_vendor: 'fixture', observed_family: 'fixture', revision: '1', prompt: study.prompt, settings: { temperature: 0, seed: 1, tools: [], thinking: 'none' }, examples: [] };
  study.evaluators = [{ ...config, prompt_digest: digest(config.prompt), config_digest: digest(config) }];
  const vote = { episode_id: bundle.id, bundle_digest: bundle.digest, criterion_id: 'Q1', criterion_version: '1', evaluator_id: 'single', config_digest: digest(config), label: 'MET', evidence: ['output'], rationale: 'synthetic fixture only', critical_flags: [], raw_response: 'MET', raw_digest: digest('MET'), cost_usd: 0.01, tokens: 10, latency_ms: 2, option_order: ['MET', 'UNMET'], confidence: 0.8, execution_id: 'initial', retry_of: null, status: 'completed' };
  return { study, vote, bundle, records: fixed.pilot!.records };
}

describe('offline criterion calibration', () => {
  it('defines strict rubric, receipt and study contracts in the existing eval family', async () => {
    const schema = JSON.parse(await readFile('tools/eval/datasets/contracts.v1.schema.json', 'utf8'));
    expect(schema.$defs).toHaveProperty('CalibrationStudy');
    expect(schema.$defs).toHaveProperty('CriterionVote');
    const study = await fixture();
    validateEvalContract('CalibrationStudy', study);
    expect(() => validateEvalContract('CalibrationStudy', { ...study, extra: true })).toThrow();
  });

  it('keeps N/A, cannot assess, provider errors, missing and negative votes distinct after SKIP', async () => {
    const { scoreCriteria } = await api();
    const { criteria } = await fixture();
    const score = scoreCriteria(criteria, { Q1: 'UNMET', Q2: 'NOT_APPLICABLE', Q3: 'HALF', Q4: 'CANNOT_ASSESS', Q5: 'PROVIDER_ERROR', Q6: 'MISSING' });
    expect(score).toMatchObject({ score: 0.25, original_count: 6, retained_count: 2, original_weight: 5, retained_weight: 2, applicable_count: 5 });
    expect(score.excluded).toEqual({ NOT_APPLICABLE: 1, CANNOT_ASSESS: 1, PROVIDER_ERROR: 1, PARTIAL: 0, MISSING: 1 });
    expect(scoreCriteria(criteria, {}).score).toBeNull();
    expect(() => scoreCriteria(criteria, { Q1: 'HALF' })).toThrow(/label/);
  });

  it('reports binary confusion, ordinal weighted agreement and nominal macro F1 without numeric defect scores', async () => {
    const { criterionMetrics } = await api();
    const { criteria } = await fixture();
    const binary = criterionMetrics(criteria[0], [['MET', 'MET'], ['UNMET', 'MET'], ['MET', 'UNMET'], ['UNMET', 'UNMET']]);
    expect(binary).toMatchObject({ n: 4, exact: 0.5, kappa: 0, tp: 1, fp: 1, fn: 1, tn: 1, sensitivity: 0.5, specificity: 0.5, precision: 0.5 });
    const ordinal = criterionMetrics(criteria[2], [['ZERO', 'HALF'], ['HALF', 'ONE'], ['ONE', 'ONE']]);
    expect(ordinal.adjacent).toBe(1);
    expect(ordinal.directional_bias).toBeCloseTo(1 / 3);
    expect(ordinal.quadratic_kappa).toBeCloseTo(0.5);
    const nominal = criterionMetrics(criteria[5], [['none', 'none'], ['omitted requirement', 'none']]);
    expect(nominal).toMatchObject({ exact: 0.5, macro_f1: 1 / 3 });
    expect(nominal).not.toHaveProperty('directional_bias');
    expect(criterionMetrics(criteria[0], []).exact).toBeNull();
    expect(criterionMetrics(criteria[0], [['MET', 'MET']]).kappa).toBeNull();
    const reordered = { ...criteria[2], anchors: { ONE: 'all', ZERO: 'none', HALF: 'some' } };
    expect(criterionMetrics(reordered, [['ZERO', 'HALF'], ['HALF', 'ONE'], ['ONE', 'ONE']])).toEqual(ordinal);
  });

  it('retains partial and errored attempts without converting them into negative judgments', async () => {
    const { calibrate } = await api();
    const { study, vote, records } = await sample();
    study.votes = [{ ...vote, status: 'partial', label: null, critical_flags: ['truncated-response'] }];
    const result = calibrate(study, records);
    expect(result.candidates[0].criteria.Q1).toMatchObject({ retained: 0, partials: 1, missing: 255, coverage: 0, metrics: { n: 0, exact: null } });
    expect(result.total_cost_usd).toBe(0.01);
    expect(result.raw_votes[0].critical_flags).toEqual(['truncated-response']);
    expect(result.candidates[0].scores.find(s => s.episode_id === vote.episode_id)!.excluded).toMatchObject({ PARTIAL: 1, PROVIDER_ERROR: 0 });
    expect(() => validateEvalContract('CalibrationReport', { ...result, claim_gate: { state: 'PASS', reasons: [] } })).toThrow();
    validateEvalContract('CalibrationReport', result);
  });

  it('rejects mismatched, incomplete or ambiguous vote provenance', async () => {
    const { calibrate } = await api();
    const { study, vote, records } = await sample();
    for (const change of [
      { label: 'HALF' }, { criterion_version: '2' }, { config_digest: digest('wrong') },
      { raw_digest: digest('wrong') }, { evidence: ['absent'] }, { label: 'NOT_APPLICABLE' },
      { status: 'provider-error' }, { option_order: ['MET'] }, { retry_of: 'unknown' },
    ]) {
      const input = { ...study, votes: [{ ...vote, ...change }] };
      expect(() => calibrate(input, records), JSON.stringify(change)).toThrow();
    }
    expect(() => calibrate({ ...study, votes: [vote, vote] }, records)).toThrow(/execution/);
    expect(() => calibrate({ ...study, votes: [vote, { ...vote, execution_id: 'again', retry_of: 'initial' }] }, records)).toThrow(/retry/);
    expect(() => calibrate(study, records.slice(1))).toThrow(/Incomplete/);
    expect(() => calibrate({ ...study, evaluators: [...study.evaluators, ...study.evaluators] }, records)).toThrow(/Duplicate evaluator/);
    expect(() => calibrate({ ...study, evaluators: [{ ...study.evaluators[0], config_digest: digest('changed') }] }, records)).toThrow(/hash/);
    const human = { episode_id: vote.episode_id, bundle_digest: vote.bundle_digest, criterion_id: 'Q1', criterion_version: '1', annotator: 'a', blinded: true, label: 'MET', evidence: ['output'], rationale: 'synthetic only' };
    expect(() => calibrate({ ...study, humans: [human, human] }, records)).toThrow(/Duplicate human/);
    for (const edit of [
      (v: any) => { v.criteria[1] = v.criteria[0]; },
      (v: any) => { delete v.criteria[0].values.MET; },
      (v: any) => { v.criteria[5].weight = 1; },
      (v: any) => { v.criteria[2].values.HALF = null; },
      (v: any) => { v.split.dev.push('coding-repair'); },
    ]) {
      const changed = structuredClone(study); edit(changed);
      const { evaluators: _e, votes: _v, humans: _h, adjudications: _a, commitment: _c, ...frozen } = changed;
      changed.commitment = digest(frozen);
      expect(() => calibrate(changed, records)).toThrow();
    }
  });

  it('preserves abstentions and measures their errors against human labels', async () => {
    const { calibrate } = await api();
    const { study, vote, bundle, records } = await sample();
    const receipt = { episode_id: bundle.id, bundle_digest: bundle.digest, criterion_id: 'Q5', criterion_version: '1', evidence: ['output'], rationale: 'synthetic only' };
    study.votes = [{ ...vote, ...receipt, label: 'NOT_APPLICABLE', option_order: ['ZERO', 'HALF', 'ONE'] }];
    study.humans = ['a', 'b'].map(annotator => ({ ...receipt, annotator, blinded: true, label: 'ONE' }));
    study.adjudications = [{ ...receipt, adjudicator: 'c', label: 'ONE' }];
    let result = calibrate(study, records);
    expect(result.candidates[0].criteria.Q5).toMatchObject({ NOT_APPLICABLE: 1, applicable: 256, retained: 0, abstention: { incorrect_na: 1 } });
    study.votes[0].label = 'CANNOT_ASSESS';
    result = calibrate(study, records);
    expect(result.candidates[0].criteria.Q5.abstention.unsupported_abstention).toBe(1);
    study.humans.pop();
    expect(() => calibrate(study, records)).toThrow(/two blinded/);
  });

  it('keeps calibration and shuffling treatments separate and forbids held-out prompt examples', async () => {
    const { calibrate, ensembleLabel } = await api();
    const { study, vote, bundle, records } = await sample();
    study.votes = [vote];
    for (const treatment of ['calibration', 'shuffling', 'ensemble']) {
      const { config_digest: _hash, prompt_digest: _prompt, ...base } = study.evaluators[0];
      const config = { ...base, id: treatment, treatment };
      study.evaluators.push({ ...config, config_digest: digest(config), prompt_digest: digest(config.prompt) });
      study.votes.push({ ...vote, evaluator_id: treatment, config_digest: digest(config), execution_id: treatment });
    }
    const result = calibrate(study, records);
    expect(result.candidates).toHaveLength(4);
    expect(result.comparisons).toHaveLength(36);
    expect(result.comparisons[0]).toMatchObject({ paired_n: 0, conditional_shared_error: null });
    const receipt = { episode_id: bundle.id, bundle_digest: bundle.digest, criterion_id: 'Q1', criterion_version: '1', evidence: ['output'], rationale: 'synthetic fixture only' };
    study.humans = ['a', 'b'].map(annotator => ({ ...receipt, annotator, blinded: true, label: 'UNMET' }));
    study.adjudications = [{ ...receipt, adjudicator: 'c', label: 'UNMET' }];
    const paired = calibrate(study, records).comparisons[0];
    expect(paired).toMatchObject({ paired_n: 1, baseline_wrong: 1, both_wrong: 1, conditional_shared_error: 1, error_difference: { estimate: 0, lower: 0, upper: 0 } });
    expect(ensembleLabel(study.criteria[0], ['MET', 'MET', 'UNMET'])).toBe('MET');
    expect(ensembleLabel(study.criteria[0], ['MET', 'CANNOT_ASSESS'])).toBe('CANNOT_ASSESS');
    expect(ensembleLabel(study.criteria[4], ['NOT_APPLICABLE', 'NOT_APPLICABLE', 'ONE'])).toBe('NOT_APPLICABLE');
    const { config_digest: _hash, prompt_digest: _prompt, ...config } = study.evaluators[1];
    config.examples = [bundle.id];
    study.evaluators[1] = { ...config, config_digest: digest(config), prompt_digest: digest(config.prompt) };
    expect(() => calibrate(study, records)).toThrow(/Held-out/);
  });

  it('resamples whole scenario families, preserving nested votes and paired differences', async () => {
    const { clusteredInterval } = await api();
    const rows = [{ family: 'a', value: 0 }, { family: 'a', value: 1 }, { family: 'b', value: 1 }];
    const result = clusteredInterval(rows, 4240);
    expect(result).toEqual(clusteredInterval(rows, 4240));
    expect(result).toMatchObject({ clusters: 2, estimate: 2 / 3, lower: 0.5, upper: 1, method: 'scenario-family-percentile' });
    expect(result.limitation).toMatch(/too few/);
    expect(clusteredInterval([], 4240).estimate).toBeNull();
  });

  it('compares synthetic labels on identical bundles and preserves retries, human disagreement and all costs', async () => {
    const { calibrate, makeBundles } = await api();
    const report = await runOfflinePilot('tools/eval/datasets/composition-pilot.json', 'test/fixtures/eval-pilot');
    const study = await fixture();
    const bundles = makeBundles(report.pilot!.records, study);
    const bundle = bundles.find((b: any) => b.split === 'held-out')!;
    const config = { id: 'single', version: '1', treatment: 'single', observed_model: 'synthetic', observed_vendor: 'fixture', observed_family: 'fixture', revision: '1', prompt: study.prompt, settings: { temperature: 0, seed: 1, tools: [], thinking: 'none' }, examples: [] };
    study.evaluators = [{ ...config, prompt_digest: digest(config.prompt), config_digest: digest(config) }];
    const base = { episode_id: bundle.id, bundle_digest: bundle.digest, criterion_id: 'Q1', criterion_version: '1', evaluator_id: 'single', config_digest: digest(config), label: 'MET', evidence: ['output'], rationale: 'synthetic fixture only', critical_flags: [], raw_response: 'MET', raw_digest: digest('MET'), cost_usd: 0.01, tokens: 10, latency_ms: 2, option_order: ['MET', 'UNMET'], confidence: 0.8 };
    study.votes = [{ ...base, execution_id: 'failed', retry_of: null, status: 'provider-error', label: null, raw_response: 'timeout', raw_digest: digest('timeout') }, { ...base, execution_id: 'retry', retry_of: 'failed', status: 'completed' }];
    study.humans = ['ann-a', 'ann-b'].map((annotator, i) => ({ episode_id: bundle.id, bundle_digest: bundle.digest, criterion_id: 'Q1', criterion_version: '1', annotator, blinded: true, label: i ? 'UNMET' : 'MET', evidence: ['output'], rationale: 'synthetic label' }));
    study.adjudications = [{ episode_id: bundle.id, bundle_digest: bundle.digest, criterion_id: 'Q1', criterion_version: '1', adjudicator: 'ann-c', label: 'UNMET', evidence: ['output'], rationale: 'synthetic disagreement retained' }];
    const result = calibrate(study, report.pilot!.records);
    expect(result.raw_votes).toEqual(study.votes);
    expect(result.raw_humans).toEqual(study.humans);
    expect(result.total_cost_usd).toBe(0.02);
    expect(result.human_disagreements).toBe(1);
    expect(result.candidates[0].criteria.Q1.metrics).toMatchObject({ fp: 1, n: 1 });
    expect(result.candidates[0].criteria.Q1).toMatchObject({ provider_errors: 1, original: 256, retained: 1, missing: 255 });
    expect(result.candidates[0].criteria.Q1.brier).toBeCloseTo(0.64);
    expect(result.claim_gate.state).toBe('BLOCKED');
    study.votes[1].bundle_digest = 'sha256:' + '0'.repeat(64);
    expect(() => calibrate(study, report.pilot!.records)).toThrow(/bundle/);
  });

  it('adds a frozen evidence-only recommendation to the pilot without fabricating labels', async () => {
    const { calibrate, makeBundles, blindedPacket } = await api();
    const study = await fixture();
    const report = await runOfflinePilot('tools/eval/datasets/composition-pilot.json', 'test/fixtures/eval-pilot');
    const result = calibrate(study, report.pilot!.records);
    expect(report.pilot!.calibration).toEqual(result);
    expect(result).toMatchObject({ status: 'insufficient-evidence', raw_votes: [], raw_humans: [], total_cost_usd: 0, claim_gate: { state: 'BLOCKED' } });
    expect(result.bundles).toHaveLength(384);
    expect(result.split).toEqual({ dev: 128, 'held-out': 256 });
    expect(result.recommendation).toMatch(/human/);
    const bundles = makeBundles(report.pilot!.records, study);
    expect(Object.keys(blindedPacket(bundles[0]))).toEqual(['episode_id', 'bundle_digest', 'evidence']);
    expect(new Set(bundles.filter((b: any) => b.split === 'dev').map((b: any) => b.family))).toEqual(new Set(['corpus-verification']));
    const changed = structuredClone(study); changed.criteria[0].weight = 2;
    expect(() => calibrate(changed, report.pilot!.records)).toThrow(/commitment/);
    const drift = structuredClone(report.pilot!.records); drift[0].modelResponse += 'drift';
    expect(() => calibrate(study, drift)).toThrow(/output/);
  });
});
