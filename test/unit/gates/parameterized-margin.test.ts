// Guard signed paired-margin references, inheritance and project floor enforcement.
import { describe, expect, it } from 'vitest';
import { artifactDigest } from '../../../src/decision/validate.js';
import { evaluateGates } from '../../../src/gates/evaluate.js';
import { resolveProjectFloors } from '../../../src/gates/floors.js';
import { assertGateTightens, GateRegistryError } from '../../../src/gates/registry.js';
import type { GateDefinition, GatePack, GateParameter } from '../../../src/gates/types.js';
import { qualifyGateParameter } from '../../../src/gates/types.js';
import { makeBindingForPack, makeUpstream, NOW, passingMetrics, projectPack,
  testHoldout, testRegistry } from '../../conformance/gates-v1/helper.js';

function marginPack(): GatePack {
  const pack = projectPack('project:paired-margin');
  pack.spec.parameters = { margin: { type: 'value', direction: 'higher-is-stricter', default: -250 } };
  pack.spec.gates = pack.spec.gates.filter(gate => ['contrast-ni', 'integrity-ceiling'].includes(gate.id));
  pack.spec.gates[0]!.onFail = 'HOLD';
  pack.spec.gates[0]!.statistic!.marginBps = { param: 'margin' };
  return pack;
}

function fixture(pack = marginPack()) {
  const { registry } = testRegistry();
  registry.registerPack(pack, { namespace: 'project' });
  const binding = makeBindingForPack(pack);
  const evaluate = (floors: Parameters<typeof evaluateGates>[0]['floors'] = 'none-explicit-opt-out') => evaluateGates({
    binding, registry, trustedBindingDigest: artifactDigest(binding), holdout: testHoldout(binding),
    metrics: passingMetrics(), upstream: makeUpstream('promote'), now: NOW, floors,
  });
  return { binding, registry, evaluate };
}

describe('paired margin binding parameters', () => {
  it('resolves negative defaults, fails a tightened binding, and refuses missing required values', () => {
    const pack = marginPack();
    const { binding, evaluate } = fixture(pack);
    const key = qualifyGateParameter(pack.metadata.id, 'margin');
    delete binding.spec.parameters[key];
    expect(evaluate().decision).toBe('PROMOTE');
    binding.spec.parameters[key] = 0;
    expect(evaluate()).toMatchObject({ decision: 'HOLD', gateEvidence: expect.arrayContaining([
      expect.objectContaining({ gateId: 'contrast-ni', status: 'fail', threshold: { op: 'gte', resolved: 0 } }),
    ]) });
    delete pack.spec.parameters!.margin!.default;
    const required = fixture(pack);
    delete required.binding.spec.parameters[key];
    expect(() => required.evaluate()).toThrow(/missing required parameter/);
  });

  it.each([1, -10001, 0.5])('refuses an invalid resolved NI margin %s', margin => {
    const { binding, evaluate } = fixture();
    binding.spec.parameters['project:paired-margin.margin'] = margin;
    expect(() => evaluate()).toThrow(/marginBps/);
  });

  it.each([
    ['unknown', undefined],
    ['type', { type: 'bps', direction: 'higher-is-stricter', default: 0 }],
    ['direction', { type: 'value', direction: 'lower-is-stricter', default: -250 }],
    ['default', { type: 'value', direction: 'higher-is-stricter', default: 1 }],
  ] as Array<[string, GateParameter | undefined]>)('refuses an invalid margin declaration: %s', (_name, parameter) => {
    const pack = marginPack();
    pack.spec.parameters = parameter ? { margin: parameter }
      : { unrelated: { type: 'value', direction: 'higher-is-stricter' } };
    expect(() => fixture(pack)).toThrow(GateRegistryError);
  });

  it('retains strict superiority semantics for a parameterized margin', () => {
    const pack = marginPack();
    pack.spec.parameters!.margin!.default = 0;
    pack.spec.gates[0]!.statistic!.mode = 'superiority';
    const { binding, evaluate } = fixture(pack);
    expect(evaluate().decision).toBe('HOLD');
    binding.spec.parameters['project:paired-margin.margin'] = -1;
    expect(() => evaluate()).toThrow(/superiority marginBps must be non-negative/);
  });

  it('prevents inherited margin references from being renamed, rebound or loosened', () => {
    const pack = marginPack();
    const gate = pack.spec.gates[0]!;
    const params = pack.spec.parameters!;
    const changed = (marginBps: NonNullable<GateDefinition['statistic']>['marginBps']): GateDefinition =>
      ({ ...gate, statistic: { ...gate.statistic!, marginBps } });
    expect(() => assertGateTightens(gate, changed(-249), params)).not.toThrow();
    expect(() => assertGateTightens(gate, changed(-251), params)).toThrow(/only raise marginBps/);
    expect(() => assertGateTightens(gate, changed({ param: 'renamed' }), params)).toThrow(/rename.*marginBps/);
    expect(() => assertGateTightens(changed(-250), gate, params)).toThrow(/literal marginBps/);
    expect(() => assertGateTightens(gate, changed(-249), { margin: { ...params.margin!, default: undefined } }))
      .toThrow(/unresolvable/);
    const { registry } = fixture(pack);
    const child = structuredClone(pack);
    child.metadata.id = 'project:paired-margin-child';
    child.spec.extends = { id: pack.metadata.id, version: pack.metadata.version, digest: artifactDigest(pack) };
    child.spec.parameters!.margin!.default = -251;
    expect(() => registry.registerPack(child, { namespace: 'project' })).toThrow(/default loosens/);
  });

  it('enforces a defaulted project floor against the materialized binding margin', () => {
    const floor = marginPack();
    const { binding, evaluate } = fixture();
    const floors = resolveProjectFloors({ floors: [{ pack: floor }] });
    expect(evaluate(floors).decision).toBe('PROMOTE');
    binding.spec.parameters['project:paired-margin.margin'] = -251;
    expect(() => evaluate(floors)).toThrow(/loosens project floor gate 'contrast-ni'/);
    delete floor.spec.parameters!.margin!.default;
    expect(() => evaluate(resolveProjectFloors({ floors: [{ pack: floor }] }))).toThrow(/requires a default/);
  });
});
