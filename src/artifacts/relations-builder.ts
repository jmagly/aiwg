/** Framework build projection. Kept separate so lookup processes import only relations.ts. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { INDEX_EXTRACTOR_VERSION, type MetadataEntry } from './types.js';
import { recordTypeForEntry, stableRecordId } from './browser-export.js';
import { resolveRuleBindingTarget } from './query-engine.js';
import { Minimatch } from 'minimatch';
import { FRAMEWORK_RELATIONS_REVISION } from './framework-source-digest.js';
import { writeIndexFile } from './index-reader.js';
import { createDependencyResolver } from './index-dependencies.js';
import {
  RELATIONS_SCHEMA, RELATIONS_VERSION, RULE_TIERS, emptyRuleStats,
  type RelationsIndex, type RelationTargetType, type RuleStats,
} from './relations.js';

const TARGET_TYPES = new Set(['skill', 'agent', 'flow', 'command']);
const BINDING_TYPES = { skills: 'skill', agents: 'agent', flows: 'flow' } as const;
export function relationId(entry: MetadataEntry): string {
  return stableRecordId(recordTypeForEntry(entry, 'v2'), entry.path);
}

function slug(entry: MetadataEntry): string {
  const normalized = entry.path.replace(/\\/g, '/');
  const file = path.posix.basename(normalized);
  return /^(SKILL|AGENT|FLOW|COMMAND|RULE|BEHAVIOR)\.md$/i.test(file)
    ? path.posix.basename(path.posix.dirname(normalized)) : file.replace(/\.[^.]+$/, '');
}

/** Same source bundle boundary as the framework graph (nested extensions retain their owner). */
function owner(entry: MetadataEntry): { id: string; kind: 'framework' | 'addon' | 'extension' } | null {
  const match = entry.path.replace(/\\/g, '/').match(/(?:^|\/)agentic\/code\/(frameworks|addons|extensions)\/([^/]+)\//);
  if (!match) return null; // Top-level behaviors are unowned, not fabricated bundles.
  const kind = ({ frameworks: 'framework', addons: 'addon', extensions: 'extension' } as const)[match[1] as 'frameworks' | 'addons' | 'extensions'];
  return { id: `${kind}:${match[2]}`, kind };
}

/** Only rule/action/template sources affect this projection; no file rereads. */
export function relationsFingerprint(entries: MetadataEntry[]): RelationsIndex['fingerprint'] {
  const sources = entries.filter(entry => TARGET_TYPES.has(entry.type) || ['rule', 'behavior', 'template'].includes(entry.type))
    .map(entry => [entry.path, entry.checksum]).sort((a, b) => a[0].localeCompare(b[0]));
  return { version: RELATIONS_VERSION, sources: `sha256:${createHash('sha256').update(JSON.stringify({ projectionVersion: FRAMEWORK_RELATIONS_REVISION, extractorVersion: INDEX_EXTRACTOR_VERSION, sources })).digest('hex')}` };
}

function statsFor(ids: string[], index: RelationsIndex): RuleStats {
  const stats = emptyRuleStats();
  for (const id of ids) {
    const rule = index.rules[id];
    const enforcement = rule.enforcement ?? 'unknown';
    const activation = rule.activation ?? 'unknown';
    stats.by_enforcement[enforcement] = (stats.by_enforcement[enforcement] ?? 0) + 1;
    stats.by_activation[activation] = (stats.by_activation[activation] ?? 0) + 1;
    if (enforcement === 'critical' || enforcement === 'high') stats.required_checks++;
  }
  return stats;
}

export function buildRelations(entries: MetadataEntry[]): RelationsIndex {
  const index: RelationsIndex = {
    $schema: RELATIONS_SCHEMA, version: RELATIONS_VERSION, generatedAt: '1970-01-01T00:00:00.000Z',
    fingerprint: relationsFingerprint(entries), artifacts: {}, rules: {}, templates: {}, targets: {}, capabilities: {}, aliases: { targets: {}, rules: {}, templates: {} },
  };
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!TARGET_TYPES.has(entry.type) && !['rule', 'behavior', 'template'].includes(entry.type)) continue;
    const { path: sourcePath, type, name, title, kernel, script, governedPaths } = entry;
    index.artifacts![relationId(entry)] = { path: sourcePath, type, title, ...(name ? { name } : {}), ...(kernel ? { kernel } : {}), ...(script ? { script } : {}), ...(governedPaths ? { governedPaths } : {}) };
  }
  const rules = entries.filter(entry => entry.type === 'rule' || entry.type === 'behavior')
    .sort((a, b) => (a.name ?? a.path).localeCompare(b.name ?? b.path) || a.path.localeCompare(b.path));
  const targets = entries.filter(entry => TARGET_TYPES.has(entry.type)).sort((a, b) => a.path.localeCompare(b.path));
  for (const rule of rules) {
    const id = relationId(rule);
    const capability = owner(rule);
    index.rules[id] = {
      name: rule.name ?? slug(rule), path: rule.path, type: rule.type as 'rule' | 'behavior',
      activation: rule.activation ?? null, enforcement: rule.ruleEnforcement ?? null,
      precedence: rule.rulePrecedence ?? 'medium', overridable: rule.ruleOverridable ?? true,
      summary: rule.ruleSummary ?? '', capability: capability?.id ?? null,
      ...(rule.rulePaths ? { paths: rule.rulePaths } : {}),
      ...(rule.triggers?.length ? { triggers: rule.triggers } : {}),
      ...(rule.bound_to ? { bound_to: rule.bound_to } : {}), targets: [],
    };
    for (const alias of new Set([rule.name, slug(rule), rule.path].filter((value): value is string => !!value))) {
      (index.aliases.rules[alias] ??= []).push(id);
    }
    if (capability) {
      const owned = index.capabilities[capability.id] ??= {
        kind: capability.kind, rules_by_tier: { critical: [], high: [], medium: [], low: [] },
      };
      const tier = RULE_TIERS.find(tier => tier === rule.ruleEnforcement);
      if (tier) owned.rules_by_tier[tier].push(id);
    }
  }
  const compiled = rules.map(rule => ({ rule, bindings: Object.fromEntries(
    Object.entries(rule.bound_to ?? {}).map(([key, patterns]) => [key, patterns.map(pattern =>
      ({ pattern, matcher: new Minimatch(pattern, { nonegate: true, nocomment: true }) }))]),
  ) as Record<string, Array<{ pattern: string; matcher: Minimatch }>> }));
  const aliases = new Map<string, { type: string; alias: string; entries: MetadataEntry[] }>();
  for (const target of targets) for (const alias of new Set([target.name, slug(target), relationId(target)].filter((value): value is string => !!value))) {
    const key = `${target.type}:${alias}`;
    const group = aliases.get(key) ?? { type: target.type, alias, entries: [] };
    group.entries.push(target);
    aliases.set(key, group);
  }
  for (const target of targets) {
    const key = `${target.type}:${relationId(target)}`;
    // Preserve show's tolerant alias/glob matching, including behavior contracts.
    const normalized = target.path.replace(/\\/g, '/');
    const file = path.posix.basename(normalized);
    const showAliases = [target.name, target.title, target.path, relationId(target),
      file === 'SKILL.md' ? path.posix.basename(path.posix.dirname(normalized)) : file.replace(/\.[^.]+$/, '')]
      .filter((value): value is string => !!value);
    const binding = Object.entries(BINDING_TYPES).find(([, type]) => type === target.type)?.[0];
    const bound = binding ? compiled.filter(({ bindings }) => bindings[binding]?.some(({ pattern, matcher }) =>
      showAliases.some(alias => alias === pattern || matcher.match(alias)))).map(({ rule }) => relationId(rule)) : [];
    index.targets[key] = { name: target.name ?? slug(target), path: target.path,
      rules: bound, rule_stats: emptyRuleStats() };
  }

  // Forward edges deliberately use deploy's strict canonical-ID resolver. Do not
  // turn stale/misspelled/ambiguous bindings into silently missing contracts.
  const resolved = new Map<string, MetadataEntry>();
  for (const rule of rules) {
    const edges = new Map<string, { type: RelationTargetType; id: string }>();
    for (const [binding, type] of Object.entries(BINDING_TYPES)) {
      for (const alias of rule.bound_to?.[binding as keyof typeof BINDING_TYPES] ?? []) {
        const key = `${type}:${alias}`;
        let target = resolved.get(key);
        if (!target) {
          target = resolveRuleBindingTarget(aliases.get(key)?.entries ?? [], type, alias);
          resolved.set(key, target);
        }
        const id = relationId(target);
        edges.set(`${type}:${id}`, { type, id });
        if (type === 'flow') {
          // A provider may wrap this flow as a skill, or share an authored skill's
          // body. Keep a distinct projection identity so show parity is preserved.
          const projectedId = `projected:${id}`;
          const projectedKey = `skill:${projectedId}`;
          index.targets[projectedKey] ??= { ...index.targets[`flow:${id}`],
            rules: [...index.targets[`flow:${id}`].rules], projected_from: { type: 'flow', id } };
          edges.set(projectedKey, { type: 'skill', id: projectedId });
        }
      }
    }
    index.rules[relationId(rule)].targets = [...edges.values()].sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
  }

  // Resolve each accepted spelling once at build time, retaining ambiguities.
  for (const [key, group] of aliases) {
    let matches = group.entries;
    if (group.type !== 'command') {
      try { matches = [resolveRuleBindingTarget(group.entries, group.type as 'skill' | 'agent' | 'flow', group.alias)]; }
      catch { /* Preserve all candidates for an explicit ambiguity diagnostic. */ }
    }
    index.aliases.targets[key] = matches.map(entry => `${entry.type}:${relationId(entry)}`);
  }
  for (const [key, target] of Object.entries(index.targets)) {
    if (target.projected_from) index.aliases.targets[`skill:projected:${target.name}`] = [key];
    target.rule_stats = statsFor(target.rules, index);
  }
  addTemplateRelations(entries, index);
  return index;
}

/** Project resolved index dependencies, including Markdown-link reverse edges. */
function addTemplateRelations(entries: MetadataEntry[], index: RelationsIndex): void {
  const byPath = Object.fromEntries(entries.map(entry => [entry.path, entry]));
  const resolve = createDependencyResolver(byPath);
  const templates = entries.filter(entry => entry.type === 'template').sort((a, b) => a.path.localeCompare(b.path));
  const link = (component: MetadataEntry, template: MetadataEntry) => {
    if (!TARGET_TYPES.has(component.type)) return;
    const target = index.targets[`${component.type}:${relationId(component)}`];
    const id = relationId(template);
    const edges = target.templates ??= [];
    if (edges.includes(id)) return;
    edges.push(id);
    index.templates![id].used_by.push({ type: component.type as RelationTargetType, id: relationId(component) });
  };
  for (const template of templates) {
    const id = relationId(template);
    index.templates![id] = { name: template.name ?? slug(template), path: template.path, title: template.title, used_by: [] };
    for (const alias of new Set([template.name, slug(template), template.path].filter((value): value is string => !!value))) {
      (index.aliases.templates![alias] ??= []).push(id);
    }
  }
  for (const component of entries.filter(entry => TARGET_TYPES.has(entry.type))) {
    for (const dependency of component.dependencies ?? []) {
      const template = byPath[resolve(component.path, dependency) ?? ''];
      if (template?.type === 'template') link(component, template);
    }
  }
  for (const template of templates) for (const dependent of template.dependents ?? []) {
    if (byPath[dependent]) link(byPath[dependent], template);
  }
  for (const target of Object.values(index.targets)) {
    if (target.projected_from) target.templates = [...(index.targets[`${target.projected_from.type}:${target.projected_from.id}`].templates ?? [])];
    target.templates?.sort();
  }
  for (const template of Object.values(index.templates!)) template.used_by.sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
}

export async function writeRelations(entries: Record<string, MetadataEntry>, cwd: string, indexDir: string, force = false, existingDir = indexDir): Promise<void> {
  const values = Object.values(entries);
  const fingerprint = relationsFingerprint(values);
  try {
    const existing = JSON.parse(fs.readFileSync(path.join(existingDir, 'relations.json'), 'utf8')) as RelationsIndex;
    if (!force && existing.version === RELATIONS_VERSION && existing.$schema === RELATIONS_SCHEMA
      && existing.fingerprint.version === fingerprint.version && existing.fingerprint.sources === fingerprint.sources
      && existing.artifacts && existing.rules && existing.targets && existing.capabilities && existing.aliases?.targets && existing.aliases.rules) return;
  } catch { /* Missing, corrupt, and unsupported sidecars are regenerated. */ }
  writeIndexFile(cwd, 'relations.json', buildRelations(values), indexDir);
}
