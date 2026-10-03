/**
 * Layered MCP configuration roots.
 *
 * AIWG_CONFIG_LAYERS lists configuration directories separated by the
 * platform path delimiter (`:` on POSIX, `;` on Windows), lowest precedence
 * first. Each directory may hold mcp-servers.json and mcp-profiles.json. An
 * entry (server or profile) in a later directory replaces the entry of the
 * same name in an earlier one; entries are not merged field by field.
 *
 * The last directory is the write layer: add, update and recordInjection
 * write there, and nothing from an earlier layer is copied into it unless
 * that entry is updated.
 *
 * When AIWG_CONFIG_LAYERS is unset, or a registry is constructed with an
 * explicit directory, the single-directory behaviour applies unchanged.
 */

import { readFile } from 'fs/promises';
import { delimiter, resolve } from 'path';

export function resolveConfigLayers(configDirOverride, env = process.env) {
  if (configDirOverride) return null;
  const raw = env.AIWG_CONFIG_LAYERS;
  if (!raw || !raw.trim()) return null;
  const layers = raw.split(delimiter).map(entry => entry.trim()).filter(Boolean).map(entry => resolve(entry));
  return layers.length > 0 ? layers : null;
}

async function readLayer(path) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in MCP configuration layer ${path}`);
    throw error;
  }
}

/** Bookkeeping fields that do not make an entry "changed" for layering purposes. */
const BOOKKEEPING_FIELDS = ['injectedProviders', 'addedAt', 'createdAt', 'updatedAt'];

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
}

function comparable(entry) {
  const copy = { ...entry };
  for (const field of BOOKKEEPING_FIELDS) delete copy[field];
  return JSON.stringify(sortKeys(copy));
}

/**
 * Read `filename` from every layer and merge the `collection` map by entry
 * name. Top-level fields come from the highest layer that sets them.
 *
 * Returns the merged data and a layering record: the names defined in the
 * write layer, and a comparable form of each entry as the lower layers define it.
 */
export async function loadLayered(layers, filename, collection, defaults) {
  const merged = { ...defaults, [collection]: {} };
  const lower = new Map();
  const own = new Set();
  const writeLayer = layers.length - 1;
  for (const [index, dir] of layers.entries()) {
    const parsed = await readLayer(resolve(dir, filename));
    if (!parsed) continue;
    const { [collection]: entries, ...rest } = parsed;
    Object.assign(merged, rest);
    for (const [name, entry] of Object.entries(entries || {})) {
      merged[collection][name] = entry;
      if (index === writeLayer) own.add(name);
      else lower.set(name, comparable(entry));
    }
  }
  return { data: merged, layering: { lower, own } };
}

/** True when the entry is defined only below the write layer. */
export function isLowerLayerEntry(layering, name) {
  return layering.lower.has(name) && !layering.own.has(name);
}

/**
 * The data to persist in the write layer: entries defined there, new entries,
 * and lower-layer entries whose content (bookkeeping aside) was changed.
 */
export function writeLayerData(data, collection, layering) {
  const entries = Object.entries(data[collection] || {}).filter(([name, entry]) =>
    layering.own.has(name) || !layering.lower.has(name) || comparable(entry) !== layering.lower.get(name));
  return { ...data, [collection]: Object.fromEntries(entries) };
}

/**
 * Resolve a profile's `extends` chain. Servers are concatenated base-first
 * without duplicates. Per provider key, toolDeny accumulates across the chain
 * and toolAllow is taken from the most-derived profile that sets it.
 */
export function resolveProfileExtends(name, profiles, seen = []) {
  const profile = profiles[name];
  if (!profile) {
    throw new Error(seen.length > 0
      ? `Profile "${seen[seen.length - 1]}" extends "${name}", which is not defined in any configuration layer.`
      : `Profile "${name}" not found.`);
  }
  if (seen.includes(name)) throw new Error(`Profile extends cycle: ${[...seen, name].join(' -> ')}`);
  const bases = (profile.extends || []).map(base => resolveProfileExtends(base, profiles, [...seen, name]));

  const servers = [];
  const providerOverrides = {};
  for (const source of [...bases, profile]) {
    for (const server of source.servers || []) if (!servers.includes(server)) servers.push(server);
    for (const [provider, override] of Object.entries(source.providerOverrides || {})) {
      const previous = providerOverrides[provider] || {};
      providerOverrides[provider] = {
        ...previous,
        ...(override.toolDeny ? { toolDeny: [...new Set([...(previous.toolDeny || []), ...override.toolDeny])] } : {}),
        ...(override.toolAllow ? { toolAllow: [...override.toolAllow] } : {}),
      };
    }
  }
  return { ...profile, servers, providerOverrides };
}
