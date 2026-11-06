/** Small framework relationship reader. This module never reads metadata.json. */
import fs from 'node:fs';
import path from 'node:path';
import { getGraphIndexDir, type MetadataEntry } from './types.js';
import { resolveFrameworkCorpusRoot, resolveFrameworkIndexRoot } from './framework-index-paths.js';
import { frameworkSourceDigest } from './framework-source-digest.js';
import { createHash } from 'node:crypto';
import { loadRulePinConfigs, resolveRulePins } from '../rules/pins.mjs';

export const RELATIONS_VERSION = 1;
export const RELATIONS_SCHEMA = 'https://aiwg.io/schemas/artifacts/relations.v1.schema.json';
export const RULE_TIERS = ['critical', 'high', 'medium', 'low'] as const;
export type RuleTier = typeof RULE_TIERS[number];
export type RelationTargetType = 'skill' | 'agent' | 'flow' | 'command';
export interface RelationTarget { type: RelationTargetType; id: string }
export interface RuleStats {
  by_enforcement: Record<string, number>;
  by_activation: Record<string, number>;
  /** Number of CRITICAL/HIGH contracts; not a claim of mechanical enforcement. */
  required_checks: number;
}
export interface RelationRule {
  name: string;
  path: string;
  type: 'rule' | 'behavior';
  activation: string | null;
  enforcement: string | null;
  summary: string;
  capability: string | null;
  paths?: string[];
  triggers?: string[];
  targets: RelationTarget[];
  /** Original patterns support project/user overrides with distinct stable IDs. */
  bound_to?: MetadataEntry['bound_to'];
}
export interface RelationsIndex {
  $schema: string;
  version: number;
  generatedAt: string;
  fingerprint: { version: number; sources: string };
  rules: Record<string, RelationRule>;
  /** Template nodes with reverse uses-template edges; optional in older v1 tables. */
  templates?: Record<string, { name: string; path: string; title: string; used_by: RelationTarget[] }>;
  targets: Record<string, {
    name: string;
    path: string;
    rules: string[];
    rule_stats: RuleStats;
    templates?: string[];
    projected_from?: RelationTarget;
  }>;
  capabilities: Record<string, { kind: 'framework' | 'addon' | 'extension'; rules_by_tier: Record<RuleTier, string[]> }>;
  /** Pre-resolved aliases retain ambiguity rather than choosing an arbitrary artifact. */
  artifacts?: Record<string, Pick<MetadataEntry, 'path' | 'type' | 'name' | 'title' | 'kernel' | 'script' | 'governedPaths'>>;
  aliases: { targets: Record<string, string[]>; rules: Record<string, string[]>; templates?: Record<string, string[]> };
}

export function emptyRuleStats(): RuleStats {
  return { by_enforcement: {}, by_activation: {}, required_checks: 0 };
}

function lookupAlias(aliases: Record<string, string[]>, id: string): string | undefined {
  const matches = aliases[id];
  if (matches?.length > 1) throw new Error(`Ambiguous relationship ID: ${id}: ${matches.join(', ')}`);
  return matches?.[0];
}

export class RelationsReader {
  constructor(readonly index: RelationsIndex, readonly pinnedRuleIds: ReadonlySet<string> = new Set()) {}

  templatesForTarget(type: RelationTargetType, id: string): string[] {
    const key = `${type}:${id}`;
    const resolved = Object.hasOwn(this.index.targets, key) ? key : lookupAlias(this.index.aliases.targets, key);
    return [...(resolved ? this.index.targets[resolved]?.templates ?? [] : [])];
  }

  targetsForTemplate(id: string): RelationTarget[] {
    const resolved = Object.hasOwn(this.index.templates ?? {}, id) ? id : lookupAlias(this.index.aliases.templates ?? {}, id);
    return resolved ? (this.index.templates?.[resolved]?.used_by ?? []).map(target => ({ ...target })) : [];
  }

  rulesForTarget(type: RelationTargetType, id: string): string[] {
    const key = `${type}:${id}`;
    const resolved = Object.hasOwn(this.index.targets, key) ? key : lookupAlias(this.index.aliases.targets, key);
    return [...(resolved ? this.index.targets[resolved]?.rules ?? [] : [])];
  }

  targetsForRule(id: string): RelationTarget[] {
    const resolved = Object.hasOwn(this.index.rules, id) ? id : lookupAlias(this.index.aliases.rules, id);
    return resolved ? (this.index.rules[resolved]?.targets ?? []).map(target => ({ ...target })) : [];
  }

  rulesForCapability(id: string, tiers: readonly RuleTier[] = RULE_TIERS): string[] {
    const capability = this.index.capabilities[id];
    return [...new Set(tiers.flatMap(tier => capability?.rules_by_tier[tier] ?? []))];
  }

  ruleStats(type: RelationTargetType, id: string): RuleStats {
    const key = `${type}:${id}`;
    const resolved = Object.hasOwn(this.index.targets, key) ? key : lookupAlias(this.index.aliases.targets, key);
    const stats = resolved ? this.index.targets[resolved]?.rule_stats : undefined;
    if (!stats) return emptyRuleStats();
    const result = { by_enforcement: { ...stats.by_enforcement }, by_activation: { ...stats.by_activation }, required_checks: stats.required_checks };
    for (const ruleId of this.index.targets[resolved!].rules) {
      if (!this.pinnedRuleIds.has(ruleId)) continue;
      const activation = this.index.rules[ruleId]?.activation ?? 'unknown';
      if (activation === 'kernel') continue;
      result.by_activation[activation] = Math.max(0, (result.by_activation[activation] ?? 0) - 1);
      if (!result.by_activation[activation]) delete result.by_activation[activation];
      result.by_activation.kernel = (result.by_activation.kernel ?? 0) + 1;
    }
    return result;
  }
}

function readerWithPins(index: RelationsIndex, pinCwd: string): RelationsReader {
  const pins = resolveRulePins({ configs: loadRulePinConfigs(pinCwd),
    rules: Object.entries(index.rules).map(([id, rule]) => ({ ...rule, id })) });
  return new RelationsReader(index, new Set(pins.rules.map(rule => rule.id)));
}

/** Missing, corrupt, or unsupported sidecars return null; invalid pin policy remains an explicit error. */
export function loadBuiltRelations(cwd: string, pinCwd = cwd): RelationsReader | null {
  let index: RelationsIndex;
  try {
    index = JSON.parse(fs.readFileSync(path.join(getGraphIndexDir(cwd, 'framework'), 'relations.json'), 'utf8')) as RelationsIndex;
    if (index.version !== RELATIONS_VERSION || index.$schema !== RELATIONS_SCHEMA
      || index.fingerprint?.version !== RELATIONS_VERSION || !/^sha256:[a-f0-9]{64}$/.test(index.fingerprint.sources)
      || !index.rules || !index.targets || !index.capabilities || !index.aliases?.targets || !index.aliases.rules) return null;
  } catch { return null; }
  return readerWithPins(index, pinCwd);
}

export const PREBUILT_RELATIONS_DIR = 'prebuilt/framework-relations';
export interface RelationsStamp {
  schema_version: 'aiwg.relationships.prebuilt.v1';
  package_version: string;
  source_digest: string;
  generated_at: string;
  checksums: { 'relations.json': string; 'bindings.json': string };
}
export interface PrebuiltSelection { reader: RelationsReader | null; reason?: string; sourceDigest?: string }

/** Validate the running root, never the root from which this module was loaded. */
function selectPrebuiltRelationsSource(cwd: string, cacheSourceDigest = true): PrebuiltSelection {
  const root = resolveFrameworkIndexRoot(cwd);
  const dir = path.join(root, PREBUILT_RELATIONS_DIR);
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as RelationsStamp;
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (stamp.schema_version !== 'aiwg.relationships.prebuilt.v1') return { reader: null, reason: 'unsupported prebuilt relationship schema' };
    if (stamp.package_version !== pkg.version) return { reader: null, reason: 'prebuilt relationship package version differs' };
    const sourceDigest = frameworkSourceDigest(root, cacheSourceDigest);
    if (stamp.source_digest !== sourceDigest) return { reader: null, sourceDigest, reason: 'prebuilt relationship source digest differs (modified, added or removed corpus source)' };
    const text = fs.readFileSync(path.join(dir, 'relations.json'), 'utf8');
    if (createHash('sha256').update(text).digest('hex') !== stamp.checksums['relations.json']) return { reader: null, reason: 'prebuilt relationship checksum differs' };
    const bindings = fs.readFileSync(path.join(dir, 'bindings.json'), 'utf8');
    if (createHash('sha256').update(bindings).digest('hex') !== stamp.checksums['bindings.json']) return { reader: null, reason: 'prebuilt binding checksum differs' };
    const index = JSON.parse(text) as RelationsIndex;
    if (index.version !== RELATIONS_VERSION || index.$schema !== RELATIONS_SCHEMA || !index.artifacts
      || index.fingerprint?.version !== RELATIONS_VERSION || !/^sha256:[a-f0-9]{64}$/.test(index.fingerprint.sources)
      || !index.rules || !index.targets || !index.capabilities || !index.aliases?.targets || !index.aliases.rules) return { reader: null, reason: 'unsupported prebuilt relationship table' };
    return { reader: new RelationsReader(index), sourceDigest };
  } catch { return { reader: null, reason: 'prebuilt relationship tables unavailable or corrupt' }; }
}

/** Apply local pins only after cache validation so policy errors cannot masquerade as cache misses. */
export function selectPrebuiltRelations(cwd: string, pinCwd = cwd, cacheSourceDigest = true): PrebuiltSelection {
  const selected = selectPrebuiltRelationsSource(cwd, cacheSourceDigest);
  return selected.reader ? { ...selected, reader: readerWithPins(selected.reader.index, pinCwd) } : selected;
}

/** Synchronous read API: prebuilt first, then this root's built sidecar. */
export function loadRelations(cwd: string, pinCwd = cwd, cacheSourceDigest = true): RelationsReader | null {
  return selectPrebuiltRelations(cwd, pinCwd, cacheSourceDigest).reader ?? loadBuiltRelations(cwd, pinCwd);
}

/** Read paths reconcile through the existing lock/receipt when prebuilt is stale. */
export async function ensureRelations(cwd: string, pinCwd = cwd, options: { verbose?: boolean; selection?: PrebuiltSelection; reconciled?: boolean } = {}): Promise<RelationsReader | null> {
  const selected = options.selection ?? selectPrebuiltRelations(cwd, pinCwd);
  if (selected.reader) return selected.reader;
  const root = resolveFrameworkIndexRoot(cwd);
  if ((options.verbose || process.argv.includes('--verbose') || process.argv.includes('--debug')
    || ['debug', 'info'].includes(process.env.AIWG_LOG_LEVEL ?? ''))
    && fs.existsSync(path.join(root, PREBUILT_RELATIONS_DIR, 'manifest.json'))) {
    console.error(`Relationship tables: ${selected.reason}; using the per-root index (rebuilding if stale).`);
  }
  const { refreshFrameworkCapabilities } = await import('./framework-capabilities.js');
  if (!options.reconciled) await refreshFrameworkCapabilities(root, false);
  const reader = loadBuiltRelations(cwd, pinCwd);
  if (!reader && (resolveFrameworkCorpusRoot(root) || fs.existsSync(path.join(root, PREBUILT_RELATIONS_DIR, 'manifest.json')))) throw new Error('Relationship tables unavailable: no usable prebuilt or per-root index. Run `aiwg index build --graph framework`.');
  return reader;
}

// Convenience entry points; use one loaded reader for a batch of lookups.
export function rulesForTarget(type: RelationTargetType, id: string, cwd = process.cwd()): string[] {
  return loadRelations(cwd)?.rulesForTarget(type, id) ?? [];
}
export function targetsForRule(id: string, cwd = process.cwd()): RelationTarget[] {
  return loadRelations(cwd)?.targetsForRule(id) ?? [];
}
export function rulesForCapability(id: string, tiers?: readonly RuleTier[], cwd = process.cwd()): string[] {
  return loadRelations(cwd)?.rulesForCapability(id, tiers) ?? [];
}
export function ruleStats(type: RelationTargetType, id: string, cwd = process.cwd()): RuleStats {
  return loadRelations(cwd)?.ruleStats(type, id) ?? emptyRuleStats();
}
