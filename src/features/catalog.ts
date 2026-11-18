/**
 * Optional Features Catalog
 *
 * AIWG ships several runtime-optional features whose dependencies may
 * be installed separately. This catalog is the canonical mapping
 * between **feature names** (operator vocabulary) and the **npm
 * packages** that enable them.
 *
 * Consumed by:
 *   - `aiwg features` command (status / info / install / remove)
 *   - `aiwg doctor` (Optional Features section)
 *   - Runtime error messages (when a dynamic import fails, point at
 *     `aiwg features install <name>`)
 *
 * @implements #1219
 */

export interface FeatureDefinition {
  /** Operator-facing name — the slug used in `aiwg features <name>` */
  name: string;
  /** One-line description */
  description: string;
  /** npm packages this feature requires (all must resolve for `available=true`) */
  packages: string[];
  /** npm dependency specs used by the scoped feature installer */
  packageSpecs: Record<string, string>;
  /** Packages whose lifecycle scripts are explicitly approved for this feature */
  scriptPackages?: string[];
  /** Concrete capabilities this feature unlocks */
  enables: string[];
  /** Install cost / size estimate for operator awareness */
  cost: string;
}

export const FEATURE_CATALOG: FeatureDefinition[] = [
  {
    name: 'embeddings',
    description: 'Vector embeddings for `aiwg discover` (semantic search beyond the keyword scorer)',
    packages: ['@xenova/transformers', 'hnswlib-node'],
    packageSpecs: {
      '@xenova/transformers': '2.17.2',
      'hnswlib-node': '3.0.0',
    },
    scriptPackages: ['hnswlib-node'],
    enables: [
      'higher hit@K on natural-language queries that don\'t match trigger phrases',
      'optional dense-rerank layer when sparse top-1 is ambiguous',
    ],
    cost: '~150 MB — transformers runtime + libvips native binary, one-time download',
  },
  {
    name: 'sqlite',
    description: 'SQLite runtime for session catalogs and persistent storage backends',
    packages: ['better-sqlite3'],
    packageSpecs: { 'better-sqlite3': '12.8.0' },
    scriptPackages: ['better-sqlite3'],
    enables: [
      'aiwg sessions list / discover / import-discovered / timeline / search',
      'storage.config: backend=sqlite for any subsystem',
      'transactional reads/writes against `.aiwg/storage/`',
    ],
    cost: '~5 MB — platform prebuild when available, otherwise a native compile via node-gyp',
  },
  {
    name: 'postgres',
    description: 'Advanced direct PostgreSQL canonical-storage backend',
    packages: ['pg'],
    packageSpecs: { pg: '8.23.0' },
    enables: [
      'aiwg.storage-backend/v1 direct PostgreSQL persistence',
      'transactional migration batches, snapshots, cursors, and tombstones',
    ],
    cost: '~1 MB — pure JavaScript PostgreSQL client',
  },
  {
    name: 'pty',
    description: 'PTY bridge for daemon — pass-through interactive TUIs (Claude Code, Codex, etc.)',
    packages: ['node-pty'],
    packageSpecs: { 'node-pty': '1.1.0' },
    scriptPackages: ['node-pty'],
    enables: [
      'aiwg daemon pty start / list / stop',
      'daemon web UI for interactive Claude/Codex/etc sessions over WebSocket',
    ],
    cost: '~2 MB — native compile via node-gyp',
  },
  {
    name: 'webserver',
    description: 'HTTP/WebSocket server for the daemon web UI and ralph-external bridge',
    packages: ['hono', '@hono/node-server', 'ws'],
    packageSpecs: {
      hono: '4.13.17',
      '@hono/node-server': '2.1.6',
      ws: '8.21.1',
    },
    enables: [
      'aiwg daemon serve',
      'browser-based daemon UI',
      'ralph-external WebSocket dispatch',
    ],
    cost: '~3 MB — pure JS, no native deps',
  },
  {
    name: 'graph',
    description: 'Graphology backend for artifact-index traversal only; not Flow graph execution',
    packages: ['graphology', 'graphology-operators', 'graphology-traversal'],
    packageSpecs: {
      graphology: '0.26.0',
      'graphology-operators': '1.6.0',
      'graphology-traversal': '0.3.0',
    },
    enables: [
      'index.graphBackend: graphology',
      'in-memory attributed graph traversal and operator workflows',
      'artifact graph data operations (use graph-pattern addon for Flow execution graphs)',
    ],
    cost: '~2 MB — pure JS, no native deps',
  },
  {
    name: 'terminal',
    description: 'Headless terminal state parsing for PTY orchestration and auditing',
    packages: ['@xterm/headless'],
    packageSpecs: { '@xterm/headless': '6.0.0' },
    enables: [
      'structured screen-state parsing for PTY orchestrators',
      'auditable terminal snapshots without a browser DOM',
    ],
    cost: '~1 MB — pure JS, no native deps',
  },
];

/** Native packages require a successful runtime load, not just package files. */
export const NATIVE_FEATURE_PACKAGES = new Set(
  FEATURE_CATALOG.flatMap(feature => feature.scriptPackages ?? []),
);

/** Quick lookup by feature name. */
export function getFeature(name: string): FeatureDefinition | null {
  return FEATURE_CATALOG.find(f => f.name === name) ?? null;
}

/** All feature names — useful for `--all` flags and CLI completion. */
export function listFeatureNames(): string[] {
  return FEATURE_CATALOG.map(f => f.name);
}

/** Reverse lookup: given a package name, which feature does it belong to? */
export function featureForPackage(pkg: string): FeatureDefinition | null {
  return FEATURE_CATALOG.find(f => f.packages.includes(pkg)) ?? null;
}
