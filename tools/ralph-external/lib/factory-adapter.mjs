/**
 * Factory (Droid) CLI Provider Adapter for External Ralph Loop
 *
 * Provides support for Factory's Droid CLI as a provider for
 * autonomous task execution in Ralph loops.
 *
 * Droid CLI differences from Claude:
 * - Binary: `droid` instead of `claude`
 * - Headless mode: `droid exec` subcommand
 * - Permission bypass: `--skip-permissions-unsafe` instead of `--dangerously-skip-permissions`
 * - Output format: `--output-format text|stream-json` (supports stream-json!)
 * - Session resume: `-s/--session-id <id>` with prompt required
 * - Model selection: `-m/--model <id>` (direct model IDs, not generic)
 * - No --print flag (exec is already non-interactive)
 * - No --append-system-prompt (inject into main prompt)
 * - No --max-budget-usd flag
 * - No --max-turns flag
 * - No --mcp-config flag (but has MCP subcommand)
 * - No --agent flag
 * - Autonomy levels: --auto low|medium|high (alternative to skip-permissions)
 *
 * @implements Plan: Multi-Provider Support for External Ralph Loop
 */

import { ProviderAdapter, registerProvider } from './provider-adapter.mjs';

/** Model mapping from generic names to Factory/Droid model IDs */
const MODEL_MAP = {
  'opus': 'claude-opus-5',
  'sonnet': 'claude-sonnet-5',
  'haiku': 'claude-haiku-4-5-20251001',
};

export class FactoryAdapter extends ProviderAdapter {
  /** @returns {string} */
  getBinary() {
    return 'droid';
  }

  /** @returns {string} */
  getName() {
    return 'factory';
  }

  /**
   * Factory supports stream-json output and session resume.
   * @returns {import('./provider-adapter.mjs').ProviderCapabilities}
   */
  getCapabilities() {
    return {
      streamJson: true,
      sessionResume: true,
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
   * Factory uses `droid exec --skip-permissions-unsafe` for headless operation.
   *
   * @param {import('./provider-adapter.mjs').SessionArgs} options
   * @returns {string[]}
   */
  buildSessionArgs(options) {
    const args = [
      'exec',
      // SECURITY: --skip-permissions-unsafe bypasses ALL permission prompts
      // Equivalent to Claude's --dangerously-skip-permissions
      '--skip-permissions-unsafe',
      '--output-format', 'stream-json',
    ];

    // Model selection (map generic to Factory model IDs)
    if (options.model) {
      args.push('-m', this.mapModel(options.model));
    }

    // Session resume
    if (options.sessionId) {
      args.push('-s', options.sessionId);
    }

    // Budget control not supported
    if (options.budget) {
      this.warnUnsupported('budgetControl', 'Budget control (--max-budget-usd)');
    }

    // Max turns not supported
    if (options.maxTurns) {
      this.warnUnsupported('maxTurns', 'Max turns (--max-turns)');
    }

    // MCP configuration not supported via flag
    if (options.mcpConfig) {
      this.warnUnsupported('mcpConfig', 'MCP configuration (--mcp-config)');
    }

    // System prompt: Factory doesn't support --append-system-prompt,
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
   * Uses read-only mode (no --skip-permissions-unsafe) since analysis
   * calls only need to read and reason, not modify files.
   *
   * @param {import('./provider-adapter.mjs').AnalysisArgs} options
   * @returns {string[]}
   */
  buildAnalysisArgs(options) {
    const args = [
      'exec',
      '--output-format', 'text',
    ];

    // Model selection
    if (options.model) {
      args.push('-m', this.mapModel(options.model));
    }

    // Agent flag not supported by Factory
    if (options.agent) {
      // Silently skip - agent context will be in the prompt itself
    }

    // The analysis prompt (must be last)
    args.push(options.prompt);

    return args;
  }

  /**
   * Map generic model names to Factory/Droid model IDs.
   *
   * @param {string} genericModel
   * @returns {string}
   */
  mapModel(genericModel) {
    const mapped = MODEL_MAP[genericModel.toLowerCase()];
    if (mapped) return mapped;
    // Pass through if already a Factory model name or unknown
    return genericModel;
  }

  /**
   * Environment overrides for headless Factory sessions.
   * @returns {Object<string, string>}
   */
  getEnvOverrides() {
    return {
      CI: 'true',
    };
  }

  /**
   * Factory does not expose session transcripts in a known file path.
   * @returns {null}
   */
  getTranscriptPath() {
    return null;
  }

  /**
   * Parse Factory output — supports stream-json or text.
   *
   * @param {string} stdout
   * @returns {Object|null}
   */
  parseOutput(stdout) {
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
registerProvider('factory', () => new FactoryAdapter());

export default FactoryAdapter;
