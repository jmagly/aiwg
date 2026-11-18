// Normalize public discovery responses without conflating installs, stars or review tiers.
import { repositoryKey } from '../plugin-directory.js';
import type { MarketplaceSearchAdapter, SearchObservation, SearchSignal, SearchSourceId } from '../types.js';

type Data = Record<string, unknown>;
const object = (v: unknown): Data => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Data : {};
const text = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v : null;
const count = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
const date = (v: unknown): string | null => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
function signal(value: string | number | null, source: string, asOf: string): SearchSignal {
  return { value, source, asOf: value === null ? null : asOf };
}
function records(body: unknown, key: string): Data[] {
  const rows = object(body)[key];
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new Error(`Unrecognized response: expected ${key} array`);
  }
  return rows.map(object);
}
function observation(id: string, name: string, description: unknown, repository: unknown, signals: Record<string, SearchSignal>, keywords: unknown = []): SearchObservation {
  return {
    id, name, description: text(description) ?? '', repository: repositoryKey(repository), signals,
    keywords: Array.isArray(keywords) ? keywords.filter((item): item is string => typeof item === 'string') : [],
  };
}
function required(value: unknown): string {
  const result = text(value);
  if (!result) throw new Error('Unrecognized response: missing entry identity');
  return result;
}
function endpoint(base: string, query: string, parameters: Record<string, string>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  url.searchParams.set(base.includes('modelcontextprotocol') ? 'search' : 'q', query);
  return url.href;
}
function adapter(source: SearchSourceId, base: string, parameters: Record<string, string>, normalize: MarketplaceSearchAdapter['normalize']): MarketplaceSearchAdapter {
  return { source, endpoint: query => endpoint(base, query, parameters), normalize };
}
export const publicSearchAdapters: MarketplaceSearchAdapter[] = [
  adapter('mcp-registry', 'https://registry.modelcontextprotocol.io/v0.1/servers', { limit: '100' }, (body, url, asOf) => ({
    observations: records(body, 'servers').map(entry => {
      const server = object(entry.server);
      const meta = object(object(entry._meta)['io.modelcontextprotocol.registry/official']);
      const name = required(server.name);
      return observation(name, name, server.description, object(server.repository).url, {
        version: signal(text(server.version), url, asOf),
        publishedAt: signal(date(meta.publishedAt), url, asOf),
        updatedAt: signal(date(meta.updatedAt), url, asOf),
      });
    }),
    limited: Boolean(text(object(object(body).metadata).nextCursor)),
  })),
  adapter('github', 'https://api.github.com/search/repositories', { per_page: '100', sort: 'stars', order: 'desc' }, (body, url, asOf) => {
    const rows = records(body, 'items');
    return {
      observations: rows.map(entry => {
        const name = required(entry.full_name);
        const license = text(object(entry.license).spdx_id);
        return observation(name, name, entry.description, `https://github.com/${name}`, {
          stars: signal(count(entry.stargazers_count), url, asOf),
          license: signal(license === 'NOASSERTION' ? null : license, url, asOf),
          lastPush: signal(date(entry.pushed_at), url, asOf),
        }, entry.topics);
      }),
      limited: object(body).incomplete_results === true || Number(object(body).total_count) > rows.length || rows.length >= 100,
    };
  }),
  adapter('skills.sh', 'https://skills.sh/api/search', { limit: '100' }, (body, url, asOf) => {
    const rows = records(body, 'skills');
    return {
      observations: rows.map(entry => {
        const id = required(entry.id);
        return observation(id, text(entry.name) ?? required(entry.skillId), entry.description, entry.source, {
          installs: signal(count(entry.installs), url, asOf),
        }, [entry.skillId]);
      }),
      limited: Number(object(body).count) > rows.length || rows.length >= 100,
    };
  }),
];
