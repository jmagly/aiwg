/**
 * AIWG MCP Subsystem Toolsets
 *
 * Exposes AIWG's CLI subsystems (memory, kb, reflections, provenance,
 * research-store, activity-log, index, ralph, mc, ops) as MCP toolsets.
 * Each toolset is opt-in via AIWG_MCP_TOOLSETS env var or `aiwg mcp
 * serve --toolsets=` flag (#1332 / S18).
 *
 * Default toolset enabled: `core` (already registered by discovery.mjs +
 * command-run.mjs in server.mjs).
 *
 * @architecture @.aiwg/architecture/sketch-hermes-mcp-parity.md DD-3
 * @issues #1322 (memory) #1323 (kb) #1324 (provenance) #1325 (activity-log)
 *         #1326 (index) #1327 (ralph) #1328 (ops) #1331 (mc) #1332 (dispatch)
 */

import { z } from 'zod';
import { runAiwgCli, mcpError, mcpJson } from '../helpers.mjs';
import { registerFlowToolset, registerMissionToolset } from './orchestration.mjs';
import { registerAgenticSandboxToolset } from './agentic-sandbox.mjs';

/**
 * Wrap an `aiwg <subsystem> <verb>` CLI call as an MCP tool.
 *
 * @param {object} cfg
 * @param {string} cfg.name              MCP tool name
 * @param {string} cfg.subsystem         CLI subsystem (e.g. "memory")
 * @param {string} cfg.verb              CLI verb (e.g. "list")
 * @param {string} cfg.title             MCP tool title
 * @param {string} cfg.description       Human-readable description
 * @param {object} cfg.inputSchema       zod schema
 * @param {boolean} [cfg.destructive]    Mark as destructive
 * @param {boolean} [cfg.readOnly]       Mark as read-only
 * @param {(args: object) => string[]} cfg.buildArgs  Convert MCP args to CLI argv tail (excluding subsystem + verb)
 * @param {(args: object) => string|undefined} [cfg.buildInput]  Optional stdin payload (for put commands)
 */
function registerSubsystemTool(server, cfg) {
  const {
    name,
    subsystem,
    verb,
    title,
    description,
    inputSchema,
    destructive = false,
    readOnly = false,
    buildArgs,
    buildInput,
  } = cfg;

  server.registerTool(name, {
    title,
    description,
    inputSchema,
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: destructive,
    },
  }, async (args) => {
    try {
      const cliArgs = [subsystem, verb, ...buildArgs(args)];
      const input = buildInput ? buildInput(args) : undefined;
      const { stdout, stderr, code } = await runAiwgCli(cliArgs, { input });
      if (code !== 0) {
        return mcpError(`${name} failed (exit ${code}): ${stderr || stdout}`);
      }
      // Prefer JSON if the output parses
      try {
        const parsed = JSON.parse(stdout);
        return mcpJson(parsed);
      } catch {
        return mcpJson({ output: stdout, stderr });
      }
    } catch (err) {
      return mcpError(`${name}: ${err.message}`);
    }
  });
}

// ============================================================================
// Storage subsystems (memory, kb, reflections, provenance, research-store)
//
// All five share the same CLI surface: path, list, get, put, delete.
// Generated via a single factory below.
// ============================================================================

const STORAGE_SUBSYSTEMS = [
  { name: 'memory',         toolset: 'memory',   project: true,  description: 'Project memory / persistent agent recall' },
  { name: 'reflections',    toolset: 'memory',   project: true,  description: 'Agent reflection memory' },
  { name: 'kb',             toolset: 'kb',       project: true,  description: 'Project knowledge base' },
  { name: 'provenance',     toolset: 'research', project: true,  description: 'W3C PROV records' },
  { name: 'research-store', toolset: 'research', project: true,  description: 'Research corpus' },
];

function registerStorageSubsystem(server, sub) {
  const { name, description } = sub;

  registerSubsystemTool(server, {
    name: `${name}-list`,
    subsystem: name,
    verb: 'list',
    title: `List ${description} entries`,
    description: `List entries in the ${name} subsystem. Mirrors \`aiwg ${name} list --json\`.`,
    inputSchema: {
      prefix: z.string().optional().describe('Filter by path prefix'),
    },
    readOnly: true,
    buildArgs: ({ prefix }) => {
      const args = ['--json'];
      if (prefix) args.push('--prefix', prefix);
      return args;
    },
  });

  registerSubsystemTool(server, {
    name: `${name}-get`,
    subsystem: name,
    verb: 'get',
    title: `Get ${description} entry`,
    description: `Read an entry from the ${name} subsystem. Mirrors \`aiwg ${name} get <path>\`.`,
    inputSchema: {
      path: z.string().describe('Entry path/key'),
    },
    readOnly: true,
    buildArgs: ({ path }) => [path],
  });

  registerSubsystemTool(server, {
    name: `${name}-put`,
    subsystem: name,
    verb: 'put',
    title: `Put ${description} entry`,
    description: `Write content to an entry in the ${name} subsystem. Mirrors \`aiwg ${name} put <path>\` with stdin.`,
    inputSchema: {
      path: z.string().describe('Entry path/key'),
      content: z.string().describe('Content to write (stdin to CLI)'),
    },
    destructive: false,  // append/upsert semantics
    buildArgs: ({ path }) => [path],
    buildInput: ({ content }) => content,
  });

  registerSubsystemTool(server, {
    name: `${name}-delete`,
    subsystem: name,
    verb: 'delete',
    title: `Delete ${description} entry`,
    description: `Delete an entry. No-op if missing. Mirrors \`aiwg ${name} delete <path>\`.`,
    inputSchema: {
      path: z.string().describe('Entry path/key'),
    },
    destructive: true,
    buildArgs: ({ path }) => [path],
  });

  registerSubsystemTool(server, {
    name: `${name}-path`,
    subsystem: name,
    verb: 'path',
    title: `${description} resolved path`,
    description: `Resolve the underlying physical path (fs backend). Mirrors \`aiwg ${name} path\`.`,
    inputSchema: {
      subpath: z.string().optional().describe('Optional subpath'),
    },
    readOnly: true,
    buildArgs: ({ subpath }) => {
      const args = ['--json'];
      if (subpath) args.unshift(subpath);
      return args;
    },
  });
}

// ============================================================================
// activity-log
// ============================================================================

function registerActivityLogToolset(server) {
  registerSubsystemTool(server, {
    name: 'activity-log-show',
    subsystem: 'activity-log',
    verb: 'show',
    title: 'Show activity log',
    description: 'Show the AIWG activity log (chronological event stream). Mirrors `aiwg activity-log show`.',
    inputSchema: {
      since: z.string().optional().describe('Filter by date YYYY-MM-DD'),
      operation: z.string().optional().describe('Filter by operation token (e.g. "create", "deploy")'),
      limit: z.number().int().min(1).max(1000).default(100),
    },
    readOnly: true,
    buildArgs: ({ since, operation, limit }) => {
      const args = [];
      if (since) args.push('--since', since);
      if (operation) args.push('--operation', operation);
      if (limit) args.push('--limit', String(limit));
      return args;
    },
  });

  registerSubsystemTool(server, {
    name: 'activity-log-append',
    subsystem: 'activity-log',
    verb: 'append',
    title: 'Append activity log entry',
    description: 'Append a one-line event. Mirrors `aiwg activity-log append <op> "<summary>"`.',
    inputSchema: {
      operation: z.string().describe('Operation token (e.g. "create", "deploy", "lint")'),
      summary: z.string().describe('One-line summary (<120 chars)'),
    },
    buildArgs: ({ operation, summary }) => [operation, summary],
  });

  registerSubsystemTool(server, {
    name: 'activity-log-stats',
    subsystem: 'activity-log',
    verb: 'stats',
    title: 'Activity log stats',
    description: 'Summary statistics over the activity log. Mirrors `aiwg activity-log stats`.',
    inputSchema: {},
    readOnly: true,
    buildArgs: () => [],
  });
}

// ============================================================================
// index
// ============================================================================

function registerIndexToolset(server) {
  registerSubsystemTool(server, {
    name: 'index-build',
    subsystem: 'index',
    verb: 'build',
    title: 'Build artifact index',
    description: 'Rebuild the artifact index (project / codebase / framework / user graphs). Mirrors `aiwg index build`.',
    inputSchema: {
      force: z.boolean().default(false).describe('Force full rebuild'),
      graph: z.enum(['project', 'codebase', 'source', 'user', 'framework']).optional().describe('Restrict to one graph'),
    },
    buildArgs: ({ force, graph }) => {
      const args = [];
      if (force) args.push('--force');
      if (graph) args.push('--graph', graph);
      return args;
    },
  });

  registerSubsystemTool(server, {
    name: 'index-query',
    subsystem: 'index',
    verb: 'query',
    title: 'Query artifact index',
    description: 'Search artifacts by keyword/type/phase/tags. Mirrors `aiwg index query`.',
    inputSchema: {
      keyword: z.string().optional().describe('Keyword query'),
      type: z.string().optional().describe('Artifact type filter'),
      limit: z.number().int().min(1).max(500).default(50),
    },
    readOnly: true,
    buildArgs: ({ keyword, type, limit }) => {
      const args = ['--json'];
      if (keyword) args.push(keyword);
      if (type) args.push('--type', type);
      if (limit) args.push('--limit', String(limit));
      return args;
    },
  });

  registerSubsystemTool(server, {
    name: 'index-deps',
    subsystem: 'index',
    verb: 'deps',
    title: 'Artifact dependency graph',
    description: 'Show dependency relationships for an artifact. Mirrors `aiwg index deps <path>`.',
    inputSchema: {
      artifact: z.string().describe('Artifact path or ID'),
      direction: z.enum(['upstream', 'downstream', 'both']).default('both'),
    },
    readOnly: true,
    buildArgs: ({ artifact, direction }) => {
      const args = [artifact, '--json'];
      if (direction) args.push('--direction', direction);
      return args;
    },
  });

  registerSubsystemTool(server, {
    name: 'index-stats',
    subsystem: 'index',
    verb: 'stats',
    title: 'Index statistics',
    description: 'Artifact counts by phase/type, graph metrics, coverage. Mirrors `aiwg index stats`.',
    inputSchema: {},
    readOnly: true,
    buildArgs: () => ['--json'],
  });
}

// ============================================================================
// ralph (agent loop) — session-id async pattern
// ============================================================================

function registerRalphToolset(server) {
  // ralph start is a command, not a subcommand. We use the top-level `ralph` command.
  server.registerTool('ralph-start', {
    title: 'Start AIWG Ralph (agent loop)',
    description: 'Begin a Ralph iterative agent loop. Returns immediately with a session id; status polled via `ralph-status`. Mirrors `aiwg ralph "<task>" --completion "<criteria>"`.',
    inputSchema: {
      task: z.string().describe('Task description'),
      completion: z.string().describe('Measurable completion criteria (verification command)'),
      max_cycles: z.number().int().min(1).max(500).default(20),
      confirmed: z.boolean().default(false).describe('Required (Ralph is long-running)'),
    },
    annotations: { destructiveHint: true },
  }, async ({ task, completion, max_cycles, confirmed }) => {
    if (!confirmed) {
      return mcpError(
        `ralph-start is a long-running agent loop. Re-invoke with confirmed=true to proceed.`,
        { requiresConfirmation: true, remediation: 'Surface task/completion/max_cycles to the user before confirming.' }
      );
    }
    try {
      // Spawn detached: kick off the loop in background; return immediately
      const { stdout, stderr, code } = await runAiwgCli(
        ['ralph', task, '--completion', completion, '--max-cycles', String(max_cycles), '--background'],
        { timeoutMs: 10_000 }
      );
      if (code !== 0) return mcpError(`ralph-start failed: ${stderr}`);
      return mcpJson({ message: 'ralph started', stdout, stderr });
    } catch (err) {
      return mcpError(`ralph-start: ${err.message}`);
    }
  });

  registerSubsystemTool(server, {
    name: 'ralph-status',
    subsystem: 'ralph-status',
    verb: '',
    title: 'Ralph loop status',
    description: 'Show status of running/recent Ralph loops. Mirrors `aiwg ralph-status`.',
    inputSchema: {
      session_id: z.string().optional().describe('Specific session id (default: all running)'),
      all: z.boolean().default(false).describe('Include completed/failed loops'),
    },
    readOnly: true,
    buildArgs: ({ session_id, all }) => {
      const args = ['--json'];
      if (session_id) args.push('--session', session_id);
      if (all) args.push('--all');
      return args;
    },
  });

  registerSubsystemTool(server, {
    name: 'ralph-abort',
    subsystem: 'ralph-abort',
    verb: '',
    title: 'Abort Ralph loop',
    description: 'Abort a running Ralph loop. Mirrors `aiwg ralph-abort`.',
    inputSchema: {
      session_id: z.string().describe('Session id'),
      confirmed: z.boolean().default(false),
    },
    destructive: true,
    buildArgs: ({ session_id, confirmed }) => {
      if (!confirmed) throw new Error('ralph-abort requires confirmed=true');
      return ['--session', session_id];
    },
  });

  registerSubsystemTool(server, {
    name: 'ralph-attach',
    subsystem: 'ralph-attach',
    verb: '',
    title: 'Attach to running Ralph loop',
    description: 'Attach to a running external agent loop. Mirrors `aiwg ralph-attach`.',
    inputSchema: {
      session_id: z.string().describe('Session id'),
    },
    readOnly: true,
    buildArgs: ({ session_id }) => ['--session', session_id, '--json'],
  });
}

// ============================================================================
// mc (Mission Control)
// ============================================================================

function registerMcToolset(server) {
  registerSubsystemTool(server, {
    name: 'mc-start',
    subsystem: 'mc',
    verb: 'start',
    title: 'Start Mission Control session',
    description: 'Begin a multi-loop background orchestration session. Mirrors `aiwg mc start`.',
    inputSchema: {
      name: z.string().optional().describe('Session label'),
    },
    buildArgs: ({ name }) => {
      const args = [];
      if (name) args.push('--name', name);
      return args;
    },
  });

  registerSubsystemTool(server, {
    name: 'mc-dispatch',
    subsystem: 'mc',
    verb: 'dispatch',
    title: 'Dispatch mission to MC session',
    description: 'Add a background mission to an MC session. Mirrors `aiwg mc dispatch <id> "<objective>"`.',
    inputSchema: {
      session_id: z.string().describe('Session id'),
      objective: z.string().describe('Mission objective'),
      completion: z.string().optional().describe('Completion criteria'),
      max_iterations: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional().describe('Ralph iteration cap'),
      max_total_tokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional().describe('Hard cumulative token ceiling'),
      max_output_tokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional().describe('Hard cumulative output-token ceiling'),
      max_tool_calls: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional().describe('Hard cumulative tool-call ceiling'),
      max_total_cost: z.number().positive().finite().optional().describe('Hard cumulative provider-reported spend ceiling'),
      max_wall_clock_minutes: z.number().positive().finite().optional().describe('Hard cumulative runtime ceiling'),
      exploration_quota: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional().describe('Require structural variant after this many flat cycles (off unless declared; no default K)'),
      budget_stop_policy: z.enum(['completion-wins', 'budget-wins']).optional().describe('Stop semantics when the completing iteration crosses a ceiling (default: completion-wins)'),
    },
    buildArgs: ({
      session_id,
      objective,
      completion,
      max_iterations,
      max_total_tokens,
      max_output_tokens,
      max_tool_calls,
      max_total_cost,
      max_wall_clock_minutes,
      exploration_quota,
      budget_stop_policy,
    }) => {
      const args = [session_id, objective];
      if (completion) args.push('--completion', completion);
      if (max_iterations) args.push('--max-iterations', String(max_iterations));
      if (max_total_tokens) args.push('--max-total-tokens', String(max_total_tokens));
      if (max_output_tokens) args.push('--max-output-tokens', String(max_output_tokens));
      if (max_tool_calls) args.push('--max-tool-calls', String(max_tool_calls));
      if (max_total_cost) args.push('--max-total-cost', String(max_total_cost));
      if (max_wall_clock_minutes) args.push('--max-wall-clock-minutes', String(max_wall_clock_minutes));
      if (exploration_quota) args.push('--exploration-quota', String(exploration_quota));
      if (budget_stop_policy) args.push('--budget-stop-policy', budget_stop_policy);
      return args;
    },
  });

  registerSubsystemTool(server, {
    name: 'mc-status',
    subsystem: 'mc',
    verb: 'status',
    title: 'MC session status',
    description: 'View status of all missions in MC sessions. Mirrors `aiwg mc status`.',
    inputSchema: {
      session_id: z.string().optional(),
    },
    readOnly: true,
    buildArgs: ({ session_id }) => {
      const args = ['--json'];
      if (session_id) args.push('--session', session_id);
      return args;
    },
  });

  registerSubsystemTool(server, {
    name: 'mc-stop',
    subsystem: 'mc',
    verb: 'stop',
    title: 'Stop MC session',
    description: 'Shut down a Mission Control session. Mirrors `aiwg mc stop <id>`.',
    inputSchema: {
      session_id: z.string(),
      confirmed: z.boolean().default(false),
    },
    destructive: true,
    buildArgs: ({ session_id, confirmed }) => {
      if (!confirmed) throw new Error('mc-stop requires confirmed=true');
      return [session_id];
    },
  });

  registerSubsystemTool(server, {
    name: 'mc-list',
    subsystem: 'mc',
    verb: 'list',
    title: 'List MC sessions',
    description: 'List all active/recent MC sessions. Mirrors `aiwg mc list`.',
    inputSchema: {},
    readOnly: true,
    buildArgs: () => ['--json'],
  });
}

// ============================================================================
// ops
// ============================================================================

function registerOpsToolset(server) {
  registerSubsystemTool(server, {
    name: 'ops-status',
    subsystem: 'ops',
    verb: 'status',
    title: 'Ops workspace status',
    description: 'Show ops workspace health. Mirrors `aiwg ops status`.',
    inputSchema: {
      all: z.boolean().default(false),
    },
    readOnly: true,
    buildArgs: ({ all }) => {
      const args = ['--json'];
      if (all) args.push('--all');
      return args;
    },
  });

  registerSubsystemTool(server, {
    name: 'ops-list',
    subsystem: 'ops',
    verb: 'list',
    title: 'List ops workspaces',
    description: 'List registered ops workspaces. Mirrors `aiwg ops list`.',
    inputSchema: {},
    readOnly: true,
    buildArgs: () => ['--json'],
  });

  registerSubsystemTool(server, {
    name: 'ops-use',
    subsystem: 'ops',
    verb: 'use',
    title: 'Switch ops workspace',
    description: 'Switch active ops workspace. Mirrors `aiwg ops use <workspace>`.',
    inputSchema: {
      workspace: z.string(),
    },
    buildArgs: ({ workspace }) => [workspace],
  });

  registerSubsystemTool(server, {
    name: 'ops-push',
    subsystem: 'ops',
    verb: 'push',
    title: 'Push ops workspace repos',
    description: 'Push workspace repos to remote. DESTRUCTIVE — affects shared state. Mirrors `aiwg ops push`.',
    inputSchema: {
      workspace: z.string().optional(),
      confirmed: z.boolean().default(false),
    },
    destructive: true,
    buildArgs: ({ workspace, confirmed }) => {
      if (!confirmed) throw new Error('ops-push requires confirmed=true');
      const args = [];
      if (workspace) args.push('--workspace', workspace);
      return args;
    },
  });
}

// ============================================================================
// Toolset registry + dispatch (#1332 / S18)
// ============================================================================

/**
 * Known toolsets. Each maps to a registration function. The `core` toolset
 * is always registered by server.mjs (discovery + command-run).
 */
const TOOLSET_REGISTRY = {
  flows: registerFlowToolset,
  missions: registerMissionToolset,
  memory: (server) => {
    registerStorageSubsystem(server, STORAGE_SUBSYSTEMS.find(s => s.name === 'memory'));
    registerStorageSubsystem(server, STORAGE_SUBSYSTEMS.find(s => s.name === 'reflections'));
  },
  kb: (server) => {
    registerStorageSubsystem(server, STORAGE_SUBSYSTEMS.find(s => s.name === 'kb'));
  },
  research: (server) => {
    registerStorageSubsystem(server, STORAGE_SUBSYSTEMS.find(s => s.name === 'provenance'));
    registerStorageSubsystem(server, STORAGE_SUBSYSTEMS.find(s => s.name === 'research-store'));
  },
  'activity-log': registerActivityLogToolset,
  index: registerIndexToolset,
  ralph: registerRalphToolset,
  mc: registerMcToolset,
  ops: registerOpsToolset,
  sandbox: registerAgenticSandboxToolset,
};

/**
 * Parse AIWG_MCP_TOOLSETS env or `--toolsets` CLI value into a Set.
 *
 * Format: comma-separated list (whitespace ignored). `core` is always
 * implicit. Unknown names produce a warning but don't abort startup.
 *
 * Examples:
 *   AIWG_MCP_TOOLSETS=flows,missions,ralph
 *   AIWG_MCP_TOOLSETS=core,memory          (core is implicit; harmless)
 *   AIWG_MCP_TOOLSETS=all                  (all known toolsets)
 */
export function parseToolsets(value) {
  if (!value || typeof value !== 'string') return new Set();
  const items = value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (items.includes('all')) {
    return new Set(Object.keys(TOOLSET_REGISTRY));
  }
  const out = new Set();
  const known = new Set(Object.keys(TOOLSET_REGISTRY));
  for (const item of items) {
    if (item === 'core') continue;  // always on
    if (!known.has(item)) {
      console.error(`[AIWG MCP] Unknown toolset: "${item}" — known: core, ${[...known].join(', ')}, all`);
      continue;
    }
    out.add(item);
  }
  return out;
}

/**
 * Register all opt-in toolsets requested via env/flag.
 */
export function registerOptInToolsets(server, toolsets) {
  const enabled = [];
  for (const name of toolsets) {
    const fn = TOOLSET_REGISTRY[name];
    if (fn) {
      fn(server);
      enabled.push(name);
    }
  }
  if (enabled.length > 0) {
    console.error(`[AIWG MCP] Opt-in toolsets enabled: ${enabled.join(', ')}`);
  } else {
    console.error('[AIWG MCP] Default toolset only (core). Enable more via AIWG_MCP_TOOLSETS=<csv>.');
  }
}

export const KNOWN_TOOLSETS = Object.keys(TOOLSET_REGISTRY);
