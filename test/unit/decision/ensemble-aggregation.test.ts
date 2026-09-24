import { describe, expect, it } from 'vitest';
import {
  EnsembleContractError, aggregateEnsembleResults, validateEnsembleAggregate,
  type DecisionEnsembleAggregate, type DecisionEnsemblePolicy, type EnsembleMemberResult,
} from '../../../src/decision/ensemble/index.js';
import { applyPatch, readFixture, records, seededShuffle, type PatchOp } from './ensemble-fixtures.js';

interface Vector {
  id: string; title: string; policy: string; patch?: PatchOp[]; groundTruth?: string;
  results: EnsembleMemberResult[];
  expected: {
    disposition: string; value: string | number | null; reason: string; tie: boolean;
    algorithm: { id: string; version: string }; disagreementBps: number; warnings: string[]; correctnessGate: string;
  };
}
const policies = records<DecisionEnsemblePolicy>('ensemble-policy.v1.valid.json');
const { cases } = readFixture<{ cases: Vector[] }>('aggregation-vectors.v1.json');
const policyFor = (vector: Vector) => applyPatch(policies.get(vector.policy)!, vector.patch);
const run = (vector: Vector, results = vector.results) => aggregateEnsembleResults(policyFor(vector), results);

function rejection(fn: () => unknown): EnsembleContractError {
  try { fn(); } catch (error) { if (error instanceof EnsembleContractError) return error; throw error; }
  throw new Error('expected an EnsembleContractError');
}

describe('ENS D17 reference aggregation vectors (#2679)', () => {
  it('ENS-AGG-00 covers aggregation, disagreement, stable tie and defer-on-conflict for Choice, Noul and Score', () => {
    const byPrimitive = (primitive: string) => cases.filter(vector => policies.get(vector.policy)!.primitive === primitive);
    for (const primitive of ['choice', 'truth-probability', 'ordinal-score']) {
      const vectors = byPrimitive(primitive);
      expect(vectors.some(vector => vector.expected.disposition === 'accept' && !vector.expected.tie), primitive).toBe(true);
      expect(vectors.some(vector => vector.expected.tie && vector.expected.disposition === 'accept'), `${primitive} stable tie`).toBe(true);
      expect(vectors.some(vector => vector.expected.reason === 'disagreement-exceeded'), `${primitive} defer on conflict`).toBe(true);
    }
    const algorithms = new Set(cases.map(vector => vector.expected.algorithm.id));
    expect([...algorithms].sort()).toEqual(['majority-v1', 'mean-probability-v1', 'score-distribution-mean-v1', 'score-median-v1']);
    const metrics = new Set(cases.map(vector => policyFor(vector).disagreement.metric));
    expect([...metrics].sort()).toEqual(['jensen-shannon-v1', 'normalized-entropy-v1', 'score-dispersion-v1', 'vote-share-v1']);
  });

  for (const vector of cases) {
    it(`${vector.id} ${vector.title}`, () => {
      const aggregate = run(vector);
      expect(validateEnsembleAggregate(aggregate)).toBe(aggregate);
      expect({
        disposition: aggregate.outcome.disposition, value: aggregate.outcome.value, reason: aggregate.outcome.reason, tie: aggregate.outcome.tie,
        algorithm: aggregate.algorithm, disagreementBps: aggregate.disagreement.valueBps, warnings: aggregate.warnings,
        correctnessGate: aggregate.correctnessGate.status,
      }).toEqual(vector.expected);
      expect(aggregate.algorithm.id).toBe(policyFor(vector).aggregation.algorithm);
      expect(aggregate.disagreement.metric.id).toBe(policyFor(vector).disagreement.metric);
      expect(aggregate.members.map(member => member.resultDigest).sort()).toEqual(vector.results.map(result => result.resultDigest).sort());
    });
  }

  it('ENS-AGG-PERM is deterministic under seeded permutations of member order', () => {
    for (const vector of cases) {
      const baseline = run(vector);
      for (let seed = 1; seed <= 25; seed++) {
        const shuffled = seededShuffle(vector.results, seed * 7919 + vector.id.length);
        expect(run(vector, shuffled), `${vector.id} seed ${seed}`).toEqual(baseline);
      }
      // Reordering policy members changes nothing either: members are canonicalized by ID.
      const policy = policyFor(vector);
      const reordered = { ...policy, members: seededShuffle(policy.members, 17) };
      const again = aggregateEnsembleResults(reordered, vector.results);
      expect({ ...again, policy: baseline.policy, digest: baseline.digest }).toEqual(baseline);
    }
  });

  it('ENS-SHARED-01 high agreement from one shared model warns and never satisfies the correctness gate', () => {
    const vector = cases.find(item => item.id === 'ENS-SHARED-01')!;
    const aggregate = run(vector);
    expect(aggregate.disagreement.valueBps).toBe(0);
    expect(aggregate.outcome.value).not.toBe(vector.groundTruth);
    expect(aggregate.warnings).toEqual(expect.arrayContaining(['high-agreement-not-correctness', 'shared-systematic-error-risk']));
    expect(aggregate.correctnessGate.status).toBe('not-satisfied');
    expect(aggregate.semantics).toBe('stability-signal-not-correctness');
    // Independent unanimous members still only yield a stability warning, not a satisfied gate.
    const independent = run(cases.find(item => item.id === 'ENS-CHOICE-08')!);
    expect(independent.warnings).toContain('high-agreement-not-correctness');
    expect(independent.warnings).not.toContain('shared-systematic-error-risk');
    expect(independent.correctnessGate.status).toBe('not-satisfied');
  });

  it('ENS-AGG-EVID keeps every member result, including failures, inspectable and never fabricates a common probability', () => {
    const vector = cases.find(item => item.id === 'ENS-CHOICE-05')!;
    const aggregate: DecisionEnsembleAggregate = run(vector);
    expect(aggregate.counts).toEqual({ declared: 3, succeeded: 1, failed: 1, abstained: 1 });
    expect(aggregate.members.filter(member => member.status !== 'succeeded').every(member => member.value === null)).toBe(true);
    const majority = run(cases.find(item => item.id === 'ENS-CHOICE-01')!);
    expect(majority.statistics.meanProbability).toBeNull();
    expect(majority.statistics.meanDistribution).toBeNull();
  });

  it('ENS-AGG-REJ refuses incomplete, forged or semantically mismatched member results', () => {
    const vector = cases.find(item => item.id === 'ENS-CHOICE-01')!;
    const [first, ...rest] = vector.results;
    const variants: Array<[string, EnsembleMemberResult[]]> = [
      ['every planned sample must be recorded', rest],
      ['is duplicated', [first!, first!, ...rest.slice(1)]],
      ['unknown member', [{ ...first!, memberId: 'ghost' }, ...rest]],
      ['not a declared choice option', [{ ...first!, value: 'maybe' }, ...rest]],
      ['uncertainty profile does not match', [{ ...first!, uncertaintyProfile: 'typesafe-truth-v1' }, ...rest]],
      ['cannot carry a value', [{ ...first!, status: 'failed' }, ...rest]],
      ['outside the planned samples', [{ ...first!, sampleIndex: 1 }, ...rest]],
      ['must pin its retained result lineage', [{ ...first!, resultDigest: 'sha256:short' as `sha256:${string}` }, ...rest]],
      ['invalid distribution', [{ ...first!, distribution: { approve: 0.9 } }, ...rest]],
    ];
    for (const [message, results] of variants) expect(rejection(() => run(vector, results)).details.join('\n'), message).toContain(message);
    const js = cases.find(item => item.id === 'ENS-CHOICE-07')!;
    const missing = js.results.map((result, index) => index === 0 ? { ...result, distribution: null } : result);
    expect(rejection(() => run(js, missing)).details[0]).toContain('needs a provider distribution');
    const noul = cases.find(item => item.id === 'ENS-NOUL-01')!;
    expect(rejection(() => run(noul, noul.results.map((result, index) => index ? result : { ...result, value: 1.2 }))).details[0]).toContain('not a probability');
    const score = cases.find(item => item.id === 'ENS-SCORE-01')!;
    expect(rejection(() => run(score, score.results.map((result, index) => index ? result : { ...result, value: 5 }))).details[0]).toContain('outside the score levels');
  });
});
