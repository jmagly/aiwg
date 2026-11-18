// Refresh or reuse public adapter snapshots and report the precise query coverage.
import { marketplaceSearchAdapters } from './registry.js';
import { readSearchCache, writeSearchCache } from './cache.js';
import type { PluginSearchReport, PluginSearchResult } from './plugin-search.js';
import type { SearchSnapshot } from './types.js';

export const REFRESH_COMMAND = 'aiwg marketplace search "<query>" --plugins --refresh';
export interface PublicSearchOptions {
  home?: string;
  provider?: string;
  maxAgeDays?: number;
  now?: number;
  refresh?: boolean;
  fetch?: typeof globalThis.fetch;
}

async function responseBody(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty response');
  const buffers: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 5 * 1024 * 1024) throw new Error('Response exceeds 5 MiB');
      buffers.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(buffers).toString('utf8'));
  } finally {
    await reader.cancel();
  }
}
function results(snapshot: SearchSnapshot): PluginSearchResult[] {
  return snapshot.observations.map(entry => ({
    ...entry, id: `${snapshot.source}:${entry.id}`, provider: snapshot.source,
    marketplace: snapshot.source, category: null, sources: [snapshot.endpoint], cacheAsOf: snapshot.fetchedAt,
    installs: typeof entry.signals.installs?.value === 'number'
      ? { ...entry.signals.installs, value: entry.signals.installs.value } : { value: null, asOf: null },
    review: { value: null, asOf: null }, matchedTerms: [],
    installSkill: null, installHelp: 'Discovery only; consult the source for installation guidance.',
  }));
}
export async function appendPublicSearch(report: PluginSearchReport, options: PublicSearchOptions): Promise<void> {
  const now = options.now ?? Date.now();
  for (const adapter of marketplaceSearchAdapters) {
    const coverage: PluginSearchReport['coverage'][number] = {
      source: adapter.source, status: 'skipped', mode: 'none', asOf: null,
      reason: options.provider && options.provider !== 'all' ? `Excluded by --provider ${options.provider}` : `No cache for this query; run ${REFRESH_COMMAND}`,
    };
    report.coverage.push(coverage);
    if (options.provider && options.provider !== 'all') continue;
    let snapshot: SearchSnapshot | null = null;
    try { snapshot = readSearchCache(adapter.source, report.query, options.home); }
    catch { report.warnings.push(`Invalid ${adapter.source} search cache; run ${REFRESH_COMMAND}`); }
    if (options.refresh) {
      try {
        const endpoint = adapter.endpoint(report.query);
        const response = await (options.fetch ?? globalThis.fetch)(endpoint, {
          headers: { accept: 'application/json', 'user-agent': 'aiwg-marketplace-search' },
          redirect: 'error', signal: AbortSignal.timeout(10_000),
        });
        const normalized = adapter.normalize(await responseBody(response), endpoint, new Date(now).toISOString());
        const fresh: SearchSnapshot = { source: adapter.source, query: report.query, endpoint, fetchedAt: new Date(now).toISOString(), ...normalized };
        writeSearchCache(fresh, options.home);
        snapshot = fresh;
        coverage.mode = 'refresh';
      } catch (error) {
        // Do not expose provider response bodies or exception text that may contain remote data.
        const reason = error instanceof Error && /^HTTP \d+$/.test(error.message) ? error.message : 'request, response validation or cache write failed';
        coverage.reason = `Refresh failed (${reason})${snapshot ? '; retained cached observations' : ''}`;
        report.warnings.push(`${adapter.source}: ${coverage.reason}; retry ${REFRESH_COMMAND}`);
      }
    }
    if (!snapshot) continue;
    coverage.status = 'searched';
    if (coverage.mode !== 'refresh') coverage.mode = 'cache';
    coverage.asOf = snapshot.fetchedAt;
    if (!coverage.reason.startsWith('Refresh failed')) coverage.reason = snapshot.limited
      ? 'Bounded first page only; additional or incomplete results were reported by the source'
      : 'Query-specific snapshot; source search may omit unindexed entries';
    if (snapshot.limited) report.warnings.push(`${adapter.source}: ${coverage.reason}`);
    const age = now - Date.parse(snapshot.fetchedAt);
    if (age < 0) report.warnings.push(`Cache date is in the future: ${adapter.source} (as of ${snapshot.fetchedAt})`);
    else if (age > (options.maxAgeDays ?? 30) * 86_400_000) {
      report.warnings.push(`Stale cache: ${adapter.source} (as of ${snapshot.fetchedAt}); run ${REFRESH_COMMAND}`);
    }
    report.results.push(...results(snapshot));
  }
  if (options.refresh && (!options.provider || options.provider === 'all' || options.provider === 'claude')) {
    report.coverage.push({ source: 'claude-refresh', status: 'skipped', mode: 'none', asOf: null,
      reason: 'No established public Claude directory/count endpoint contract; provider-owned caches were not overwritten. Refresh them through Claude.' });
  }
}
export function rankPluginResults(report: PluginSearchReport): void {
  const terms = [...new Set(report.query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
  const tier = (result: PluginSearchResult): number => ({ anthropic: 2, partner: 1, none: 0 })[result.review.value ?? 'none'];
  report.results = report.results.filter(result => {
    const text = [result.name, result.description, result.category, ...result.keywords].join(' ').toLowerCase();
    result.matchedTerms = terms.filter(term => text.includes(term));
    return terms.length > 0 && result.matchedTerms.length > 0;
  }).sort((a, b) => b.matchedTerms.length - a.matchedTerms.length || tier(b) - tier(a)
    || (b.installs.value ?? -1) - (a.installs.value ?? -1)
    || Date.parse(b.cacheAsOf ?? '1970-01-01') - Date.parse(a.cacheAsOf ?? '1970-01-01')
    || a.id.localeCompare(b.id));
  for (const result of report.results) {
    if (result.installs.value === null || result.installs.value < 100_000 || !result.repository) continue;
    const github = report.results.find(candidate => candidate.provider === 'github' && candidate.repository === result.repository);
    const stars = github?.signals?.stars?.value;
    if (typeof stars === 'number' && result.installs.value > Math.max(stars, 1) * 1000) {
      report.warnings.push(`Implausible signal: ${result.id} has ${result.installs.value} installs vs ${stars} GitHub stars for ${result.repository}; different metrics and dates, not proof of abuse.`);
    }
  }
}
