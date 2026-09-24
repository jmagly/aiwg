import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CalibrationRegistry, calibrationIdentityDigest, type CalibrationIdentity, type CompatibilityDecision } from '../../../src/decision/calibration/index.js';
import {
  ENSEMBLE_SCHEMA_FILES, EnsembleContractError, aggregateEnsembleResults, checkEnsembleSchema, planEnsembleBudget,
  validateChampionChallenger, validateDriftResponsePolicy, validateEnsembleAggregate, validateEnsemblePolicy,
  type DecisionChampionChallenger, type DecisionDriftResponse, type DecisionEnsemblePolicy, type EnsembleMemberResult,
} from '../../../src/decision/ensemble/index.js';
import { loadSchemaCatalog, SchemaResolver } from '../../../src/schema/index.js';
import { ROOT, applyPatch, readFixture, records, type AntiFixtureCase } from './ensemble-fixtures.js';

const policies = records<DecisionEnsemblePolicy>('ensemble-policy.v1.valid.json');
const championChallengers = records<DecisionChampionChallenger>('champion-challenger.v1.valid.json');
const driftPolicies = records<DecisionDriftResponse>('drift-response.v1.valid.json');
const choice = policies.get('triage-choice-ensemble')!;
const cc = championChallengers.get('triage-champion-challenger-2026-09')!;
const hash = (character: string) => `sha256:${character.repeat(64)}` as const;

function rejection(run: () => unknown): EnsembleContractError {
  try { run(); } catch (error) { if (error instanceof EnsembleContractError) return error; throw error; }
  throw new Error('expected an EnsembleContractError');
}

const suites = [
  { name: 'DecisionEnsemblePolicy.v1', valid: 'ensemble-policy.v1.valid.json', invalid: 'ensemble-policy.v1.invalid.json',
    bases: policies as Map<string, unknown>, validate: (value: unknown) => validateEnsemblePolicy(value) },
  { name: 'DecisionChampionChallenger.v1', valid: 'champion-challenger.v1.valid.json', invalid: 'champion-challenger.v1.invalid.json',
    bases: championChallengers as Map<string, unknown>, validate: (value: unknown) => validateChampionChallenger(value) },
  { name: 'DecisionDriftResponse.v1', valid: 'drift-response.v1.valid.json', invalid: 'drift-response.v1.invalid.json',
    bases: driftPolicies as Map<string, unknown>, validate: (value: unknown) => validateDriftResponsePolicy(value) },
];

describe('ENS D17 contract schemas (#2679)', () => {
  it('ENS-SCHEMA-01 registers every D17 schema in the decision catalog with fixtures and projections', () => {
    const loaded = loadSchemaCatalog({ rootDir: ROOT });
    expect(loaded.valid, JSON.stringify(loaded.diagnostics)).toBe(true);
    const resolver = new SchemaResolver(loaded.catalog!, { rootDir: ROOT });
    const withFixtures = new Set(['decision.ensemble-policy', 'decision.champion-challenger', 'decision.drift-response']);
    const names = ['decision.ensemble-policy', 'decision.champion-challenger', 'decision.drift-response', 'decision.ensemble-aggregate', 'decision.ensemble-integrity-report'];
    for (const name of names) {
      const entry = resolver.require(`${name}@1.0.0`);
      expect(entry.artifact.stability).toBe('experimental');
      expect(Object.values(ENSEMBLE_SCHEMA_FILES).map(file => `schemas/decision/${file}`)).toContain(entry.artifact.authority.path);
      const schema = JSON.parse(readFileSync(resolve(ROOT, entry.artifact.authority.path!), 'utf8')) as { $id: string };
      expect(schema.$id).toBe(entry.artifact.id);
      expect(entry.artifact.projections?.map(item => item.kind)).toEqual(['types', 'validator']);
      if (withFixtures.has(name)) {
        for (const path of [...entry.artifact.fixtures!.valid!, ...entry.artifact.fixtures!.invalid!]) expect(existsSync(resolve(ROOT, path)), path).toBe(true);
      }
    }
  });

  for (const suite of suites) {
    it(`ENS-SCHEMA-02 ${suite.name} accepts every positive fixture`, () => {
      const fixture = readFixture<{ provenance: { origin: string; sanitization: string }; records: unknown[] }>(suite.valid);
      expect(fixture.provenance).toMatchObject({ origin: 'repository-authored', sanitization: 'synthetic; no personal inputs' });
      expect(fixture.records.length).toBeGreaterThan(0);
      for (const record of fixture.records) expect(() => suite.validate(record)).not.toThrow();
    });

    it(`ENS-SCHEMA-03 ${suite.name} rejects every anti-fixture at the declared layer`, () => {
      const { cases } = readFixture<{ cases: AntiFixtureCase[] }>(suite.invalid);
      expect(new Set(cases.map(item => item.id)).size).toBe(cases.length);
      expect(cases.some(item => item.layer === 'schema') && cases.some(item => item.layer === 'semantic')).toBe(true);
      for (const item of cases) {
        const base = suite.bases.get(item.base);
        expect(base, item.id).toBeDefined();
        const error = rejection(() => suite.validate(applyPatch(base, item.patch)));
        expect(error.layer, item.id).toBe(item.layer);
        if (item.expect) expect(error.details.join('\n'), item.id).toContain(item.expect);
      }
    });
  }

  it('ENS-SCHEMA-04 names the acceptance-criteria anti-fixtures explicitly', () => {
    const ids = suites.flatMap(suite => readFixture<{ cases: AntiFixtureCase[] }>(suite.invalid).cases.map(item => item.id));
    for (const id of ['missing-member-binding-pin', 'primitive-mismatch', 'missing-ceilings', 'unknown-aggregation-version',
      'alias-drift-without-response', 'rule-without-response', 'promotion-without-rollback-target', 'promotion-without-eligibility',
      'promotion-without-integrity-report']) expect(ids).toContain(id);
  });

  it('ENS-OUT-01 the aggregate output schema has no calibrated or correctness value field', () => {
    const schema = JSON.parse(readFileSync(resolve(ROOT, 'schemas/decision', ENSEMBLE_SCHEMA_FILES.aggregate), 'utf8')) as Record<string, unknown>;
    const keys: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (!node || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      if (record.properties && typeof record.properties === 'object') keys.push(...Object.keys(record.properties));
      if (record.type === 'object' && record.properties) expect(record.additionalProperties === false || typeof record.additionalProperties === 'object').toBe(true);
      Object.values(record).forEach(walk);
    };
    walk(schema);
    expect(keys.length).toBeGreaterThan(20);
    const forbidden = /calibrat|accura|correctProbability|correctnessProbability|probabilityCorrect|isCorrect|verified|truth/i;
    expect(keys.filter(key => forbidden.test(key))).toEqual([]);
    const gate = (schema.properties as any).correctnessGate.properties;
    expect(gate.status).toEqual({ const: 'not-satisfied' });
    expect((schema.properties as any).semantics).toEqual({ const: 'stability-signal-not-correctness' });
  });

  it('ENS-OUT-02 aggregate output validates, and a relabelled correctness claim is rejected', () => {
    const results: EnsembleMemberResult[] = choice.members.map((member, index) => ({ memberId: member.id, sampleIndex: 0, status: 'succeeded',
      resultDigest: hash(String(index + 1)), value: 'approve', distribution: null, uncertaintyProfile: member.uncertaintyProfile }));
    const aggregate = aggregateEnsembleResults(choice, results);
    expect(validateEnsembleAggregate(aggregate)).toBe(aggregate);
    expect(aggregate.correctnessGate).toEqual({ status: 'not-satisfied', reason: 'agreement-is-not-correctness-evidence' });
    expect(Object.keys(aggregate)).not.toContain('calibratedCorrectness');
    for (const forged of [
      { ...aggregate, calibratedCorrectness: 1 },
      { ...aggregate, correctnessGate: { status: 'satisfied', reason: 'agreement-is-not-correctness-evidence' } },
      { ...aggregate, statistics: { ...aggregate.statistics, calibratedProbability: 0.99 } },
      { ...aggregate, semantics: 'calibrated-correctness' },
    ]) expect(rejection(() => validateEnsembleAggregate(forged)).layer).toBe('schema');
    expect(rejection(() => validateEnsembleAggregate({ ...aggregate, warnings: [] })).details).toContain('aggregate digest does not match its content');
  });
});

describe('ENS D17 budget validation mirrors GraphBudgetLedger', () => {
  it('ENS-BUD-01 plans all-or-nothing reservations and treats every attempt as consumed', () => {
    const plan = planEnsembleBudget(choice);
    expect(plan.reservations).toHaveLength(3);
    expect(plan.reservations.every(item => item.attempts >= 1 && Number.isSafeInteger(item.tokens) && Number.isSafeInteger(item.costMicros))).toBe(true);
    expect(plan.demand).toEqual({ members: 3, attempts: 6, tokens: 6000, costMicros: 6000, concurrency: 3, deadlineMs: 20000, fallbackDepth: 1 });
    expect(plan.effective).toEqual({ members: 3, attempts: 9, deadlineMs: 60000, tokens: 30000, costMicros: 30000, concurrency: 3, fallbackDepth: 1 });
  });

  it('ENS-BUD-02 takes the minimum of host ceiling layers and rejects an oversized policy before dispatch', () => {
    expect(planEnsembleBudget(choice, [{ attempts: 100 }, { tokens: 6000 }]).effective.tokens).toBe(6000);
    const lowered = rejection(() => planEnsembleBudget(choice, [{ costMicros: 4000 }]));
    expect(lowered.details).toContain('ensemble costMicros demand 6000 exceeds ceiling 4000');
    // A narrower concurrency layer serializes samples and so lengthens the conservative deadline.
    expect(planEnsembleBudget(choice, [{ concurrency: 1 }]).demand.deadlineMs).toBe(60000);
    expect(rejection(() => planEnsembleBudget(choice, [{ concurrency: 1, deadlineMs: 50000 }])).details).toContain('ensemble deadlineMs demand 60000 exceeds ceiling 50000');
    expect(rejection(() => planEnsembleBudget(choice, [{ attempts: 0 }])).message).toBe('invalid host ceiling attempts');
    expect(rejection(() => planEnsembleBudget(choice, [{ tokens: 1.5 }])).message).toBe('invalid host ceiling tokens');
  });

  it('ENS-BUD-03 reserves a trusted bound for unknown cost only when the policy says so', () => {
    const noul = policies.get('eligibility-noul-ensemble')!;
    const plan = planEnsembleBudget(noul);
    expect(plan.reservations.find(item => item.memberId === 'jev-eu')!.costMicros).toBe(3000);
    expect(plan.demand.costMicros).toBe(7000);
    const rejecting = applyPatch(noul, [{ op: 'replace', path: '/ceilings/unknownCost', value: { rule: 'reject' } }]);
    expect(rejection(() => planEnsembleBudget(rejecting)).details[0]).toContain('unknown cost');
  });
});

describe('ENS D17 composes with the D09 calibration registry', () => {
  const identity = (actualModel: string): CalibrationIdentity => ({
    provider: 'jev', backend: 'api', actualModel, primitive: 'choice', definitionDigest: hash('a'), adapterVersion: '1.0.0',
    dataset: { id: 'triage', hash: hash('b') }, slice: { id: 'all', hash: hash('c') }, calibrator: { id: 'isotonic', version: '1', parametersDigest: hash('d') },
  });
  const pin = (overrides: Partial<CompatibilityDecision>): CompatibilityDecision => ({
    schemaVersion: 'decision-calibration-compatibility/v1', pinId: 'run:pin', runId: 'run', requestedAlias: 'jev-latest', actualModel: 'jev-2026-09-01',
    aliasRevision: 1, artifactId: 'cal-jev-a', artifactDigest: hash('e'), state: 'exact', action: 'allow', reasons: [], decidedAt: '2026-09-10T00:00:00.000Z', ...overrides,
  });

  it('ENS-CAL-01 refuses a member whose D09 compatibility pin is not an allow for its pinned artifact', () => {
    expect(() => validateEnsemblePolicy(choice, { calibrationPins: { 'jev-a': pin({}) } })).not.toThrow();
    for (const overrides of [{ action: 'shadow' as const, state: 'shadow-required' as const }, { artifactDigest: hash('9') }, { state: 'unknown' as const, action: 'defer' as const }]) {
      expect(rejection(() => validateEnsemblePolicy(choice, { calibrationPins: { 'jev-a': pin(overrides) } })).details[0]).toContain('calibration is incompatible');
    }
    expect(rejection(() => validateEnsemblePolicy(choice, { calibrationPins: {} })).details[0]).toContain('no resolved calibration compatibility pin');
  });

  it('ENS-CAL-02 champion/challenger promotion requires the matching eligible D09 record and exact rollback history', () => {
    const registry = new CalibrationRegistry();
    const champion = registry.observeAlias('jev-latest', identity('jev-2026-07-15'), '2026-09-01T00:00:00.000Z');
    const candidate = identity('jev-2026-09-01');
    const record = structuredClone(cc);
    record.champion.identityDigest = champion.actualIdentityDigest; record.rollbackTarget.identityDigest = champion.actualIdentityDigest;
    record.challenger.identityDigest = calibrationIdentityDigest(candidate);
    const eligibility = registry.recordPromotionEligibility({ id: record.eligibilityId, alias: 'jev-latest', candidateIdentityDigest: record.challenger.identityDigest,
      candidateActualModel: 'jev-2026-09-01', evaluationIntegrityReport: record.evaluationIntegrityReport, approvalReference: record.approval.reference,
      rollbackTarget: { aliasRevision: 1, identityDigest: champion.actualIdentityDigest }, eligible: true, reasons: [], recordedAt: '2026-09-05T00:00:00.000Z' });
    expect(() => validateChampionChallenger(record, { eligibility, aliasHistory: registry.aliasHistory('jev-latest') })).not.toThrow();
    const denied = { ...eligibility, id: 'elig-denied', eligible: false, reasons: ['calibration-bound-exceeded'] };
    expect(rejection(() => validateChampionChallenger(record, { eligibility: denied })).details).toEqual(expect.arrayContaining(['eligibility-id-mismatch', 'eligibility-not-eligible']));
    const otherReport = { ...eligibility, evaluationIntegrityReport: { id: 'other', digest: hash('7') } };
    expect(rejection(() => validateChampionChallenger(record, { eligibility: otherReport })).details).toContain('eligibility-integrity-report-mismatch');
    const moved = registry.aliasHistory('jev-latest').map(event => event.revision === 1 ? { ...event, actualIdentityDigest: hash('0') } : event);
    expect(rejection(() => validateChampionChallenger(record, { aliasHistory: moved })).details).toContain('rollback target no longer matches immutable alias history');
  });

  it('ENS-CAL-03 refuses a policy before aggregation when members are incompatible', () => {
    const mismatch = applyPatch(choice, [{ op: 'replace', path: '/members/1/primitive', value: 'truth-probability' }]);
    expect(() => checkEnsembleSchema('policy', mismatch)).not.toThrow();
    expect(rejection(() => aggregateEnsembleResults(mismatch, [])).details[0]).toContain('primitive mismatch');
  });
});
