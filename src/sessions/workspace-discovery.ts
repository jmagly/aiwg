import { createReadStream } from 'node:fs';
import {
  access, mkdir, readFile, realpath, rename, stat, writeFile,
} from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { ClaudeSessionAdapter } from './adapters/claude.js';
import { CodexSessionAdapter } from './adapters/codex.js';
import { CursorSessionAdapter } from './adapters/cursor.js';
import { FactorySessionAdapter } from './adapters/factory.js';
import { OmpSessionAdapter, readOmpSessionHeader } from './adapters/omp.js';
import { resolveOmpPaths } from '../providers/omp-paths.mjs';
import { PiSessionAdapter } from './adapters/pi.js';
import { DeepSeekHarnessSessionAdapter } from './adapters/deepseek-harness.js';
import {
  SESSION_PROVIDER_IDS,
  sha256,
  type AuthorizedScope,
  type SessionProviderId,
  type SessionSourceAdapter,
  type SourceDescriptor,
} from './contracts.js';
import { redactSourceLocator } from './discovery.js';
import { fingerprintSourceFile } from './readers.js';

export const DISCOVERY_MANIFEST_VERSION = '1.0.0' as const;

export type DiscoveryProviderStatus =
  | 'checked'
  | 'unavailable'
  | 'export-required'
  | 'not-checked';

export interface DiscoveryManifestSource {
  sourceId: string;
  provider: SessionProviderId;
  locator: string;
  redactedLocator: string;
  locatorClass: string;
  authorizedRoot: string;
  modifiedAt: string;
  sizeBytes: number;
  digest: string;
}

export interface DiscoveryProviderReport {
  provider: SessionProviderId;
  status: DiscoveryProviderStatus;
  disposition: 'discoverable' | 'manual-export' | 'unsupported';
  sourceCount: number;
  dateRange: { earliest: string | null; latest: string | null };
  dateRangeBasis: 'source-mtime';
  reasonCode: string | null;
  remediation: string | null;
}

export interface SessionDiscoveryManifest {
  schemaVersion: typeof DISCOVERY_MANIFEST_VERSION;
  manifestId: string;
  createdAt: string;
  workspaceId: string;
  workspacePath: string;
  providers: DiscoveryProviderReport[];
  sources: DiscoveryManifestSource[];
}

export interface DiscoverWorkspaceOptions {
  workspace: string;
  providerHome?: string;
  operatorHome?: string;
  codexRoot?: string;
  ompRoot?: string;
  dshRoot?: string;
  createdAt?: string;
}

interface DiscoverableProvider {
  provider: 'claude' | 'codex' | 'cursor' | 'factory' | 'pi' | 'omp' | 'deepseek-harness';
  adapter: SessionSourceAdapter;
  roots: string[];
}

const MANUAL_EXPORT_PROVIDERS = new Set<SessionProviderId>([
  'copilot', 'hermes', 'opencode', 'openclaw', 'openhuman', 'grokbot',
  'warp', 'devin-desktop', 'muse', 'generic',
]);

export async function discoverWorkspaceHistories(
  options: DiscoverWorkspaceOptions,
): Promise<SessionDiscoveryManifest> {
  const workspacePath = await canonicalPath(options.workspace);
  const workspaceId = workspacePath;
  const providerHomes = providerHomeCandidates(options.providerHome, options.operatorHome);
  const keyWithLeadingDash = workspaceKey(workspacePath, true);
  const keyWithoutLeadingDash = workspaceKey(workspacePath, false);
  const discoverable: DiscoverableProvider[] = [
    { provider: 'deepseek-harness', adapter: new DeepSeekHarnessSessionAdapter(), roots: options.dshRoot
      ? [resolve(options.dshRoot)] : options.providerHome
        ? [join(resolve(options.providerHome), '.dsh', 'sessions')] : [] },
    { provider: 'omp', adapter: new OmpSessionAdapter(), roots: options.ompRoot
      ? [resolve(options.ompRoot)] : options.providerHome
        ? [resolveOmpPaths({ home: resolve(options.providerHome), cwd: workspacePath }).sessionsDir] : [] },
    {
      provider: 'claude',
      adapter: new ClaudeSessionAdapter(),
      roots: providerHomes.map(
        (providerHome) => join(providerHome, '.claude', 'projects', keyWithLeadingDash),
      ),
    },
    {
      provider: 'codex',
      adapter: new CodexSessionAdapter(),
      roots: options.codexRoot
        ? [resolve(options.codexRoot)]
        : options.providerHome
          ? [join(resolve(options.providerHome), '.codex', 'sessions')]
          : [],
    },
    {
      provider: 'cursor',
      adapter: new CursorSessionAdapter(),
      roots: providerHomes.map(
        (providerHome) =>
          join(providerHome, '.cursor', 'projects', keyWithoutLeadingDash, 'agent-transcripts'),
      ),
    },
    {
      provider: 'factory',
      adapter: new FactorySessionAdapter(),
      roots: providerHomes.flatMap((providerHome) => [
        join(providerHome, '.factory', 'projects', keyWithLeadingDash),
        join(providerHome, '.factory', 'sessions', keyWithLeadingDash),
      ]),
    },
    {
      provider: 'pi',
      adapter: new PiSessionAdapter(),
      roots: options.providerHome
        ? [process.env.PI_CODING_AGENT_SESSION_DIR
          ? resolve(process.env.PI_CODING_AGENT_SESSION_DIR)
          : join(resolve(options.providerHome), '.pi', 'agent', 'sessions')]
        : [],
    },
  ];

  const reports = new Map<SessionProviderId, DiscoveryProviderReport>();
  const candidates: DiscoveryManifestSource[] = [];
  const seen = new Set<string>();
  for (const entry of discoverable) {
    const availableRoots = [];
    for (const root of entry.roots) {
      if (await pathExists(root)) availableRoots.push(await canonicalPath(root));
    }
    if (availableRoots.length === 0) {
      const codexNeedsAuthorization = (entry.provider === 'codex' || entry.provider === 'omp' || entry.provider === 'deepseek-harness')
        && entry.roots.length === 0;
      reports.set(entry.provider, providerReport(
        entry.provider,
        codexNeedsAuthorization ? 'export-required' : 'unavailable',
        codexNeedsAuthorization ? 'manual-export' : 'discoverable',
        [],
        codexNeedsAuthorization
          ? 'SHARED_ROOT_AUTHORIZATION_REQUIRED'
          : 'PROVIDER_ROOT_UNAVAILABLE',
        codexNeedsAuthorization
          ? `Pass --${entry.provider}-root with an explicitly authorized sessions root.`
          : `No authorized ${entry.provider} workspace history root was found.`,
      ));
      continue;
    }
    const scope: AuthorizedScope = {
      workspaceId,
      allowedRoots: availableRoots,
    };
    const providerSources: DiscoveryManifestSource[] = [];
    for await (const descriptor of entry.adapter.discover(scope)) {
      const locator = await canonicalPath(descriptor.locator);
      if (entry.provider === 'codex'
        && !await codexSourceMatchesWorkspace(locator, workspacePath)) continue;
      const ompHeader = entry.provider === 'omp' ? await readOmpSessionHeader({ ...descriptor, sourceId: 'discovery', authorizedScope: scope }) : undefined;
      if (ompHeader && resolve(ompHeader.cwd) !== workspacePath) continue;
      const details = await stat(locator);
      const authorizedRoot = scope.allowedRoots.find(
        (root) => locator === root || locator.startsWith(`${root}/`),
      );
      if (!authorizedRoot) continue;
      const fingerprint = await fingerprintSourceFile({
        selectedPath: locator,
        allowedRoots: [authorizedRoot],
      });
      const dedupeKey = `${entry.provider}\0${fingerprint.digest}\0${fingerprint.size}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const source = sourceFromDescriptor(
        descriptor,
        locator,
        authorizedRoot,
        details,
        fingerprint.digest,
      );
      if (ompHeader) source.sourceId = sha256(['omp-native-source-v1', workspaceId, ompHeader.id].join('\0'));
      providerSources.push(source);
      candidates.push(source);
    }
    reports.set(entry.provider, providerReport(
      entry.provider,
      'checked',
      'discoverable',
      providerSources,
      providerSources.length === 0 ? 'NO_WORKSPACE_SOURCES' : null,
      providerSources.length === 0
        ? `The ${entry.provider} root was checked, but no source matched the authorized workspace.`
        : null,
    ));
  }

  for (const provider of SESSION_PROVIDER_IDS) {
    if (reports.has(provider)) continue;
    const manual = MANUAL_EXPORT_PROVIDERS.has(provider);
    reports.set(provider, providerReport(
      provider,
      manual ? 'export-required' : 'not-checked',
      manual ? 'manual-export' : 'unsupported',
      [],
      manual ? 'EXPLICIT_EXPORT_REQUIRED' : 'PROVIDER_NOT_CHECKED',
      manual
        ? `Select and authorize a supported ${provider} export before importing it.`
        : `No discovery strategy is registered for ${provider}.`,
    ));
  }

  const sources = candidates.sort(compareSources);
  const providers = [...reports.values()].sort((a, b) => a.provider.localeCompare(b.provider));
  const identity = {
    schemaVersion: DISCOVERY_MANIFEST_VERSION,
    workspaceId,
    sources: sources.map((source) => ({
      sourceId: source.sourceId,
      provider: source.provider,
      locatorClass: source.locatorClass,
      locator: source.locator,
      modifiedAt: source.modifiedAt,
      sizeBytes: source.sizeBytes,
      digest: source.digest,
    })),
    providers: providers.map((provider) => ({
      provider: provider.provider,
      status: provider.status,
      reasonCode: provider.reasonCode,
    })),
  };
  return {
    schemaVersion: DISCOVERY_MANIFEST_VERSION,
    manifestId: sha256(JSON.stringify(identity)),
    createdAt: options.createdAt ?? new Date().toISOString(),
    workspaceId,
    workspacePath,
    providers,
    sources,
  };
}

export function defaultDiscoveryManifestPath(workspace: string): string {
  return resolve(workspace, '.aiwg', 'sessions', 'discovery-manifest.json');
}

export async function writeDiscoveryManifest(
  path: string,
  manifest: SessionDiscoveryManifest,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function readDiscoveryManifest(path: string): Promise<SessionDiscoveryManifest> {
  const value = JSON.parse(await readFile(path, 'utf8')) as SessionDiscoveryManifest;
  if (value.schemaVersion !== DISCOVERY_MANIFEST_VERSION
    || typeof value.manifestId !== 'string'
    || typeof value.workspaceId !== 'string'
    || !Array.isArray(value.providers)
    || !Array.isArray(value.sources)) {
    throw new Error('session discovery manifest is malformed or unsupported');
  }
  const expected = await rediscoverManifestIdentity(value);
  if (expected !== value.manifestId) {
    throw new Error('session discovery manifest identity does not match its contents');
  }
  return value;
}

export function publicDiscoveryManifest(manifest: SessionDiscoveryManifest): Record<string, unknown> {
  return {
    schemaVersion: manifest.schemaVersion,
    manifestId: manifest.manifestId,
    createdAt: manifest.createdAt,
    workspaceId: manifest.workspaceId,
    workspacePath: manifest.workspacePath,
    providers: manifest.providers,
    sources: manifest.sources.map(({ locator: _locator, authorizedRoot: _root, ...source }) => source),
    totals: {
      providers: manifest.providers.length,
      sources: manifest.sources.length,
    },
  };
}

function sourceFromDescriptor(
  descriptor: SourceDescriptor,
  locator: string,
  authorizedRoot: string,
  details: Awaited<ReturnType<typeof stat>>,
  digest: string,
): DiscoveryManifestSource {
  return {
    sourceId: sha256([
      'workspace-source-v1', descriptor.provider, descriptor.locatorClass, digest,
    ].join('\0')),
    provider: descriptor.provider,
    locator,
    redactedLocator: redactSourceLocator(locator),
    locatorClass: descriptor.locatorClass,
    authorizedRoot,
    modifiedAt: details.mtime.toISOString(),
    sizeBytes: Number(details.size),
    digest,
  };
}

function providerReport(
  provider: SessionProviderId,
  status: DiscoveryProviderStatus,
  disposition: DiscoveryProviderReport['disposition'],
  sources: DiscoveryManifestSource[],
  reasonCode: string | null,
  remediation: string | null,
): DiscoveryProviderReport {
  const timestamps = sources.map((source) => source.modifiedAt).sort();
  return {
    provider,
    status,
    disposition,
    sourceCount: sources.length,
    dateRange: {
      earliest: timestamps.at(0) ?? null,
      latest: timestamps.at(-1) ?? null,
    },
    dateRangeBasis: 'source-mtime',
    reasonCode,
    remediation,
  };
}

async function rediscoverManifestIdentity(manifest: SessionDiscoveryManifest): Promise<string> {
  const identity = {
    schemaVersion: manifest.schemaVersion,
    workspaceId: manifest.workspaceId,
    sources: manifest.sources.map((source) => ({
      sourceId: source.sourceId,
      provider: source.provider,
      locatorClass: source.locatorClass,
      locator: source.locator,
      modifiedAt: source.modifiedAt,
      sizeBytes: source.sizeBytes,
      digest: source.digest,
    })),
    providers: manifest.providers.map((provider) => ({
      provider: provider.provider,
      status: provider.status,
      reasonCode: provider.reasonCode,
    })),
  };
  return sha256(JSON.stringify(identity));
}

async function codexSourceMatchesWorkspace(
  locator: string,
  workspacePath: string,
): Promise<boolean> {
  const input = createReadStream(locator, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let count = 0;
  try {
    for await (const line of lines) {
      if (++count > 50) break;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const cwd = codexWorkspaceField(value);
      if (!cwd) continue;
      try {
        return await canonicalPath(cwd) === workspacePath;
      } catch {
        return resolve(cwd) === workspacePath;
      }
    }
    return false;
  } finally {
    lines.close();
    input.destroy();
  }
}

function codexWorkspaceField(value: unknown): string | null {
  const root = asObject(value);
  const payload = asObject(root.payload);
  const result = asObject(root.result);
  const resultThread = asObject(result.thread);
  const params = asObject(root.params);
  const paramsThread = asObject(params.thread);
  for (const candidate of [
    payload.cwd, result.cwd, resultThread.cwd, params.cwd, paramsThread.cwd,
  ]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return null;
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function canonicalPath(path: string): Promise<string> {
  return realpath(resolve(path));
}

function workspaceKey(path: string, retainLeadingSeparator: boolean): string {
  const normalized = path.replace(/\\/g, '/');
  const input = retainLeadingSeparator ? normalized : normalized.replace(/^\/+/, '');
  return input.replace(/[/:]+/g, '-');
}

function providerHomeCandidates(
  explicit: string | undefined,
  operatorHome: string | undefined,
): string[] {
  if (explicit) return [resolve(explicit)];
  let accountHome = operatorHome;
  if (!accountHome) {
    try {
      accountHome = userInfo().homedir;
    } catch {
      accountHome = undefined;
    }
  }
  return [...new Set([homedir(), accountHome].filter(
    (candidate): candidate is string => Boolean(candidate),
  ).map((candidate) => resolve(candidate)))];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function compareSources(
  left: DiscoveryManifestSource,
  right: DiscoveryManifestSource,
): number {
  return left.provider.localeCompare(right.provider)
    || left.locator.localeCompare(right.locator)
    || basename(left.locator).localeCompare(basename(right.locator));
}
