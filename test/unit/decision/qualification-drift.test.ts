import { describe, expect, it } from 'vitest';
import { measureCategoricalDrift, measureLabelStability } from '../../../src/decision/qualification/drift.js';

const plan = { minimumN: 20, maximumTotalVariation: 0.1, maximumPopulationStability: 0.2 };
const repeat = (counts: Record<string, number>) => Object.entries(counts).flatMap(([label, n]) => Array<string>(n).fill(label));

describe('decision qualification drift measures', () => {
  it('reports total variation and PSI for identical, shifted and new-category samples', () => {
    const reference = repeat({ a: 10, b: 10 });
    expect(measureCategoricalDrift(reference, [...reference].reverse(), plan)).toMatchObject({
      decision: 'stable', totalVariation: 0, populationStability: 0, reasons: [] });
    const shifted = measureCategoricalDrift(reference, repeat({ a: 18, b: 2 }), plan);
    expect(shifted.totalVariation).toBeCloseTo(0.4);
    expect(shifted).toMatchObject({ decision: 'drift', reasons: ['total-variation', 'population-stability'] });
    const added = measureCategoricalDrift(reference, repeat({ a: 10, b: 8, c: 2 }), plan);
    expect(added.categories).toEqual(['a', 'b', 'c']);
    expect(added.reference.c).toBe(0);
    expect(Number.isFinite(added.populationStability)).toBe(true);
  });

  it('never reports stable from too few samples and rejects invalid plans or values', () => {
    expect(measureCategoricalDrift(['a'], ['a'], plan)).toMatchObject({ decision: 'insufficient-evidence', reasons: ['insufficient-samples'] });
    expect(() => measureCategoricalDrift(['a'], ['a'], { ...plan, minimumN: 0 })).toThrow();
    expect(() => measureCategoricalDrift(['a'], ['a'], { ...plan, maximumTotalVariation: 2 })).toThrow();
    expect(() => measureCategoricalDrift(['a', ' '], ['a'], plan)).toThrow();
  });

  it('decides label stability from the whole Wilson interval', () => {
    const pairs = (changed: number, n: number) => Array.from({ length: n }, (_, index) => ({
      id: `p${index}`, control: 'x', observed: index < changed ? 'y' : 'x' }));
    expect(measureLabelStability(pairs(0, 100), 0.05).decision).toBe('stable');
    expect(measureLabelStability(pairs(30, 100), 0.05).decision).toBe('drift');
    expect(measureLabelStability(pairs(5, 100), 0.05).decision).toBe('insufficient-evidence');
    expect(() => measureLabelStability(pairs(0, 10), 1.5)).toThrow();
  });
});
