// Mission Control help operations, extracted from the shared handler.

import * as ui from '../ui.js';

/**
 * Per-subcommand usage strings (#1440).
 *
 * `aiwg mc <subcommand> --help` MUST print this text and exit before any
 * side-effecting logic. The previous behavior — running `aiwg mc start --help`
 * actually created a session — violated the universal `--help` convention.
 */
export const subcommandUsage: Record<string, string> = {
  summary: `Usage: aiwg mc summary --ledger <path> [--json]

Read an existing Mission conductor ledger without syncing or writing it.
Accepted requires an independent review result with evidence references.
Completed means worker execution finished without independent acceptance.
Routed, plan-only and unmeasured work remain unknown.

  --ledger <path>   Existing conductor ledger JSON (relative to the working directory)
  --json            Emit cycle classifications, reasons, evidence and counts`,
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
  --worker-dispatch <path>      Prepared managed worker dispatch JSON (queues only)
  --expected-updated-at <time>  Reject stale state with exit 3
  --request-id <id>             Idempotent dispatch key`,

  run: `Usage: aiwg mc run [<session-id>] [--accept-cost]

Drain queued missions in a session by launching each as a ralph loop. Missions
without --completion criteria are skipped with a warning.

  --accept-cost   Skip the cost-warning gate (required for non-TTY contexts
                  when estimated cumulative cost exceeds $5). See #1450.

The estimate is the cumulative iteration floor (missions x max-iterations x
~$1.60 cache cost per headless iteration). A mission's --max-total-cost caps its
share of that estimate only on a provider that reports spend; on a provider that
reports none the ceiling is inert (#1766), so it is reported but not subtracted.
See #2522.`,

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

export function printSubcommandHelp(name: string): void {
  const text = subcommandUsage[name];
  ui.blank();
  if (text) {
    console.log(`  ${text}`);
  } else {
    console.log(`  No detailed help for 'aiwg mc ${name}'. Run 'aiwg mc --help' for the full reference.`);
  }
  ui.blank();
}

export function showMcHelp(): void {
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
    summary --ledger <path> [--json]  Read accepted, completed, failed and unknown work
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
