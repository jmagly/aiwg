// Read provider-owned plugin manifests and caches without fetching or changing state.
import { normalizeDirectoryListing, pluginRepository, repositoryKey } from './plugin-directory.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type RecordValue = Record<string, unknown>;
export interface Signal<T> { value: T | null; asOf: string | null }
export interface PluginSearchResult {
  id: string;
  name: string;
  marketplace: string | null;
  repository: string | null;
  provider: 'claude';
  description: string;
  category: string | null;
  keywords: string[];
  sources: string[];
  cacheAsOf: string | null;
  installs: Signal<number>;
  review: Signal<'anthropic' | 'partner' | 'none'>;
  matchedTerms: string[];
  installSkill: 'install-plugin';
  installHelp: string;
}
export interface PluginSearchReport {
  query: string;
  marketplaces: { name: string; provider: string; manifest: string; asOf: string | null }[];
  results: PluginSearchResult[];
  warnings: string[];
  ranking: string;
}
const object = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as RecordValue : {};
const string = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;
function date(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const milliseconds = typeof value === 'number' && value < 1e12 ? value * 1000 : value;
  const parsed = new Date(milliseconds);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
function asOf(value: RecordValue): string | null {
  return date(value.lastUpdated ?? value.updatedAt ?? value.fetchedAt ?? value.timestamp);
}
function entries(value: unknown): [string, unknown][] {
  return Array.isArray(value) ? value.map((entry, index) => [String(index), entry]) : Object.entries(object(value));
}

export function searchProviderPlugins(query: string, options: {
  home?: string; provider?: string; maxAgeDays?: number; now?: number; claudeConfigDir?: string;
} = {}): PluginSearchReport {
  const maxAgeDays = options.maxAgeDays ?? 30;
  if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) throw new Error('--max-age-days must be a non-negative number');
  const report: PluginSearchReport = {
    query, marketplaces: [], results: [], warnings: [],
    ranking: 'Matched terms, review tier (anthropic > partner > none/unknown), installs, cache date; descending. Signals are observations, not ratings or capability measurements.',
  };
  const provider = options.provider ?? 'all';
  if (!['all', 'claude', 'codex'].includes(provider)) throw new Error('Plugin search supports --provider all, claude or codex');
  if (provider !== 'claude') report.warnings.push('Codex marketplace.json search deferred pending a stable local manifest/configuration contract (#783). Other provider formats are not yet supported.');
  if (provider === 'codex') return report;
  const base = path.join(options.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR
    ?? path.join(options.home ?? os.homedir(), '.claude'), 'plugins');
  const now = options.now ?? Date.now();
  function read(file: string, required = false): RecordValue | null {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object');
      return object(parsed);
    } catch (error) {
      if (required || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
        report.warnings.push(`Unable to read marketplace data: ${file}`);
      }
      return null;
    }
  }
  function checkAge(file: string, timestamp: string | null) {
    if (!timestamp) report.warnings.push(`Cache date unknown: ${file}`);
    else if (Date.parse(timestamp) > now) report.warnings.push(`Cache date is in the future: ${file} (as of ${timestamp})`);
    else if (now - Date.parse(timestamp) > maxAgeDays * 86_400_000) {
      report.warnings.push(`Stale cache: ${file} (as of ${timestamp}; maximum age ${maxAgeDays} days)`);
    }
  }
  const results = new Map<string, PluginSearchResult>();
  function add(raw: unknown, marketplace: string | undefined, source: string, timestamp: string | null, key?: string, directoryId?: string, repository?: string | null) {
    const entry = object(raw);
    const plugin = Object.keys(object(entry.plugin)).length ? object(entry.plugin) : entry;
    const coordinate = string(entry.id) ?? (key?.includes('@') ? key : undefined);
    const split = coordinate?.lastIndexOf('@') ?? -1;
    const name = string(plugin.name) ?? (split > 0 ? coordinate?.slice(0, split) : undefined);
    const market = marketplace ?? string(entry.marketplace) ?? string(object(entry.marketplace).name)
      ?? string(entry.marketplaceName) ?? (split > 0 ? coordinate?.slice(split + 1) : undefined);
    if (!name || (!market && !directoryId)) return;
    const id = directoryId ? `directory:${directoryId}` : `${name}@${market}`;
    const previous = results.get(id);
    const keywords = Array.isArray(plugin.keywords) ? plugin.keywords.filter((item): item is string => typeof item === 'string') : [];
    const reviewType = object(object(object(entry.checks).review).by).type;
    const review = ['anthropic', 'partner', 'none'].includes(String(reviewType))
      ? reviewType as 'anthropic' | 'partner' | 'none' : null;
    const observedAt = asOf(entry) ?? timestamp;
    results.set(id, {
      id, name, marketplace: market ?? null, provider: 'claude',
      repository: repository ?? repositoryKey(plugin.repository) ?? previous?.repository ?? null,
      description: string(plugin.description) ?? previous?.description ?? '',
      category: string(plugin.category) ?? previous?.category ?? null,
      keywords: [...new Set([...(previous?.keywords ?? []), ...keywords])],
      sources: [...new Set([...(previous?.sources ?? []), source])],
      cacheAsOf: observedAt ?? previous?.cacheAsOf ?? null,
      installs: previous?.installs ?? { value: null, asOf: null },
      review: review ? { value: review, asOf: observedAt } : previous?.review ?? { value: null, asOf: null },
      matchedTerms: [], installSkill: 'install-plugin',
      installHelp: 'aiwg show skill install-plugin',
    });
  }
  const registryFile = path.join(base, 'known_marketplaces.json');
  const registry = read(registryFile);
  for (const [name, value] of Object.entries(registry ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const config = object(value);
    const location = string(config.installLocation);
    // Registry names must never escape the provider's marketplaces directory.
    if (!location && (name === '.' || name === '..' || /[\\/]/.test(name))) {
      report.warnings.push(`Invalid marketplace name: ${name}`); continue;
    }
    const manifest = path.join(location ? path.resolve(base, location) : path.join(base, 'marketplaces', name), '.claude-plugin/marketplace.json');
    const data = read(manifest, true);
    const timestamp = asOf(data ?? {}) ?? asOf(config);
    report.marketplaces.push({ name, provider: 'claude', manifest, asOf: timestamp });
    if (!data) continue;
    checkAge(manifest, timestamp);
    for (const [key, plugin] of entries(data.plugins)) add(plugin, name, manifest, timestamp, key, undefined, pluginRepository(plugin, config.source));
  }
  const directoryFile = path.join(base, 'plugin-directory-cache-v2.json');
  const directory = read(directoryFile);
  if (directory) {
    const timestamp = asOf(directory);
    checkAge(directoryFile, timestamp);
    if (!directory.plugins && !directory.listings) report.warnings.push(`Unrecognized directory cache format: ${directoryFile}`);
    const manifestTargets = [...results.values()];
    for (const [key, plugin] of entries(directory.plugins)) add(plugin, undefined, directoryFile, timestamp, key);
    // V2 directory IDs do not encode marketplace membership. Join only on
    // both repository identity and the provider's recorded entry name.
    for (const [, listing] of entries(directory.listings)) {
      const normalized = normalizeDirectoryListing(listing, directory.entryNames, manifestTargets);
      if (normalized) add(normalized.plugin, normalized.marketplace, directoryFile, timestamp, undefined, normalized.directoryId);
    }
  }
  const countsFile = path.join(base, 'install-counts-cache.json');
  const counts = read(countsFile);
  if (counts) {
    const timestamp = asOf(counts);
    checkAge(countsFile, timestamp);
    if (!counts.counts) report.warnings.push(`Unrecognized install-count cache format: ${countsFile}`);
    for (const [key, value] of entries(counts.counts)) {
      const entry = object(value);
      const id = string(entry.plugin) ?? string(entry.id) ?? key;
      const result = results.get(id);
      const installs = entry.unique_installs;
      if (result && typeof installs === 'number' && Number.isSafeInteger(installs) && installs >= 0) {
        result.installs = { value: installs, asOf: asOf(entry) ?? timestamp };
      }
    }
  }
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
  const tier = (result: PluginSearchResult): number => ({ anthropic: 2, partner: 1, none: 0 })[result.review.value ?? 'none'];
  report.results = [...results.values()].filter(result => {
    const text = [result.name, result.description, result.category, ...result.keywords].join(' ').toLowerCase();
    result.matchedTerms = terms.filter(term => text.includes(term));
    return terms.length > 0 && result.matchedTerms.length > 0;
  }).sort((a, b) => b.matchedTerms.length - a.matchedTerms.length || tier(b) - tier(a)
    || (b.installs.value ?? -1) - (a.installs.value ?? -1)
    || Date.parse(b.cacheAsOf ?? '1970-01-01') - Date.parse(a.cacheAsOf ?? '1970-01-01')
    || a.id.localeCompare(b.id));
  if (!registry && !directory) report.warnings.push('No local Claude marketplace manifests or directory cache found; nothing was fetched.');
  return report;
}

export function formatPluginSearch(report: PluginSearchReport): string {
  const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  const lines = [`Plugin marketplace search: ${clean(report.query)}`,
    `Configured marketplaces: ${report.marketplaces.map(market => clean(market.name)).join(', ') || 'none'}`,
    'Plugin / ID | Marketplace | Installs (as of) | Review (as of) | Cache as of | Description'];
  for (const result of report.results) lines.push([
    clean(result.marketplace ? result.id : `${result.name} / ${result.id}`), clean(result.marketplace ?? 'unknown'),
    `${result.installs.value ?? 'unknown'} (${result.installs.asOf ?? 'unknown'})`,
    `${result.review.value ?? 'unknown'} (${result.review.asOf ?? 'unknown'})`, result.cacheAsOf ?? 'unknown', clean(result.description),
  ].join(' | '));
  if (!report.results.length) lines.push('No results found.');
  lines.push(report.ranking, 'Installation guidance for a selected ID: aiwg show skill install-plugin');
  return lines.join('\n');
}
