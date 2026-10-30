// Resolve governing rules and shape bound-rule checks and summaries.
import { minimatch } from 'minimatch';
import * as path from 'node:path';
import { inferRuleActivation } from '../rules/activation.mjs';
import { parseFrontmatter } from './index-builder.js';
import { discoveryIdForEntry, normalizeIndexedPath } from './query-engine-entries.js';
import { type ShowParams } from './query-engine-options.js';
import { emptyRuleStats, type RelationsReader, type RelationTargetType, type RuleStats } from './relations.js';
import type { MetadataEntry } from './types.js';

/** Build an ephemeral reverse lookup from the already-loaded rule metadata. */
export function rulesBoundTo(entries: MetadataEntry[], target: MetadataEntry): MetadataEntry[] {
  const key = ({ skill: 'skills', agent: 'agents', flow: 'flows' } as const)[target.type as 'skill' | 'agent' | 'flow'];
  if (!key) return [];
  const file = path.basename(normalizeIndexedPath(target.path));
  const aliases = [target.name, target.title, target.path, discoveryIdForEntry(target),
    file === 'SKILL.md' ? path.basename(path.dirname(normalizeIndexedPath(target.path))) : file.replace(/\.[^.]+$/, '')]
    .filter((alias): alias is string => !!alias);
  const seen = new Set<string>();
  return entries.filter(rule => {
    if (rule.type !== 'rule' && rule.type !== 'behavior') return false;
    const patterns = rule.bound_to?.[key];
    if (!Array.isArray(patterns) || !patterns.some(pattern => typeof pattern === 'string'
      && aliases.some(alias => alias === pattern || minimatch(alias, pattern, { nonegate: true, nocomment: true })))) return false;
    const identity = `${rule.type}:${rule.path}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).sort((a, b) => (a.name ?? a.path).localeCompare(b.name ?? b.path) || a.path.localeCompare(b.path));
}


/** Relationship metadata for shipped targets, merged with project/user contracts. */
export function relationshipRules(entries: MetadataEntry[], target: MetadataEntry, relations?: RelationsReader): MetadataEntry[] {
  const local = rulesBoundTo(relations ? entries.filter(entry => !normalizeIndexedPath(entry.path).startsWith('agentic/code/')) : entries, target);
  if (!relations || !['skill', 'agent', 'flow', 'command'].includes(target.type)) return local;
  const asMetadata = (id: string): MetadataEntry => {
    const rule = relations.index.rules[id];
    return { path: rule.path, type: rule.type, name: rule.name, activation: rule.activation ?? undefined,
      bound_to: rule.bound_to, ruleSummary: rule.summary, ruleEnforcement: rule.enforcement ?? undefined, rulePaths: rule.paths, triggers: rule.triggers } as MetadataEntry;
  };
  const key = `${target.type}:${discoveryIdForEntry(target)}`;
  const shipped = Object.hasOwn(relations.index.targets, key)
    ? relations.rulesForTarget(target.type as RelationTargetType, discoveryIdForEntry(target)).map(asMetadata)
    // Project/user overrides keep the old alias/glob behavior using only small records.
    : rulesBoundTo(Object.keys(relations.index.rules).map(asMetadata), target);
  const merged = new Map([...local, ...shipped].map(rule => [`${rule.type}:${rule.path}`, rule]));
  return [...merged.values()].sort((a, b) => (a.name ?? a.path).localeCompare(b.name ?? b.path) || a.path.localeCompare(b.path));
}


export interface GoverningRule { rule: MetadataEntry; applicability: string[] }

export const RULE_CHECK_OBLIGATION = 'Before governed work, fetch and follow every required rule below; a discovery summary is not the full rule.';

export function relationMetadata(relations: RelationsReader): MetadataEntry[] {
  return Object.values(relations.index.rules).map(rule => ({ path: rule.path, type: rule.type, name: rule.name,
    activation: rule.activation ?? undefined, ruleSummary: rule.summary, ruleEnforcement: rule.enforcement ?? undefined,
    bound_to: rule.bound_to, rulePaths: rule.paths, triggers: rule.triggers } as MetadataEntry));
}

/** Post-ranking enrichment: relationship lookup never loads the full metadata index. */
export function compoundGoverningRules(entries: MetadataEntry[], target: MetadataEntry, relations?: RelationsReader,
  phrase = '', includeMatches = true, excludeKernel = true): GoverningRule[] {
  if (!['skill', 'agent', 'flow', 'command'].includes(target.type)) return [];
  const found = new Map<string, GoverningRule>();
  const add = (rule: MetadataEntry, why: string, binding = false) => {
    const pinned = relations?.pinnedRuleIds.has(discoveryIdForEntry(rule));
    const activation = rule.activation ?? (rule.type === 'behavior' ? 'kernel' : inferRuleActivation(rule.ruleEnforcement));
    // Delivery mode never removes an explicit contract; only ambient matches are filtered.
    if (!binding && excludeKernel && (activation === 'kernel' || activation === 'core' || rule.kernel || pinned)) return;
    const key = `${rule.type}:${rule.path}`, item = found.get(key) ?? {
      rule: pinned ? { ...rule, activation: 'kernel' } : rule, applicability: [],
    };
    if (!item.applicability.includes(why)) item.applicability.push(why);
    found.set(key, item);
  };
  for (const rule of relationshipRules(entries, target, relations)) add(rule, `bound:${target.type}:${discoveryIdForEntry(target)}`, true);
  if (relations && target.type === 'skill' && target.name?.startsWith('projected:')) {
    for (const id of relations.rulesForTarget('skill', target.name)) {
      const rule = relationMetadata(relations).find(rule => discoveryIdForEntry(rule) === id);
      if (rule) add(rule, `projected-flow:${target.name.slice('projected:'.length)}`, true);
    }
  }
  if (includeMatches) {
    const query = phrase.toLowerCase();
    const queryPaths = (phrase.replace(/\\/g, '/').match(/[\w@./*?-]+/g) ?? []).map(value => value.replace(/[.,;:!?]+$/, ''));
    const corpus = relations ? relationMetadata(relations) : [];
    const rules = new Map([...corpus, ...entries.filter(entry => ['rule', 'behavior'].includes(entry.type))]
      .map(rule => [`${rule.type}:${rule.path}`, rule]));
    for (const rule of rules.values()) {
      for (const glob of rule.rulePaths ?? []) for (const candidate of [...queryPaths.filter(value => /[./*?]/.test(value) || value === glob), ...(target.governedPaths ?? [])]) {
        if (minimatch(candidate, glob, { dot: true, nonegate: true, nocomment: true })
          || ((target.governedPaths ?? []).includes(candidate) && minimatch(glob, candidate, { dot: true, nonegate: true, nocomment: true }))) add(rule, `path:${candidate}`);
      }
      for (const trigger of rule.triggers ?? []) {
        const normalized = trigger.trim().toLowerCase();
        let offset = normalized ? query.indexOf(normalized) : -1;
        while (offset >= 0) {
          if ((offset === 0 || !/\w/.test(query[offset - 1]))
            && (offset + normalized.length === query.length || !/\w/.test(query[offset + normalized.length]))) {
            add(rule, `trigger:${trigger}`); break;
          }
          offset = query.indexOf(normalized, offset + 1);
        }
      }
    }
  }
  return [...found.values()].sort((a, b) => (a.rule.name ?? a.rule.path).localeCompare(b.rule.name ?? b.rule.path) || a.rule.path.localeCompare(b.rule.path));
}

export function boundRuleDescriptor(rule: MetadataEntry) {
  return { name: rule.name ?? path.basename(rule.path, '.md'), activation: rule.activation ?? null, enforcement: rule.ruleEnforcement ?? null,
    summary: (rule.ruleSummary ?? '').replace(/\s+/g, ' ').trim(), show_command: `aiwg show ${rule.type} ${rule.name ?? path.basename(rule.path, '.md')} --body` };
}

/** Counts unique attached contracts; every emitted check is required irrespective of severity. */
export function governingRuleStats(governing: GoverningRule[]): RuleStats {
  const stats = emptyRuleStats();
  for (const { rule } of new Map(governing.map(item => [`${item.rule.type}:${item.rule.path}`, item])).values()) {
    const enforcement = rule.ruleEnforcement?.toLowerCase() ?? 'unknown', activation = rule.activation ?? 'unknown';
    stats.by_enforcement[enforcement] = (stats.by_enforcement[enforcement] ?? 0) + 1;
    stats.by_activation[activation] = (stats.by_activation[activation] ?? 0) + 1;
    stats.required_checks++;
  }
  return stats;
}

export function governingRuleFields(governing: GoverningRule[]) {
  if (!governing.length) return {};
  return { bound_rules: governing.map(({ rule }) => boundRuleDescriptor(rule)), rule_stats: governingRuleStats(governing),
    required_rule_checks: governing.map(({ rule, applicability }) => ({ rule_id: discoveryIdForEntry(rule),
      applicability, fetch_command: `aiwg show ${rule.type} ${discoveryIdForEntry(rule)} --body` })), rule_check_obligation: RULE_CHECK_OBLIGATION };
}

export function statsText(stats: RuleStats): string {
  return `rules: ${Object.entries(stats.by_enforcement).map(([level, count]) => `${count} ${level}`).join(', ') || '0'} · activation: ${Object.entries(stats.by_activation).map(([mode, count]) => `${count} ${mode}`).join(', ') || 'none'} · ${stats.required_checks} required checks`;
}


export function relationshipRuleStats(entries: MetadataEntry[], target: MetadataEntry, relations: RelationsReader): RuleStats {
  const shipped = Object.hasOwn(relations.index.targets, `${target.type}:${discoveryIdForEntry(target)}`);
  const stats = shipped ? relations.ruleStats(target.type as RelationTargetType, discoveryIdForEntry(target)) : emptyRuleStats();
  // Shipped counts are precomputed; project/user contracts and overrides are overlays.
  const overlay = shipped ? rulesBoundTo(entries.filter(entry => !normalizeIndexedPath(entry.path).startsWith('agentic/code/')), target)
    : relationshipRules(entries, target, relations);
  for (const rule of overlay) {
    const enforcement = rule.ruleEnforcement ?? 'unknown';
    const activation = rule.activation ?? 'unknown';
    stats.by_enforcement[enforcement] = (stats.by_enforcement[enforcement] ?? 0) + 1;
    stats.by_activation[activation] = (stats.by_activation[activation] ?? 0) + 1;
    if (enforcement === 'critical' || enforcement === 'high') stats.required_checks++;
  }
  return stats;
}


export async function showBindings(
  entries: MetadataEntry[], target: MetadataEntry, content: string, params: ShowParams,
  read: (entry: MetadataEntry) => Promise<string>,
  relations?: RelationsReader,
): Promise<{ fields: Record<string, unknown>; text: string }> {
  const governing = compoundGoverningRules(entries, target, relations, '', false, false);
  const rules = governing.map(item => item.rule);
  const boundRules = await Promise.all(rules.map(async rule => ({
    ...boundRuleDescriptor(rule),
    ...((params.boundRuleBodies || params.withRuleBodies) ? { content: await read(rule) } : {}),
  })));
  // Parse the selected rule for reverse lookup, including corpus-only rules.
  const targets = target.type === 'rule' || target.type === 'behavior'
    ? parseFrontmatter(content).data.bound_to : undefined;
  const boundTo = targets && typeof targets === 'object' && !Array.isArray(targets)
    ? Object.fromEntries(['skills', 'agents', 'flows'].flatMap(key => {
        const values = (targets as Record<string, unknown>)[key];
        const names = Array.isArray(values) ? [...new Set(values.filter((value): value is string => typeof value === 'string' && !!value.trim()))] : [];
        return names.length ? [[key, names]] : [];
      })) : {};
  const boundTargets = new Map<string, { type: string; id: string; name?: string }>();
  if (target.type === 'rule' || target.type === 'behavior') {
    for (const edge of relations?.targetsForRule(discoveryIdForEntry(target)) ?? []) {
      boundTargets.set(`${edge.type}:${edge.id}`, { ...edge, name: relations?.index.artifacts?.[edge.id]?.name
        ?? relations?.index.targets[`${edge.type}:${edge.id}`]?.name });
    }
    const selectedRule = { ...target, bound_to: boundTo } as MetadataEntry;
    for (const candidate of entries) if (rulesBoundTo([selectedRule], candidate).length) {
      const id = discoveryIdForEntry(candidate);
      boundTargets.set(`${candidate.type}:${id}`, { type: candidate.type, id, name: candidate.name });
    }
  }
  let text = '';
  if (boundRules.length) {
    // Cards already print these stats in the header; body/section output has no header.
    const stats = params.body || params.sections?.length ? `${statsText(governingRuleStats(governing))}\n\n` : '';
    text += `\n## Bound rules\n\n${RULE_CHECK_OBLIGATION}\n\n${stats}` + boundRules.map(rule =>
      `- **${rule.name}** [${rule.activation ?? 'unknown'} / ${rule.enforcement ?? 'unknown'}]: ${rule.summary} (\`${rule.show_command}\`)`
      + ('content' in rule ? `\n\n${rule.content}` : '')).join('\n') + '\n';
  }
  if (Object.keys(boundTo).length) {
    text += '\n## Bound targets\n\n' + Object.entries(boundTo)
      .map(([key, names]) => `- ${key}: ${(names as string[]).map(name => `\`${name}\``).join(', ')}`).join('\n') + '\n';
  }
  if (boundTargets.size) text += '\nResolved targets: ' + [...boundTargets.values()].map(target => `${target.type} ${target.name ?? target.id}`).join(', ') + '\n';
  return { fields: {
    ...governingRuleFields(governing),
    ...(['rule', 'behavior'].includes(target.type) ? { bound_to: boundTo, bound_targets: [...boundTargets.values()] } : {}),
    ...(boundRules.length ? { bound_rules: boundRules } : {}),
    ...(Object.keys(boundTo).length ? { bound_to: boundTo } : {}),
  }, text };
}
