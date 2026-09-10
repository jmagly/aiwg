/**
 * Mission Control Command Handler
 *
 * Multi-loop background orchestration dashboard. Lets an orchestrator
 * spawn multiple long-running agent loops, monitor all simultaneously,
 * and react to completions or failures without blocking the primary session.
 *
 * Subcommands: start, dispatch, status, watch, abort, pause, resume, stop, list
 *
 * @implements @agentic/code/frameworks/sdlc-complete/rules/self-maintenance.md
 * @source @src/cli/router.ts
 * @issue #483
 */

import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import * as ui from '../ui.js';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

// ── Constants ────────────────────────────────────────────────

const MC_ROOT = '.aiwg/ralph-external/mc';
const SESSIONS_DIR = join(MC_ROOT, 'sessions');
const CONTROL_ID_RE = /^[a-zA-Z0-9._-]+$/;

type MissionStatus = 'queued' | 'running' | 'done' | 'failed' | 'aborted' | 'paused';
type SessionState = 'active' | 'paused' | 'stopped';

type MissionMode = 'direct' | 'pty-orchestrator';

interface Mission {
  id: string;
  objective: string;
  completion?: string;
  status: MissionStatus;
  loop: number;
  maxIterations: number;
  maxTotalTokens?: number;
  maxOutputTokens?: number;
  maxToolCalls?: number;
  maxTotalCost?: number;
  maxWallClockMinutes?: number;
  explorationQuota?: number;
  budgetStopPolicy?: 'completion-wins' | 'budget-wins';
  priority: string;
  mode: MissionMode;
  targetAgent?: string;
  lastAction?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  /** Ralph loop ID once the mission is launched (#1439) */
  ralphLoopId?: string;
  /** Ralph process PID once the mission is launched (#1439) */
  ralphPid?: number;
  /** Shared-host admission lease backing this local execution (#1566, #1657). */
  admissionRequestId?: string;
  admissionState?: string;
  admissionLeaseExpiresAt?: string;
  admissionSubmittedAt?: string;
}

interface Session {
  id: string;
  name: string;
  state: SessionState;
  maxMissions: number;
  createdAt: string;
  updatedAt: string;
  missions: Mission[];
  /** Idempotency ledger shared by CLI and Cockpit control mutations. */
  mutationKeys?: Record<string, { action: string; target: string; updatedAt: string }>;
}

// ── Helpers ──────────────────────────────────────────────────

function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function readSession(sessionId: string): Promise<Session | null> {
  if (!CONTROL_ID_RE.test(sessionId)) return null;
  const path = join(SESSIONS_DIR, sessionId, 'session.json');
  try {
    const raw = await fs.readFile(path, 'utf-8');
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

async function writeSession(session: Session, { touch = true }: { touch?: boolean } = {}): Promise<void> {
  const dir = join(SESSIONS_DIR, session.id);
  await ensureDir(dir);
  if (touch) session.updatedAt = new Date().toISOString();
  const destination = join(dir, 'session.json');
  const temporary = join(dir, `.session.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  await fs.writeFile(temporary, JSON.stringify(session, null, 2));
  await fs.rename(temporary, destination);
}

async function appendLog(sessionId: string, event: Record<string, unknown>): Promise<void> {
  const logPath = join(SESSIONS_DIR, sessionId, 'log.jsonl');
  const entry = JSON.stringify({ ...event, ts: new Date().toISOString() });
  await fs.appendFile(logPath, entry + '\n');
}

type MutationResult =
  | { ok: true; session: Session; replayed: boolean }
  | { ok: false; code: 'mission_conflict' | 'session_not_found' | 'target_not_found' | 'invalid_state' | 'capacity'; message: string };

/**
 * Apply one durable Mission Control mutation under a cross-process lock.
 * `expectedUpdatedAt` provides optimistic concurrency and `requestId` makes
 * retries idempotent across CLI/Cockpit reconnects.
 */
async function mutateSession(
  sessionId: string,
  action: string,
  target: string,
  expectedUpdatedAt: string | undefined,
  requestId: string | undefined,
  mutate: (session: Session) => string | undefined,
): Promise<MutationResult> {
  if (!CONTROL_ID_RE.test(sessionId) || !CONTROL_ID_RE.test(target)) {
    return { ok: false, code: 'target_not_found', message: 'invalid Mission control identifier' };
  }
  const dir = join(SESSIONS_DIR, sessionId);
  await ensureDir(dir);
  const lockPath = join(dir, '.control.lock');
  let lock;
  try {
    lock = await fs.open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return { ok: false, code: 'mission_conflict', message: 'another Mission control mutation is in progress' };
    }
    throw error;
  }
  try {
    const session = await readSession(sessionId);
    if (!session) return { ok: false, code: 'session_not_found', message: `Session not found: ${sessionId}` };
    if (expectedUpdatedAt && session.updatedAt !== expectedUpdatedAt) {
      return { ok: false, code: 'mission_conflict', message: `expected revision ${expectedUpdatedAt}; current revision is ${session.updatedAt}` };
    }
    if (requestId && session.mutationKeys?.[requestId]) {
      const prior = session.mutationKeys[requestId]!;
      if (prior.action !== action || prior.target !== target) {
        return { ok: false, code: 'mission_conflict', message: `request id '${requestId}' was already used for another mutation` };
      }
      return { ok: true, session, replayed: true };
    }
    const errorCode = mutate(session);
    if (errorCode === 'target_not_found') return { ok: false, code: errorCode, message: `Mission not found: ${target}` };
    if (errorCode === 'invalid_state') return { ok: false, code: errorCode, message: `Mutation '${action}' is invalid from state '${session.state}'` };
    if (errorCode === 'capacity') return { ok: false, code: errorCode, message: `Session at capacity (${session.maxMissions} missions)` };
    const nextUpdatedAt = new Date().toISOString();
    session.updatedAt = nextUpdatedAt;
    if (requestId) {
      session.mutationKeys = { ...(session.mutationKeys ?? {}), [requestId]: { action, target, updatedAt: nextUpdatedAt } };
    }
    await writeSession(session, { touch: false });
    await appendLog(session.id, { event: `control_${action}`, target, requestId: requestId ?? null, replayed: false, revision: session.updatedAt });
    return { ok: true, session, replayed: false };
  } finally {
    await lock.close();
    await fs.unlink(lockPath).catch(() => undefined);
  }
}

function mutationFlags(args: string[]): { expectedUpdatedAt?: string; requestId?: string } {
  return {
    expectedUpdatedAt: parseFlag(args, '--expected-updated-at'),
    requestId: parseFlag(args, '--request-id'),
  };
}

function mutationFailure(result: Extract<MutationResult, { ok: false }>): HandlerResult {
  ui.error(`${result.code}: ${result.message}`);
  return { exitCode: result.code === 'mission_conflict' ? 3 : 1, message: `${result.code}: ${result.message}` };
}

async function listSessions(): Promise<Session[]> {
  try {
    const entries = await fs.readdir(SESSIONS_DIR, { withFileTypes: true });
    const sessions: Session[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const s = await readSession(entry.name);
        if (s) sessions.push(s);
      }
    }
    return sessions;
  } catch {
    return [];
  }
}

async function findActiveSession(sessionIdArg?: string): Promise<Session | null> {
  if (sessionIdArg) return readSession(sessionIdArg);

  // Find latest active session
  const sessions = await listSessions();
  const active = sessions
    .filter(s => s.state === 'active' || s.state === 'paused')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return active[0] || null;
}

function parseFlag(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      return i + 1 < args.length ? args[i + 1] : undefined;
    }
    // Support --flag=value — previously silently ignored, which for budget
    // flags meant an unbounded loop the operator believed was capped (#1770)
    if (args[i].startsWith(`${flag}=`)) {
      return args[i].slice(flag.length + 1);
    }
  }
  return undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/**
 * Parse a numeric flag. A flag that is PRESENT but not a positive number is a
 * usage error collected into `invalidSink` — silently dropping it used to
 * dispatch missions with no ceiling while the operator believed one applied
 * (#1770).
 */
function parseNumberFlag(args: string[], flag: string, invalidSink?: string[], integer = false): number | undefined {
  if (!args.some(arg => arg === flag || arg.startsWith(`${flag}=`))) return undefined;
  const raw = parseFlag(args, flag);
  // Presence and validity are distinct: a trailing flag must not silently
  // disappear, and counter limits must not accept fractional/unsafe values.
  const decimal = typeof raw === 'string' && /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw);
  const value = decimal ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) {
    invalidSink?.push(`${flag} (got '${raw}')`);
    return undefined;
  }
  return value;
}

function wantsHelp(args: string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

/**
 * Per-subcommand usage strings (#1440).
 *
 * `aiwg mc <subcommand> --help` MUST print this text and exit before any
 * side-effecting logic. The previous behavior — running `aiwg mc start --help`
 * actually created a session — violated the universal `--help` convention.
 */
const subcommandUsage: Record<string, string> = {
  start: `Usage: aiwg mc start [--name "<label>"] [--max-missions N]

Create a new Mission Control session for tracking background missions.

  --name <label>       Human-readable session name (default: "Mission YYYY-MM-DD")
  --max-missions N     Capacity limit for queued missions (default: 10)

Note: 'start' only creates the session. Use 'dispatch' to queue missions and
'run' to drain the queue.`,

  dispatch: `Usage: aiwg mc dispatch <session-id> "<objective>" [options]

Queue a mission onto a session. Does NOT execute — use 'aiwg mc run' to launch.

  --completion "<criteria>"     Verifiable completion criteria (required for 'mc run')
  --priority <level>            Priority hint (default: normal)
  --max-iterations N            Ralph iteration cap when launched (default: 10)
  --max-total-tokens N          Hard cumulative token ceiling when observable
  --max-output-tokens N         Hard cumulative output-token ceiling
  --max-tool-calls N            Hard cumulative tool-call ceiling
  --max-total-cost USD          Hard cumulative provider-reported spend ceiling
  --max-wall-clock-minutes N    Hard cumulative runtime ceiling
  --exploration-quota K         Require structural variant after K flat cycles
                                (off unless declared; no default K)
  --budget-stop-policy P        completion-wins (default) | budget-wins
  --mode pty-orchestrator       PTY-orchestrator mode (requires --target-agent)
  --target-agent <id>           Required for --mode pty-orchestrator
  --expected-updated-at <time>  Reject stale state with exit 3
  --request-id <id>             Idempotent dispatch key`,

  run: `Usage: aiwg mc run [<session-id>] [--accept-cost]

Drain queued missions in a session by launching each as a ralph loop. Missions
without --completion criteria are skipped with a warning.

  --accept-cost   Skip the cost-warning gate (required for non-TTY contexts
                  when estimated cumulative cost exceeds $5). See #1450.`,

  status: `Usage: aiwg mc status [<session-id>] [--json]

Show mission status for a session. Auto-syncs from ralph loop state files.

  --json   Emit JSON instead of human-readable table`,

  watch: `Usage: aiwg mc watch [<session-id>]

Live-monitor mission progress (non-interactive context prints status once).`,

  abort: `Usage: aiwg mc abort <session-id> <mission-id>

Mark a specific mission as aborted.

  --expected-updated-at <timestamp>  Reject stale state with exit 3
  --request-id <id>                  Idempotent mutation key`,

  pause: `Usage: aiwg mc pause [<session-id>]

Pause an active session; running missions transition to 'paused' status.

  --expected-updated-at <timestamp>  Reject stale state with exit 3
  --request-id <id>                  Idempotent mutation key`,

  resume: `Usage: aiwg mc resume [<session-id>]

Resume a paused session; paused missions transition back to 'running'.

  --expected-updated-at <timestamp>  Reject stale state with exit 3
  --request-id <id>                  Idempotent mutation key`,

  stop: `Usage: aiwg mc stop [<session-id>] [--drain]

Shut down a session.

  --drain   Cancel queued, let running finish (default: abort all non-completed)`,

  list: `Usage: aiwg mc list [--json]

List all Mission Control sessions.`,

  agents: `Usage: aiwg mc agents [filters] [--json]

Query routable agents from a local 'aiwg serve' instance.

  --framework <name>       Require an AIWG framework (repeatable)
  --sandbox <id>           Restrict to a sandbox
  --agent <id>             Restrict to a specific agent ID
  --name <n>               Match by logical name
  --max-cpu <pct>          Reject agents above this CPU %
  --min-memory <gb>        Reject agents below this memory threshold
  --json                   Output raw JSON`,
};

function printSubcommandHelp(name: string): void {
  const text = subcommandUsage[name];
  ui.blank();
  if (text) {
    console.log(`  ${text}`);
  } else {
    console.log(`  No detailed help for 'aiwg mc ${name}'. Run 'aiwg mc --help' for the full reference.`);
  }
  ui.blank();
}

function getPositionalArgs(args: string[]): string[] {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      // Skip flag and its value if it has one
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) i++;
      continue;
    }
    positional.push(args[i]);
  }
  return positional;
}

// ── Subcommand handlers ──────────────────────────────────────

async function mcStart(ctx: HandlerContext): Promise<HandlerResult> {
  const name = parseFlag(ctx.args, '--name') || `Mission ${new Date().toISOString().slice(0, 10)}`;
  const maxMissions = parseInt(parseFlag(ctx.args, '--max-missions') || '10', 10);

  const session: Session = {
    id: genId('mc'),
    name,
    state: 'active',
    maxMissions,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    missions: [],
  };

  await writeSession(session);
  await appendLog(session.id, { event: 'session_started', name, maxMissions });

  ui.blank();
  console.log(`  ${ui.brandMark()} ${ui.bold('Mission Control')} — ${ui.accent(name)}`);
  ui.rule();
  ui.success(`Session started: ${session.id}`);
  ui.info(`Max missions: ${maxMissions}`);
  // #1439: the lifecycle is start → dispatch → run → status. State this
  // up-front so users don't get stuck wondering why missions never execute.
  ui.info(`Next: \`aiwg mc dispatch ${session.id} "<objective>" --completion "<criteria>"\``);
  ui.info(`Then: \`aiwg mc run ${session.id}\` to drain the queue (missions stay 'queued' until you do).`);
  ui.blank();

  return { exitCode: 0, message: session.id };
}

async function mcDispatch(ctx: HandlerContext): Promise<HandlerResult> {
  const positional = getPositionalArgs(ctx.args);
  const sessionId = positional[0];
  const objective = positional.slice(1).join(' ') || parseFlag(ctx.args, '--objective');
  const completion = parseFlag(ctx.args, '--completion');
  const priority = parseFlag(ctx.args, '--priority') || 'normal';
  const invalidFlags: string[] = [];
  const maxIterations = parseNumberFlag(ctx.args, '--max-iterations', invalidFlags, true) ?? 10;
  const maxTotalTokens = parseNumberFlag(ctx.args, '--max-total-tokens', invalidFlags, true);
  const maxOutputTokens = parseNumberFlag(ctx.args, '--max-output-tokens', invalidFlags, true);
  const maxToolCalls = parseNumberFlag(ctx.args, '--max-tool-calls', invalidFlags, true);
  const maxTotalCost = parseNumberFlag(ctx.args, '--max-total-cost', invalidFlags);
  const maxWallClockMinutes = parseNumberFlag(ctx.args, '--max-wall-clock-minutes', invalidFlags);
  const explorationQuota = parseNumberFlag(ctx.args, '--exploration-quota', invalidFlags, true);
  const budgetStopPolicyRaw = parseFlag(ctx.args, '--budget-stop-policy');
  let budgetStopPolicy: 'completion-wins' | 'budget-wins' | undefined;
  if (budgetStopPolicyRaw !== undefined) {
    if (budgetStopPolicyRaw === 'completion-wins' || budgetStopPolicyRaw === 'budget-wins') {
      budgetStopPolicy = budgetStopPolicyRaw;
    } else {
      invalidFlags.push(`--budget-stop-policy (got '${budgetStopPolicyRaw}', expected completion-wins|budget-wins)`);
    }
  }
  const modeRaw = parseFlag(ctx.args, '--mode') || 'direct';
  const mode: MissionMode = modeRaw === 'pty-orchestrator' ? 'pty-orchestrator' : 'direct';
  const targetAgent = parseFlag(ctx.args, '--target-agent');

  if (!objective) {
    // #1438: keep this in sync with subcommandUsage.dispatch above so 'mc
    // dispatch' with bad args and 'mc dispatch --help' agree on flags.
    ui.error('Usage: aiwg mc dispatch <session-id> "<objective>" [--completion "<criteria>"] [--max-iterations N] [--priority <level>] [--mode pty-orchestrator] [--target-agent <agent-id>]');
    return { exitCode: 1 };
  }

  if (invalidFlags.length > 0) {
    ui.error(`Invalid numeric flag value(s): ${invalidFlags.join(', ')}. Budget/quota flags require positive numbers. Mission not dispatched.`);
    return { exitCode: 1 };
  }

  if (mode === 'pty-orchestrator' && !targetAgent) {
    ui.error('--mode pty-orchestrator requires --target-agent <agent-id>');
    return { exitCode: 1 };
  }

  const selected = await findActiveSession(sessionId);
  if (!selected) {
    ui.error(sessionId ? `Session not found: ${sessionId}` : 'No active session. Run `aiwg mc start` first.');
    return { exitCode: 1 };
  }

  // #1361: Check project-level parallelism cap. Active missions = running or
  // queued; if at cap, warn but still queue (FIFO behavior — the mission goes
  // into the session as 'queued' and will run when a slot frees up).
  let capWarning: string | undefined;
  try {
    const { readAiwgConfig, resolveParallelism } = await import('../../config/aiwg-config.js');
    const cfg = await readAiwgConfig(ctx.cwd || process.cwd());
    if (cfg) {
      const resolved = resolveParallelism(cfg.parallelism, cfg.providers[0]);
      const activeCount = selected.missions.filter(
        m => m.status === 'running' || m.status === 'queued' || m.status === 'paused',
      ).length;
      if (activeCount >= resolved.max_parallel_mc_missions) {
        capWarning = `Active missions (${activeCount}) at or above project parallelism cap (${resolved.max_parallel_mc_missions}). Mission will queue; bump via 'aiwg config set --project parallelism.max_parallel_mc_missions N'.`;
      }
    }
  } catch {
    // Non-fatal — config read failure doesn't block dispatch
  }

  const flags = mutationFlags(ctx.args);
  const mission: Mission = {
    id: flags.requestId
      ? `m-${createHash('sha256').update(flags.requestId).digest('hex').slice(0, 16)}`
      : genId('m'),
    objective,
    completion,
    status: 'queued',
    loop: 0,
    maxIterations,
    maxTotalTokens,
    maxOutputTokens,
    maxToolCalls,
    maxTotalCost,
    maxWallClockMinutes,
    explorationQuota,
    budgetStopPolicy,
    priority,
    mode,
    targetAgent: targetAgent || undefined,
  };

  const result = await mutateSession(selected.id, 'dispatch', mission.id, flags.expectedUpdatedAt, flags.requestId, session => {
    if (session.state !== 'active') return 'invalid_state';
    if (session.missions.length >= session.maxMissions) return 'capacity';
    session.missions.push(mission);
    return undefined;
  });
  if (!result.ok) return mutationFailure(result);
  if (!result.replayed) {
    await appendLog(selected.id, {
      event: 'mission_dispatched',
      missionId: mission.id,
      objective,
      priority,
      mode,
      targetAgent,
      requestId: flags.requestId ?? null,
      lfdBudgets: {
        maxTotalTokens,
        maxOutputTokens,
        maxToolCalls,
        maxTotalCost,
        maxWallClockMinutes,
        explorationQuota,
      },
    });
  }

  if (capWarning) ui.warn(capWarning);
  ui.success(`${result.replayed ? 'Replayed dispatch for' : 'Dispatched mission'} ${mission.id}: ${objective}`);
  const modeLabel = mode === 'pty-orchestrator' ? ` | Mode: PTY orchestrator → ${targetAgent}` : '';
  ui.info(`Priority: ${priority} | Max iterations: ${maxIterations}${modeLabel}`);
  const lfdLimits = [
    maxTotalTokens ? `total tokens ${maxTotalTokens}` : null,
    maxOutputTokens ? `output tokens ${maxOutputTokens}` : null,
    maxToolCalls ? `tool calls ${maxToolCalls}` : null,
    maxTotalCost ? `total cost $${maxTotalCost}` : null,
    maxWallClockMinutes ? `wall clock ${maxWallClockMinutes}m` : null,
    explorationQuota ? `exploration quota ${explorationQuota}` : null,
  ].filter(Boolean);
  if (lfdLimits.length > 0) {
    ui.info(`LFD limits: ${lfdLimits.join(' | ')}`);
  }

  // #1439: dispatch alone does NOT execute the mission. Surface the next step
  // so the user knows the queue won't drain on its own.
  ui.info(`Next: run \`aiwg mc run ${selected.id}\` to launch queued missions as ralph loops.`);

  return { exitCode: 0, message: mission.id };
}

/**
 * Drain queued missions in a session by launching each as a ralph loop (#1439).
 *
 * Before this command existed, missions sat in `queued` status forever because
 * no supervisor process drained the queue. `mc run` is the explicit supervisor
 * step: for every queued direct-mode mission, spawn a detached ralph process
 * via launchExternalRalph(), record the resulting loopId + pid on the mission,
 * and flip the mission to `running`.
 *
 * Status sync back from ralph to mc happens lazily via syncMissionsFromRalph()
 * called from `mc status` and `mc watch` — no separate daemon needed.
 *
 * Limitations of cycle 1:
 * - pty-orchestrator missions are skipped with a warning (separate codepath)
 * - missions launch sequentially (each call to launchExternalRalph spawns a
 *   detached process, so they DO run in parallel after launch — the loop here
 *   is just for orderly dispatch, not for parallel scheduling)
 */
async function mcRun(ctx: HandlerContext): Promise<HandlerResult> {
  const positional = getPositionalArgs(ctx.args);
  const sessionId = positional[0];
  const acceptCost = hasFlag(ctx.args, '--accept-cost');

  const session = await findActiveSession(sessionId);
  if (!session) {
    ui.error(sessionId ? `Session not found: ${sessionId}` : 'No active session. Run `aiwg mc start` first.');
    return { exitCode: 1 };
  }

  const queued = session.missions.filter((m) => m.status === 'queued');
  if (queued.length === 0) {
    ui.info(`No queued missions in session ${session.id}. Run \`aiwg mc dispatch ${session.id} "<objective>"\` to add one.`);
    return { exitCode: 0 };
  }

  // #1450 P0: cost warning gate.
  //
  // Each headless claude session pays a ~$1.60 cache-creation cost on iteration
  // 1 before any user-meaningful work (sonnet baseline; opus is ~$3.90). Across
  // N missions × M iterations the floor compounds quickly. Warn before launch
  // and refuse in non-TTY contexts unless --accept-cost is set.
  //
  // Estimate is intentionally conservative: cumulative iteration floor =
  // missions × max_iterations × sonnet_cache_cost. Real spend may be lower if
  // missions complete in fewer iterations.
  const eligible = queued.filter(m => m.mode !== 'pty-orchestrator' && !!m.completion);
  const SONNET_CACHE_USD = 1.60;
  const iterFloor = eligible.reduce((sum, m) => sum + m.maxIterations, 0);
  const estimateUsd = iterFloor * SONNET_CACHE_USD;
  const COST_WARNING_THRESHOLD_USD = 5.0;

  if (estimateUsd >= COST_WARNING_THRESHOLD_USD && !acceptCost) {
    ui.blank();
    ui.warn(`Cost estimate: ~$${estimateUsd.toFixed(2)} (${eligible.length} missions × iteration floors × ~$${SONNET_CACHE_USD.toFixed(2)} cache cost per claude headless iter).`);
    ui.warn('Actual spend may be lower if missions complete early, higher if model is opus or context grows.');
    if (!process.stdout.isTTY) {
      ui.error('Refusing to launch in non-interactive context. Re-run with `--accept-cost` to proceed.');
      return { exitCode: 1 };
    }
    // TTY path: surface the warning and continue. A future revision should
    // prompt y/N here; for now the warning is informational and the operator
    // can Ctrl+C before launches actually begin.
    ui.info('Continuing (TTY). Use Ctrl+C to abort within the next 2 seconds.');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  ui.blank();
  console.log(`  ${ui.brandMark()} ${ui.bold('Mission Control')} — running ${queued.length} queued mission(s) in ${ui.accent(session.id)}`);
  ui.rule();

  // Lazy import — ralph-launcher pulls in node:child_process and other heavy
  // deps we don't want to pay for on every mc subcommand.
  const { launchExternalRalph } = await import('./ralph-launcher.js');

  let launched = 0;
  let skipped = 0;
  let failed = 0;
  const projectRoot = ctx.cwd || process.cwd();
  const frameworkRoot = ctx.frameworkRoot;
  const { readAiwgConfig, resolveParallelism } = await import('../../config/aiwg-config.js');
  const { FileAdmissionStore, SharedHostScheduler } = await import('../../serve/shared-host-scheduler.js');
  const cfg = await readAiwgConfig(projectRoot).catch(() => null);
  const provider = cfg?.providers[0] ?? 'unknown';
  const maxConcurrent = resolveParallelism(cfg?.parallelism, provider).max_parallel_mc_missions;
  const scheduler = new SharedHostScheduler(
    new FileAdmissionStore(join(projectRoot, MC_ROOT, 'admission.json')),
    {
      maxConcurrent,
      leaseTtlMs: 5 * 60_000,
      agingIntervalMs: 30_000,
      allowPreemption: false,
      defaultHostQuota: maxConcurrent,
    },
  );

  for (const mission of queued) {
    if (mission.mode === 'pty-orchestrator') {
      ui.warn(`Mission ${mission.id} mode=pty-orchestrator is not yet wired to mc run; skipping. Use 'aiwg ralph' directly for PTY-orchestrator workflows.`);
      skipped += 1;
      continue;
    }

    if (!mission.completion) {
      ui.warn(`Mission ${mission.id} has no --completion criteria; ralph requires one. Skipping. Re-dispatch with --completion "<criteria>" to include this mission.`);
      skipped += 1;
      continue;
    }

    const admissionRequestId = mission.admissionState === 'released'
      ? `${session.id}.${mission.id}.${Date.now().toString(36)}`
      : mission.admissionRequestId ?? `${session.id}.${mission.id}`;
    const admissionSubmittedAt = mission.admissionState === 'released'
      ? new Date().toISOString()
      : mission.admissionSubmittedAt ?? new Date().toISOString();
    const admission = scheduler.submit({
      requestId: admissionRequestId,
      orchestratorId: session.id,
      environment: process.env.AIWG_ENVIRONMENT ?? 'default',
      provider,
      runtimeKind: 'host',
      priority: mission.priority === 'critical' ? 100 : mission.priority === 'high' ? 50 : mission.priority === 'low' ? 0 : 10,
      submittedAt: admissionSubmittedAt,
      queueTimeoutMs: 24 * 60 * 60_000,
      preemptible: false,
      metadata: { missionId: mission.id },
    });
    mission.admissionRequestId = admissionRequestId;
    mission.admissionSubmittedAt = admissionSubmittedAt;
    mission.admissionState = admission.state;
    mission.admissionLeaseExpiresAt = admission.leaseExpiresAt;
    await writeSession(session);
    if (admission.state !== 'admitted') {
      await appendLog(session.id, {
        event: 'mission_admission_queued',
        missionId: mission.id,
        admissionRequestId,
        reason: admission.reason,
      });
      ui.info(`Queued ${mission.id}: ${admission.reason}`);
      skipped += 1;
      continue;
    }

    try {
      const result = await launchExternalRalph(frameworkRoot, projectRoot, {
        objective: mission.objective,
        completionCriteria: mission.completion,
        maxIterations: mission.maxIterations,
        maxTotalTokens: mission.maxTotalTokens,
        maxOutputTokens: mission.maxOutputTokens,
        maxToolCalls: mission.maxToolCalls,
        maxTotalCost: mission.maxTotalCost,
        maxWallClockMinutes: mission.maxWallClockMinutes,
        explorationQuota: mission.explorationQuota,
        budgetStopPolicy: mission.budgetStopPolicy,
        // Defaults for cycle 1; advanced options can be added per-mission later.
        verbose: false,
      });

      mission.status = 'running';
      mission.startedAt = new Date().toISOString();
      mission.ralphLoopId = result.loopId;
      mission.ralphPid = result.pid;
      await writeSession(session);
      await appendLog(session.id, {
        event: 'mission_started',
        missionId: mission.id,
        loopId: result.loopId,
        pid: result.pid,
      });

      ui.success(`Started ${mission.id} → ralph loop ${result.loopId} (PID ${result.pid})`);
      launched += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      mission.status = 'failed';
      mission.error = msg;
      mission.completedAt = new Date().toISOString();
      scheduler.release(admissionRequestId);
      mission.admissionState = 'released';
      mission.admissionLeaseExpiresAt = undefined;
      await writeSession(session);
      await appendLog(session.id, {
        event: 'mission_launch_failed',
        missionId: mission.id,
        error: msg,
      });
      ui.error(`Failed to start ${mission.id}: ${msg}`);
      failed += 1;
    }
  }

  ui.blank();
  ui.info(`Launched: ${launched} | Skipped: ${skipped} | Failed: ${failed}`);
  if (launched > 0) {
    ui.info(`Monitor: \`aiwg mc status ${session.id}\` or \`aiwg mc watch ${session.id}\``);
  }

  return { exitCode: failed > 0 && launched === 0 ? 1 : 0 };
}

/**
 * Sync mission statuses from their backing ralph loop state files (#1439).
 *
 * Each mission launched by `mc run` carries a `ralphLoopId`. The ralph loop
 * writes its own session-state.json with a `status` field
 * (running|completed|failed|paused|aborted). This helper polls those files
 * and reflects the truth back into the mc session.json so `mc status` and
 * `mc watch` show actual progress without manual intervention.
 *
 * Sync is best-effort — a missing or unreadable ralph state file leaves the
 * mission status unchanged (typically 'running' until the ralph process
 * actually writes state).
 */
async function syncMissionsFromRalph(session: Session, projectRoot: string): Promise<boolean> {
  let mutated = false;
  const { readAiwgConfig, resolveParallelism } = await import('../../config/aiwg-config.js');
  const { FileAdmissionStore, SharedHostScheduler } = await import('../../serve/shared-host-scheduler.js');
  const cfg = await readAiwgConfig(projectRoot).catch(() => null);
  const provider = cfg?.providers[0] ?? 'unknown';
  const maxConcurrent = resolveParallelism(cfg?.parallelism, provider).max_parallel_mc_missions;
  const scheduler = new SharedHostScheduler(
    new FileAdmissionStore(join(projectRoot, MC_ROOT, 'admission.json')),
    { maxConcurrent, leaseTtlMs: 5 * 60_000, agingIntervalMs: 30_000, allowPreemption: false, defaultHostQuota: maxConcurrent },
  );
  for (const mission of session.missions) {
    if (mission.status !== 'running') continue;
    if (!mission.ralphLoopId) continue;
    const ralphStatePath = join(
      projectRoot,
      '.aiwg',
      'ralph-external',
      'loops',
      mission.ralphLoopId,
      'session-state.json',
    );
    try {
      const raw = await fs.readFile(ralphStatePath, 'utf-8');
      const state = JSON.parse(raw);
      const ralphStatus = String(state.status || '').toLowerCase();
      // Map ralph status → mc mission status
      let nextStatus: MissionStatus | null = null;
      if (ralphStatus === 'completed') nextStatus = 'done';
      else if (ralphStatus === 'failed' || ralphStatus === 'crashed') nextStatus = 'failed';
      else if (ralphStatus === 'aborted') nextStatus = 'aborted';
      else if (ralphStatus === 'paused') nextStatus = 'paused';
      // 'running' stays running

      // Reflect iteration count if available
      const iter = typeof state.iteration === 'number' ? state.iteration : (typeof state.currentIteration === 'number' ? state.currentIteration : null);
      if (iter !== null && iter !== mission.loop) {
        mission.loop = iter;
        mutated = true;
      }

      // mission.status is narrowed to 'running' by the early-continue above,
      // and nextStatus is one of {done, failed, aborted, paused}. So the
      // transition is always real when nextStatus is set — no equality
      // check needed.
      if (nextStatus) {
        mission.status = nextStatus;
        mission.completedAt = new Date().toISOString();
        if (nextStatus === 'failed' && typeof state.error === 'string') {
          mission.error = state.error;
        }
        mutated = true;
        if (mission.admissionRequestId) {
          try { scheduler.release(mission.admissionRequestId); } catch { /* already expired or released */ }
          mission.admissionState = 'released';
          mission.admissionLeaseExpiresAt = undefined;
        }
      } else if (mission.admissionRequestId) {
        try {
          const renewed = scheduler.renew(mission.admissionRequestId);
          mission.admissionState = renewed.state;
          mission.admissionLeaseExpiresAt = renewed.leaseExpiresAt;
          mutated = true;
        } catch {
          // An expired lease is reconciled on the next run; status remains best-effort.
        }
      }
    } catch {
      // State file missing/unreadable — leave mission status unchanged.
    }
  }
  if (mutated) {
    session.updatedAt = new Date().toISOString();
    await writeSession(session);
  }
  return mutated;
}

async function mcStatus(ctx: HandlerContext): Promise<HandlerResult> {
  const positional = getPositionalArgs(ctx.args);
  const sessionId = positional[0];
  const json = hasFlag(ctx.args, '--json');

  const session = await findActiveSession(sessionId);
  if (!session) {
    if (json) {
      console.log(JSON.stringify({ error: 'no_active_session' }));
    } else {
      ui.error(sessionId ? `Session not found: ${sessionId}` : 'No active session.');
    }
    return { exitCode: 1 };
  }

  // #1439: Sync mission statuses from ralph loop state files BEFORE display
  // so 'mc status' reflects the true state of any in-flight ralph processes
  // (otherwise missions launched by 'mc run' stay 'running' in mc.session.json
  // even after the ralph loop has completed).
  await syncMissionsFromRalph(session, ctx.cwd || process.cwd());

  if (json) {
    console.log(JSON.stringify(session, null, 2));
    return { exitCode: 0 };
  }

  const statusIcons: Record<MissionStatus, string> = {
    done: '✓',
    running: '⏳',
    queued: '⏺',
    failed: '✗',
    aborted: '⊘',
    paused: '⏸',
  };

  ui.blank();
  console.log(`  ${ui.brandMark()} ${ui.bold('MISSION CONTROL')} — ${ui.accent(session.name)}  [${session.id}]`);
  ui.rule(60);

  // Header
  // #1441: ui.dim() returns void (it prints) — wrapping in console.log emitted
  // a literal "undefined" between the header and the separator. Use dimText()
  // (returns a string) for inline styling.
  const header = `  ${'#'.padEnd(4)} ${'Mission'.padEnd(32)} ${'Mode'.padEnd(6)} ${'Status'.padEnd(12)} ${'Loop'.padEnd(8)} ${'Started'.padEnd(8)}`;
  console.log(ui.dimText(header));
  ui.rule(68);

  for (let i = 0; i < session.missions.length; i++) {
    const m = session.missions[i];
    const icon = statusIcons[m.status] || '?';
    const num = String(i + 1).padEnd(4);
    const obj = m.objective.length > 30 ? m.objective.slice(0, 27) + '...' : m.objective.padEnd(32);
    const modeTag = m.mode === 'pty-orchestrator' ? 'PTY'.padEnd(6) : '—'.padEnd(6);
    const status = `${icon} ${m.status.toUpperCase()}`.padEnd(12);
    const loop = m.status === 'queued' ? '—'.padEnd(8) : `${m.loop}/${m.maxIterations}`.padEnd(8);
    const started = m.startedAt ? new Date(m.startedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
    console.log(`  ${num} ${obj} ${modeTag} ${status} ${loop} ${started}`);
    // Show last action for PTY-orchestrated missions
    if (m.mode === 'pty-orchestrator' && m.lastAction && m.status === 'running') {
      console.log(ui.dimText(`       └─ Last: ${m.lastAction}`));
    }
  }

  ui.rule(68);

  const counts = {
    done: session.missions.filter(m => m.status === 'done').length,
    running: session.missions.filter(m => m.status === 'running').length,
    queued: session.missions.filter(m => m.status === 'queued').length,
    failed: session.missions.filter(m => m.status === 'failed').length,
  };

  console.log(`  ${session.missions.length} missions  |  ${counts.done} done  |  ${counts.running} running  |  ${counts.queued} queued  |  ${counts.failed} failed`);

  // #1361: Show project parallelism cap when one is configured.
  try {
    const { readAiwgConfig, resolveParallelism } = await import('../../config/aiwg-config.js');
    const cfg = await readAiwgConfig(ctx.cwd || process.cwd());
    if (cfg) {
      const resolved = resolveParallelism(cfg.parallelism, cfg.providers[0]);
      const active = counts.running + counts.queued;
      const cap = resolved.max_parallel_mc_missions;
      const overCap = active > cap ? ` ${ui.dim(`(${active - cap} over cap — queued)`)}` : '';
      console.log(`  Parallelism cap: ${active}/${cap} active${overCap}`);
    }
  } catch {
    // Non-fatal
  }

  ui.blank();

  return { exitCode: 0 };
}

async function mcAbort(ctx: HandlerContext): Promise<HandlerResult> {
  const positional = getPositionalArgs(ctx.args);
  const sessionId = positional[0];
  const missionId = positional[1];

  if (!sessionId || !missionId) {
    ui.error('Usage: aiwg mc abort <session-id> <mission-id>');
    return { exitCode: 1 };
  }

  const flags = mutationFlags(ctx.args);
  const result = await mutateSession(sessionId, 'cancel', missionId, flags.expectedUpdatedAt, flags.requestId, session => {
    const mission = session.missions.find(m => m.id === missionId);
    if (!mission) return 'target_not_found';
    if (mission.status === 'done' || mission.status === 'failed' || mission.status === 'aborted') return 'invalid_state';
    mission.status = 'aborted';
    mission.completedAt = new Date().toISOString();
    return undefined;
  });
  if (!result.ok) return mutationFailure(result);

  if (!result.replayed) {
    const mission = result.session.missions.find(candidate => candidate.id === missionId);
    if (mission?.admissionRequestId) {
      try {
        const projectRoot = ctx.cwd || process.cwd();
        const { readAiwgConfig, resolveParallelism } = await import('../../config/aiwg-config.js');
        const { FileAdmissionStore, SharedHostScheduler } = await import('../../serve/shared-host-scheduler.js');
        const cfg = await readAiwgConfig(projectRoot).catch(() => null);
        const provider = cfg?.providers[0] ?? 'unknown';
        const maxConcurrent = resolveParallelism(cfg?.parallelism, provider).max_parallel_mc_missions;
        const scheduler = new SharedHostScheduler(
          new FileAdmissionStore(join(projectRoot, MC_ROOT, 'admission.json')),
          { maxConcurrent, leaseTtlMs: 5 * 60_000, agingIntervalMs: 30_000, allowPreemption: false, defaultHostQuota: maxConcurrent },
        );
        scheduler.cancel(mission.admissionRequestId);
      } catch {
        // The mission state is authoritative; lease expiry provides recovery.
      }
    }
  }

  ui.success(`${result.replayed ? 'Replayed' : 'Aborted'} mission: ${missionId}`);
  return { exitCode: 0, message: JSON.stringify({ ok: true, replayed: result.replayed, updated_at: result.session.updatedAt }) };
}

async function mcPause(ctx: HandlerContext): Promise<HandlerResult> {
  const positional = getPositionalArgs(ctx.args);
  const sessionId = positional[0];

  const selected = await findActiveSession(sessionId);
  if (!selected) {
    ui.error('No active session to pause.');
    return { exitCode: 1 };
  }
  const flags = mutationFlags(ctx.args);
  const result = await mutateSession(selected.id, 'pause', selected.id, flags.expectedUpdatedAt, flags.requestId, session => {
    if (session.state !== 'active') return 'invalid_state';
    session.state = 'paused';
    for (const mission of session.missions) if (mission.status === 'running') mission.status = 'paused';
    return undefined;
  });
  if (!result.ok) return mutationFailure(result);

  ui.success(`${result.replayed ? 'Replayed pause for' : 'Paused'} session: ${selected.id}`);
  return { exitCode: 0, message: JSON.stringify({ ok: true, replayed: result.replayed, updated_at: result.session.updatedAt }) };
}

async function mcResume(ctx: HandlerContext): Promise<HandlerResult> {
  const positional = getPositionalArgs(ctx.args);
  const sessionId = positional[0];

  const selected = await findActiveSession(sessionId);
  if (!selected || selected.state !== 'paused') {
    ui.error('No paused session to resume.');
    return { exitCode: 1 };
  }
  const flags = mutationFlags(ctx.args);
  const result = await mutateSession(selected.id, 'resume', selected.id, flags.expectedUpdatedAt, flags.requestId, session => {
    if (session.state !== 'paused') return 'invalid_state';
    session.state = 'active';
    for (const mission of session.missions) if (mission.status === 'paused') mission.status = 'running';
    return undefined;
  });
  if (!result.ok) return mutationFailure(result);

  ui.success(`${result.replayed ? 'Replayed resume for' : 'Resumed'} session: ${selected.id}`);
  return { exitCode: 0, message: JSON.stringify({ ok: true, replayed: result.replayed, updated_at: result.session.updatedAt }) };
}

async function mcStop(ctx: HandlerContext): Promise<HandlerResult> {
  const positional = getPositionalArgs(ctx.args);
  const sessionId = positional[0];
  const drain = hasFlag(ctx.args, '--drain');

  const session = await findActiveSession(sessionId);
  if (!session) {
    ui.error('No active session to stop.');
    return { exitCode: 1 };
  }

  if (drain) {
    // Mark queued missions as aborted, let running finish
    for (const m of session.missions) {
      if (m.status === 'queued') {
        m.status = 'aborted';
        m.completedAt = new Date().toISOString();
      }
    }
    ui.info('Draining: queued missions cancelled, running missions will complete.');
  } else {
    // Abort all non-completed missions
    for (const m of session.missions) {
      if (m.status === 'running' || m.status === 'queued' || m.status === 'paused') {
        m.status = 'aborted';
        m.completedAt = new Date().toISOString();
      }
    }
  }

  session.state = 'stopped';
  await writeSession(session);
  await appendLog(session.id, { event: 'session_stopped', drain });

  ui.success(`Stopped session: ${session.id}`);
  return { exitCode: 0 };
}

async function mcList(ctx: HandlerContext): Promise<HandlerResult> {
  const json = hasFlag(ctx.args, '--json');
  const sessions = await listSessions();

  if (json) {
    console.log(JSON.stringify(sessions.map(s => ({
      id: s.id,
      name: s.name,
      state: s.state,
      missions: s.missions.length,
      created: s.createdAt,
      updated: s.updatedAt,
    })), null, 2));
    return { exitCode: 0 };
  }

  if (sessions.length === 0) {
    ui.info('No Mission Control sessions. Run `aiwg mc start` to create one.');
    return { exitCode: 0 };
  }

  ui.blank();
  console.log(`  ${ui.brandMark()} ${ui.bold('Mission Control Sessions')}`);
  ui.rule();

  for (const s of sessions) {
    const stateIcon = s.state === 'active' ? '●' : s.state === 'paused' ? '⏸' : '○';
    const missionCount = s.missions.length;
    const done = s.missions.filter(m => m.status === 'done').length;
    console.log(`  ${stateIcon} ${s.id}  ${ui.accent(s.name)}  (${done}/${missionCount} done)  [${s.state}]`);
  }

  ui.blank();
  return { exitCode: 0 };
}

async function mcWatch(ctx: HandlerContext): Promise<HandlerResult> {
  const positional = getPositionalArgs(ctx.args);
  const sessionId = positional[0];

  const session = await findActiveSession(sessionId);
  if (!session) {
    ui.error('No active session to watch.');
    return { exitCode: 1 };
  }

  // For non-interactive contexts, show status once with a note
  // Real streaming would use fs.watch on the session file
  ui.info(`Watch mode: polling session ${session.id}`);
  ui.info('Press Ctrl+C to stop watching.');
  ui.blank();

  // Show current status
  ctx.args = [session.id];
  return mcStatus(ctx);
}

// ── Agent routing query ──────────────────────────────────────

/**
 * aiwg mc agents [--filter key=value...] [--json]
 *
 * Queries GET /api/agents/candidates on the local aiwg serve instance and
 * prints a table of agents that match the given routing filter. This is a thin
 * CLI wrapper over the #916 routing endpoint so operators can check routing
 * from a terminal without opening the dashboard.
 *
 * Filter flags:
 *   --framework <name>       Require a specific AIWG framework (repeatable)
 *   --sandbox <id>           Restrict to a specific sandbox
 *   --agent <id>             Restrict to a specific agent ID
 *   --name <n>               Match by logical name
 *   --max-cpu <pct>          Reject agents above this CPU %
 *   --min-memory <gb>        Reject agents below this memory threshold
 *   --json                   Output raw JSON
 */
async function mcAgents(ctx: HandlerContext): Promise<HandlerResult> {
  const args = ctx.args;
  const json = hasFlag(args, '--json');

  const port = process.env['AIWG_SERVE_PORT'] ?? '7337';
  const base = `http://127.0.0.1:${port}`;

  const params = new URLSearchParams();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--framework' && args[i + 1]) { params.append('frameworks', args[++i]!); }
    else if (a === '--sandbox' && args[i + 1]) { params.set('sandbox_id', args[++i]!); }
    else if (a === '--agent' && args[i + 1]) { params.set('agent_id', args[++i]!); }
    else if (a === '--name' && args[i + 1]) { params.set('agent_name', args[++i]!); }
    else if (a === '--max-cpu' && args[i + 1]) { params.set('max_cpu_percent', args[++i]!); }
    else if (a === '--min-memory' && args[i + 1]) { params.set('min_memory_gb', args[++i]!); }
  }

  // 5s timeout so a wedged serve cannot hang the CLI. Override with
  // AIWG_FETCH_TIMEOUT_MS for slow local environments or integration tests.
  const fetchTimeoutMs = (() => {
    const raw = process.env['AIWG_FETCH_TIMEOUT_MS'];
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 5_000;
  })();

  let result: { selected?: Record<string, unknown>; candidates: Record<string, unknown>[] };
  try {
    // Combine user-cancel (Ctrl-C) with the per-call timeout so the fetch
    // aborts on either. `AbortSignal.any` requires Node 20+.
    const signal = ctx.signal
      ? AbortSignal.any([ctx.signal, AbortSignal.timeout(fetchTimeoutMs)])
      : AbortSignal.timeout(fetchTimeoutMs);
    const resp = await fetch(`${base}/api/agents/candidates?${params.toString()}`, {
      signal,
    });
    if (!resp.ok) {
      ui.error(`aiwg serve returned ${resp.status} — is it running on port ${port}?`);
      return { exitCode: 1 };
    }
    result = await resp.json() as typeof result;
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      ui.error(`aiwg serve on port ${port} timed out after ${fetchTimeoutMs}ms. Is it wedged?`);
    } else {
      ui.error(`Cannot reach aiwg serve on port ${port}. Start it with: aiwg serve`);
    }
    return { exitCode: 1 };
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return { exitCode: 0 };
  }

  ui.blank();
  console.log(`  ${ui.brandMark()} ${ui.bold('Agent Routing Candidates')}`);
  ui.rule();

  if (result.candidates.length === 0) {
    ui.info('No matching agents found for the given filter.');
    return { exitCode: 0 };
  }

  for (const c of result.candidates) {
    const agent = c['agent'] as Record<string, unknown> | undefined;
    const agentId = agent?.['agentId'] as string ?? '?';
    const logicalName = agent?.['logicalName'] as string | undefined;
    const sandboxName = c['sandboxName'] as string ?? '';
    const cpu = (agent?.['latestMetrics'] as Record<string, number> | undefined)?.['cpu_percent'];
    const status = agent?.['status'] as string ?? '';
    const isSelected = (result.selected as Record<string, unknown> | undefined)?.['sandboxName'] === sandboxName &&
      ((result.selected as Record<string, unknown>)?.['agent'] as Record<string, unknown> | undefined)?.['agentId'] === agentId;

    const label = logicalName ? `${logicalName} (${agentId})` : agentId;
    const cpuStr = cpu !== undefined ? ` cpu:${cpu.toFixed(0)}%` : '';
    const selectedMark = isSelected ? ' ← selected' : '';
    console.log(`  • ${ui.bold(label)}  sandbox:${sandboxName}  status:${status}${cpuStr}${selectedMark}`);
    const reason = c['matchReason'] as string | undefined;
    if (reason) console.log(`      reason: ${reason}`);
  }

  ui.blank();
  return { exitCode: 0 };
}

// ── Subcommand router ────────────────────────────────────────

const subcommands: Record<string, (ctx: HandlerContext) => Promise<HandlerResult>> = {
  start: mcStart,
  dispatch: mcDispatch,
  run: mcRun, // #1439
  status: mcStatus,
  watch: mcWatch,
  abort: mcAbort,
  cancel: mcAbort,
  pause: mcPause,
  resume: mcResume,
  stop: mcStop,
  list: mcList,
  agents: mcAgents,
};

function showMcHelp(): void {
  ui.blank();
  console.log(`  ${ui.brandMark()} ${ui.bold('Mission Control')} — multi-loop background orchestration`);
  ui.rule();
  console.log(`
  ${ui.bold('Usage:')} aiwg mc <subcommand> [options]

  ${ui.bold('Lifecycle:')}
    1. start    — create a session (state-tracking only)
    2. dispatch — queue one or more missions onto a session
    3. run      — drain the queue by launching each mission as a ralph loop
    4. status   — view progress (auto-syncs from ralph loop state)
    5. watch    — live tail of progress
    6. stop     — shut down the session

  ${ui.bold('Subcommands:')}
    start                         Start a new Mission Control session
    dispatch <id> "<objective>"   Queue a mission on the session (does NOT execute)
                                  [--completion "<criteria>"] [--max-iterations N]
                                  [--max-total-tokens N] [--max-output-tokens N]
                                  [--max-tool-calls N] [--max-total-cost USD]
                                  [--max-wall-clock-minutes N] [--exploration-quota N]
                                  [--mode pty-orchestrator] [--target-agent <id>]
    run <id> [--accept-cost]      Launch queued missions as ralph loops (#1439)
                                  Cost gate warns/refuses above ~$5 estimate
    status [<id>] [--json]        View mission status dashboard
    watch [<id>]                  Live monitor (streaming)
    abort|cancel <session> <mission> Abort a specific mission
    pause [<id>]                  Pause active session
    resume [<id>]                 Resume paused session
    stop [<id>] [--drain]         Shut down session
    list [--json]                 List all sessions
    agents [--filter] [--json]    Query routable agents from aiwg serve (#916)
  ${ui.bold('Examples:')}
    aiwg mc start --name "Sprint 4"
    aiwg mc dispatch mc-abc123 "Fix auth" --completion "tests pass"
    aiwg mc dispatch mc-abc123 "Fix auth" --completion "tests pass" --max-total-tokens 5000 --exploration-quota 2
    aiwg mc dispatch mc-abc123 "Refactor users" --completion "npm test passes"
    aiwg mc run mc-abc123                     # launches queued missions
    aiwg mc status mc-abc123                  # syncs progress from ralph loops
    aiwg mc dispatch mc-abc123 "Supervise agent-01" --mode pty-orchestrator --target-agent agent-01 --completion "migration complete"
    aiwg mc stop mc-abc123 --drain
    aiwg mc agents --framework sdlc-complete --max-cpu 80

  ${ui.bold('A2A route for new sandbox work:')}
    GET  /api/v2/admin/instances
    GET  /agents/{instance_id}/.well-known/agent-card.json
    GET  /agents/{instance_id}/v1/extendedAgentCard
    POST /agents/{instance_id}/v1/messages:send
`);
}

// ── Exported handler ─────────────────────────────────────────

export const mcHandler: CommandHandler = {
  id: 'mc',
  name: 'Mission Control',
  description: 'Multi-loop background orchestration (start, dispatch, status, watch, stop)',
  category: 'orchestration',
  aliases: ['mission-control'],

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const subcmd = ctx.args[0];

    if (!subcmd || subcmd === '--help' || subcmd === '-h') {
      showMcHelp();
      return { exitCode: 0 };
    }

    const handler = subcommands[subcmd];
    if (!handler) {
      ui.error(`Unknown subcommand: ${subcmd}. Run 'aiwg mc --help' for usage.`);
      return { exitCode: 1 };
    }

    // #1440: '--help' / '-h' on any subcommand prints usage and exits BEFORE
    // any side-effecting logic. The previous behavior — e.g. 'mc start --help'
    // actually creating a session — violated the universal --help convention.
    const subArgs = ctx.args.slice(1);
    if (wantsHelp(subArgs)) {
      printSubcommandHelp(subcmd);
      return { exitCode: 0 };
    }

    // Pass remaining args to subcommand
    const subCtx: HandlerContext = {
      ...ctx,
      args: subArgs,
    };

    return handler(subCtx);
  },
};

/**
 * All MC-related handlers for bulk registration
 */
export const mcHandlers: CommandHandler[] = [mcHandler];
