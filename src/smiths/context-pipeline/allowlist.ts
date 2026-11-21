/**
 * Path-emission allowlist for AGENTS.md link-index entries.
 *
 * Per ADR-1 §2 (security mitigation R2): the generator MUST only emit `Path:` values
 * that match a path produced by the AIWG-owned ProviderDefinition registry plus
 * the canonical `~/.agents/skills/` cross-provider user-scope target. Files
 * deployed by project-local manifests at non-AIWG paths are not indexed. This
 * closes the link-redirect attack surface where a malicious project-local
 * artifact could cite a shadow file outside AIWG's path-map domain.
 */

import { homedir } from 'node:os';
import * as path from 'node:path';

/**
 * The AIWG-owned path prefixes that may appear in an AGENTS.md link entry.
 *
 * Mirrors the per-provider directory list from `ProviderDefinition.paths.artifacts`,
 * generalized to prefixes (so per-artifact subpaths under each prefix are accepted).
 *
 * Sources kept in sync:
 * - `src/providers/provider-definitions.ts`
 * - `src/smiths/platform-paths.ts` (TypeScript path resolvers)
 * - `src/config/aiwg-config.ts`
 *
 * If a new platform path is added there, add it here.
 */
const AIWG_PATH_PREFIXES_RELATIVE: ReadonlyArray<string> = [
  // Claude Code
  '.claude/agents/',
  '.claude/skills/',
  '.claude/commands/',
  '.claude/rules/',
  '.claude/hooks/',

  // Factory AI
  '.factory/droids/',
  '.factory/skills/',
  '.factory/commands/',
  '.factory/rules/',

  // OpenAI Codex (project scope; user scope handled below via homedir)
  '.codex/agents/',
  '.codex/skills/',
  '.codex/commands/',
  '.codex/rules/',

  // OpenCode
  '.opencode/agent/',
  '.opencode/skill/',
  '.opencode/rule/',

  // Copilot
  '.github/agents/',
  '.github/skills/',
  '.github/copilot-rules/',
  '.github/prompts/',
  '.github/instructions/',

  // Cursor
  '.cursor/agents/',
  '.cursor/skills/',
  '.cursor/commands/',
  '.cursor/rules/',

  // Warp
  '.warp/agents/',
  '.warp/skills/',
  '.warp/commands/',
  '.warp/rules/',

  // Devin Desktop
  '.windsurf/agents/',
  '.windsurf/skills/',
  '.windsurf/workflows/',
  '.windsurf/rules/',

  // Cross-agent canonical project-scope path (#766 + ADR-1)
  '.agents/agents/',
  '.agents/skills/',
  '.agents/rules/',
  '.agents/behaviors/',
];

/**
 * User-scope path prefixes (resolved with homedir() at check time).
 *
 * Per ADR-4 §2 user-global path map.
 */
const AIWG_PATH_PREFIXES_USER: ReadonlyArray<string> = [
  // Cross-agent canonical user-scope path (ADR-4)
  '.agents/skills/',

  // Per-provider user-scope paths
  '.claude/agents/',
  '.claude/skills/',
  '.claude/commands/',
  '.claude/rules/',
  '.claude/hooks/',
  '.codex/skills/',
  '.codex/prompts/',
  '.codex/agents/',
  '.codex/rules/',
  '.cursor/agents/',
  '.cursor/skills/',
  '.cursor/commands/',
  '.cursor/rules/',
  '.warp/agents/',
  '.warp/skills/',
  '.warp/commands/',
  '.warp/rules/',
  '.windsurf/agents/',
  '.windsurf/skills/',
  '.windsurf/workflows/',
  '.windsurf/rules/',
  '.opencode/agent/',
  '.opencode/skill/',
  '.opencode/rule/',
  '.openclaw/agents/',
  '.openclaw/skills/',
  '.openclaw/commands/',
  '.openclaw/rules/',
  '.openclaw/behaviors/',
  '.openclaw/hooks/',
  '.factory/droids/',
  '.factory/skills/',
  '.factory/commands/',
  '.factory/rules/',
  '.config/github-copilot/agents/',
  '.config/github-copilot/prompts/',
  '.config/github-copilot/instructions/',
  '.hermes/skills/',
];

/**
 * Result of an allowlist check.
 */
export interface AllowlistResult {
  ok: boolean;
  /** Reason path was rejected; empty when ok=true */
  rejectedFor: string;
  /** True when the path matched a user-scope prefix (~/...) */
  isUserScope: boolean;
}

/**
 * Check whether a path is allowed in an AGENTS.md link-index entry.
 *
 * Accepts both relative project-scope paths and absolute user-scope paths
 * (rooted in homedir()). Rejects all other paths.
 *
 * Path normalization:
 * - Backslashes are converted to forward slashes for cross-platform compatibility.
 * - Leading `./` is stripped.
 * - `..` segments anywhere in the path cause rejection (prevents escaping the project root).
 */
export function checkPathAllowed(inputPath: string): AllowlistResult {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    return { ok: false, rejectedFor: 'empty or non-string path', isUserScope: false };
  }

  // Reject any path with a parent-dir traversal segment.
  const segments = inputPath.split(/[/\\]/);
  if (segments.includes('..')) {
    return { ok: false, rejectedFor: 'parent-dir traversal (..) not allowed', isUserScope: false };
  }

  // Normalize to forward slashes; strip leading ./
  let normalized = inputPath.replace(/\\/g, '/');
  if (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }

  // User-scope: starts with ~/ (or absolute home directory)
  const home = homedir();
  const homeNormalized = home.replace(/\\/g, '/');

  let isUserScope = false;
  let userScopeRelative = '';
  if (normalized.startsWith('~/')) {
    isUserScope = true;
    userScopeRelative = normalized.slice(2);
  } else if (normalized.startsWith(homeNormalized + '/')) {
    isUserScope = true;
    userScopeRelative = normalized.slice(homeNormalized.length + 1);
  } else if (path.isAbsolute(inputPath)) {
    return {
      ok: false,
      rejectedFor: 'absolute path outside home directory',
      isUserScope: false,
    };
  }

  if (isUserScope) {
    for (const prefix of AIWG_PATH_PREFIXES_USER) {
      if (userScopeRelative === prefix.replace(/\/$/, '') || userScopeRelative.startsWith(prefix)) {
        return { ok: true, rejectedFor: '', isUserScope: true };
      }
    }
    return {
      ok: false,
      rejectedFor: 'user-scope path not in AIWG-owned prefix list',
      isUserScope: true,
    };
  }

  // Project-scope: must start with one of AIWG_PATH_PREFIXES_RELATIVE.
  for (const prefix of AIWG_PATH_PREFIXES_RELATIVE) {
    if (normalized === prefix.replace(/\/$/, '') || normalized.startsWith(prefix)) {
      return { ok: true, rejectedFor: '', isUserScope: false };
    }
  }

  return {
    ok: false,
    rejectedFor: 'project-scope path not in AIWG-owned prefix list',
    isUserScope: false,
  };
}

export const ALLOWLIST_INTERNALS = {
  AIWG_PATH_PREFIXES_RELATIVE,
  AIWG_PATH_PREFIXES_USER,
};
