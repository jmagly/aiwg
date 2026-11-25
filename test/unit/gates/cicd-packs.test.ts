import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadGatePackFile } from '../../../src/gates/discovery.js';
import { gateStatusOutcome } from '../../../src/gates/evaluate.js';
import { evaluateObservation, expandScope } from '../../../src/gates/observations.js';
import { createCoreProviderRegistry, scalarProvider } from '../../../src/gates/providers/index.js';
import { validateResolvedPack } from '../../../src/gates/pack-validation.js';
import { validateGateDocument } from '../../../src/gates/schema.js';
import type { GateDefinition, GatePack } from '../../../src/gates/types.js';

const bundle = join(process.cwd(), 'agentic/code/frameworks/cicd-complete');
const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));
const load = (name: string) => loadGatePackFile(join(bundle, 'gate-packs', `${name}.gatepack.yaml`));

function outcome(pack: GatePack, gate: GateDefinition, value: number | null) {
  const parameters = Object.fromEntries(Object.entries(pack.spec.parameters ?? {})
    .map(([name, parameter]) => [`${pack.metadata.id}.${name}`, parameter.default!]));
  const result = evaluateObservation(gate, value === null ? null : { n: 1, value }, {
    packId: pack.metadata.id, parameters, metrics: { providers: {} },
    upstream: null, nowMs: 0, slice: gate.scope.slices![0]!, slices: gate.scope.slices!,
  });
  return gateStatusOutcome(result.status, gate);
}

describe('cicd gate packs', () => {
  it('registers exactly the authored files and validates shape and core metric contracts', () => {
    expect(manifest.gatePacks).toEqual(['coverage-floor', 'build-time-budget', 'progressive-rollout-health']);
    expect(readdirSync(join(bundle, 'gate-packs')).sort())
      .toEqual(manifest.gatePacks.map((name: string) => `${name}.gatepack.yaml`).sort());
    for (const name of manifest.gatePacks) {
      const pack = load(name);
      expect(pack.metadata.id).toBe(`aiwg:cicd-complete/${name}`);
      validateGateDocument<GatePack>(pack);
      validateResolvedPack(pack, createCoreProviderRegistry());
    }
  });

  it.each([
    ['coverage-floor', 80, 79.99],
    ['build-time-budget', 600, 600.01],
  ] as const)('%s holds breaches and missing observations', (name, boundary, breach) => {
    const pack = load(name);
    const gate = pack.spec.gates[0]!;
    expect(outcome(pack, gate, boundary)).toBe('PROMOTE');
    expect(outcome(pack, gate, breach)).toBe('HOLD');
    expect(outcome(pack, gate, null)).toBe('HOLD');
  });

  it('holds before propagation and rolls back health breaches using independent slices', () => {
    const pack = load('progressive-rollout-health');
    const [propagation, errors, latency] = pack.spec.gates as [GateDefinition, GateDefinition, GateDefinition];
    expect(outcome(pack, propagation, 119)).toBe('HOLD');
    expect(outcome(pack, propagation, 120)).toBe('PROMOTE');
    expect(outcome(pack, errors, 0.01)).toBe('PROMOTE');
    expect(outcome(pack, errors, 0.0101)).toBe('ROLLBACK');
    expect(outcome(pack, latency, 500)).toBe('PROMOTE');
    expect(outcome(pack, latency, 501)).toBe('ROLLBACK');
    expect(outcome(pack, errors, null)).toBe('HOLD');
    expect(outcome(pack, latency, null)).toBe('HOLD');
    const series = scalarProvider.compute([
      { slice: 'propagation-age-seconds', value: 120 },
      { slice: 'error-rate', value: 0.02 },
      { slice: 'latency-p95-ms', value: 100 },
    ]).metrics.measurement!;
    expect(expandScope(errors, 'scalar', series, Object.keys(series.bySlice)))
      .toEqual([{ slice: 'error-rate', observation: { n: 1, value: 0.02 } }]);
  });

  it('rejects an unknown threshold parameter and a reversed coverage floor', () => {
    const missing = structuredClone(load('coverage-floor'));
    missing.spec.gates[0]!.threshold!.param = 'unknownFloor';
    expect(() => validateResolvedPack(missing, createCoreProviderRegistry())).toThrow(/unknown parameter/);
    const reversed = structuredClone(load('coverage-floor'));
    reversed.spec.gates[0]!.direction = 'lower-is-stricter';
    expect(() => validateResolvedPack(reversed, createCoreProviderRegistry())).toThrow(/gte requires direction/);
  });
});
