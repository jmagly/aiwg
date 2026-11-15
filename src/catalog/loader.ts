/**
 * Model Catalog Loader
 *
 * Loads and merges model catalogs from multiple sources:
 * - Builtin models (shipped with AIWG)
 * - Discovered models (from auto-refresh)
 * - Custom models (user-defined)
 *
 * Merge priority: custom > discovered > builtin
 *
 * @implements @docs/models/supported-models.md
 * @module src/catalog/loader
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type {
  ModelCatalog,
  CatalogModel,
  CatalogProvider,
  CatalogFilter,
} from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Get catalog directory in user's data directory
 */
function getCatalogDir(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(homeDir, '.local/share/aiwg/catalog');
}

/**
 * Load a catalog file, handling missing files gracefully
 */
async function loadCatalogFile(filePath: string): Promise<Partial<ModelCatalog> | null> {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.warn(`Failed to load catalog from ${filePath}:`, error);
    return null;
  }
}

/**
 * Merge two model catalogs
 * Later catalog takes precedence for conflicts
 */
function mergeCatalogs(
  base: Partial<ModelCatalog>,
  overlay: Partial<ModelCatalog> | null
): Partial<ModelCatalog> {
  if (!overlay) {
    return base;
  }

  return {
    models: {
      ...(base.models || {}),
      ...(overlay.models || {}),
    },
    providers: {
      ...(base.providers || {}),
      ...(overlay.providers || {}),
    },
    metadata: overlay.metadata || base.metadata,
  };
}

/**
 * Load the builtin models catalog
 */
async function loadBuiltinCatalog(): Promise<Partial<ModelCatalog>> {
  const builtinPath = path.join(__dirname, 'builtin-models.json');
  const catalog = await loadCatalogFile(builtinPath);

  if (!catalog) {
    throw new Error('Failed to load builtin models catalog');
  }

  return catalog;
}

/**
 * Load the discovered models catalog
 */
async function loadDiscoveredCatalog(): Promise<Partial<ModelCatalog> | null> {
  const catalogDir = getCatalogDir();
  const discoveredPath = path.join(catalogDir, 'discovered-models.json');
  return loadCatalogFile(discoveredPath);
}

/**
 * Load the custom models catalog
 */
async function loadCustomCatalog(): Promise<Partial<ModelCatalog> | null> {
  const catalogDir = getCatalogDir();
  const customPath = path.join(catalogDir, 'custom-models.json');
  return loadCatalogFile(customPath);
}

/**
 * Load and merge all catalog sources
 *
 * Merge order: builtin -> discovered -> custom
 * Later sources override earlier ones
 */
export async function loadCatalog(): Promise<ModelCatalog> {
  const builtin = await loadBuiltinCatalog();
  const discovered = await loadDiscoveredCatalog();
  const custom = await loadCustomCatalog();

  let merged = mergeCatalogs(builtin, discovered);
  merged = mergeCatalogs(merged, custom);

  // Ensure required fields exist
  const catalog: ModelCatalog = {
    models: merged.models || {},
    providers: merged.providers || {},
    metadata: merged.metadata || {
      version: '1.0.0',
      lastRefresh: new Date().toISOString(),
      modelCount: 0,
      providerCount: 0,
    },
  };

  // Update counts
  catalog.metadata.modelCount = Object.keys(catalog.models).length;
  catalog.metadata.providerCount = Object.keys(catalog.providers).length;

  return catalog;
}

/**
 * Get a single model by ID or alias
 */
export async function getModel(modelIdOrAlias: string): Promise<CatalogModel | null> {
  const catalog = await loadCatalog();

  // Try direct ID lookup
  if (catalog.models[modelIdOrAlias]) {
    return catalog.models[modelIdOrAlias];
  }

  // Try alias lookup
  for (const model of Object.values(catalog.models)) {
    if (model.aliases.includes(modelIdOrAlias)) {
      return model;
    }
  }

  return null;
}

/**
 * List all models, optionally filtered
 */
export async function listModels(filter?: CatalogFilter): Promise<CatalogModel[]> {
  const catalog = await loadCatalog();
  let models = Object.values(catalog.models);

  if (!filter) {
    return models;
  }

  // Apply filters
  if (filter.provider) {
    models = models.filter((m) => m.provider === filter.provider);
  }

  if (filter.status) {
    models = models.filter((m) => m.status === filter.status);
  }

  if (filter.tag) {
    models = models.filter((m) => m.tags.includes(filter.tag!));
  }

  if (filter.minContext !== undefined) {
    const minCtx = filter.minContext;
    models = models.filter((m) => m.capabilities.contextWindow >= minCtx);
  }

  if (filter.capability) {
    const cap = filter.capability;
    models = models.filter((m) => {
      const value = m.capabilities[cap];
      // For boolean capabilities, must be true
      if (typeof value === 'boolean') {
        return value === true;
      }
      // For quality ratings, exclude 'poor' and 'unknown'
      if (typeof value === 'string') {
        return value !== 'poor' && value !== 'unknown';
      }
      // For numbers, must be > 0
      return value > 0;
    });
  }

  return models;
}

/**
 * Get provider information
 */
export async function getProvider(providerId: string): Promise<CatalogProvider | null> {
  const catalog = await loadCatalog();
  return catalog.providers[providerId] || null;
}

/**
 * List all providers
 */
export async function listProviders(): Promise<Array<{ id: string; info: CatalogProvider }>> {
  const catalog = await loadCatalog();
  return Object.entries(catalog.providers).map(([id, info]) => ({ id, info }));
}

/**
 * Search models by query string
 * Searches in: id, displayName, aliases, tags
 */
export async function searchModels(query: string): Promise<CatalogModel[]> {
  const catalog = await loadCatalog();
  const lowerQuery = query.toLowerCase();

  return Object.values(catalog.models).filter((model) => {
    // Search in ID
    if (model.id.toLowerCase().includes(lowerQuery)) {
      return true;
    }

    // Search in display name
    if (model.displayName.toLowerCase().includes(lowerQuery)) {
      return true;
    }

    // Search in aliases
    if (model.aliases.some((alias) => alias.toLowerCase().includes(lowerQuery))) {
      return true;
    }

    // Search in tags
    if (model.tags.some((tag) => tag.toLowerCase().includes(lowerQuery))) {
      return true;
    }

    return false;
  });
}
