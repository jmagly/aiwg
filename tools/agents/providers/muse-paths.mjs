/**
 * Muse Code user skill-root resolution for the file-deploy path (.mjs twin).
 *
 * This module mirrors `src/providers/muse-paths.ts` so the deploy-agents
 * writer resolves the same XDG user root without importing TypeScript:
 *
 *   - unset XDG_CONFIG_HOME        → `~/.config/muse/skills` (documented default)
 *   - absolute XDG_CONFIG_HOME     → `<xdg>/muse/skills`
 *   - leading `~/`                 → expanded against the operator home
 *   - relative values / bare `~` / NUL bytes / filesystem-root collapse
 *                                  → fail closed (null)
 *
 * Never invent `~/.muse`, `~/.config/muse` siblings outside `muse/skills`,
 * or `~/.agents/skills` as a write target.
 *
 * @see docs/architecture/adr-muse-provider-target.md
 * @issue #226 (path semantics defined by #234)
 */

import os from 'node:os';
import path from 'node:path';

/** Muse's documented user skills subtree below the XDG config root. */
export const MUSE_XDG_SKILLS_SUBDIR = path.join('muse', 'skills');

/**
 * Expand a leading `~/` against the operator home directory.
 * Bare `~` is rejected — it would invent a home skill root.
 */
function expandHomePrefix(raw, userHome = os.homedir()) {
  if (raw === '~') return raw;
  if (raw.startsWith('~/')) return path.join(userHome, raw.slice(2));
  return raw;
}

/**
 * Validate and resolve the Muse XDG user skills directory.
 * Returns a structured result so the writer can fail closed on bad metadata.
 */
export function resolveMuseXdgSkillsDirResult(env = process.env, userHome = os.homedir()) {
  const raw = (env.XDG_CONFIG_HOME || '').trim();
  if (!raw) {
    // Documented default: ~/.config/muse/skills when XDG_CONFIG_HOME is unset.
    return {
      ok: true,
      path: path.join(userHome, '.config', MUSE_XDG_SKILLS_SUBDIR),
      source: 'default',
    };
  }

  const expanded = expandHomePrefix(raw, userHome);
  if (expanded === '~' || expanded.startsWith('~')) {
    return {
      ok: false,
      reason: 'not-absolute',
      message:
        `XDG_CONFIG_HOME must be an absolute path (got '${raw}'). Bare '~' is rejected so AIWG never invents a Muse home layout.`,
    };
  }

  if (!path.isAbsolute(expanded)) {
    return {
      ok: false,
      reason: 'not-absolute',
      message:
        `XDG_CONFIG_HOME must be an absolute path (got '${raw}'). Relative values are rejected.`,
    };
  }

  if (raw.includes('\0') || expanded.includes('\0')) {
    return {
      ok: false,
      reason: 'traversal',
      message: 'XDG_CONFIG_HOME contains an invalid path character.',
    };
  }

  // Defensive: refuse a config root that collapses to the filesystem root;
  // deploying skills to /muse/skills is never the operator's intent.
  const normalized = path.normalize(expanded);
  if (normalized === path.sep) {
    return {
      ok: false,
      reason: 'empty',
      message: 'XDG_CONFIG_HOME resolves to the filesystem root; refuse to deploy skills there.',
    };
  }

  return {
    ok: true,
    path: path.join(normalized, MUSE_XDG_SKILLS_SUBDIR),
    source: 'env',
  };
}

/**
 * Absolute Muse XDG user skills dir when the metadata is sane; otherwise
 * null (fail closed). Never invents ~/.muse.
 */
export function resolveMuseXdgSkillsDir(env = process.env, userHome = os.homedir()) {
  const resolution = resolveMuseXdgSkillsDirResult(env, userHome);
  return resolution.ok ? resolution.path : null;
}

/**
 * User-facing remediation for bad Muse XDG metadata.
 * Shared by the writer so a blocked deploy explains the fix.
 */
export function museXdgSkillsDirRemediation(env = process.env, userHome = os.homedir()) {
  const resolution = resolveMuseXdgSkillsDirResult(env, userHome);
  return resolution.ok ? '' : resolution.message;
}