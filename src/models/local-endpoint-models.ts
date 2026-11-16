// Observe declared self-hosted model presence without inference or vendor discovery.
import type { WorkerInstallation } from '../config/worker-parallelism.js';
import { buildWorkerObservation, discoveryDigest, runModelDiscoveryCommand,
  type DynamicModelCatalog, type ModelDiscoveryOptions, type ProviderModelDiscovery } from './model-discovery.js';
import { loadProviderModelCapabilities } from './provider-policy.js';
import { normalizeWorkerVersionBanner, workerVersionProbeEnvironment } from './worker-installation.mjs';

export interface LocalModelSource {
  endpoint: string;
  authEnv?: string;
  allowedHosts?: string[];
  timeoutMs?: number;
  models: Array<{ id: string; checkpoint: string; family?: string; contextTokens?: number;
    maxOutputTokens?: number; efforts?: string[] }>;
}
export type LocalUnavailableReason = 'endpoint-down' | 'timeout' | 'unauthorized' | 'model-missing'
  | 'invalid-response' | 'host-denied' | 'auth-env-missing';

/** Reject credentials and redirect destinations before issuing any request. */
export function localModelsUrl(source: LocalModelSource): URL {
  const url = new URL(source.endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('host-denied');
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && !source.allowedHosts?.includes(url.hostname)) throw new Error('host-denied');
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/models`;
  return url;
}

/** Failures are typed observations; response bodies and credential values never escape. */
export async function discoverLocalEndpointModels(options: {
  cli: string; provider: string; source: LocalModelSource; runtimeVersion: string; accountBinding: string;
  env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; now?: () => Date;
}): Promise<ProviderModelDiscovery> {
  const { source } = options;
  const observedAt = (options.now?.() ?? new Date()).toISOString();
  let reason: LocalUnavailableReason | undefined;
  let ids = new Set<string>();
  try {
    const url = localModelsUrl(source);
    const token = source.authEnv ? (options.env ?? process.env)[source.authEnv] : undefined;
    if (source.authEnv && !token) reason = 'auth-env-missing';
    else {
      const response = await (options.fetchImpl ?? fetch)(url, { redirect: 'error',
        headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(Math.min(30000, Math.max(1, source.timeoutMs ?? 3000))) });
      if (response.status === 401 || response.status === 403) reason = 'unauthorized';
      else if (!response.ok) reason = 'endpoint-down';
      else {
        // Bound response bytes as well as elapsed time, including chunked responses.
        const reader = response.body?.getReader();
        if (!reader) throw new Error('invalid-response');
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 1024 * 1024) throw new Error('invalid-response');
            chunks.push(part.value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!Array.isArray(payload?.data) || payload.data.some((row: { id?: unknown } | null) =>
          !row || typeof row.id !== 'string')) throw new Error('invalid-response');
        ids = new Set(payload.data.map((row: { id: string }) => row.id));
      }
    }
  } catch (error) {
    const name = (error as Error).name;
    reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout'
      : (error as Error).message === 'host-denied' ? 'host-denied'
      : error instanceof SyntaxError || (error as Error).message === 'invalid-response' ? 'invalid-response' : 'endpoint-down';
  }
  const models = source.models.map(declared => {
    const unavailableReason = reason ?? (!ids.has(declared.id) ? 'model-missing' : undefined);
    const worker = buildWorkerObservation({ cliId: options.cli, source: 'local-endpoint',
      runtimeVersion: options.runtimeVersion, accountScope: 'local-runtime', accountBinding: options.accountBinding,
      observedAt, contentDigest: discoveryDigest(JSON.stringify({ declared, endpoint: source.endpoint, unavailableReason })) }, {
      modelId: declared.id, family: declared.family ?? 'unknown', visibility: 'listed', lifecycle: 'active',
      availability: unavailableReason ? 'unavailable' : 'accessible', contextTokens: declared.contextTokens,
      maxOutputTokens: declared.maxOutputTokens, effortSupport: declared.efforts ? 'explicit' : 'not-applicable',
      efforts: declared.efforts?.map(id => ({ id, selfDelegates: null })), provenanceFields: [] });
    worker.endpoint = source.endpoint;
    worker.checkpoint = declared.checkpoint;
    if (unavailableReason) worker.unavailableReason = unavailableReason;
    // Presence is endpoint-observed; execution path and checkpoint remain operator declarations.
    worker.dataUse.processing = 'local';
    worker.pricing.billing = 'local';
    worker.provenance[0].fields = ['/id', '/apiModelId', '/availability', '/unavailableReason', '/observedAt', '/fetchedAt'];
    worker.provenance[0].source = `${source.endpoint.replace(/\/+$/, '')}/models`;
    worker.provenance[0].digest = discoveryDigest(JSON.stringify({ id: declared.id, unavailableReason, observedAt }));
    worker.provenance.push({ fields: ['/endpoint', '/checkpoint', '/family', '/contextTokens', '/maxOutputTokens',
      '/efforts', '/effortSupport', '/dataUse/processing', '/pricing/billing'], source: `/parallelism/clis/${options.cli}/localModels`,
      kind: 'operator', observedAt, digest: discoveryDigest(JSON.stringify(source)), confidence: 'reported' });
    worker.evidenceDigest = discoveryDigest(JSON.stringify({ source, id: declared.id, unavailableReason }));
    return { id: declared.id, apiModelId: declared.id, llmProvider: 'self-hosted', reasoningEfforts: declared.efforts ?? [], worker };
  });
  const failure = reason ?? (models.some(row => row.worker.unavailableReason) ? 'model-missing' : undefined);
  return { provider: options.provider, source: 'local-endpoint', observedAt, runtimeVersion: options.runtimeVersion,
    accountScope: 'local-runtime', accountBinding: options.accountBinding, models,
    ...(failure ? { errorKind: failure === 'unauthorized' ? 'authentication' as const : failure === 'timeout' ? 'timeout' as const : 'environment' as const,
      error: `Local model observation unavailable: ${failure}` } : {}) };
}

function enabledInstallations(options: ModelDiscoveryOptions) {
  return Object.entries(options.parallelism?.clis ?? {}).filter(([, installation]) => installation.enabled !== false);
}

/** A provider shared by vendor and endpoint installations still needs its vendor observation. */
export function usesVendorDiscovery(provider: string, options: ModelDiscoveryOptions): boolean {
  const installations = enabledInstallations(options).filter(([, installation]) => installation.adapter === `providers:${provider}`);
  return !installations.some(([, installation]) => installation.localModels)
    || installations.some(([, installation]) => !installation.localModels);
}

/** Local-only refreshes must not fetch the optional public vendor catalog. */
export function hasOnlyLocalModelSources(options: ModelDiscoveryOptions): boolean {
  return enabledInstallations(options).some(([, installation]) => installation.localModels)
    && !options.inventory.providers.some(provider => provider.available && usesVendorDiscovery(provider.id, options));
}

/** Merge endpoint facts into the normal catalog; its owner performs the single cache write. */
export async function mergeLocalEndpointCatalog(catalog: DynamicModelCatalog, options: ModelDiscoveryOptions,
  cached: DynamicModelCatalog | null): Promise<DynamicModelCatalog> {
  const localInstallations = enabledInstallations(options).filter(([, installation]) => installation.localModels);
  if (!localInstallations.length) return catalog;
  const discovery = catalog.discovery!;
  const instances = Object.fromEntries(Object.entries(discovery.instances ?? {})
    .filter(([, entry]) => entry.source !== 'local-endpoint'));
  for (const [cli, installation] of localInstallations) {
    if (!options.allowNetwork || !options.forceRefresh) {
      const prior = cached?.discovery?.instances?.[cli];
      if (prior?.source === 'local-endpoint' && prior.models.every(row =>
        row.worker?.provenance.some(entry => entry.digest === discoveryDigest(JSON.stringify(installation.localModels))))) {
        instances[cli] = prior;
      }
      continue;
    }
    const provider = installation.adapter.split(':')[1];
    const runtimeVersion = await localRuntimeVersion(installation, options);
    instances[cli] = await discoverLocalEndpointModels({ cli, provider,
      source: installation.localModels!, runtimeVersion, accountBinding: installation.accountScope,
      fetchImpl: options.fetchImpl, now: options.now });
  }
  return { ...catalog, discovery: { ...discovery, instances } };
}

async function localRuntimeVersion(installation: WorkerInstallation, options: ModelDiscoveryOptions): Promise<string> {
  try {
    const registry = loadProviderModelCapabilities();
    const [namespace, id] = installation.adapter.split(':');
    const provider = registry.providers[id as keyof typeof registry.providers];
    const adapter = namespace === 'providers' ? provider?.workerAdapter ?? provider?.workerHealthAdapter
      : registry.workerAdapters?.[id];
    if (adapter?.invocation.kind !== 'process') return 'unknown';
    const result = await (options.runner ?? runModelDiscoveryCommand)(installation.executable ?? adapter.invocation.executable,
      adapter.invocation.versionArgv, { cwd: options.inventory.projectDir, timeoutMs: 3000, env: workerVersionProbeEnvironment() });
    return normalizeWorkerVersionBanner(result.stdout.trim(), adapter.invocation.versionPattern);
  } catch { return 'unknown'; }
}
