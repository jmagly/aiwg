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
import { basename, dirname, isAbsolute, posix, relative, resolve, sep, win32 } from 'path';
import { assertConfigDestination, assertConfigObject, assertNoSymlinkParents, writeConfigAtomic } from './config-file.mjs';
import { credentialPolicyViolations, resolveCredentialPolicy, stricterCredentialPolicy, warnCredentialPolicyRelaxation, warnDroppedOverlayPolicy } from './credentials.mjs';

/**
 * `platform` lets tests validate Windows path semantics (`C:\org`, UNC
 * `\\server`, root-relative `\org`/`/org`) deterministically on any host; it
 * defaults to the real host platform, so production calls behave exactly as
 * the native `path` module already would.
 */
export function resolveConfigLayers(configDirOverride, env = process.env, { platform = process.platform } = {}) {
  if (configDirOverride) return null;
  const raw = env.AIWG_CONFIG_LAYERS;
  if (!raw || !raw.trim()) return null;
  const pathForPlatform = platform === 'win32' ? win32 : posix;
  // A Windows-formatted value uses `;`; splitting a drive-qualified entry
  // (`C:\org`) on the real host's POSIX `:` would wrongly cut it at the drive
  // letter, so the simulated platform's own delimiter is used, not the real
  // host's - matching the native `path` module's behaviour when the real host
  // actually is that platform.
  const entries = raw.split(pathForPlatform.delimiter).map(entry => entry.trim()).filter(Boolean);
  // A bare leading `\` or `/` with no drive letter is current-drive-relative
  // under Windows path semantics: resolving it from C:\work versus D:\work
  // selects different drives, so a layer list could change meaning across
  // hosts. The backslash form is refused on every platform, since it is never
  // a valid POSIX absolute path either. The forward-slash form is refused
  // only when interpreting entries under actual Windows path semantics; on
  // POSIX, a leading `/` is an unambiguous, fully-qualified absolute path and
  // must keep working. Drive-qualified (`C:\`, `C:/`) and UNC (`\\server`,
  // `//server`) forms remain allowed on every platform.
  const driveRelativePattern = platform === 'win32' ? /^[\\/](?![\\/])/ : /^\\(?!\\)/;
  const driveRelativeEntries = entries.filter(entry => driveRelativePattern.test(entry));
  if (driveRelativeEntries.length) {
    throw new Error(`AIWG_CONFIG_LAYERS entries must be absolute paths; refusing Windows current-drive-relative entries: ${driveRelativeEntries.join(', ')}`);
  }
  // A relative entry would resolve against the current working directory, so the
  // same AIWG_CONFIG_LAYERS value would name different layers from different
  // invocation directories. Refuse instead of silently picking a directory.
  const relativeEntries = entries.filter(entry => !pathForPlatform.isAbsolute(entry));
  if (relativeEntries.length) {
    throw new Error(`AIWG_CONFIG_LAYERS entries must be absolute paths; refusing relative entries: ${relativeEntries.join(', ')}`);
  }
  const layers = entries.map(entry => pathForPlatform.resolve(entry));
  return layers.length > 0 ? layers : null;
}

async function readLayer(path, collection) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8'));
    try {
      assertConfigObject(parsed, collection);
    } catch {
      throw new Error(`Invalid MCP configuration layer ${path}: expected an object root and an object ${collection} map`);
    }
    return parsed;
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
 * credentialPolicy: lower (non-write) layers fold together with the
 * strictest value winning - an enforced organisation floor - and the write
 * layer's own declared value (a personal default) is then bounded below by
 * that floor, never copying the floor itself into the write layer's record.
 * `lowerPolicySource` names the config file of the lower layer that set the
 * folded floor's value (the first layer to set it; a later layer repeating
 * the same strictness does not move attribution), for diagnostics.
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
  let lowerPolicySource;
  const writeLayer = layers.length - 1;
  for (const [index, dir] of layers.entries()) {
    const parsed = await readLayer(resolve(dir, filename), collection);
    if (!parsed) continue;
    const { [collection]: entries, ...rest } = parsed;
    if (index === writeLayer) {
      ownPolicy = rest.credentialPolicy;
    } else if (Object.hasOwn(rest, 'credentialPolicy')) {
      try {
        const folded = stricterCredentialPolicy(lowerPolicy, rest.credentialPolicy);
        if (folded !== lowerPolicy) lowerPolicySource = resolve(dir, filename);
        lowerPolicy = folded;
      } catch (error) {
        throw new Error(`Invalid MCP credential policy in layer ${resolve(dir, filename)}: ${error.message}`);
      }
    }
    Object.assign(merged, rest);
    // Across several lower layers, credentialPolicy folds by strictness, not
    // by "last layer wins" like every other field: keep the running snapshot
    // in sync with the folded floor so a later lowerFields comparison (used
    // to decide whether to copy an unchanged inherited value) reflects it,
    // not one lower layer's own raw declared value.
    if (index < writeLayer) merged.credentialPolicy = lowerPolicy;
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
  // No layer declared a policy anywhere: leave the field absent, exactly as
  // when `defaults` carries no credentialPolicy, rather than materializing
  // the built-in `literal` default as a stored value.
  let effectivePolicy;
  if (ownPolicy !== undefined || lowerPolicy !== undefined) {
    try {
      effectivePolicy = resolveCredentialPolicy({
        registryPolicy: ownPolicy, floorPolicy: lowerPolicy, floorSource: lowerPolicySource, env: {},
      });
    } catch (error) {
      throw new Error(`Invalid MCP credential policy in layer ${resolve(layers[writeLayer], filename)}: ${error.message}`);
    }
    merged.credentialPolicy = effectivePolicy;
  } else {
    delete merged.credentialPolicy;
  }
  return { data: merged, layering: { lower, own, lowerFields, ownFields, ownPolicy, lowerPolicy, lowerPolicySource, effectivePolicy } };
}

/** True when the entry is defined only below the write layer. */
export function isLowerLayerEntry(layering, name) {
  return layering.lower.has(name) && !layering.own.has(name);
}

/**
 * True when the write layer overrides a lower-layer entry that still carries
 * worker qualification. Removing that override would silently re-expose the
 * lower entry's qualification, so removal must be refused instead.
 */
export function lowerEntryQualified(layering, name) {
  if (!layering?.lower?.has(name) || !layering?.own?.has(name)) return false;
  try {
    return JSON.parse(layering.lower.get(name))?.workerQualification !== undefined;
  } catch {
    return false;
  }
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
      flag: data.credentialPolicy, floorPolicy: layering.lowerPolicy, floorSource: layering.lowerPolicySource, env: {},
    });
    if (effective !== data.credentialPolicy) {
      const location = layering.lowerPolicySource ? ` (set in ${layering.lowerPolicySource})` : '';
      throw new Error(`Cannot relax MCP credential policy floor "${effective}"${location} to "${data.credentialPolicy}".`);
    }
    persisted.credentialPolicy = data.credentialPolicy;
  } else if (layering.ownPolicy !== undefined &&
    resolveCredentialPolicy({ flag: layering.ownPolicy, floorPolicy: layering.lowerPolicy, floorSource: layering.lowerPolicySource, env: {} }) !== layering.ownPolicy) {
    delete persisted.credentialPolicy;
    warnDroppedOverlayPolicy(layering.ownPolicy, layering.lowerPolicy, layering.lowerPolicySource);
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
  // Validate the current bytes even if the caller loaded and cached an older
  // version, or called save(data) on a fresh standalone registry.
  await readLayer(file, collection);
  const persisted = layering ? writeLayerData(data, collection, layering, explicitPolicy) : data;
  // The active identity layer file is always 0600: it is the personal write
  // layer of an active AIWG_CONFIG_LAYERS configuration and may carry secrets.
  // Without layering, `file` is whatever single directory the caller
  // configured (which may be a shared, group-readable organisation checkout
  // maintained directly, not a private identity directory): an existing file
  // keeps its mode unless the persisted servers carry literal credentials,
  // while a newly created file starts private at 0600.
  const info = layers ? null : await assertConfigDestination(file);
  const tighten = info && (info.mode & 0o077) !== 0 && collection === 'servers'
    && Object.values(persisted[collection] || {}).some(server => credentialPolicyViolations(server, 'references').length > 0);
  await writeConfigAtomic(file, JSON.stringify(persisted, null, 2) + '\n', layers
    ? { userScope: true, rejectSymlinkParents: true }
    : { newFileMode: 0o600, rejectSymlinkParents: true, ...(tighten ? { mode: 0o600 } : {}) });
  if (tighten) {
    console.warn(`Warning: tightened MCP registry ${file} from ${(info.mode & 0o7777).toString(8).padStart(4, '0')} to 0600 because it contains literal credentials.`);
  }
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
