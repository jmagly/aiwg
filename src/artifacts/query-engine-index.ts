// Search artifact indexes and emit ranked query results.
import { minimatch } from 'minimatch';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { projectAiwgPath } from '../config/project-artifacts.js';
import { bm25Rank, type FullTextDoc } from './fulltext.js';
import { parseFrontmatter } from './index-builder.js';
import { loadGraphIndexFile, loadMetadataIndex } from './index-reader.js';
import { operationalStateQueryProjection, type OperationalStateQueryProjection } from './operational-state.js';
import {
  compareDiscoverResults,
  DEFAULT_ARTIFACT_SEARCH_BACKEND,
  isOrdinaryMemoryEntry,
  normalizeIndexedPath,
} from './query-engine-entries.js';
import { type QueryOptions } from './query-engine-options.js';
import { scoreEntry } from './query-engine-scoring.js';
import type { ArtifactIndex, GraphType, MetadataEntry, QueryParams, QueryResult } from './types.js';

/**
 * Resolve an index entry's source file path and read its body (frontmatter
 * stripped). Entry paths are normally relative to the project; framework-graph
 * entries may be absolute or anchored to $AIWG_ROOT. Returns null when the
 * file can't be read (stale index entry) so full-text ranking skips it.
 */
export function readEntryBody(cwd: string, entryPath: string): string | null {
  const candidates: string[] = [];
  if (path.isAbsolute(entryPath)) candidates.push(entryPath);
  else {
    const normalizedPath = normalizeIndexedPath(entryPath);
    if (normalizedPath.startsWith('.aiwg/')) {
      candidates.push(projectAiwgPath(cwd, normalizedPath.slice('.aiwg/'.length)));
    }
    candidates.push(path.resolve(cwd, normalizedPath));
    if (process.env.AIWG_ROOT) candidates.push(path.resolve(process.env.AIWG_ROOT, normalizedPath));
  }
  for (const p of candidates) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      return parseFrontmatter(raw).body;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}


/**
 * Query the artifact index
 */
export async function queryIndex(
  cwd: string,
  params: QueryParams,
  options: QueryOptions = {}
): Promise<void> {
  const { graph } = options;
  const backend = options.backend ?? DEFAULT_ARTIFACT_SEARCH_BACKEND;
  const startTime = Date.now();

  let candidates: MetadataEntry[];

  if (backend === 'fortemi-core') {
    const { loadFortemiCoreMetadataEntries } = await import('./fortemi-core-query-adapter.js');
    const loaded = loadFortemiCoreMetadataEntries(cwd, graph ?? 'project');
    if (loaded.reason) {
      if (options.json) {
        console.log(JSON.stringify({
          query: { text: params.text, backend: 'fortemi-core', graph: graph ?? 'project' },
          results: [],
          total: 0,
          hint: loaded.reason ?? 'Fortemi Core static index is unavailable.',
        }, null, 2));
      } else {
        console.error('Error: ' + (loaded.reason ?? 'Fortemi Core static index is unavailable.'));
      }
      process.exit(1);
    }
    candidates = loaded.entries;
  } else if (graph) {
    // Single graph mode
    const index = loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', graph);
    if (!index) {
      console.error(`Error: No artifact index found for graph '${graph}'.`);
      console.log("Run 'aiwg index build' first to create the index.");
      process.exit(1);
    }
    candidates = Object.values(index.entries);
  } else {
    // No graph specified: search across all project-local graphs
    const graphTypes: GraphType[] = ['project', 'codebase'];
    const allEntries: MetadataEntry[] = [];
    for (const g of graphTypes) {
      const idx = loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', g);
      if (idx) allEntries.push(...Object.values(idx.entries));
    }

    // Fall back to legacy root index
    if (allEntries.length === 0) {
      const legacy = loadMetadataIndex(cwd);
      if (!legacy) {
        console.error('Error: No artifact index found.');
        console.log("Run 'aiwg index build' first to create the index.");
        process.exit(1);
      }
      allEntries.push(...Object.values(legacy.entries));
    }

    candidates = allEntries;
  }

  // Retained tombstones are history, never ordinary retrieval results.
  candidates = candidates.filter(entry => isOrdinaryMemoryEntry(entry, cwd));
  // Apply filters
  if (params.type) {
    candidates = candidates.filter(e => e.type === params.type);
  }
  if (params.phase) {
    candidates = candidates.filter(e => e.phase === params.phase);
  }
  if (params.tags && params.tags.length > 0) {
    candidates = candidates.filter(e =>
      params.tags!.every(tag => e.tags.includes(tag))
    );
  }
  if (params.path) {
    candidates = candidates.filter(e => minimatch(e.path, params.path!));
  }
  if (params.updatedAfter) {
    const cutoff = new Date(params.updatedAfter).getTime();
    candidates = candidates.filter(e => new Date(e.updated).getTime() >= cutoff);
  }

  // Score and rank
  let results: QueryResult[];
  const matchedById = new Map<string, string[]>();
  const operationalStateById = new Map<string, OperationalStateQueryProjection>();
  if (params.text && params.fulltext && backend === 'fortemi-core') {
    const { queryFortemiCoreStaticFulltextIndex } = await import('./fortemi-core-query-adapter.js');
    const queried = queryFortemiCoreStaticFulltextIndex(cwd, {
      graph: graph ?? 'project',
      text: params.text,
      limit: params.limit ?? 20,
      path: params.path,
      type: params.type,
      phase: params.phase,
      tags: params.tags,
    });
    if (queried.reason) {
      if (options.json) {
        console.log(JSON.stringify({
          query: { text: params.text, backend: 'fortemi-core', graph: graph ?? 'project' },
          mode: 'fulltext',
          results: [],
          total: 0,
          hint: queried.reason,
        }, null, 2));
      } else {
        console.error('Error: ' + queried.reason);
      }
      process.exit(1);
    }
    const candidateByPath = new Map(candidates.map(entry => [entry.path, entry]));
    results = queried.results.filter(result => candidateByPath.has(result.path)).map(result => {
      const entry: MetadataEntry = {
        ...(candidateByPath.get(result.path)?.memoryRecord ? { memoryRecord: candidateByPath.get(result.path)!.memoryRecord } : {}),
        path: result.path,
        type: result.type,
        phase: result.phase,
        title: result.title,
        tags: result.tags,
        created: '',
        updated: '',
        checksum: '',
        summary: result.summary,
        dependencies: [],
        dependents: [],
      };
      matchedById.set(result.path, result.matched);
      if (result.operational_state) {
        operationalStateById.set(result.path, result.operational_state);
      }
      return { entry, score: result.score };
    });
  } else if (params.text && params.fulltext) {
    // Lexical full-text (#1494): read candidate bodies and BM25-rank. The
    // index is the candidate set; ranking is over actual body content, not
    // the metadata/summary the default path scores.
    const byPath = new Map<string, MetadataEntry>();
    const docs: FullTextDoc[] = [];
    for (const entry of candidates) {
      const body = readEntryBody(cwd, entry.path);
      if (body === null) continue;
      byPath.set(entry.path, entry);
      docs.push({ id: entry.path, text: body });
    }
    const hits = bm25Rank(docs, params.text);
    results = hits
      .map(h => {
        matchedById.set(h.id, h.matchedTerms);
        return { entry: byPath.get(h.id)!, score: h.score };
      })
      .filter(r => r.entry);
  } else if (params.text) {
    results = candidates
      .map(entry => ({ entry, score: scoreEntry(entry, params.text!) }))
      .filter(r => r.score > 0)
      .sort(compareDiscoverResults);
  } else {
    // No keyword — return all filtered results with score 1.0
    results = candidates.map(entry => ({ entry, score: 1.0 }));
  }

  // Apply limit
  const limit = params.limit ?? 20;
  results = results.filter(result => isOrdinaryMemoryEntry(result.entry, cwd)).slice(0, limit);

  const queryTimeMs = Date.now() - startTime;

  // Output
  if (options.json) {
    console.log(JSON.stringify({
      query: { text: params.text, filters: { type: params.type, phase: params.phase, tags: params.tags, path: params.path }, backend },
      mode: params.fulltext ? 'fulltext' : 'metadata',
      results: results.map(r => ({
        path: r.entry.path,
        type: r.entry.type,
        phase: r.entry.phase,
        title: r.entry.title,
        score: Math.round(r.score * 100) / 100,
        summary: r.entry.summary,
        ...(operationalStateById.has(r.entry.path)
          ? { operational_state: operationalStateById.get(r.entry.path) }
          : r.entry.operationalState
            ? { operational_state: operationalStateQueryProjection(r.entry.operationalState) }
            : {}),
        ...(params.fulltext ? { matched: matchedById.get(r.entry.path) ?? [] } : {}),
      })),
      total: results.length,
      query_time_ms: queryTimeMs,
    }, null, 2));
  } else {
    const queryDesc = params.text ? `"${params.text}"` : 'all';
    console.log(`Results for ${queryDesc} (${results.length} matches, ${queryTimeMs}ms):`);
    console.log('');
    console.log('  #  Score  Type         Phase          Path');

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const num = String(i + 1).padStart(3);
      const score = r.score.toFixed(2).padStart(4);
      const type = r.entry.type.padEnd(12).slice(0, 12);
      const phase = r.entry.phase.padEnd(14).slice(0, 14);
      console.log(`  ${num}  ${score}  ${type} ${phase} ${r.entry.path}`);
    }

    if (results.length === 0) {
      console.log('  No results found.');
    }
    console.log('');
  }
}
