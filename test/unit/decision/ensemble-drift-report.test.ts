import { describe, expect, it } from 'vitest';
import { CalibrationRegistry, type CalibrationIdentity, type PromotionEligibility } from '../../../src/decision/calibration/index.js';
import type { QualificationIntegrityMetadata } from '../../../src/decision/qualification/release.js';
import {
  EnsembleContractError, buildEnsembleIntegrityReport, ensembleContractDigest, integrityGateRank, resolveDriftResponse,
  validateEnsembleIntegrityReport, type DecisionChampionChallenger, type DecisionDriftResponse, type DriftSignal,
  type IntegrityGateDecision, type PairedDeltaObservation,
} from '../../../src/decision/ensemble/index.js';
import { readFixture, records } from './ensemble-fixtures.js';

const hash = (character: string) => `sha256:${character.repeat(64)}` as const;
const drift = records<DecisionDriftResponse>('drift-response.v1.valid.json').get('triage-drift-response')!;
const cc = records<DecisionChampionChallenger>('champion-challenger.v1.valid.json').get('triage-champion-challenger-2026-09')!;
type Row = { id: string; signal: DriftSignal; expected: { error: string } | { state: string; response: string | null; ruleId: string; evidence: string } };

function rejection(fn: () => unknown): EnsembleContractError {
  try { fn(); } catch (error) { if (error instanceof EnsembleContractError) return error; throw error; }
  throw new Error('expected an EnsembleContractError');
}

describe('DRF D17 drift-response table (#2679)', () => {
  const { rows, policy } = readFixture<{ policy: string; rows: Row[] }>('drift-response-table.v1.json');

  it('DRF-TABLE-00 exercises every configured response kind', () => {
    expect(policy).toBe(drift.id);
    const responses = new Set(rows.flatMap(row => 'response' in row.expected && row.expected.response ? [row.expected.response] : []));
    expect([...responses].sort()).toEqual(['alert', 'disable-challenger', 'reduce-coverage', 'require-recertification', 'restore-champion', 'route-to-review']);
  });

  for (const row of rows) {
    it(`${row.id} maps to its exact configured response`, () => {
      if ('error' in row.expected) {
        expect(rejection(() => resolveDriftResponse(drift, row.signal)).message).toContain(row.expected.error);
        return;
      }
      const decision = resolveDriftResponse(drift, row.signal);
      expect({ state: decision.state, response: decision.response, ruleId: decision.ruleId, evidence: decision.evidence }).toEqual(row.expected);
      expect(decision.policy).toEqual({ id: drift.id, version: drift.version, thresholdsVersion: drift.thresholds.version });
    });
  }

  it('DRF-REG-01 consumes AliasDriftEvent records produced by the D09 registry', () => {
    const registry = new CalibrationRegistry();
    const identity = (actualModel: string): CalibrationIdentity => ({
      provider: 'jev', backend: 'api', actualModel, primitive: 'choice', definitionDigest: hash('a'), adapterVersion: '1.0.0',
      dataset: { id: 'triage', hash: hash('b') }, slice: { id: 'all', hash: hash('c') }, calibrator: { id: 'isotonic', version: '1', parametersDigest: hash('d') },
    });
    registry.observeAlias('jev-latest', identity('jev-2026-07-15'), '2026-09-01T00:00:00.000Z');
    registry.observeAlias('jev-latest', identity('jev-2026-09-01'), '2026-09-10T00:00:00.000Z');
    const [event] = registry.driftEvents('jev-latest');
    expect(event).toBeDefined();
    expect(resolveDriftResponse(drift, { source: 'alias-drift', event: event! })).toMatchObject({
      state: 'breached', response: 'require-recertification', signalId: event!.id, evidence: 'identity-change' });
  });

  it('DRF-POL-01 refuses to resolve against an invalid drift policy', () => {
    const withoutAlias = { ...drift, rules: drift.rules.filter(rule => rule.source !== 'alias-drift') };
    const signal = readFixture<{ rows: Row[] }>('drift-response-table.v1.json').rows[0]!.signal;
    expect(rejection(() => resolveDriftResponse(withoutAlias, signal)).details).toContain('alias-drift events have no configured response');
  });
});

describe('ENS D17 eval-integrity report extension (#2037/#2048)', () => {
  const integrity = (decision: IntegrityGateDecision, overrides: Partial<QualificationIntegrityMetadata> = {}): QualificationIntegrityMetadata => ({
    sample_n: 400, uncertainty: { method: 'paired-bootstrap', level: 0.95 }, paired_baseline: { id: 'champion-shadow' },
    integrity_mode: 'isolated', fresh_workspace_required: true, fresh_workspace_verified: true, integrity_state: 'verified',
    trusted_score_source: 'signed-runner', compromise_labels: [], weak_signal_reason: null,
    release_gate: { decision, reasons: decision === 'PROMOTE' ? [] : [`upstream-${decision.toLowerCase()}`] }, ...overrides,
  });
  const deltas: PairedDeltaObservation[] = [
    { metric: 'quality', delta: 0.01, pairs: 400 }, { metric: 'calibration', delta: -0.002, pairs: 400 },
    { metric: 'risk-coverage', delta: 0.01, pairs: 400 }, { metric: 'abstention', delta: 0, pairs: 400 },
    { metric: 'latency', delta: 120, pairs: 400 }, { metric: 'tokens', delta: 40, pairs: 400 },
    { metric: 'cost', delta: 20, pairs: 400 }, { metric: 'slice', delta: -0.01, pairs: 150 },
  ];
  const eligibility: PromotionEligibility = {
    id: cc.eligibilityId, alias: cc.alias, candidateIdentityDigest: cc.challenger.identityDigest, candidateActualModel: cc.challenger.actualModel,
    evaluationIntegrityReport: cc.evaluationIntegrityReport, approvalReference: cc.approval.reference, rollbackTarget: cc.rollbackTarget,
    eligible: true, reasons: [], recordedAt: '2026-09-05T00:00:00.000Z',
  };
  const build = (decision: IntegrityGateDecision, changes: { integrity?: Partial<QualificationIntegrityMetadata>; deltas?: PairedDeltaObservation[]; eligibility?: PromotionEligibility | null } = {}) =>
    buildEnsembleIntegrityReport({ record: cc, integrity: integrity(decision, changes.integrity), pairedDeltas: changes.deltas ?? deltas,
      eligibility: changes.eligibility === undefined ? eligibility : changes.eligibility });

  it('ENS-RPT-01 promotes only with eligible D09 evidence, verified integrity and every paired delta within its bound', () => {
    const report = build('PROMOTE');
    expect(report.decision).toBe('PROMOTE');
    expect(report.findings).toEqual([]);
    expect(report.integrity).toEqual(integrity('PROMOTE'));
    expect(report.pairedDeltas.map(item => item.metric)).toEqual(['abstention', 'calibration', 'cost', 'latency', 'quality', 'risk-coverage', 'slice', 'tokens']);
    expect(report.subject).toEqual({ kind: 'champion-challenger', id: cc.id, digest: ensembleContractDigest(cc), eligibilityId: cc.eligibilityId });
    expect(validateEnsembleIntegrityReport(report)).toBe(report);
  });

  it('ENS-RPT-02 preserves HOLD and ROLLBACK even when every D17 check passes', () => {
    expect(build('HOLD').decision).toBe('HOLD');
    expect(build('ROLLBACK').decision).toBe('ROLLBACK');
    expect(build('HOLD').findings).toEqual([]);
  });

  it('ENS-RPT-03 D17 findings can only tighten the upstream decision', () => {
    const variants: Array<Parameters<typeof build>[1]> = [
      {}, { eligibility: null }, { eligibility: { ...eligibility, eligible: false, reasons: ['denied'] } },
      { deltas: deltas.map(item => item.metric === 'quality' ? { ...item, delta: -0.2 } : item) },
      { deltas: deltas.filter(item => item.metric !== 'cost') },
      { deltas: deltas.map(item => item.metric === 'latency' ? { ...item, delta: null } : item) },
      { deltas: deltas.map(item => item.metric === 'slice' ? { ...item, pairs: 5 } : item) },
      { integrity: { integrity_state: 'unverified' } }, { integrity: { weak_signal_reason: 'small-effect' } },
      { integrity: { paired_baseline: null } }, { integrity: { uncertainty: null } }, { integrity: { sample_n: 20 } },
      { integrity: { fresh_workspace_verified: false } }, { integrity: { trusted_score_source: 'local-unverified' } },
      { integrity: { integrity_mode: 'standard' } }, { integrity: { compromise_labels: ['protected-artifact-read'] } },
      { integrity: { integrity_state: 'compromised' } },
    ];
    for (const upstream of ['PROMOTE', 'HOLD', 'ROLLBACK'] as const) {
      for (const [index, variant] of variants.entries()) {
        const report = build(upstream, variant);
        expect(integrityGateRank(report.decision), `${upstream} variant ${index}`).toBeGreaterThanOrEqual(integrityGateRank(upstream));
        if (upstream !== 'PROMOTE') expect(report.decision, `${upstream} variant ${index}`).not.toBe('PROMOTE');
        if (index > 0 && upstream === 'PROMOTE') expect(report.decision, `variant ${index}`).not.toBe('PROMOTE');
      }
    }
    expect(build('PROMOTE', { integrity: { compromise_labels: ['protected-artifact-read'] } }).decision).toBe('ROLLBACK');
    expect(build('PROMOTE', { eligibility: null }).findings).toContain('d09-eligibility-missing');
    expect(build('PROMOTE', { deltas: deltas.filter(item => item.metric !== 'cost') }).findings).toContain('paired-delta-missing:cost');
  });

  it('ENS-RPT-04 rejects a forged report that upgrades HOLD or ROLLBACK to PROMOTE', () => {
    for (const upstream of ['HOLD', 'ROLLBACK'] as const) {
      const { digest: _digest, ...payload } = build(upstream);
      const forged = { ...payload, decision: 'PROMOTE' as const };
      const error = rejection(() => validateEnsembleIntegrityReport({ ...forged, digest: ensembleContractDigest(forged) }));
      expect(error.details).toContain(`D17 cannot upgrade ${upstream} to PROMOTE`);
      const relabelled = { ...payload, upstreamDecision: 'PROMOTE' as const, decision: 'PROMOTE' as const };
      expect(rejection(() => validateEnsembleIntegrityReport({ ...relabelled, digest: ensembleContractDigest(relabelled) })).details)
        .toContain('upstream decision must be the eval-integrity release gate decision');
    }
    const { digest: _digest, ...held } = build('PROMOTE', { eligibility: null });
    const promoted = { ...held, decision: 'PROMOTE' as const };
    expect(rejection(() => validateEnsembleIntegrityReport({ ...promoted, digest: ensembleContractDigest(promoted) })).details)
      .toContain('PROMOTE requires every D17 check to pass');
  });

  it('ENS-RPT-05 rejects duplicated paired observations and invalid champion/challenger records', () => {
    expect(rejection(() => build('PROMOTE', { deltas: [...deltas, deltas[0]!] })).message).toContain('duplicated');
    const { rollbackTarget: _rollbackTarget, ...withoutRollback } = cc;
    expect(rejection(() => buildEnsembleIntegrityReport({ record: withoutRollback, integrity: integrity('PROMOTE'), pairedDeltas: deltas, eligibility })).layer).toBe('schema');
  });
});
