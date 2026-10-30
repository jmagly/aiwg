// Recreate every retained D17 statistics scenario for pre-migration digest parity.
import type { D17ArmMeasurement, D17Pair } from '../../../src/decision/ensemble-study/statistics.js';

export const d17CaseNames = ['unchanged', 'extra-cost', 'quality-ni', 'benefit', 'native-quality', 'slice-support',
  'slice-harm', 'accepted-risk', 'coverage', 'abstention', 'brier', 'p95', 'inclusive-caps',
  'cost', 'tokens', 'latency', 'calibration', 'unknown-tokens', 'missing-pair', 'empty'] as const;
export function d17GateFixture(name: typeof d17CaseNames[number]) {
  const ids = Array.from({ length: 1200 }, (_, i) => `test-${i}`);
  const arm = (): D17ArmMeasurement => ({ probability: 0.9, accepted: true, correct: true,
    brier: 0.01, latencyMs: 100, tokens: 1000, reservedCostMicros: 400 });
  let pairs: D17Pair[] = ids.map((id, i) => ({ id, slice: ['direct-facts', 'multi-fact', 'negation', 'authority'][i % 4]!,
    champion: arm(), challenger: arm() }));
  if (name === 'extra-cost') for (const row of pairs) row.challenger.reservedCostMicros = 1200;
  if (name === 'quality-ni' || name === 'native-quality') {
    for (const row of pairs.slice(0, name === 'quality-ni' ? 30 : 60)) row.challenger.correct = false;
  }
  if (name === 'benefit') for (const row of pairs.slice(0, 120)) row.champion.correct = false;
  if (name === 'slice-support' || name === 'slice-harm') {
    if (name === 'slice-support') pairs[0]!.slice = 'multi-fact';
    pairs[4]!.challenger.correct = false; pairs[5]!.champion.correct = false;
  }
  if (name === 'accepted-risk') for (const row of pairs.slice(0, 48)) row.champion.correct = row.challenger.correct = false;
  if (name === 'coverage') for (const row of pairs.slice(720)) {
    row.champion.accepted = row.challenger.accepted = row.champion.correct = row.challenger.correct = false;
  }
  if (name === 'abstention') for (const row of pairs.slice(0, 48)) {
    row.champion.correct = row.challenger.correct = row.challenger.accepted = false;
  }
  if (name === 'brier') for (const [i, row] of pairs.entries()) {
    row.champion.brier = 0.25; row.challenger.brier = i < 690 ? 0.35 : 0.15;
  }
  if (name === 'p95' || name === 'inclusive-caps') {
    for (const row of pairs.slice(0, 72)) row.challenger.latencyMs += name === 'p95' ? 15001 : 15000;
    if (name === 'inclusive-caps') for (const row of pairs) row.challenger.tokens = 9000;
  }
  if (name === 'cost') for (const row of pairs) row.challenger.reservedCostMicros = 1201;
  if (name === 'tokens') for (const row of pairs) row.challenger.tokens = 9001;
  if (name === 'latency') for (const row of pairs) row.challenger.latencyMs = 10101;
  if (name === 'calibration') for (const row of pairs) row.challenger.brier = 0.031;
  if (name === 'unknown-tokens') pairs[0]!.challenger.tokens = null;
  if (name === 'missing-pair') pairs = pairs.slice(1);
  if (name === 'empty') pairs = [];
  return { pairs, ids };
}
