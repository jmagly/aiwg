/**
 * Hook bridge shim — env-var contract substitution + canonical schemas.
 *
 * Per ADR-3 §2: hook authors write canonical $AIWG_* env vars. Translators
 * substitute them with the provider-native equivalents at deploy time so
 * authors don't need to maintain N copies of the same hook.
 */

import { AIWG_ENV_VARS, NATIVE_ENV_VAR_MAP } from './types.js';

/**
 * Substitute canonical AIWG env vars with the provider's native equivalents.
 *
 * Example for codex:
 *   "$AIWG_PROJECT_DIR/scripts/scan.sh"  →  "$CODEX_WORKSPACE/scripts/scan.sh"
 *
 * When a provider has no native equivalent for a given canonical var, the
 * canonical name is preserved. Hook authors who need the value despite the
 * gap can rely on the runtime shim setting $AIWG_PROJECT_DIR (etc.) before
 * invoking the command — that's the per-ADR-3-§2 fallback.
 */
export function substituteEnvVars(input: string, provider: string): string {
  const mapping = NATIVE_ENV_VAR_MAP[provider];
  if (!mapping) return input;

  let out = input;
  for (const [canonicalKey, canonicalRef] of Object.entries(AIWG_ENV_VARS)) {
    const native = mapping[canonicalKey];
    if (!native) continue;
    // Replace both $VAR and ${VAR} forms.
    const escaped = canonicalRef.replace(/\$/g, '\\$');
    out = out.replace(new RegExp(escaped + '\\b', 'g'), native);
    out = out.replace(new RegExp('\\${' + canonicalRef.slice(1) + '}', 'g'), native);
  }
  return out;
}

/**
 * Canonical AIWG stdin schema (per ADR-3 §3). Translators wrap the hook
 * command with a small shim that normalizes the provider's native stdin to
 * this shape before piping to the actual hook.
 */
export interface AiwgHookStdin {
  event: string;
  tool?: string;
  args?: unknown[];
  project_dir?: string;
  session_id?: string;
}

/**
 * Canonical exit-code mapping per ADR-3 §4.
 *
 * AIWG canonical:
 *   0 = allow
 *   1 = block
 *   2 = warn-and-continue
 *
 * Provider mapping returns the native exit code(s) that mean each AIWG
 * semantic. Used by the wrapper shim to translate hook exit codes back to
 * what the provider expects.
 */
export const EXIT_CODE_MAP: Record<string, { allow: number; block: number; warn: number }> = {
  claude: { allow: 0, block: 1, warn: 0 /* warn surfaces via stderr only */ },
  codex: { allow: 0, block: 1, warn: 2 },
  copilot: { allow: 0, block: 1, warn: 0 },
  factory: { allow: 0, block: 1, warn: 0 },
  hermes: { allow: 0, block: 1, warn: 2 },
  openclaw: { allow: 0, block: 1, warn: 2 },
  // Grok only honors an explicit PreToolUse deny decision; other failures are fail-open.
  'grok-build': { allow: 0, block: 2, warn: 0 },
};

/**
 * Generate a small bash shim that:
 *   1. exports $AIWG_PROJECT_DIR + $AIWG_TOOL_NAME from native env vars
 *   2. reads native stdin, transforms to AIWG canonical JSON
 *   3. pipes to the hook command
 *   4. translates the exit code back per ADR-3 §4
 *
 * The shim is what gets installed as the actual hook artifact on the
 * provider; the AIWG hook command runs inside it.
 */
export function generateShimBash(provider: string, hookCommand: string, args: string[] = []): string {
  const native = NATIVE_ENV_VAR_MAP[provider] || {};
  const projectDirSrc = native.PROJECT_DIR || '$PWD';
  const toolNameSrc = native.TOOL_NAME || '"${AIWG_TOOL_NAME:-unknown}"';

  // Substitute canonical env vars in the command + args ahead of shim emission
  // so the shim invocation references native names where available.
  const subCommand = substituteEnvVars(hookCommand, provider);
  const subArgs = args.map((a) => substituteEnvVars(a, provider));

  return [
    '#!/usr/bin/env bash',
    `# AIWG hook bridge shim (ADR-3) — provider: ${provider}`,
    'set -e',
    '',
    `export AIWG_PROJECT_DIR="${projectDirSrc}"`,
    `export AIWG_TOOL_NAME=${toolNameSrc}`,
    `export AIWG_HOOK_EVENT="${'${AIWG_HOOK_EVENT:-unknown}'}"`,
    '',
    '# Forward stdin verbatim. Hook command can re-parse if it needs the',
    '# canonical AIWG schema; the env-var contract above is the primary',
    '# integration surface for cross-provider portability.',
    `${subCommand}${subArgs.length ? ' ' + subArgs.map((a) => `"${a}"`).join(' ') : ''}`,
  ].join('\n');
}
