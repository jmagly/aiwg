/**
 * CLI Handler Types
 *
 * Defines the interface for CLI command handlers extracted from the monolithic router.
 *
 * @implements @docs/architecture/cli/adr-001-unified-extension-registry.md
 * @source @src/cli/router.ts
 * @issue #33
 */

/**
 * Result of a CLI handler execution
 */
export interface HandlerResult {
  /** Exit code (0 = success, non-zero = error) */
  exitCode: number;

  /** Output message (optional) */
  message?: string;

  /** Emit message verbatim to stdout, including for non-zero machine-readable results. */
  rawOutput?: boolean;

  /** Error details (optional) */
  error?: Error;
}

/**
 * Context passed to handlers
 */
export interface HandlerContext {
  /** Command arguments (after the command name) */
  args: string[];

  /** Raw arguments including command name */
  rawArgs: string[];

  /** Current working directory */
  cwd: string;

  /** Framework root path */
  frameworkRoot: string;

  /** Whether running in dry-run mode */
  dryRun?: boolean;

  /**
   * Cancellation signal. Aborted on SIGINT/SIGTERM by the top-level entry.
   * Long-running handlers MUST check `signal.aborted` between iterations
   * (or `throwIfAborted()`), and any fetch()/child-process call that
   * accepts a signal MUST plumb this through (typically via
   * `AbortSignal.any([ctx.signal, AbortSignal.timeout(N)])`).
   *
   * Handlers that never block or loop can safely ignore this field.
   * Optional so existing handlers can adopt incrementally (#920).
   */
  signal?: AbortSignal;
}

/**
 * CLI command handler interface
 *
 * All extracted handlers implement this interface for uniform dispatch.
 */
export interface CommandHandler {
  /** Handler identifier matching command name */
  id: string;

  /** Human-readable name */
  name: string;

  /** Description for help text */
  description: string;

  /** Command category for help grouping */
  category: CommandCategory;

  /** Command aliases (e.g., ['-new', '--new'] for 'new') */
  aliases: string[];

  /**
   * Display command-specific help without entering the command execution path.
   *
   * The router calls this callback when `--help` or `-h` is present. Handlers
   * that omit it receive a generic, non-executing fallback instead.
   */
  help?(ctx: HandlerContext): Promise<HandlerResult>;

  /** Execute the handler */
  execute(ctx: HandlerContext): Promise<HandlerResult>;
}

/**
 * Command categories for help text grouping
 */
export type CommandCategory =
  | 'framework'     // Framework management (use, list, remove)
  | 'project'       // Project setup (new)
  | 'workspace'     // Workspace management (status, migrate, rollback)
  | 'mcp'           // MCP server commands
  | 'toolsmith'     // Runtime discovery
  | 'catalog'       // Model catalog
  | 'utility'       // Utilities (prefill-cards, validate-metadata, etc.)
  | 'plugin'        // Plugin packaging
  | 'scaffolding'   // Scaffolding (add-agent, scaffold-addon, etc.)
  | 'channel'       // Channel management
  | 'maintenance'   // Maintenance (doctor, version, update, help)
  | 'ralph'         // Agent loop
  | 'index'         // Artifact index
  | 'orchestration' // Mission Control
  | 'daemon'        // Daemon and behavior management
  | 'config'        // User-level config management
  | 'ops'           // Operations ecosystem management
  | 'sandbox'       // Sandbox agent management (alias, resolve, identities)
  | 'agentic-tools'; // Support tools for agentic sessions (RLM chunk, fanout, etc.)

/**
 * Handler factory function type
 */
export type HandlerFactory = () => CommandHandler;

/**
 * Script runner options
 */
export interface ScriptRunnerOptions {
  /** Working directory */
  cwd?: string;

  /** Additional environment variables */
  env?: Record<string, string>;

  /** Shell variables withheld from unrelated script recipients. */
  omitEnv?: readonly string[];

  /** Timeout in milliseconds */
  timeout?: number;

  /** Capture stdout/stderr instead of inheriting (for quiet mode) */
  capture?: boolean;

  /** File-backed stdout capture; caller owns and closes the descriptor. */
  stdoutFd?: number;
}

/**
 * Script runner interface for delegating to existing scripts
 */
export interface ScriptRunner {
  /**
   * Run a script from the framework root
   *
   * @param scriptPath - Relative path to script from framework root
   * @param args - Arguments to pass to the script
   * @param options - Execution options
   */
  run(scriptPath: string, args: string[], options?: ScriptRunnerOptions): Promise<HandlerResult>;
}
