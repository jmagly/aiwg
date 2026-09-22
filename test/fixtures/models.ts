/**
 * Shared test fixture for model names, provider strings, and config values.
 *
 * ALL test files should import model names from here instead of hardcoding them.
 * When a model name changes, update this ONE file and all tests follow.
 *
 * @issue #614
 * @see agentic/code/frameworks/sdlc-complete/config/models-v2.json (source of truth for resolver)
 * @see tools/ralph-external/lib/*-adapter.mjs (source of truth for adapter mappings)
 * @see tools/agents/providers/factory.mjs (source of truth for factory deploy models)
 * @see tools/agents/providers/base.mjs (source of truth for default model config)
 */

// ---------------------------------------------------------------------------
// Model Resolver expected outputs (from models-v2.json)
// These are the model IDs returned by ModelResolver for a given provider+role.
// ---------------------------------------------------------------------------

export const CLAUDE_MODELS = {
  reasoning: 'claude-opus-5',
  coding: 'claude-sonnet-5',
  efficiency: 'claude-haiku-4-5',
} as const;

export const OPENAI_MODELS = {
  reasoning: 'gpt-5.6-sol',
  coding: 'gpt-5.6-terra',
  efficiency: 'gpt-5.6-luna',
} as const;

// ---------------------------------------------------------------------------
// Provider adapter model mappings (from *-adapter.mjs MODEL_MAP constants)
// These are the model IDs that each adapter maps generic aliases (opus/sonnet/haiku) to.
// ---------------------------------------------------------------------------

export const CODEX_ADAPTER_MODELS = {
  opus: 'gpt-5.6-sol',
  sonnet: 'gpt-5.6-terra',
  haiku: 'gpt-5.6-luna',
} as const;

/** Flagship IDs are user-elected only and must never be reached via an alias. */
export const FLAGSHIP_MODELS = {
  claude: 'claude-fable-5-1',
  openai: 'gpt-6-astra',
} as const;

export const OPENCODE_ADAPTER_MODEL = 'opencode/big-pickle';

export const FACTORY_ADAPTER_MODELS = {
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5-20251001',
} as const;

// ---------------------------------------------------------------------------
// Factory agent deployer models (from tools/agents/providers/factory.mjs + base.mjs)
// These are the models used by the agent deploy system for Factory provider.
// ---------------------------------------------------------------------------

export const FACTORY_DEPLOY_MODELS = {
  reasoning: 'heavy',
  coding: 'medium',
  efficiency: 'light',
} as const;

export const DEFAULT_SHORTHAND = {
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5-20251001',
  inherit: 'inherit',
} as const;

// ---------------------------------------------------------------------------
// OpenCode deployment models (namespaced format used by opencode provider)
// ---------------------------------------------------------------------------

export const OPENCODE_DEPLOY_MODELS = {
  reasoning: 'anthropic/claude-opus-5',
  coding: 'anthropic/claude-sonnet-5',
  efficiency: 'anthropic/claude-haiku-4-5-20251001',
} as const;

// ---------------------------------------------------------------------------
// Catalog test models (mock data used in catalog loader tests)
// ---------------------------------------------------------------------------

export const CATALOG_MOCK = {
  claudeOpus: {
    id: 'claude-opus-4-5',
    provider: 'anthropic',
    displayName: 'Claude Opus 4.5',
    aliases: ['opus', 'opus-4.5'],
  },
  gpt4o: {
    id: 'gpt-4o',
    provider: 'openai',
    displayName: 'GPT-4o',
    aliases: ['gpt4o'],
  },
} as const;

// ---------------------------------------------------------------------------
// Provider names
// ---------------------------------------------------------------------------

export const PROVIDERS = {
  ANTHROPIC: 'anthropic',
  OPENAI: 'openai',
  CLAUDE: 'claude',
  CODEX: 'codex',
  OPENCODE: 'opencode',
  FACTORY: 'factory',
  WARP: 'warp',
  COPILOT: 'copilot',
} as const;

// ---------------------------------------------------------------------------
// Legacy / misc model names used in validation or edge-case tests
// ---------------------------------------------------------------------------

export const LEGACY_MODELS = {
  claudeOpusOld: 'claude-opus-4-1-20250805',
  gpt4: 'gpt-4',
  gpt4turbo: 'gpt-4-turbo',
  gpt51: 'gpt-5.1',
  gpt5codex: 'gpt-5-codex',
  gpt5codexMini: 'gpt-5-codex-mini',
  gpt53codex: 'gpt-5.3-codex',
} as const;

// ---------------------------------------------------------------------------
// Helper: build a complete defaultModelsConfig for Factory model-override tests
// ---------------------------------------------------------------------------

export function buildFactoryModelsConfig() {
  return {
    factory: {
      reasoning: { model: FACTORY_DEPLOY_MODELS.reasoning },
      coding: { model: FACTORY_DEPLOY_MODELS.coding },
      efficiency: { model: FACTORY_DEPLOY_MODELS.efficiency },
    },
    factory_shorthand: {
      opus: FACTORY_DEPLOY_MODELS.reasoning,
      sonnet: FACTORY_DEPLOY_MODELS.coding,
      haiku: FACTORY_DEPLOY_MODELS.efficiency,
      inherit: 'inherit',
    },
    shorthand: { ...DEFAULT_SHORTHAND },
  };
}
