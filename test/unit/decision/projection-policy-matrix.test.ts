import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  dispatchProjectedDecisionState,
  evaluateDecisionRuleset,
  type AdapterObservation,
  type DecisionAdapter,
  type DecisionAdapterEgress,
  type DecisionBinding,
  type DecisionDefinition,
  type DecisionEvaluationRequest,
  type DecisionProjectionField,
  type DecisionProjectionPolicy,
  type DecisionRuleset,
} from '../../../src/decision/index.js';

// #2597 AC2 / evidence plan: table-driven policy matrix across data class, trust,
// purpose, provider, model, origin, region and retention, with allow, deny and
// unknown values. Every non-allowed cell must make zero credential and dispatch calls.

type Outcome = 'allow' | 'data-boundary-denied' | 'invalid-policy';
interface Cell { value: string; outcome: Outcome; apply(policy: DecisionProjectionPolicy, field: DecisionProjectionField): void }

const DIMENSIONS: Record<string, Cell[]> = {
  sensitivity: [
    { value: 'public', outcome: 'allow', apply: (_p, f) => { f.sensitivity = 'public'; } },
    { value: 'internal', outcome: 'allow', apply: (_p, f) => { f.sensitivity = 'internal'; } },
    { value: 'confidential', outcome: 'allow', apply: (_p, f) => { f.sensitivity = 'confidential'; } },
    // Data-class rule: restricted needs an explicit ceiling AND no export or persistence.
    { value: 'restricted-default-ceiling', outcome: 'data-boundary-denied', apply: (_p, f) => { f.sensitivity = 'restricted'; } },
    { value: 'restricted-explicit-ceiling', outcome: 'allow', apply: (p, f) => {
      p.maxSensitivity = 'restricted'; f.sensitivity = 'restricted'; f.exportPolicy = 'denied'; } },
    { value: 'restricted-exportable', outcome: 'invalid-policy', apply: (p, f) => {
      p.maxSensitivity = 'restricted'; f.sensitivity = 'restricted'; f.exportPolicy = 'sanitized'; } },
    { value: 'internal-over-public-ceiling', outcome: 'data-boundary-denied', apply: (p, f) => {
      p.maxSensitivity = 'public'; f.sensitivity = 'internal'; } },
    { value: 'unknown', outcome: 'invalid-policy', apply: (_p, f) => { (f as { sensitivity: string }).sensitivity = 'unknown'; } },
  ],
  trust: [
    { value: 'verified', outcome: 'allow', apply: (_p, f) => { f.trust = 'verified'; } },
    { value: 'untrusted', outcome: 'allow', apply: (_p, f) => { f.trust = 'untrusted'; } },
    { value: 'unknown', outcome: 'invalid-policy', apply: (_p, f) => { (f as { trust: string }).trust = 'unknown'; } },
  ],
  purpose: [
    { value: 'authorized', outcome: 'allow', apply: () => undefined },
    { value: 'denied', outcome: 'data-boundary-denied', apply: p => { p.purpose = 'model-training'; } },
    { value: 'unknown', outcome: 'invalid-policy', apply: (_p, f) => { f.purpose = ''; } },
  ],
  provider: [
    { value: 'authorized', outcome: 'allow', apply: () => undefined },
    { value: 'denied', outcome: 'data-boundary-denied', apply: p => { p.provider = 'other-provider'; } },
    { value: 'unknown', outcome: 'invalid-policy', apply: (_p, f) => { f.allowedProviders = []; } },
  ],
  model: [
    { value: 'authorized', outcome: 'allow', apply: () => undefined },
    { value: 'denied', outcome: 'data-boundary-denied', apply: p => { p.model = 'unapproved-model'; } },
    { value: 'unknown', outcome: 'invalid-policy', apply: (_p, f) => { f.allowedModels = []; } },
  ],
  origin: [
    { value: 'authorized', outcome: 'allow', apply: () => undefined },
    { value: 'denied', outcome: 'data-boundary-denied', apply: p => { p.origin = 'https://other.example'; } },
    { value: 'unknown', outcome: 'invalid-policy', apply: p => { p.origin = 'http://api.typesafe.ai'; } },
  ],
  region: [
    { value: 'authorized', outcome: 'allow', apply: () => undefined },
    { value: 'denied', outcome: 'data-boundary-denied', apply: p => { p.region = 'eu'; } },
    { value: 'unknown', outcome: 'data-boundary-denied', apply: (p, f) => { p.region = 'unknown'; f.allowedRegions.push('unknown'); } },
  ],
  retention: [
    { value: 'declared', outcome: 'allow', apply: () => undefined },
    { value: 'unknown', outcome: 'invalid-policy', apply: (_p, f) => { f.retentionClass = ''; } },
  ],
};

function basePolicy(): DecisionProjectionPolicy {
  return {
    version: '1.0.0', provider: 'jev', model: 'jev-latest', origin: 'https://api.typesafe.ai', region: 'us',
    purpose: 'triage', allowIncompleteContext: false,
    fields: [{ pointer: '/message', output: 'excerpt', source: 'caller', subject: 'ticket:42', trust: 'untrusted',
      sensitivity: 'internal', purpose: 'triage', retentionClass: 'ephemeral', accessScopes: ['decision-runtime'],
      exportPolicy: 'sanitized', deletionPolicy: 'erase', backupPolicy: 'not-persisted', allowedProviders: ['jev'],
      allowedModels: ['jev-latest'], allowedOrigins: ['https://api.typesafe.ai'], allowedRegions: ['us'] }],
  };
}

function* cells(): Generator<Array<[string, Cell]>> {
  const names = Object.keys(DIMENSIONS);
  const indexes = names.map(() => 0);
  for (;;) {
    yield names.map((name, index) => [name, DIMENSIONS[name]![indexes[index]!]!]);
    let position = names.length - 1;
    while (position >= 0 && ++indexes[position]! === DIMENSIONS[names[position]!]!.length) indexes[position--] = 0;
    if (position < 0) return;
  }
}

async function run(combination: Array<[string, Cell]>) {
  const policy = basePolicy();
  for (const [, cell] of combination) cell.apply(policy, policy.fields[0]!);
  const resolveCredential = vi.fn(async () => 'credential');
  const dispatch = vi.fn(async () => 'sent');
  try {
    await dispatchProjectedDecisionState({ message: 'fixture', adjacent: 'must-not-cross' }, policy, { resolveCredential, dispatch });
    return { outcome: 'allow' as Outcome, resolveCredential, dispatch };
  } catch (error) {
    return { outcome: (error as { reason: Outcome }).reason, resolveCredential, dispatch };
  }
}

describe('D10 projection policy matrix (#2597 AC2)', () => {
  it('PRV-EGRESS-MATRIX-01 allows only fully authorized cells and denies every other cell before credentials', async () => {
    let total = 0;
    const tally: Record<Outcome, number> = { allow: 0, 'data-boundary-denied': 0, 'invalid-policy': 0 };
    for (const combination of cells()) {
      total += 1;
      const expectedAllow = combination.every(([, cell]) => cell.outcome === 'allow');
      const deviations = combination.filter(([, cell]) => cell.outcome !== 'allow');
      const { outcome, resolveCredential, dispatch } = await run(combination);
      tally[outcome] += 1;
      const label = combination.map(([name, cell]) => `${name}=${cell.value}`).join(',');
      if (expectedAllow) {
        expect(outcome, label).toBe('allow');
        expect(dispatch, label).toHaveBeenCalledOnce();
        expect(JSON.stringify(dispatch.mock.calls[0]), label).not.toContain('must-not-cross');
      } else {
        expect(['data-boundary-denied', 'invalid-policy'], label).toContain(outcome);
        expect(resolveCredential, label).not.toHaveBeenCalled();
        expect(dispatch, label).not.toHaveBeenCalled();
        // A single deviation must produce that dimension's exact typed category.
        if (deviations.length === 1) expect(outcome, label).toBe(deviations[0]![1].outcome);
      }
    }
    const expectedTotal = Object.values(DIMENSIONS).reduce((product, values) => product * values.length, 1);
    expect(total).toBe(expectedTotal);
    const allowed = Object.values(DIMENSIONS).reduce((product, values) =>
      product * values.filter(cell => cell.outcome === 'allow').length, 1);
    expect(tally.allow).toBe(allowed);
    expect(tally['data-boundary-denied']).toBeGreaterThan(0);
    expect(tally['invalid-policy']).toBeGreaterThan(0);
  }, 60_000);
});

// Evaluator-level cells: projection presence x adapter destination x policy destination.
const fixture = <T>(name: string): T => JSON.parse(readFileSync(`examples/decision/${name}`, 'utf8')) as T;

class MatrixAdapter implements DecisionAdapter {
  readonly id = 'jev';
  readonly version = '1.0.0';
  readonly evaluate = vi.fn(async (request: { alias: string }): Promise<AdapterObservation> => ({
    status: 'success', reason: 'none',
    value: request.alias === 'category' ? 'documentation' : request.alias === 'severity' ? 0.25 : 0.05,
    uncertainty: { source: 'provider', profile: request.alias === 'core_unavailable' ? 'typesafe-truth-v1' : 'typesafe-distribution-v1',
      calibration: 'vendor-claimed', confidence: 0.9, distribution: null, calibrationRef: null },
    actualModel: 'fixture-model', usage: { inputTokens: 1, outputTokens: 1, costUsd: null }, requestId: null,
  }));
  constructor(private readonly egress: DecisionAdapterEgress | undefined) {}
  async capabilities() {
    return { answerKinds: ['choice', 'ordinal-score', 'truth-probability'] as Array<'choice' | 'ordinal-score' | 'truth-probability'>,
      features: ['choice', 'ordinal-score', 'truth-probability'], maxOptions: 255, maxLevels: 10,
      confidenceProfiles: ['typesafe-distribution-v1', 'typesafe-truth-v1'], executable: true,
      ...(this.egress ? { egress: this.egress } : {}) };
  }
}

describe('D10 evaluator egress matrix (#2597 AC2, AC11)', () => {
  const network = (origin: string | null, region: string | null): DecisionAdapterEgress => ({ mode: 'network', origin, region });
  const withPolicy = (overrides: Partial<DecisionProjectionPolicy> = {}): DecisionEvaluationRequest['projection'] =>
    ({ resolve: () => ({ ...basePolicy(), ...overrides,
      fields: basePolicy().fields.map(field => ({ ...field, allowedOrigins: ['https://api.typesafe.ai', 'https://other.example'],
        allowedRegions: ['us', 'eu'] })) }) });
  it.each([
    ['no policy, undeclared adapter', undefined, undefined, false],
    ['no policy, network adapter', network('https://api.typesafe.ai', 'us'), undefined, false],
    ['no policy, no-egress adapter', { mode: 'none' } as const, undefined, true],
    ['host opt-out, network adapter', network('https://api.typesafe.ai', 'us'), { mode: 'unprojected-local' } as const, true],
    ['policy, matching destination', network('https://api.typesafe.ai', 'us'), withPolicy(), true],
    ['policy, origin mismatch', network('https://api.typesafe.ai', 'us'), withPolicy({ origin: 'https://other.example' }), false],
    ['policy, region mismatch', network('https://api.typesafe.ai', 'us'), withPolicy({ region: 'eu' }), false],
    ['policy, adapter region unknown', network('https://api.typesafe.ai', null), withPolicy(), false],
    ['policy, adapter origin unknown', network(null, 'us'), withPolicy(), false],
    ['policy, undeclared adapter', undefined, withPolicy(), false],
    ['policy, no-egress adapter', { mode: 'none' } as const, withPolicy(), true],
  ] as const)('PRV-EGRESS-MATRIX-02 %s', async (_name, egress, projection, allowed) => {
    const adapter = new MatrixAdapter(egress as DecisionAdapterEgress | undefined);
    const resolveCredential = vi.fn(async () => new TextEncoder().encode('fixture'));
    const definitions: Record<string, DecisionDefinition> = { category: fixture('decision-category.json'),
      severity: fixture('decision-severity.json'), core: fixture('decision-core_unavailable.json') };
    const result = await evaluateDecisionRuleset({
      ruleset: fixture<DecisionRuleset>('ruleset.json'), binding: fixture<DecisionBinding>('binding-jev.json'), definitions,
      input: { message: 'fixture' }, runId: 'matrix', invocationId: 'matrix', adapters: { jev: adapter }, resolveCredential,
      ...(projection ? { projection: projection as DecisionEvaluationRequest['projection'] } : {}),
    });
    if (allowed) {
      expect(result.spec.status).toBe('completed');
      expect(adapter.evaluate).toHaveBeenCalledTimes(3);
    } else {
      expect(Object.values(result.spec.evaluations).every(value => value.spec.reason === 'data-boundary-denied')).toBe(true);
      expect(adapter.evaluate).not.toHaveBeenCalled();
      expect(resolveCredential).not.toHaveBeenCalled();
    }
  });
});
