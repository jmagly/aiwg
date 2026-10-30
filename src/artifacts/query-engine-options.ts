// Define the query, discover, and show parameter contracts.
import type { ResourceSource, WebReleaseOptions } from '../resources/web-release.js';
import type { DiscoveryShadowRoute } from './discovery-shadow.js';
import type { GraphType } from './types.js';

export interface QueryOptions {
  json?: boolean;
  graph?: GraphType;
  backend?: 'local' | 'fortemi-core';
}


/**
 * Discovery query — capability search across AIWG artifact kinds.
 *
 * Tuned for "agent looking for the right operational asset" use case.
 * Defaults the type filter to AIWG operational artifact kinds, prefers the
 * `framework` graph (where deployed source lives), and outputs in a
 * token-tight format that names the top trigger phrase responsible for
 * each match.
 *
 * @implements #1214
 */
export interface DiscoverParams {
  /** Trusted host-only, default-off D27 observer. Shadow evidence never changes ranking. */
  shadowRoute?: DiscoveryShadowRoute;
  /** Search phrase (the user's capability description) */
  phrase: string;
  /** Restrict to specific types — defaults to the operational discovery surface */
  typeFilter?: string[];
  /** Max results (default 10) */
  limit?: number;
  /** JSON output mode */
  json?: boolean;
  /** Pretty-print JSON output. Defaults to true for CLI compatibility. */
  jsonPretty?: boolean;
  /** Override default graph (defaults to `framework`, falls back to `project`) */
  graph?: GraphType;
  /** Query backend. Defaults to Fortemi Core; use local for the legacy path. */
  backend?: 'local' | 'fortemi-core';
  /** Physical source of AIWG-owned resources. Defaults to local. */
  resourceSource?: ResourceSource;
  /** Exact calendar-semver version or signed channel selector for web mode. */
  aiwgVersion?: string;
  /** Prohibit network requests and require a fully verified warm cache. */
  offline?: boolean;
  /** Dependency injection for release-host tests and development. */
  webReleaseOptions?: Omit<WebReleaseOptions, 'selector' | 'offline'>;
  /**
   * Include filesystem paths in public discovery output. Default is true for
   * direct API compatibility; CLI callers set false so discover stays
   * capability-oriented and agents use the stable id with `show metadata`.
   */
  includePaths?: boolean;
}


export interface ShowParams {
  /** Skill name (e.g. `intake-wizard`), title, or artifact path */
  name: string;
  /** Restrict to specific types — defaults to showable operational types */
  typeFilter?: string[];
  /** Emit the metadata card as JSON. Content is opt-in. */
  json?: boolean;
  /** Override default graph (defaults to `framework`, falls back to `project`) */
  graph?: GraphType;
  /** Include full bound rule bodies in addition to summaries and pointers. */
  boundRuleBodies?: boolean;
  body?: boolean;
  sections?: string[];
  rules?: boolean;
  withRuleBodies?: boolean;
  resources?: boolean;
  resource?: string;
  /** When ambiguous, pick the first match instead of erroring */
  first?: boolean;
  /** Query backend. Defaults to Fortemi Core; use local for the legacy path. */
  backend?: 'local' | 'fortemi-core';
  /** Physical source of AIWG-owned resources. Defaults to local. */
  resourceSource?: ResourceSource;
  /** Exact calendar-semver version or signed channel selector for web mode. */
  aiwgVersion?: string;
  /** Prohibit network requests and require verified cached metadata and body bytes. */
  offline?: boolean;
  /** Dependency injection for release-host tests and development. */
  webReleaseOptions?: Omit<WebReleaseOptions, 'selector' | 'offline'>;
}


export interface ShowMetadataParams extends ShowParams {}
