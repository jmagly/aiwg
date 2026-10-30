// Serve artifact bodies and metadata through the show surface.
import * as path from 'node:path';
import { loadProviderModelMetadata } from '../models/provider-models.js';
import { isCorpusBundleInstalled } from './framework-capabilities.js';
import { findCorpusArtifact } from './query-engine-corpus.js';
import {
  buildRunHint,
  DEFAULT_ARTIFACT_SEARCH_BACKEND,
  discoveryIdForEntry,
  normalizeIndexedPath,
  type ProvenancedEntry,
} from './query-engine-entries.js';
import { findShowMatches } from './query-engine-matching.js';
import { type ShowMetadataParams, type ShowParams } from './query-engine-options.js';
import { showBindings } from './query-engine-rules.js';
import { emitShowCard } from './query-engine-show-card.js';
import { fortemiRecordForEntry, loadShowEntries, resolveMetadataPath } from './query-engine-show-load.js';
import type { MetadataEntry } from './types.js';
import { loadGlobalGraphConfigs, OPERATIONAL_SHOW_TYPES } from './types.js';

/**
 * Emit a metadata card, with opt-in body/section drill-ins for a
 * SKILL.md. Consumers don't need to know where AIWG stores skills —
 * they pass the skill name and the CLI reads the file from the indexed
 * location.
 *
 * Lookup order:
 *   1. Stable discover/Fortemi id
 *   2. Exact path match against any indexed entry's stored path
 *   3. Basename match (e.g. `intake-wizard` matches an entry whose
 *      directory basename is `intake-wizard`)
 *   4. Title match (case-insensitive)
 *   5. Corpus fallback under AIWG_ROOT (#1221)
 *
 * On ambiguity, lists all matches and exits with code 2 unless
 * `--first` is supplied.
 */
export async function showArtifact(
  cwd: string,
  params: ShowParams,
): Promise<void> {
  loadGlobalGraphConfigs();
  const { promises: fs } = await import('node:fs');
  const types = params.typeFilter && params.typeFilter.length > 0
    ? params.typeFilter
    : [...OPERATIONAL_SHOW_TYPES];
  const {
    entries,
    aiwgRoot,
    resourceSource,
    webRelease,
    relations,
  } = await loadShowEntries(cwd, params, true);

  if (entries.length === 0 && !relations && params.backend !== 'fortemi-core') {
    console.error('Error: No artifact index found.');
    console.error('Run `aiwg index build --graph framework` (or `aiwg use <framework>`) first.');
    process.exit(1);
  }

  const needle = params.name.trim();
  let matches = findShowMatches(entries, types, needle);

  if (matches.length === 0) {
    // Corpus fallback (#1221): when the artifact isn't in any indexed graph,
    // scan the AIWG_ROOT corpus for a likely match and render it with an
    // installation-aware banner. This keeps `aiwg show` useful in workspaces
    // where the operator hasn't run `aiwg use` yet, or where the framework
    // index is stale, rather than exiting with a misleading "not found".
    if (resourceSource === 'local' && aiwgRoot && params.backend !== 'fortemi-core') {
      const corpusMatch = await findCorpusArtifact(aiwgRoot, needle, types);
      if (corpusMatch) {
        let content: string;
        try {
          content = await fs.readFile(corpusMatch.path, 'utf8');
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          console.error(`Error reading ${corpusMatch.path}: ${e.message ?? String(err)}`);
          process.exit(1);
        }
        const localPin = corpusMatch.type === 'rule' ? (await import('../rules/pin-state.js')).rulePinState(cwd, aiwgRoot).rules.find(rule => rule.path === corpusMatch.path) : undefined;
        const installed = await isCorpusBundleInstalled(
          cwd, aiwgRoot, corpusMatch.bundleKind, corpusMatch.bundleId,
        );
        const installHint = installed
          ? 'The installed bundle is missing from this index. Run `aiwg index build --graph framework` to refresh it.'
          : corpusMatch.bundleKind && corpusMatch.bundleId
          ? `Run \`aiwg use ${corpusMatch.bundleId}\` to install this ${corpusMatch.bundleKind} into the workspace.`
          : 'Run `aiwg index build --graph framework` to refresh the artifact index.';
        const fallbackEntry = { path: path.relative(aiwgRoot, corpusMatch.path), type: corpusMatch.type, name: needle, title: needle } as MetadataEntry;
        const bindings = await showBindings(entries, fallbackEntry, content, params, rule => fs.readFile(resolveMetadataPath(cwd, aiwgRoot, rule), 'utf8'), relations);
        await emitShowCard(cwd, aiwgRoot, fallbackEntry,
          corpusMatch.path, content, params, bindings, { uninstalled: !installed, installed, hint: installHint,
            ...(localPin ? { local_pin: localPin } : {}) }, true);
        return;
      }
    }
    console.error(`Error: no artifact found matching "${needle}".`);
    console.error('Try `aiwg discover "<phrase>"` to find the right name.');
    process.exit(1);
  }

  // Resolve relative framework-graph paths to absolute paths.
  // Kernel entries are anchored the same way as non-kernel framework entries
  // (#1230) — show reads the source corpus, not platform deploy mirrors.
  const resolvePath = (entry: MetadataEntry) => resourceSource === 'web'
    ? `raw/${normalizeIndexedPath(entry.path)}`
    : resolveMetadataPath(cwd, aiwgRoot, entry);

  if (matches.length > 1 && !params.first) {
    if (params.json) {
      console.log(JSON.stringify({
        ambiguous: true,
        name: needle,
        matches: matches.map(e => ({
          id: discoveryIdForEntry(e),
          path: resolvePath(e),
          type: e.type,
          name: e.name,
          title: e.title,
          kernel: e.kernel ?? false,
          provenance: {
            graph: (e as ProvenancedEntry).indexGraph ?? null,
            scope: (e as ProvenancedEntry).indexScope ?? null,
            ...(webRelease
              ? {
                  resource_source: 'web',
                  aiwg_selector: webRelease.selector,
                  aiwg_version: webRelease.version,
                  manifest_sha256: webRelease.manifestDigest,
                  manifest_url: webRelease.manifestUrl,
                }
              : {}),
          },
        })),
      }, null, 2));
    } else {
      console.error(`Ambiguous: "${needle}" matches ${matches.length} artifacts. Disambiguate with --type or pass the stable id:`);
      for (const e of matches) {
        console.error(`  ${e.type.padEnd(7)} ${discoveryIdForEntry(e)} ${e.title}`);
      }
      console.error('');
      console.error('Re-run with `--first` to pick the top match, `--type skill` to filter, or `aiwg show metadata <id>` for paths.');
    }
    process.exit(2);
  }

  const entry = matches[0];
  const filePath = resolvePath(entry);
  let content: string;
  if (resourceSource === 'web') {
    try {
      if (!webRelease) throw new Error('verified web release context is unavailable');
      const { logicalIdFromFirstPartyPath, resolveAiwgResourceBytes } = await import('../resources/resolver.js');
      const logicalId = logicalIdFromFirstPartyPath(entry.path);
      if (!logicalId) throw new Error(`indexed path is not a first-party AIWG resource: ${entry.path}`);
      const resolved = await resolveAiwgResourceBytes(logicalId, {
        source: 'web',
        frameworkRoot: aiwgRoot ?? cwd,
        webRelease,
        webReleaseOptions: params.webReleaseOptions,
        offline: params.offline,
      });
      content = resolved.bytes.toString('utf8');
    } catch (error) {
      console.error(`Error: AIWG web resource show failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  } else {
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      console.error(`Error reading ${filePath}: ${e.message ?? String(err)}`);
      process.exit(1);
    }
  }

  const localPin = entry.type === 'rule' ? (await import('../rules/pin-state.js')).rulePinState(cwd, aiwgRoot ?? cwd).rules.find(rule => rule.path === filePath) : undefined;
  const bindings = await showBindings(entries, entry, content, params, async rule => {
    if (resourceSource === 'local') return fs.readFile(resolvePath(rule), 'utf8');
    const { logicalIdFromFirstPartyPath, resolveAiwgResourceBytes } = await import('../resources/resolver.js');
    const logicalId = logicalIdFromFirstPartyPath(rule.path);
    if (!logicalId || !webRelease) throw new Error(`Cannot resolve bound rule: ${rule.path}`);
    const resolved = await resolveAiwgResourceBytes(logicalId, {
      source: 'web', frameworkRoot: aiwgRoot ?? cwd, webRelease,
      webReleaseOptions: params.webReleaseOptions, offline: params.offline,
    });
    return resolved.bytes.toString('utf8');
  }, relations);

  const providerModels = resourceSource === 'local' ? await loadProviderModelMetadata(cwd, aiwgRoot) : null;
  await emitShowCard(cwd, aiwgRoot, entry, filePath, content, params, bindings, {
    provenance: {
      graph: (entry as ProvenancedEntry).indexGraph ?? null,
      scope: (entry as ProvenancedEntry).indexScope ?? null,
      ...(webRelease ? { resource_source: 'web', aiwg_selector: webRelease.selector, aiwg_version: webRelease.version,
        manifest_sha256: webRelease.manifestDigest, manifest_url: webRelease.manifestUrl } : {}),
    },
    ...(entry.script ? { executable: true, run_hint: buildRunHint(entry) } : {}),
    ...(providerModels ? { providerModels } : {}),
    ...(localPin ? { local_pin: localPin } : {}),
  }, resourceSource === 'local', webRelease);
}


export async function showMetadata(
  cwd: string,
  params: ShowMetadataParams,
): Promise<void> {
  loadGlobalGraphConfigs();
  const types = params.typeFilter && params.typeFilter.length > 0
    ? params.typeFilter
    : [...OPERATIONAL_SHOW_TYPES];
  const {
    entries,
    aiwgRoot,
    resourceSource,
    webRelease,
    sourcePaths,
  } = await loadShowEntries(cwd, params);

  if (entries.length === 0 && params.backend !== 'fortemi-core') {
    console.error('Error: No artifact index found.');
    console.error('Run `aiwg index build --graph framework` (or `aiwg use <framework>`) first.');
    process.exit(1);
  }

  const needle = params.name.trim();
  const matches = findShowMatches(entries, types, needle);

  if (matches.length === 0) {
    console.error(`Error: no artifact metadata found matching "${needle}".`);
    console.error('Try `aiwg discover "<phrase>" --json` to find the stable id.');
    process.exit(1);
  }

  const resolvePath = (entry: MetadataEntry) => resourceSource === 'web'
    ? `raw/${normalizeIndexedPath(entry.path)}`
    : resolveMetadataPath(cwd, aiwgRoot, entry);

  if (matches.length > 1 && !params.first) {
    if (params.json) {
      console.log(JSON.stringify({
        ambiguous: true,
        name: needle,
        matches: matches.map((entry) => ({
          id: discoveryIdForEntry(entry),
          type: entry.type,
          name: entry.name,
          title: entry.title,
          provenance: {
            graph: (entry as ProvenancedEntry).indexGraph ?? null,
            scope: (entry as ProvenancedEntry).indexScope ?? null,
            ...(webRelease
              ? {
                  resource_source: 'web',
                  aiwg_selector: webRelease.selector,
                  aiwg_version: webRelease.version,
                  manifest_sha256: webRelease.manifestDigest,
                  manifest_url: webRelease.manifestUrl,
                }
              : {}),
          },
        })),
      }, null, 2));
    } else {
      console.error(`Ambiguous: "${needle}" matches ${matches.length} artifacts. Disambiguate with the stable id:`);
      for (const entry of matches) {
        console.error(`  ${entry.type.padEnd(7)} ${discoveryIdForEntry(entry)} ${entry.title}`);
      }
    }
    process.exit(2);
  }

  const entry = matches[0];
  const absolutePath = resolvePath(entry);
  const backend = params.backend ?? DEFAULT_ARTIFACT_SEARCH_BACKEND;
  const record = backend === 'fortemi-core'
    ? await fortemiRecordForEntry(cwd, entry, sourcePaths)
    : null;
  const payload = {
    id: discoveryIdForEntry(entry),
    backend,
    type: entry.type,
    name: entry.name,
    title: entry.title,
    paths: {
      absolute: absolutePath,
      indexed: entry.path,
      repo_relative: record?.source.repo_relative_path ?? entry.path,
      locator: record?.source.locator ?? entry.name ?? entry.title,
    },
    provenance: {
      graph: (entry as ProvenancedEntry).indexGraph ?? null,
      scope: (entry as ProvenancedEntry).indexScope ?? null,
      ...(webRelease
        ? {
            resource_source: 'web',
            aiwg_selector: webRelease.selector,
            aiwg_version: webRelease.version,
            manifest_sha256: webRelease.manifestDigest,
            manifest_url: webRelease.manifestUrl,
          }
        : {}),
    },
    metadata: record ?? entry,
    providerModels: resourceSource === 'local'
      ? await loadProviderModelMetadata(cwd, aiwgRoot)
      : null,
  };

  if (params.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`${payload.type} ${payload.title}`);
  console.log(`  id: ${payload.id}`);
  if (payload.name) console.log(`  name: ${payload.name}`);
  console.log(`  graph: ${payload.provenance.graph ?? 'unknown'}`);
  console.log(`  scope: ${payload.provenance.scope ?? 'unknown'}`);
  console.log(`  path: ${payload.paths.absolute}`);
  console.log(`  indexed_path: ${payload.paths.indexed}`);
  if (payload.providerModels) {
    console.log('  provider_models:');
    for (const [provider, hints] of Object.entries(payload.providerModels.providers)) {
      console.log(`    ${provider}:`);
      for (const hint of hints) {
        console.log(`      ${hint.role}: ${hint.model} (wrapper: ${hint.wrapper}, status: ${hint.status})`);
      }
    }
  }
  console.log('');
  console.log(JSON.stringify(payload.metadata, null, 2));
}
