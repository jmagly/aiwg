/**
 * Storage Adapter Types
 *
 * Public contracts for the AIWG storage abstraction. Consumers use
 * `resolveStorage(subsystem)` to obtain a backend-specific adapter
 * conforming to `StorageAdapter`.
 *
 * @design @docs/storage/overview.md
 * @schema @schemas/storage/storage.config.v1.schema.json
 * @issue #934
 * @issue #953
 */

/**
 * Subsystems that route through the storage adapter. Adding a new
 * subsystem requires updating the schema, the validator, and the
 * default-roots map in `config.ts`.
 */
export type SubsystemKey =
  | 'memory'
  | 'reflections'
  | 'kb'
  | 'activity_log'
  | 'provenance'
  | 'research'
  | 'media'
  | 'sandbox_identity';

export const SUBSYSTEM_KEYS: readonly SubsystemKey[] = [
  'memory',
  'reflections',
  'kb',
  'activity_log',
  'provenance',
  'research',
  'media',
  'sandbox_identity',
] as const;

/**
 * Backend type identifiers. The schema constrains config to these
 * values; new backends must be added here, in the schema, and in the
 * factory in `index.ts`.
 */
export type BackendType =
  | 'fs'
  | 'obsidian'
  | 'logseq'
  | 'notion'
  | 'anythingllm'
  | 'fortemi'
  | 's3'
  | 'webdav';

export const BACKEND_TYPES: readonly BackendType[] = [
  'fs',
  'obsidian',
  'logseq',
  'notion',
  'anythingllm',
  'fortemi',
  's3',
  'webdav',
] as const;

/**
 * Listing entry returned by `StorageAdapter.list()`.
 */
export interface StorageEntry {
  /** Subsystem-relative path. Always forward-slash-separated. */
  path: string;
  /** Bytes for backends that report it; undefined otherwise. */
  size?: number;
  /** Last-modified timestamp when the backend reports one. */
  modifiedAt?: Date;
  /** Backend-specific opaque handle (Notion page ID, Logseq block UUID, …). */
  externalId?: string;
}

/**
 * Optional metadata forwarded to the adapter's `write()`. Backends that
 * support frontmatter (Obsidian, Logseq, Notion) interpret it; backends
 * that don't ignore it.
 */
export interface WriteMeta {
  contentType?: string;
  frontmatter?: Record<string, unknown>;
}

/**
 * The minimal contract every backend implements.
 *
 * Path semantics:
 *   - Paths are subsystem-relative (no leading `/`).
 *   - Forward slashes only.
 *   - `..` traversal is rejected at the adapter boundary.
 */
export interface StorageAdapter {
  /** Returns null when the path does not exist. Throws on transport errors. */
  read(path: string): Promise<string | null>;

  /** Idempotent. Overwrites by default. */
  write(path: string, content: string, meta?: WriteMeta): Promise<void>;

  /**
   * Atomic append. Optional — backends that don't expose an
   * append-friendly primitive omit this and callers fall back to
   * read-then-write. The fs backend implements this via fs.appendFile
   * (POSIX O_APPEND), which the kernel guarantees atomic for writes
   * within PIPE_BUF (4096 bytes on Linux). See #976.
   */
  append?(path: string, content: string): Promise<void>;

  /** Returns entries whose path starts with `prefix`. Empty string lists all. */
  list(prefix: string): Promise<StorageEntry[]>;

  /** No-op when the path does not exist. */
  delete(path: string): Promise<void>;

  /** Optional: backends with server-side query (AnythingLLM, Notion, Fortemi). */
  query?(q: string): Promise<StorageEntry[]>;

  /** Optional: open connections / authenticate. Idempotent. */
  init?(): Promise<void>;

  /** Optional: release resources. */
  close?(): Promise<void>;
}

// ── Configuration types ──────────────────────────────────────────────

export type FsBackendConfig = { type: 'fs' };

export interface ObsidianBackendConfig {
  type: 'obsidian';
  vault: string;
  folder?: string;
  useCli?: boolean;
}

export interface LogseqBackendConfig {
  type: 'logseq';
  graph: string;
  apiUrl?: string;
  /** Environment name (default LOGSEQ_API_TOKEN), file:ABSOLUTE_PATH or store:NAME. */
  apiTokenEnv?: string;
  useApi?: boolean;
}

export interface NotionBackendConfig {
  type: 'notion';
  parent: { pageId: string } | { databaseId: string };
  externalIdProperty?: string;
}

export interface AnythingLlmBackendConfig {
  type: 'anythingllm';
  baseUrl: string;
  workspace: string;
  folder?: string;
}

export interface FortemiBackendConfig {
  type: 'fortemi';
  mcpServer?: string;
  scheme?: string;
}

export interface S3BackendConfig {
  type: 's3';
  bucket: string;
  prefix?: string;
  region?: string;
  endpoint?: string;
}

export interface WebdavBackendConfig {
  type: 'webdav';
  url: string;
  basePath?: string;
  authMode?: 'basic' | 'digest' | 'bearer';
}

export type BackendConfig =
  | FsBackendConfig
  | ObsidianBackendConfig
  | LogseqBackendConfig
  | NotionBackendConfig
  | AnythingLlmBackendConfig
  | FortemiBackendConfig
  | S3BackendConfig
  | WebdavBackendConfig;

export interface StorageConfig {
  /** Schema version. v1 is the only currently-supported value. */
  version: '1';
  /** Path overrides for `fs`-backed subsystems. */
  roots?: Partial<Record<SubsystemKey, string>>;
  /** Backend selection per subsystem. Unlisted subsystems default to `fs`. */
  backends?: Partial<Record<SubsystemKey, BackendConfig>>;
  /** What to do on transport errors. Default `cache_and_warn`. */
  fallback?: 'cache_and_warn' | 'block';
}
