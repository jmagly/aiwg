// Share entry identity, provenance, graph selection, and discovery ordering helpers.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { projectAiwgPath, projectControlPath } from '../config/project-artifacts.js';
import { recordTypeForEntry, stableRecordId } from './browser-export.js';
import { loadGraphIndexFile } from './index-reader.js';
import type { ArtifactIndex, GraphType, MetadataEntry, QueryResult } from './types.js';
import { isOperationalShowType, OPERATIONAL_DISCOVERY_TYPES } from './types.js';

export function normalizeIndexedPath(entryPath: string): string {
  return entryPath.replace(/\\/g, '/');
}


/** Historical records stay in the index for explicit show/history lookup. */
export function isOrdinaryMemoryEntry(entry: MetadataEntry, _cwd?: string): boolean {
  // Maintenance owners publish dispositions into the index before returning.
  // Retrieval must not read sources: ordinary legacy entries need no memory
  // stamp, and temporary source I/O failures cannot hide active metadata.
  return !entry.memoryRecord || (entry.memoryRecord.lifecycle === 'active' && entry.memoryRecord.placement !== 'archived');
}


export const DEFAULT_ARTIFACT_SEARCH_BACKEND: 'fortemi-core' = 'fortemi-core';


export const DISCOVER_TYPE_ORDER = new Map(
  [...OPERATIONAL_DISCOVERY_TYPES, 'hook', 'doc'].map((type, index) => [type, index]),
);


export function canonicalLocalityRank(entryPath: string): number {
  const normalized = entryPath.replace(/\\/g, '/');
  if (normalized.startsWith('.aiwg/') || normalized.includes('/.aiwg/')) return 0;
  // Top-level persona mirrors are the least canonical source for a name a bundle
  // also owns. Without this they fell into the catch-all below and scored 1,
  // beating the bundle copy at 2 — the opposite of #1643. It only ever looked
  // correct because a populated user index supplied provenance and `scopeRank`
  // never reached this fallback (#2544).
  if (normalized.startsWith('agentic/code/agents/') || normalized.includes('/agentic/code/agents/')) return 4;
  if (normalized.includes('/plugins/') || normalized.startsWith('agentic/code/plugins/')) return 3;
  if (
    normalized.includes('/frameworks/') ||
    normalized.includes('/addons/') ||
    normalized.includes('/extensions/') ||
    normalized.startsWith('agentic/code/frameworks/') ||
    normalized.startsWith('agentic/code/addons/') ||
    normalized.startsWith('agentic/code/extensions/')
  ) {
    return 2;
  }
  return 1;
}


export type ProvenancedEntry = MetadataEntry & {
  indexGraph?: string;
  indexScope?: 'project' | 'user' | 'packaged' | 'codebase' | 'custom';
};


export function graphScope(graph: GraphType): ProvenancedEntry['indexScope'] {
  if (graph === 'project') return 'project';
  if (graph === 'user' || graph.startsWith('user-')) return 'user';
  if (graph === 'framework') return 'packaged';
  if (graph === 'codebase' || graph === 'source') return 'codebase';
  return 'custom';
}


export function withIndexProvenance(entry: MetadataEntry, graph: GraphType): ProvenancedEntry {
  return { ...entry, indexGraph: graph, indexScope: graphScope(graph) };
}


/** Keep existing project capabilities visible while their derived cache is unavailable. */
export function projectCapabilityFallback(cwd: string): MetadataEntry[] | null {
  const index = loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', 'project');
  if (index) {
    const entries = Object.values(index.entries).map((entry) => withIndexProvenance(entry, 'project'));
    if (entries.length > 0) {
      // One diagnostic per command, on stderr so JSON and skill bodies stay parseable.
      console.error('Warning: project capability cache is unavailable or stale; using the local project index. Run `aiwg index sync` to repair the cache.');
      return entries;
    }
  }
  if (['extensions', 'addons', 'frameworks', 'plugins', 'skills'].some(
    (dir) => fs.existsSync(projectAiwgPath(cwd, dir)),
  )) {
    console.error('Warning: project capabilities could not be loaded: the cache is unavailable and the local project index is missing or empty. Run `aiwg index build --graph project` to repair discovery.');
  }
  return index ? [] : null;
}


export function discoveryIdForEntry(entry: MetadataEntry): string {
  return stableRecordId(recordTypeForEntry(entry, 'v2'), entry.path);
}


export function logicalDiscoverKey(entry: MetadataEntry): string {
  const identity = (entry.name ?? entry.title ?? path.basename(entry.path))
    .toLowerCase()
    .replace(/[-_\s]+/g, ' ')
    .trim();
  return `${entry.type}:${identity}`;
}


export function dedupeDiscoverResults<T extends QueryResult>(results: T[]): T[] {
  const bestByIdentity = new Map<string, T>();
  for (const result of results) {
    const key = logicalDiscoverKey(result.entry);
    const existing = bestByIdentity.get(key);
    if (!existing || compareDiscoverResults(result, existing) < 0) {
      bestByIdentity.set(key, result);
    }
  }
  return Array.from(bestByIdentity.values()).sort(compareDiscoverResults);
}


export function scopeRank(entry: MetadataEntry): number {
  const scope = (entry as ProvenancedEntry).indexScope;
  if (scope === 'project') return 0;
  if (scope === 'user') return 1;
  if (scope === 'custom') return 2;
  if (scope === 'packaged') return 3;
  if (scope === 'codebase') return 4;
  return canonicalLocalityRank(entry.path);
}


export function compareText(left: string | undefined, right: string | undefined): number {
  return (left ?? '').localeCompare(right ?? '');
}


export function compareDiscoverResults(left: QueryResult, right: QueryResult): number {
  const scoreCmp = right.score - left.score;
  if (scoreCmp !== 0) return scoreCmp;

  const localityCmp = scopeRank(left.entry) - scopeRank(right.entry);
  if (localityCmp !== 0) return localityCmp;

  const typeCmp =
    (DISCOVER_TYPE_ORDER.get(left.entry.type) ?? 99) -
    (DISCOVER_TYPE_ORDER.get(right.entry.type) ?? 99);
  if (typeCmp !== 0) return typeCmp;

  const nameCmp = compareText(left.entry.name ?? left.entry.title, right.entry.name ?? right.entry.title);
  if (nameCmp !== 0) return nameCmp;

  return left.entry.path.localeCompare(right.entry.path);
}


export const DEFAULT_DISCOVER_TYPES = [...OPERATIONAL_DISCOVERY_TYPES];


export const DEFAULT_CAPABILITY_GRAPHS: GraphType[] = ['project', 'user', 'framework'];


export function projectAllowsUserIndices(cwd: string): boolean {
  try {
    const configPath = projectControlPath(cwd, 'aiwg.config');
    if (!fs.existsSync(configPath)) return true;
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const index = parsed.index as Record<string, unknown> | undefined;
    const userIndices = index?.userIndices as Record<string, unknown> | undefined;
    if (userIndices?.enabled === false) return false;
    const indices = parsed.indices as Record<string, unknown> | undefined;
    const user = indices?.user as Record<string, unknown> | undefined;
    if (user?.enabled === false) return false;
  } catch {
    return true;
  }
  return true;
}


export function defaultCapabilityGraphs(cwd: string): GraphType[] {
  if (projectAllowsUserIndices(cwd)) return DEFAULT_CAPABILITY_GRAPHS;
  return DEFAULT_CAPABILITY_GRAPHS.filter((graph) => graph !== 'user' && !graph.startsWith('user-'));
}


/**
 * Resolve the AIWG installation root for path-anchoring discover output.
 * Discover returns paths anchored to AIWG_ROOT so the agent's `Read`
 * tool can resolve them from any project working directory (#1217).
 */
/**
 * Build the `run_hint` string for a script-bearing skill entry (#1227).
 *
 * Format: `aiwg run skill <name> [-- <argsHint>]`. The skill name is the
 * basename of its source directory (skills/<name>/SKILL.md), which is
 * what `aiwg run skill` accepts.
 */
export function buildRunHint(entry: MetadataEntry): string {
  // Use the directory basename for slug-layout skills, filename stem otherwise.
  const lastSlash = entry.path.lastIndexOf('/');
  const tail = lastSlash >= 0 ? entry.path.slice(lastSlash + 1) : entry.path;
  let name: string;
  if (tail === 'SKILL.md' && lastSlash >= 0) {
    const dir = entry.path.slice(0, lastSlash);
    const dirSlash = dir.lastIndexOf('/');
    name = dirSlash >= 0 ? dir.slice(dirSlash + 1) : dir;
  } else {
    name = tail.replace(/\.[^.]+$/, '');
  }
  const argsHint = entry.script?.argsHint ? ` -- ${entry.script.argsHint}` : '';
  return `aiwg run skill ${name}${argsHint}`;
}


export function showHintForDiscoverResult(entry: MetadataEntry, id: string): string {
  if (isOperationalShowType(entry.type)) {
    return `aiwg show ${entry.type} ${id}`;
  }
  return `aiwg show ${id}`;
}
