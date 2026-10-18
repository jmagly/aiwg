#!/usr/bin/env node

/**
 * Runtime-dependency budget gate.
 *
 * Counts direct runtime dependencies declared in package.json and fails
 * if the count exceeds the budget. Optional flag `--all` includes the
 * full transitive dependency graph via `npm ls --prod --all --json`.
 *
 * Rationale: a CLI should be careful about what it ships. Every new
 * runtime dep slows cold start, bloats install size, and extends the
 * supply-chain attack surface. This gate forces an explicit decision
 * when the number grows.
 *
 * Budgets (overridable via env):
 *   AIWG_DIRECT_DEPS_BUDGET     — default 20 (direct runtime deps)
 *   AIWG_TRANSITIVE_DEPS_BUDGET — default 250 (transitive, when --all set)
 *
 * Usage:
 *   node tools/cli/check-dep-budget.mjs            # direct count only (fast)
 *   node tools/cli/check-dep-budget.mjs --all      # full tree (slow)
 *   node tools/cli/check-dep-budget.mjs --verbose
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { importImpl } from '../_resolve-impl.mjs';

const { boundedExecSync } = await importImpl(import.meta.url, 'process/bounded-child-process.mjs');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Reviewed October baseline: 18 direct runtime dependencies; two slots of
// headroom. See docs/reports/package-budget-2026-10.md for the decision.
const DIRECT_BUDGET = parseIntEnv('AIWG_DIRECT_DEPS_BUDGET', 20);
const TRANSITIVE_BUDGET = parseIntEnv('AIWG_TRANSITIVE_DEPS_BUDGET', 250);

const includeTransitive = process.argv.includes('--all');
const verbose = process.argv.includes('--verbose');

function parseIntEnv(name, def) {
  const raw = process.env[name];
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : def;
}

function countTransitive(tree) {
  // Walk an npm ls tree, counting unique package names. The root itself
  // doesn't count as a dep of the user project.
  const seen = new Set();
  function walk(node) {
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      if (!child || seen.has(name)) continue;
      seen.add(name);
      if (typeof child === 'object') walk(child);
    }
  }
  walk(tree);
  return seen.size;
}

const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
const directDeps = Object.keys(pkg.dependencies ?? {});
const directCount = directDeps.length;

if (verbose) {
  console.log(`Direct runtime deps (${directCount}, budget ${DIRECT_BUDGET}):`);
  for (const d of directDeps) console.log(`  - ${d}`);
  console.log('');
}

const failures = [];
if (directCount > DIRECT_BUDGET) {
  failures.push(`Direct runtime deps ${directCount} exceeds budget of ${DIRECT_BUDGET}`);
}

let transitiveCount;
if (includeTransitive) {
  try {
    let raw;
    try {
      raw = boundedExecSync('npm ls --prod --all --json', 'quick', {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (err) {
      // npm ls can report peer/optional problems while still returning a
      // usable tree. Recover that tree, but never silently skip a requested gate.
      if (!err.stdout?.length) throw err;
      raw = err.stdout.toString();
    }
    const tree = JSON.parse(raw);
    if (!tree || typeof tree !== 'object' || !tree.dependencies) {
      throw new Error('npm ls output did not contain a dependency tree');
    }
    transitiveCount = countTransitive(tree);
    if (verbose) console.log(`Transitive deps: ${transitiveCount} (budget ${TRANSITIVE_BUDGET})`);
    if (transitiveCount > TRANSITIVE_BUDGET) {
      failures.push(`Transitive deps ${transitiveCount} exceeds budget of ${TRANSITIVE_BUDGET}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`Unable to measure transitive dependencies: ${message.slice(0, 160)}`);
  }
}

if (failures.length > 0) {
  console.error('check-dep-budget: FAILED');
  for (const f of failures) console.error(`  - ${f}`);
  console.error('');
  console.error('Every new runtime dep slows cold start, bloats install size, and');
  console.error('extends the supply-chain attack surface. If a new dep is genuinely');
  console.error('needed, bump AIWG_DIRECT_DEPS_BUDGET and document the tradeoff in the');
  console.error('commit message.');
  process.exit(1);
}

const transitiveMsg = transitiveCount !== undefined ? ` / ${transitiveCount} transitive` : '';
console.log(`check-dep-budget: OK (${directCount} direct${transitiveMsg})`);
