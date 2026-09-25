/**
 * The dedicated Ed25519 ledger signing key and its pluggable providers.
 *
 * The private key lives only inside a `LedgerSigningKey` private field. It has
 * no accessor, and JSON serialization and inspection show the public key only,
 * so it cannot reach records, errors or output by accident.
 *
 * Providers:
 * - `credentialStoreKeyProvider`: the host secret service through the
 *   configurable credential store (`src/auth/credential-store.ts`). This is the
 *   production provider.
 * - `environmentTestKeyProvider`: a key injected through
 *   `AIWG_EFFECT_LEDGER_TEST_KEY`, honoured only under a test runner or CI.
 * - `staticKeyProvider`: an in-process key object, for embedding hosts and tests.
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { inspect } from 'node:util';
import { createSecretStore, type CommandRunner, type SecretStore } from '../auth/credential-store.js';
import { signDsseEnvelope } from '../security/signing.js';
import { EffectLedgerError } from './errors.js';
import { sha256Digest } from './identity.js';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
export const DEFAULT_LEDGER_KEY_SERVICE = 'effects.aiwg.io';
export const LEDGER_TEST_KEY_ENV = 'AIWG_EFFECT_LEDGER_TEST_KEY';

const keyUnavailable = (message = 'Effect ledger signing key is unavailable') => new EffectLedgerError('key-unavailable', message, 'key-unavailable');

export class LedgerSigningKey {
  readonly keyid: string;
  /** Standard base64 of the DER SubjectPublicKeyInfo. */
  readonly publicKey: string;
  readonly #privateKey: KeyObject;

  constructor(privateKey: KeyObject) {
    if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') throw keyUnavailable('Effect ledger signing key must be an Ed25519 private key');
    this.#privateKey = privateKey;
    const der = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer;
    this.publicKey = der.toString('base64');
    this.keyid = sha256Digest(der);
  }

  /** Signature (standard padded base64) over the DSSE PAE of `payloadType` and `payload`. */
  signPae(payloadType: string, payload: Uint8Array): string {
    const envelope = signDsseEnvelope(payloadType, payload, this.#privateKey);
    return envelope.signatures[0].sig;
  }

  toJSON(): { keyid: string; publicKey: string } { return { keyid: this.keyid, publicKey: this.publicKey }; }
  [inspect.custom](): string { return `LedgerSigningKey(${this.keyid})`; }
}

export interface LedgerKeyProvider {
  /** A non-secret label for diagnostics. */
  readonly name: string;
  load(): Promise<LedgerSigningKey>;
}

/** Parse a PKCS#8 PEM, base64 PKCS#8 DER, or 32-byte hex seed into an Ed25519 key. */
export function parseLedgerPrivateKey(secret: string): KeyObject {
  const value = secret.trim();
  try {
    if (value.includes('-----BEGIN')) return createPrivateKey(value);
    if (/^[a-f0-9]{64}$/i.test(value)) {
      return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(value, 'hex')]), format: 'der', type: 'pkcs8' });
    }
    return createPrivateKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'pkcs8' });
  } catch {
    throw keyUnavailable('Effect ledger signing key material is not a valid Ed25519 private key');
  }
}

/** Generate a fresh Ed25519 ledger key, serialized as base64 PKCS#8 DER for a secret store. */
export function generateLedgerKeySecret(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  return (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64');
}

export function staticKeyProvider(privateKey: KeyObject | string, name = 'static'): LedgerKeyProvider {
  const key = new LedgerSigningKey(typeof privateKey === 'string' ? parseLedgerPrivateKey(privateKey) : privateKey);
  return { name, load: async () => key };
}

export interface CredentialStoreKeyProviderOptions {
  /** Secret-store account naming this ledger key, for example `ledger/<tenant>/<project>`. */
  account: string;
  /** Secret-store service. Defaults to `effects.aiwg.io`, distinct from the release credential. */
  service?: string;
  /** Generate and store a new key when none exists. Off by default. */
  provisionIfMissing?: boolean;
  platform?: NodeJS.Platform;
  runner?: CommandRunner;
  /** Explicit mode-0600 file fallback. */
  useFile?: boolean;
  allowFile?: boolean;
  pathname?: string;
  /** Inject a store directly (tests, embedding hosts). */
  store?: SecretStore;
}

/** The production provider: the host secret service through the configurable credential store. */
export function credentialStoreKeyProvider(options: CredentialStoreKeyProviderOptions): LedgerKeyProvider {
  const service = options.service ?? DEFAULT_LEDGER_KEY_SERVICE;
  let cached: LedgerSigningKey | undefined;
  return {
    name: 'credential-store',
    async load() {
      if (cached) return cached;
      let store: SecretStore;
      try {
        store = options.store ?? createSecretStore({
          service, account: options.account, platform: options.platform, runner: options.runner,
          useFile: options.useFile, allowFile: options.allowFile, pathname: options.pathname,
        });
      } catch { throw keyUnavailable('Effect ledger key store is unavailable on this host'); }
      let secret: string | null;
      try { secret = await store.loadSecret(); }
      catch { throw keyUnavailable('Effect ledger key could not be read from the host secret service'); }
      if (!secret) {
        if (!options.provisionIfMissing) throw keyUnavailable('Effect ledger key is not provisioned in the host secret service');
        secret = generateLedgerKeySecret();
        try { await store.saveSecret(secret); }
        catch { throw keyUnavailable('Effect ledger key could not be stored in the host secret service'); }
      }
      cached = new LedgerSigningKey(parseLedgerPrivateKey(secret));
      return cached;
    },
  };
}

function testContext(env: NodeJS.ProcessEnv): boolean {
  return env.VITEST === 'true' || env.NODE_ENV === 'test' || env.CI === 'true' || env.CI === '1';
}

/** Tests and CI only: a key injected through `AIWG_EFFECT_LEDGER_TEST_KEY`. */
export function environmentTestKeyProvider(env: NodeJS.ProcessEnv = process.env): LedgerKeyProvider {
  return {
    name: 'environment-test-key',
    async load() {
      if (!testContext(env)) throw keyUnavailable(`${LEDGER_TEST_KEY_ENV} is honoured only under a test runner or CI`);
      const value = env[LEDGER_TEST_KEY_ENV];
      if (!value) throw keyUnavailable(`${LEDGER_TEST_KEY_ENV} is not set`);
      return new LedgerSigningKey(parseLedgerPrivateKey(value));
    },
  };
}
