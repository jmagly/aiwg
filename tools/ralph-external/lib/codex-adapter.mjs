/**
 * Codex CLI Provider Adapter for External Ralph Loop
 *
 * Provides support for OpenAI's Codex CLI as a provider for
 * autonomous task execution in Ralph loops.
 *
 * Codex CLI differences from Claude:
 * - Binary: `codex` instead of `claude`
 * - Headless flag: `--dangerously-bypass-approvals-and-sandbox` (full dangerous mode)
 * - Requires `--skip-git-repo-check` for temp/non-git working directories
 * - No stream-json output format (text only)
 * - No session resume capability
 * - No --agent flag
 * - No --mcp-config flag
 * - No --append-system-prompt flag (inject into main prompt)
 * - No --max-budget-usd flag
 * - Model: generic aliases map to the GPT-5.6 tier ladder (sol / terra / luna)
 *
 * @implements Plan: Multi-Provider Support for External Ralph Loop
 */

import { ProviderAdapter, registerProvider } from './provider-adapter.mjs';

/**
 * Model mapping from generic names to Codex-specific models.
 *
 * Tier-equivalent mapping (observed in Codex model/list, 2026-09-21):
 * premium = gpt-5.6-sol, standard = gpt-5.6-terra, economy = gpt-5.6-luna.
 * The flagship gpt-6-astra is never selected by an alias; pass it explicitly
 * (e.g., --model gpt-6-astra) when the user elects it.
 */
const MODEL_MAP = {
  'opus':   'gpt-5.6-sol',
  'sonnet': 'gpt-5.6-terra',
  'haiku':  'gpt-5.6-luna',
};

export class CodexAdapter extends ProviderAdapter {
  /** @returns {string} */
  getBinary() {
    return 'codex';
  }

  /** @returns {string} */
  getName() {
    return 'codex';
  }

  /**
   * Codex has limited capabilities compared to Claude.
   * @returns {import('./provider-adapter.mjs').ProviderCapabilities}
   */
  getCapabilities() {
    return {
      streamJson: false,
      sessionResume: false,
      budgetControl: false,
      systemPrompt: false,
      agentMode: false,
      mcpConfig: false,
      maxTurns: false,
    };
  }

  /**
   * Build args for the main headless session.
   *
   * Codex uses `--full-auto` for headless operation and has a different
   * argument structure than Claude.
   *
   * @param {import('./provider-adapter.mjs').SessionArgs} options
   * @returns {string[]}
   */
  buildSessionArgs(options) {
    const args = [
      // Codex requires the 'exec' subcommand for non-interactive (headless) use.
      'exec',
      // SECURITY: bypass ALL confirmation prompts and sandboxing.
      // Required for headless operation in temp directories (UAT, daemon tasks).
      // Equivalent to Claude's --dangerously-skip-permissions.
      '--dangerously-bypass-approvals-and-sandbox',
      // Allow running outside a git repository (temp dirs used by UAT and daemon).
      '--skip-git-repo-check',
    ];

    // Model selection (map generic to Codex-specific)
    if (options.model) {
      args.push('--model', this.mapModel(options.model));
    }

    // Budget control not supported - warn if requested
    if (options.budget) {
      this.warnUnsupported('budgetControl', 'Budget control (--max-budget-usd)');
    }

    // Max turns not supported
    if (options.maxTurns) {
      this.warnUnsupported('maxTurns', 'Max turns (--max-turns)');
    }

    // Session ID not supported - each iteration is a fresh session
    if (options.sessionId) {
      this.warnUnsupported('sessionResume', 'Session resume (--session-id)');
    }

    // MCP configuration not supported
    if (options.mcpConfig) {
      this.warnUnsupported('mcpConfig', 'MCP configuration (--mcp-config)');
    }

    // System prompt: Codex doesn't support --append-system-prompt,
    // so we prepend it to the main prompt
    let prompt = options.prompt;
    if (options.systemPrompt) {
      prompt = `[System Context]\n${options.systemPrompt}\n\n[Task]\n${prompt}`;
    }

    // The prompt itself (must be last)
    args.push(prompt);

    return args;
  }

  /**
   * Build args for short analysis calls (spawnSync).
   *
   * Codex analysis calls use the same basic pattern but with
   * Codex-specific flags.
   *
   * @param {import('./provider-adapter.mjs').AnalysisArgs} options
   * @returns {string[]}
   */
  buildAnalysisArgs(options) {
    const args = [
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
    ];

    // Model selection
    if (options.model) {
      args.push('--model', this.mapModel(options.model));
    }

    // Agent flag not supported by Codex - inject agent context into prompt
    if (options.agent) {
      // Silently skip - agent context will be in the prompt itself
    }

    // The analysis prompt (must be last)
    args.push(options.prompt);

    return args;
  }

  /**
   * Map generic model names to Codex-specific models.
   *
   * Mirrors the catalog roles used by tools/agents/providers/codex.mjs:
   *   opus → gpt-5.6-sol
   *   sonnet → gpt-5.6-terra
   *   haiku → gpt-5.6-luna
   *
   * @param {string} genericModel
   * @returns {string}
   */
  mapModel(genericModel) {
    const mapped = MODEL_MAP[genericModel.toLowerCase()];
    if (mapped) return mapped;
    // Pass through if already a Codex model name or unknown
    return genericModel;
  }

  /**
   * Environment overrides for headless Codex sessions.
   * @returns {Object<string, string>}
   */
  getEnvOverrides() {
    return {
      CI: 'true',
    };
  }

  /**
   * Codex does not store session transcripts in a known location.
   * @returns {null}
   */
  getTranscriptPath() {
    return null;
  }

  /**
   * Parse Codex output - Codex returns plain text, not stream-json.
   * We still try to extract JSON from the output for analysis results.
   *
   * @param {string} stdout
   * @returns {Object|null}
   */
  parseOutput(stdout) {
    // Codex output is plain text. Try to find embedded JSON.
    try {
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      return JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }
  }
}

// Self-register on import
registerProvider('codex', () => new CodexAdapter());

export default CodexAdapter;
