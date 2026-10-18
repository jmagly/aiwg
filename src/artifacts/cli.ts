/**
 * Artifact Index CLI Commands
 *
 * Provides CLI interface for artifact index operations:
 * - build: Build/rebuild the artifact index
 * - query: Search artifacts by keyword, type, phase, tags
 * - deps:  Show artifact dependency graph
 * - stats: Show index statistics
 *
 * Supports multi-graph architecture via --graph flag:
 * - framework: AIWG framework source (shared, built during `aiwg use`)
 * - project: SDLC artifacts in .aiwg/ (per-project)
 * - codebase: Source code, tests, configs (per-project)
 *
 * @implements #420 #421
 * @source @src/cli/handlers/subcommands.ts
 * @tests @test/unit/artifacts/cli.test.ts
 */

import type { GraphType } from './types.js';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  GRAPH_CONFIGS,
  OPERATIONAL_DISCOVERY_TYPES,
  OPERATIONAL_SHOW_TYPES,
  isOperationalShowType,
  loadUserGraphConfigs,
  loadGlobalGraphConfigs,
  orderedGraphEntries,
} from './types.js';
import { SUPPORTED_VIEWS } from './corpus-views/renderers.js';
import {
  parseResourceSelector,
  readVerifiedRegularFile,
  type ResourceSource,
  type WebReleaseOptions,
} from '../resources/web-release.js';
import { findPackageRoot } from '../cli/find-package-root.js';
import { createResourceCredentialProvider } from '../auth/resource-credentials.js';

const MAX_RESOURCE_TRUST_ROOT_BYTES = 64 * 1024;

function webReleaseOptionsFromEnvironment(): Omit<WebReleaseOptions, 'selector' | 'offline'> {
  const baseUrl = process.env.AIWG_RESOURCE_BASE_URL;
  const cacheRoot = process.env.AIWG_RESOURCE_CACHE_ROOT;
  const trustRootFile = process.env.AIWG_RESOURCE_TRUST_ROOT_FILE;
  let publicKeyPem: Buffer | undefined;

  if (trustRootFile !== undefined) {
    if (trustRootFile.trim().length === 0) {
      throw new Error('AIWG_RESOURCE_TRUST_ROOT_FILE must name a non-empty public PEM file');
    }
    publicKeyPem = readVerifiedRegularFile(path.resolve(trustRootFile), {
      label: 'AIWG_RESOURCE_TRUST_ROOT_FILE public PEM',
      maxBytes: MAX_RESOURCE_TRUST_ROOT_BYTES,
    });
    if (publicKeyPem.toString('utf8').trim().length === 0) {
      throw new Error('AIWG_RESOURCE_TRUST_ROOT_FILE public PEM is empty');
    }
  }

  return {
    credentialProvider: createResourceCredentialProvider(process.env),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(cacheRoot === undefined ? {} : { cacheRoot }),
    ...(publicKeyPem === undefined ? {} : { publicKeyPem }),
    ...(process.env.AIWG_RESOURCE_ALLOW_INSECURE_LOOPBACK_HTTP === '1'
      ? { allowInsecureLoopbackHttp: true }
      : {}),
  };
}

/** Parse --graph flag from args, returns undefined for "all graphs" */
function parseGraphFlag(args: string[]): GraphType | undefined {
  const idx = args.indexOf('--graph');
  if (idx === -1) return undefined;
  if (idx + 1 >= args.length || args[idx + 1].startsWith('--')) {
    console.error('Error: --graph requires a graph name');
    process.exit(1);
  }
  const val = args[idx + 1];
  // Load user-defined graphs so validation is complete
  loadUserGraphConfigs(process.cwd());
  loadGlobalGraphConfigs();
  if (val in GRAPH_CONFIGS) return val;
  // Corpus markdown views (#1490) are valid --graph targets for `index build`.
  if ((SUPPORTED_VIEWS as readonly string[]).includes(val)) return val;
  const validNames = [...Object.keys(GRAPH_CONFIGS), ...SUPPORTED_VIEWS].join(', ');
  console.error(`Error: Invalid graph type '${val}'. Valid: ${validNames}`);
  process.exit(1);
}

function parseBackendFlag(args: string[]): 'local' | 'fortemi-core' | undefined {
  const idx = args.indexOf('--backend');
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (value === 'local' || value === 'fortemi-core') return value;
  console.error('Error: --backend must be local or fortemi-core');
  process.exit(1);
}

function parseSearchBackendFlag(args: string[]): 'local' | 'fortemi-core' {
  return parseBackendFlag(args) ?? 'fortemi-core';
}

/**
 * The full `aiwg` package owns a local corpus, while `@aiwg/cli` intentionally
 * ships only executable code and embedded runtime metadata. Select web
 * resources automatically for the lightweight distribution so a normal
 * `aiwg discover` / `aiwg show` invocation works immediately after install.
 *
 * Resolve from this module rather than process.argv so the exported API gets
 * the same package-aware default as the npm binary.
 */
function defaultResourceSource(): ResourceSource {
  const packageRoot = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
  if (!packageRoot) return 'local';
  try {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    return manifest.name === '@aiwg/cli' ? 'web' : 'local';
  } catch {
    return 'local';
  }
}

function parseResourceSourceFlag(args: string[]): ResourceSource {
  const indices = args
    .map((arg, index) => arg === '--resource-source' ? index : -1)
    .filter((index) => index >= 0);
  if (indices.length > 1) {
    console.error('Error: --resource-source may be specified only once');
    process.exit(1);
  }
  if (indices.length === 0) return defaultResourceSource();
  const value = args[indices[0] + 1];
  if (value === 'local' || value === 'web' || value === 'auto') return value;
  console.error('Error: --resource-source must be local, web, or auto');
  process.exit(1);
}

function parseAiwgVersionFlag(args: string[]): string | undefined {
  const indices = args
    .map((arg, index) => arg === '--aiwg-version' ? index : -1)
    .filter((index) => index >= 0);
  if (indices.length > 1) {
    console.error('Error: --aiwg-version may be specified only once');
    process.exit(1);
  }
  if (indices.length === 0) return undefined;
  const value = args[indices[0] + 1];
  if (!value || value.startsWith('--')) {
    console.error('Error: --aiwg-version requires an exact calendar-semver version, SemVer range, sha256 digest, or channel name');
    process.exit(1);
  }
  try {
    parseResourceSelector(value);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  return value;
}

function firstPositionalArg(args: string[], valueFlags: string[]): string | undefined {
  const skip = new Set<number>();
  for (let i = 0; i < args.length; i++) {
    if (valueFlags.includes(args[i]) && i + 1 < args.length) skip.add(i + 1);
  }
  return args.find((arg, index) => !arg.startsWith('--') && !skip.has(index));
}

function parseDirectionFlag<T extends string>(
  args: string[],
  allowed: readonly T[],
  defaultValue: T,
  label: string,
): T {
  const idx = args.indexOf('--direction');
  if (idx === -1) return defaultValue;
  const value = args[idx + 1];
  if (allowed.includes(value as T)) return value as T;
  console.error(`Error: --direction must be ${label}`);
  process.exit(1);
}

function parseFlagValue(args: string[], flag: string, errorMessage: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith('--')) {
    console.error(errorMessage);
    process.exit(1);
  }
  return value;
}

function parsePositiveIntegerFlag(args: string[], flag: string, defaultValue: number, errorMessage: string): number {
  const value = parseFlagValue(args, flag, errorMessage);
  if (value === undefined) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== value) {
    console.error(errorMessage);
    process.exit(1);
  }
  return parsed;
}

function parseOptionalPositiveIntegerFlag(args: string[], flag: string, errorMessage: string): number | undefined {
  const value = parseFlagValue(args, flag, errorMessage);
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== value) {
    console.error(errorMessage);
    process.exit(1);
  }
  return parsed;
}

/**
 * Main index command router
 */
export async function main(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subcommandArgs = args.slice(1);

  // #1231 — intercept --help/-h before subcommand dispatch. Print the
  // same usage block as the no-args case, but framed as help (exit 0)
  // rather than as an unknown-subcommand error (exit 1).
  if (subcommand === '--help' || subcommand === '-h') {
    printIndexUsage();
    process.exit(0);
  }

  switch (subcommand) {
    case 'refresh': {
      if (subcommandArgs.includes('--help') || subcommandArgs.includes('-h')) {
        printIndexUsage();
        break;
      }
      const { runIndexRefresh } = await import('./index-refresh.js');
      await runIndexRefresh(subcommandArgs);
      break;
    }

    case 'build':
      await handleBuild(subcommandArgs);
      break;

    case 'query':
      await handleQuery(subcommandArgs);
      break;

    case 'discover':
      await handleDiscover(subcommandArgs);
      break;

    case 'show':
      await handleShow(subcommandArgs);
      break;

    case 'export':
      await handleExport(subcommandArgs);
      break;

    case 'sync':
      await handleSync(subcommandArgs);
      break;

    case 'migrate-legacy':
      await handleMigrateLegacy(subcommandArgs);
      break;

    case 'deps':
      await handleDeps(subcommandArgs);
      break;

    case 'stats':
      await handleStats(subcommandArgs);
      break;

    case 'status':
    case 'list':
      await handleStatus(subcommandArgs);
      break;

    case 'neighbors':
      await handleNeighbors(subcommandArgs);
      break;

    case 'set':
      await handleSetQuery(subcommandArgs);
      break;

    case 'embed':
      await handleEmbed(subcommandArgs);
      break;

    case 'similar':
      await handleSimilar(subcommandArgs);
      break;

    case 'dedup-report':
      await handleDedup(subcommandArgs);
      break;

    case 'eval-discovery':
      await handleEvalDiscovery(subcommandArgs);
      break;

    case 'watch':
      await handleWatch(subcommandArgs);
      break;

    case 'views': {
      const { main: viewsMain } = await import('./views/cli.js');
      await viewsMain(subcommandArgs);
      break;
    }

    case 'enrich': {
      const { main: enrichMain } = await import('./enrichment/cli.js');
      await enrichMain(subcommandArgs);
      break;
    }

    case 'doctor': {
      const { main: doctorMain } = await import('./audit/cli.js');
      await doctorMain(subcommandArgs);
      break;
    }

    case undefined:
      console.error('Error: Index subcommand required');
      console.log('');
      printIndexUsage();
      process.exit(1);
      break;

    default:
      console.error(`Error: Unknown index subcommand '${subcommand}'`);
      console.log('Available: build, refresh, query, discover, show, export, sync, migrate-legacy, deps, stats, status, list, neighbors, set, embed, similar, dedup-report, eval-discovery, watch');
      process.exit(1);
  }
}

export function printIndexUsage(): void {
  console.log('Usage: aiwg index <subcommand> [options]');
  console.log('');
  console.log('Available subcommands:');
  console.log('  build      Build/rebuild the artifact index');
  console.log('  refresh    Safely refresh graphs, caches, sessions, runtime, models, and local issues');
  console.log('  query      Search artifacts by keyword, type, phase, tags');
  console.log('  discover   Capability search across operational asset types (#1214)');
  console.log('  show       Print the full text of a specific operational asset');
  console.log('  export     Export a browser-consumable index contract');
  console.log('  sync       Materialize the Fortemi Core static index cache');
  console.log('  migrate-legacy  Move legacy root indexes into graph sidecar indexes');
  console.log('  deps       Show artifact dependency graph');
  console.log('  stats      Show index statistics');
  console.log('  status     Enumerate the index-graph registry (freshness + drift); alias: list');
  console.log('  neighbors  Get neighbors of a node in a graph');
  console.log('  set        Set operations (intersection, union, difference) on neighbor sets');
  console.log('  embed      Build the semantic embedding index for a graph (opt-in deps)');
  console.log('  similar    Semantic neighbors of a node (requires embed)');
  console.log('  dedup-report  Near-duplicate node pairs above a similarity threshold');
  console.log('  eval-discovery  Benchmark operational capability discovery relevance');
  console.log('  watch      Start a filesystem watcher for automatic incremental index updates');
  console.log('');
  console.log('Options:');
  console.log('  build [--force] [--verbose] [--all] [--scope <dir>] [--graph <name>]');
  console.log('  refresh [--full] [--workspace <path>]... [--root <dir>]...');
  console.log('          [--only graphs|sessions|caches|runtime|models|issues] [--dry-run] [--json] [--lock-wait-ms <n>]');
  console.log('          [--max-record-bytes <n>] [--max-source-bytes <n>]');
  console.log('  Session import defaults: 67108864 bytes per record, 1073741824 bytes (1 GiB) per source; source 0 is unlimited.');
  console.log('  --exclude <id-or-glob> (repeatable): skip session IDs or absolute path globs; adds to sessions.import.exclude and AIWG_SESSIONS_IMPORT_EXCLUDE (comma-separated).');
  console.log('  Import limits: CLI flag > AIWG_SESSIONS_IMPORT_MAX_RECORD_BYTES / AIWG_SESSIONS_IMPORT_MAX_SOURCE_BYTES > workspace config > default.');
  console.log('  sync [--backend fortemi-core] [--graph <name> | --all] [--repo <name>]');
  console.log('       [--privacy private|sanitized|public] [--generated-at <iso>] [--json]');
  console.log('  --graph <name>  Target a specific graph (framework, project, codebase, source, user, or user-defined)');
  console.log('  --all           Build all known graphs (including user-defined)');
  console.log('');
  console.log('Examples:');
  console.log('  aiwg index build');
  console.log('  aiwg index build --all');
  console.log('  aiwg index refresh --root ~/dev --json');
  console.log('  aiwg index build --graph codebase --force');
  console.log('  aiwg index discover "create intake"');
  console.log('  aiwg index discover "deploy production" --limit 5 --json');
  console.log('  aiwg index discover "audit security" --type skill');
  console.log('  aiwg index show skill intake-wizard');
  console.log('  aiwg index show skill flow-deploy-to-production --json');
  console.log('  aiwg index show metadata aiwg:skill:4840fa441622f676 --json');
  console.log('  aiwg index show agent aiwg-steward');
  console.log('  aiwg index export --format fortemi --graph project --out aiwg-fortemi-index.json');
  console.log('  aiwg index migrate-legacy --scope project --dry-run');
  console.log('  aiwg index query "authentication" --type use-case');
  console.log('  aiwg index query "security rules" --graph framework --json');
  console.log('  aiwg index query "mixture of experts" --fulltext --graph papers   # body text, BM25');
  console.log('  aiwg index embed --graph papers --embed-body                       # body-granularity vectors');
  console.log('  aiwg index deps .aiwg/requirements/UC-001.md');
  console.log('  aiwg index stats --json');
  console.log('  aiwg index stats --graph project');
  console.log('  aiwg index eval-discovery --queries test/fixtures/artifacts/discovery-relevance.jsonl --backend local --strategy lexical');
  console.log('  aiwg index neighbors --graph citation-network --node REF-008 --direction in --edge-type cites');
  console.log('  aiwg index set --graph citation-network --op intersection --node-a REF-008 --node-b REF-016 --direction in');
}

async function handleEvalDiscovery(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: aiwg index eval-discovery --queries <jsonl> --backend <local|fortemi-core> --strategy <lexical|dense|hybrid-rrf|rerank|chunk-multivector> [options]');
    console.log('');
    console.log('Options:');
    console.log('  --queries <path>   Versioned relevance JSONL fixture (required)');
    console.log('  --backend <name>   local or fortemi-core (required)');
    console.log('  --strategy <name>  lexical, dense, hybrid-rrf, rerank, or chunk-multivector');
    console.log('  --out <path>       Write the JSON report to a file');
    console.log('  --json             Emit JSON instead of the readable summary');
    return;
  }
  const queries = parseFlagValue(args, '--queries', 'Error: --queries requires a JSONL path');
  if (!queries) {
    console.error('Error: --queries is required');
    process.exit(1);
  }
  const backend = parseFlagValue(args, '--backend', 'Error: --backend requires local or fortemi-core');
  if (backend !== 'local' && backend !== 'fortemi-core') {
    console.error('Error: --backend must be local or fortemi-core');
    process.exit(1);
  }
  const strategy = parseFlagValue(args, '--strategy', 'Error: --strategy requires a value') ?? 'lexical';
  const { DISCOVERY_EVAL_STRATEGIES, evaluateDiscovery, formatDiscoveryEvalSummary } = await import('./discovery-eval.js');
  if (!(DISCOVERY_EVAL_STRATEGIES as readonly string[]).includes(strategy)) {
    console.error(`Error: --strategy must be ${DISCOVERY_EVAL_STRATEGIES.join(', ')}`);
    process.exit(1);
  }
  try {
    const report = await evaluateDiscovery({
      cwd: process.cwd(),
      fixturePath: path.resolve(queries),
      backend,
      strategy: strategy as import('./discovery-eval.js').DiscoveryEvalStrategy,
    });
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    const out = parseFlagValue(args, '--out', 'Error: --out requires a path');
    if (out) {
      const fs = await import('node:fs');
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      fs.writeFileSync(path.resolve(out), serialized);
    }
    console.log(args.includes('--json') ? serialized.trimEnd() : formatDiscoveryEvalSummary(report));
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

/**
 * Handle 'index watch' command — filesystem watcher daemon for auto-index updates.
 *
 * Modes:
 *   aiwg index watch            — start watcher (foreground)
 *   aiwg index watch --stop     — stop a running watcher
 *   aiwg index watch --status   — check watcher status
 *
 * @implements #795
 */
async function handleWatch(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: aiwg index watch [options]');
    console.log('');
    console.log('Start a filesystem watcher that triggers incremental index rebuilds');
    console.log('when .aiwg/ files change. Uses the checksum manifest (#794) for fast');
    console.log('change detection.');
    console.log('');
    console.log('Options:');
    console.log('  --stop            Stop a running watcher for this project');
    console.log('  --status          Show whether a watcher is running');
    console.log('  --debounce <ms>   Debounce window for batched updates (default: 500)');
    console.log('  --graph <name>    Graph to rebuild (default: project)');
    console.log('  --verbose         Log every detected change');
    console.log('');
    console.log('Examples:');
    console.log('  aiwg index watch');
    console.log('  aiwg index watch --verbose --debounce 1000');
    console.log('  aiwg index watch --stop');
    console.log('  aiwg index watch --status');
    return;
  }

  const cwd = process.cwd();
  const { startWatcher, stopWatcher, getRunningPid } = await import('./watcher.js');

  // --status: check if a watcher is running
  if (args.includes('--status')) {
    const pid = getRunningPid(cwd);
    if (pid) {
      console.log(`Watcher running: PID ${pid}`);
    } else {
      console.log('No watcher running for this project');
    }
    return;
  }

  // --stop: terminate a running watcher
  if (args.includes('--stop')) {
    const stopped = stopWatcher(cwd);
    if (stopped) {
      console.log('Watcher stopped');
    } else {
      console.log('No watcher running for this project');
    }
    return;
  }

  // --debounce <ms>
  let debounceMs = 500;
  const debounceIdx = args.indexOf('--debounce');
  if (debounceIdx !== -1 && debounceIdx + 1 < args.length) {
    const parsed = parseInt(args[debounceIdx + 1], 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      debounceMs = parsed;
    }
  }

  // --graph <name>
  const graph = parseGraphFlag(args);

  const verbose = args.includes('--verbose');

  try {
    startWatcher({
      cwd,
      debounceMs,
      verbose,
      graph,
    });
    // startWatcher registers SIGINT/SIGTERM handlers; block the main thread
    // until one of them fires. setInterval keeps Node alive indefinitely.
    setInterval(() => { /* keep-alive */ }, 1 << 30);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/**
 * Handle 'index build' command
 */
async function handleBuild(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: aiwg index build [options]');
    console.log('');
    console.log('Options:');
    console.log('  --force          Full rebuild (ignore checksums, re-index everything)');
    console.log('  --verbose        Show detailed progress during indexing');
    console.log('  --all            Build all known graphs (including user-defined)');
    console.log('  --scope <dir>    Limit scan to a specific subdirectory');
    console.log('  --include-ignored Include gitignored sources (runtime directories stay excluded)');
    console.log('  Source discovery skips symlinks and .aiwg/{working,sessions,scratch,tmp,temp,cache,.index,.cache,.storage-cache}/.');
    console.log('  --graph <name>   Build a specific graph only (built-in or user-defined)');
    console.log('');
    console.log('Built-in graph names: project, codebase, source, user, framework');
    console.log('User-defined graphs: configure under index.graphs in .aiwg/aiwg.config');
    console.log('');
    console.log('Default behavior (no --graph): builds all graphs with defaultBuild: true');
    console.log('Multi-graph builds run by buildOrder/buildTier (refs → citations → bibliography before heavy graphs)');
    console.log('  Built-in defaults: project (always), codebase (auto-detects JavaScript/TypeScript and Python layouts)');
    console.log('');
    console.log('Examples:');
    console.log('  aiwg index build');
    console.log('  aiwg index build --force');
    console.log('  aiwg index build --graph codebase --force');
    console.log('  aiwg index build --graph source --force');
    console.log('  aiwg index build --graph user --force');
    console.log('  aiwg index build --graph references            # user-defined graph');
    console.log('  aiwg index build --scope documentation/references');
    console.log('  aiwg index build --all');
    console.log('  aiwg index sync --all');
    return;
  }

  // Dynamic import to keep the CLI router lightweight
  const { buildIndex } = await import('./index-builder.js');
  const cwd = process.cwd();

  // Validate the index config at build time (#1491) — fail fast on malformed graph defs.
  await validateIndexConfigOrExit(cwd);

  const force = args.includes('--force');
  const verbose = args.includes('--verbose');
  const all = args.includes('--all');
  const includeIgnored = args.includes('--include-ignored');
  const graph = parseGraphFlag(args);

  let scope: string | undefined;
  const scopeIdx = args.indexOf('--scope');
  if (scopeIdx !== -1 && scopeIdx + 1 < args.length) {
    scope = args[scopeIdx + 1];
  }

  // Load user-defined graphs
  loadUserGraphConfigs(cwd);
  loadGlobalGraphConfigs();

  let jsonBuilt = false;
  const builtGraphs = new Set<GraphType>();
  if (graph) {
    // --graph X: build the JSON graph if X is one; otherwise X may be a
    // research-corpus markdown view, rendered below.
    if (graph in GRAPH_CONFIGS) {
      await buildIndex(cwd, { force, verbose, scope, includeIgnored, graph, explicit: true });
      jsonBuilt = true;
      builtGraphs.add(graph);
    }
  } else if (all) {
    // Build all known graphs — user asked for everything, but don't hard-error on missing dirs
    for (const [name] of orderedGraphEntries(Object.entries(GRAPH_CONFIGS))) {
      await buildIndex(cwd, { force, verbose, includeIgnored, graph: name, explicit: false });
      builtGraphs.add(name);
    }
    jsonBuilt = true;
  } else {
    // Default: build graphs with defaultBuild=true; skip gracefully if their dirs don't exist
    for (const [name, config] of orderedGraphEntries(Object.entries(GRAPH_CONFIGS))) {
      if (config.defaultBuild) {
        await buildIndex(cwd, { force, verbose, includeIgnored, scope: name === Object.keys(GRAPH_CONFIGS)[0] ? scope : undefined, graph: name, explicit: false });
        builtGraphs.add(name);
      }
    }
    jsonBuilt = true;
  }

  // Render research-corpus markdown views in the same process (#1490, Full A —
  // the native replacement for the retired corpus-index-build/build.py).
  // No-op when the project has no documentation/references/ corpus.
  const { buildCorpusViews } = await import('./corpus-views/build.js');
  const viewResults = await buildCorpusViews(cwd, { force, only: graph });
  if (viewResults.length > 0) {
    const built = viewResults.filter((r) => r.status === 'built').length;
    const skipped = viewResults.filter((r) => r.status === 'skipped').length;
    const unsupported = viewResults.filter((r) => r.status === 'unsupported').length;
    console.log('');
    console.log(`Markdown views: ${built} built, ${skipped} up to date${unsupported ? `, ${unsupported} unsupported` : ''} → indices/`);
    if (verbose || unsupported) {
      for (const r of viewResults) {
        const extra = r.status === 'unsupported' ? ` (${r.error})` : '';
        console.log(`  ${r.graph}: ${r.status} → ${r.output}${extra}`);
      }
    }
  }

  // A --graph that matched neither a JSON graph nor a rendered view is unknown.
  if (graph && !jsonBuilt && viewResults.length === 0) {
    console.error(`Unknown graph: ${graph}`);
    process.exit(1);
  }
  // Mirror build.py: an unsupported view name in the manifest fails the build.
  if (viewResults.some((r) => r.status === 'unsupported')) {
    process.exit(1);
  }

  if (builtGraphs.size > 0) {
    await syncFortemiCoreCachesAfterBuild(cwd, builtGraphs, verbose);
  }
}

async function syncFortemiCoreCachesAfterBuild(
  cwd: string,
  graphs: Iterable<GraphType>,
  verbose: boolean,
): Promise<void> {
  const { syncFortemiCoreIndex } = await import('./fortemi-core-sync.js');
  const { loadGraphIndexFile } = await import('./index-reader.js');
  for (const graph of graphs) {
    try {
      // Some auto-selected graphs skip cleanly when their scan roots are absent.
      if (!loadGraphIndexFile(cwd, 'metadata.json', graph)) continue;
      const manifest = syncFortemiCoreIndex(cwd, { graph });
      if (verbose) {
        console.log(`Fortemi Core ${graph} sync: ${manifest.status}, ${manifest.item_count} item(s) → ${manifest.export_path}`);
      }
    } catch (err) {
      process.exitCode = 1;
      console.error(`Error: Fortemi Core ${graph} sync failed: ${err instanceof Error ? err.message : String(err)}`);
      console.error(`Run \`aiwg index sync --graph ${graph}\` before using Fortemi-backed commands for '${graph}' artifacts.`);
    }
  }
}

/**
 * Validate the project's index config (#1491) before building. Reads the
 * canonical `.aiwg/aiwg.config` index block (config.yaml fallback) and rejects
 * malformed graph defs at validate time with actionable messages.
 */
async function validateIndexConfigOrExit(cwd: string): Promise<void> {
  const { readIndexConfig, validateIndexConfig } = await import('../config/aiwg-config.js');
  const { index } = await readIndexConfig(cwd);
  if (!index) return;
  const errors = validateIndexConfig(index);
  if (errors.length > 0) {
    console.error('✗ Invalid index config (#1491):');
    for (const e of errors) console.error(`  - ${e}`);
    console.error('Fix the errors above in .aiwg/aiwg.config (or legacy .aiwg/config.yaml) and re-run.');
    process.exit(1);
  }
}

/**
 * Handle 'index query' command
 *
 * Stub — full implementation in #416
 */
async function handleQuery(args: string[]): Promise<void> {
  const { queryIndex } = await import('./query-engine.js');
  const cwd = process.cwd();

  // Parse query text (positional args before any -- flags)
  const textParts: string[] = [];
  const flags: string[] = [];
  let inFlags = false;

  for (const arg of args) {
    if (arg.startsWith('--')) {
      inFlags = true;
    }
    if (inFlags) {
      flags.push(arg);
    } else {
      textParts.push(arg);
    }
  }

  const text = textParts.join(' ') || undefined;
  const json = flags.includes('--json');
  const fulltext = flags.includes('--fulltext');

  const type = parseFlagValue(flags, '--type', 'Error: --type requires a value');
  const phase = parseFlagValue(flags, '--phase', 'Error: --phase requires a value');
  const tags = parseFlagValue(flags, '--tags', 'Error: --tags requires a value');
  const updatedAfter = parseFlagValue(flags, '--updated-after', 'Error: --updated-after requires a value');
  const limit = parseOptionalPositiveIntegerFlag(flags, '--limit', 'Error: --limit must be a positive integer');
  const pathPattern = parseFlagValue(flags, '--path', 'Error: --path requires a value');

  const graph = parseGraphFlag(flags);
  const backend = parseSearchBackendFlag(flags);

  // --semantic (#1493): conceptual similarity via the embedding index.
  if (flags.includes('--semantic')) {
    if (!text) {
      console.error('Error: --semantic requires a query string.');
      process.exit(1);
    }
    await runSemanticQuery(cwd, text, graph, limit ?? 10, json, backend);
    return;
  }

  if (flags.includes('--hybrid')) {
    if (!text) {
      console.error('Error: --hybrid requires a query string.');
      process.exit(1);
    }
    await runHybridQuery(
      cwd,
      {
        text,
        graph,
        limit: limit ?? 10,
        path: pathPattern,
        type,
        phase,
        tags: tags?.split(','),
      },
      json,
      backend,
    );
    return;
  }

  await queryIndex(
    cwd,
    {
      text,
      type,
      phase,
      tags: tags?.split(','),
      updatedAfter,
      limit,
      path: pathPattern,
      fulltext,
    },
    { json, graph, backend },
  );
}

/** Resolve the embedding index dir for a graph, or null if deps/index absent (with guidance printed). */
async function requireEmbeddingIndex(cwd: string, graph: GraphType | undefined): Promise<string | null> {
  const { checkEmbeddingDeps, loadEmbeddingManifest } = await import('./embedding-index.js');
  const { resolveIndexDir } = await import('./index-reader.js');
  const deps = await checkEmbeddingDeps();
  if (!deps.available) {
    console.error(`Error: semantic search needs optional dependencies: ${deps.missing.join(', ')}`);
    console.error('Install them to enable semantic features:');
    console.error('  aiwg features install embeddings');
    return null;
  }
  const dir = resolveIndexDir(cwd, graph);
  if (!loadEmbeddingManifest(dir)) {
    console.error(`Error: no embedding index for graph '${graph ?? 'default'}'.`);
    console.error(`Build one first:  aiwg index embed${graph ? ` --graph ${graph}` : ''}`);
    return null;
  }
  return dir;
}

/** `aiwg index query "..." --semantic` — ranked semantic results, mapped back to index metadata. */
async function runSemanticQuery(
  cwd: string,
  text: string,
  graph: GraphType | undefined,
  topK: number,
  json: boolean,
  backend: 'local' | 'fortemi-core' | undefined,
): Promise<void> {
  if (backend === 'fortemi-core') {
    const { queryFortemiCoreStaticSemanticIndex } = await import('./fortemi-core-query-adapter.js');
    const queried = queryFortemiCoreStaticSemanticIndex(cwd, {
      graph,
      text,
      limit: topK,
    });
    if (queried.reason) {
      if (json) {
        console.log(
          JSON.stringify(
            {
              query: { text, backend: 'fortemi-core' },
              mode: 'semantic',
              graph: graph ?? null,
              results: [],
              total: 0,
              hint: queried.reason,
            },
            null,
            2,
          ),
        );
      } else {
        console.error(`Error: ${queried.reason}`);
      }
      process.exit(1);
    }
    if (json) {
      console.log(
        JSON.stringify(
          {
            query: { text, backend: 'fortemi-core' },
            mode: 'semantic',
            graph: graph ?? null,
            results: queried.results,
            total: queried.results.length,
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log(`Fortemi Core static semantic results for "${text}" (${queried.results.length}):`);
    console.log('');
    for (let i = 0; i < queried.results.length; i++) {
      const r = queried.results[i];
      console.log(`  ${String(i + 1).padStart(3)}  ${r.score.toFixed(3)}  ${r.path}  ${r.title}`);
    }
    return;
  }

  const dir = await requireEmbeddingIndex(cwd, graph);
  if (!dir) process.exit(1);
  const { semanticQuery, loadEmbeddingManifest } = await import('./embedding-index.js');
  const { loadGraphIndexFile } = await import('./index-reader.js');
  const index = loadGraphIndexFile<{
    entries: Record<string, { type: string; phase: string; title: string; summary: string }>;
  }>(cwd, 'metadata.json', graph);
  const manifest = loadEmbeddingManifest(dir!);
  const results = await semanticQuery(text, dir!, topK);
  if (json) {
    console.log(
      JSON.stringify(
        {
          query: { text },
          mode: 'semantic',
          graph: graph ?? null,
          embedding: {
            granularity: manifest?.granularity ?? 'title-summary',
            model: manifest?.model ?? null,
          },
          results: results.map((r) => ({
            path: r.nodeId,
            score: Math.round(r.score * 100) / 100,
            title: index?.entries[r.nodeId]?.title,
            summary: index?.entries[r.nodeId]?.summary,
          })),
          total: results.length,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`Semantic results for "${text}" (${results.length}, granularity: ${manifest?.granularity ?? 'title-summary'}):`);
  console.log('');
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const title = index?.entries[r.nodeId]?.title ?? '';
    console.log(`  ${String(i + 1).padStart(3)}  ${r.score.toFixed(3)}  ${r.nodeId}${title ? `  ${title}` : ''}`);
  }
}

interface HybridQueryOptions {
  text: string;
  graph: GraphType | undefined;
  limit: number;
  path?: string;
  type?: string;
  phase?: string;
  tags?: string[];
}

/** `aiwg index query "..." --hybrid` — static semantic scoring plus filters/facets. */
async function runHybridQuery(
  cwd: string,
  options: HybridQueryOptions,
  json: boolean,
  backend: 'local' | 'fortemi-core' | undefined,
): Promise<void> {
  if (backend !== 'fortemi-core') {
    console.error('Error: --hybrid uses the Fortemi Core static contract by default. Remove --backend local or use local semantic/fulltext modes separately.');
    process.exit(1);
  }

  const { queryFortemiCoreStaticHybridIndex } = await import('./fortemi-core-query-adapter.js');
  const queried = queryFortemiCoreStaticHybridIndex(cwd, options);
  if (queried.reason) {
    if (json) {
      console.log(
        JSON.stringify(
          {
            query: { text: options.text, backend: 'fortemi-core' },
            mode: 'hybrid',
            graph: options.graph ?? null,
            results: [],
            total: 0,
            hint: queried.reason,
          },
          null,
          2,
        ),
      );
    } else {
      console.error(`Error: ${queried.reason}`);
    }
    process.exit(1);
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          query: { text: options.text, backend: 'fortemi-core' },
          mode: 'hybrid',
          graph: options.graph ?? null,
          results: queried.results,
          total: queried.results.length,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`Fortemi Core static hybrid results for "${options.text}" (${queried.results.length}):`);
  console.log('');
  for (let i = 0; i < queried.results.length; i++) {
    const r = queried.results[i];
    console.log(`  ${String(i + 1).padStart(3)}  ${r.score.toFixed(3)}  ${r.path}  ${r.title}`);
  }
}

/** `aiwg index embed [--graph X] [--model M] [--granularity title-summary|body]` — build the embedding index. */
async function handleEmbed(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const graph = parseGraphFlag(args);
  const model = args.indexOf('--model') !== -1 ? args[args.indexOf('--model') + 1] : undefined;
  const requestedGranularity = args.includes('--embed-body')
    ? 'body'
    : parseFlagValue(args, '--granularity', 'Error: --granularity requires title-summary, metadata, or body') ?? 'title-summary';
  if (!['title-summary', 'metadata', 'body'].includes(requestedGranularity)) {
    console.error('Error: --granularity must be title-summary, metadata, or body');
    process.exit(1);
  }
  const granularity = requestedGranularity === 'metadata' ? 'title-summary' : requestedGranularity;
  const { checkEmbeddingDeps, buildEmbeddingIndex, DEFAULT_EMBEDDING_MODEL } = await import('./embedding-index.js');
  const { resolveIndexDir, loadGraphIndexFile } = await import('./index-reader.js');
  const deps = await checkEmbeddingDeps();
  if (!deps.available) {
    console.error(`Error: embedding needs optional dependencies: ${deps.missing.join(', ')}`);
    console.error('  aiwg features install embeddings');
    process.exit(1);
  }
  const index = loadGraphIndexFile<{ entries: Record<string, unknown> }>(cwd, 'metadata.json', graph);
  if (!index || Object.keys(index.entries).length === 0) {
    console.error(`Error: no metadata index for graph '${graph ?? 'default'}'. Run 'aiwg index build${graph ? ` --graph ${graph}` : ''}' first.`);
    process.exit(1);
  }
  const dir = resolveIndexDir(cwd, graph);
  console.log(`Embedding ${Object.keys(index.entries).length} nodes (model: ${model ?? DEFAULT_EMBEDDING_MODEL}, granularity: ${granularity})…`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const n = await buildEmbeddingIndex(index.entries as any, dir, model, {
    granularity: granularity as 'title-summary' | 'body',
    cwd,
  });
  console.log(`Embedded ${n} nodes → ${dir}/embeddings/`);
}

/** `aiwg index similar --node X [--graph X] [--top K]` — semantic neighbors of a node. */
async function handleSimilar(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const graph = parseGraphFlag(args);
  const node = args.indexOf('--node') !== -1 ? args[args.indexOf('--node') + 1] : undefined;
  const top = args.indexOf('--top') !== -1 ? parseInt(args[args.indexOf('--top') + 1], 10) : 10;
  const json = args.includes('--json');
  if (!node) {
    console.error('Error: similar requires --node <id>.');
    process.exit(1);
  }
  const dir = await requireEmbeddingIndex(cwd, graph);
  if (!dir) process.exit(1);
  const { semanticNeighbors } = await import('./embedding-index.js');
  const { loadGraphIndexFile } = await import('./index-reader.js');
  const index = loadGraphIndexFile<{ entries: Record<string, { title: string }> }>(cwd, 'metadata.json', graph);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results = await semanticNeighbors(node!, (index?.entries ?? {}) as any, dir!, top);
  if (json) {
    console.log(JSON.stringify({ node, graph: graph ?? null, results: results.map((r) => ({ path: r.nodeId, score: Math.round(r.score * 100) / 100, title: index?.entries[r.nodeId]?.title })) }, null, 2));
    return;
  }
  console.log(`Similar to ${node} (${results.length}):`);
  for (const r of results) console.log(`  ${r.score.toFixed(3)}  ${r.nodeId}${index?.entries[r.nodeId]?.title ? `  ${index.entries[r.nodeId].title}` : ''}`);
}

/** `aiwg index dedup-report [--graph X] [--threshold T]` — near-duplicate node pairs. */
async function handleDedup(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const graph = parseGraphFlag(args);
  const threshold = args.indexOf('--threshold') !== -1 ? parseFloat(args[args.indexOf('--threshold') + 1]) : 0.92;
  const json = args.includes('--json');
  const dir = await requireEmbeddingIndex(cwd, graph);
  if (!dir) process.exit(1);
  const { dedupReport, loadEmbeddingManifest } = await import('./embedding-index.js');
  const { loadGraphIndexFile } = await import('./index-reader.js');
  const index = loadGraphIndexFile<{ entries: Record<string, { title: string }> }>(cwd, 'metadata.json', graph);
  const manifest = loadEmbeddingManifest(dir!);
  const pairs = await dedupReport(dir!, threshold);
  if (json) {
    console.log(JSON.stringify({
      graph: graph ?? null,
      threshold,
      embedding: {
        granularity: manifest?.granularity ?? 'title-summary',
        model: manifest?.model ?? null,
      },
      pairs: pairs.map((p) => ({ ...p, score: Math.round(p.score * 1000) / 1000 })),
    }, null, 2));
    return;
  }
  console.log(`Near-duplicate pairs (cosine ≥ ${threshold}, granularity: ${manifest?.granularity ?? 'title-summary'}): ${pairs.length}`);
  console.log('');
  for (const p of pairs) {
    const ta = index?.entries[p.a]?.title ?? '';
    const tb = index?.entries[p.b]?.title ?? '';
    console.log(`  ${p.score.toFixed(3)}  ${p.a} ↔ ${p.b}`);
    if (ta || tb) console.log(`         ${ta}  |  ${tb}`);
  }
}

/**
 * Handle 'index export' command
 */
async function handleExport(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: aiwg index export --format fortemi|fortemi-shard [options]');
    console.log('');
    console.log('Options:');
    console.log('  --format fortemi       Export the AIWG/Fortemi browser contract (required)');
    console.log('  --format fortemi-shard Export a portable Fortemi Knowledge Shard');
    console.log('  --graph <name>         Graph to export (default: project)');
    console.log('  --out <path>           Write JSON or .shard output to a file');
    console.log('  --repo <name>          Source repository label (default: cwd basename)');
    console.log('  --privacy <level>      private, sanitized, or public (default: private)');
    console.log('  --schema-version <v>   Browser: v1|v2; shard: 2.0.0|1.2.0');
    console.log('  --profile <name>       Shard profile: full-v1 (default) or core-v1');
    console.log('  --fail-on-loss         Reject a full-v1 conversion that reports any loss');
    console.log('  --dry-run              Build and report without writing the shard');
    console.log('  --force                Replace an existing output path');
    console.log('  --migrate-from <path>  Diagnose a source-less legacy shard (dry-run only)');
    console.log('  --json                 Emit the machine-readable conversion report');
    console.log('  --generated-at <iso>   Override generated timestamp for deterministic fixtures');
    console.log('');
    console.log('Examples:');
    console.log('  aiwg index export --format fortemi --graph project --out aiwg-fortemi-index.json');
    console.log('  aiwg index export --format fortemi-shard --graph project --schema-version 2.0.0 --profile full-v1 --fail-on-loss --out aiwg-index.shard');
    console.log('  aiwg index export --format fortemi-shard --migrate-from legacy.shard --dry-run --json');
    console.log('  aiwg index export --format fortemi --privacy sanitized --generated-at 2026-01-01T00:00:00.000Z');
    return;
  }

  const format = parseFlagValue(args, '--format', 'Error: index export requires --format fortemi or fortemi-shard');
  if (format !== 'fortemi' && format !== 'fortemi-shard') {
    console.error('Error: index export requires --format fortemi or fortemi-shard');
    process.exit(1);
  }

  const graph = parseGraphFlag(args);
  const out = parseFlagValue(args, '--out', 'Error: --out requires a file path');
  const repo = parseFlagValue(args, '--repo', 'Error: --repo requires a value');
  const privacy = parseFlagValue(args, '--privacy', 'Error: --privacy must be private, sanitized, or public');
  if (privacy && !['private', 'sanitized', 'public'].includes(privacy)) {
    console.error('Error: --privacy must be private, sanitized, or public');
    process.exit(1);
  }
  const generatedAt = parseFlagValue(args, '--generated-at', 'Error: --generated-at requires an ISO timestamp value');
  const schemaVersion = parseFlagValue(args, '--schema-version', 'Error: --schema-version requires a value');
  const profile = parseFlagValue(args, '--profile', 'Error: --profile requires a value');
  const migrateFrom = parseFlagValue(args, '--migrate-from', 'Error: --migrate-from requires a shard path');
  const dryRun = args.includes('--dry-run');
  const json = args.includes('--json');
  if (format === 'fortemi' && schemaVersion && !['v1', 'v2'].includes(schemaVersion)) {
    console.error('Error: browser export --schema-version must be v1 or v2');
    process.exit(1);
  }
  if (format === 'fortemi-shard' && schemaVersion && !['1.2.0', '2.0.0'].includes(schemaVersion)) {
    console.error('Error: shard --schema-version must be 2.0.0 or 1.2.0');
    process.exit(1);
  }
  if (format === 'fortemi-shard' && profile && !['full-v1', 'core-v1'].includes(profile)) {
    console.error('Error: shard --profile must be full-v1 or core-v1');
    process.exit(1);
  }
  if (format === 'fortemi-shard' && !out && !migrateFrom) {
    console.error('Error: --format fortemi-shard requires --out <path>');
    process.exit(1);
  }

  try {
    if (format === 'fortemi-shard') {
      const {
        diagnoseAiwgFortemiShardMigration,
        writeAiwgFortemiKnowledgeShard,
      } = await import('./fortemi-shard-export.js');
      if (migrateFrom) {
        if (!dryRun) {
          throw new Error(
            '--migrate-from is diagnostic-only and requires --dry-run; '
            + 'source-less core-v1 artifacts cannot be promoted losslessly.',
          );
        }
        const diagnosis = diagnoseAiwgFortemiShardMigration(process.cwd(), migrateFrom);
        if (json) console.log(JSON.stringify(diagnosis, null, 2));
        else {
          console.log(`Migration supported: no`);
          console.log(`Diagnostic: ${diagnosis.diagnostic}`);
          console.log(`Action: ${diagnosis.action}`);
        }
        return;
      }
      const result = await writeAiwgFortemiKnowledgeShard(process.cwd(), out!, {
        graph,
        repo,
        privacy: privacy as 'private' | 'sanitized' | 'public' | undefined,
        generatedAt,
        schemaVersion: schemaVersion as '1.2.0' | '2.0.0' | undefined,
        profile: profile as 'core-v1' | 'full-v1' | undefined,
        failOnLoss: args.includes('--fail-on-loss'),
        dryRun,
        overwrite: args.includes('--force'),
      });
      if (json) console.log(JSON.stringify(result, null, 2));
      else {
        const action = result.written ? 'Exported' : 'Would export';
        console.log(
          `${action} ${result.items} AIWG records as `
          + `${result.conversion.schemaVersion}/${result.conversion.profile} `
          + `to ${result.outPath} (${result.bytes} bytes; `
          + `${result.conversion.losses.length} losses)`,
        );
      }
      return;
    }
    const { buildAiwgFortemiIndexExport, writeAiwgFortemiIndexExport } = await import('./browser-export.js');
    const exported = buildAiwgFortemiIndexExport(process.cwd(), {
      graph,
      repo,
      privacy: privacy as 'private' | 'sanitized' | 'public' | undefined,
      generatedAt,
      schemaVersion: schemaVersion as 'v1' | 'v2' | undefined,
    });
    writeAiwgFortemiIndexExport(exported, out);
  } catch (err) {
    console.error('Error: ' + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}

/**
 * Handle 'index sync' command
 */
async function handleSync(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: aiwg index sync [--backend fortemi-core] [options]');
    console.log('');
    console.log('Options:');
    console.log('  --backend fortemi-core  Materialize the Fortemi Core static index cache (default)');
    console.log('  --graph <name>          Graph to sync (default: project)');
    console.log('  --all                   Sync all built graph caches in build-order');
    console.log('  --repo <name>           Source repository label (default: cwd basename)');
    console.log('  --privacy <level>       private, sanitized, or public (default: private)');
    console.log('  --generated-at <iso>    Override generated timestamp for deterministic fixtures');
    console.log('  --json                  Print the sync manifest as JSON');
    return;
  }

  const backend = parseSearchBackendFlag(args);
  if (backend !== 'fortemi-core') {
    console.error('Error: index sync only supports the fortemi-core backend; omit --backend or pass --backend fortemi-core');
    process.exit(1);
  }

  const graph = parseGraphFlag(args);
  const all = args.includes('--all');
  if (graph && all) {
    console.error('Error: pass either --graph or --all, not both');
    process.exit(1);
  }
  const repo = parseFlagValue(args, '--repo', 'Error: --repo requires a value');
  const privacy = parseFlagValue(args, '--privacy', 'Error: --privacy must be private, sanitized, or public');
  if (privacy && !['private', 'sanitized', 'public'].includes(privacy)) {
    console.error('Error: --privacy must be private, sanitized, or public');
    process.exit(1);
  }
  const generatedAt = parseFlagValue(args, '--generated-at', 'Error: --generated-at requires an ISO timestamp value');
  const json = args.includes('--json');

  const { syncFortemiCoreIndex } = await import('./fortemi-core-sync.js');
  try {
    const cwd = process.cwd();
    loadUserGraphConfigs(cwd);
    loadGlobalGraphConfigs();
    const options = {
      repo,
      privacy: privacy as 'private' | 'sanitized' | 'public' | undefined,
      generatedAt,
    };
    if (all) {
      const { loadGraphIndexFile } = await import('./index-reader.js');
      const manifests = [];
      const failures: Array<{ graph: string; status: 'failed'; error: string }> = [];
      for (const [name] of orderedGraphEntries(Object.entries(GRAPH_CONFIGS))) {
        try {
          if (!loadGraphIndexFile(cwd, 'metadata.json', name)) continue;
          manifests.push(syncFortemiCoreIndex(cwd, { ...options, graph: name }));
        } catch (err) {
          failures.push({ graph: name, status: 'failed', error: err instanceof Error ? err.message : String(err) });
        }
      }
      if (failures.length) process.exitCode = 1;
      if (json) {
        console.log(JSON.stringify({ manifests, failures }, null, 2));
        return;
      }
      console.log(`Fortemi Core sync: ${manifests.length} graph(s) succeeded, ${failures.length} failed`);
      for (const manifest of manifests) {
        console.log(`  ${manifest.graph}: ${manifest.status}, ${manifest.item_count} item(s) → ${manifest.export_path}`);
      }
      for (const failure of failures) {
        console.error(`  ${failure.graph}: failed — ${failure.error}`);
      }
      return;
    }
    const manifest = syncFortemiCoreIndex(cwd, {
      ...options,
      graph,
    });
    if (json) {
      console.log(JSON.stringify(manifest, null, 2));
      return;
    }
    console.log(`Fortemi Core ${manifest.status}: ${manifest.item_count} item(s) → ${manifest.export_path}`);
  } catch (err) {
    console.error('Error: ' + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}

/**
 * Handle 'index migrate-legacy' command.
 */
async function handleMigrateLegacy(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: aiwg index migrate-legacy [--scope project|user|global | --all] [options]');
    console.log('');
    console.log('Migrates compatible legacy root index files into graph sidecar index');
    console.log('directories. Project scope moves .aiwg/.index/*.json to');
    console.log('.aiwg/.index/project/*.json and refreshes the Fortemi Core static');
    console.log('cache. User/global scopes report or migrate their corresponding');
    console.log('sidecar locations without modifying packaged/prebuilt AIWG indexes.');
    console.log('');
    console.log('Options:');
    console.log('  --scope <name>         Scope to migrate: project, user, or global (default: project)');
    console.log('  --all                  Migrate project, user, and global scopes');
    console.log('  --dry-run              Print planned changes without writing files');
    console.log('  --no-fortemi-sync      Do not refresh the project Fortemi Core static cache');
    console.log('  --generated-at <iso>   Override generated timestamp for deterministic fixtures');
    console.log('  --json                 Print the migration report as JSON');
    console.log('');
    console.log('Examples:');
    console.log('  aiwg index migrate-legacy --scope project --dry-run');
    console.log('  aiwg index migrate-legacy --all --json');
    return;
  }

  const all = args.includes('--all');
  const scopeValue = parseFlagValue(args, '--scope', 'Error: --scope requires project, user, or global');
  if (all && scopeValue) {
    console.error('Error: pass either --all or --scope, not both');
    process.exit(1);
  }
  const allowedScopes = ['project', 'user', 'global'] as const;
  const scopes = all
    ? [...allowedScopes]
    : scopeValue
      ? [scopeValue]
      : ['project'];
  const invalidScope = scopes.find((scope) => !allowedScopes.includes(scope as typeof allowedScopes[number]));
  if (invalidScope) {
    console.error('Error: --scope must be project, user, or global');
    process.exit(1);
  }

  const generatedAt = parseFlagValue(args, '--generated-at', 'Error: --generated-at requires an ISO timestamp value');
  const { migrateLegacyIndex } = await import('./legacy-index-migration.js');
  try {
    const report = migrateLegacyIndex(process.cwd(), {
      scopes: scopes as Array<'project' | 'user' | 'global'>,
      dryRun: args.includes('--dry-run'),
      syncFortemi: !args.includes('--no-fortemi-sync'),
      generatedAt,
    });

    if (args.includes('--json')) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(`Legacy index migration ${report.dryRun ? '(DRY RUN)' : 'complete'}`);
    for (const result of report.results) {
      const entries = result.entries === null ? 'unknown' : String(result.entries);
      const detail = result.reason ? ` — ${result.reason}` : '';
      console.log(`  ${result.scope}: ${result.status} (${entries} entries)${detail}`);
      for (const file of result.files) {
        console.log(`    ${file.name}: ${file.status}`);
      }
      if (result.fortemiCore) {
        console.log(
          `    fortemi-core: ${result.fortemiCore.status} (${result.fortemiCore.itemCount} item(s)) → ${result.fortemiCore.exportPath}`,
        );
      }
    }
    if (report.reportPath) {
      console.log(`  report: ${report.reportPath}`);
    }
  } catch (err) {
    console.error('Error: ' + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}

/**
 * Handle 'index deps' command
 *
 * Stub — full implementation in #417
 */
async function handleDeps(args: string[]): Promise<void> {
  const { showDeps } = await import('./dep-graph.js');
  const cwd = process.cwd();

  // First non-flag arg is the artifact path
  const artifactPath = firstPositionalArg(args, ['--backend', '--direction', '--depth', '--edge-type', '--graph']);
  if (!artifactPath) {
    console.error('Error: Artifact path required');
    console.log(
      'Usage: aiwg index deps <path> [--direction upstream|downstream|both] [--depth N] [--json] [--backend fortemi-core|local]',
    );
    process.exit(1);
  }

  const json = args.includes('--json');

  const direction = parseDirectionFlag(
    args,
    ['upstream', 'downstream', 'both'] as const,
    'both',
    'upstream, downstream, or both',
  );

  const depth = parsePositiveIntegerFlag(args, '--depth', 3, 'Error: --depth must be a positive integer');
  const edgeType = parseFlagValue(args, '--edge-type', 'Error: --edge-type requires a value');

  const graph = parseGraphFlag(args);
  const backend = parseBackendFlag(args) ?? 'fortemi-core';

  await showDeps(cwd, artifactPath, {
    direction,
    depth,
    json,
    graph,
    edgeType,
    backend,
  });
}

/**
 * Handle 'index stats' command
 *
 * Stub — full implementation in #418
 */
async function handleStats(args: string[]): Promise<void> {
  const { showStats } = await import('./stats.js');
  const cwd = process.cwd();

  const json = args.includes('--json');

  const graph = parseGraphFlag(args);

  await showStats(cwd, { json, graph });
}

/**
 * Handle 'index status' / 'index list' — enumerate the durable index-graph
 * registry with build state, freshness, and drift (#1624).
 */
async function handleStatus(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: aiwg index status [--json]');
    console.log('       aiwg index list   [--json]   (alias)');
    console.log('');
    console.log('Enumerate every registered index graph (built-in + module + operator)');
    console.log('with its build state, freshness, and drift. Surfaces durable indices that');
    console.log('are registered but never built, on-disk index dirs that match no graph,');
    console.log('and graph-config defs that previously failed to load silently (#1624).');
    console.log('');
    console.log('Examples:');
    console.log('  aiwg index status');
    console.log('  aiwg index status --json');
    return;
  }
  const { showIndexStatus } = await import('./index-status.js');
  await showIndexStatus(process.cwd(), { json: args.includes('--json') });
}

/**
 * Handle 'index neighbors' command
 *
 * @implements #725
 */
async function handleNeighbors(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: aiwg index neighbors --graph <name> --node <id> [options]');
    console.log('');
    console.log('Options:');
    console.log('  --graph <name>      Graph to query (required)');
    console.log('  --node <id>         Node path or REF-XXX identifier (required)');
    console.log('  --direction <dir>   in (upstream), out (downstream), or both (default: both)');
    console.log('  --edge-type <type>  Filter by edge type (e.g., "cites", "depends-on")');
  console.log('  --backend <name>    fortemi-core or local legacy fallback (default: fortemi-core)');
    console.log('  --json              Output as JSON');
    console.log('');
    console.log('Examples:');
    console.log('  aiwg index neighbors --graph citation-network --node REF-008 --direction in --edge-type cites');
    console.log('  aiwg index neighbors --graph project --node .aiwg/requirements/UC-001.md --json');
    return;
  }

  const { showNeighbors } = await import('./graph-query.js');
  const cwd = process.cwd();

  const graph = parseGraphFlag(args);
  if (!graph) {
    console.error('Error: --graph is required for neighbors command');
    process.exit(1);
  }

  let node = parseFlagValue(
    args,
    '--node',
    'Error: --node is required for neighbors command',
  );
  if (!node) {
    // Try first positional arg
    node = firstPositionalArg(args, ['--backend', '--direction', '--edge-type', '--graph', '--node']);
  }
  if (!node) {
    console.error('Error: --node is required for neighbors command');
    process.exit(1);
  }

  const direction = parseDirectionFlag(
    args,
    ['in', 'out', 'both'] as const,
    'both',
    'in, out, or both',
  );

  const edgeType = parseFlagValue(args, '--edge-type', 'Error: --edge-type requires a value');

  const json = args.includes('--json');
  const backend = parseSearchBackendFlag(args);

  await showNeighbors(cwd, { graph, node, direction, edgeType, json, backend });
}

/**
 * Handle 'index set' command
 *
 * @implements #725
 */
async function handleSetQuery(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: aiwg index set --graph <name> --op <operation> --node-a <id> --node-b <id> [options]');
    console.log('');
    console.log('Operations:');
    console.log('  intersection   Nodes in both neighbor sets');
    console.log('  union          Nodes in either neighbor set');
    console.log('  difference     Nodes in A but not in B');
    console.log('');
    console.log('Options:');
    console.log('  --graph <name>      Graph to query (required)');
    console.log('  --op <operation>    Set operation (required)');
    console.log('  --node-a <id>       First node (required)');
    console.log('  --node-b <id>       Second node (required)');
    console.log('  --direction <dir>   in (upstream) or out (downstream) (default: in)');
    console.log('  --edge-type <type>  Filter by edge type');
  console.log('  --backend <name>    fortemi-core or local legacy fallback (default: fortemi-core)');
    console.log('  --json              Output as JSON');
    console.log('');
    console.log('Examples:');
    console.log('  # Papers that cited both REF-008 and REF-016');
    console.log(
      '  aiwg index set --graph citation-network --op intersection --node-a REF-008 --node-b REF-016 --direction in',
    );
    console.log('');
    console.log('  # Papers cited by REF-004 but not cited by REF-001');
    console.log(
      '  aiwg index set --graph citation-network --op difference --node-a REF-004 --node-b REF-001 --direction out',
    );
    return;
  }

  const { executeSetQuery } = await import('./graph-query.js');
  const cwd = process.cwd();

  const graph = parseGraphFlag(args);
  if (!graph) {
    console.error('Error: --graph is required for set command');
    process.exit(1);
  }

  const op = parseFlagValue(
    args,
    '--op',
    'Error: --op is required (intersection, union, difference)',
  );
  if (!op || !['intersection', 'union', 'difference'].includes(op)) {
    console.error('Error: --op is required (intersection, union, difference)');
    process.exit(1);
  }

  const nodeA = parseFlagValue(args, '--node-a', 'Error: --node-a and --node-b are required');
  const nodeB = parseFlagValue(args, '--node-b', 'Error: --node-a and --node-b are required');

  if (!nodeA || !nodeB) {
    console.error('Error: --node-a and --node-b are required');
    process.exit(1);
  }

  const direction = parseDirectionFlag(
    args,
    ['in', 'out'] as const,
    'in',
    'in or out',
  );

  const edgeType = parseFlagValue(args, '--edge-type', 'Error: --edge-type requires a value');

  const json = args.includes('--json');
  const backend = parseSearchBackendFlag(args);

  await executeSetQuery(cwd, {
    graph,
    op: op as 'intersection' | 'union' | 'difference',
    nodeA,
    nodeB,
    direction,
    edgeType,
    json,
    backend,
  });
}

/** `index discover` flags that consume the following argument as a value. */
const DISCOVER_VALUE_FLAGS = new Set([
  '--type', '--limit', '--format', '--graph', '--backend', '--resource-source', '--aiwg-version',
]);

/**
 * Handle 'index discover' command — capability-search for AIWG operational
 * assets.
 *
 * Like `query` but tuned for capability lookups: ranks by trigger
 * phrase + capability description first, falls back to title/tag/path
 * matches. Defaults to the operational discovery surface,
 * narrowable via `--type`.
 *
 * Returns a token-tight format intended for in-context agent
 * consumption — path, score, type, top trigger, capability snippet.
 *
 * @implements #1214
 */
async function handleDiscover(args: string[]): Promise<void> {
  const { discoverCapability } = await import('./query-engine.js');
  const cwd = process.cwd();

  // Parse the positional phrase. Flags may appear before or after it — the
  // documented local-backend fallback is written flag-first
  // (`aiwg discover --backend local "<phrase>"`, #2530), so a phrase after a
  // value flag must not be swallowed as that flag's argument (#2559).
  const textParts: string[] = [];
  const flags: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      textParts.push(arg);
      continue;
    }
    flags.push(arg);
    const bare = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    const next = args[index + 1];
    if (DISCOVER_VALUE_FLAGS.has(bare) && !arg.includes('=') && next !== undefined && !next.startsWith('--')) {
      flags.push(next);
      index += 1;
    }
  }

  const phrase = textParts.join(' ').trim();
  if (!phrase) {
    console.error('Error: aiwg index discover requires a search phrase');
    console.log('');
    console.log(
      'Usage: aiwg index discover "<phrase>" [--type <kinds>] [--limit N] [--json|--format json|text] [--pretty|--compact] [--graph <name>] [--backend local|fortemi-core] [--resource-source local|web|auto] [--aiwg-version <version|range|digest|channel>] [--offline]',
    );
    console.log('');
    console.log('Examples:');
    console.log('  aiwg index discover "create intake"');
    console.log('  aiwg index discover "deploy production" --limit 5');
    console.log(`  aiwg index discover "audit security" --type ${OPERATIONAL_DISCOVERY_TYPES.join(',')}`);
    console.log('  aiwg index discover "intake" --format json --pretty');
    console.log('  aiwg discover "intake" --resource-source web --aiwg-version stable');
    process.exit(1);
  }

  const typeValue = parseFlagValue(flags, '--type', 'Error: --type requires a value');
  const typeFilter = typeValue
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // K=5 default — see query-engine.ts comment (#1218 Wave A).
  const limit = parsePositiveIntegerFlag(flags, '--limit', 5, 'Error: --limit must be a positive integer');
  const format = parseFlagValue(flags, '--format', 'Error: --format requires text or json') ?? 'text';
  if (format !== 'text' && format !== 'json') {
    console.error('Error: --format must be text or json');
    process.exit(1);
  }
  const json = flags.includes('--json') || format === 'json';
  if (flags.includes('--pretty') && flags.includes('--compact')) {
    console.error('Error: --pretty and --compact cannot be used together');
    process.exit(1);
  }
  const jsonPretty = !flags.includes('--compact');

  const graph = parseGraphFlag(flags);
  const backend = parseSearchBackendFlag(flags);
  const resourceSource = parseResourceSourceFlag(flags);
  const aiwgVersion = parseAiwgVersionFlag(flags);
  const offline = flags.includes('--offline');
  const webReleaseOptions = resourceSource === 'local'
    ? undefined
    : webReleaseOptionsFromEnvironment();

  await discoverCapability(cwd, {
    phrase,
    typeFilter,
    limit,
    json,
    jsonPretty,
    graph,
    backend,
    resourceSource,
    aiwgVersion,
    offline,
    webReleaseOptions,
    includePaths: false,
  });
}

/**
 * Handle 'index show' command — print the full text of a specific
 * artifact by type and name.
 *
 * Shape (#1218):
 *   aiwg show <type> <name> [--json] [--first] [--bound-rule-bodies] [--graph <name>] [--backend local|fortemi-core]
 *
 * Type is positional (not a flag) so the verb reads as
 * "show <kind> <name>". `<type>` is one of the operational show types.
 *
 * Companion to `discover`: where discover ranks candidates, show fetches
 * the artifact body so consumers don't need to navigate the filesystem.
 */
async function handleShow(args: string[]): Promise<void> {
  const { showArtifact, showMetadata } = await import('./query-engine.js');
  const cwd = process.cwd();

  const positional: string[] = [];
  const flags: string[] = [];
  let inFlags = false;
  for (const arg of args) {
    if (arg.startsWith('--')) inFlags = true;
    if (inFlags) flags.push(arg);
    else positional.push(arg);
  }

  const HELP_TEXT = [
    '',
    'Usage: aiwg show <type> <name> [--json] [--first] [--bound-rule-bodies] [--graph <name>] [--backend local|fortemi-core] [--resource-source local|web|auto] [--aiwg-version <version|range|digest|channel>] [--offline]',
    '       aiwg show metadata <id-or-name-or-path> [--json] [--first] [--bound-rule-bodies] [--graph <name>] [--backend local|fortemi-core] [--resource-source local|web|auto] [--aiwg-version <version|range|digest|channel>] [--offline]',
    '       aiwg index show <type> <name> ...',
    '',
    `Types: ${OPERATIONAL_SHOW_TYPES.join(' | ')}`,
    '',
    'Examples:',
    '  aiwg show skill intake-wizard',
    '  aiwg show skill flow-deploy-to-production --json',
    '  aiwg show flow flow-release --json',
    '  aiwg show behavior quiet-bot --json',
    '  aiwg show template config.toml --json',
    '  aiwg show metadata aiwg:skill:4840fa441622f676 --json',
    '  aiwg show agent aiwg-steward',
    '  aiwg show command discover',
    '  aiwg show skill intake-wizard --resource-source web --aiwg-version stable',
    '',
    'Bound rules: summaries and show pointers are appended for bound skills, agents, and flows.',
    'Use --bound-rule-bodies to include their full text (JSON: bound_rules[].content).',
    '',
    'Tip: use `aiwg discover "<phrase>" --json` first to find the stable id.',
  ].join('\n');

  if (positional.length === 0) {
    console.error('Error: aiwg show requires a type and name');
    console.error(HELP_TEXT);
    process.exit(1);
  }

  const firstLower = positional[0].toLowerCase();
  const metadataMode = firstLower === 'metadata';
  if (metadataMode) {
    positional.shift();
  }

  // Wave A (#1218): if the first positional is a known type, treat it
  // as the type. If it's NOT a known type, fall through to single-name
  // mode — `aiwg show intake-wizard` works as long as the name is
  // unambiguous across artifact types. Multi-type matches still error
  // with the disambiguation list (existing behavior in showArtifact).
  let type: string | null = null;
  let name: string;
  if (metadataMode) {
    name = positional.join(' ').trim();
    if (!name) {
      console.error('Error: aiwg show metadata requires an id, name, or path');
      console.error(HELP_TEXT);
      process.exit(1);
    }
  } else if (isOperationalShowType(firstLower)) {
    type = firstLower;
    name = positional.slice(1).join(' ').trim();
    if (!name) {
      console.error(`Error: aiwg show ${type} requires a name`);
      console.error(HELP_TEXT);
      process.exit(1);
    }
  } else {
    // Single-name fallback. Pass to showArtifact without a type filter
    // so its existing ambiguity logic kicks in: unique match → succeed,
    // multiple matches → list candidates and exit 2 (or pick first
    // with `--first`).
    name = positional.join(' ').trim();
  }

  let json = false;
  let first = false;

  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--json') {
      json = true;
    } else if (flags[i] === '--first') {
      first = true;
    }
  }

  const graph = parseGraphFlag(flags);
  const backend = parseSearchBackendFlag(flags);
  const resourceSource = parseResourceSourceFlag(flags);
  const aiwgVersion = parseAiwgVersionFlag(flags);
  const offline = flags.includes('--offline');
  const webReleaseOptions = resourceSource === 'local'
    ? undefined
    : webReleaseOptionsFromEnvironment();

  const params = {
    name,
    boundRuleBodies: flags.includes('--bound-rule-bodies'),
    typeFilter: type ? [type] : undefined,
    json,
    first,
    graph,
    backend,
    resourceSource,
    aiwgVersion,
    offline,
    webReleaseOptions,
  };

  if (metadataMode) await showMetadata(cwd, params);
  else await showArtifact(cwd, params);
}
