// Resolve show matches and exact rule-binding target identities.
import * as path from 'node:path';
import {
  preferCanonicalBindingTargets,
  selectBindingTargetIdentities,
  type BindingTargetIdentityOptions,
} from './binding-target-identity.js';
import { discoveryIdForEntry, normalizeIndexedPath, scopeRank } from './query-engine-entries.js';
import type { MetadataEntry } from './types.js';

export function findShowMatches(entries: MetadataEntry[], types: string[], needle: string): MetadataEntry[] {
  const needleLower = needle.toLowerCase();
  const normalizedNeedle = normalizeIndexedPath(needle);
  const candidates = entries.filter(e => types.includes(e.type));

  let matches = needle.startsWith('aiwg:') ? candidates.filter(e => discoveryIdForEntry(e) === needle) : [];
  if (matches.length === 0) {
    matches = candidates.filter(e => e.path === needle || normalizeIndexedPath(e.path) === normalizedNeedle);
  }
  if (matches.length === 0) {
    matches = candidates.filter(e => {
      const normalizedPath = normalizeIndexedPath(e.path);
      const dirStem = path.basename(path.dirname(normalizedPath));
      const basename = path.basename(normalizedPath);
      const fileStem = basename.replace(/\.[^.]+$/, '');
      const slugLayoutMatch =
        ((basename === 'SKILL.md' && e.type === 'skill') ||
          (basename === 'BEHAVIOR.md' && e.type === 'behavior')) &&
        dirStem === needle;
      if (slugLayoutMatch || fileStem === needle || e.name === needle) return true;
      if (e.type === 'gate-pack' && typeof e.name === 'string') {
        const gateStem = fileStem.replace(/\.gatepack$/i, '');
        const rest = e.name.includes(':') ? e.name.slice(e.name.indexOf(':') + 1) : e.name;
        const short = rest.includes('/') ? rest.slice(rest.indexOf('/') + 1) : rest;
        return gateStem === needle || rest === needle || short === needle;
      }
      return false;
    });
  }
  if (matches.length === 0) {
    matches = candidates.filter(e =>
      typeof e.title === 'string' && e.title.toLowerCase() === needleLower,
    );
  }

  matches = uniqueEntriesByPath(matches);
  matches = matches.sort((a, b) => scopeRank(a) - scopeRank(b) || a.path.localeCompare(b.path));

  if (matches.length > 1) {
    const sameIdentity = matches.every((entry) =>
      entry.type === matches[0].type &&
      (entry.name ?? '').toLowerCase() === (matches[0].name ?? '').toLowerCase(),
    );
    if (sameIdentity && scopeRank(matches[0]) < scopeRank(matches[1])) {
      matches = [matches[0]];
    }
  }
  if (matches.length > 1 && types.includes('skill')) {
    const frameworkSkillMatches = matches.filter(e => isFrameworkSourceSkillPath(e.path));
    if (frameworkSkillMatches.length === 1) matches = frameworkSkillMatches;
  }
  if (matches.length > 1 && types.includes('skill')) {
    const sourceSkillMatches = matches.filter(e => isCanonicalSourceSkillPath(e.path));
    if (sourceSkillMatches.length === 1) matches = sourceSkillMatches;
  }
  if (matches.length > 1 && types.includes('agent')) {
    const canonicalSourceMatches = matches.filter(e => isCanonicalSourceAgentPath(e.path));
    if (canonicalSourceMatches.length === 1) matches = canonicalSourceMatches;
  }
  if (matches.length > 1 && types.includes('agent')) {
    const canonicalBundleMatches = matches.filter(e => isCanonicalBundleAgentPath(e.path));
    const canonicalBundlePaths = uniqueEntriesByPath(canonicalBundleMatches);
    if (canonicalBundlePaths.length === 1) matches = canonicalBundlePaths;
  }
  if (matches.length > 1 && types.includes('agent')) {
    const nonPersonaMatches = matches.filter(e => !isTopLevelPersonaAgentPath(e.path));
    if (nonPersonaMatches.length === 1) matches = nonPersonaMatches;
  }
  return matches;
}


/** Preselect exact candidates once; the canonical resolver still owns precedence and ambiguity. */
export function createRuleBindingTargetResolver(entries: MetadataEntry[], options: BindingTargetIdentityOptions = {}): (
  type: 'skill' | 'agent' | 'flow', id: string, bundleRoot?: string,
) => MetadataEntry {
  const candidates = new Map<string, MetadataEntry[]>();
  for (const entry of entries) {
    if (!['skill', 'agent', 'flow'].includes(entry.type)) continue;
    const normalized = normalizeIndexedPath(entry.path);
    const basename = path.posix.basename(normalized);
    const slug = /^(?:SKILL|AGENT|FLOW)\.md$/i.test(basename)
      ? path.posix.basename(path.posix.dirname(normalized))
      : basename.replace(/\.[^.]+$/, '');
    for (const id of new Set([entry.name, discoveryIdForEntry(entry), slug])) {
      if (typeof id !== 'string') continue;
      const key = `${entry.type}\0${id}`;
      const selected = candidates.get(key) ?? [];
      selected.push(entry);
      candidates.set(key, selected);
    }
  }
  return (type, id, bundleRoot = options.bundleRoot) => resolveRuleBindingTarget(candidates.get(`${type}\0${id}`) ?? [], type, id, { ...options, bundleRoot });
}


/** Resolve exact rule binding IDs using the same precedence and ambiguity as show.
 * Canonical layout slugs remain valid when frontmatter names are display names.
 * Titles and filesystem paths are deliberately excluded (#2938).
 */
export function resolveRuleBindingTarget(
  entries: MetadataEntry[], type: 'skill' | 'agent' | 'flow', id: string, options: BindingTargetIdentityOptions = {},
): MetadataEntry {
  const exact = entries.filter(entry => {
    if (entry.type !== type) return false;
    const normalized = normalizeIndexedPath(entry.path);
    const basename = path.posix.basename(normalized);
    const slug = /^(?:SKILL|AGENT|FLOW)\.md$/i.test(basename)
      ? path.posix.basename(path.posix.dirname(normalized))
      : basename.replace(/\.[^.]+$/, '');
    return entry.name === id || discoveryIdForEntry(entry) === id || slug === id;
  });
  const matches = preferCanonicalBindingTargets(findShowMatches(selectBindingTargetIdentities(exact, options), [type], id));
  if (matches.length === 0) throw new Error(`Missing ${type} binding target: ${id}`);
  if (matches.length > 1) throw new Error(`Ambiguous ${type} binding target: ${id}: ${matches.map(entry => entry.path).join(', ')}`);
  return matches[0];
}


export function isTopLevelPersonaAgentPath(entryPath: string): boolean {
  return /(^|[/\\])agentic[/\\]code[/\\]agents[/\\]personas[/\\][^/\\]+\.md$/.test(entryPath);
}


export function isCanonicalBundleAgentPath(entryPath: string): boolean {
  return /(^|[/\\])agentic[/\\]code[/\\](?:frameworks|addons|extensions|plugins)[/\\][^/\\]+[/\\]agents[/\\][^/\\]+\.md$/.test(entryPath);
}


export function isCanonicalSourceAgentPath(entryPath: string): boolean {
  return /(^|[/\\])agentic[/\\]code[/\\](?:frameworks|addons|extensions)[/\\][^/\\]+[/\\]agents[/\\][^/\\]+\.md$/.test(entryPath);
}


export function isFrameworkSourceSkillPath(entryPath: string): boolean {
  return /(^|[/\\])agentic[/\\]code[/\\]frameworks[/\\][^/\\]+[/\\]skills[/\\][^/\\]+[/\\]SKILL\.md$/.test(entryPath);
}


export function isCanonicalSourceSkillPath(entryPath: string): boolean {
  return /(^|[/\\])agentic[/\\]code[/\\](?:frameworks|addons|extensions)[/\\][^/\\]+[/\\]skills[/\\][^/\\]+[/\\]SKILL\.md$/.test(entryPath);
}


export function uniqueEntriesByPath(entries: MetadataEntry[]): MetadataEntry[] {
  const seen = new Set<string>();
  const unique: MetadataEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    unique.push(entry);
  }
  return unique;
}
