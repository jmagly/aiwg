/**
 * Unit tests for optional tracker credential and merge policy validation.
 *
 * @source @src/config/delivery-validation.ts
 * @implements #3862
 */
import { describe, expect, it } from 'vitest';
import { validateDeliverySettings } from '../../../src/config/delivery-validation.js';

const identity = { name: 'Fixture Operator', email: 'fixture@example.invalid' };

describe('validateDeliverySettings', () => {
  it('accepts a config without delivery or remotes', () => {
    expect(validateDeliverySettings({})).toEqual([]);
  });

  it.each(['local-signed', 'local', 'tracker'] as const)('accepts delivery.merge=%s when its requirements are met', (merge) => {
    const delivery = { merge, committer: identity, signing: { key: 'ABC123' } };
    expect(validateDeliverySettings({ delivery })).toEqual([]);
  });

  it('rejects an unknown merge mode', () => {
    expect(validateDeliverySettings({ delivery: { merge: 'api' as never } }))
      .toEqual(['delivery.merge must be local-signed, local, or tracker']);
  });

  it('requires a signing key and committer identity for local-signed', () => {
    const message = 'delivery.merge=local-signed requires signing.key and committer.name/email';
    expect(validateDeliverySettings({ delivery: { merge: 'local-signed', committer: identity } })).toEqual([message]);
    expect(validateDeliverySettings({ delivery: { merge: 'local-signed', signing: { key: 'ABC123' } } })).toEqual([message]);
    expect(validateDeliverySettings({ delivery: { merge: 'local-signed', signing: { key: 'ABC123' }, committer: { name: 'Only Name' } } }))
      .toEqual([message]);
  });

  it('allows unsigned local and tracker merges without signing config', () => {
    expect(validateDeliverySettings({ delivery: { merge: 'local' } })).toEqual([]);
    expect(validateDeliverySettings({ delivery: { merge: 'tracker' } })).toEqual([]);
  });

  it.each([
    [{ env: 'AIWG_GITEA_TOKEN' }],
    [{ store: 'gitea.roctinam' }],
  ])('accepts one credential reference %j for both tracker actors', (credential) => {
    const remotes = { tracker_actor: { credential }, customer_tracker_actor: { credential } } as never;
    expect(validateDeliverySettings({ remotes })).toEqual([]);
  });

  it.each([
    ['both sources', { env: 'AIWG_GITEA_TOKEN', store: 'gitea' }],
    ['no source', {}],
    ['an invalid env name', { env: '1BAD-NAME' }],
    ['an invalid store name', { store: '../escape' }],
    ['a non-string value', { env: 42 }],
    ['an unknown source kind', { file: '/tmp/token' }],
    ['a non-object', 'AIWG_GITEA_TOKEN'],
    ['null', null],
  ])('rejects a tracker credential with %s', (_label, credential) => {
    const remotes = { tracker_actor: { credential } } as never;
    expect(validateDeliverySettings({ remotes }))
      .toEqual(['remotes.tracker_actor.credential requires exactly one store or env reference']);
  });

  it('reports each invalid actor and merge error together', () => {
    const remotes = { tracker_actor: { credential: {} }, customer_tracker_actor: { credential: { env: '' } } } as never;
    expect(validateDeliverySettings({ remotes, delivery: { merge: 'nope' as never } })).toEqual([
      'delivery.merge must be local-signed, local, or tracker',
      'remotes.tracker_actor.credential requires exactly one store or env reference',
      'remotes.customer_tracker_actor.credential requires exactly one store or env reference',
    ]);
  });
});
