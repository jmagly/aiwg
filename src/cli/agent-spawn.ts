/**
 * Agent Spawn Utility
 *
 * Centralized utility for spawning agentic CLI tools across providers.
 * Handles --dangerous, --provider, and --params passthrough flags uniformly
 * across all commands that invoke an underlying agent system.
 *
 * Usage pattern:
 *   const { opts, remaining } = parseAgentSpawnFlags(ctx.args);
 *   const config = getProviderConfig(opts.provider);
 *   const spawnArgs = buildAgentArgs(prompt, opts);
 *   spawn(config.binary, spawnArgs, { stdio: 'inherit' });
 */

// ── Provider configuration ────────────────────────────────────

/**
 * Per-provider spawn configuration.
 *
 * binary: CLI binary name (null = IDE-integrated, cannot be spawned)
 * dangerousFlag: Flag that enables unrestricted/bypass mode for this provider
 *   (null = provider does not support a dangerous mode via CLI flag)
 * name: Human-readable display name
 * guidanceMessage: Shown instead of spawning when binary is null
 */
export interface ProviderConfig {
  binary: string | null;
  dangerousFlag: string | null;
  name: string;
  /**
   * Args to prepend before the prompt when spawning.
   * e.g. opencode requires ['run'] → `opencode run "<prompt>"`
   * Defaults to [] (prompt is the first arg).
   */
  promptPrefix?: string[];
  guidanceMessage?: string;
}

export const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  antigravity: {
    binary: 'agy',
    dangerousFlag: '--dangerously-skip-permissions',
    name: 'Google Antigravity CLI',
  },
  claude: {
    binary: 'claude',
    dangerousFlag: '--dangerously-skip-permissions',
    name: 'Claude Code',
  },
  opencode: {
    binary: 'opencode',
    // OpenCode uses `opencode run "<prompt>"` for non-interactive execution.
    // Dangerous mode flag not yet confirmed; omit rather than guess.
    promptPrefix: ['run'],
    dangerousFlag: null,
    name: 'OpenCode',
  },
  codex: {
    binary: 'codex',
    // Current Codex releases use the explicit bypass flag for unrestricted,
    // non-interactive execution. Keep this centralized so every launcher maps
    // AIWG's --dangerous option consistently.
    dangerousFlag: '--dangerously-bypass-approvals-and-sandbox',
    name: 'OpenAI Codex',
  },
  'deepseek-harness': {
    binary: 'dsh',
    dangerousFlag: null,
    name: 'DeepSeek Harness',
    promptPrefix: ['--profile', 'headless'],
  },
  hermes: {
    // Hermes is a model series (NousResearch), not a confirmed standalone CLI.
    // Treat as IDE/runtime-integrated until a CLI is confirmed.
    binary: null,
    dangerousFlag: null,
    name: 'Hermes',
    guidanceMessage:
      'Hermes does not have a confirmed standalone CLI.\n' +
      'Run via Ollama (`ollama run hermes3`) or through your configured MCP sidecar.',
  },
  copilot: {
    binary: null,
    dangerousFlag: null,
    name: 'GitHub Copilot',
    guidanceMessage:
      'GitHub Copilot is IDE-integrated and cannot be spawned from the CLI.\n' +
      'Open your IDE, navigate to the Copilot chat panel, and run the skill manually.',
  },
  cursor: {
    binary: null,
    dangerousFlag: null,
    name: 'Cursor',
    guidanceMessage:
      'Cursor is IDE-integrated and cannot be spawned from the CLI.\n' +
      'For unrestricted AIWG tool access, use the MCP sidecar:\n' +
      '  aiwg mcp install cursor && aiwg mcp serve\n' +
      'See: docs/integrations/cursor-mcp-sidecar.md',
  },
  factory: {
    binary: null,
    dangerousFlag: null,
    name: 'Factory AI',
    guidanceMessage:
      'Factory AI is cloud-based and cannot be spawned from the CLI.\n' +
      'Use the Factory AI dashboard to dispatch the workflow.',
  },
  warp: {
    binary: null,
    dangerousFlag: null,
    name: 'Warp Terminal',
    guidanceMessage:
      'Warp Terminal cannot be spawned programmatically.\n' +
      'For unrestricted AIWG tool access, use the MCP sidecar:\n' +
      '  aiwg mcp install warp && aiwg mcp serve\n' +
      'See: docs/integrations/warp-mcp-sidecar.md',
  },
  devin: {
    binary: null,
    dangerousFlag: null,
    name: 'Devin Desktop',
    guidanceMessage:
      'Devin Desktop is IDE-integrated and cannot be spawned from the CLI.\n' +
      'For unrestricted AIWG tool access, use the MCP sidecar:\n' +
      '  aiwg mcp install devin && aiwg mcp serve\n' +
      'See: docs/integrations/windsurf-mcp-sidecar.md',
  },
};

// ── Flag parsing ──────────────────────────────────────────────

export interface AgentSpawnOptions {
  /** Provider override (default: 'claude') */
  provider?: string;
  /** Enable dangerous/unrestricted mode via provider-specific flag */
  dangerous?: boolean;
  /**
   * Raw args to append to the agent binary call verbatim.
   * The user is responsible for correctness — no validation performed.
   * Accepts a space-separated string; quoted segments are preserved.
   *
   * Example: --params "--output-format json --timeout 120"
   */
  params?: string;
}

/**
 * Extract --provider, --dangerous, and --params from an args array.
 * Returns the parsed options and the remaining args with those flags removed.
 *
 * This is non-destructive — the original array is not modified.
 */
export function parseAgentSpawnFlags(args: string[]): {
  opts: AgentSpawnOptions;
  remaining: string[];
} {
  const opts: AgentSpawnOptions = {};
  const remaining: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--provider' && i + 1 < args.length) {
      opts.provider = args[++i];
    } else if (arg === '--dangerous') {
      opts.dangerous = true;
    } else if (arg === '--params' && i + 1 < args.length) {
      opts.params = args[++i];
    } else {
      remaining.push(arg);
    }
  }

  return { opts, remaining };
}

// ── Arg construction ──────────────────────────────────────────

/**
 * Build the final args array for spawning a provider binary.
 *
 * Order: [prompt, dangerous-flag?, ...raw-params]
 */
export function buildAgentArgs(prompt: string, opts: AgentSpawnOptions): string[] {
  const config = getProviderConfig(opts.provider ?? 'claude');
  const args: string[] = [];

  // Dangerous flag must precede the prompt — it is a CLI flag to the binary,
  // not content to pass to the agent. e.g. `claude --dangerously-skip-permissions "<prompt>"`
  if (opts.dangerous && config.dangerousFlag) {
    args.push(config.dangerousFlag);
    // If provider has no dangerous flag, silently ignored —
    // callers should warn via dangerousWarning().
  }

  // Some providers require a subcommand before the prompt (e.g. `opencode run "<prompt>"`)
  args.push(...(config.promptPrefix ?? []));

  // The prompt
  args.push(prompt);

  // User passthrough params — appended after the prompt verbatim
  if (opts.params) {
    args.push(...splitParams(opts.params));
  }

  return args;
}

/**
 * Split a params string into individual args, respecting double/single quotes.
 * "hello world" → ['hello world']
 * --flag value  → ['--flag', 'value']
 */
export function splitParams(params: string): string[] {
  const result: string[] = [];
  const re = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(params)) !== null) {
    // Strip surrounding quotes from individual tokens
    result.push(match[0].replace(/^["']|["']$/g, ''));
  }
  return result;
}

// ── Provider helpers ──────────────────────────────────────────

const SPAWN_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  agy: 'antigravity',
  dsh: 'deepseek-harness',
};

/** Get config for a provider. Unknown values fail closed instead of launching another harness. */
export function getProviderConfig(provider: string): ProviderConfig {
  const candidate = provider.trim().toLowerCase();
  const canonical = SPAWN_PROVIDER_ALIASES[candidate] ?? candidate;
  const config = PROVIDER_CONFIGS[canonical];
  if (!config) throw new Error(`Unsupported provider '${provider}'`);
  return config;
}

/** Returns true if the provider has a CLI binary that can be spawned. */
export function isSpawnableProvider(provider: string): boolean {
  return getProviderConfig(provider).binary !== null;
}

/**
 * Warn string if --dangerous was requested but the provider has no
 * corresponding flag. Returns null if the combination is valid.
 */
export function dangerousWarning(provider: string): string | null {
  const config = getProviderConfig(provider);
  if (!config.dangerousFlag) {
    return `--dangerous is not supported for provider '${config.name}' and will be ignored.`;
  }
  return null;
}

/** List all spawnable provider names. */
export function spawnableProviders(): string[] {
  return Object.entries(PROVIDER_CONFIGS)
    .filter(([, c]) => c.binary !== null)
    .map(([k]) => k);
}
