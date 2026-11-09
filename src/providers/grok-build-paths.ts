/**
 * Grok Build home/path resolution — documented defaults with fail-closed overrides.
 *
 * Default `$GROK_HOME` is `~/.grok` (absolute after expand). Relative overrides,
 * bare `~`, root-only paths, and null bytes are rejected.
 *
 * Distinct from Grok Bot (`grokbot` / `AIWG_GROKBOT_SKILLS_DIR`): never share
 * roots or invent `~/.grokbot` / `.cursor` paths.
 *
 * @see https://docs.x.ai/build/settings
 * @issue #2575
 */

import { homedir } from 'node:os';
import * as path from 'node:path';

/** Project-only opt-in bulk mirror, shared by the registry and deployment adapter. */
export const GROK_BUILD_STANDARD_SKILLS_PATH = '.grok/.aiwg/skills';

export const GROK_HOME_ENV = 'GROK_HOME';

export type GrokHomeResolution =
  | { ok: true; path: string; source: 'env' | 'default' }
  | { ok: false; reason: 'not-absolute' | 'traversal' | 'empty' | 'root'; message: string };

export function isGrokFilesystemRoot(
  resolved: string,
  pathFlavor: Pick<typeof path, 'parse'> = path,
): boolean {
  return pathFlavor.parse(resolved).root === resolved;
}

function expandHomePrefix(raw: string, userHome = homedir()): string {
  if (raw === '~') return raw;
  if (raw.startsWith('~/')) return path.join(userHome, raw.slice(2));
  return raw;
}

/**
 * Resolve Grok Build home directory.
 * When unset, defaults to `~/.grok` (expanded). Explicit env must be absolute or `~/…`.
 */
export function resolveGrokHomeResult(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): GrokHomeResolution {
  const raw = (env[GROK_HOME_ENV] || '').trim();
  const fromEnv = Boolean(raw);
  const candidate = fromEnv ? raw : path.join(userHome, '.grok');
  const expanded = expandHomePrefix(candidate, userHome);

  if (expanded === '~' || expanded.startsWith('~')) {
    return {
      ok: false,
      reason: 'not-absolute',
      message: `${GROK_HOME_ENV} must be an absolute path or ~/… (got '${raw || '(default)'}'). Bare '~' is rejected.`,
    };
  }

  if (!path.isAbsolute(expanded)) {
    return {
      ok: false,
      reason: 'not-absolute',
      message: `${GROK_HOME_ENV} must be an absolute path (got '${raw}'). Relative overrides are rejected.`,
    };
  }

  if (raw.includes('\0') || expanded.includes('\0')) {
    return {
      ok: false,
      reason: 'traversal',
      message: `${GROK_HOME_ENV} contains an invalid path character.`,
    };
  }

  const resolved = path.resolve(expanded);
  if (!resolved || isGrokFilesystemRoot(resolved)) {
    return {
      ok: false,
      reason: 'root',
      message: `${GROK_HOME_ENV} resolves to filesystem root; refuse to deploy there.`,
    };
  }

  return { ok: true, path: resolved, source: fromEnv ? 'env' : 'default' };
}

export function resolveGrokHome(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string | null {
  const result = resolveGrokHomeResult(env, userHome);
  return result.ok ? result.path : null;
}

export function grokBuildProjectPaths() {
  return {
    skills: '.grok/skills',
    agents: '.grok/agents',
    rules: '.grok/rules',
    hooks: '.grok/hooks',
    config: '.grok/config.toml',
    agentsMd: 'AGENTS.md',
  } as const;
}

export function grokBuildUserPaths(grokHome: string) {
  return {
    skills: path.join(grokHome, 'skills'),
    agents: path.join(grokHome, 'agents'),
  } as const;
}

export function grokHomeRemediation(env: NodeJS.ProcessEnv = process.env): string {
  const result = resolveGrokHomeResult(env);
  if (result.ok) return `${GROK_HOME_ENV}=${result.path} (${result.source})`;
  return result.message;
}
