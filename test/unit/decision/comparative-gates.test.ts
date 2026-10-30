// Exercise the D23 binding adapter directly, without the report builder's deduplication.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { artifactDigest } from '../../../src/decision/validate.js';
import { buildComparativeReplayReport, type ComparativeReplayInput,
  type ComparativeReplayReport } from '../../../src/decision/sensitivity/comparative.js';
import { comparativeReplayGateFindings, comparativeReplayGateInput } from '../../../src/decision/sensitivity/comparative-gates.js';
import { evaluateGates, sealGateHoldout } from '../../../src/gates/evaluate.js';
import { evidenceProvider } from '../../../src/gates/providers/index.js';

const directory = resolve(import.meta.dirname, '../../../docs/decision/evidence/comparative-replay-v1');
const read = (name: string) => JSON.parse(readFileSync(resolve(directory, name), 'utf8'));
const retained: ComparativeReplayReport = read('report.json');

function fixture() {
  const preregistration = read('preregistration.json');
  const integrity = { ...structuredClone(retained.integrity), integrity_mode: 'locked', integrity_state: 'verified',
    trusted_score_source: 'locked-artifact-snapshot', weak_signal_reason: null,
    release_gate: { decision: 'PROMOTE' as const, reasons: [] } };
  const input: ComparativeReplayInput = { preregistration, trustedPreregistrationDigest: preregistration.digest,
    roots: [], members: [], integrity, trustedIntegrityDigest: artifactDigest(integrity),
    accessedAt: retained.accessedAt, reviewerAuditDigest: null };
  return { input, rows: structuredClone(retained.roots), usage: retained.metrics };
}

describe('D23 binding policy parameters', () => {
  it('changes PROMOTE to HOLD when only the binding margin is tightened, including equality', () => {
    const { input, rows, usage } = fixture();
    const context = comparativeReplayGateInput(input, rows, usage, new Set());
    // Synthetic completed review permits testing the raw decision; production review remains pending.
    context.metrics.providers[evidenceProvider.id]!.metrics.attestations!.pooled!.available!
      .find(item => item.id === 'reviewer-audit-pending')!.passed = true;
    const parameter = 'project:d23-comparative-replay.nonInferiorityMarginBps';
    expect(context.binding.spec.parameters[parameter]).toBe(-100);
    expect(evaluateGates(context).decision).toBe('PROMOTE');
    for (const [margin, decision] of [[-96, 'PROMOTE'], [-95, 'HOLD']] as const) {
      context.binding.spec.parameters[parameter] = margin;
      expect(() => evaluateGates(context)).toThrow(/digest/);
      context.trustedBindingDigest = artifactDigest(context.binding);
      context.holdout = sealGateHoldout({ frozenDigest: context.trustedBindingDigest, firstAccessedAt: input.accessedAt });
      const changed = evaluateGates(context);
      expect(changed.decision).toBe(decision);
      expect(changed.gateEvidence.find(item => item.gateId === 'non-inferiority-failed')).toMatchObject({
        status: decision === 'PROMOTE' ? 'pass' : 'fail', threshold: { resolved: margin },
        statistic: { method: 'newcombe', lowerBps: -96 },
      });
    }
    expect(input.preregistration.nonInferiorityMarginBps).toBe(-100);
  });

  it.each([['pairedMethod', 'tango'], ['errorMethod', 'clopper-pearson']] as const)(
    'refuses a different %s at both the raw adapter and report boundary', (method, value) => {
      const { input, rows, usage } = fixture();
      Object.assign(input.preregistration, { [method]: value });
      expect(() => comparativeReplayGateInput(input, rows, usage, new Set()))
        .toThrow('requires pairedMethod newcombe-10 and errorMethod wilson');
      expect(() => buildComparativeReplayReport(input)).toThrow(/schema/);
    });

  it('deduplicates a slice failing all three sub-gates before findings leave the adapter', () => {
    const { input, rows, usage } = fixture();
    const index = rows.findIndex(row => row.split === 'test' && row.slice === 'threshold-boundary');
    rows.splice(index, 1);
    rows.find(row => row.split === 'test' && row.slice === 'threshold-boundary')!.correct = false;
    input.integrity.sample_n = 399;
    const context = comparativeReplayGateInput(input, rows, usage, new Set());
    const report = evaluateGates(context);
    expect(report.gateEvidence.filter(gate => gate.slice === 'threshold-boundary')
      .map(gate => [gate.gateId, gate.status])).toEqual([
      ['slice-support', 'insufficient'], ['slice-errors', 'fail'], ['slice-error-bound', 'fail'],
    ]);
    const translated = comparativeReplayGateFindings(report);
    expect(translated.diagnosticDecision).toBe('fail');
    expect(translated.findings.filter(finding => finding === 'slice-failed:threshold-boundary')).toHaveLength(1);
    expect(translated.findings).toEqual([...new Set(translated.findings)]);
  });
});
