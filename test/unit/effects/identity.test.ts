/**
 * Effect identity against the E1 golden vectors: `aiwg.effect/v1`, the
 * `d13.review/v1` adapter derivation (equal to reviewDigest), reader-side ID
 * strictness and the input grammar. Offline only.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { reviewDigest } from '../../../src/decision/review/validate.js';
import {
  EFFECT_ID_DERIVATIONS,
  EffectLedgerError,
  base32Lower,
  effectId,
  isValidEffectId,
  payloadDigest,
} from '../../../src/effects/index.js';
import { scope } from './helpers.js';

const vectors = JSON.parse(readFileSync('test/fixtures/effects/vectors/identity.v1.json', 'utf8'));

describe('effect identity', () => {
  it('EFF-IDL-01 base32 matches RFC 4648 section 10 vectors in lowercase without padding', () => {
    const cases: Array<[string, string]> = [['', ''], ['f', 'my'], ['fo', 'mzxq'], ['foo', 'mzxw6'], ['foob', 'mzxw6yq'], ['fooba', 'mzxw6ytb'], ['foobar', 'mzxw6ytboi']];
    for (const [input, expected] of cases) expect(base32Lower(Buffer.from(input))).toBe(expected);
  });

  it.each(vectors.effectIds.map((vector: any) => [vector.name, vector]))('EFF-IDL-02 effectId reproduces golden vector %s', (_name, vector: any) => {
    const { v: _v, ...input } = vector.input;
    expect(effectId(input)).toBe(vector.expected);
    expect(effectId(input, 'aiwg.effect/v1')).toBe(vector.expected);
    expect(isValidEffectId(vector.expected, 'aiwg.effect/v1')).toBe(true);
  });

  it.each(vectors.d13ReviewIds.map((vector: any) => [vector.name, vector]))('EFF-IDL-03 d13.review/v1 equals reviewDigest exactly for %s', (_name, vector: any) => {
    const id = effectId({ scope: { ...scope, subsystem: 'review' }, kind: 'decision.review.continuation', target: 'review:local/example/repo/review-0001', context: vector.input });
    expect(id).toBe(vector.expected);
    expect(id).toBe(reviewDigest(vector.input));
    expect(EFFECT_ID_DERIVATIONS['d13.review/v1'].pattern.test(id)).toBe(true);
  });

  it('EFF-IDL-04 d13.review/v1 refuses other kinds, subsystems and context shapes; aiwg.effect/v1 refuses the review kind', () => {
    const base = { scope: { ...scope, subsystem: 'review' as const }, kind: 'decision.review.continuation', target: 'review:local/example/repo/r', context: { reviewId: 'r', continuationId: 'c', proposalVersion: 1 } };
    expect(() => effectId({ ...base, scope })).toThrow(EffectLedgerError);
    expect(() => effectId({ ...base, context: { ...base.context, extra: true } })).toThrow(EffectLedgerError);
    expect(() => effectId({ ...base, context: { ...base.context, proposalVersion: 0 } })).toThrow(EffectLedgerError);
    expect(() => effectId({ ...base, kind: 'tracker.comment' }, 'd13.review/v1')).toThrow(EffectLedgerError);
    expect(() => effectId(base, 'aiwg.effect/v1')).toThrow(EffectLedgerError);
    expect(() => effectId(base, 'custom/v1' as never)).toThrow(EffectLedgerError);
    expect(Object.isFrozen(EFFECT_ID_DERIVATIONS)).toBe(true);
  });

  it('EFF-IDL-05 readers reject uppercase, padding, other lengths and non-zero trailing bits without normalizing', () => {
    const valid = vectors.effectIds[0].expected as string;
    expect(isValidEffectId(valid)).toBe(true);
    expect(isValidEffectId(`eff1_${valid.slice(5).toUpperCase()}`)).toBe(false);
    expect(isValidEffectId(`${valid}====`)).toBe(false);
    expect(isValidEffectId(valid.slice(0, -1))).toBe(false);
    expect(isValidEffectId(`${valid.slice(0, -1)}${valid.endsWith('a') ? 'b' : 'r'}`)).toBe(false);
    expect(isValidEffectId(`eff2_${valid.slice(5)}`)).toBe(false);
  });

  it('EFF-IDL-06 identity excludes nothing but the declared inputs and validates the grammar', () => {
    const input = { scope, kind: 'tracker.comment', target: 'gitea:example/repo#12', context: { issue: 12 } };
    expect(effectId(input)).toBe(effectId({ context: { issue: 12 }, target: input.target, kind: input.kind, scope: { subsystem: 'delivery', project: 'example/repo', tenant: 'local' } }));
    expect(effectId(input)).not.toBe(effectId({ ...input, scope: { ...scope, subsystem: 'job' } }));
    expect(effectId({ ...input, kind: 'x.example.notify', target: 'x-example:channel' })).toMatch(/^eff1_/);
    for (const bad of [
      { ...input, kind: 'x.bad' },
      { ...input, target: 'ftp:host' },
      { ...input, target: `gitea:${'a'.repeat(1030)}` },
      { ...input, context: { '1bad': 1 } },
      { ...input, context: { value: 1.5 } },
      { ...input, context: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`k${index}`, index])) },
      { ...input, scope: { ...scope, extra: 'x' } as never },
    ]) expect(() => effectId(bad as never)).toThrow(EffectLedgerError);
  });

  it('EFF-IDL-07 payload digests cover exact bytes or canonical JSON', () => {
    const expected = `sha256:${createHash('sha256').update('example\n').digest('hex')}`;
    expect(payloadDigest('example\n')).toBe(expected);
    expect(payloadDigest(Buffer.from('example\n'))).toBe(expected);
    expect(payloadDigest({ b: 1, a: 2 })).toBe(payloadDigest('{"a":2,"b":1}'));
    expect(payloadDigest('x')).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
