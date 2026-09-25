/**
 * Effect ledger keyring: public Ed25519 keys with validity windows, extended
 * only by rotations signed by both the prior and the successor key.
 *
 * @see docs/contracts/effect-ledger.v1.md "Signing and keyring"
 */

import { canonicalJson, decodeBase64, dssePae, publicKeyFingerprint, verifyBytes } from '../security/artifact-trust.js';
import { integrityError, usageError } from './errors.js';
import { sha256Digest } from './identity.js';
import type { LedgerSigningKey } from './keys.js';
import { isEffectSchemaValid } from './schema.js';
import {
  KEYRING_SCHEMA_VERSION,
  ROTATION_PAYLOAD_TYPE,
  ROTATION_SCHEMA_VERSION,
  type EffectKeyring,
  type EffectKeyringKey,
  type EffectKeyRotation,
  type EffectKeyRotationBody,
  type EffectScope,
} from './types.js';

export type SignatureCheck = 'ok' | 'unknown-keyid' | 'key-window' | 'signature-invalid';

const time = (value: string) => Date.parse(value);

/** `"sha256:"` plus hex SHA-256 of `canonicalJson(keyring)`, as recorded in checkpoints. */
export function keyringDigest(keyring: EffectKeyring): string {
  return sha256Digest(canonicalJson(keyring));
}

/** `validFrom ≤ t < validUntil`, and before `revokedAt` for a revoked key. */
export function keyValidAt(key: EffectKeyringKey, at: string): boolean {
  const t = time(at);
  if (!Number.isFinite(t) || t < time(key.validFrom)) return false;
  if (key.validUntil !== undefined && t >= time(key.validUntil)) return false;
  if (key.status === 'revoked' && (key.revokedAt === undefined || t >= time(key.revokedAt))) return false;
  return true;
}

function signatureValid(publicKey: string, payloadType: string, payload: Uint8Array, sig: string): boolean {
  try { return verifyBytes('ed25519', publicKey, dssePae(payloadType, payload), decodeBase64(sig, 'signature')); }
  catch { return false; }
}

/** Check one DSSE signature against the keyring at signing time `at`. */
export function checkSignature(keyring: EffectKeyring, keyid: string, sig: string, payloadType: string, payload: Uint8Array, at: string): SignatureCheck {
  const key = keyring.keys.find(entry => entry.keyid === keyid);
  if (!key) return 'unknown-keyid';
  if (!signatureValid(key.publicKey, payloadType, payload, sig)) return 'signature-invalid';
  if (!keyValidAt(key, at)) return 'key-window';
  return 'ok';
}

function rotationBody(rotation: EffectKeyRotation): EffectKeyRotationBody {
  const { signatures: _signatures, ...body } = rotation;
  return body;
}

/**
 * Structural and cryptographic keyring check. Returns a failure reason, or
 * null when the keyring is a genesis key extended only by valid rotations.
 */
export function keyringFailure(keyring: unknown, scope?: EffectScope): string | null {
  if (!isEffectSchemaValid('keyring', keyring)) return 'keyring-schema-invalid';
  const ring = keyring as EffectKeyring;
  if (scope && canonicalJson(ring.scope) !== canonicalJson(scope)) return 'keyring-scope-mismatch';
  const byId = new Map<string, EffectKeyringKey>();
  for (const key of ring.keys) {
    if (byId.has(key.keyid)) return 'keyring-duplicate-keyid';
    try { if (`sha256:${publicKeyFingerprint(key.publicKey)}` !== key.keyid) return 'keyring-keyid-mismatch'; }
    catch { return 'keyring-keyid-mismatch'; }
    byId.set(key.keyid, key);
  }
  const introduced = new Set(ring.rotations.map(rotation => rotation.to));
  const genesis = ring.keys.filter(key => !introduced.has(key.keyid));
  if (genesis.length !== 1 || ring.keys.length !== ring.rotations.length + 1) return 'keyring-unrotated-key';
  let current = genesis[0];
  let lastEffective = -Infinity;
  for (const [index, rotation] of ring.rotations.entries()) {
    if (rotation.sequence !== index + 1) return 'keyring-rotation-sequence';
    const successor = byId.get(rotation.to);
    const effective = time(rotation.effectiveAt);
    if (rotation.from !== current.keyid || !successor || successor.keyid === current.keyid) return 'keyring-rotation-chain';
    if (!(effective > lastEffective) || current.validUntil === undefined || time(current.validUntil) !== effective
      || time(successor.validFrom) !== effective) return 'keyring-rotation-window';
    const payload = Buffer.from(canonicalJson(rotationBody(rotation)), 'utf8');
    const prior = rotation.signatures.find(entry => entry.role === 'prior');
    const next = rotation.signatures.find(entry => entry.role === 'successor');
    if (!prior || prior.keyid !== current.keyid || !signatureValid(current.publicKey, ROTATION_PAYLOAD_TYPE, payload, prior.sig)) return 'keyring-rotation-prior-signature';
    if (!next || next.keyid !== successor.keyid || !signatureValid(successor.publicKey, ROTATION_PAYLOAD_TYPE, payload, next.sig)) return 'keyring-rotation-successor-signature';
    current = successor;
    lastEffective = effective;
  }
  return null;
}

export function assertKeyring(keyring: unknown, scope?: EffectScope): asserts keyring is EffectKeyring {
  const failure = keyringFailure(keyring, scope);
  if (failure) throw integrityError(failure, 'Effect ledger keyring failed verification');
}

/** The key currently allowed to sign: the last one in the rotation chain. */
export function activeKey(keyring: EffectKeyring): EffectKeyringKey {
  const last = keyring.rotations.at(-1);
  const keyid = last ? last.to : keyring.keys[0].keyid;
  return keyring.keys.find(key => key.keyid === keyid)!;
}

export function createGenesisKeyring(scope: EffectScope, key: LedgerSigningKey, validFrom: string): EffectKeyring {
  return {
    schemaVersion: KEYRING_SCHEMA_VERSION,
    scope: structuredClone(scope),
    keys: [{ keyid: key.keyid, algorithm: 'ed25519', publicKey: key.publicKey, validFrom, status: 'active' }],
    rotations: [],
  };
}

/**
 * Extend `keyring` with a rotation from `prior` (which must be the active key)
 * to `successor`, signed by both. The prior key's window closes at
 * `effectiveAt`; records it signed earlier stay verifiable.
 */
export function rotateKeyring(
  keyring: EffectKeyring,
  prior: LedgerSigningKey,
  successor: LedgerSigningKey,
  effectiveAt: string,
  reason: EffectKeyRotationBody['reason'] = 'scheduled',
): EffectKeyring {
  assertKeyring(keyring);
  const current = activeKey(keyring);
  if (current.keyid !== prior.keyid) throw usageError('Only the active ledger key can sign a rotation', 'rotation-prior-not-active');
  if (keyring.keys.some(key => key.keyid === successor.keyid)) throw usageError('The successor key is already in the keyring', 'rotation-key-reused');
  if (!(time(effectiveAt) > time(current.validFrom))) throw usageError('A rotation must take effect after the active key became valid', 'rotation-effective-at');
  const body: EffectKeyRotationBody = {
    schemaVersion: ROTATION_SCHEMA_VERSION,
    sequence: keyring.rotations.length + 1,
    from: prior.keyid,
    to: successor.keyid,
    effectiveAt,
    reason,
  };
  const payload = Buffer.from(canonicalJson(body), 'utf8');
  const next = structuredClone(keyring);
  const retired = next.keys.find(key => key.keyid === prior.keyid)!;
  retired.validUntil = effectiveAt;
  if (retired.status === 'active') retired.status = 'retired';
  next.keys.push({ keyid: successor.keyid, algorithm: 'ed25519', publicKey: successor.publicKey, validFrom: effectiveAt, status: 'active' });
  next.rotations.push({
    ...body,
    signatures: [
      { role: 'prior', keyid: prior.keyid, sig: prior.signPae(ROTATION_PAYLOAD_TYPE, payload) },
      { role: 'successor', keyid: successor.keyid, sig: successor.signPae(ROTATION_PAYLOAD_TYPE, payload) },
    ],
  });
  assertKeyring(next);
  return next;
}
