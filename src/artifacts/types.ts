/**
 * Artifact Index Types
 *
 * Shared TypeScript types for the artifact indexing system.
 * Used by index-builder, query-engine, dep-graph, and stats modules.
 *
 * @implements #420
 * @source @src/artifacts/cli.ts
 * @tests @test/unit/artifacts/index-builder.test.ts
 */

import fs from 'fs';
import { validateIndexGraphOverrides, type IndexBuiltinGraphOverride } from '../config/index-graph-overrides.js';
import os from 'node:os';
import path from 'node:path';
import { load as loadYaml } from 'js-yaml';
import type { OperationalStateProvenance } from './operational-state.js';
import type { StateTransferProjection } from './state-transfer.js';
import {
  DEFAULT_PROJECT_AIWG_DIR,
  projectAiwgPath,
  projectControlPath,
  resolveProjectAiwgDir,
} from '../config/project-artifacts.js';

/**
 * A single indexed artifact entry
 */
export interface MetadataEntry {
  /** Relative path from project root */
  path: string;

  /** Artifact type (use-case, adr, test-plan, nfr, threat-model, etc.) */
  type: string;

  /**
   * Exact declarative/process kind when the source format defines one.
   * Examples: `FlowPlaybook`, `OpsInventory`, and `Runbook`. This preserves
   * distinctions that are intentionally coarser in the top-level `type`.
   */
  kind?: string;

  /**
   * Physical/original artifact classification when semantic classification
   * changes the top-level type. A Markdown runbook under `templates/`, for
   * example, has `type: runbook` and `sourceType: template`.
   */
  sourceType?: string;

  /** SDLC phase (requirements, architecture, testing, security, deployment, etc.) */
  phase: string;

  /** Title from frontmatter or first heading */
  title: string;

  /**
   * Canonical short name (#1233). For skills this is the SKILL.md
   * directory basename (e.g. `aiwg-doctor`); for agents/commands/rules
   * the filename without extension; falls back to frontmatter `name`
   * when present. Used by the scorer to floor exact-name queries to 1.0
   * so that hyphenated kernel-skill names remain searchable even when
   * the rendered title strips the hyphen.
   */
  name?: string;

  /** Tags from frontmatter */
  tags: string[];

  /** ISO timestamp — file creation or frontmatter date */
  created: string;

  /** ISO timestamp — file modification */
  updated: string;

  /** Truncated SHA-256 hex (16 chars) for change detection */
  checksum: string;

  /** Brief content summary (max 500 chars) */
  summary: string;

  /** Outbound @-mention references (paths this artifact depends on) */
  dependencies: string[];

  /** Raw relative Markdown link targets parsed from this artifact. */
  markdownLinks?: string[];

  /** Computed: paths that reference this artifact */
  dependents: string[];

  /**
   * Trigger phrases extracted from the `## Triggers` section of skill / agent
   * descriptors. One entry per phrase, lowercased. Used by capability search
   * (#1214) to boost matches that hit a skill's declared activation phrase.
   */
  triggers?: string[];

  /**
   * Capability summary — what this artifact does, in one sentence.
   * Drawn from frontmatter `description` for skills/agents/commands/rules.
   * Used by capability search (#1214) for substring scoring above the
   * generic body summary.
   */
  capability?: string;

  /**
   * Compact, structure-aware language lookup terms. Process artifacts use
   * this for headings, step/capability identifiers, validation language, and
   * other signals that do not belong in a one-line summary.
   */
  searchTerms?: string[];

  /**
   * `kernel: true` from frontmatter. Marks always-loaded skills the
   * deploy pipeline routes to the platform-native skills directory
   * (#1212). Surfaced in the index for `aiwg index discover` so the
   * agent can prefer non-kernel skills when the kernel set already
   * covers a request.
   */
  kernel?: boolean;

  /**
   * Script entrypoint declaration for executable skills (#1227).
   *
   * When present, the skill has a backing script the CLI can invoke via
   * `aiwg run skill <name>`. Surfaced in `aiwg discover --json` as
   * `executable: true` + a `run_hint` so agents know to use the run
   * command instead of trying to execute the SKILL.md instructions
   * themselves.
   */
  script?: SkillScriptSpec;

  /**
   * Optional live-state provenance for tracker/repository observations. This
   * is exported only through the Fortemi v2 contract; v1 remains unchanged.
   */
  operationalState?: OperationalStateProvenance;

  /**
   * Explicit state-transfer projection for bridge consumers. This is distinct
   * from operationalState, which records observed external state and must not
   * be interpreted as persistence lifecycle.
   */
  stateTransfer?: StateTransferProjection;
}

/**
 * Skill script entrypoint declaration (#1227).
 *
 * Parsed from the optional `script:` block in a SKILL.md frontmatter. The
 * `entrypoint` is resolved relative to the skill's source directory; the
 * runtime executes from the calling project's root by default so relative
 * paths the script reads/writes resolve into the user's project, not the
 * AIWG install.
 */
export interface SkillScriptSpec {
  /** Path to the script file, relative to the skill's source directory */
  entrypoint: string;
  /** Runtime to dispatch with: node | python | python3 | bash | sh | pwsh | ruby | auto */
  runtime: string;
  /**
   * Working directory policy. Default is `project-root`: the script runs
   * from the project the CLI was invoked from, so relative paths resolve
   * into the caller's tree. `skill-dir` is rare (only for skills that
   * bundle assets they read via relative paths); `aiwg-root` is an escape
   * hatch and almost never correct.
   */
  cwd?: 'project-root' | 'skill-dir' | 'aiwg-root';
  /** Optional human-readable hint shown by `aiwg discover` and `aiwg show` */
  argsHint?: string;
}

/**
 * Operational artifact kinds that belong on the broad capability-discovery
 * surface. This is intentionally narrower than every indexed artifact type:
 * `query` remains the general document/artifact search surface, while
 * `discover` is for assets agents can act on or route to.
 */
export const OPERATIONAL_DISCOVERY_TYPES = [
  'skill',
  'agent',
  'command',
  'rule',
  'schema',
  'decision-definition',
  'decision-ruleset',
  'decision-binding',
  'gate-pack',
  'flow',
  'runbook',
  'template',
  'behavior',
] as const;

/**
 * Operational artifact kinds that `aiwg show <type> <name>` can fetch. Hooks
 * are operational but low-level, so they are showable and focus-searchable
 * without being part of broad discovery defaults.
 */
export const OPERATIONAL_SHOW_TYPES = [
  ...OPERATIONAL_DISCOVERY_TYPES,
  'hook',
] as const;

export type OperationalDiscoveryType = typeof OPERATIONAL_DISCOVERY_TYPES[number];
export type OperationalShowType = typeof OPERATIONAL_SHOW_TYPES[number];

export function isOperationalShowType(value: string): value is OperationalShowType {
  return (OPERATIONAL_SHOW_TYPES as readonly string[]).includes(value);
}

export const DEFAULT_INDEX_EXTENSIONS = ['.md', '.yaml', '.yml', '.json'] as const;

/**
 * Template assets are often provider-native files (`config.toml`,
 * `AGENTS.md.aiwg-template`, GitHub workflow `.yml`, JSONC snippets, etc.).
 * These extensions are only meaningful as operational templates when the file
 * is under a `templates/` directory; type inference enforces that boundary.
 */
export const TEMPLATE_INDEX_EXTENSIONS = [
  '.aiwg-template',
  '.aiwg-base',
  '.jsonc',
  '.tmpl',
  '.j2',
  '.csv',
  '.toml',
] as const;

export const FRAMEWORK_INDEX_EXTENSIONS = [
  ...DEFAULT_INDEX_EXTENSIONS,
  ...TEMPLATE_INDEX_EXTENSIONS,
] as const;

/**
 * The master artifact index stored at .aiwg/.index/metadata.json
 */
export interface ArtifactIndex {
  /** Index format version */
  version: string;

  /** Metadata extractor revision used to build the entries. */
  extractorVersion?: string;

  /** ISO timestamp of last build */
  builtAt: string;

  /** Build duration in milliseconds */
  buildTimeMs: number;

  /** All indexed entries keyed by path */
  entries: Record<string, MetadataEntry>;
}

/**
 * Tag reverse index stored at .aiwg/.index/tags.json
 */
export interface TagIndex {
  /** Tag name -> array of artifact paths */
  [tag: string]: string[];
}

/**
 * A typed edge in the dependency graph
 *
 * @implements #724
 */
export interface TypedEdge {
  /** Target artifact path */
  path: string;
  /** Relationship type (e.g., "depends-on", "cites", "cited-by", "summarizes") */
  type: string;
}

/**
 * Normalize a raw edge value to TypedEdge.
 * Handles backward compatibility: plain strings become { path, type: "depends-on" }.
 */
export function normalizeEdge(edge: string | TypedEdge): TypedEdge {
  if (typeof edge === 'string') return { path: edge, type: 'depends-on' };
  return edge;
}

/**
 * Normalize an array of raw edges to TypedEdge[].
 */
export function normalizeEdges(edges: (string | TypedEdge)[]): TypedEdge[] {
  return edges.map(normalizeEdge);
}

/**
 * Dependency graph stored at .aiwg/.index/dependencies.json
 *
 * @implements #724
 */
export interface DependencyGraph {
  /** Path -> upstream and downstream relationships */
  [path: string]: {
    /** Artifacts this one depends on (typed edges) */
    upstream: TypedEdge[];
    /** Artifacts that depend on this one (typed edges) */
    downstream: TypedEdge[];
  };
}

/**
 * Index statistics stored at .aiwg/.index/stats.json
 */
export interface IndexStats {
  /** Index format version */
  version: string;

  /** Metadata extractor revision used for the corresponding index. */
  extractorVersion?: string;

  /** ISO timestamp of last build */
  builtAt: string;

  /** Build duration in milliseconds */
  buildTimeMs: number;

  /** Total artifact count */
  totalArtifacts: number;

  /** Counts by SDLC phase */
  byPhase: Record<string, number>;

  /** Counts by artifact type */
  byType: Record<string, number>;

  /** Tag name -> count */
  tagDistribution: Record<string, number>;

  /** Dependency graph metrics */
  graphMetrics: {
    /**
     * Unique directed relationships. For citation graphs this is a
     * compatibility alias for canonicalEdges.
     */
    totalEdges: number;
    /** Unique directed source -> target citations declared by outgoing tables. */
    canonicalEdges?: number;
    /** Parsed outgoing citation declarations after per-sidecar deduplication. */
    outgoingDeclarations?: number;
    /** Parsed incoming/cited-by declarations after per-sidecar deduplication. */
    incomingDeclarations?: number;
    /** Stored upstream plus downstream adjacency entries. */
    adjacencyEntries?: number;
    /** Edges derived from relative Markdown links that resolve to indexed nodes. */
    markdownLinkEdges?: number;
    /** Canonical outgoing citations without a matching incoming declaration. */
    unmirroredOutgoing?: number;
    /** Incoming declarations without a matching canonical outgoing citation. */
    unmirroredIncoming?: number;
    orphanedArtifacts: number;
    mostReferenced: { path: string; count: number } | null;
  };
}

/**
 * Result from a query operation
 */
export interface QueryResult {
  /** The matching entry */
  entry: MetadataEntry;

  /** Relevance score (0-1) */
  score: number;
}

/**
 * Query parameters for artifact search
 */
export interface QueryParams {
  /** Keyword search term */
  text?: string;

  /** Filter by path glob pattern */
  path?: string;

  /** Filter by artifact type */
  type?: string;

  /** Filter by SDLC phase */
  phase?: string;

  /** Filter by tags (AND logic) */
  tags?: string[];

  /** Filter by modification date */
  updatedAfter?: string;

  /** Maximum results */
  limit?: number;

  /**
   * Lexical full-text search over artifact bodies (BM25), instead of the
   * default metadata/summary-scoped scoring. Reads candidate node bodies at
   * query time. Distinct from `--semantic` (conceptual). See #1494.
   */
  fulltext?: boolean;
}

/**
 * Phase name to directory mapping
 */
export const PHASE_DIRECTORIES: Record<string, string> = {
  requirements: '.aiwg/requirements',
  architecture: '.aiwg/architecture',
  testing: '.aiwg/testing',
  security: '.aiwg/security',
  deployment: '.aiwg/deployment',
  risks: '.aiwg/risks',
  planning: '.aiwg/planning',
  intake: '.aiwg/intake',
  reports: '.aiwg/reports',
};

/**
 * Default index output directory
 */
export const INDEX_DIR = '.aiwg/.index';

/**
 * Current index format version
 */
export const INDEX_VERSION = '1.0.0';

/**
 * Metadata extraction revision. Unlike INDEX_VERSION, this can change without
 * making the serialized index schema incompatible; a mismatch simply forces a
 * one-time content re-extraction during the next incremental build.
 */
export const INDEX_EXTRACTOR_VERSION = '2026.08.24.1';

/**
 * Built-in graph type identifiers
 *
 * @implements #421 #426
 */
export type BuiltinGraphType = 'framework' | 'project' | 'codebase' | 'source' | 'user';

/**
 * Any graph identifier — built-in or user-defined via .aiwg/config.yaml
 *
 * @implements #426
 */
export type GraphType = string;

/**
 * Edge extraction configuration for a graph
 *
 * @implements #722
 */
export interface EdgeExtractionConfig {
  /** Parser to use for edge extraction */
  parser: 'citation-sidecar';

  /** Edge definitions to extract */
  edges: Array<{
    /** Edge type label (e.g., "cites", "cited-by") */
    type: string;
    /** Source field path (e.g., "frontmatter.ref") */
    source: string;
    /** Target field path (e.g., "outgoing-table.inducted-ref") */
    target: string;
    /** Skip rows where the target column is empty or dash */
    skipEmpty?: boolean;
  }>;
}

/**
 * Metadata supplement configuration — merge fields from sidecar files
 *
 * @implements #723
 */
export interface MetadataSupplementConfig {
  /** Directory to scan for sidecar files */
  scanDir: string;
  /** Frontmatter field to match against (e.g., "frontmatter.ref") */
  matchOn: string;
  /** Captured group name from filenamePattern to match against */
  nodeKey: string;
  /** Fields to merge from the sidecar frontmatter into the node */
  mergeFields: string[];
}

/**
 * Graph configuration — defines what each graph indexes
 */
/**
 * A non-fatal problem encountered while loading graph configs (#1624).
 *
 * Historically `loadModuleGraphConfigs` / `loadUserGraphConfigs` swallowed
 * malformed graph definitions in best-effort `try/catch`, so a misconfigured
 * durable index silently never loaded ("not found to be working properly").
 * Callers that care (e.g. `aiwg index status`, `aiwg doctor`) pass a
 * diagnostics array to surface these instead of dropping them.
 */
export interface GraphConfigWarning {
  /** Graph name (or module id when the manifest itself is unparseable). */
  graph: string;
  /** Human-readable reason the definition was rejected. */
  reason: string;
  /** Where the bad definition came from. */
  source: 'module' | 'operator-config';
}

export interface GraphConfig {
  /** Graph type identifier */
  type: string;

  /** Directories to scan (relative to project/framework root) */
  scanDirs: string[];

  /** File extensions to index */
  extensions: string[];

  /** Whether this graph is shared across projects */
  shared: boolean;

  /** Whether to include in default `aiwg index build` (no --graph flag) */
  defaultBuild: boolean;

  /**
   * Build tier used to order multi-graph build/sync runs. Lightweight corpus
   * graphs become queryable before standard/heavy graphs backfill (#1720).
   */
  buildTier?: 'lightweight' | 'standard' | 'heavy';

  /**
   * Optional numeric ordering within/across tiers. Lower values build/sync
   * first. Use this for refs → citations → bibliography ordering (#1720).
   */
  buildOrder?: number;

  /** Optional edge extraction configuration */
  edgeExtraction?: EdgeExtractionConfig;

  /**
   * Node creation strategy.
   * - 'default': read file content, parse frontmatter (standard behavior)
   * - 'filename-metadata': derive metadata from filename regex, skip content reading
   *
   * @implements #723
   */
  nodeStrategy?: 'default' | 'filename-metadata';

  /**
   * Named-capture regex for extracting metadata from filenames.
   * Only used when nodeStrategy is 'filename-metadata'.
   * Example: "REF-(?P<ref>\\d{3})-(?P<author>[^-]+)-(?P<year>\\d{4})-(?P<slug>.+)\\.pdf"
   *
   * @implements #723
   */
  filenamePattern?: string;

  /**
   * Optional sidecar files that can enrich node metadata.
   * Merges frontmatter fields from matching sidecar files into the node.
   *
   * @implements #723
   */
  metadataSupplements?: MetadataSupplementConfig[];

  /**
   * Graph storage backend for this graph.
   * - 'json' (default): zero-dep adjacency list
   * - 'graphology': rich traversal, community detection (`aiwg features install graph`)
   * - 'sqlite': persistent on-disk, SQL set operations (`aiwg features install sqlite`)
   *
   * @implements #727
   */
  graphBackend?: 'json' | 'graphology' | 'sqlite';

  /**
   * Optional embedding index configuration for semantic similarity queries.
   * Enable with: aiwg features install embeddings
   *
   * @implements #730
   */
  embedding?: {
    /** Enable embedding index for this graph */
    enabled: boolean;
    /** Model to use (default: Xenova/all-MiniLM-L6-v2) */
    model?: string;
    /** Number of results for semantic queries (default: 10) */
    topK?: number;
    /** When to rebuild: 'content-change' | 'always' | 'never' */
    rebuildOn?: 'content-change' | 'always' | 'never';
  };
}

/**
 * Built-in graph definitions
 */
export const BUILTIN_GRAPH_CONFIGS: Record<BuiltinGraphType, GraphConfig> = {
  framework: {
    type: 'framework',
    // Includes `agentic/code/extensions` and
    // `agentic/code/behaviors` so extension bundles (sys, net, it, sec,
    // stream, dev) and top-level behaviors (concierge, security-sentinel, ...)
    // appear in `aiwg discover` alongside frameworks and addons. Marketplace
    // plugin bundles under `agentic/code/plugins` are provider/package mirrors
    // of canonical framework/addon/extension capabilities, so they are
    // intentionally excluded from the capability graph to avoid duplicate
    // records, slower searches, and inflated Fortemi caches. `inferType()` in
    // index-builder.ts uses nearest-type-dir ancestor matching to handle
    // every nested layout (slug vs flat, frameworks/<f>/extensions/<sub>,
    // research-complete/elaboration/{agents,commands}, etc.).
    scanDirs: [
      'agentic/code/frameworks',
      'agentic/code/addons',
      'agentic/code/extensions',
      'agentic/code/agents',
      'agentic/code/behaviors',
      'docs',
    ],
    extensions: [...FRAMEWORK_INDEX_EXTENSIONS],
    shared: true,
    // Not built by `aiwg index build` (no flag) — that would write to
    // the shared XDG location from any project. Freshness is guaranteed
    // by the explicit post-deploy rebuild in `useHandler` (#1212/#1214)
    // and by `aiwg index build --graph framework` for manual rebuilds.
    defaultBuild: false,
    buildTier: 'standard',
  },
  project: {
    type: 'project',
    scanDirs: ['.aiwg'],
    // Project-local bundles are byte-compatible pilots of upstream
    // extensions/addons/frameworks/plugins. Scan the same provider-native
    // template extensions as the framework graph so local assets do not
    // disappear from discover/show merely because they have not been
    // promoted upstream yet.
    extensions: [...FRAMEWORK_INDEX_EXTENSIONS],
    shared: false,
    defaultBuild: true,
    buildTier: 'standard',
  },
  codebase: {
    type: 'codebase',
    scanDirs: ['src', 'test', 'tools'],
    extensions: ['.ts', '.mts', '.js', '.mjs', '.json', '.yaml', '.yml'],
    shared: false,
    defaultBuild: true,
    buildTier: 'heavy',
  },
  source: {
    type: 'source',
    scanDirs: ['src', 'tools', 'test', 'config', 'bin', 'apps', 'vscode-extension'],
    extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
    shared: false,
    defaultBuild: false,
    buildTier: 'heavy',
  },
  user: {
    type: 'user',
    scanDirs: [
      '~/.aiwg/skills',
      '~/.aiwg/agents',
      '~/.aiwg/commands',
      '~/.aiwg/rules',
      '~/.aiwg/flows',
      '~/.aiwg/runbooks',
      '~/.aiwg/frameworks',
      '~/.aiwg/addons',
      '~/.aiwg/extensions',
      '~/.aiwg/plugins',
      '~/.aiwg/providers',
    ],
    extensions: [...DEFAULT_INDEX_EXTENSIONS],
    shared: true,
    defaultBuild: false,
    buildTier: 'standard',
  },
};

/**
 * Mutable graph configs — starts with built-ins, extended by user config
 *
 * @implements #426
 */
export const GRAPH_CONFIGS: Record<string, GraphConfig> = { ...BUILTIN_GRAPH_CONFIGS };

let projectGraphBackend: GraphConfig['graphBackend'];

/** Resolve backend precedence: graph override, project default, then JSON. */
export function resolveGraphBackendType(graph?: GraphType): NonNullable<GraphConfig['graphBackend']> {
  return (graph ? GRAPH_CONFIGS[graph]?.graphBackend : undefined) ?? projectGraphBackend ?? 'json';
}

function freshBuiltinGraphConfig(name: BuiltinGraphType): GraphConfig {
  const config = BUILTIN_GRAPH_CONFIGS[name];
  return {
    ...config,
    scanDirs: [...config.scanDirs],
    extensions: [...config.extensions],
  };
}

/**
 * Detect conventional Python layouts without treating every top-level folder
 * as source. A Python project manifest activates `.py`/`.pyi` support; package
 * roots are immediate directories containing `__init__.py`, plus the common
 * `tests/` and `scripts/` roots when present.
 */
function detectPythonCodebaseConfig(cwd: string, base: GraphConfig): GraphConfig {
  const hasPythonManifest = ['pyproject.toml', 'setup.py', 'setup.cfg']
    .some((manifest) => fs.existsSync(path.join(cwd, manifest)));
  if (!hasPythonManifest) return base;

  const detectedRoots: string[] = [];
  for (const root of ['tests', 'scripts']) {
    if (fs.existsSync(path.join(cwd, root))) detectedRoots.push(root);
  }

  const excluded = new Set([
    '.aiwg', '.git', '.github', '.venv', 'venv', 'node_modules',
    'src', 'test', 'tests', 'tools', 'scripts', 'docs', 'documentation',
  ]);
  try {
    for (const entry of fs.readdirSync(cwd, { withFileTypes: true })) {
      if (!entry.isDirectory() || excluded.has(entry.name) || entry.name.startsWith('.')) continue;
      if (fs.existsSync(path.join(cwd, entry.name, '__init__.py'))) detectedRoots.push(entry.name);
    }
  } catch {
    // Layout detection is best-effort; the immutable defaults still apply.
  }

  return {
    ...base,
    scanDirs: [...new Set([...base.scanDirs, ...detectedRoots])],
    extensions: [...new Set([...base.extensions, '.py', '.pyi'])],
  };
}

function applyBuiltinGraphOverride(base: GraphConfig, override: IndexBuiltinGraphOverride | undefined): GraphConfig {
  if (!override) return base;
  return {
    ...base,
    scanDirs: override.scanDirs ? [...override.scanDirs] : base.scanDirs,
    extensions: override.extensions ? [...override.extensions] : base.extensions,
  };
}

/**
 * Normalize metadataSupplements entries.
 *
 * Accepts the shorthand `match: "frontmatter.<field>"` and expands it to
 * `matchOn` + `nodeKey`. This lets users write the compact form in config:
 *
 *   match: frontmatter.ref
 *
 * instead of the explicit two-field form:
 *
 *   matchOn: frontmatter.ref
 *   nodeKey: ref
 *
 * @implements #738
 */
function normalizeSupplements(raw: Record<string, unknown>[]): MetadataSupplementConfig[] {
  return raw.map((entry) => {
    let matchOn = entry.matchOn as string | undefined;
    let nodeKey = entry.nodeKey as string | undefined;

    // Accept "match" shorthand: derive matchOn and nodeKey from it
    if (!matchOn && typeof entry.match === 'string') {
      matchOn = entry.match;
    }

    // Derive nodeKey from matchOn if not explicitly provided
    // e.g. "frontmatter.ref" -> nodeKey "ref"
    if (!nodeKey && matchOn) {
      nodeKey = matchOn.replace(/^frontmatter\./, '');
    }

    return {
      scanDir: entry.scanDir as string,
      matchOn: matchOn ?? '',
      nodeKey: nodeKey ?? '',
      mergeFields: Array.isArray(entry.mergeFields) ? entry.mergeFields as string[] : [],
    };
  });
}

/**
 * Parse a raw graph definition object into a GraphConfig.
 *
 * Shared between loadUserGraphConfigs and loadModuleGraphConfigs.
 */
function parseGraphDef(name: string, graphDef: Record<string, unknown>): GraphConfig | null {
  if (!Array.isArray(graphDef.scanDirs)) return null;

  return {
    type: name,
    scanDirs: graphDef.scanDirs as string[],
    extensions: Array.isArray(graphDef.extensions) ? graphDef.extensions as string[] : [...DEFAULT_INDEX_EXTENSIONS],
    shared: graphDef.shared === true,
    defaultBuild: graphDef.defaultBuild !== false,
    buildTier:
      graphDef.buildTier === 'lightweight' || graphDef.buildTier === 'standard' || graphDef.buildTier === 'heavy'
        ? graphDef.buildTier
        : undefined,
    buildOrder: typeof graphDef.buildOrder === 'number' && Number.isFinite(graphDef.buildOrder)
      ? graphDef.buildOrder
      : undefined,
    edgeExtraction: graphDef.edgeExtraction as EdgeExtractionConfig | undefined,
    nodeStrategy: graphDef.nodeStrategy as GraphConfig['nodeStrategy'],
    filenamePattern: typeof graphDef.filenamePattern === 'string' ? graphDef.filenamePattern : undefined,
    metadataSupplements: Array.isArray(graphDef.metadataSupplements)
      ? normalizeSupplements(graphDef.metadataSupplements as Record<string, unknown>[])
      : undefined,
    graphBackend: typeof graphDef.graphBackend === 'string'
      ? graphDef.graphBackend as GraphConfig['graphBackend']
      : undefined,
  };
}

const BUILD_TIER_ORDER: Record<NonNullable<GraphConfig['buildTier']>, number> = {
  lightweight: 10,
  standard: 50,
  heavy: 90,
};

function inferredGraphBuildOrder(name: string): number {
  const normalized = name.toLowerCase();
  if (/(^|[-_])(refs?|references?)([-_]|$)/.test(normalized)) return 10;
  if (/(citation|citations|cites|citation-network)/.test(normalized)) return 20;
  if (/(bib|bibliography)/.test(normalized)) return 30;
  if (/(summary|summaries)/.test(normalized)) return 40;
  if (/(paper|papers|source|codebase|embedding|full)/.test(normalized)) return 90;
  return 50;
}

export function graphBuildOrder(name: string, config: GraphConfig): number {
  if (typeof config.buildOrder === 'number' && Number.isFinite(config.buildOrder)) {
    return config.buildOrder;
  }
  if (config.buildTier) return BUILD_TIER_ORDER[config.buildTier];
  return inferredGraphBuildOrder(name);
}

export function orderedGraphEntries(
  entries: Array<[string, GraphConfig]>,
): Array<[string, GraphConfig]> {
  return [...entries].sort(([leftName, leftConfig], [rightName, rightConfig]) => {
    const orderCmp = graphBuildOrder(leftName, leftConfig) - graphBuildOrder(rightName, rightConfig);
    if (orderCmp !== 0) return orderCmp;
    return leftName.localeCompare(rightName);
  });
}

/**
 * Load graph configs declared in framework/addon manifest.json files.
 *
 * Reads `.aiwg/frameworks/registry.json` to find installed modules,
 * then loads each module's manifest and merges `index.graphs` declarations
 * into GRAPH_CONFIGS. Module-declared graphs cannot override built-in names.
 *
 * This runs before operator config so that .aiwg/config.yaml can override
 * module-declared graphs.
 *
 * @param cwd - Project root directory
 * @returns Names of module-declared graphs that were loaded
 *
 * @implements #726
 */
export function loadModuleGraphConfigs(cwd: string, diagnostics?: GraphConfigWarning[]): string[] {
  const registryPath = projectAiwgPath(cwd, 'frameworks', 'registry.json');
  const loaded: string[] = [];

  try {
    if (!fs.existsSync(registryPath)) return loaded;

    const registryContent = fs.readFileSync(registryPath, 'utf-8');
    const registry = JSON.parse(registryContent) as {
      frameworks?: Array<{ id: string }>;
    };

    if (!Array.isArray(registry.frameworks)) return loaded;

    // Search paths for manifest.json (framework source locations)
    const searchRoots = [
      `${cwd}/agentic/code/frameworks`,
      `${cwd}/agentic/code/addons`,
      `${cwd}/agentic/code/plugins`,
    ];

    for (const entry of registry.frameworks) {
      const id = entry.id;
      let manifestData: Record<string, unknown> | null = null;

      // Try each search root to find the manifest
      for (const root of searchRoots) {
        const manifestPath = `${root}/${id}/manifest.json`;
        if (fs.existsSync(manifestPath)) {
          try {
            manifestData = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          } catch {
            // Malformed manifest — skip, but surface it (#1624) instead of
            // dropping silently.
            diagnostics?.push({
              graph: id,
              reason: `manifest.json is not valid JSON (${manifestPath})`,
              source: 'module',
            });
          }
          break;
        }
      }

      if (!manifestData) continue;

      // Extract index.graphs from manifest
      const indexSection = manifestData.index as Record<string, unknown> | undefined;
      if (!indexSection || typeof indexSection !== 'object') continue;

      const graphs = indexSection.graphs as Record<string, unknown> | undefined;
      if (!graphs || typeof graphs !== 'object') continue;

      for (const [name, def] of Object.entries(graphs)) {
        if (name in BUILTIN_GRAPH_CONFIGS) continue;
        // Module graphs don't override already-loaded graphs (first module wins)
        if (name in GRAPH_CONFIGS && !(name in BUILTIN_GRAPH_CONFIGS)) continue;

        const config = parseGraphDef(name, def as Record<string, unknown>);
        if (config) {
          GRAPH_CONFIGS[name] = config;
          loaded.push(name);
        } else {
          // #1624 — a declared-but-invalid graph (e.g. missing/non-array
          // scanDirs) used to vanish silently. Report it.
          diagnostics?.push({
            graph: name,
            reason: 'invalid graph definition — `scanDirs` is missing or not an array',
            source: 'module',
          });
        }
      }
    }
  } catch {
    // Module config loading is best-effort
  }

  return loaded;
}

/**
 * Load user-defined graph configs from .aiwg/config.yaml
 *
 * Also loads module-declared graphs from installed framework manifests.
 * Module graphs are loaded first; operator config overrides them.
 * Neither can override built-in graph names.
 *
 * @param cwd - Project root directory
 * @returns Names of user-defined graphs that were loaded (includes module graphs)
 *
 * @implements #426 #726
 */
export function loadUserGraphConfigs(cwd: string, diagnostics?: GraphConfigWarning[]): string[] {
  // Built-ins are immutable in index.graphs, but project/codebase scan fields may
  // be adapted through the explicitly bounded graphOverrides contract (#2123).
  // Reset on every project load so a prior cwd cannot leak its override or
  // detected Python package roots into a later build in the same process.
  GRAPH_CONFIGS.project = freshBuiltinGraphConfig('project');
  GRAPH_CONFIGS.codebase = detectPythonCodebaseConfig(cwd, freshBuiltinGraphConfig('codebase'));
  projectGraphBackend = undefined;

  // Load module-declared graphs first (frameworks/addons)
  const moduleLoaded = loadModuleGraphConfigs(cwd, diagnostics);
  const loaded: string[] = [...moduleLoaded];

  // Resolve the operator's index.graphs source. Canonical home is
  // the configured artifact root's aiwg.config (JSON, #1491); the legacy
  // config.yaml is a
  // deprecated fallback so un-migrated corpora keep working.
  let graphs: Record<string, unknown> | undefined;
  let graphOverrides: unknown;
  let fromDeprecatedYaml = false;
  let canonicalIndexPresent = false;

  // (a) Canonical: .aiwg/aiwg.config (JSON).
  try {
    const aiwgConfigPath = projectControlPath(cwd, 'aiwg.config');
    if (fs.existsSync(aiwgConfigPath)) {
      const parsed = JSON.parse(fs.readFileSync(aiwgConfigPath, 'utf-8')) as Record<string, unknown>;
      const idx = parsed.index as Record<string, unknown> | undefined;
      canonicalIndexPresent = idx !== undefined;
      if (idx?.graphBackend === 'json' || idx?.graphBackend === 'graphology' || idx?.graphBackend === 'sqlite') projectGraphBackend = idx.graphBackend;
      const g = idx?.graphs as Record<string, unknown> | undefined;
      if (g && typeof g === 'object') graphs = g;
      const overrides = idx?.graphOverrides as Record<string, unknown> | undefined;
      graphOverrides = overrides;
    }
  } catch {
    // #1624 — surface a malformed aiwg.config rather than dropping the whole
    // index block silently.
    diagnostics?.push({
      graph: '.aiwg/aiwg.config',
      reason: 'aiwg.config is not valid JSON — index.graphs not loaded',
      source: 'operator-config',
    });
  }

  // (b) Fallback: legacy .aiwg/config.yaml.
  if (!canonicalIndexPresent && !graphs && !graphOverrides) {
    try {
      const configPath = projectAiwgPath(cwd, 'config.yaml');
      if (fs.existsSync(configPath)) {
        const config = loadYaml(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown> | null;
        const idx = config?.index as Record<string, unknown> | undefined;
        if (idx?.graphBackend === 'json' || idx?.graphBackend === 'graphology' || idx?.graphBackend === 'sqlite') projectGraphBackend = idx.graphBackend;
        const g = idx?.graphs as Record<string, unknown> | undefined;
        if (g && typeof g === 'object') {
          graphs = g;
          fromDeprecatedYaml = true;
        }
        const overrides = idx?.graphOverrides as Record<string, unknown> | undefined;
        if (overrides !== undefined) {
          graphOverrides = overrides;
          fromDeprecatedYaml = true;
        }
      }
    } catch {
      // best-effort
    }
  }

  const warnOverride = (graph: string, reason: string): void => {
    if (diagnostics) diagnostics.push({ graph, reason, source: 'operator-config' });
    else console.warn(`[aiwg index] Warning: ${reason}`);
  };
  const overrideErrors = validateIndexGraphOverrides(graphOverrides);
  for (const reason of overrideErrors) warnOverride('graphOverrides', reason);
  if (graphOverrides && typeof graphOverrides === 'object' && !Array.isArray(graphOverrides)) {
    for (const name of ['project', 'codebase'] as const) {
      const override = (graphOverrides as Record<string, unknown>)[name];
      if (override === undefined || validateIndexGraphOverrides({ [name]: override }).length > 0) continue;
      GRAPH_CONFIGS[name] = applyBuiltinGraphOverride(GRAPH_CONFIGS[name], override as IndexBuiltinGraphOverride);
    }
  }

  if (!graphs) return loaded;

  if (fromDeprecatedYaml && !yamlIndexDeprecationWarned) {
    yamlIndexDeprecationWarned = true;
    process.stderr.write(
      '[aiwg index] note: index.graphs in .aiwg/config.yaml is deprecated — move the index block into .aiwg/aiwg.config (see docs/cli/reference.md, #1491).\n',
    );
  }

  for (const [name, def] of Object.entries(graphs)) {
    if (name in BUILTIN_GRAPH_CONFIGS) {
      warnOverride(name, `index.graphs.${name}: built-in graph definitions cannot be overridden here; ` +
        (name === 'project' || name === 'codebase'
          ? `use index.graphOverrides.${name} (supported: scanDirs, extensions)`
          : 'no built-in override is supported for this graph'));
      continue;
    }
    const graphConfig = parseGraphDef(name, def as Record<string, unknown>);
    if (!graphConfig) {
      // #1624 — report the invalid operator-declared graph instead of the
      // historical silent `continue`.
      diagnostics?.push({
        graph: name,
        reason: 'invalid graph definition — `scanDirs` is missing or not an array',
        source: 'operator-config',
      });
      continue;
    }
    // Operator config overrides module-declared graphs; built-ins are protected above.
    GRAPH_CONFIGS[name] = graphConfig;
    if (!moduleLoaded.includes(name)) loaded.push(name);
  }

  return loaded;
}

/**
 * Load user/global graph configs from ~/.aiwg/aiwg.config.
 *
 * These graphs are shared across projects and written to the XDG AIWG index
 * sidecar. They intentionally cannot override built-in graph names or
 * project/operator graph names; project-local definitions remain more
 * specific than broad user-level defaults.
 */
export function loadGlobalGraphConfigs(diagnostics?: GraphConfigWarning[]): string[] {
  const loaded: string[] = [];
  const home = process.env.HOME;
  if (!home) return loaded;
  const configPath = `${home}/.aiwg/aiwg.config`;
  let graphs: Record<string, unknown> | undefined;
  let rootGraphs: Record<string, unknown> | undefined;
  try {
    if (!fs.existsSync(configPath)) return loaded;
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const index = parsed.index as Record<string, unknown> | undefined;
    const g = index?.graphs as Record<string, unknown> | undefined;
    if (g && typeof g === 'object') graphs = g;
    const indices = parsed.indices as Record<string, unknown> | undefined;
    const user = indices?.user as Record<string, unknown> | undefined;
    const roots = user?.roots as Record<string, unknown> | undefined;
    if (roots && typeof roots === 'object') rootGraphs = roots;
  } catch {
    diagnostics?.push({
      graph: '~/.aiwg/aiwg.config',
      reason: 'user aiwg.config is not valid JSON — index.graphs not loaded',
      source: 'operator-config',
    });
    return loaded;
  }
  if (rootGraphs) {
    for (const [name, rawRoot] of Object.entries(rootGraphs)) {
      if (name in GRAPH_CONFIGS) continue;
      if (!rawRoot || typeof rawRoot !== 'object' || Array.isArray(rawRoot)) {
        diagnostics?.push({
          graph: name,
          reason: 'invalid user-level root definition — expected an object with `path`',
          source: 'operator-config',
        });
        continue;
      }
      const root = rawRoot as Record<string, unknown>;
      if (typeof root.path !== 'string' || root.path.trim() === '') {
        diagnostics?.push({
          graph: name,
          reason: 'invalid user-level root definition — `path` is required',
          source: 'operator-config',
        });
        continue;
      }
      GRAPH_CONFIGS[name] = {
        type: name,
        scanDirs: [root.path],
        extensions: Array.isArray(root.extensions) ? root.extensions.map(String) : ['.md', '.yaml', '.json'],
        shared: true,
        defaultBuild: false,
      };
      loaded.push(name);
    }
  }
  if (!graphs) return loaded;
  for (const [name, def] of Object.entries(graphs)) {
    if (name in GRAPH_CONFIGS) continue;
    const graphConfig = parseGraphDef(name, def as Record<string, unknown>);
    if (!graphConfig) {
      diagnostics?.push({
        graph: name,
        reason: 'invalid user-level graph definition — `scanDirs` is missing or not an array',
        source: 'operator-config',
      });
      continue;
    }
    GRAPH_CONFIGS[name] = { ...graphConfig, shared: true };
    loaded.push(name);
  }
  return loaded;
}

/** Module-scoped guard so the config.yaml deprecation note prints at most once per process. */
let yamlIndexDeprecationWarned = false;

/**
 * Get the index output directory for a given graph type
 *
 * @param cwd - Project root
 * @param graphType - Graph type
 * @returns Absolute path to the graph's index directory
 */
export function getGraphIndexDir(cwd: string, graphType: GraphType): string {
  const config = GRAPH_CONFIGS[graphType];
  if (graphType === 'framework' || config?.shared) {
    // Shared across projects — XDG data directory
    const xdgData = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
    return path.join(xdgData, 'aiwg', 'index', graphType);
  }
  return path.join(getProjectIndexRoot(cwd), graphType);
}

/**
 * Resolve the project-local index root for the configured AIWG artifact dir.
 */
export function getProjectIndexRoot(cwd: string): string {
  return path.join(resolveProjectAiwgDir(cwd), '.index');
}

/**
 * Resolve graph scan directories using the same AIWG artifact root contract as
 * runtime config/storage. This keeps built-in project graph paths virtualized
 * as `.aiwg/...` while allowing the physical directory to be renamed or moved.
 */
export function resolveGraphScanDir(cwd: string, scanDir: string): string {
  if (scanDir === '~') return process.env.HOME ?? scanDir;
  if (scanDir.startsWith('~/')) {
    return path.join(process.env.HOME ?? '', scanDir.slice(2));
  }
  if (path.isAbsolute(scanDir)) return scanDir;
  if (scanDir === DEFAULT_PROJECT_AIWG_DIR) return resolveProjectAiwgDir(cwd);
  if (scanDir.startsWith(`${DEFAULT_PROJECT_AIWG_DIR}/`)) {
    return path.join(resolveProjectAiwgDir(cwd), scanDir.slice(DEFAULT_PROJECT_AIWG_DIR.length + 1));
  }
  return path.join(cwd, scanDir);
}

/**
 * Framework graph version tracking
 */
export interface FrameworkGraphVersion {
  /** AIWG version when graph was built */
  aiwg_version: string;

  /** Frameworks included in the graph */
  frameworks_installed: string[];

  /** Build timestamp */
  built_at: string;
}
