// Authenticate canonical source inventories for provider transformation receipts.
import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { InstalledEntry } from '../config/aiwg-config.js';
import type { ArtifactVerificationResult } from '../security/artifact-verifier.js';
import type { VerifiedWebRelease } from '../resources/web-release.js';
import { normalizeProviderDefinitionId } from './provider-definitions.js';
import { installedEntries, type ProviderReceiptIntegrationOptions, type ProviderReceiptRuntimeEvidence } from './transformation-receipt-integration.js';
const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const FRAMEWORK_BUNDLE_DIRS: Readonly<Record<string, string>> = {
  all: 'sdlc-complete',
  sdlc: 'sdlc-complete',
  marketing: 'media-marketing-kit',
  'media-curator': 'media-curator',
  research: 'research-complete',
  forensics: 'forensics-complete',
  dfir: 'forensics-complete',
  'security-engineering': 'security-engineering',
  ops: 'ops-complete',
  validation: 'validation-complete',
  'knowledge-base': 'knowledge-base',
};

interface CanonicalSourceBundle {
  digest: string;
  root: string;
  files: Array<{ path: string; sha256: string; bytes: number; absolutePath: string }>;
  canonicalBytesAvailable: boolean;
}

async function sourceBundleFiles(root: string): Promise<CanonicalSourceBundle['files']> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`canonical source bundle contains a symbolic link: ${candidate}`);
      if (entry.isDirectory()) await walk(candidate);
      else if (entry.isFile()) files.push(candidate);
      else throw new Error(`canonical source bundle contains a non-regular entry: ${candidate}`);
    }
  };
  await walk(root);
  const inventory = await Promise.all(files.map(async absolutePath => {
    const content = await readFile(absolutePath);
    return {
      path: path.relative(root, absolutePath).split(path.sep).join('/'),
      sha256: sha256(content),
      bytes: content.byteLength,
      absolutePath,
    };
  }));
  return inventory.sort((left, right) => left.path.localeCompare(right.path));
}

async function resolveSourceBundle(
  options: ProviderReceiptIntegrationOptions,
  bundle: string,
  entry: InstalledEntry | undefined,
): Promise<CanonicalSourceBundle | null> {
  const candidates: string[] = [];
  if (entry?.source === 'project-local' && entry.localPath) {
    candidates.push(path.resolve(options.projectRoot, entry.localPath, 'manifest.json'));
  }
  const frameworkDir = FRAMEWORK_BUNDLE_DIRS[bundle] ?? bundle;
  candidates.push(
    path.join(options.frameworkRoot, 'agentic', 'code', 'frameworks', frameworkDir, 'manifest.json'),
    path.join(options.frameworkRoot, 'agentic', 'code', 'addons', bundle, 'manifest.json'),
    path.join(options.frameworkRoot, 'agentic', 'code', 'extensions', bundle, 'manifest.json'),
  );
  for (const candidate of candidates) {
    try {
      await access(candidate);
      const root = path.dirname(candidate);
      const files = await sourceBundleFiles(root);
      if (files.length === 0) continue;
      return {
        digest: sha256(stable(files.map(({ path: file, sha256: digest, bytes }) => ({ path: file, sha256: digest, bytes })))),
        root,
        files,
        canonicalBytesAvailable: true,
      };
    } catch {
      // Continue through the canonical source locations.
    }
  }
  const recorded = entry?.manifestHash?.replace(/^sha256:/, '');
  return recorded && /^[a-f0-9]{64}$/.test(recorded)
    ? { digest: recorded, root: '', files: [], canonicalBytesAvailable: false }
    : null;
}

export function receiptBundles(
  installed: Record<string, InstalledEntry>,
  options: ProviderReceiptIntegrationOptions,
): string[] {
  const deployed = Object.keys(installed)
    .filter(bundle => Boolean(installed[bundle]?.deployedTo[options.provider]))
    .sort();
  return deployed.length > 0 ? deployed : [...new Set(options.requestedBundles)].sort();
}

/**
 * Return whether the deployed provider surface includes project-local source
 * material that cannot be authenticated by an AIWG signed web release.
 */
export async function providerReceiptHasLocalSources(
  rawOptions: ProviderReceiptIntegrationOptions,
): Promise<boolean> {
  const provider = normalizeProviderDefinitionId(rawOptions.provider) ?? rawOptions.provider;
  const options = { ...rawOptions, provider };
  const installed = await installedEntries(options);
  return receiptBundles(installed, options)
    .some(bundle => installed[bundle]?.source === 'project-local');
}

/**
 * Convert an already signature-verified web release into the stable verifier
 * result contract for the complete canonical bundle consumed by deployment.
 * Every local file must match its signed descriptor; a registry's self-recorded
 * manifestHash is never an authentication boundary.
 */
export async function sourceVerificationsFromSignedWebRelease(
  options: ProviderReceiptIntegrationOptions,
  release: VerifiedWebRelease,
): Promise<Readonly<Record<string, ArtifactVerificationResult>>> {
  const installed = await installedEntries(options);
  const results: Record<string, ArtifactVerificationResult> = {};
  for (const bundle of receiptBundles(installed, options)) {
    const entry = installed[bundle];
    if (entry?.source === 'project-local') continue;
    const source = await resolveSourceBundle(options, bundle, entry);
    if (!source?.canonicalBytesAvailable) continue;
    let matched = true;
    for (const file of source.files) {
      const relative = path.relative(options.frameworkRoot, file.absolutePath).split(path.sep).join('/');
      if (!relative || relative === '..' || relative.startsWith('../')) {
        matched = false;
        break;
      }
      const descriptor = release.descriptors.get(`raw/${relative}`);
      if (!descriptor || descriptor.sha256 !== file.sha256 || descriptor.size !== file.bytes) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    const artifactName = `aiwg:bundle-inventory:${bundle}`;
    results[bundle] = {
      schemaVersion: 'aiwg.verify.result.v1',
      status: 'verified',
      exitCode: 0,
      artifact: { name: artifactName, sha256: source.digest },
      policy: 'aiwg-signed-web-release',
      identities: ['aiwg-release-publisher'],
      ...(release.channelSequence === undefined ? {} : {
        freshness: {
          namespace: 'aiwg',
          channel: release.selector,
          sequence: release.channelSequence,
          version: release.version,
        },
      }),
      diagnostics: [{
        code: 'SIGNED_RELEASE_DESCRIPTOR',
        message: `Exact canonical source bytes match signed release manifest ${release.manifestDigest}`,
      }],
    };
  }
  return results;
}

export async function sourceEvidence(
  options: ProviderReceiptIntegrationOptions,
  installed: Record<string, InstalledEntry>,
): Promise<ProviderReceiptRuntimeEvidence['source']> {
  const bundles = [...new Set(options.requestedBundles)].sort();
  const materials: Array<Record<string, string>> = [];
  let authenticated = Boolean(options.sourceVerifications);
  for (const bundle of bundles) {
    const entry = installed[bundle];
    const source = await resolveSourceBundle(options, bundle, entry);
    if (!source) {
      return {
        subject: `aiwg:deployment:${sha256(bundles.join('\0')).slice(0, 24)}`,
        sha256: sha256(stable(materials)),
        verification: 'failed',
      };
    }
    const verification = options.sourceVerifications?.[bundle];
    if (!source.canonicalBytesAvailable
      || verification?.status !== 'verified'
      || verification.artifact.sha256 !== source.digest) {
      authenticated = false;
    }
    materials.push({
      bundle,
      digest: source.digest,
      source: entry?.source ?? 'unknown',
      version: entry?.version ?? 'unknown',
    });
  }
  const digest = sha256(stable(materials));
  return {
    subject: `aiwg:deployment:${digest.slice(0, 24)}`,
    sha256: digest,
    verification: options.sourceVerifications
      ? authenticated ? 'verified' : 'failed'
      : 'policy-exempt',
  };
}
