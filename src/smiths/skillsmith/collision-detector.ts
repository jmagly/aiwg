/**
 * Skill Deployment Collision Detector
 *
 * Scans target platform directories before `aiwg use` to identify name conflicts
 * between skills being deployed and existing skills already present.
 *
 * Severity levels:
 * - none    — target path does not exist, deploy silently
 * - info    — target exists and is owned by the same namespace, overwrite silently
 * - warn    — target exists and is owned by a different namespace or user, prompt user
 * - error   — name matches a known platform built-in or AIWG CLI command, block deployment
 *
 * @see adr-skill-namespace-strategy.md
 * @implements #698
 * @implements #804
 */

import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import * as path from 'path';
import type { Platform } from '../../agents/types.js';

// ============================================
// Types
// ============================================

export type CollisionSeverity = 'none' | 'info' | 'warn' | 'error';

export interface CollisionResult {
  /** Skill name being deployed */
  skillName: string;
  /** Full path that would be written */
  targetPath: string;
  /** Severity of the collision */
  severity: CollisionSeverity;
  /** Human-readable reason */
  reason: string;
  /** Whether this collision blocks deployment */
  blocksDeployment: boolean;
}

export interface CollisionCheckOptions {
  /** Platform being deployed to */
  platform: Platform;
  /** Project root directory */
  projectPath: string;
  /** Skill names about to be deployed */
  skillNames: string[];
  /** Namespace of the deploying package (e.g. 'aiwg') */
  namespace?: string;
  /** Base skills directory (computed from platform if not provided) */
  skillsBaseDir?: string;
  /** Source skills directory for content hash comparison (skips unchanged files) */
  sourceSkillsDir?: string;
}

// ============================================
// Platform Built-in Blocklists
// ============================================

/**
 * Platform built-in commands that must never be overwritten.
 * Attempting to deploy a skill with one of these names is an ERROR.
 */
const PLATFORM_BUILTINS: Record<string, string[]> = {
  'claude': [
    'help', 'clear', 'compact', 'review', 'init', 'doctor',
    'memory', 'settings', 'logout', 'login', 'mcp', 'migrate',
  ],
  'cursor': ['settings', 'chat', 'edit'],
  'codex': ['help', 'run', 'exec'],
  'copilot': ['help', 'explain', 'fix', 'tests', 'review'],
  'windsurf': ['help', 'settings'],
  'opencode': ['help', 'run'],
  'warp': ['help', 'settings'],
  'hermes': [],
  'grokbot': [],
  'muse': [],
  'openclaw': [],
  'openhuman': [],
  'factory': [],
  'generic': [],
};

// Note: previously this module also blocked `aiwg-{cliCommand}` slugs (e.g.
// `aiwg-doctor`) as "shadowing" the AIWG CLI. That check was removed because
// it directly contradicted the namespace migration strategy: `/aiwg-doctor`
// IS the canonical slug for the doctor skill (the bare `doctor` collides with
// Claude's built-in). Slash commands and shell CLI commands live on different
// surfaces and do not actually conflict at runtime.
// See: docs/migration/skill-namespace-migration.md, .aiwg/architecture/adr-skill-namespace-strategy.md

// ============================================
// Ownership Attribution
// ============================================

/**
 * Determine if an existing skill directory is owned by the given namespace.
 *
 * A skill is owned by `namespace` when ANY of:
 * 1. Its SKILL.md frontmatter contains `namespace: {namespace}`
 * 2. Its parent directory is named after the namespace (e.g. `.claude/skills/aiwg/`)
 *
 * This generalises the original AIWG-only check to support any package namespace,
 * enabling correct cross-namespace collision severity for third-party packages (#804).
 *
 * @param skillPath - Absolute path to the skill directory
 * @param namespace - Namespace to test ownership against (default: 'aiwg')
 */
export async function isOwnedByNamespace(skillPath: string, namespace: string = 'aiwg'): Promise<boolean> {
  // Check 1: namespace in SKILL.md frontmatter
  const skillFile = path.join(skillPath, 'SKILL.md');
  try {
    const content = await fs.readFile(skillFile, 'utf-8');
    // Match `namespace: <value>` line where value equals the queried namespace
    const nsMatch = content.match(/^namespace:\s*(.+?)\s*$/m);
    if (nsMatch && nsMatch[1] === namespace) {
      return true;
    }
  } catch {
    // file doesn't exist or unreadable — not owned
  }

  // Check 2: deployed under a namespace subdirectory
  const parentDir = path.basename(path.dirname(skillPath));
  if (parentDir === namespace) {
    return true;
  }

  return false;
}

// ============================================
// Content Hash Comparison
// ============================================

/**
 * Compute MD5 hash of a file's content. Returns null if unreadable.
 */
async function fileHash(filePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath);
    return createHash('md5').update(content).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Check if the source skill SKILL.md matches the deployed SKILL.md by content hash.
 * Returns true when both exist and have identical content (no update needed).
 */
async function skillContentUnchanged(sourceDir: string, deployedDir: string): Promise<boolean> {
  const srcFile = path.join(sourceDir, 'SKILL.md');
  const dstFile = path.join(deployedDir, 'SKILL.md');
  const [srcHash, dstHash] = await Promise.all([fileHash(srcFile), fileHash(dstFile)]);
  if (!srcHash || !dstHash) return false;
  return srcHash === dstHash;
}

// ============================================
// Collision Check
// ============================================

/**
 * Check for deployment collisions before writing skills to a platform directory.
 *
 * Ownership comparison uses the deploying package's namespace:
 * - Same namespace overwrites → `info` severity (silent upgrade)
 * - Cross-namespace or user-owned overwrites → `warn` severity (user confirmation)
 *
 * @param options - Collision check parameters
 * @returns Array of collision results, one per skill name. Only non-`none` results
 *          are returned (clean deployments are omitted).
 */
export async function checkCollisions(options: CollisionCheckOptions): Promise<CollisionResult[]> {
  const { platform, projectPath, skillNames, skillsBaseDir, sourceSkillsDir, namespace = 'aiwg' } = options;

  const platformBuiltins = new Set(PLATFORM_BUILTINS[platform] ?? []);
  const results: CollisionResult[] = [];

  for (const skillName of skillNames) {
    const targetPath = skillsBaseDir
      ? path.join(skillsBaseDir, skillName)
      : path.join(projectPath, `.${platform}/skills`, skillName);

    // Check 1: Platform built-in collision (literal slug only).
    //
    // The namespaced canonical slug (e.g. `aiwg-doctor`) is the actual command
    // registered with the platform — it does NOT collide with the platform's bare
    // built-in (`doctor`). The whole point of the `aiwg-` prefix per
    // `docs/migration/skill-namespace-migration.md` is to side-step platform built-ins.
    //
    // Only check the literal skillName here. Bare names like `doctor` (no prefix)
    // are still caught and blocked.
    if (platformBuiltins.has(skillName)) {
      results.push({
        skillName,
        targetPath,
        severity: 'error',
        reason: `'${skillName}' matches a ${platform} platform built-in command`,
        blocksDeployment: true,
      });
      continue;
    }

    // Check 2: Target path existence
    let exists = false;
    try {
      await fs.access(targetPath);
      exists = true;
    } catch {
      // doesn't exist — no collision
    }

    if (!exists) {
      // No collision, don't add to results
      continue;
    }

    // Check 3: Ownership of existing skill
    // Same-namespace overwrites are silent upgrades (info).
    // Cross-namespace or unowned overwrites require user confirmation (warn).
    const ownedBySameNamespace = await isOwnedByNamespace(targetPath, namespace);
    if (ownedBySameNamespace) {
      // Check if content is actually unchanged — skip silently if identical
      if (sourceSkillsDir) {
        const sourceDir = path.join(sourceSkillsDir, skillName);
        const unchanged = await skillContentUnchanged(sourceDir, targetPath);
        if (unchanged) {
          // Identical content — no collision, no output needed
          continue;
        }
      }
      results.push({
        skillName,
        targetPath,
        severity: 'info',
        reason: `'${skillName}' updating`,
        blocksDeployment: false,
      });
    } else {
      results.push({
        skillName,
        targetPath,
        severity: 'warn',
        reason: `'${skillName}' already exists at ${targetPath} and is not owned by namespace '${namespace}' — will overwrite existing skill`,
        blocksDeployment: false,
      });
    }
  }

  return results;
}

/**
 * Format collision results as a human-readable warning block.
 *
 * @param results - Collision results from `checkCollisions()`
 * @param options - Formatting options
 * @param options.verbose - When false, suppress info-level messages (same-namespace updates)
 * @returns Formatted string for CLI output, or empty string if no results
 */
export function formatCollisionReport(
  results: CollisionResult[],
  options: { verbose?: boolean } = {}
): string {
  if (results.length === 0) return '';

  const { verbose = false } = options;
  const errors = results.filter((r) => r.severity === 'error');
  const warnings = results.filter((r) => r.severity === 'warn');
  const infos = results.filter((r) => r.severity === 'info');

  const lines: string[] = [];

  if (errors.length > 0) {
    lines.push('');
    lines.push('ERROR: Deployment blocked for the following skills:');
    for (const r of errors) {
      lines.push(`  ✗ ${r.skillName}: ${r.reason}`);
    }
  }

  if (warnings.length > 0) {
    lines.push('');
    lines.push('WARNING: The following skills will overwrite content from a different namespace:');
    for (const r of warnings) {
      lines.push(`  ⚠ ${r.skillName}: ${r.reason}`);
    }
    lines.push('');
    lines.push('  Use --force to overwrite, or --skip-conflicts to skip these skills.');
  }

  // Info-level (same-namespace updates) only shown in verbose mode
  if (verbose && infos.length > 0 && errors.length === 0 && warnings.length === 0) {
    for (const r of infos) {
      lines.push(`  ℹ ${r.skillName}: ${r.reason}`);
    }
  }

  return lines.join('\n');
}

/**
 * Check if any collision results block deployment.
 */
export function hasBlockingCollisions(results: CollisionResult[]): boolean {
  return results.some((r) => r.blocksDeployment);
}
