/**
 * Marketplace Source Registry
 *
 * Registers marketplace source adapters and resolves a parsed identifier
 * to its adapter.
 *
 * @implements #787
 */

import type { MarketplaceSource, MarketplaceSourceId } from './types.js';
import { ClawHubSource } from './sources/clawhub.js';
import { GitSource } from './sources/git.js';

/**
 * Registered source adapters keyed by source id.
 * Additional adapters (cursor, codex, claude) will be registered here as
 * their implementations land.
 */
const adapters = new Map<MarketplaceSourceId, MarketplaceSource>();

adapters.set('clawhub', new ClawHubSource());
adapters.set('git', new GitSource());

/**
 * Get the adapter for a given source.
 */
export function getSource(source: MarketplaceSourceId): MarketplaceSource {
  const adapter = adapters.get(source);
  if (!adapter) {
    throw new Error(
      `No adapter registered for marketplace source '${source}'. ` +
      `Registered sources: ${Array.from(adapters.keys()).join(', ')}`
    );
  }
  return adapter;
}

/**
 * List all registered source ids
 */
export function listRegisteredSources(): MarketplaceSourceId[] {
  return Array.from(adapters.keys());
}

// Discovery-only sources share this registry; installing them is outside search's scope.
export { publicSearchAdapters as marketplaceSearchAdapters } from './sources/public-search.js';
