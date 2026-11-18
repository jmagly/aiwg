/**
 * Marketplace Consumer Types
 *
 * Interfaces for third-party marketplace plugin ingestion.
 *
 * @implements #787
 */

/**
 * Supported marketplace sources
 */
export type MarketplaceSourceId = 'clawhub' | 'cursor' | 'codex' | 'claude' | 'git';

/**
 * Normalized AIWG-internal metadata for a marketplace plugin
 */
export interface PackageMetadata {
  /** Package name (e.g. "aiwg-sdlc") */
  name: string;
  /** Package version (SemVer preferred) */
  version: string;
  /** Namespace for deployment paths ("aiwg" or third-party) */
  namespace: string;
  /** Source marketplace */
  source: MarketplaceSourceId;
  /** Human-readable description */
  description: string;
  /** License identifier (SPDX preferred) */
  license: string;
  /** Original publisher/author */
  publisher?: string;
  /** Homepage URL */
  homepage?: string;
  /** Repository URL */
  repository?: string;
  /** Source-specific fields preserved for update detection */
  sourceSpecific?: Record<string, unknown>;
}

/**
 * Artifact paths within a fetched package bundle
 */
export interface PackageArtifacts {
  agents?: string[];
  commands?: string[];
  skills?: string[];
  rules?: string[];
  behaviors?: string[];
  templates?: string[];
}

/**
 * A fetched package ready for caching and deployment
 */
export interface PackageBundle {
  metadata: PackageMetadata;
  artifacts: PackageArtifacts;
  /** Local directory where the package is staged */
  localPath: string;
  /** Raw manifest from the source marketplace */
  rawManifest: Record<string, unknown>;
}

/**
 * Summary of a package found via search
 */
export interface PackageSummary {
  name: string;
  version: string;
  description: string;
  source: MarketplaceSourceId;
  downloads?: number;
  stars?: number;
}

/**
 * Search options
 */
export interface SearchOptions {
  limit?: number;
  sort?: 'downloads' | 'stars' | 'updated' | 'name';
}

/**
 * Result of manifest validation
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Common interface for marketplace source adapters
 */
export interface MarketplaceSource {
  readonly source: MarketplaceSourceId;

  /** Fetch a package by identifier */
  fetch(packageId: string, version?: string): Promise<PackageBundle>;

  /** Search the marketplace */
  search(query: string, options?: SearchOptions): Promise<PackageSummary[]>;

  /** Validate a package manifest */
  validate(manifest: unknown): ValidationResult;

  /** List available versions of a package */
  getVersions(packageId: string): Promise<string[]>;
}

/**
 * Parsed source identifier (e.g. "clawhub:aiwg/sdlc" → { source, packageId })
 */
export interface ParsedIdentifier {
  source: MarketplaceSourceId;
  packageId: string;
  version?: string;
}

/** Public search adapters expose observations only; they never install packages. */
export type SearchSourceId = 'mcp-registry' | 'github' | 'skills.sh';
export interface SearchSignal {
  value: string | number | null;
  source: string;
  asOf: string | null;
}
export interface SearchObservation {
  id: string;
  name: string;
  description: string;
  repository: string | null;
  keywords: string[];
  signals: Record<string, SearchSignal>;
}
export interface SearchSnapshot {
  source: SearchSourceId;
  query: string;
  endpoint: string;
  fetchedAt: string;
  limited: boolean;
  observations: SearchObservation[];
}
export interface MarketplaceSearchAdapter {
  source: SearchSourceId;
  endpoint(query: string): string;
  normalize(body: unknown, endpoint: string, observedAt: string): Pick<SearchSnapshot, 'observations' | 'limited'>;
}
