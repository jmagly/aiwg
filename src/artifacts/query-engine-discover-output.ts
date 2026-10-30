// Shape capability discovery diagnostics, rule checks, and CLI output.
import * as path from 'node:path';
import type { ResourceSource, VerifiedWebRelease } from '../resources/web-release.js';
import { diagnoseFacetActivations, type FacetScoreDiagnostic } from './discover-facets.js';
import {
  buildRunHint,
  DISCOVER_TYPE_ORDER,
  discoveryIdForEntry,
  normalizeIndexedPath,
  type ProvenancedEntry,
  scopeRank,
  showHintForDiscoverResult,
} from './query-engine-entries.js';
import { type DiscoverParams } from './query-engine-options.js';
import {
  boundRuleDescriptor,
  compoundGoverningRules,
  type GoverningRule,
  governingRuleFields,
  governingRuleStats,
  RULE_CHECK_OBLIGATION,
  statsText,
} from './query-engine-rules.js';
import { type LexicalScoreDiagnostic, tokenize } from './query-engine-scoring.js';
import { ensureRelations, type RelationsReader, type RelationTargetType } from './relations.js';
import type { MetadataEntry, QueryResult } from './types.js';

export interface DiscoverOutputContext {
  cwd: string;
  params: DiscoverParams;
  types: string[];
  limit: number;
  aiwgRoot: string | null;
  entries: MetadataEntry[];
  backend: 'local' | 'fortemi-core';
  resourceSource: ResourceSource;
  resolvedWebRelease?: VerifiedWebRelease;
  prebuiltRelations: RelationsReader | null;
  scored: Array<QueryResult & { facetDiagnostics?: FacetScoreDiagnostic[] }>;
  relaxed: boolean;
  queryTimeMs: number;
  lexicalDiagnostics: Map<string, LexicalScoreDiagnostic>;
}

export async function emitDiscoverResults(context: DiscoverOutputContext): Promise<void> {
  const { cwd, params, types, limit, aiwgRoot, entries, backend, resourceSource,
    resolvedWebRelease, prebuiltRelations, scored, relaxed, queryTimeMs, lexicalDiagnostics } = context;
  /**
   * Resolve a stored framework-graph path to an absolute AIWG_ROOT
   * path (#1217). Framework-graph entries are stored as paths relative
   * to the AIWG repo root (e.g. `agentic/code/frameworks/.../SKILL.md`);
   * anchoring them to `AIWG_ROOT` makes them readable from any project
   * working directory.
   *
   * Kernel skills are anchored the same way (#1230) — `aiwg show` reads
   * the source corpus, not platform deploy mirrors, so kernel entries
   * need the same `AIWG_ROOT` anchoring as non-kernel framework entries.
   * Non-framework entries (project / codebase graphs) keep their stored
   * paths unchanged.
   */
  function resolvePath(entry: MetadataEntry): string {
    const normalizedPath = normalizeIndexedPath(entry.path);
    if (!aiwgRoot) return normalizedPath;
    if (path.isAbsolute(entry.path)) return entry.path;
    if (normalizedPath.startsWith('agentic/code/')) return path.join(aiwgRoot, normalizedPath);
    return normalizedPath;
  }

  // Build a hint string when the index has entries but no scored matches —
  // this is the second silent-failure mode #1221 calls out. When the workspace
  // has project-local content (.aiwg/{extensions,addons,frameworks,plugins,providers}/)
  // surface a project-graph rebuild hint (#1235).
  // discover-appropriate hint (#1545): never push index/graph mechanics. If
  // nothing scored, the phrase didn't match an indexed capability — suggest a
  // broader phrase / type filter, and a capability refresh via `aiwg use`.
  const emptyResultHint = scored.length === 0
    ? backend === 'fortemi-core'
      ? `No capability matched "${params.phrase}" among ${entries.length} Fortemi Core static-cache capabilities. Try a broader phrase or a \`--type\` filter. If the local index changed, refresh the cache with \`aiwg index sync ${params.graph ? `--graph ${params.graph}` : '--all'}\`, or pass \`--backend local\` to use the legacy local index.`
      : `No capability matched "${params.phrase}" among ${entries.length} indexed capabilities. Try a broader phrase or a \`--type\` filter. If you just installed or authored capabilities, refresh discovery with \`aiwg use <framework>\` (or \`aiwg index build\`).`
    : null;

  const relations = resourceSource === 'local' && (!params.graph || params.graph === 'framework')
    ? prebuiltRelations ?? await ensureRelations(cwd) : undefined;
  const governing = scored.map(result => compoundGoverningRules(entries, result.entry, relations ?? undefined, params.phrase));
  const responseRules = new Map<string, GoverningRule>();
  for (const item of governing.flat()) {
    const key = `${item.rule.type}:${item.rule.path}`, prior = responseRules.get(key);
    responseRules.set(key, { rule: item.rule, applicability: [...new Set([...(prior?.applicability ?? []), ...item.applicability])] });
  }
  const responseFields = governingRuleFields([...responseRules.values()]);
  const responseRuleStats = governingRuleStats([...responseRules.values()]);
  const includePaths = params.includePaths ?? true;
  const facetActivations = diagnoseFacetActivations(params.phrase);
  const roundDiagnostic = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;
  const rankingDiagnostic = (
    entry: MetadataEntry,
    finalScore: number,
    facetDiagnostics: FacetScoreDiagnostic[] | undefined,
  ) => {
    const lexical = lexicalDiagnostics.get(entry.path) ?? {
      content_tokens: tokenize(params.phrase),
      raw_score: 0,
      score: 0,
      score_cap_applied: false,
      matches: [],
    };
    const scope = (entry as ProvenancedEntry).indexScope ?? 'unknown';
    return {
      lexical_score: roundDiagnostic(lexical.score),
      lexical_raw_score: roundDiagnostic(lexical.raw_score),
      final_score: roundDiagnostic(finalScore),
      score_cap_applied: lexical.score_cap_applied,
      matches: lexical.matches.map((match) => ({
        ...match,
        contribution: roundDiagnostic(match.contribution),
        ...(match.query_token_coverage === undefined
          ? {}
          : { query_token_coverage: roundDiagnostic(match.query_token_coverage) }),
      })),
      facets: (facetDiagnostics ?? []).map((facet) => ({
        ...facet,
        activation_floor: roundDiagnostic(facet.activation_floor),
        base_score: roundDiagnostic(facet.base_score),
        rrf_tiebreak: roundDiagnostic(facet.rrf_tiebreak),
      })),
      tie_breakers: {
        scope,
        scope_rank: scopeRank(entry),
        type_rank: DISCOVER_TYPE_ORDER.get(entry.type) ?? 99,
      },
    };
  };

  const { loadRelations } = await import('./relations.js');
  const ruleRelations = resourceSource === 'local' ? loadRelations(cwd) ?? (aiwgRoot ? loadRelations(aiwgRoot, cwd) : null) : null;
  if (params.json) {
    const jsonIndent = params.jsonPretty === false ? undefined : 2;
    console.log(JSON.stringify({
      query: {
        phrase: params.phrase,
        types,
        limit,
        aiwg_root: aiwgRoot ?? null,
        backend,
        graph: backend === 'fortemi-core'
          ? resourceSource === 'web' ? 'framework' : params.graph ?? 'capability-default'
          : params.graph,
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
      results: scored.map((r, resultIndex) => ({
        id: discoveryIdForEntry(r.entry),
        ...(includePaths ? { path: resolvePath(r.entry) } : {}),
        type: r.entry.type,
        name: r.entry.name,
        title: r.entry.title,
        score: Math.round(r.score * 100) / 100,
        ranking: rankingDiagnostic(r.entry, r.score, r.facetDiagnostics),
        ...governingRuleFields(governing[resultIndex]),
        triggers: r.entry.triggers ?? [],
        capability: r.entry.capability ?? r.entry.summary,
        kernel: r.entry.kernel ?? false,
        ...(['skill', 'agent', 'flow', 'command'].includes(r.entry.type) && ruleRelations
          && ruleRelations.rulesForTarget(r.entry.type as RelationTargetType, discoveryIdForEntry(r.entry)).length ? {
          startup_rule_stats: ruleRelations.ruleStats(r.entry.type as 'skill' | 'agent' | 'flow' | 'command', discoveryIdForEntry(r.entry)),
        } : {}),
        provenance: {
          graph: (r.entry as ProvenancedEntry).indexGraph ?? null,
          scope: (r.entry as ProvenancedEntry).indexScope ?? null,
        },
        // #1227 — surface script-bearing skills so agents know to use
        // `aiwg run skill <name>` instead of executing instructions
        // themselves.
        ...(r.entry.script
          ? {
              executable: true,
              run_hint: buildRunHint(r.entry),
            }
          : {}),
      })),
      rule_stats: responseRuleStats,
      ...(responseFields.required_rule_checks ? { required_rule_checks: responseFields.required_rule_checks, rule_check_obligation: RULE_CHECK_OBLIGATION } : {}),
      total: scored.length,
      query_time_ms: queryTimeMs,
      diagnostics: {
        content_tokens: tokenize(params.phrase),
        facet_activations: facetActivations,
        score_tie_break_order: ['score', 'scope', 'type', 'name', 'path'],
      },
      ...(relaxed ? { relaxed_overlap: true } : {}),
      ...(emptyResultHint ? { hint: emptyResultHint } : {}),
    }, null, jsonIndent));
    return;
  }

  if (scored.length === 0) {
    console.log(`No discovery matches for "${params.phrase}" in types: ${types.join(',')}.`);
    console.log(backend === 'fortemi-core'
      ? emptyResultHint
      : 'Try a broader phrase or a `--type` filter. If capabilities were just added, refresh with `aiwg use <framework>` (or `aiwg index build`).');
    return;
  }

  const relaxedNote = relaxed ? ' — relaxed match (verbose query)' : '';
  console.log(`Discovery results for "${params.phrase}" (${scored.length} matches, ${queryTimeMs}ms)${relaxedNote}:`);
  console.log(statsText(responseRuleStats));
  console.log('');
  for (const diagnostic of facetActivations) {
    if (diagnostic.status === 'suppressed' && diagnostic.reason) {
      console.log(`Routing diagnostic: ${diagnostic.reason}.`);
      console.log('');
    }
  }
  for (let i = 0; i < scored.length; i++) {
    const r = scored[i];
    const ranking = rankingDiagnostic(r.entry, r.score, r.facetDiagnostics);
    const id = discoveryIdForEntry(r.entry);
    const score = r.score.toFixed(2);
    const flags = [
      r.entry.kernel ? 'kernel' : null,
      r.entry.script ? 'exec' : null,
    ].filter(Boolean).join(', ');
    const locator = includePaths ? resolvePath(r.entry) : id;
    const topTriggerMatch = ranking.matches
      .filter((match) => match.field === 'trigger')
      .reduce<(typeof ranking.matches)[number] | undefined>(
        (best, match) => !best || match.contribution > best.contribution ? match : best,
        undefined,
      );
    const topTrigger = topTriggerMatch?.value ??
      (r.entry.triggers && r.entry.triggers.length > 0 ? r.entry.triggers[0] : '');
    console.log(`${i + 1}. ${r.entry.title}`);
    console.log(`   type: ${r.entry.type}  score: ${score}${flags ? `  flags: ${flags}` : ''}`);
    console.log(`   ${includePaths ? 'path' : 'id'}: ${locator}`);
    if (r.entry.name) {
      console.log(`   name: ${r.entry.name}`);
    }
    if (r.entry.capability) {
      console.log(`   capability: ${r.entry.capability}`);
    }
    if (topTrigger) {
      console.log(`   trigger: "${topTrigger}"`);
    }
    const triggerCoverage = topTriggerMatch?.query_token_coverage;
    const rankingParts = [
      `lexical ${ranking.lexical_score.toFixed(4)} -> final ${ranking.final_score.toFixed(4)}`,
      triggerCoverage === undefined
        ? null
        : `trigger covers ${Math.round(triggerCoverage * 100)}% of query tokens`,
      `scope ${ranking.tie_breakers.scope}`,
    ].filter((part): part is string => Boolean(part));
    console.log(`   ranking: ${rankingParts.join('; ')}`);
    if (governing[i].length) {
      console.log(`   ${statsText(governingRuleStats(governing[i]))}`);
      console.log(`   ${RULE_CHECK_OBLIGATION}`);
      for (const { rule, applicability } of governing[i]) console.log(`   - ${rule.name ?? rule.path}: ${rule.ruleSummary ?? ''} (${applicability.join('; ')}) — \`${boundRuleDescriptor(rule).show_command}\``);
    }
    if (r.entry.script) {
      console.log(`   run: ${buildRunHint(r.entry)}`);
    } else if (!includePaths) {
      console.log(`   show: ${showHintForDiscoverResult(r.entry, id)}`);
    }
    console.log('');
  }
  console.log('Use `--format json` for machine-readable output. Use `aiwg show metadata <id>` for paths and full metadata.');
}
