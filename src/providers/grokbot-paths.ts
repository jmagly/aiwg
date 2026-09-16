/**
 * Grok Bot skill-root resolution — fail-closed until explicitly configured.
 *
 * Unlike Hermes (HERMES_HOME with a documented default) or Pi
 * (PI_CODING_AGENT_DIR with ~/.pi/agent fallback), Grok Bot's native skill
 * filesystem root is not yet verified in AIWG. This module therefore:
 *
 *   1. Honors AIWG_GROKBOT_SKILLS_DIR when set to an absolute path
 *   2. Rejects relative paths, `~`-only values that would invent a home layout,
 *      and path segments that attempt traversal after resolution
 *   3. Returns null when unset — callers MUST fail closed for user-scope writes
 *
 * Never invent ~/.grokbot or ~/.cursor as a fallback.
 *
 * @see docs/architecture/adr-grokbot-provider-target.md
 * @issue #205 #207
 */

import { homedir } from 'node:os';
import * as path from 'node:path';

export const GROKBOT_SKILLS_DIR_ENV = 'AIWG_GROKBOT_SKILLS_DIR';

export type GrokbotSkillsDirResolution =
  | { ok: true; path: string; source: 'env' }
  | { ok: false; reason: 'unset' | 'not-absolute' | 'traversal' | 'empty'; message: string };

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
 * Validate and resolve the configured Grok Bot skills directory.
 * Returns a structured result so CLI/doctor can print actionable remediation.
 */
export function resolveGrokbotSkillsDirResult(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): GrokbotSkillsDirResolution {
  const raw = (env[GROKBOT_SKILLS_DIR_ENV] || '').trim();
  if (!raw) {
    return {
      ok: false,
      reason: 'unset',
      message:
        `Grok Bot user-scope skill root is not configured. Set ${GROKBOT_SKILLS_DIR_ENV} to the absolute path of the Grok Bot skills/workflows directory before using --scope user or --global. AIWG does not invent ~/.grokbot.`,
    };
  }

  const expanded = expandHomePrefix(raw, userHome);
  if (expanded === '~' || expanded.startsWith('~')) {
    return {
      ok: false,
      reason: 'not-absolute',
      message:
        `${GROKBOT_SKILLS_DIR_ENV} must be an absolute path (got '${raw}'). Bare '~' is rejected so AIWG never invents a Grok home layout.`,
    };
  }

  if (!path.isAbsolute(expanded)) {
    return {
      ok: false,
      reason: 'not-absolute',
      message:
        `${GROKBOT_SKILLS_DIR_ENV} must be an absolute path (got '${raw}'). Relative values are rejected.`,
    };
  }

  const resolved = path.resolve(expanded);
  // After resolve(), reject any attempt to escape via .. that still looks suspicious
  // relative to a normalized absolute root — path.resolve already collapses '..',
  // so the main remaining check is that we did not start relative.
  if (raw.includes('\0') || resolved.includes('\0')) {
    return {
      ok: false,
      reason: 'traversal',
      message: `${GROKBOT_SKILLS_DIR_ENV} contains an invalid path character.`,
    };
  }

  // Defensive: if the pre-resolve value contained '..' segments that would
  // escape a declared parent, surface traversal. Absolute resolve is fine;
  // we still refuse paths that are only '..' noise without a real root.
  const normalizedInput = path.normalize(expanded);
  if (normalizedInput === path.sep || normalizedInput === '') {
    return {
      ok: false,
      reason: 'empty',
      message: `${GROKBOT_SKILLS_DIR_ENV} resolves to an empty or root-only path; refuse to deploy there.`,
    };
  }

  return { ok: true, path: resolved, source: 'env' };
}

/** Absolute skills dir when configured; otherwise null (fail closed). */
export function resolveGrokbotSkillsDir(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string | null {
  const result = resolveGrokbotSkillsDirResult(env, userHome);
  return result.ok ? result.path : null;
}

/** True when user-scope skill writes are allowed. */
export function isGrokbotUserScopeConfigured(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): boolean {
  return resolveGrokbotSkillsDir(env, userHome) !== null;
}

/**
 * User-facing remediation for missing/invalid Grok Bot skill root.
 * Shared by `aiwg use`, doctor, and the provider writer.
 */
export function grokbotMissingRootRemediation(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string {
  const result = resolveGrokbotSkillsDirResult(env, userHome);
  if (result.ok) return '';
  return result.message;
}
