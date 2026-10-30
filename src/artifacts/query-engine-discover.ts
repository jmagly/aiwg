// Load and rank capability discovery candidates.
import type { ResourceSource, VerifiedWebRelease } from '../resources/web-release.js';
import { applyFacetFusion } from './discover-facets.js';
import { refreshFrameworkCapabilities, resolveFrameworkCorpusRoot } from './framework-capabilities.js';
import { resolveFrameworkIndexRoot } from './framework-index-paths.js';
import { loadGraphIndexFile, loadMetadataIndex } from './index-reader.js';
import { emitDiscoverResults } from './query-engine-discover-output.js';
import {
  compareDiscoverResults,
  dedupeDiscoverResults,
  DEFAULT_ARTIFACT_SEARCH_BACKEND,
  DEFAULT_DISCOVER_TYPES,
  defaultCapabilityGraphs,
  discoveryIdForEntry,
  isOrdinaryMemoryEntry,
  projectAllowsUserIndices,
  projectCapabilityFallback,
  withIndexProvenance,
} from './query-engine-entries.js';
import { type DiscoverParams } from './query-engine-options.js';
import { scoreEntryDetailed, type LexicalScoreDiagnostic } from './query-engine-scoring.js';
import { emptyRuleStats, selectPrebuiltRelations } from './relations.js';
import type { ArtifactIndex, GraphType, MetadataEntry } from './types.js';
import { loadGlobalGraphConfigs } from './types.js';

export async function discoverCapability(
  cwd: string,
  params: DiscoverParams,
): Promise<void> {
  loadGlobalGraphConfigs();
  const startTime = Date.now();
  const types = params.typeFilter && params.typeFilter.length > 0
    ? params.typeFilter
    : DEFAULT_DISCOVER_TYPES;
  // Default top-K = 5 (Wave A from #1218): peer-reviewed work on tool
  // retrieval (Semantic Tool Discovery for MCP, arXiv:2603.20313) reports
  // 97.1% hit@K=3 at scale; K=5 keeps a buffer above K=3 while halving
  // the prior K=10 default. Operators wanting more breadth can pass
  // `--limit N` explicitly.
  const limit = params.limit ?? 5;
  // For framework-graph entries, anchor returned paths to AIWG_ROOT so
  // they resolve from any project working directory (#1217).
  const aiwgRoot = resolveFrameworkIndexRoot(cwd);

  // Source: prefer `framework` graph (built post-deploy), fall back to
  // project / codebase / legacy depending on what's available.
  let entries: MetadataEntry[] = [];
  const backend = params.backend ?? DEFAULT_ARTIFACT_SEARCH_BACKEND;
  let fortemiCoreDiscoveryScores: Map<string, number> | null = null;
  let resourceSource: ResourceSource = params.resourceSource ?? 'local';
  let resolvedWebRelease: VerifiedWebRelease | undefined;
  let verifiedSourcePaths:
    | import('./fortemi-core-query-adapter.js').FortemiCoreVerifiedSourcePaths
    | undefined;

  const prebuiltRelations = resourceSource !== 'web' && (!params.graph || params.graph === 'framework')
    ? selectPrebuiltRelations(cwd).reader : null;

  if ((!prebuiltRelations || backend === 'local') && resourceSource !== 'web' && (!params.graph || params.graph === 'framework')) {
    const root = resolveFrameworkCorpusRoot(cwd) ?? aiwgRoot;
    if (root) {
      try {
        await refreshFrameworkCapabilities(root, backend === 'fortemi-core');
      } catch (error) {
        console.error(`Warning: capability index refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (resourceSource === 'auto') {
    const { loadFortemiCoreMetadataEntries } = await import('./fortemi-core-query-adapter.js');
    const localGraphs = params.graph ? [params.graph] : defaultCapabilityGraphs(cwd);
    const localAvailable = localGraphs.some(
      (graph) => loadFortemiCoreMetadataEntries(cwd, graph).entries.length > 0
        || Object.keys(loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', graph)?.entries ?? {}).length > 0,
    );
    resourceSource = localAvailable ? 'local' : 'web';
  }

  if (resourceSource === 'web') {
    if (backend !== 'fortemi-core') {
      console.error('Error: --resource-source web requires the Fortemi Core query backend; --backend local remains available with local resources.');
      process.exit(1);
    }
    if (params.graph && params.graph !== 'framework') {
      console.error("Error: web-backed capability discovery currently supports only the 'framework' graph.");
      process.exit(1);
    }
    try {
      const { resolveWebRelease } = await import('../resources/web-release.js');
      const release = await resolveWebRelease({
        ...params.webReleaseOptions,
        selector: params.aiwgVersion ?? 'stable',
        offline: params.offline,
      });
      resolvedWebRelease = release;
      verifiedSourcePaths = {
        manifestPath: release.fortemiManifestPath,
        exportPath: release.fortemiExportPath,
        manifestSha256: release.fortemiManifestSha256,
        manifestSize: release.fortemiManifestSize,
        exportSha256: release.fortemiExportSha256,
        exportSize: release.fortemiExportSize,
      };
    } catch (error) {
      console.error(`Error: AIWG web resource resolution failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }

  if (backend === 'fortemi-core') {
    const graphs = resourceSource === 'web'
      ? ['framework' as GraphType]
      : params.graph ? [params.graph] : defaultCapabilityGraphs(cwd);
    const {
      loadFortemiCoreMetadataEntries,
      queryFortemiCoreAiwgDiscovery,
    } = await import('./fortemi-core-query-adapter.js');
    let unavailableReason: string | undefined;
    for (const graph of graphs) {
      const loaded = loadFortemiCoreMetadataEntries(cwd, graph, verifiedSourcePaths);
      if (loaded.reason && graph === 'project' && !params.graph) {
        const fallback = projectCapabilityFallback(cwd);
        if (fallback) {
          entries.push(...fallback);
          continue;
        }
      }
      if (loaded.sourceIndexNewer && resourceSource === 'local') {
        // Do not silently omit a graph whose derived cache is stale. Rank its
        // current source metadata, without consulting scores from the old cache.
        const index = loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', graph);
        if (index) {
          console.error(`Warning: ${graph} capability cache is unavailable or stale; using the local ${graph} index. ${loaded.reason}`);
          entries.push(...Object.values(index.entries).map((entry) => withIndexProvenance(entry, graph)));
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
      const discovered = await queryFortemiCoreAiwgDiscovery(cwd, {
        graph,
        text: params.phrase,
        limit: Math.max(limit * 10, 50),
        types,
        sourcePaths: verifiedSourcePaths,
      });
      if (!discovered.reason) {
        fortemiCoreDiscoveryScores ??= new Map();
        for (const result of discovered.results) {
          if (result.score <= 0) continue;
          fortemiCoreDiscoveryScores.set(
            result.entry.path,
            Math.max(fortemiCoreDiscoveryScores.get(result.entry.path) ?? 0, result.score),
          );
        }
      }
    }
    if (entries.length === 0 && unavailableReason) {
      if (params.json) {
        console.log(JSON.stringify({
          query: {
            phrase: params.phrase,
            types,
            limit,
            backend: 'fortemi-core',
            graph: resourceSource === 'web' ? 'framework' : params.graph ?? 'capability-default',
            ...(resourceSource === 'web'
              ? {
                  resource_source: 'web',
                  aiwg_selector: resolvedWebRelease?.selector,
                  aiwg_version: resolvedWebRelease?.version,
                  manifest_sha256: resolvedWebRelease?.manifestDigest,
                  manifest_url: resolvedWebRelease?.manifestUrl,
                }
              : {}),
          },
          results: [],
          rule_stats: emptyRuleStats(),
          total: 0,
          hint: unavailableReason,
        }, null, 2));
      } else {
        console.error('Error: ' + unavailableReason);
      }
      process.exit(1);
    }
  } else if (params.graph) {
    const idx = loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', params.graph);
    if (idx) entries = Object.values(idx.entries).map((entry) => withIndexProvenance(entry, params.graph!));
  } else {
    // discover is EXCLUSIVELY the agentic-capability surface (#1545): source
    // the `framework` graph (deployed AIWG capabilities) + project-local
    // capability artifacts. NEVER `codebase` — source code is not a capability
    // surface. The framework
    // index is reconciled with its source above, including existing indexes
    // left behind by an older runtime or a different checkout.
    const fwIdx = loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', 'framework');
    const includeUser = projectAllowsUserIndices(cwd);
    // Project-local operational artifacts authored in this project. The
    // DEFAULT_DISCOVER_TYPES filter keeps non-capability project artifacts
    // (requirements, ADRs, …) out of results.
    const projIdx = loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', 'project');
    if (projIdx) entries.push(...Object.values(projIdx.entries).map((entry) => withIndexProvenance(entry, 'project')));
    if (includeUser) {
      const userIdx = loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', 'user');
      if (userIdx) entries.push(...Object.values(userIdx.entries).map((entry) => withIndexProvenance(entry, 'user')));
    }
    if (fwIdx) entries.push(...Object.values(fwIdx.entries).map((entry) => withIndexProvenance(entry, 'framework')));
    if (entries.length === 0) {
      const legacy = loadMetadataIndex(cwd);
      if (legacy) entries.push(...Object.values(legacy.entries));
    }
  }

  if (entries.length === 0 && backend !== 'fortemi-core') {
    // Empty-index case (#1221). Surface a hint that explains the gap rather
    // than returning a bare zero-result envelope — the latter trains agents
    // to conclude "AIWG doesn't have a skill for that" when in fact the
    // index simply hasn't been built in this workspace yet.
    const hint = 'No artifact index found. Run `aiwg index build --graph framework` (or `aiwg use <framework>`) first.';
    if (params.json) {
      console.log(JSON.stringify({
        query: { phrase: params.phrase, types },
        results: [],
        rule_stats: emptyRuleStats(),
        total: 0,
        hint,
      }, null, 2));
    } else {
      console.error('Error: No artifact index found.');
      console.log('Run `aiwg index build --graph framework` (or `aiwg use <framework>`) first.');
    }
    process.exit(1);
  }

  // Filter by type
  entries = entries.filter(entry => isOrdinaryMemoryEntry(entry, cwd));
  const candidates = entries.filter(e => types.includes(e.type));

  // Score (strict overlap gate). Keep the full sorted list so the facet
  // fusion below can inject/lift curated capabilities into the top-K before
  // truncation — a capability that the lexical pass ranked outside `limit`
  // (or missed entirely) still surfaces when the query activates its facet.
  const lexicalDiagnostics = new Map<string, LexicalScoreDiagnostic>();
  const legacyStrictScored = candidates
    .map(entry => {
      const detailed = scoreEntryDetailed(entry, params.phrase);
      const legacyScore = detailed.score;
      const fortemiScore = fortemiCoreDiscoveryScores?.get(entry.path) ?? 0;
      lexicalDiagnostics.set(entry.path, detailed.diagnostic);
      return {
        entry,
        score: legacyScore > 0 ? legacyScore : fortemiScore * 0.2,
        legacyScore,
      };
    })
    .filter(r => r.score > 0)
    .sort(compareDiscoverResults);
  const strictScored = (
    legacyStrictScored.some(result => result.legacyScore > 0)
      ? legacyStrictScored.filter(result => result.legacyScore > 0)
      : legacyStrictScored
  ).map(({ entry, score }) => ({ entry, score }));

  // Single-pass facet fusion (#1623 U3): fuse the curated feature→capability
  // facets (expansion / persona / project / provider-capability) into the
  // lexical ranking so canonical domain phrases rank their owning capability
  // top-K instead of being out-scored by artifacts that merely mention the
  // word. Facet activation can also rescue an otherwise-empty strict pass.
  // #154 — a strict result anywhere in the corpus must not suppress relevant
  // partial matches for a natural-language query. Score the relaxed pass on
  // matched terms (unmatched terms do not divide the score), apply a noise
  // floor, and union it with strict matches before ranking. Word-boundary
  // token matching keeps this from resurrecting substring noise such as UX in
  // Linux.
  const RELAXED_MIN_SCORE = 0.02;
  const strictPaths = new Set(strictScored.map(result => result.entry.path));
  const combinedByPath = new Map(strictScored.map(result => [result.entry.path, result]));
  for (const entry of candidates) {
    const detailed = scoreEntryDetailed(entry, params.phrase, { relaxOverlap: true });
    if (detailed.score < RELAXED_MIN_SCORE) continue;
    const existing = combinedByPath.get(entry.path);
    if (!existing || detailed.score > existing.score) {
      combinedByPath.set(entry.path, { entry, score: detailed.score });
      lexicalDiagnostics.set(entry.path, detailed.diagnostic);
    }
  }
  const scored = dedupeDiscoverResults(
    await applyFacetFusion(
      Array.from(combinedByPath.values()).sort(compareDiscoverResults),
      candidates,
      params.phrase,
    ),
  ).slice(0, limit);
  const relaxed = scored.some(result => !strictPaths.has(result.entry.path));

  if (params.shadowRoute) {
    try {
      await params.shadowRoute.observe(params.phrase, scored.map(result => ({
        id: discoveryIdForEntry(result.entry), name: result.entry.name ?? result.entry.title,
        type: result.entry.type, capability: result.entry.capability ?? result.entry.summary,
        score: result.score,
      })));
    } catch {
      // An optional observation failure must never replace deterministic discovery.
      params.shadowRoute.disable();
    }
  }

  const queryTimeMs = Date.now() - startTime;

  await emitDiscoverResults({ cwd, params, types, limit, aiwgRoot, entries, backend, resourceSource,
    resolvedWebRelease, prebuiltRelations, scored, relaxed, queryTimeMs, lexicalDiagnostics });
}
