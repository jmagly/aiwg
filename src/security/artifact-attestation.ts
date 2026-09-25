import {
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from 'node:crypto';

import { canonicalJson, sha256 } from './artifact-trust.js';
import { signDsseEnvelope } from './signing.js';

export const ARTIFACT_ATTESTATION_MEDIA_TYPE = 'application/vnd.aiwg.artifact-attestation.v1+json';
export const ARTIFACT_PROVENANCE_PREDICATE_TYPE = 'https://aiwg.io/attestations/artifact-provenance/v1';
export const IN_TOTO_STATEMENT_V1 = 'https://in-toto.io/Statement/v1';
export const DSSE_IN_TOTO_PAYLOAD_TYPE = 'application/vnd.in-toto+json';

export interface ArtifactDescriptor {
  name: string;
  uri?: string;
  mediaType?: string;
  digest: { sha256: string };
}

export interface ArtifactMaterial {
  name?: string;
  uri: string;
  mediaType?: string;
  digest: { sha256: string };
}

export interface ArtifactProvenanceStatement {
  _type: typeof IN_TOTO_STATEMENT_V1;
  subject: ArtifactDescriptor[];
  predicateType: typeof ARTIFACT_PROVENANCE_PREDICATE_TYPE;
  predicate: {
    schemaVersion: 'aiwg.artifact-provenance.v1';
    assetType: string;
    publisher: { id: string; namespace: string; role?: string };
    publication: {
      version: string;
      channel: string;
      sequence: number;
      sourceUri?: string;
      collection?: ArtifactDescriptor;
      supersedes?: ArtifactDescriptor;
    };
    issuedAt: string;
    notBefore?: string;
    expiresAt?: string;
    derivation?: {
      builder: { id: string; version?: string };
      transformation?: { id: string; version: string; provider?: string };
      materials: ArtifactMaterial[];
      reproducible?: boolean;
      invocationId?: string;
    };
    provenanceGraph?: { standard: 'W3C-PROV'; uri: string; sha256: string };
    dependencies?: ArtifactDescriptor[];
  };
}

export interface ArtifactAttestation {
  mediaType: typeof ARTIFACT_ATTESTATION_MEDIA_TYPE;
  envelope: {
    payloadType: typeof DSSE_IN_TOTO_PAYLOAD_TYPE;
    payload: string;
    signatures: Array<{ keyid: string; sig: string }>;
  };
  verificationMaterial: {
    kind: 'public-key';
    algorithm: 'ed25519';
    publicKey: string;
  };
}

export interface CreateArtifactAttestationOptions {
  artifact: { name: string; bytes: Uint8Array; uri?: string; mediaType?: string };
  assetType: string;
  publisher: { id: string; namespace: string; role?: string };
  publication: ArtifactProvenanceStatement['predicate']['publication'];
  issuedAt: string;
  notBefore?: string;
  expiresAt?: string;
  derivation?: ArtifactProvenanceStatement['predicate']['derivation'];
  provenanceGraph?: ArtifactProvenanceStatement['predicate']['provenanceGraph'];
  dependencies?: ArtifactDescriptor[];
  privateKey: string | Buffer | KeyObject;
}

export interface AttestationSidecarDescriptor {
  path: string;
  sha256: string;
  bytes: number;
  mediaType: typeof ARTIFACT_ATTESTATION_MEDIA_TYPE;
}

function assertNonEmpty(value: string, label: string): void {
  if (!value) throw new Error(`${label} must not be empty`);
}

function assertTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an RFC 3339 date-time`);
  return parsed;
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
}

function validateDescriptor(descriptor: ArtifactDescriptor, label: string): void {
  assertNonEmpty(descriptor.name, `${label}.name`);
  assertSha256(descriptor.digest.sha256, `${label}.digest.sha256`);
}

/** Build the exact canonical in-toto bytes that DSSE signs. */
export function createArtifactProvenanceStatement(
  options: Omit<CreateArtifactAttestationOptions, 'privateKey'>,
): ArtifactProvenanceStatement {
  assertNonEmpty(options.artifact.name, 'artifact.name');
  assertNonEmpty(options.assetType, 'assetType');
  assertNonEmpty(options.publisher.id, 'publisher.id');
  assertNonEmpty(options.publisher.namespace, 'publisher.namespace');
  assertNonEmpty(options.publication.version, 'publication.version');
  assertNonEmpty(options.publication.channel, 'publication.channel');
  if (!Number.isSafeInteger(options.publication.sequence) || options.publication.sequence < 1) {
    throw new Error('publication.sequence must be a positive safe integer');
  }
  const issuedAt = assertTimestamp(options.issuedAt, 'issuedAt');
  const notBefore = options.notBefore ? assertTimestamp(options.notBefore, 'notBefore') : undefined;
  const expiresAt = options.expiresAt ? assertTimestamp(options.expiresAt, 'expiresAt') : undefined;
  if (notBefore !== undefined && expiresAt !== undefined && expiresAt <= notBefore) {
    throw new Error('expiresAt must follow notBefore');
  }
  if (expiresAt !== undefined && expiresAt <= issuedAt) throw new Error('expiresAt must follow issuedAt');
  for (const [index, dependency] of (options.dependencies ?? []).entries()) {
    validateDescriptor(dependency, `dependencies[${index}]`);
  }
  for (const [index, material] of (options.derivation?.materials ?? []).entries()) {
    if (material.name !== undefined) assertNonEmpty(material.name, `derivation.materials[${index}].name`);
    assertNonEmpty(material.uri, `derivation.materials[${index}].uri`);
    if (material.mediaType !== undefined) assertNonEmpty(material.mediaType, `derivation.materials[${index}].mediaType`);
    assertSha256(material.digest.sha256, `derivation.materials[${index}].digest.sha256`);
  }

  const subject: ArtifactDescriptor = {
    name: options.artifact.name,
    ...(options.artifact.uri ? { uri: options.artifact.uri } : {}),
    ...(options.artifact.mediaType ? { mediaType: options.artifact.mediaType } : {}),
    digest: { sha256: sha256(options.artifact.bytes) },
  };
  return {
    _type: IN_TOTO_STATEMENT_V1,
    subject: [subject],
    predicateType: ARTIFACT_PROVENANCE_PREDICATE_TYPE,
    predicate: {
      schemaVersion: 'aiwg.artifact-provenance.v1',
      assetType: options.assetType,
      publisher: options.publisher,
      publication: options.publication,
      issuedAt: options.issuedAt,
      ...(options.notBefore ? { notBefore: options.notBefore } : {}),
      ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
      ...(options.derivation ? { derivation: options.derivation } : {}),
      ...(options.provenanceGraph ? { provenanceGraph: options.provenanceGraph } : {}),
      ...(options.dependencies ? { dependencies: options.dependencies } : {}),
    },
  };
}

/** Create a portable public-key DSSE attestation over exact canonical payload bytes. */
export function createArtifactAttestation(options: CreateArtifactAttestationOptions): ArtifactAttestation {
  const privateKey = options.privateKey instanceof Object && 'type' in options.privateKey
    ? options.privateKey as KeyObject
    : createPrivateKey(options.privateKey);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('artifact attestation key must be Ed25519');
  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const statement = createArtifactProvenanceStatement(options);
  const payload = Buffer.from(canonicalJson(statement), 'utf8');
  return {
    mediaType: ARTIFACT_ATTESTATION_MEDIA_TYPE,
    envelope: signDsseEnvelope(DSSE_IN_TOTO_PAYLOAD_TYPE, payload, privateKey),
    verificationMaterial: {
      kind: 'public-key',
      algorithm: 'ed25519',
      publicKey: publicKeyPem,
    },
  };
}

export function serializeArtifactAttestation(attestation: ArtifactAttestation): Buffer {
  return Buffer.from(`${canonicalJson(attestation)}\n`, 'utf8');
}

export function describeAttestationSidecar(
  artifactPath: string,
  attestationBytes: Uint8Array,
): AttestationSidecarDescriptor {
  assertNonEmpty(artifactPath, 'artifactPath');
  return {
    path: `${artifactPath}.aiwg-attestation.json`,
    sha256: sha256(attestationBytes),
    bytes: attestationBytes.byteLength,
    mediaType: ARTIFACT_ATTESTATION_MEDIA_TYPE,
  };
}
