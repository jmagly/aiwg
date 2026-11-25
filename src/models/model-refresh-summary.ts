// Keep refresh receipts small while the complete observations remain in the cache.
import type { DynamicModelCatalog } from './model-discovery.js';

export function summarizeModelRefresh(catalog: DynamicModelCatalog, cachePath: string) {
  const discovery = catalog.discovery;
  const entries = Object.entries(discovery?.providers ?? {});
  const providers = entries.map(([provider, entry]) => ({
    provider, modelCount: entry.models.length,
    ...(entry.errorKind ? { errorKind: entry.errorKind } : {}),
  }));
  const warnings = [
    ...(discovery?.remoteError ? [discovery.remoteError.slice(0, 512)] : []),
    ...entries.flatMap(([provider, entry]) => entry.error || entry.errorKind
      ? [`${provider}: ${entry.error ?? entry.errorKind}`.slice(0, 512)] : []),
  ];
  return {
    source: discovery?.source ?? 'static',
    ...(discovery ? { fetchedAt: discovery.fetchedAt } : {}),
    cachePath,
    providers,
    modelCount: providers.reduce((total, provider) => total + provider.modelCount, 0),
    warnings,
  };
}
