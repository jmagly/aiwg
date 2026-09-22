/**
 * `aiwg index enrich` subcommand router.
 *
 * Subcommands / flags:
 *   --using-rlm                 — emit enrichment plan(s) for an agent to dispatch
 *   --filter <expr>             — restrict to artifacts matching expr
 *   --force                     — re-enrich even when enriched_hash matches
 *   --dry-run                   — count and estimate cost only
 *   --reset                     — drop all enrichment data
 *   --list                      — list current enrichment entries
 *   --apply --id <id> --result <path>  — write a result back from agent dispatch
 *
 * Like `views build`, this CLI does NOT directly invoke RLM. It emits
 * EnrichmentPlan records the agent acts on (dispatching /rlm-batch),
 * then the agent writes results back via `--apply`.
 *
 * @implements #1204
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { computeHash } from '../../rlm/cache/hash.js';
import { ENRICHMENT_PROMPT, validateEnrichmentOutput } from './prompt.js';
import {
  computeContentHash,
  get as getEnrichment,
  has as hasEnrichment,
  list as listEnrichments,
  put as putEnrichment,
  reset as resetEnrichments,
  resolveSemanticRoot,
} from './store.js';
import type { EnrichmentPlan, SemanticFields } from './types.js';

export async function main(args: string[]): Promise<void> {
  if (args.includes('--reset')) {
    handleReset();
    return;
  }
  if (args.includes('--list')) {
    handleList(args);
    return;
  }
  if (args.includes('--apply')) {
    handleApply(args);
    return;
  }
  if (args.includes('--using-rlm')) {
    handleUsingRlm(args);
    return;
  }
  printUsage();
  if (args.length > 0) {
    process.exitCode = 1;
  }
}

function asJson(args: string[]): boolean {
  return args.includes('--json');
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : undefined;
}

function handleReset(): void {
  const root = resolveSemanticRoot();
  const r = resetEnrichments(root);
  console.log(`Reset enrichment: removed ${r.removed} sidecar entries from ${root}`);
}

function handleList(args: string[]): void {
  const root = resolveSemanticRoot();
  const summaries = listEnrichments(root, /* currentHashes */ {});
  if (asJson(args)) {
    console.log(JSON.stringify(summaries, null, 2));
    return;
  }
  if (summaries.length === 0) {
    console.log('No enrichment entries.');
    console.log(`Semantic root: ${root}`);
    return;
  }
  console.log(`artifact                                       symbols  citations  age   stale`);
  console.log(`─────────────────────────────────────────────  ───────  ─────────  ────  ─────`);
  for (const s of summaries) {
    const id = s.artifactId.length > 45 ? `…${s.artifactId.slice(-44)}` : s.artifactId.padEnd(45);
    console.log(
      `${id}  ${String(s.symbolCount).padStart(7)}  ${String(s.citationCount).padStart(9)}  ${String(s.ageDays).padStart(3)}d  ${s.isStale ? 'YES' : ''}`
    );
  }
  console.log(`\n${summaries.length} entries at ${root}`);
}

function handleApply(args: string[]): void {
  const id     = flagValue(args, '--id');
  const result = flagValue(args, '--result');
  if (!id || !result) {
    console.error('Usage: aiwg index enrich --apply --id <id> --result <path-to-json>');
    process.exitCode = 1;
    return;
  }
  if (!existsSync(result)) {
    console.error(`No file: ${result}`);
    process.exitCode = 1;
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(result, 'utf-8'));
  } catch (err) {
    console.error(`Failed to parse JSON: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  const issues = validateEnrichmentOutput(parsed);
  if (issues.length > 0) {
    console.error('Enrichment result validation failed:');
    for (const i of issues) console.error(`  - ${i}`);
    process.exitCode = 1;
    return;
  }
  // Read the artifact to compute its current hash
  const absId = resolve(id);
  if (!existsSync(absId)) {
    console.error(`Artifact not found at ${absId} — cannot compute content hash`);
    process.exitCode = 1;
    return;
  }
  const contentHash = computeContentHash(readFileSync(absId));

  const r = parsed as Record<string, unknown>;
  const fields: SemanticFields = {
    summary:         r['summary'] as string,
    declaredSymbols: r['declared_symbols'] as string[],
    citations:       r['citations']        as string[],
    inferredTags:    r['inferred_tags']    as string[],
    openQuestions:   r['open_questions']   as string[],
    enrichedAt:      new Date().toISOString(),
    enrichedBy:      flagValue(args, '--by') ?? 'rlm-batch',
    enrichedHash:    contentHash,
  };
  const root = resolveSemanticRoot();
  const file = putEnrichment(root, id, fields);
  console.log(`Enrichment applied: ${id}`);
  console.log(`  Written: ${file}`);
}

function handleUsingRlm(args: string[]): void {
  const filter  = flagValue(args, '--filter');
  const force   = args.includes('--force');
  const dryRun  = args.includes('--dry-run');
  const json    = asJson(args);
  const root    = resolveSemanticRoot();

  // Discover artifacts to enrich. We delegate target selection to the user
  // via --files (one path per line, or comma-separated). This keeps the CLI
  // free of an opinionated index walker; agents typically pass the file list
  // they want enriched.
  const filesArg = flagValue(args, '--files');
  let files: string[];
  if (filesArg) {
    if (existsSync(filesArg)) {
      files = readFileSync(filesArg, 'utf-8')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else {
      files = filesArg.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    }
  } else {
    console.error('Usage: aiwg index enrich --using-rlm --files <path-to-list|csv> [--filter <expr>] [--force] [--dry-run]');
    console.error('       aiwg index enrich --using-rlm --files src/foo.ts,src/bar.ts');
    console.error('');
    console.error('Tip: pipe `aiwg index query --json | jq -r .results[].path` into --files <path>.');
    process.exitCode = 1;
    return;
  }

  if (filter) {
    const re = new RegExp(filter);
    files = files.filter((f) => re.test(f));
  }

  // Filter by enrichment freshness unless --force
  const plans: EnrichmentPlan[] = [];
  let skipped = 0;
  for (const f of files) {
    if (!existsSync(f)) {
      console.error(`[skip] missing: ${f}`);
      continue;
    }
    const contentHash = computeContentHash(readFileSync(f));
    if (!force && hasEnrichment(root, f)) {
      try {
        const existing = getEnrichment(root, f);
        if (existing.enrichedHash === contentHash) {
          skipped++;
          continue;
        }
      } catch { /* fall through to enrich */ }
    }
    const cacheKey = computeHash({
      inputs:            [{ artifactId: f, contentHash }],
      query:             ENRICHMENT_PROMPT,
      subPrompt:         ENRICHMENT_PROMPT,
      model:             'claude-sonnet-5',
      aggregateStrategy: 'json-merge',
    });
    plans.push({
      artifactId:  f,
      contentHash,
      prompt:      ENRICHMENT_PROMPT,
      outputPath:  join(root, `${f.replace(/\//g, '__')}.json`),
      cacheKey,
    });
  }

  if (json) {
    console.log(JSON.stringify({ plans, skipped, totalFiles: files.length }, null, 2));
    return;
  }

  if (plans.length === 0) {
    console.log(`No artifacts need enrichment (${skipped} already fresh, ${files.length} total).`);
    if (!force) console.log('Use --force to re-enrich regardless of hash.');
    return;
  }

  console.log(`Enrichment plan: ${plans.length} artifact(s) to enrich, ${skipped} fresh, ${files.length} total.`);
  if (dryRun) {
    console.log('--dry-run: plan emitted, no dispatch.');
    return;
  }

  console.log('');
  console.log('NOTE: This command emits dispatch plans. The RLM agent (/rlm-batch) reads each plan,');
  console.log('runs the canonical extraction prompt against the artifact, and applies the result via:');
  console.log('  aiwg index enrich --apply --id <id> --result <path>');
  console.log('');
  for (const p of plans.slice(0, 10)) {
    console.log(`  • ${p.artifactId}  (cache: ${p.cacheKey.slice(0, 12)}…)`);
  }
  if (plans.length > 10) {
    console.log(`  … and ${plans.length - 10} more (use --json for full list)`);
  }
}

function printUsage(): void {
  console.log('aiwg index enrich [flags]');
  console.log('');
  console.log('Flags:');
  console.log('  --using-rlm --files <path|csv>   Emit enrichment dispatch plans');
  console.log('  --filter <regex>                 Restrict --using-rlm targets by regex');
  console.log('  --force                          Re-enrich even when enriched_hash matches');
  console.log('  --dry-run                        Plan without dispatch');
  console.log('  --apply --id <id> --result <p>   Write back a single agent result');
  console.log('  --list [--json]                  List current enrichment entries');
  console.log('  --reset                          Drop all enrichment data (rollback)');
}
