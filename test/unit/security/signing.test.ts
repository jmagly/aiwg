import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import * as marketplace from '../../../src/marketplace/provenance.js';
import {
  createArtifactAttestation,
  DSSE_IN_TOTO_PAYLOAD_TYPE,
  serializeArtifactAttestation,
} from '../../../src/security/artifact-attestation.js';
import {
  createCanonicalSigner,
  signCanonicalDocument,
  signDsseEnvelope,
  signingKeyId,
  verifyCanonicalSignature,
  verifyDsseEnvelope,
} from '../../../src/security/signing.js';

// Fixed Ed25519 key: PKCS#8 wrapping of a 32-byte seed of 0x07. Test-only material.
const PRIVATE_KEY_PEM = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 7)]),
  format: 'der',
  type: 'pkcs8',
}).export({ format: 'pem', type: 'pkcs8' }).toString();
const PUBLIC_KEY_PEM = createPublicKey(PRIVATE_KEY_PEM).export({ format: 'pem', type: 'spki' }).toString();
const PUBLIC_KEY_BASE64 = 'MCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=';
const SIGNED_AT = '2026-01-01T00:00:00.000Z';
const ATTESTATION_OPTIONS = {
  artifact: { name: 'artifact.txt', bytes: Buffer.from('artifact bytes\n') },
  assetType: 'skill',
  publisher: { id: 'publisher-1', namespace: 'aiwg' },
  publication: { version: '1.0.0', channel: 'stable', sequence: 1 },
  issuedAt: SIGNED_AT,
  privateKey: PRIVATE_KEY_PEM,
};

describe('marketplace canonical signatures keep their golden bytes (#2716)', () => {
  // Captured from the pre-refactor src/marketplace/provenance.ts implementation.
  const document = { schema: 'x', b: [1, 'two', { z: null, a: true }], a: 'é', omitted: undefined, Z: 2.5 };
  const golden = {
    keyId: 'ed25519:324be2dea8bc44461b0233e51fa48902',
    algorithm: 'ed25519',
    publicKey: PUBLIC_KEY_BASE64,
    signedAt: SIGNED_AT,
    payloadSha256: '86ef2f9ddcc90f59269183db2de10932e26b5df8fe707ecc48b1f258c487d9f3',
    signature: '+icpse+PAW9pPTfXPCOYrcyPxU2NPFQiXw327dOOUagf12nYshe/flA74dA3tzK6bskEiU5W17TqgiQyK0R3Cg==',
  };

  it('signs byte-identically to the committed golden vector', () => {
    expect(marketplace.signCanonicalDocument(document, PRIVATE_KEY_PEM, { signedAt: SIGNED_AT })).toEqual(golden);
    expect(marketplace.canonicalJson(document)).toBe('{"Z":2.5,"a":"é","b":[1,"two",{"a":true,"z":null}],"schema":"x"}');
    expect(marketplace.signingKeyId(PUBLIC_KEY_PEM)).toBe(golden.keyId);
  });

  it('verifies the golden vector and rejects tampering', () => {
    expect(marketplace.verifyCanonicalSignature(document, golden as never)).toBe(true);
    expect(marketplace.verifyCanonicalSignature({ ...document, a: 'e' }, golden as never)).toBe(false);
  });

  it('keeps the marketplace key-type error message', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    expect(() => marketplace.signCanonicalDocument({}, rsa)).toThrow(/^Marketplace signing keys must use Ed25519$/);
    expect(() => signCanonicalDocument({}, rsa)).toThrow(/^Signing keys must use Ed25519$/);
  });

  it('agrees with the shared signer for JSON-native documents', () => {
    const nativeDocument = { b: 1, a: 'x', nested: { y: [true, null] } };
    expect(signCanonicalDocument(nativeDocument, PRIVATE_KEY_PEM, { signedAt: SIGNED_AT }))
      .toEqual(marketplace.signCanonicalDocument(nativeDocument, PRIVATE_KEY_PEM, { signedAt: SIGNED_AT }));
  });
});

describe('shared Ed25519 canonical-document signing (#2716)', () => {
  it('produces the golden default signature and verifies it', () => {
    const signature = signCanonicalDocument({ b: 1, a: 'x' }, PRIVATE_KEY_PEM, { signedAt: SIGNED_AT });
    expect(signature).toEqual({
      keyId: 'ed25519:324be2dea8bc44461b0233e51fa48902',
      algorithm: 'ed25519',
      publicKey: PUBLIC_KEY_BASE64,
      signedAt: SIGNED_AT,
      payloadSha256: 'cdab067e9f3beb32d1252cfd63e492592fecbf591b0d08cadb24bb17f3864246',
      signature: 'a7h4PKRzxB3ofn022rrznN8FrImQqkfLup4PvfwztpdO2xJC8e3BR1YT8HM3ugsGwmXAXglMkR7eOxSeKpWSAw==',
    });
    expect(verifyCanonicalSignature({ a: 'x', b: 1 }, signature)).toBe(true);
    expect(verifyCanonicalSignature({ a: 'x', b: 2 }, signature)).toBe(false);
    expect(signingKeyId(PUBLIC_KEY_PEM)).toBe(signature.keyId);
  });

  it('uses the RFC 8785 canonicalizer by default and refuses non-JSON values', () => {
    expect(() => signCanonicalDocument({ value: Number.NaN }, PRIVATE_KEY_PEM)).toThrow(/non-finite/);
    expect(() => signCanonicalDocument({ value: undefined }, PRIVATE_KEY_PEM)).toThrow(/cannot encode undefined/);
  });

  it('binds a custom canonicalizer and message', () => {
    const signer = createCanonicalSigner({ canonicalize: () => 'fixed', keyTypeErrorMessage: 'custom' });
    const signature = signer.signCanonicalDocument({ a: 1 }, PRIVATE_KEY_PEM, { signedAt: SIGNED_AT });
    expect(signer.verifyCanonicalSignature({ anything: true }, signature)).toBe(true);
    expect(verifyCanonicalSignature({ a: 1 }, signature)).toBe(false);
    expect(() => signer.publicKeyDer(generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey)).toThrow(/^custom$/);
  });
});

describe('shared Ed25519 DSSE helpers (#2716)', () => {
  const payloadType = 'application/vnd.test+json';
  const payload = Buffer.from('{"a":1}');

  it('produces the golden envelope and round-trips', () => {
    const envelope = signDsseEnvelope(payloadType, payload, PRIVATE_KEY_PEM);
    expect(envelope).toEqual({
      payloadType,
      payload: 'eyJhIjoxfQ==',
      signatures: [{
        keyid: '324be2dea8bc44461b0233e51fa48902ed6b1cc671e7739af2551e0bfe68f54e',
        sig: 'Kc81Bm0sUPbFLCLNw2WBexTfHQqQfqvU4p9R47fU8HnS2qtnVd1llshcauKv7+YdCjA2gH+JaCB8ZkMTueVAAA==',
      }],
    });
    expect(verifyDsseEnvelope(envelope, PUBLIC_KEY_PEM)).toBe(true);
    expect(verifyDsseEnvelope(envelope, PUBLIC_KEY_BASE64)).toBe(true);
  });

  it('fails verification for a wrong key, a changed payload type or a changed payload', () => {
    const envelope = signDsseEnvelope(payloadType, payload, PRIVATE_KEY_PEM);
    const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }).toString();
    expect(verifyDsseEnvelope(envelope, other)).toBe(false);
    expect(verifyDsseEnvelope({ ...envelope, payloadType: 'application/vnd.other+json' }, PUBLIC_KEY_PEM)).toBe(false);
    expect(verifyDsseEnvelope({ ...envelope, payload: Buffer.from('{"a":2}').toString('base64') }, PUBLIC_KEY_PEM)).toBe(false);
    expect(verifyDsseEnvelope({ ...envelope, signatures: [] }, PUBLIC_KEY_PEM)).toBe(false);
    expect(verifyDsseEnvelope({ ...envelope, signatures: [{ keyid: 'x', sig: 'not base64!' }] }, PUBLIC_KEY_PEM)).toBe(false);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'pem', type: 'spki' }).toString();
    expect(verifyDsseEnvelope(envelope, rsa)).toBe(false);
  });

  it('refuses non-Ed25519 signing keys', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    expect(() => signDsseEnvelope(payloadType, payload, ec)).toThrow(/^Signing keys must use Ed25519$/);
  });

  it('is the signer behind artifact attestations', () => {
    const attestation = createArtifactAttestation(ATTESTATION_OPTIONS);
    expect(attestation.envelope.payloadType).toBe(DSSE_IN_TOTO_PAYLOAD_TYPE);
    expect(attestation.envelope).toEqual(signDsseEnvelope(
      DSSE_IN_TOTO_PAYLOAD_TYPE,
      Buffer.from(attestation.envelope.payload, 'base64'),
      PRIVATE_KEY_PEM,
    ));
    expect(verifyDsseEnvelope(attestation.envelope, attestation.verificationMaterial.publicKey)).toBe(true);
    // SHA-256 of the serialized attestation from the pre-refactor implementation.
    expect(createHash('sha256').update(serializeArtifactAttestation(attestation)).digest('hex'))
      .toBe('a5f12adb2cbca8d86f867ae313d9aaa675c44218d89f471efb5d3b169279f7f3');
  });
});
