/**
 * Cross-provider hook bridge types (PUW-018 / #1119).
 *
 * Per ADR-3 §1: AIWG hooks are authored in a canonical source format and
 * per-provider translators emit native artifacts at deploy time. This module
 * defines the shared type surface that translators consume.
 */

/**
 * Canonical AIWG hook event names. Per-provider translators map these to the
 * provider's native event taxonomy (Claude `PreToolUse`, OpenClaw
 * `before_tool_call`, Codex `pre_tool`, etc.).
 *
 * Extending the enum requires an ADR amendment because every translator must
 * grow a mapping entry.
 */
export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop';

/**
 * Canonical exit code semantic (per ADR-3 §4). Translators map to provider
 * native exit codes.
 */
export type HookExitSemantic = 'allow' | 'block' | 'warn';

/**
 * Source format authored in AIWG. One file per hook, frontmatter declares
 * subscription, body documents the hook.
 */
export interface HookSource {
  /** kebab-case identifier */
  id: string;
  /** One-line description */
  description: string;
  /** Events this hook subscribes to */
  events: HookEvent[];
  /** Shell command or script invocation. Uses canonical $AIWG_* env vars. */
  command: string;
  /** Optional command arguments (template strings using canonical env vars). */
  args?: string[];
  /** Per ADR-3 / adr-override-shadow-policy.md — pin to priority 1; never auto-disable. */
  safetyCritical?: boolean;
  /** Provider IDs to skip emission for (rather than degrading silently). */
  degradeOn?: string[];
  /** Working directory hint (relative to project root). Defaults to project root. */
  workingDir?: string;
}

/**
 * Result of one translator pass. Translators write zero or more files
 * (varying per provider) and report what they did.
 */
export interface TranslateResult {
  provider: string;
  emittedPaths: string[];
  warnings: string[];
  /** Set when this provider is in source.degradeOn or otherwise unsupported. */
  skipped: boolean;
  skipReason?: string;
}

/**
 * Provider-specific deploy options. Translators use these to locate target
 * directories and detect dry-run mode.
 */
export interface TranslateOptions {
  /** Project root absolute path */
  projectPath: string;
  /** Don't write files; describe what would happen */
  dryRun?: boolean;
  /** Force overwrite of operator-claimed files (with backup per ADR-3 §5) */
  force?: boolean;
  /** Verbose log output */
  verbose?: boolean;
}

/**
 * Per-provider translator interface. Each provider supplies a function that
 * matches this shape; the orchestrator calls it once per hook source.
 */
export type ProviderTranslator = (
  source: HookSource,
  options: TranslateOptions,
) => Promise<TranslateResult>;

/**
 * Per-provider event mapping table. Drives the env-var contract substitution
 * in the deploy-time shim (ADR-3 §2).
 */
export interface EventMapping {
  /** Native provider event name */
  nativeName: string;
  /** Native env vars exposed by the provider (used by reverse mapping) */
  nativeEnvVars: Record<string, string>;
}

/** Canonical AIWG env vars. Translators substitute these at deploy time. */
export const AIWG_ENV_VARS = {
  PROJECT_DIR: '$AIWG_PROJECT_DIR',
  TOOL_NAME: '$AIWG_TOOL_NAME',
  HOOK_EVENT: '$AIWG_HOOK_EVENT',
  SESSION_ID: '$AIWG_SESSION_ID',
} as const;

/** Native env-var contract per ADR-3 §2 table. */
export const NATIVE_ENV_VAR_MAP: Record<string, Record<string, string>> = {
  claude: {
    PROJECT_DIR: '$CLAUDE_PROJECT_DIR',
    TOOL_NAME: '$CLAUDE_TOOL_NAME',
  },
  factory: {
    PROJECT_DIR: '$FACTORY_PROJECT_DIR',
  },
  codex: {
    PROJECT_DIR: '$CODEX_WORKSPACE',
  },
  copilot: {
    PROJECT_DIR: '$GITHUB_WORKSPACE',
  },
  'grok-build': {
    PROJECT_DIR: '$GROK_WORKSPACE_ROOT',
    HOOK_EVENT: '$GROK_HOOK_EVENT',
    SESSION_ID: '$GROK_SESSION_ID',
  },
};
