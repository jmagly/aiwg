/**
 * Ledger key providers: the host secret service through the configurable
 * credential store, the test-only environment key, and key-material
 * containment. Offline only: native helpers are replaced by a recorded runner.
 */
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { MemorySecretStore, type CommandRunner } from '../../../src/auth/credential-store.js';
import {
  DEFAULT_LEDGER_KEY_SERVICE,
  EffectLedgerError,
  LEDGER_TEST_KEY_ENV,
  LedgerSigningKey,
  credentialStoreKeyProvider,
  environmentTestKeyProvider,
  generateLedgerKeySecret,
} from '../../../src/effects/index.js';
import { testKey, testKeySeedHex } from './helpers.js';

describe('ledger key providers', () => {
  it('EFF-KEY-01 the credential-store provider reads the dedicated ledger identity from the native helper', async () => {
    const seed = testKeySeedHex('native');
    const run = vi.fn<CommandRunner>().mockResolvedValue({ stdout: `${seed}\n`, stderr: '', exitCode: 0 });
    const key = await credentialStoreKeyProvider({ account: 'ledger/local/example-repo', platform: 'linux', runner: run }).load();
    expect(run.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ['secret-tool', ['lookup', 'service', DEFAULT_LEDGER_KEY_SERVICE, 'account', 'ledger/local/example-repo']],
    ]);
    expect(key.keyid).toBe(new LedgerSigningKey(testKey('native')).keyid);
    expect(DEFAULT_LEDGER_KEY_SERVICE).not.toBe('releases.aiwg.io');
  });

  it('EFF-KEY-02 a missing key fails closed unless provisioning is requested, and provisioning is stable', async () => {
    const store = new MemorySecretStore();
    await expect(credentialStoreKeyProvider({ account: 'ledger/a', store }).load()).rejects.toMatchObject({ code: 'key-unavailable' });
    const first = await credentialStoreKeyProvider({ account: 'ledger/a', store, provisionIfMissing: true }).load();
    const second = await credentialStoreKeyProvider({ account: 'ledger/a', store }).load();
    expect(second.keyid).toBe(first.keyid);
  });

  it('EFF-KEY-03 helper failures and malformed material surface fixed messages that never echo the secret', async () => {
    const secret = 'not-a-key-0123456789abcdef-canary';
    const unreadable = vi.fn<CommandRunner>().mockResolvedValue({ stdout: secret, stderr: secret, exitCode: 9 });
    const malformed = vi.fn<CommandRunner>().mockResolvedValue({ stdout: secret, stderr: '', exitCode: 0 });
    for (const runner of [unreadable, malformed]) {
      const error = await credentialStoreKeyProvider({ account: 'ledger/a', platform: 'linux', runner }).load().then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(EffectLedgerError);
      expect(JSON.stringify(error)).not.toContain(secret);
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it('EFF-KEY-04 the environment test key is honoured only under a test runner or CI', async () => {
    const seed = testKeySeedHex('env');
    await expect(environmentTestKeyProvider({ [LEDGER_TEST_KEY_ENV]: seed }).load()).rejects.toMatchObject({ code: 'key-unavailable' });
    await expect(environmentTestKeyProvider({ VITEST: 'true' }).load()).rejects.toMatchObject({ code: 'key-unavailable' });
    const key = await environmentTestKeyProvider({ VITEST: 'true', [LEDGER_TEST_KEY_ENV]: seed }).load();
    expect(key.keyid).toBe(new LedgerSigningKey(testKey('env')).keyid);
    expect((await environmentTestKeyProvider({ CI: 'true', [LEDGER_TEST_KEY_ENV]: generateLedgerKeySecret() }).load()).keyid).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('EFF-KEY-05 a signing key serializes and inspects as public material only', () => {
    const key = new LedgerSigningKey(testKey('contain'));
    const text = `${JSON.stringify(key)} ${inspect(key)} ${String(Object.keys(key))}`;
    expect(text).not.toContain(testKeySeedHex('contain'));
    expect(text).not.toMatch(/PRIVATE KEY|MC4CAQAwBQYDK2Vw/);
    expect(JSON.parse(JSON.stringify(key))).toEqual({ keyid: key.keyid, publicKey: key.publicKey });
    expect(() => new LedgerSigningKey(testKey('contain') as never).signPae('x', Buffer.from('y'))).not.toThrow();
  });
});
