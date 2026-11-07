// Define query contracts and resolve discover input without shell interpretation.
import type { ResourceSource, WebReleaseOptions } from '../resources/web-release.js';
import type { DiscoveryShadowRoute } from './discovery-shadow.js';
import type { GraphType } from './types.js';

export async function readDiscoverPhrase(
  positional: string[],
  flags: string[],
  input: AsyncIterable<string | Uint8Array> = process.stdin,
): Promise<string> {
  if (!flags.includes('--stdin')) return positional.join(' ').trim();
  if (positional.length > 0) {
    throw new Error('--stdin cannot be combined with a positional search phrase');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(Buffer.from(chunk));
  const phrase = Buffer.concat(chunks).toString('utf8').trim();
  if (!phrase) throw new Error('--stdin requires a non-empty search phrase');
  return phrase;
}

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
  /** Host hook only: read prebuilt/local metadata, omit writes, refresh and rule assembly.
   * Candidates are hints; callers must fetch governing rule bodies before apply. */
  promptContext?: boolean;
  /** Read cached local metadata only, without builds, writes, or repair diagnostics. */
  noBuild?: boolean;
  /** Trusted host-only, default-off D27 observer. Shadow evidence never changes ranking. */
  shadowRoute?: DiscoveryShadowRoute;
  /** Emit cache fallback diagnostics on stderr. */
  verbose?: boolean;
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
