/**
 * Muse Code skill-root resolution — documented roots only, fail-closed on bad metadata.
 *
 * Muse Code's documented user skill root is `$XDG_CONFIG_HOME/muse/skills`
 * (default `~/.config/muse/skills` when XDG_CONFIG_HOME is unset). The
 * project skill root (`<repo>/.agents/skills`) is static provider metadata
 * on the `muse` skillNamespace; this module resolves only the XDG user root
 * at deploy time.
 *
 * Unlike Grok Bot (AIWG_GROKBOT_SKILLS_DIR, fail-closed until configured),
 * the Muse user root is documented, so an unset XDG_CONFIG_HOME falls back
 * to the documented default — but malformed metadata (relative
 * XDG_CONFIG_HOME, bare `~`, NUL bytes, root-only resolution) fails closed
 * so the deployer never invents a bogus tree.
 *
 * Never invent `~/.muse`, `~/.config/muse` siblings outside `muse/skills`,
 * or `~/.agents/skills` as a write target.
 *
 * @see docs/architecture/adr-muse-provider-target.md
 * @issue #234
 */

import { homedir } from 'node:os';
import * as path from 'node:path';

/** Muse's documented user skills subtree below the XDG config root. */
export const MUSE_XDG_SKILLS_SUBDIR = path.join('muse', 'skills');

export type MuseXdgSkillsDirResolution =
  | { ok: true; path: string; source: 'env' | 'default' }
  | { ok: false; reason: 'not-absolute' | 'traversal' | 'empty'; message: string };

/**
 * Expand a leading `~/` against the operator home directory.
 * Bare `~` is rejected — it would invent a home skill root.
 */
function expandHomePrefix(raw: string, userHome = homedir()): string {
  if (raw === '~') return raw;
  if (raw.startsWith('~/')) return path.join(userHome, raw.slice(2));
  return raw;
}

/**
 * Validate and resolve the Muse XDG user skills directory.
 * Returns a structured result so the deployer can fail closed on bad metadata.
 */
export function resolveMuseXdgSkillsDirResult(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): MuseXdgSkillsDirResolution {
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
export function resolveMuseXdgSkillsDir(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string | null {
  const resolution = resolveMuseXdgSkillsDirResult(env, userHome);
  return resolution.ok ? resolution.path : null;
}

/**
 * User-facing remediation for bad Muse XDG metadata.
 * Shared by the deployer so a blocked deploy explains the fix.
 */
export function museXdgSkillsDirRemediation(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string {
  const resolution = resolveMuseXdgSkillsDirResult(env, userHome);
  return resolution.ok ? '' : resolution.message;
}
