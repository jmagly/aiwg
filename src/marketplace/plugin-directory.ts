// Normalize local directory listings and correlate only matching repository identities.
type Data = Record<string, unknown>;
const record = (value: unknown): Data => value !== null && typeof value === 'object' ? value as Data : {};
export function repositoryKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return `${url.hostname.toLowerCase()}${url.pathname.replace(/\.git\/?$/, '').replace(/\/$/, '')}`.toLowerCase();
  } catch {
    return /^[\w.-]+\/[\w.-]+$/.test(value) ? `github.com/${value.toLowerCase().replace(/\.git$/, '')}` : null;
  }
}
export function pluginRepository(plugin: unknown, marketplaceSource: unknown): string | null {
  const source = record(record(plugin).source);
  const market = record(marketplaceSource);
  return repositoryKey(source.url ?? source.repo) ?? repositoryKey(market.repo ?? market.url);
}
export interface DirectoryTarget { id: string; name: string; marketplace: string | null; repository: string | null }
export function normalizeDirectoryListing(
  raw: unknown, entryNames: unknown, targets: DirectoryTarget[],
): { plugin: Data; marketplace?: string; directoryId?: string } | null {
  const entry = record(raw);
  if (typeof entry.id !== 'string') return null;
  const repository = record(record(entry.source).repository);
  const key = repositoryKey(repository.url);
  const slug = record(entryNames)[entry.id];
  const name = typeof slug === 'string' && slug ? slug : typeof entry.name === 'string' ? entry.name : null;
  if (!name) return null;
  const matches = targets.filter(target => key !== null && target.repository === key && target.name === name);
  const matching = matches.length === 1 ? matches[0] : undefined;
  return {
    plugin: { ...entry, name, description: entry.summary, repository: repository.url },
    marketplace: matching?.marketplace ?? undefined,
    directoryId: matching ? undefined : entry.id,
  };
}
