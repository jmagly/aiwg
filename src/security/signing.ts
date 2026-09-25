/**
 * Ed25519 signing helpers shared across subsystems.
 *
 * Two shapes are provided:
 *
 * - canonical-document signatures: an Ed25519 signature over the canonical JSON
 *   of a document, with its SHA-256 and signer SPKI carried alongside;
 * - DSSE envelopes: an Ed25519 signature over the DSSE pre-authentication
 *   encoding (`artifact-trust.dssePae`) of exact payload bytes.
 *
 * Canonicalization defaults to the RFC 8785 implementation in
 * `artifact-trust.canonicalJson`. A caller whose stored signatures were made
 * over a different canonical form can bind its own canonicalizer through
 * `createCanonicalSigner`, so existing signatures keep verifying byte for byte.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';

import { canonicalJson, decodeBase64, dssePae, publicKeyFingerprint, publicKeyObject, verifyBytes } from './artifact-trust.js';

export interface CanonicalDocumentSignature {
  keyId: string;
  algorithm: 'ed25519';
  publicKey: string;
  signedAt: string;
  payloadSha256: string;
  signature: string;
}

export interface CanonicalSignOptions {
  keyId?: string;
  signedAt?: string;
  publicKeyPem?: string;
}

export interface CanonicalSignerOptions {
  /** Serializes a document to the exact bytes that are signed. Defaults to RFC 8785. */
  canonicalize?: (value: unknown) => string;
  /** Message thrown when a key is not Ed25519. */
  keyTypeErrorMessage?: string;
}

export interface CanonicalSigner {
  signCanonicalDocument(
    document: Record<string, unknown>,
    privateKeyPem: string,
    options?: CanonicalSignOptions,
  ): CanonicalDocumentSignature;
  verifyCanonicalSignature(document: Record<string, unknown>, signature: CanonicalDocumentSignature): boolean;
  signingKeyId(publicKey: string | KeyObject): string;
  /** SPKI DER of an Ed25519 public key, refusing any other key type. */
  publicKeyDer(key: string | KeyObject): Buffer;
}

export const DEFAULT_KEY_TYPE_ERROR_MESSAGE = 'Signing keys must use Ed25519';

function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function publicKeyFromBase64(value: string): KeyObject {
  return createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' });
}

/** Bind the canonical-document signing helpers to one canonicalizer and error message. */
export function createCanonicalSigner(options: CanonicalSignerOptions = {}): CanonicalSigner {
  const canonicalize = options.canonicalize ?? canonicalJson;
  const keyTypeError = options.keyTypeErrorMessage ?? DEFAULT_KEY_TYPE_ERROR_MESSAGE;

  function publicKeyDer(key: string | KeyObject): Buffer {
    const object = typeof key === 'string'
      ? createPublicKey(key)
      : key.type === 'public' ? key : createPublicKey(key);
    if (object.asymmetricKeyType !== 'ed25519') throw new Error(keyTypeError);
    return object.export({ format: 'der', type: 'spki' }) as Buffer;
  }

  function signingKeyId(publicKey: string | KeyObject): string {
    return `ed25519:${sha256Hex(publicKeyDer(publicKey)).slice(0, 32)}`;
  }

  function signCanonicalDocument(
    document: Record<string, unknown>,
    privateKeyPem: string,
    signOptions: CanonicalSignOptions = {},
  ): CanonicalDocumentSignature {
    const privateKey = createPrivateKey(privateKeyPem);
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error(keyTypeError);
    const publicKey = signOptions.publicKeyPem ? createPublicKey(signOptions.publicKeyPem) : createPublicKey(privateKey);
    const payload = canonicalize(document);
    return {
      keyId: signOptions.keyId ?? signingKeyId(publicKey),
      algorithm: 'ed25519',
      publicKey: publicKeyDer(publicKey).toString('base64'),
      signedAt: signOptions.signedAt ?? new Date().toISOString(),
      payloadSha256: sha256Hex(payload),
      signature: cryptoSign(null, Buffer.from(payload), privateKey).toString('base64'),
    };
  }

  function verifyCanonicalSignature(document: Record<string, unknown>, signature: CanonicalDocumentSignature): boolean {
    const payload = canonicalize(document);
    return signature.algorithm === 'ed25519'
      && signature.payloadSha256 === sha256Hex(payload)
      && cryptoVerify(
        null,
        Buffer.from(payload),
        publicKeyFromBase64(signature.publicKey),
        Buffer.from(signature.signature, 'base64'),
      );
  }

  return { signCanonicalDocument, verifyCanonicalSignature, signingKeyId, publicKeyDer };
}

const defaultSigner = createCanonicalSigner();

/** Sign the RFC 8785 canonical JSON of `document` with an Ed25519 private key. */
export const signCanonicalDocument = defaultSigner.signCanonicalDocument;
/** Verify a signature made by `signCanonicalDocument` over the RFC 8785 canonical JSON. */
export const verifyCanonicalSignature = defaultSigner.verifyCanonicalSignature;
/** Stable identifier for an Ed25519 public key: `ed25519:` plus 32 hex chars of its SPKI SHA-256. */
export const signingKeyId = defaultSigner.signingKeyId;

export interface DsseSignature { keyid: string; sig: string }

export interface DsseEnvelope<PayloadType extends string = string> {
  payloadType: PayloadType;
  payload: string;
  signatures: DsseSignature[];
}

function ed25519PrivateKey(privateKey: string | KeyObject, message: string): KeyObject {
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(message);
  return key;
}

/**
 * Sign exact payload bytes as a single-signature DSSE envelope. The keyid is the
 * SHA-256 of the signer's SPKI DER (`artifact-trust.publicKeyFingerprint`).
 */
export function signDsseEnvelope<PayloadType extends string>(
  payloadType: PayloadType,
  payload: Uint8Array,
  privateKey: string | KeyObject,
  options: { keyTypeErrorMessage?: string } = {},
): DsseEnvelope<PayloadType> {
  const key = ed25519PrivateKey(privateKey, options.keyTypeErrorMessage ?? DEFAULT_KEY_TYPE_ERROR_MESSAGE);
  const publicKeyPem = createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
  const body = Buffer.from(payload);
  const signature = cryptoSign(null, dssePae(payloadType, body), key);
  return {
    payloadType,
    payload: body.toString('base64'),
    signatures: [{ keyid: publicKeyFingerprint(publicKeyPem), sig: signature.toString('base64') }],
  };
}

/**
 * Verify that at least one envelope signature is a valid Ed25519 signature by
 * `publicKey` (PEM or base64 SPKI DER) over the DSSE PAE of the envelope's
 * payload type and payload. Keyids are lookup hints and are not trusted.
 * Malformed input verifies as false rather than throwing.
 */
export function verifyDsseEnvelope(envelope: DsseEnvelope, publicKey: string): boolean {
  let payload: Buffer;
  try {
    if (typeof envelope?.payloadType !== 'string' || !Array.isArray(envelope.signatures)) return false;
    if (publicKeyObject(publicKey).asymmetricKeyType !== 'ed25519') return false;
    payload = decodeBase64(envelope.payload, 'DSSE payload');
  } catch { return false; }
  const pae = dssePae(envelope.payloadType, payload);
  return envelope.signatures.some((signature) => {
    try { return verifyBytes('ed25519', publicKey, pae, decodeBase64(signature.sig, 'DSSE signature')); }
    catch { return false; }
  });
}
