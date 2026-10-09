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

import { lstat, mkdtemp, readFile, readlink, realpath, rmdir } from 'fs/promises';
import { basename, delimiter, dirname, isAbsolute, relative, resolve, sep } from 'path';
import { assertConfigDestination, assertNoSymlinkParents, writeConfigAtomic } from './config-file.mjs';
import { resolveCredentialPolicy, warnCredentialPolicyRelaxation } from './credentials.mjs';

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

/** File-format fields every layer file keeps, whichever layer set them. */
const FORMAT_FIELDS = ['apiVersion', 'kind'];

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
 * name. Top-level fields come from the highest layer that sets them, except
 * credentialPolicy, which keeps the strictest policy across layers.
 *
 * Returns the merged data and a layering record: the names defined in the
 * write layer, and comparable forms of entries and top-level fields in lower layers.
 */
export async function loadLayered(layers, filename, collection, defaults) {
  const merged = { ...defaults, [collection]: {} };
  const lower = new Map();
  const own = new Set();
  const lowerFields = new Map();
  const ownFields = new Set();
  let ownPolicy;
  let lowerPolicy;
  const writeLayer = layers.length - 1;
  for (const [index, dir] of layers.entries()) {
    const parsed = await readLayer(resolve(dir, filename));
    if (!parsed) continue;
    const { [collection]: entries, ...rest } = parsed;
    if (index === writeLayer) ownPolicy = rest.credentialPolicy;
    let policy = merged.credentialPolicy;
    if (Object.hasOwn(rest, 'credentialPolicy')) {
      try {
        policy = resolveCredentialPolicy({ registryPolicy: merged.credentialPolicy, flag: rest.credentialPolicy, env: {} });
      } catch (error) {
        throw new Error(`Invalid MCP credential policy in layer ${resolve(dir, filename)}: ${error.message}`);
      }
    }
    Object.assign(merged, rest);
    if (policy !== undefined) merged.credentialPolicy = policy;
    if (index < writeLayer) lowerPolicy = policy;
    for (const field of Object.keys(rest)) {
      if (index === writeLayer) ownFields.add(field);
      else lowerFields.set(field, comparable({ value: merged[field] }));
    }
    for (const [name, entry] of Object.entries(entries || {})) {
      merged[collection][name] = entry;
      if (index === writeLayer) own.add(name);
      else lower.set(name, comparable(entry));
    }
  }
  return { data: merged, layering: { lower, own, lowerFields, ownFields, ownPolicy, lowerPolicy, effectivePolicy: merged.credentialPolicy } };
}

/** True when the entry is defined only below the write layer. */
export function isLowerLayerEntry(layering, name) {
  return layering.lower.has(name) && !layering.own.has(name);
}

/**
 * The data to persist in the write layer: entries defined there, new entries,
 * and lower-layer entries whose content (bookkeeping aside) was changed.
 * Top-level fields follow the same rule, without entry bookkeeping exclusions;
 * apiVersion and kind are always kept so the file stays self-describing.
 */
export function writeLayerData(data, collection, layering, explicitPolicy = false) {
  const entries = Object.entries(data[collection] || {}).filter(([name, entry]) =>
    layering.own.has(name) || !layering.lower.has(name) || comparable(entry) !== layering.lower.get(name));
  const fields = Object.entries(data).filter(([field, value]) => field !== collection && (
    FORMAT_FIELDS.includes(field) || layering.ownFields.has(field) || !layering.lowerFields.has(field) ||
    comparable({ value }) !== layering.lowerFields.get(field)));
  const persisted = { ...Object.fromEntries(fields), [collection]: Object.fromEntries(entries) };
  // A setter explicitly writes even when its value equals the merged floor.
  // Other saves retain policy ownership, without copying an inherited floor.
  if (explicitPolicy || data.credentialPolicy !== layering.effectivePolicy) {
    const effective = resolveCredentialPolicy({
      flag: data.credentialPolicy, registryPolicy: layering.lowerPolicy, env: {},
    });
    if (effective !== data.credentialPolicy) {
      throw new Error(`Cannot relax MCP credential policy floor "${effective}" to "${data.credentialPolicy}".`);
    }
    persisted.credentialPolicy = data.credentialPolicy;
  } else if (layering.ownPolicy !== undefined &&
    resolveCredentialPolicy({ flag: layering.ownPolicy, registryPolicy: layering.lowerPolicy, env: {} }) !== layering.ownPolicy) {
    delete persisted.credentialPolicy;
    warnCredentialPolicyRelaxation(layering.ownPolicy, layering.lowerPolicy);
    console.warn(`Dropping ignored MCP overlay credential policy "${layering.ownPolicy}" on save.`);
  }
  return persisted;
}

/** Resolve a target, including a missing suffix, without creating it. */
async function targetRealpath(path, aliases = []) {
  const absolute = resolve(path);
  if (aliases.includes(absolute)) throw new Error(`MCP configuration target symlink cycle: ${[...aliases, absolute].join(' -> ')}`);
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Resolve dangling aliases too: creating their missing referent would change
    // a lower layer even though realpath currently reports ENOENT.
    if (dirname(absolute) === absolute) throw error;
    const candidate = resolve(await targetRealpath(dirname(absolute), aliases), basename(absolute));
    try {
      if ((await lstat(candidate)).isSymbolicLink()) {
        return targetRealpath(resolve(dirname(candidate), await readlink(candidate)), [...aliases, absolute]);
      }
    } catch (statError) {
      if (statError.code !== 'ENOENT') throw statError;
    }
    return candidate;
  }
}

/** Probe the filesystem containing the nearest existing ancestor of a target. */
export async function isCaseInsensitivePath(path) {
  let ancestor = resolve(path);
  while (true) {
    try {
      await realpath(ancestor);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error;
      ancestor = dirname(ancestor);
    }
  }
  let probe;
  try {
    probe = await mkdtemp(resolve(ancestor, '.aiwg-case-probe-a-'));
    const alternate = resolve(dirname(probe), basename(probe).toUpperCase());
    try {
      const [original, folded] = await Promise.all([lstat(probe), lstat(alternate)]);
      return original.dev === folded.dev && original.ino === folded.ino;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  } catch (error) {
    // Read-only ancestors cannot be probed: compare conservatively rather than allow overlap.
    if (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'EROFS') return true;
    throw error;
  } finally {
    if (probe) await rmdir(probe);
  }
}

function inside(target, parent, caseInsensitive) {
  const rel = relative(caseInsensitive ? parent.toLowerCase() : parent, caseInsensitive ? target.toLowerCase() : target);
  return !rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Refuse a write that could modify another configuration layer. */
export async function assertLayerWriteDestination(layers, filename) {
  const targets = await Promise.all(layers.map(async dir => ({
    dir: await targetRealpath(dir),
    files: await Promise.all(['mcp-servers.json', 'mcp-profiles.json'].map(name => targetRealpath(resolve(dir, name)))),
  })));
  const write = targets[targets.length - 1];
  const caseInsensitive = await isCaseInsensitivePath(write.dir);
  const writeFile = await targetRealpath(resolve(layers[layers.length - 1], filename));
  for (const lower of targets.slice(0, -1)) {
    if (inside(write.dir, lower.dir, caseInsensitive) || inside(writeFile, lower.dir, caseInsensitive) || lower.files.some(file => inside(writeFile, file, caseInsensitive))) {
      throw new Error(`Refusing overlapping MCP configuration layer targets: ${writeFile} overlaps ${lower.dir}`);
    }
  }
  const file = resolve(layers[layers.length - 1], filename);
  await assertNoSymlinkParents(file, layers[layers.length - 1]);
  await assertConfigDestination(file);
}

/** Persist atomically, then refresh ownership only after a successful write. */
export async function saveLayerData(file, data, collection, layers, layering, explicitPolicy = false) {
  if (layers) await assertLayerWriteDestination(layers, basename(file));
  const persisted = layering ? writeLayerData(data, collection, layering, explicitPolicy) : data;
  await writeConfigAtomic(file, JSON.stringify(persisted, null, 2) + '\n', {
    userScope: true, rejectSymlinkParents: true,
  });
  if (layering) {
    layering.own = new Set(Object.keys(persisted[collection] || {}));
    layering.ownFields = new Set(Object.keys(persisted).filter(field => field !== collection));
    layering.ownPolicy = persisted.credentialPolicy;
    layering.effectivePolicy = data.credentialPolicy;
  }
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
