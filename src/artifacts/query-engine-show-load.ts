// Load local or verified web metadata for show lookups.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { projectAiwgPath } from '../config/project-artifacts.js';
import type { ResourceSource, VerifiedWebRelease } from '../resources/web-release.js';
import { type AiwgFortemiRecord } from './browser-export.js';
import { refreshFrameworkCapabilities, resolveFrameworkCorpusRoot } from './framework-capabilities.js';
import { resolveFrameworkIndexRoot } from './framework-index-paths.js';
import { loadGraphIndexFile, loadMetadataIndex } from './index-reader.js';
import {
  DEFAULT_ARTIFACT_SEARCH_BACKEND,
  defaultCapabilityGraphs,
  discoveryIdForEntry,
  isOrdinaryMemoryEntry,
  normalizeIndexedPath,
  projectCapabilityFallback,
  withIndexProvenance,
  type ProvenancedEntry,
} from './query-engine-entries.js';
import { findShowMatches } from './query-engine-matching.js';
import { type ShowParams } from './query-engine-options.js';
import { ensureRelations, type RelationsReader } from './relations.js';
import type { ArtifactIndex, GraphType, MetadataEntry } from './types.js';
import { getGraphIndexDir, OPERATIONAL_SHOW_TYPES } from './types.js';

export function resolveMetadataPath(cwd: string, aiwgRoot: string | null, entry: MetadataEntry): string {
  if (path.isAbsolute(entry.path)) return entry.path;
  const normalizedPath = normalizeIndexedPath(entry.path);
  if (aiwgRoot && normalizedPath.startsWith('agentic/code/')) {
    return path.join(aiwgRoot, normalizedPath);
  }
  if ((entry as ProvenancedEntry).indexScope === 'user' && normalizedPath.startsWith('~/.aiwg/')) {
    return path.join(process.env.HOME ?? '', normalizedPath.slice(2));
  }
  if (normalizedPath.startsWith('.aiwg/')) {
    return projectAiwgPath(cwd, normalizedPath.slice('.aiwg/'.length));
  }
  return path.join(cwd, normalizedPath);
}


export async function loadShowEntries(
  cwd: string,
  params: Pick<
    ShowParams,
    'backend' | 'graph' | 'json' | 'name' | 'resourceSource' | 'aiwgVersion' | 'offline' | 'webReleaseOptions' | 'typeFilter'
  >,
  compact = false,
): Promise<{
  entries: MetadataEntry[];
  aiwgRoot: string | null;
  resourceSource: 'local' | 'web';
  webRelease?: VerifiedWebRelease;
  sourcePaths?: import('./fortemi-core-query-adapter.js').FortemiCoreVerifiedSourcePaths;
  relations?: RelationsReader;
}> {
  const aiwgRoot = resolveFrameworkIndexRoot(cwd);
  const backend = params.backend ?? DEFAULT_ARTIFACT_SEARCH_BACKEND;
  let resourceSource: ResourceSource = params.resourceSource ?? 'local';
  let entries: MetadataEntry[] = [];
  let relations: RelationsReader | undefined;

  if (compact && resourceSource !== 'web' && (!params.graph || params.graph === 'framework')) {
    relations = await ensureRelations(cwd) ?? undefined;
    if (relations?.index.artifacts) {
      const reader = relations;
      const matched = findShowMatches(Object.values(reader.index.artifacts!) as MetadataEntry[], params.typeFilter ?? [...OPERATIONAL_SHOW_TYPES], params.name.trim());
      const frameworkEntries = matched.map(entry => {
        const id = discoveryIdForEntry(entry);
        const rule = reader.index.rules[id];
        return withIndexProvenance({ ...entry, phase: '', tags: [], created: '', updated: '', checksum: '', summary: '', dependencies: [], dependents: [],
          ...(rule ? { activation: reader.pinnedRuleIds.has(id) ? 'kernel' : rule.activation ?? undefined,
            ruleSummary: rule.summary, ruleEnforcement: rule.enforcement ?? undefined, bound_to: rule.bound_to } : {}),
        } as MetadataEntry, 'framework');
      });
      const localEntries = params.graph ? [] : defaultCapabilityGraphs(cwd).filter(graph => graph !== 'framework')
        .flatMap(graph => loadLocalCapabilityEntries(cwd, graph, undefined, true));
      const compactEntries = [...localEntries, ...frameworkEntries];
      if ((params.typeFilter?.every(type => ['skill', 'agent', 'flow', 'command', 'rule', 'behavior'].includes(type)))
        || findShowMatches(compactEntries, params.typeFilter ?? [...OPERATIONAL_SHOW_TYPES], params.name.trim()).length) {
        return { entries: compactEntries, aiwgRoot, resourceSource: 'local', relations };
      }
    }
  }

  if (resourceSource !== 'web' && (!params.graph || params.graph === 'framework')) {
    const root = resolveFrameworkCorpusRoot(cwd) ?? aiwgRoot;
    if (root) {
      try {
        await refreshFrameworkCapabilities(root, backend === 'fortemi-core' && params.backend !== undefined);
      } catch (error) {
        console.error(`Warning: capability index refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (resourceSource === 'auto' && backend === 'fortemi-core') {
    const { loadFortemiCoreMetadataEntries } = await import('./fortemi-core-query-adapter.js');
    const localGraphs = params.graph ? [params.graph] : defaultCapabilityGraphs(cwd);
    resourceSource = localGraphs.some(
      (graph) => loadFortemiCoreMetadataEntries(cwd, graph).entries.length > 0,
    ) ? 'local' : 'web';
  } else if (resourceSource === 'auto') {
    resourceSource = 'local';
  }

  if (resourceSource === 'web') {
    if (backend !== 'fortemi-core') {
      console.error('Error: --resource-source web requires the Fortemi Core query backend; --backend local remains available with local resources.');
      process.exit(1);
    }
    if (params.graph && params.graph !== 'framework') {
      console.error("Error: web-backed show currently supports only the 'framework' graph.");
      process.exit(1);
    }
    try {
      const { resolveWebRelease } = await import('../resources/web-release.js');
      const webRelease = await resolveWebRelease({
        ...params.webReleaseOptions,
        selector: params.aiwgVersion ?? 'stable',
        offline: params.offline,
      });
      const sourcePaths = {
        manifestPath: webRelease.fortemiManifestPath,
        exportPath: webRelease.fortemiExportPath,
        manifestSha256: webRelease.fortemiManifestSha256,
        manifestSize: webRelease.fortemiManifestSize,
        exportSha256: webRelease.fortemiExportSha256,
        exportSize: webRelease.fortemiExportSize,
      };
      const { loadFortemiCoreMetadataEntries } = await import('./fortemi-core-query-adapter.js');
      const loaded = loadFortemiCoreMetadataEntries(cwd, 'framework', sourcePaths);
      if (loaded.reason) throw new Error(loaded.reason);
      entries = loaded.entries.map((entry) => withIndexProvenance(entry, 'framework'));
      return { entries, aiwgRoot, resourceSource: 'web', webRelease, sourcePaths };
    } catch (error) {
      console.error(`Error: AIWG web resource resolution failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }

  // Preserve the direct API's historical local-index behavior when callers
  // omit `backend`. The CLI always passes its explicit Fortemi default, while
  // an explicit `auto` source also opts into Fortemi-backed availability.
  if (params.backend === 'fortemi-core' || params.resourceSource === 'auto') {
    const { loadFortemiCoreMetadataEntries } = await import('./fortemi-core-query-adapter.js');
    const graphs = params.graph ? [params.graph] : defaultCapabilityGraphs(cwd);
    let unavailableReason: string | undefined;
    for (const graph of graphs) {
      const loaded = loadFortemiCoreMetadataEntries(cwd, graph);
      if (loaded.reason && graph === 'project' && !params.graph) {
        const fallback = projectCapabilityFallback(cwd);
        if (fallback) {
          entries.push(...fallback);
          continue;
        }
      }
      if (loaded.reason) {
        unavailableReason ??= loaded.reason;
        if (graph === 'framework' && !params.graph) {
          console.error(`Warning: framework capabilities are unavailable: ${loaded.reason}`);
        }
      }
      entries.push(...loaded.entries.map((entry) => withIndexProvenance(entry, graph)));
    }
    if (entries.length === 0 && unavailableReason) {
      if (params.json) {
        console.log(JSON.stringify({
          backend: 'fortemi-core',
          name: params.name,
          error: unavailableReason,
        }, null, 2));
      } else {
        console.error('Error: ' + unavailableReason);
      }
      process.exit(1);
    }
  } else {
    entries = loadLocalCapabilityEntries(cwd, params.graph, undefined, true);
  }
  return { entries, aiwgRoot, resourceSource: 'local', relations };
}


/** Local index inputs shared by show and exact rule-binding validation (#2938). */
export function loadLocalCapabilityEntries(
  cwd: string, graph?: GraphType, snapshot?: Map<string, MetadataEntry[]>, includeHistory = false,
): MetadataEntry[] {
  const entries: MetadataEntry[] = [];
  for (const selectedGraph of graph ? [graph] : defaultCapabilityGraphs(cwd)) {
    const key = snapshot && `${selectedGraph}:${getGraphIndexDir(cwd, selectedGraph)}`;
    let selected = key ? snapshot!.get(key) : undefined;
    if (!selected) {
      const index = loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', selectedGraph);
      selected = index ? Object.values(index.entries).map(entry => withIndexProvenance(entry, selectedGraph)) : [];
      if (key) snapshot!.set(key, selected);
    }
    entries.push(...selected);
  }
  if (!graph && entries.length === 0) {
    const legacy = loadMetadataIndex(cwd);
    if (legacy) entries.push(...Object.values(legacy.entries));
  }
  return includeHistory ? entries : entries.filter(entry => isOrdinaryMemoryEntry(entry, cwd));
}


/** Project/user inputs only; package artifacts come from a validated compact table. */
export function loadLocalOverrideCapabilityEntries(cwd: string): MetadataEntry[] {
  const local = defaultCapabilityGraphs(cwd).filter(graph => graph !== 'framework')
    .flatMap(graph => loadLocalCapabilityEntries(cwd, graph));
  if (local.length) return local;
  const canonical = (directory: string): string => {
    try { return fs.realpathSync(directory); } catch { return path.resolve(directory); }
  };
  const packageRoot = canonical(resolveFrameworkIndexRoot(cwd));
  // Retain the legacy PROJECT index, never use the package's full index as a fallback.
  if (canonical(cwd) === packageRoot) return [];
  const legacy = loadMetadataIndex(cwd);
  return Object.values(legacy?.entries ?? {}).filter(entry => {
    const provenance = entry as ProvenancedEntry;
    if (provenance.indexGraph === 'framework' || provenance.indexScope === 'packaged'
      || normalizeIndexedPath(entry.path).startsWith('agentic/code/')) return false;
    const relative = path.relative(packageRoot, path.resolve(cwd, entry.path));
    return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  }).map(entry => withIndexProvenance(entry, 'project'));
}


export async function fortemiRecordForEntry(
  cwd: string,
  entry: MetadataEntry,
  sourcePaths?: import('./fortemi-core-query-adapter.js').FortemiCoreVerifiedSourcePaths,
): Promise<AiwgFortemiRecord | null> {
  const graph = ((entry as ProvenancedEntry).indexGraph ?? 'project') as GraphType;
  const { loadFortemiCoreExport } = await import('./fortemi-core-query-adapter.js');
  const loaded = loadFortemiCoreExport(cwd, graph, sourcePaths);
  if (!loaded.exported) return null;
  const id = discoveryIdForEntry(entry);
  return loaded.exported.items.find((record) => record.id === id || record.source.path === entry.path) ?? null;
}
