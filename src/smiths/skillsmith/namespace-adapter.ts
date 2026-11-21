/**
 * Namespace-aware Skill Deployment Adapter
 *
 * Implements per-platform namespace deployment strategy per ADR:
 * docs/migration/skill-namespace-migration.md
 *
 * Platform groups:
 *   Group A (deep-recursion): Claude Code, Cursor, Codex, OpenCode, OpenClaw
 *     → Deploy both canonical subdir layout AND prefixed slug fallback.
 *   Group B (one-level):      Factory AI, Warp, Devin Desktop
 *     → Deploy only the prefixed slug; no subdir (would break one-level discovery).
 *   Group C (unknown):        GitHub Copilot
 *     → Deploy only the prefixed slug (safe default until recursion depth confirmed).
 *   Group D (mcp-skip):       Hermes
 *     → Skip file deployment, emit guidance pointing to hermes-quickstart.md.
 *
 * @implements #704
 * @see collision-detector.ts for pre-deployment collision checking (#697)
 */

import * as os from 'os';
import * as path from 'path';
import type { Platform } from '../../agents/types.js';
import { listProviderDefinitions } from '../../providers/provider-definitions.js';

// ============================================
// Types
// ============================================

/**
 * Namespace deployment group per ADR.
 */
export type DeploymentGroup = 'deep-recursion' | 'one-level' | 'unknown' | 'mcp-skip';

/**
 * Whether the skills root resolves relative to the project directory or
 * the user's home directory.
 */
export type PathType = 'project' | 'home-dir';

/**
 * Per-platform namespace deployment adapter configuration.
 */
export interface NamespaceAdapter {
  /** Platform this adapter handles */
  platform: Platform;
  /**
   * Deployment group, determines how many target paths are produced:
   * - deep-recursion: subdir layout + prefixed slug
   * - one-level / unknown: prefixed slug only
   * - mcp-skip: no files written
   */
  deploymentGroup: DeploymentGroup;
  /** Whether skills root resolves relative to project or home directory */
  pathType: PathType;
  /** Skills base directory (relative to project root, or relative to homedir) */
  skillsBaseDir: string;
  /**
   * Whether to produce the canonical `{baseDir}/{namespace}/{slug}/` path.
   * True for Group A (deep recursion) only.
   * False for all other groups — would break one-level discovery.
   */
  subdirLayout: boolean;
  /** Maximum name field length (SKILL.md frontmatter truncation) */
  maxNameLength?: number;
  /** Maximum description field length (SKILL.md frontmatter truncation) */
  maxDescriptionLength?: number;
  /** Text appended to description field (e.g. Factory suffix) */
  appendToDescription?: string;
}

/**
 * A single file deployment instruction.
 */
export interface DeploymentPlan {
  /** Absolute path to write the SKILL.md file */
  targetPath: string;
  /** File content (may differ from source when frontmatter is mutated) */
  content: string;
  /** Human-readable description for logging */
  label: string;
}

/**
 * Result of resolving namespace deployment plans for one skill.
 */
export interface NamespaceDeployResult {
  platform: Platform;
  skillName: string;
  /** Plans to execute (empty when skip=true) */
  plans: DeploymentPlan[];
  /** When true, no files should be written */
  skip: boolean;
  /** Guidance message when skip=true (e.g. Hermes manual setup note) */
  skipMessage?: string;
}

// ============================================
// Adapter Definitions
// ============================================

/**
 * Per-platform adapter table.
 * Derived from ProviderDefinition.skillNamespace; includes a 'generic' fallback.
 */
export const NAMESPACE_ADAPTERS: Record<Platform | 'generic', NamespaceAdapter> = Object.fromEntries(
  listProviderDefinitions().map((definition) => [
    definition.id,
    {
      platform: definition.id,
      deploymentGroup: definition.skillNamespace.deploymentGroup,
      pathType: definition.skillNamespace.pathType,
      skillsBaseDir: definition.skillNamespace.skillsBaseDir,
      subdirLayout: definition.skillNamespace.subdirLayout,
      maxNameLength: definition.skillNamespace.maxNameLength,
      maxDescriptionLength: definition.skillNamespace.maxDescriptionLength,
      appendToDescription: definition.skillNamespace.appendToDescription,
    },
  ]),
) as Record<Platform | 'generic', NamespaceAdapter>;

// ============================================
// Helpers
// ============================================

/**
 * Resolve absolute skills root for a platform + project combination.
 * Home-dir platforms (Codex, OpenClaw, OpenHuman, Hermes) use os.homedir().
 */
export function resolveSkillsRoot(adapter: NamespaceAdapter, projectPath: string): string {
  if (adapter.pathType === 'home-dir') {
    return path.join(os.homedir(), adapter.skillsBaseDir);
  }
  return path.join(projectPath, adapter.skillsBaseDir);
}

/**
 * Compute canonical namespaced slug.
 * Idempotent: if `skillName` already starts with `{namespace}-`, returns it unchanged.
 *
 * @example
 * computePrefixedSlug('sync', 'aiwg')      // → 'aiwg-sync'
 * computePrefixedSlug('aiwg-sync', 'aiwg') // → 'aiwg-sync'
 */
export function computePrefixedSlug(skillName: string, namespace: string): string {
  const prefix = `${namespace}-`;
  return skillName.startsWith(prefix) ? skillName : `${prefix}${skillName}`;
}

/**
 * Apply platform-specific frontmatter mutations to SKILL.md content.
 *
 * Mutations applied (when configured):
 * - Inject `namespace: {namespace}` into frontmatter if not present
 * - Truncate `name` to `maxNameLength`
 * - Append `appendToDescription` suffix to `description`
 * - Truncate `description` to `maxDescriptionLength`
 *
 * Returns the original content unchanged when no mutations are needed.
 */
export function mutateFrontmatter(
  content: string,
  adapter: NamespaceAdapter,
  namespace: string
): string {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return content;

  let [, frontmatter, body] = fmMatch;
  let changed = false;

  // Inject namespace field if missing
  if (!/^namespace:\s*/m.test(frontmatter)) {
    frontmatter = `namespace: ${namespace}\n${frontmatter}`;
    changed = true;
  }

  // Truncate name
  if (adapter.maxNameLength) {
    frontmatter = frontmatter.replace(/^(name:\s*)(.+)$/m, (_, key, val) => {
      const truncated = val.slice(0, adapter.maxNameLength);
      if (truncated !== val) changed = true;
      return `${key}${truncated}`;
    });
  }

  // Append to description and/or truncate
  if (adapter.appendToDescription || adapter.maxDescriptionLength) {
    frontmatter = frontmatter.replace(/^(description:\s*)(.+)$/m, (_, key, val) => {
      let desc = val;
      if (adapter.appendToDescription && !desc.includes(adapter.appendToDescription)) {
        desc = `${desc} ${adapter.appendToDescription}`;
        changed = true;
      }
      if (adapter.maxDescriptionLength && desc.length > adapter.maxDescriptionLength) {
        desc = desc.slice(0, adapter.maxDescriptionLength);
        changed = true;
      }
      return `${key}${desc}`;
    });
  }

  if (!changed) return content;
  return `---\n${frontmatter}\n---\n${body}`;
}

// ============================================
// Public API
// ============================================

/**
 * Get the namespace adapter for a platform.
 * Falls back to 'generic' for unrecognised platforms.
 */
export function getAdapter(platform: Platform | string): NamespaceAdapter {
  return NAMESPACE_ADAPTERS[platform as Platform] ?? NAMESPACE_ADAPTERS.generic;
}

/**
 * Resolve deployment plans for a skill on a given platform.
 *
 * Calls `checkCollisions()` before writing should be done at the call site
 * (see collision-detector.ts, #697).
 *
 * @param platform     - Target platform
 * @param projectPath  - Absolute project root directory
 * @param skillName    - Skill folder name (e.g. 'sync', 'aiwg-sync')
 * @param sourceContent - Raw content of the source SKILL.md file
 * @param namespace    - Namespace prefix (default: 'aiwg')
 * @returns NamespaceDeployResult with plans to execute (or skip=true for Hermes)
 */
export function getDeploymentPlans(
  platform: Platform | string,
  projectPath: string,
  skillName: string,
  sourceContent: string,
  namespace: string = 'aiwg'
): NamespaceDeployResult {
  const adapter = getAdapter(platform);
  const plat = platform as Platform;

  // Group D: MCP Skip — emit guidance, write no files
  if (adapter.deploymentGroup === 'mcp-skip') {
    return {
      platform: plat,
      skillName,
      plans: [],
      skip: true,
      skipMessage:
        `Hermes skills are not deployed by aiwg use.\n` +
        `  See docs/integrations/hermes-quickstart.md for manual skill setup.`,
    };
  }

  const skillsRoot = resolveSkillsRoot(adapter, projectPath);
  const slug = computePrefixedSlug(skillName, namespace);
  const content = mutateFrontmatter(sourceContent, adapter, namespace);
  const plans: DeploymentPlan[] = [];

  // Group A: canonical subdir layout — {baseDir}/{namespace}/{slug}/SKILL.md
  if (adapter.subdirLayout) {
    plans.push({
      targetPath: path.join(skillsRoot, namespace, slug, 'SKILL.md'),
      content,
      label: `${namespace}/${slug}/SKILL.md (canonical subdir)`,
    });
  }

  // Groups A, B, C: universal prefixed slug — {baseDir}/{slug}/SKILL.md
  plans.push({
    targetPath: path.join(skillsRoot, slug, 'SKILL.md'),
    content,
    label: `${slug}/SKILL.md (universal slug)`,
  });

  return {
    platform: plat,
    skillName,
    plans,
    skip: false,
  };
}
