/**
 * Git-native provenance, signing, locking, and Fortemi conversion primitives.
 *
 * No function in this module executes package content. Git is inspected as
 * data, file traversal rejects links, and verification completes before callers
 * may deploy or persist imported bytes.
 *
 * @implements #2009
 */

import { execFile } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { AiwgFortemiIndexExport } from '../artifacts/browser-export.js';
import { createCanonicalSigner } from '../security/signing.js';
import {
  MARKETPLACE_ENVELOPE_SCHEMA,
  MARKETPLACE_LOCK_SCHEMA,
  MARKETPLACE_RECEIPT_SCHEMA,
  type MarketplaceConformanceEvidence,
  type MarketplaceDependency,
  type MarketplaceEnvelopeSignature,
  type MarketplaceInventoryEntry,
  type MarketplaceOperation,
  type MarketplaceOperationReceipt,
  type MarketplacePackageLock,
  type MarketplaceProvenanceEnvelope,
  type MarketplaceProviderSupport,
  type MarketplaceTrustStore,
  type MarketplaceTrustedKey,
  type MarketplaceVerificationPolicy,
  type MarketplaceVerificationResult,
  type PackageKind,
} from './provenance-types.js';

const execFileAsync = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const SUPPORTED_CAPABILITIES = new Set([
  'immutable-git-v1',
  'w3c-prov-v1',
  'fortemi-full-v1',
  'offline-verification-v1',
]);
const CONTROL_PATHS = [
  /^\.git(?:\/|$)/,
  /^\.aiwg\/marketplace(?:\/|$)/,
  /^aiwg-marketplace-(?:envelope|receipt|lock|catalog)\.json$/,
];

export const INTEGRITY_ONLY_POLICY: MarketplaceVerificationPolicy = Object.freeze({
  requireSignature: false,
  allowIntegrityOnly: true,
  allowYanked: false,
  allowDeprecated: true,
  allowRefMove: false,
  allowRollback: false,
});

export const SIGNED_POLICY: MarketplaceVerificationPolicy = Object.freeze({
  ...INTEGRITY_ONLY_POLICY,
  requireSignature: true,
  allowIntegrityOnly: false,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

/**
 * RFC-8785-style deterministic JSON for the JSON-native protocol values.
 *
 * For JSON-native values (no `undefined`, no non-finite numbers, no `toJSON`,
 * no array-index keys such as "9" or "10") this is byte-identical to the
 * RFC 8785 `artifact-trust.canonicalJson`: both sort keys by UTF-16 code unit
 * and serialize scalars with `JSON.stringify`. It is kept because existing
 * marketplace signatures depend on its handling of the other values:
 * `undefined` object members are dropped, `undefined` array entries and
 * non-finite numbers become `null` (RFC 8785 throws), and array-index keys are
 * emitted first in numeric order because the sorted object is rebuilt.
 * test/unit/security/canonical-json-parity.test.ts pins the parity and the
 * differences.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(stable(value));
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedRelative(value: string): string {
  const normalized = value.replaceAll(path.sep, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
    throw new Error(`Unsafe marketplace path '${value}'`);
  }
  const parts = normalized.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`Unsafe marketplace path '${value}'`);
  }
  return normalized;
}

export function isMarketplaceControlPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll(path.sep, '/');
  return CONTROL_PATHS.some((pattern) => pattern.test(normalized));
}

/** Walk regular files only, deterministically, without following links. */
export async function inventoryDirectory(root: string): Promise<MarketplaceInventoryEntry[]> {
  const resolvedRoot = path.resolve(root);
  const entries: MarketplaceInventoryEntry[] = [];

  const walk = async (current: string): Promise<void> => {
    const children = (await readdir(current, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const absolute = path.join(current, child.name);
      const relative = normalizedRelative(path.relative(resolvedRoot, absolute));
      if (isMarketplaceControlPath(relative)) continue;
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(`Marketplace packages cannot contain symbolic links: ${relative}`);
      }
      if (stat.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`Marketplace packages may contain regular files only: ${relative}`);
      }
      const bytes = await readFile(absolute);
      entries.push({
        path: relative,
        bytes: bytes.byteLength,
        mode: stat.mode & 0o777,
        sha256: sha256(bytes),
      });
    }
  };

  await walk(resolvedRoot);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export function inventorySha256(inventory: MarketplaceInventoryEntry[]): string {
  return sha256(canonicalJson(inventory));
}

function sanitizeRemoteUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Git remote cannot be empty');
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    if (url.password) throw new Error('Git remotes containing embedded credentials are not permitted');
    url.username = '';
    url.hash = '';
    url.search = '';
    const pathname = url.pathname.replace(/\/$/, '').replace(/\.git$/, '');
    url.pathname = `${pathname}.git`;
    return url.toString().replace(/\/$/, '');
  }
  if (/^(?:git@|ssh:\/\/)/.test(trimmed)) {
    return trimmed.replace(/\/$/, '').replace(/\.git$/, '') + '.git';
  }
  throw new Error(`Unsupported canonical Git remote '${raw}'`);
}

export function canonicalizeGitRemote(raw: string): string {
  return sanitizeRemoteUrl(raw);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}

async function gitBytes(cwd: string, args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'buffer',
    timeout: 120_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout as Buffer;
}

export interface GitCheckoutIdentity {
  canonicalRemote: string;
  resolvedCommit: string;
  gitTreeObject: string;
  treeSha256: string;
  commitTime: string;
}

export async function inspectGitCheckout(checkoutPath: string, remote?: string): Promise<GitCheckoutIdentity> {
  const resolvedCommit = await git(checkoutPath, ['rev-parse', 'HEAD^{commit}']);
  if (!COMMIT.test(resolvedCommit)) throw new Error(`Git returned invalid commit '${resolvedCommit}'`);
  const gitTreeObject = await git(checkoutPath, ['rev-parse', 'HEAD^{tree}']);
  if (!COMMIT.test(gitTreeObject)) throw new Error(`Git returned invalid tree object '${gitTreeObject}'`);
  const treeBytes = await gitBytes(checkoutPath, ['ls-tree', '-r', '--full-tree', '-z', 'HEAD']);
  const commitTime = await git(checkoutPath, ['show', '-s', '--format=%cI', 'HEAD']);
  const configuredRemote = remote ?? await git(checkoutPath, ['config', '--get', 'remote.origin.url']);
  return {
    canonicalRemote: canonicalizeGitRemote(configuredRemote),
    resolvedCommit,
    gitTreeObject,
    treeSha256: sha256(treeBytes),
    commitTime,
  };
}

function namespaceValue(value: unknown): string {
  const candidate = String(value ?? 'third-party').toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return candidate && SAFE_ID.test(candidate) ? candidate : 'third-party';
}

function packageKind(value: unknown): PackageKind {
  return ['framework', 'addon', 'extension', 'plugin'].includes(String(value))
    ? value as PackageKind
    : 'unknown';
}

function providersFromManifest(manifest: Record<string, unknown>): MarketplaceProviderSupport[] {
  const platforms = isRecord(manifest.platforms) ? manifest.platforms : {};
  return Object.entries(platforms)
    .filter(([, support]) => support !== false && support !== 'none' && support !== undefined)
    .map(([provider, support]) => ({ provider, support: String(support === true ? 'supported' : support) }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

function dependenciesFromManifest(manifest: Record<string, unknown>): MarketplaceDependency[] {
  if (!isRecord(manifest.dependencies)) return [];
  const result: MarketplaceDependency[] = [];
  for (const [group, optional] of [['required', false], ['optional', true]] as const) {
    const dependencies = manifest.dependencies[group];
    if (!Array.isArray(dependencies)) continue;
    for (const raw of dependencies) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const at = raw.lastIndexOf('@');
      result.push({
        identity: at > 0 ? raw.slice(0, at) : raw,
        version: at > 0 ? raw.slice(at + 1) : '*',
        optional,
      });
    }
  }
  return result.sort((a, b) => a.identity.localeCompare(b.identity));
}

export interface CreateEnvelopeOptions {
  checkoutPath: string;
  artifactPath: string;
  wrapperPath?: string;
  manifest: Record<string, unknown>;
  requestedRef: string;
  remote?: string;
  publisher?: string;
  publisherDisplayName?: string;
  sequence?: number;
  now?: Date;
  sbomPath?: string;
}

export async function createProvenanceEnvelope(
  options: CreateEnvelopeOptions,
): Promise<MarketplaceProvenanceEnvelope> {
  const checkout = path.resolve(options.checkoutPath);
  const artifact = path.resolve(options.artifactPath);
  const relativeArtifact = path.relative(checkout, artifact).replaceAll(path.sep, '/') || '.';
  if (relativeArtifact === '..' || relativeArtifact.startsWith('../') || path.isAbsolute(relativeArtifact)) {
    throw new Error('Marketplace artifact path must stay inside the Git checkout');
  }
  const gitIdentity = await inspectGitCheckout(checkout, options.remote);
  const inventory = await inventoryDirectory(artifact);
  if (inventory.length === 0) throw new Error('Marketplace package contains no regular artifact files');
  const now = (options.now ?? new Date()).toISOString();
  const manifest = options.manifest;
  const name = namespaceValue(manifest.id ?? manifest.name ?? path.basename(checkout));
  const namespace = namespaceValue(manifest.namespace ?? manifest.author);
  const version = String(manifest.version ?? gitIdentity.resolvedCommit);
  const publisher = options.publisher ?? String(manifest.author ?? namespace);
  const packageIdentity = `${namespace}/${name}@${version}`;
  const activityId = `urn:aiwg:marketplace:activity:${sha256(`${packageIdentity}:${gitIdentity.resolvedCommit}`).slice(0, 24)}`;
  const sourceId = `urn:aiwg:marketplace:git:${gitIdentity.resolvedCommit}`;
  const artifactDigest = inventorySha256(inventory);
  const packageId = `urn:aiwg:marketplace:package:${sha256(`${packageIdentity}:${artifactDigest}`).slice(0, 32)}`;
  let sbom: { format: string; sha256: string; path: string } | undefined;
  if (options.sbomPath) {
    const sbomRelative = normalizedRelative(options.sbomPath);
    const entry = inventory.find((item) => item.path === sbomRelative);
    if (!entry) throw new Error(`SBOM '${sbomRelative}' is not part of the artifact inventory`);
    sbom = { format: path.extname(sbomRelative).slice(1) || 'unknown', sha256: entry.sha256, path: sbomRelative };
  }

  const envelope: MarketplaceProvenanceEnvelope = {
    schemaVersion: MARKETPLACE_ENVELOPE_SCHEMA,
    requiredCapabilities: [...SUPPORTED_CAPABILITIES].sort(),
    package: {
      namespace,
      name,
      version,
      type: packageKind(manifest.type),
      description: String(manifest.description ?? manifest.name ?? name),
      license: String(manifest.license ?? 'NOASSERTION'),
      wrapperSchemaVersion: String(manifest.manifestVersion ?? 'legacy'),
      wrapperVersion: version,
      providers: providersFromManifest(manifest),
      dependencies: dependenciesFromManifest(manifest),
      inventory,
      ...(sbom ? { sbom } : {}),
    },
    source: {
      ...gitIdentity,
      requestedRef: options.requestedRef,
      artifactSha256: artifactDigest,
      wrapperPath: options.wrapperPath?.replaceAll(path.sep, '/') || '.',
      payloadPath: relativeArtifact,
      resolvedAt: now,
      ...(!COMMIT.test(options.requestedRef) && options.requestedRef !== 'HEAD'
        ? { tag: { name: options.requestedRef } }
        : {}),
    },
    publisher: {
      id: publisher,
      ...(options.publisherDisplayName ? { displayName: options.publisherDisplayName } : {}),
    },
    publication: {
      sequence: options.sequence ?? 1,
      publishedAt: now,
    },
    provenance: {
      standard: 'W3C-PROV',
      entities: [
        { id: sourceId, type: 'prov:Entity/git-tree', digest: gitIdentity.treeSha256 },
        { id: packageId, type: 'prov:Entity/package', digest: artifactDigest },
      ],
      activities: [{
        id: activityId,
        type: 'prov:Activity/package-publication',
        startedAt: now,
        endedAt: now,
        attributes: { requestedRef: options.requestedRef, resolvedCommit: gitIdentity.resolvedCommit },
      }],
      agents: [
        { id: `urn:aiwg:publisher:${publisher}`, type: 'organization' },
        { id: 'urn:aiwg:software:aiwg', type: 'software', attributes: { operation: 'package-provenance' } },
      ],
      relations: [
        { type: 'wasDerivedFrom', subject: packageId, object: sourceId },
        { type: 'wasGeneratedBy', subject: packageId, object: activityId },
        { type: 'used', subject: activityId, object: sourceId },
        { type: 'wasAssociatedWith', subject: activityId, object: `urn:aiwg:publisher:${publisher}` },
        { type: 'wasAttributedTo', subject: packageId, object: `urn:aiwg:publisher:${publisher}` },
      ],
    },
    fortemi: {
      schemaVersion: '2.0.0',
      profile: 'full-v1',
      sourceSchemaVersion: 'aiwg.fortemi.index.export.v2',
    },
    signatures: [],
  };
  validateProvenanceEnvelope(envelope);
  return envelope;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], where: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw new Error(`${where} contains unknown required field(s): ${extras.join(', ')}`);
}

function requiredString(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${where} must be a non-empty string`);
  return value;
}

/** Strict fail-closed envelope validation; unknown fields are never discarded. */
export function validateProvenanceEnvelope(value: unknown): asserts value is MarketplaceProvenanceEnvelope {
  if (!isRecord(value)) throw new Error('Marketplace provenance envelope must be an object');
  exactKeys(value, ['schemaVersion', 'requiredCapabilities', 'package', 'source', 'publisher', 'publication', 'provenance', 'fortemi', 'signatures'], 'envelope');
  if (value.schemaVersion !== MARKETPLACE_ENVELOPE_SCHEMA) throw new Error(`Unsupported envelope schema '${String(value.schemaVersion)}'`);
  if (!Array.isArray(value.requiredCapabilities) || value.requiredCapabilities.some((item) => typeof item !== 'string')) {
    throw new Error('envelope.requiredCapabilities must be an array of strings');
  }
  const unsupported = value.requiredCapabilities.filter((item) => !SUPPORTED_CAPABILITIES.has(item));
  if (unsupported.length) throw new Error(`Unsupported required marketplace capabilities: ${unsupported.join(', ')}`);
  if (!isRecord(value.package)) throw new Error('envelope.package must be an object');
  exactKeys(value.package, ['namespace', 'name', 'version', 'type', 'description', 'license', 'wrapperSchemaVersion', 'wrapperVersion', 'providers', 'dependencies', 'inventory', 'sbom'], 'envelope.package');
  for (const field of ['namespace', 'name', 'version', 'type', 'description', 'license', 'wrapperSchemaVersion', 'wrapperVersion']) {
    requiredString(value.package[field], `envelope.package.${field}`);
  }
  if (!Array.isArray(value.package.inventory) || value.package.inventory.length === 0) throw new Error('envelope.package.inventory must be non-empty');
  let lastPath = '';
  const seen = new Set<string>();
  for (const raw of value.package.inventory) {
    if (!isRecord(raw)) throw new Error('envelope.package.inventory entries must be objects');
    exactKeys(raw, ['path', 'bytes', 'mode', 'sha256'], 'inventory entry');
    const itemPath = normalizedRelative(requiredString(raw.path, 'inventory.path'));
    if (seen.has(itemPath)) throw new Error(`Duplicate inventory path '${itemPath}'`);
    if (lastPath && itemPath.localeCompare(lastPath) < 0) throw new Error('Inventory must be sorted by path');
    seen.add(itemPath);
    lastPath = itemPath;
    if (!Number.isSafeInteger(raw.bytes) || Number(raw.bytes) < 0) throw new Error(`Invalid byte count for '${itemPath}'`);
    if (!Number.isSafeInteger(raw.mode) || Number(raw.mode) < 0 || Number(raw.mode) > 0o777) throw new Error(`Invalid mode for '${itemPath}'`);
    if (typeof raw.sha256 !== 'string' || !SHA256.test(raw.sha256)) throw new Error(`Invalid SHA-256 for '${itemPath}'`);
  }
  if (!Array.isArray(value.package.providers) || !Array.isArray(value.package.dependencies)) throw new Error('Envelope provider/dependency inventories must be arrays');
  if (!isRecord(value.source)) throw new Error('envelope.source must be an object');
  exactKeys(value.source, ['canonicalRemote', 'requestedRef', 'resolvedCommit', 'gitTreeObject', 'treeSha256', 'artifactSha256', 'wrapperPath', 'payloadPath', 'resolvedAt', 'commitTime', 'tag'], 'envelope.source');
  for (const field of ['canonicalRemote', 'requestedRef', 'resolvedCommit', 'gitTreeObject', 'treeSha256', 'artifactSha256', 'wrapperPath', 'payloadPath', 'resolvedAt']) {
    requiredString(value.source[field], `envelope.source.${field}`);
  }
  if (!COMMIT.test(String(value.source.resolvedCommit)) || !COMMIT.test(String(value.source.gitTreeObject))) throw new Error('Envelope Git identities must be immutable object IDs');
  for (const field of ['treeSha256', 'artifactSha256']) if (!SHA256.test(String(value.source[field]))) throw new Error(`Invalid source ${field}`);
  canonicalizeGitRemote(String(value.source.canonicalRemote));
  if (!isRecord(value.publisher) || typeof value.publisher.id !== 'string') throw new Error('envelope.publisher.id is required');
  if (!isRecord(value.publication) || !Number.isSafeInteger(value.publication.sequence) || Number(value.publication.sequence) < 1) throw new Error('envelope.publication.sequence must be a positive integer');
  requiredString(value.publication.publishedAt, 'envelope.publication.publishedAt');
  if (!isRecord(value.provenance) || value.provenance.standard !== 'W3C-PROV') throw new Error('Envelope must carry a W3C-PROV graph');
  for (const field of ['entities', 'activities', 'agents', 'relations']) if (!Array.isArray(value.provenance[field])) throw new Error(`envelope.provenance.${field} must be an array`);
  if (!isRecord(value.fortemi) || value.fortemi.schemaVersion !== '2.0.0' || value.fortemi.profile !== 'full-v1' || value.fortemi.sourceSchemaVersion !== 'aiwg.fortemi.index.export.v2') {
    throw new Error('Envelope requires the exact Fortemi 2.0.0/full-v1 contract');
  }
  if (!Array.isArray(value.signatures)) throw new Error('envelope.signatures must be an array');
  for (const signature of value.signatures) {
    if (!isRecord(signature)) throw new Error('Envelope signatures must be objects');
    exactKeys(signature, ['keyId', 'algorithm', 'publicKey', 'signedAt', 'payloadSha256', 'signature'], 'envelope signature');
    if (signature.algorithm !== 'ed25519') throw new Error(`Unsupported signature algorithm '${String(signature.algorithm)}'`);
    requiredString(signature.keyId, 'signature.keyId');
    requiredString(signature.publicKey, 'signature.publicKey');
    requiredString(signature.signature, 'signature.signature');
    if (!SHA256.test(String(signature.payloadSha256))) throw new Error('Invalid signature payload SHA-256');
  }
}

export function envelopeSigningPayload(envelope: MarketplaceProvenanceEnvelope): Record<string, unknown> {
  const { signatures: _signatures, ...payload } = envelope;
  return payload;
}

// Marketplace signatures are made over this module's `canonicalJson`, which is
// kept (see its comment) so existing envelopes and receipts verify unchanged.
// The helpers themselves live in src/security/signing.ts.
const marketplaceSigner = createCanonicalSigner({
  canonicalize: canonicalJson,
  keyTypeErrorMessage: 'Marketplace signing keys must use Ed25519',
});
function publicKeyFromBase64(value: string): KeyObject {
  return createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' });
}

export function signCanonicalDocument(
  document: Record<string, unknown>,
  privateKeyPem: string,
  options: { keyId?: string; signedAt?: string; publicKeyPem?: string } = {},
): MarketplaceEnvelopeSignature {
  return marketplaceSigner.signCanonicalDocument(document, privateKeyPem, options);
}

export function verifyCanonicalSignature(
  document: Record<string, unknown>,
  signature: MarketplaceEnvelopeSignature,
): boolean {
  return marketplaceSigner.verifyCanonicalSignature(document, signature);
}

export function signingKeyId(publicKey: string | KeyObject): string {
  return marketplaceSigner.signingKeyId(publicKey);
}

export function signProvenanceEnvelope(
  envelope: MarketplaceProvenanceEnvelope,
  privateKeyPem: string,
  options: { keyId?: string; signedAt?: string; publicKeyPem?: string } = {},
): MarketplaceProvenanceEnvelope {
  validateProvenanceEnvelope(envelope);
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Marketplace signing keys must use Ed25519');
  const publicKey = options.publicKeyPem ? createPublicKey(options.publicKeyPem) : createPublicKey(privateKey);
  const keyId = options.keyId ?? signingKeyId(publicKey);
  const prepared: MarketplaceProvenanceEnvelope = {
    ...envelope,
    publisher: { ...envelope.publisher, keyId },
  };
  const signature = signCanonicalDocument(envelopeSigningPayload(prepared), privateKeyPem, {
    keyId,
    signedAt: options.signedAt,
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  });
  return {
    ...prepared,
    signatures: [...prepared.signatures.filter((item) => item.keyId !== keyId), signature]
      .sort((a, b) => a.keyId.localeCompare(b.keyId)),
  };
}

export interface KeyDelegationStatement {
  schemaVersion: 'aiwg.marketplace.key-delegation.v1';
  keyId: string;
  publicKey: string;
  publisher: string;
  validFrom: string;
  validUntil?: string;
  artifactIdentityId?: string;
}

export function keyDelegationStatement(key: MarketplaceTrustedKey): KeyDelegationStatement {
  return {
    schemaVersion: 'aiwg.marketplace.key-delegation.v1',
    keyId: key.keyId,
    publicKey: key.publicKey,
    publisher: key.publisher,
    validFrom: key.validFrom,
    ...(key.validUntil ? { validUntil: key.validUntil } : {}),
    ...(key.artifactIdentityId ? { artifactIdentityId: key.artifactIdentityId } : {}),
  };
}

export function signKeyDelegation(key: MarketplaceTrustedKey, parentPrivateKeyPem: string): string {
  return cryptoSign(null, Buffer.from(canonicalJson(keyDelegationStatement(key))), createPrivateKey(parentPrivateKeyPem)).toString('base64');
}

function verifyTrustedKey(
  key: MarketplaceTrustedKey,
  store: MarketplaceTrustStore,
  at: Date,
  seen = new Set<string>(),
): { ok: boolean; detail: string } {
  if (seen.has(key.keyId)) return { ok: false, detail: `Delegation cycle at '${key.keyId}'` };
  seen.add(key.keyId);
  if (key.revokedAt && new Date(key.revokedAt) <= at) return { ok: false, detail: `Key '${key.keyId}' is revoked` };
  if (new Date(key.validFrom) > at) return { ok: false, detail: `Key '${key.keyId}' is not yet valid` };
  if (key.validUntil && new Date(key.validUntil) < at) return { ok: false, detail: `Key '${key.keyId}' is expired` };
  if (key.trustRoot) return { ok: true, detail: `Trusted root '${key.keyId}'` };
  if (!key.delegatedBy || !key.delegationSignature) return { ok: false, detail: `Key '${key.keyId}' has no trusted delegation` };
  const parent = store.keys.find((candidate) => candidate.keyId === key.delegatedBy);
  if (!parent) return { ok: false, detail: `Delegating key '${key.delegatedBy}' is unavailable` };
  const parentResult = verifyTrustedKey(parent, store, at, seen);
  if (!parentResult.ok) return parentResult;
  const valid = cryptoVerify(
    null,
    Buffer.from(canonicalJson(keyDelegationStatement(key))),
    publicKeyFromBase64(parent.publicKey),
    Buffer.from(key.delegationSignature, 'base64'),
  );
  return valid
    ? { ok: true, detail: `Key '${key.keyId}' delegated by '${parent.keyId}'` }
    : { ok: false, detail: `Invalid delegation signature for '${key.keyId}'` };
}

export function verifyDocumentTrust(options: {
  document: Record<string, unknown>;
  signatures: MarketplaceEnvelopeSignature[];
  trustStore: MarketplaceTrustStore;
  publisher?: string;
  at?: Date;
}): { ok: boolean; signer?: string; errors: string[] } {
  const errors: string[] = [];
  for (const signature of options.signatures) {
    if (!verifyCanonicalSignature(options.document, signature)) {
      errors.push(`Invalid signature from '${signature.keyId}'`);
      continue;
    }
    const key = options.trustStore.keys.find((candidate) => candidate.keyId === signature.keyId);
    if (!key) {
      errors.push(`Signature key '${signature.keyId}' is not trusted`);
      continue;
    }
    if (key.publicKey !== signature.publicKey) {
      errors.push(`Trusted key material mismatch for '${signature.keyId}'`);
      continue;
    }
    if (options.publisher && key.publisher !== options.publisher) {
      errors.push(`Trusted key publisher mismatch for '${signature.keyId}'`);
      continue;
    }
    const trust = verifyTrustedKey(key, options.trustStore, options.at ?? new Date(signature.signedAt));
    if (trust.ok) return { ok: true, signer: signature.keyId, errors: [] };
    errors.push(trust.detail);
  }
  return { ok: false, errors };
}

export function createPackageLock(
  envelope: MarketplaceProvenanceEnvelope,
  createdAt = new Date().toISOString(),
): MarketplacePackageLock {
  validateProvenanceEnvelope(envelope);
  const identity = `${envelope.package.namespace}/${envelope.package.name}`;
  const immutableIdentity = {
    identity,
    version: envelope.package.version,
    canonicalRemote: envelope.source.canonicalRemote,
    resolvedCommit: envelope.source.resolvedCommit,
    gitTreeObject: envelope.source.gitTreeObject,
    treeSha256: envelope.source.treeSha256,
    artifactSha256: envelope.source.artifactSha256,
    wrapperSchemaVersion: envelope.package.wrapperSchemaVersion,
    fortemiProfile: '2.0.0/full-v1',
    dependencyLocks: Object.fromEntries(
      envelope.package.dependencies
        .filter((dependency) => !dependency.optional && dependency.lockId)
        .sort((a, b) => a.identity.localeCompare(b.identity))
        .map((dependency) => [dependency.identity, dependency.lockId!]),
    ),
  } as const;
  return {
    schemaVersion: MARKETPLACE_LOCK_SCHEMA,
    lockId: `sha256:${sha256(canonicalJson(immutableIdentity))}`,
    ...immutableIdentity,
    requestedRef: envelope.source.requestedRef,
    envelopeSha256: sha256(canonicalJson(envelope)),
    createdAt,
  };
}

export function envelopeToFortemiIndex(envelope: MarketplaceProvenanceEnvelope): AiwgFortemiIndexExport {
  validateProvenanceEnvelope(envelope);
  const identity = `${envelope.package.namespace}/${envelope.package.name}@${envelope.package.version}`;
  const text = canonicalJson(envelope);
  return {
    schema_version: 'aiwg.fortemi.index.export.v2',
    generated_at: envelope.publication.publishedAt,
    source: {
      repo: envelope.source.canonicalRemote,
      privacy: 'public',
      graph: 'marketplace-provenance',
    },
    compatibility: {
      previous_schema_version: 'aiwg.fortemi.index.export.v1',
      strategy: 'supported',
    },
    items: [{
      schema_version: 'aiwg.fortemi.index.record.v2',
      id: `marketplace:${sha256(identity).slice(0, 32)}`,
      type: 'aiwg.artifact',
      source: {
        path: 'aiwg-marketplace-envelope.json',
        repo_relative_path: 'aiwg-marketplace-envelope.json',
        locator: identity,
        updated_at: envelope.publication.publishedAt,
      },
      title: identity,
      text,
      facets: {},
      tags: ['marketplace', 'provenance', envelope.package.type],
      concepts: ['aiwg:marketplace-package', 'w3c:prov'],
      skos_concepts: [
        {
          id: 'aiwg:marketplace-package',
          prefLabel: 'AIWG marketplace package',
          scheme: 'aiwg-marketplace',
          definition: 'A Git-native AIWG package with a verifiable provenance envelope.',
        },
        {
          id: 'w3c:prov',
          prefLabel: 'W3C PROV',
          scheme: 'provenance-standards',
          definition: 'Entity, activity, agent, and relationship provenance graph.',
        },
      ],
      relationships: [],
      provenance: [{
        field: 'text',
        source: envelope.source.canonicalRemote,
        path: '$',
        confidence: 'source',
        privacy: 'public',
      }],
      provenance_events: envelope.provenance.activities.map((activity) => ({
        id: activity.id,
        activity: activity.type,
        agent: envelope.publisher.id,
        started_at: activity.startedAt,
        ended_at: activity.endedAt,
        attributes: activity.attributes ?? {},
      })),
      privacy: { classification: 'public', pii: false },
      updated_at: envelope.publication.publishedAt,
    }],
  } as unknown as AiwgFortemiIndexExport;
}

export async function buildFortemiEnvelopeShard(envelope: MarketplaceProvenanceEnvelope): Promise<{
  archive: Uint8Array;
  conformance: MarketplaceConformanceEvidence;
}> {
  const core = await import('@fortemi/core/aiwg-index-shard');
  const index = envelopeToFortemiIndex(envelope);
  const result = await core.aiwgFortemiIndexToKnowledgeShardWithReport(index, {
    createdAt: envelope.publication.publishedAt,
    matricVersion: 'aiwg-marketplace-v1',
  });
  if (!result.success || !result.lossless || !result.archive) {
    const detail = result.losses.map((loss) => `${loss.code}: ${loss.message}${loss.field_path ? ` (${loss.field_path})` : ''}${loss.reason ? ` [${loss.reason}]` : ''}`).join('; ');
    throw new Error(`Fortemi full-v1 conversion would be lossy${detail ? `: ${detail}` : ''}`);
  }
  await verifyFortemiEnvelopeShard(envelope, result.archive);
  return {
    archive: result.archive,
    conformance: {
      profile: '2.0.0/full-v1',
      lossless: true,
      contractValid: result.receipt.contract_valid,
      shardSha256: sha256(result.archive),
      conversionReceipt: result.receipt as unknown as Record<string, unknown>,
    },
  };
}

/** Validate the authority contract and prove the exact canonical envelope is embedded. */
export async function verifyFortemiEnvelopeShard(
  envelope: MarketplaceProvenanceEnvelope,
  archive: Uint8Array,
): Promise<void> {
  const core = await import('@fortemi/core');
  const validation = await core.validateFullV1ShardArchive(archive);
  if (!validation.valid) throw new Error(`Invalid Fortemi 2.0.0/full-v1 archive: ${validation.errors.join('; ')}`);
  const files = core.unpackTarGz(archive);
  const canonical = canonicalJson(envelope);
  const escaped = JSON.stringify(canonical).slice(1, -1);
  const embedded = [...files.values()].some((bytes) => {
    const text = Buffer.from(bytes).toString('utf8');
    return text.includes(canonical) || text.includes(escaped);
  });
  if (!embedded) throw new Error('Fortemi full-v1 archive does not contain the exact canonical provenance envelope');
}

export function createOperationReceipt(options: {
  operation: MarketplaceOperation;
  lock: MarketplacePackageLock;
  actor: string;
  result?: 'success' | 'failure';
  verificationStatus: MarketplaceOperationReceipt['verificationStatus'];
  evidence?: MarketplaceOperationReceipt['evidence'];
  conformance: MarketplaceConformanceEvidence;
  occurredAt?: string;
}): MarketplaceOperationReceipt {
  const occurredAt = options.occurredAt ?? new Date().toISOString();
  const body = {
    operation: options.operation,
    occurredAt,
    actor: options.actor,
    lockId: options.lock.lockId,
    envelopeSha256: options.lock.envelopeSha256,
    result: options.result ?? 'success',
    verificationStatus: options.verificationStatus,
    evidence: options.evidence ?? {},
    conformance: options.conformance,
  };
  return {
    schemaVersion: MARKETPLACE_RECEIPT_SCHEMA,
    receiptId: `sha256:${sha256(canonicalJson(body))}`,
    ...body,
  };
}

async function verifyInventory(
  envelope: MarketplaceProvenanceEnvelope,
  contentRoot: string,
): Promise<Array<{ check: string; ok: boolean; detail: string }>> {
  const actual = await inventoryDirectory(contentRoot);
  const expected = envelope.package.inventory;
  const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
  const actualDigest = inventorySha256(actual);
  checks.push({
    check: 'artifact-digest',
    ok: actualDigest === envelope.source.artifactSha256,
    detail: actualDigest === envelope.source.artifactSha256
      ? actualDigest
      : `expected ${envelope.source.artifactSha256}, got ${actualDigest}`,
  });
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));
  for (const expectedEntry of expected) {
    const found = actualByPath.get(expectedEntry.path);
    checks.push({
      check: `file:${expectedEntry.path}`,
      ok: Boolean(found && canonicalJson(found) === canonicalJson(expectedEntry)),
      detail: found ? found.sha256 : 'missing',
    });
  }
  const expectedPaths = new Set(expected.map((entry) => entry.path));
  const extras = actual.filter((entry) => !expectedPaths.has(entry.path));
  checks.push({
    check: 'file-inventory-complete',
    ok: extras.length === 0 && actual.length === expected.length,
    detail: extras.length ? `unexpected: ${extras.map((entry) => entry.path).join(', ')}` : `${actual.length} files`,
  });
  return checks;
}

export async function verifyProvenanceEnvelope(options: {
  envelope: MarketplaceProvenanceEnvelope;
  contentRoot?: string;
  checkoutPath?: string;
  trustStore?: MarketplaceTrustStore;
  policy?: Partial<MarketplaceVerificationPolicy>;
  installedLocks?: Record<string, string>;
  previousLock?: MarketplacePackageLock;
  at?: Date;
}): Promise<MarketplaceVerificationResult> {
  const policy = { ...INTEGRITY_ONLY_POLICY, ...options.policy };
  const checks: MarketplaceVerificationResult['checks'] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  let envelope: MarketplaceProvenanceEnvelope;
  try {
    validateProvenanceEnvelope(options.envelope);
    envelope = options.envelope;
    checks.push({ check: 'envelope-schema', ok: true, detail: MARKETPLACE_ENVELOPE_SCHEMA });
  } catch (error) {
    throw new Error(`Invalid marketplace provenance envelope: ${error instanceof Error ? error.message : String(error)}`);
  }
  const lock = createPackageLock(envelope, envelope.publication.publishedAt);
  const envelopeSha256 = sha256(canonicalJson(envelope));

  if (options.contentRoot) {
    const inventoryChecks = await verifyInventory(envelope, options.contentRoot);
    checks.push(...inventoryChecks);
    errors.push(...inventoryChecks.filter((check) => !check.ok).map((check) => `${check.check}: ${check.detail}`));
  }

  if (options.checkoutPath) {
    try {
      const gitIdentity = await inspectGitCheckout(options.checkoutPath);
      for (const [check, actual, expected] of [
        ['git-commit', gitIdentity.resolvedCommit, envelope.source.resolvedCommit],
        ['git-tree-object', gitIdentity.gitTreeObject, envelope.source.gitTreeObject],
        ['git-tree-digest', gitIdentity.treeSha256, envelope.source.treeSha256],
        ['git-remote', gitIdentity.canonicalRemote, envelope.source.canonicalRemote],
      ]) {
        const ok = actual === expected;
        checks.push({ check, ok, detail: ok ? actual : `expected ${expected}, got ${actual}` });
        if (!ok) errors.push(`${check} mismatch`);
      }
    } catch (error) {
      errors.push(`git-evidence: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (envelope.publication.yanked && !policy.allowYanked) errors.push('Package version is yanked by its publisher');
  if (envelope.publication.deprecated && !policy.allowDeprecated) errors.push('Package version is deprecated by policy');
  const identity = `${envelope.package.namespace}/${envelope.package.name}`;
  const minimum = policy.minimumSequence?.[identity];
  if (minimum !== undefined && envelope.publication.sequence < minimum && !policy.allowRollback) {
    errors.push(`Publication sequence ${envelope.publication.sequence} is below trusted minimum ${minimum}`);
  }
  if (policy.requiredPublisher && envelope.publisher.id !== policy.requiredPublisher) {
    errors.push(`Publisher '${envelope.publisher.id}' does not match required publisher '${policy.requiredPublisher}'`);
  }
  if (options.previousLock && !policy.allowRefMove
    && options.previousLock.canonicalRemote === lock.canonicalRemote
    && options.previousLock.requestedRef === lock.requestedRef
    && options.previousLock.resolvedCommit !== lock.resolvedCommit) {
    errors.push(`Mutable ref '${lock.requestedRef}' moved from ${options.previousLock.resolvedCommit} to ${lock.resolvedCommit}`);
  }
  for (const dependency of envelope.package.dependencies.filter((item) => !item.optional)) {
    if (!dependency.lockId) {
      if (policy.requireDependencyLocks) errors.push(`Required dependency '${dependency.identity}' has no immutable lockId`);
      continue;
    }
    const actual = options.installedLocks?.[dependency.identity];
    const ok = actual === dependency.lockId;
    checks.push({ check: `dependency:${dependency.identity}`, ok, detail: actual ?? 'not installed' });
    if (!ok) errors.push(`Dependency substitution detected for '${dependency.identity}'`);
  }

  const payload = canonicalJson(envelopeSigningPayload(envelope));
  const payloadDigest = sha256(payload);
  let trustedSigner: string | undefined;
  for (const signature of envelope.signatures) {
    const digestOk = signature.payloadSha256 === payloadDigest;
    const signatureOk = digestOk && cryptoVerify(
      null,
      Buffer.from(payload),
      publicKeyFromBase64(signature.publicKey),
      Buffer.from(signature.signature, 'base64'),
    );
    checks.push({
      check: `signature:${signature.keyId}`,
      ok: signatureOk,
      detail: signatureOk ? 'cryptographically valid' : 'invalid signature or signed-payload digest',
    });
    if (!signatureOk) {
      errors.push(`Invalid signature from '${signature.keyId}'`);
      continue;
    }
    const trustedKey = options.trustStore?.keys.find((key) => key.keyId === signature.keyId);
    if (!trustedKey) {
      warnings.push(`Signature key '${signature.keyId}' is not in the local trust store`);
      continue;
    }
    if (trustedKey.publicKey !== signature.publicKey) {
      errors.push(`Trusted key material mismatch for '${signature.keyId}'`);
      continue;
    }
    const trust = verifyTrustedKey(trustedKey, options.trustStore!, options.at ?? new Date());
    checks.push({ check: `trust:${signature.keyId}`, ok: trust.ok, detail: trust.detail });
    if (!trust.ok) errors.push(trust.detail);
    else if (trustedKey.publisher !== envelope.publisher.id) errors.push(`Trusted key publisher mismatch for '${signature.keyId}'`);
    else trustedSigner = signature.keyId;
  }
  if (envelope.signatures.length === 0) warnings.push('Envelope is unsigned');
  if (policy.requireSignature && !trustedSigner) errors.push('Policy requires a valid signature chained to a local trust root');
  if (!trustedSigner && !policy.allowIntegrityOnly) errors.push('Policy does not permit integrity-only verification');

  const ok = errors.length === 0;
  const status = !ok ? 'failed' : trustedSigner ? 'verified' : envelope.signatures.length ? 'untrusted' : 'integrity-only';
  return {
    ok,
    status,
    lock,
    envelopeSha256,
    ...(trustedSigner ? { signer: trustedSigner } : {}),
    checks,
    errors,
    warnings,
  };
}
