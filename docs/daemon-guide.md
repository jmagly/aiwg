# Daemon Mode Guide

> "Start the daemon for this project and show me it's healthy."
> "Run the overnight security scan and queue a task to fix what it finds."

Your assistant starts and supervises the persistent AIWG daemon for the project: lifecycle, agent tasks, schedules, memory, behaviors, and remote-operation surfaces. Every command below is on the real `aiwg daemon` surface (`tools/daemon/index.mjs`); related surfaces are `aiwg housekeeper`, `aiwg behavior`, and `aiwg daemon-init`.

## Overview

The daemon provides:

- **File watching** — Trigger actions when project files change
- **Scheduled tasks** — Cron-like scheduling for health checks and audits
- **Agent supervision** — Spawn and manage AI agent subprocesses with governance
- **PTY orchestration** — AI-driven terminal supervision: read screen, assess state, inject input autonomously
- **Multi-session management** — Supervise multiple concurrent agent sessions per daemon
- **Operator override** — Human-in-the-loop handoff: pause the AI, take manual control, resume
- **Task queue** — Persistent task management with priority support
- **Automation rules** — Event-driven trigger→condition→action workflows
- **IPC communication** — CLI↔daemon communication via Unix domain socket
- **Messaging integration** — Slack, Discord, and Telegram notifications and commands
- **2-way AI chat** — Ask questions from messaging platforms
- **Headless operation** — Runs inside agentic-sandbox containers without a display server

## Daemon vs housekeeper

> "Should this job run on the daemon or the housekeeper?"

Your assistant routes conversational, agent-driven work to the daemon and deterministic maintenance to the housekeeper, and explains the boundary in one sentence.

`aiwg housekeeper` is the deterministic maintenance profile of the same daemon. It reuses the daemon binary (`tools/daemon/daemon-main.mjs`) but loads only the scheduler, file watcher, and minimal IPC — it never constructs the agent supervisor, behaviors, messaging, or web server, and it runs zero model calls. The default profile runs the conversational daemon described in this guide. Full boundary: [housekeeper daemon reuse boundary](https://github.com/jmagly/aiwg/blob/main/docs/architecture/housekeeper-daemon-boundary.md) and the [Housekeeper operator guide](https://github.com/jmagly/aiwg/blob/main/docs/housekeeper-operator-guide.md).

| Profile | Command | Runs |
|---|---|---|
| Conversational daemon (default) | `aiwg daemon start` | Agent tasks, chat, behaviors, automation, messaging |
| Deterministic maintenance | `aiwg housekeeper start` | Cron-scheduled owner operations with persisted receipts |

## Quick Start

> "Start the daemon and queue a task to fix the failing auth tests."

Your assistant starts the daemon, checks its status, and submits the task to the agent supervisor.

### Command reference

```bash
aiwg daemon start
aiwg daemon status
aiwg daemon task submit "Fix the failing tests in auth module"
aiwg daemon stop
```

The daemon detaches from the terminal and runs in the background. State is stored in `.aiwg/daemon/`. `status` queries the live daemon over IPC when it is running. `stop` sends SIGTERM for graceful shutdown.

## Initialize from a profile

> "Set up the daemon config for this project from the default profile."

Your assistant initializes the daemon config from a profile template.

### Command reference

```bash
aiwg daemon init                     # manager profile → .aiwg/daemon.yaml
aiwg daemon init list                # list available profiles
aiwg daemon init manager --force     # overwrite the existing config
```

`aiwg daemon-init` is the same operation under its handler name (`src/cli/handlers/daemon.ts` → `tools/daemon/init-profile.mjs`). It writes `.aiwg/daemon.yaml` plus a `.env.example` template when none exists. The daemon reads `.aiwg/daemon.yaml` first, then `.aiwg/daemon.json`, then built-in defaults.

## Lifecycle

> "Restart the daemon and tail its logs while it comes up."

Your assistant restarts the daemon and streams the log.

### Command reference

```bash
aiwg daemon start                    # detached background process
aiwg daemon start --foreground       # foreground (Docker/systemd)
aiwg daemon start --docker           # start inside a Docker container
aiwg daemon stop
aiwg daemon restart
aiwg daemon status                   # live via IPC, state-file fallback
aiwg daemon logs --lines 100
aiwg daemon logs --follow            # or: aiwg daemon logs -f
aiwg daemon attach                   # open the aiwg-daemon tmux session
aiwg daemon attach --readonly        # observe without sending input
```

`attach` creates the `aiwg-daemon` tmux session (chat REPL plus status pane) when none exists, starting the daemon first when it is stopped. There is no `start --tmux` flag: tmux handling lives in `attach`.

## Agent tasks

> "Submit a high-priority task to refactor the user module, then list what's running."

Your assistant submits the task with a priority and lists tasks filtered by state.

### Command reference

```bash
aiwg daemon task submit "Refactor the user module to use dependency injection"
aiwg daemon task submit "Fix critical security bug" --priority 10 --agent claude-code
aiwg daemon task list
aiwg daemon task list --state running --limit 20
aiwg daemon task get <task-id>
aiwg daemon task cancel <task-id>
aiwg daemon task stats
```

### How Tasks Work

1. A task is submitted (via CLI, automation rule, or messaging command)
2. The task enters the queue with its priority
3. When a slot is available (under `max_parallel_actions`), the supervisor spawns a `claude -p` process
4. The process runs in the project directory with full CLAUDE.md context
5. On completion, the result is stored in the task store
6. Events are emitted: `task:started`, `task:completed`, `task:failed`, `task:timeout`

### Task States

| State | Description |
|-------|-------------|
| `queued` | Waiting for an available slot |
| `running` | `claude -p` process is active |
| `completed` | Process exited successfully |
| `failed` | Process exited with error |
| `cancelled` | Cancelled by user or system |
| `timeout` | Exceeded `action_timeout_minutes` |

Tasks run in priority order (higher first); equal priorities run FIFO.

### Concurrency

`max_parallel_actions` controls how many tasks run simultaneously (default 3). Each running task is a separate child process running `claude -p`.

| Priority | Use Case | Example |
|----------|----------|---------|
| 10 | Critical security issues | Secret scanning |
| 5 | Important but not urgent | Nightly backups |
| 0 (default) | Normal development tasks | Test runs |
| -5 | Low priority background tasks | Documentation updates |

## Chat

> "Ask the daemon what our current test coverage is."

Your assistant sends the message through the running daemon, which handles it as an agent task.

### Command reference

```bash
aiwg daemon chat "What is our current test coverage?"
```

`chat` requires the daemon to be running and takes the message as its argument. For an interactive session, use `aiwg daemon attach`, which opens the tmux session with a chat REPL pane.

## Schedules and one-shot runs

> "Show the scheduled jobs, then run the nightly audit once without starting the daemon."

Your assistant shows scheduler status, then runs one deterministic maintenance job directly.

### Command reference

```bash
aiwg daemon schedule
aiwg daemon schedule --run-once --job <job-id>
aiwg daemon schedule --run-once --job <job-id> --json
aiwg daemon schedule --run-once --job <job-id> --fire-time <iso> --config PATH --store-path PATH
aiwg daemon schedule --run-once --job <job-id> --resolve "inspected; <what you found>"
```

`schedule` with no flags reports scheduler state and job history from the live daemon. `--run-once` executes exactly one configured deterministic maintenance job with no daemon, watcher, or IPC server; `--json` prints a single receipt object; `--resolve` acknowledges an inspected interrupted run without replaying it. Scheduled updates check only; installation stays opt-in via `aiwg update`. Manual execution is supported on Linux/macOS; on Windows use WSL2.

## Memory

> "Show me what the daemon remembers, then clear the session memory."

Your assistant shows memory contents and clears the requested scope.

### Command reference

```bash
aiwg daemon memory show
aiwg daemon memory show --scope user
aiwg daemon memory clear --scope session
aiwg daemon memory clear --scope project
```

Scopes are `session`, `project`, and `user`. `clear` requires `--scope`. When the daemon is running, both subcommands go over IPC; otherwise they read the memory files directly.

## Autonomous mode

> "Check whether autonomous mode is on, and turn it off."

Your assistant queries autonomous state and disables it.

### Command reference

```bash
aiwg daemon autonomous status
aiwg daemon autonomous enable
aiwg daemon autonomous disable
```

With no subcommand, `autonomous` reports status. Status shows running state, daily task count and spend against budget, pending proposals, approval requirements, and allowed actions.

## Messaging rooms

> "List the messaging rooms the daemon is connected to."

Your assistant lists connected rooms grouped by platform.

### Command reference

```bash
aiwg daemon rooms
```

Output shows total rooms, task bindings, and per-platform room labels, purposes, and default markers. Room wiring itself lives in the daemon config; see the [Messaging Guide](messaging-guide.md).

## Behaviors

> "List the available behaviors and apply the security sentinel to the daemon."

Your assistant lists behaviors, shows details, and applies the chosen one.

### Command reference

```bash
aiwg behavior list
aiwg behavior info security-sentinel
aiwg behavior apply security-sentinel
aiwg behavior remove security-sentinel
```

Behaviors are YAML bundles binding directives and toolsets to agent types. `list` and `info` work offline; `apply` and `remove` call the live daemon over IPC. Full format: [Behaviors Guide](behaviors-guide.md).

## Platform Support

The daemon runs on any CLI-based platform. Platforms are grouped into three tiers:

| Tier | Meaning | Platforms |
|------|---------|-----------|
| **Tier 1 — Native** | Full headless daemon support. `aiwg daemon start/stop/status` work out of the box. Platform has a headless CLI that can be supervised by the daemon's PTY orchestrator. | Claude Code, OpenCode, Warp Terminal, OpenClaw, Codex, Factory AI |
| **Tier 2 — PTY Adapter** | Platform has a TUI that can be bridged over a PTY. Not headless natively, but operable remotely via `aiwg daemon pty`. | Claude Code (secondary), Codex (secondary) |
| **Tier 3 — IDE-hosted** | Runs as an extension inside a desktop IDE process that requires a display server. No standalone CLI process to bridge or supervise. Can *connect to* a daemon over HTTP/WS but cannot *host* one. | Cursor, Devin Desktop, GitHub Copilot |

Tier 1 platforms receive the full daemon feature set: file watching, cron scheduling, agent supervision, PTY orchestration, IPC, automation rules, and behaviors. Tier 3 platforms still benefit from AIWG's agent loop, Mission Control, and scheduling via AIWG emulation — they connect to a daemon running elsewhere rather than hosting one locally.

See `agentic/code/providers/capability-matrix.yaml` for the authoritative `daemon_tier` field per provider.

## PTY Adapter

> "Start OpenCode under a PTY bridge so I can drive it remotely, then list sessions."

Your assistant spawns the platform TUI under a pseudo-terminal and bridges I/O through the chat channel, for remote operation of interactive TUI tools without a local terminal session.

### Command reference

```bash
aiwg daemon pty start opencode
aiwg daemon pty start opencode --tmux           # reconnectable session
aiwg daemon pty start codex --cols 120 --rows 40
aiwg daemon pty start claude-code -- --dangerously-skip-permissions
aiwg daemon pty list
aiwg daemon pty attach <session-id>             # reattach (requires --tmux)
aiwg daemon pty stop <session-id>
```

Supported platforms: `claude-code`, `opencode`, `codex`, `warp`, `openclaw`. Size flags are `--cols` (default 80) and `--rows` (default 24); `--tmux` starts inside a named tmux session so `pty attach` can reconnect later. Arguments after `--` pass through to the platform binary. Sessions persist across detaches — reconnect with `aiwg daemon pty list` to find the session ID.

The non-tmux PTY adapter requires `node-pty` (native module):

```bash
npm install node-pty   # requires node-gyp + C++ build tools
```

Tmux mode requires tmux to be installed instead.

Input from the chat channel is forwarded as keystrokes/stdin to the TUI and screen output flows back out, so both human-in-the-loop typing and agentic driving are supported.

### Execution Modes

The PTY adapter supports three execution modes, selected automatically based on configuration:

| Mode | Transport | Config | When to Use |
|------|-----------|--------|-------------|
| **Local** | `node-pty` on host | Default (no config) | Dev machine, `node-pty` available |
| **Container** | HTTP → sandbox → Docker | `AIWG_SANDBOX_ENDPOINT` | Isolated sandbox, fast spin-up |
| **VM** | HTTP → sandbox → QEMU | `AIWG_SANDBOX_ENDPOINT` | Full isolation, untrusted workloads |

```bash
export AIWG_SANDBOX_ENDPOINT=http://sandbox.local:8122
export AIWG_SANDBOX_AGENT_ID=agent-01   # optional, defaults to agent-01
aiwg daemon pty start opencode          # transport is transparent
```

Local mode spawns the TUI directly on the host via `node-pty` and requires native compilation. Sandbox mode delegates to an [agentic-sandbox](https://github.com/jmagly/agentic-sandbox) management server: the sandbox provisions the PTY inside containers or VMs, and the browser terminal viewer connects to the sandbox WebSocket (`:8121`) for real-time streaming with full ANSI color support.

Or use the programmatic API:

```javascript
import { PTYAdapter } from './tools/daemon/pty-adapter.mjs';

// Local transport
const adapter = new PTYAdapter({ platform: 'opencode', cols: 120, rows: 30 });

// Or explicitly use sandbox transport
const sandboxAdapter = PTYAdapter.fromSandbox({
  httpEndpoint: 'http://sandbox.local:8122',
  agentId: 'agent-01',
  platform: 'opencode',
});

await adapter.start();
adapter.on('data', (chunk) => process.stdout.write(chunk));
```

## PTY Orchestrator

> "Supervise agent-01 through Mission Control until the migration is complete and tests are green."

Your assistant dispatches a PTY-orchestrator mission that reads the agent's screen, assesses state with an LLM, and injects input the way a human operator would.

### Command reference

```bash
aiwg mc dispatch <session-id> \
  "Supervise agent-01: complete the database migration" \
  --mode pty-orchestrator \
  --target-agent agent-01 \
  --completion "migration complete and tests green"
```

`--mode pty-orchestrator` requires `--target-agent`. Mission Control treats this as a standard mission, but the executor is `OrchestratorPTY` instead of a direct task runner.

### Architecture

```
┌─────────────────────────────────────────────────────┐
│  PTY Orchestrator                                   │
│                                                     │
│  ┌──────────┐    ┌───────────────┐    ┌──────────┐  │
│  │ Screen   │───▶│ OrchestratorPTY│───▶│ Session  │  │
│  │ Reader   │    │ (assess loop) │    │ Adapter  │  │
│  └──────────┘    └───────────────┘    └──────────┘  │
│       ▲               │    ▲               │        │
│       │               ▼    │               ▼        │
│   PTY stdout     LLM Assessor    PTY stdin/signals  │
│                                                     │
│  ┌──────────────────┐                               │
│  │ Override Manager  │◄── Operator HITL handoff      │
│  └──────────────────┘                               │
└─────────────────────────────────────────────────────┘
```

**Components** (all in `src/serve/`):

| Component | File | Purpose |
|-----------|------|---------|
| **ScreenReader** | `screen-reader.ts` | Parses raw PTY byte stream into structured `ScreenState` using `@xterm/headless`. Extracts visible text grid, cursor position, scrollback, and detects prompts. |
| **OrchestratorPTY** | `orchestrator-pty.ts` | Runs a continuous read→assess→act loop. Calls an LLM assessor each cycle to decide: `type` (inject text), `wait` (observe), `signal` (SIGINT etc.), or `complete` (mission done). |
| **Orchestrator Adapter** | `orchestrator-adapter.ts` | Wires ScreenReader + OrchestratorPTY to live PTY sessions from the WebSocket bridge. Supports attach, detach, and re-attach without killing the PTY. |
| **Override Manager** | `orchestrator-override.ts` | Enables operator HITL handoff: pause the orchestrator, let a human interact directly, then resume. Maintains an audit trail of override events. |

### Assess Loop

Each cycle follows read→assess→plan→act: read screen state, evaluate it against the mission brief plus the last 10 actions, and inject keystrokes, wait, send a signal, or signal completion. Decisions are one of `type`, `wait`, `signal`, or `complete`.

### Screen State Parsing

The `ScreenReader` uses `@xterm/headless` (a headless xterm.js terminal) as its VT100/ANSI state machine, so escape sequences — colors, cursor movement, line wrapping, clear screen — are handled correctly without a DOM. The parsed `ScreenState` exposes the visible text grid, cursor position, scrollback, a human/LLM-readable summary, and whether a prompt was detected plus its text. Prompt detection checks the cursor row and last non-empty line against shell prompts (`$`, `#`, `>`, `%`), interactive prompts (`?` prefix, `[y/N]`, `(yes/no)`), and Claude Code `>` prompts.

### Operator Override (HITL Handoff)

A human operator can take manual control at any time: the orchestrator pauses after its current cycle, PTY stdin routes to the operator, and the orchestrator resumes from the current screen on release. Override events are recorded with timestamps; multiple override/release cycles are supported.

### Mission Control Integration

PTY-orchestrated missions dispatch via Mission Control (`--mode pty-orchestrator` requires `--target-agent`), where the executor is `OrchestratorPTY` instead of a direct task runner. Status displays show PTY missions distinctly, including the last injected action.

### MC ↔ aiwg serve dispatch

`aiwg mc dispatch` enqueues missions to `.aiwg/ralph-external/mc/sessions/*/session.json`. For agentic-sandbox work, use routable A2A instances and verify them through `GET /api/v2/admin/instances` and the agent-card endpoints. There are two operating modes: MC alone (missions queue for manual driving) or the A2A sandbox route (dispatch through `messages:send`, poll `tasks/{task_id}`, or subscribe).

## Daemon-in-Sandbox Deployment

> "Run a daemon inside a sandbox container so agents execute in full isolation."

Your assistant provisions the daemon-in-sandbox topology: each daemon runs inside an agentic-sandbox (Docker container or Firecracker VM), supervises PTY-orchestrated agent sessions, and coordinates with other daemons through Mission Control under the `aiwg serve` dashboard.

### Deployment Topology

| Layer | Component | Role |
|-------|-----------|------|
| **Operator** | `aiwg serve` | Web dashboard, sandbox registry, HITL relay |
| **Control plane** | AIWG daemon (1 per sandbox) | PTY orchestration, agent supervision, task queue |
| **Execution plane** | Agentic sandbox | Container/VM isolation, PTY allocation, process lifecycle |
| **Agent** | Claude Code / OpenCode / Codex | AI coding agent running inside the sandbox |

### How It Works

1. **Sandbox provisioning**: a sandbox instance starts with the daemon pre-installed; the daemon starts automatically and registers with the AIWG service.
2. **Session creation**: the operator or Mission Control dispatches a task, and the daemon spawns an agent session inside the sandbox via the PTY bridge.
3. **PTY orchestration**: `OrchestratorPTY` attaches to the session — the ScreenReader parses output, the LLM assessor decides what to type, the session adapter injects input.
4. **Multi-session**: one daemon supervises multiple concurrent agent sessions, up to `supervisor.max_concurrent`.
5. **Multi-daemon coordination**: Mission Control dispatches work across daemons and the AIWG service aggregates the view.
6. **Operator intervention**: the operator can override any session via the HITL relay — the orchestrator pauses, the operator interacts directly, then the orchestrator resumes.

Environment variables for sandbox deployment:

| Variable | Purpose |
|----------|---------|
| `AIWG_SANDBOX_ENDPOINT` | Sandbox management server URL |
| `AIWG_SERVE_ENDPOINT` | AIWG service URL for auto-registration |
| `AIWG_DAEMON_HEADLESS` | Set to `1` for headless operation (no TTY required) |

### Capability Levels

| Level | Capability | Requirements |
|-------|------------|-------------|
| **Level 1** | CLI tool — human drives, AI assists | AIWG CLI + any platform |
| **Level 2** | Agent loop — AI works, human reviews | External Ralph + agent supervisor |
| **Level 3** | PTY orchestration — AI drives terminal sessions | Daemon + ScreenReader + OrchestratorPTY |
| **Level 4** | Multi-session — one daemon supervises multiple agents | Daemon + concurrent PTY sessions |
| **Level 5** | Multi-daemon — fleet of daemons coordinated by MC | Multiple sandboxes + AIWG service + MC |

Level 3 and above require the daemon-in-sandbox deployment. Level 5 is the full distributed orchestration topology.

## Configuration

> "Watch src and test, run a health check every 30 minutes, and auto-test on TypeScript changes."

Your assistant writes the watch, schedule, and automation-rule blocks into the daemon config.

Configuration lives in `.aiwg/daemon.yaml` (written by `aiwg daemon init`) or `.aiwg/daemon.json` — the daemon reads YAML first, then JSON:

```yaml
# .aiwg/daemon.yaml
daemon:
  heartbeat_interval_seconds: 30
  max_parallel_actions: 3
  action_timeout_minutes: 120
watch:
  enabled: true
  paths: ["src/", "test/"]
  ignore: ["node_modules/", ".git/", "*.log"]
  debounce_ms: 1000
schedule:
  enabled: true
  jobs:
    - name: health-check
      cron: "*/30 * * * *"
      action: health-check
    - name: daily-audit
      cron: "0 9 * * *"
      action: security-audit
```

### Configuration Reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `daemon.heartbeat_interval_seconds` | number | 30 | Heartbeat write interval |
| `daemon.max_parallel_actions` | number | 3 | Maximum concurrent agent tasks |
| `daemon.action_timeout_minutes` | number | 120 | Task timeout before kill |
| `daemon.log.max_size_mb` | number | 50 | Log file rotation size |
| `daemon.log.max_files` | number | 5 | Number of rotated log files to keep |
| `watch.enabled` | boolean | false | Enable file system monitoring |
| `watch.paths` | string[] | — | Directories to watch |
| `watch.ignore` | string[] | — | Glob patterns to ignore |
| `watch.debounce_ms` | number | 1000 | Debounce interval for rapid changes |
| `schedule.enabled` | boolean | false | Enable cron scheduling |
| `schedule.jobs` | object[] | — | Cron job definitions |
| `rules` | object[] | — | Automation rules |

## Headend supervisor

> "Cap the daemon at four concurrent agents with a circuit breaker and a daily budget."

Your assistant writes the `supervisor` block that wraps the agent supervisor with process governance.

The daemon acts as the headend supervisor for all agent-loop lifecycles. `DaemonSupervisor` wraps the existing `AgentSupervisor` (`tools/daemon/agent-supervisor.mjs`) — which keeps handling subprocess spawning and the basic task queue — and adds governance without breaking direct `AgentSupervisor` consumers.

### What DaemonSupervisor adds

| Capability | Description |
|------------|-------------|
| **Concurrency cap** | Hard limit on simultaneous agent sessions (`max_concurrent`). Extra submissions queue in priority order; overflow past `max_queue_depth` is rejected with a structured error. |
| **Process group kill** | Terminates entire process trees (`process.kill(-pid, signal)`), so no orphaned child shells survive. |
| **Restart intensity** | Erlang/OTP-style `max_restarts` within a sliding window; exceeded thresholds mark the task permanently failed instead of looping forever. |
| **Circuit breaker** | Consecutive failures open the breaker for `cooldown_ms`; one half-open probe then decides whether it closes. |
| **Budget aggregation** | Rolls up spend across all loops — warning at 90% of `daily_budget_usd`, new spawns blocked at 100%, reset at midnight local time. |
| **Zombie reap** | Periodic sweep reconciles PID files against running processes and cleans up stale entries. |

### Command reference

```bash
aiwg daemon status    # includes supervisor, budget, and circuit state
```

```json
{
  "supervisor": {
    "max_concurrent": 4,
    "max_queue_depth": 20,
    "restart_intensity": { "max_restarts": 3, "window_seconds": 300 },
    "circuit_breaker": { "failure_threshold": 5, "cooldown_ms": 120000 },
    "daily_budget_usd": 50,
    "behaviors": ["ops-toolset"]
  }
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `supervisor.max_concurrent` | number | 4 | Maximum simultaneous agent sessions |
| `supervisor.max_queue_depth` | number | 20 | Maximum queued submissions before rejection |
| `supervisor.restart_intensity.max_restarts` | number | 3 | Restarts allowed within the window before permanent failure |
| `supervisor.restart_intensity.window_seconds` | number | 300 | Sliding window for restart counting (seconds) |
| `supervisor.circuit_breaker.failure_threshold` | number | 5 | Consecutive failures that open the circuit |
| `supervisor.circuit_breaker.cooldown_ms` | number | 120000 | Time the circuit stays open before half-open probe (ms) |
| `supervisor.daily_budget_usd` | number | 0 | Daily spend cap across all loops. 0 = no cap. |
| `supervisor.behaviors` | string[] | `[]` | Behavior names to attach at initialization |
| `interface.web.enabled` | boolean | false | Enable the operator web UI |
| `interface.web.port` | number | 7474 | Web UI port |
| `interface.web.host` | string | `"127.0.0.1"` | Bind address (localhost by default) |

See `.aiwg/architecture/adr-daemon-as-headend.md` for the full architecture decision.

## Concierge

> "Greet me with yesterday's context and route what I ask to the right daemon tool."

Your assistant enables the concierge behavior: the front-facing interaction layer that greets with persisted memory and routes intent to daemon primitives without exposing the routing.

Add to the daemon config:

```json
{
  "supervisor": { "behaviors": ["concierge"] },
  "behaviors": {
    "concierge": {
      "enabled": true,
      "memory": { "cross_session": true, "store": ".aiwg/daemon/concierge-memory.json" }
    }
  }
}
```

Or deploy via CLI:

```bash
aiwg behavior apply concierge
```

### Session Start

When the daemon session opens, the concierge reads persisted memory and greets with relevant context:

```
Welcome back. The overnight security scan completed clean. Two automation rules are
active — build-monitor and test-watcher — and the agent loop from yesterday is still
queued.
```

If no prior context exists:

```
Good morning. The daemon is running. What would you like to address?
```

### Tone Register

The concierge operates on five tone principles — the five Ps:

| Principle | Description |
|-----------|-------------|
| **Prompt** | Answers first; never hedges or over-qualifies |
| **Pertinent** | Every word earns its place; no filler |
| **Pleasant** | Warmth without informality |
| **Professional** | Consistent register regardless of topic sensitivity |
| **Discreet** | Sensitive operations handled without amplification |

### Routing

The concierge classifies user intent and routes to the appropriate daemon primitive without exposing the routing decision:

| Intent | Examples | Routes To |
|--------|---------|-----------|
| Status | "How's the build?" | Reads daemon state, summarizes |
| Task | "Fix the failing tests" | `aiwg daemon task submit` |
| Schedule | "Run the audit tonight" | Schedule config or `aiwg daemon schedule --run-once` |
| Behavior | "Start watching tests" | `aiwg behavior apply` |
| Information | "What's in the queue?" | Reads state files |
| Meta | "What can you do?" | Answers directly |
| Escalation | "Why is this failing?" | Diagnoses and surfaces cleanly |

### Memory

The concierge persists session context to `.aiwg/daemon/concierge-memory.json`:

- Last 5 completed tasks (type, outcome, timestamp)
- Active automation rules
- User preferences stated during sessions
- Unresolved items from prior sessions

It never asks about context it has already been given; relevant prior context is surfaced in the next session greeting.

### Implementation Reference

The concierge is defined in `agentic/code/behaviors/concierge/BEHAVIOR.md` and is the reference implementation for agent-based AIWG behaviors. It introduces `mode: agent` (AI-instruction behaviors vs shell-script behaviors), the `on_session_start` hook for persistent daemon session boundaries, `memory.cross_session` opt-in to persistent memory, and the `expose_internals: false` pattern for user-facing routing. See the [Behaviors Guide](behaviors-guide.md).

## Operator Web UI

> "Open the operator dashboard to watch loop output live."

Your assistant enables the web UI in the daemon config and starts the daemon.

When `interface.web.enabled` is `true`, the daemon serves an operator interface at `http://localhost:7474`.

### Access

```bash
aiwg daemon start
# then open http://localhost:7474
```

```json
{ "interface": { "web": { "enabled": true, "port": 7474, "host": "127.0.0.1" } } }
```

Authentication uses a Bearer [REDACTED] from `interface.web.token` or `AIWG_WEB_TOKEN`. With neither configured, authentication remains disabled. Prefer `interface.web.token_ref` with `ENV_NAME`, `file:ABSOLUTE_PATH`, or `store:NAME`. See [Supplying sensitive values](cli/sensitive-values.md#daemon-startup-references) for fields, precedence, and private-file requirements. The web UI is localhost-only by default; remote access requires a TLS-terminating reverse proxy — the daemon does not enforce TLS itself.

### Tab reference

| Tab | Purpose |
|-----|---------|
| **Loops** | All active loops — status, elapsed time, iteration count, controls (pause, resume, abort) |
| **Output** | Live SSE stream for a selected loop with ANSI rendering |
| **Submit** | Submit new task prompts with priority and budget override |
| **Resources** | System snapshot: CPU, memory, load average, queue depth, uptime |
| **History** | Completed loop summaries with duration, exit status, and cost rollup |

### Live streaming

Output is delivered via Server-Sent Events (SSE) — each loop has its own endpoint, and the browser reconnects automatically on disconnect. No WebSocket or polling required. See `.aiwg/architecture/adr-native-web-operator-interface.md`.

## Automation rules

> "Run the test suite whenever TypeScript sources change, after things settle for five seconds."

Your assistant writes the rule into the daemon config. Automation is config-driven: there is no `aiwg automation` CLI. The `automation.*` IPC methods exist on the daemon socket, and rule state shows in `aiwg daemon status`.

```json
{
  "id": "auto-test",
  "trigger": { "type": "file_change", "pattern": "src/**/*.{ts,js}" },
  "condition": { "type": "debounce", "interval_ms": 5000 },
  "action": { "type": "submit_task", "prompt": "Run the test suite and report results" }
}
```

| Trigger | Description | Parameters |
|------|-------------|------------|
| `file_change` | File created, modified, or deleted | `pattern` (glob) |
| `schedule` | Cron schedule fires | `cron` (cron expression) |
| `event` | Internal daemon event | `topic` (event topic string) |

| Condition | Description | Parameters |
|------|-------------|------------|
| `debounce` | Wait for activity to settle | `interval_ms` |
| `always` | Always proceed | — |

| Action | Description | Parameters |
|------|-------------|------------|
| `submit_task` | Submit to agent supervisor | `prompt`, `priority?` |

Every rule carries an `id`, one `trigger`, one `condition`, and one `action` (see the JSON above). Further examples:

```json
{
  "id": "security-scan",
  "trigger": {"type": "file_change", "pattern": "**/.env*"},
  "condition": {"type": "always"},
  "action": {"type": "submit_task", "prompt": "Scan for accidentally committed secrets", "priority": 10}
}
```

Avoid embedding secrets in rules; reference environment variables instead of literal credentials.

## Daemon Supervisor IPC Methods

The daemon communicates via a Unix domain socket at `.aiwg/daemon/daemon.sock` using JSON-RPC 2.0. The `ops-toolset` behavior maps directly onto these `daemon.*` methods.

| Method | Params | Returns |
|--------|--------|---------|
| `daemon.process.list` | `{ filter }` | Array of loop entries (id, status, pid, elapsed, iterations, cost) |
| `daemon.process.kill` | `{ loopId, signal }` | `{ killed, loopId, signal }` |
| `daemon.resource.snapshot` | `{}` | `{ cpu, memory, loadAvg, queueDepth, uptime }` |
| `daemon.circuit.status` | `{}` | `{ state, consecutiveFailures, cooldownRemainingMs }` |
| `daemon.queue.inspect` | `{}` | `{ depth, maxDepth, oldest, priorityDistribution }` |
| `daemon.loop.history` | `{ limit }` | Array of completed loop summaries |
| `daemon.budget.remaining` | `{}` | `{ dailyLimit, spent, remaining, percentUsed }` |

`filter` values for `daemon.process.list`: `all` (default), `running`, `queued`, `failed`. `signal` values for `daemon.process.kill`: `SIGTERM` (default), `SIGKILL`, `SIGINT` — sent to the entire process group. Circuit `state` values: `closed` (normal), `open` (blocking new spawns), `half-open` (one probe in progress).

## Health monitoring

> "Is the daemon alive, and what is it doing?"

Your assistant checks the heartbeat file, the state file, and live status.

The daemon writes a heartbeat every `heartbeat_interval_seconds` (default 30s) to `.aiwg/daemon/heartbeat` (PID, timestamp, uptime), and full state to `.aiwg/daemon/state.json`. The state file contains PID and start time, uptime, IPC socket path and connected clients, agent supervisor status and task statistics, file watcher and scheduler status, automation engine state, and the health assessment.

### Command reference

```bash
aiwg daemon status
cat .aiwg/daemon/heartbeat
```

Daemon logs go to `.aiwg/daemon/daemon.log` with automatic rotation at `log.max_size_mb` (default 50 MB), keeping `log.max_files` copies (default 5).

## Docker, CI, and services

> "Run the daemon in Docker and keep it alive across reboots."

Your assistant starts the daemon in a container for ephemeral environments and writes a service unit for long-lived hosts.

### Command reference

```bash
aiwg daemon start --docker
aiwg daemon start --foreground    # under systemd/docker entrypoint
```

The bundled image is built `FROM node:24-slim` (`tools/docker/Dockerfile.daemon`); use Node 24 for custom images, the same runtime the CLI requires.

No systemd or launchd is required — pure Node.js process management. PID file at `.aiwg/daemon.pid`, lock file at `.aiwg/daemon/.lock`, socket at `.aiwg/daemon/daemon.sock`. All paths are project-relative.

For long-lived deployments, use your system's service manager pointing at the daemon entry point (`tools/daemon/daemon-main.mjs`):

- **systemd (Linux)**: a unit with `Type=forking`, `PIDFile=/path/to/project/.aiwg/daemon.pid`, `ExecStart=/usr/bin/node /path/to/project/tools/daemon/daemon-main.mjs`, `WorkingDirectory=/path/to/project`, and `Restart=on-failure`.
- **launchd (macOS)**: a plist with `ProgramArguments` pointing at node plus `daemon-main.mjs`, `WorkingDirectory`, `RunAtLoad`/`KeepAlive`, and stdout/stderr paths under `.aiwg/daemon/`.

## File Structure

```
.aiwg/
├── daemon.pid                 # Daemon process ID
└── daemon/
    ├── .lock                  # Single-instance lock file
    ├── heartbeat              # Health check file (JSON)
    ├── state.json             # Full daemon state
    ├── daemon.log             # Log output
    ├── daemon.log.1           # Rotated logs
    ├── daemon.sock            # Unix domain socket for IPC
    ├── tasks.json             # Persistent task queue
    ├── actions/               # Action output directory
    └── events/                # Event log directory
```

## Troubleshooting

> "The daemon won't start and tasks are stuck in the queue."

Your assistant checks for a stale lock, verifies the socket and PID, and inspects the queue.

### Command reference

```bash
aiwg daemon status
ls -la .aiwg/daemon/.lock
rm .aiwg/daemon/.lock .aiwg/daemon.pid   # only when the daemon is confirmed not running
aiwg daemon start
ls -la .aiwg/daemon/daemon.sock
aiwg daemon task list --state running
aiwg daemon task list --state queued
aiwg daemon task get <task-id>
aiwg daemon task cancel <task-id>
tail -f .aiwg/daemon/daemon.log | grep automation
```

**Daemon won't start.** Check `aiwg daemon status` and for a stale lock file; remove the lock and PID files only when the daemon is confirmed not running, then start again.

**Can't connect.** Verify the socket exists with permissions `0600`, and that the PID in `.aiwg/daemon.pid` is alive.

**Tasks stuck in queue.** Check whether `max_parallel_actions` is saturated (`aiwg daemon task list --state running`), then cancel the stuck task.

**Circuit breaker is open.** The breaker opens when consecutive failures reach `circuit_breaker.failure_threshold`. Check `aiwg daemon status`, wait out the cooldown (default 120 s) for the half-open probe; a successful probe closes it automatically. To reduce sensitivity, raise `failure_threshold` or `cooldown_ms`.

**Restart intensity exceeded.** A loop restarts at most `max_restarts` times per `window_seconds` before permanent failure. Inspect with `aiwg daemon task get <task-id>`, fix the root cause, and resubmit with `aiwg daemon task submit`. To allow more restarts, raise `supervisor.restart_intensity.max_restarts`.

**Queue overflow.** Submissions are rejected past `max_queue_depth` — backpressure, not an error. Cancel lower-priority items or raise the cap cautiously.

**Budget gate.** New loops block at 100% of `daily_budget_usd` (warning at 90%); the budget resets at midnight local time. Set `0` to disable.

**Log file too large.** Tune `daemon.log.max_size_mb` / `max_files`; for memory growth from accumulated chat history, `aiwg daemon stop && aiwg daemon start`.

```json
{ "daemon": { "log": { "max_size_mb": 50, "max_files": 5 } } }
```

## Advanced Configuration

Automation rules can respond to custom daemon events:

```json
{
  "id": "on-deployment-complete",
  "trigger": { "type": "event", "topic": "deployment:complete" },
  "condition": {"type": "always"},
  "action": { "type": "submit_task", "prompt": "Run post-deployment smoke tests" }
}
```

Emit custom events from your own scripts over the IPC socket (`.aiwg/daemon/daemon.sock`, JSON-RPC 2.0). For environment-specific setups, keep separate daemon files per environment and select between them when running a schedule job manually:

```bash
aiwg daemon schedule --run-once --job nightly-audit --config .aiwg/daemon.prod.json
```

Priority strategy: tasks execute in priority order (higher first, FIFO within a level) — reserve high priorities for truly urgent tasks.

## Performance Tuning

For large projects, narrow `watch.paths`, extend `watch.ignore` to cover `dist/`, `build/`, and `coverage/`, and raise `watch.debounce_ms` (e.g. 3000) to quiet rapid-change noise. Adjust `daemon.max_parallel_actions` to the host: 3–5 on a development machine, 5–10 on CI, 1–3 on a production server — each agent task is a separate `claude -p` process, so watch RSS with `ps aux`. Keep `daemon.action_timeout_minutes` generous for audits (default 120); per-task timeout overrides do not exist on `task submit`, so size the global timeout for your longest job.

## Security Considerations

The daemon runs with the permissions of the user who started it, and IPC socket permissions are `0600` (owner read/write only). In multi-user environments, run the daemon as a dedicated service user and lock down `.aiwg/daemon/`. Never embed secrets in automation rules — reference environment variables instead. The daemon exposes no network surface by default (Unix domain socket only); for remote access, forward the socket over SSH rather than exposing ports.

## Migration from Manual Workflows

### Before: Manual Testing

```bash
# Developer manually runs tests after changes
npm test
```

### After: Automated Testing

```json
{
  "rules": [
    {
      "id": "auto-test",
      "trigger": {"type": "file_change", "pattern": "src/**/*.ts"},
      "condition": {"type": "debounce", "interval_ms": 5000},
      "action": {"type": "submit_task", "prompt": "Run tests for changed files"}
    }
  ]
}
```

Now tests run automatically after code changes stabilize.

### Before: Scheduled Tasks via Cron

```cron
0 9 * * * cd /path/to/project && npm run audit
```

### After: Daemon Scheduling

```json
{
  "schedule": {
    "enabled": true,
    "jobs": [{ "name": "daily-audit", "cron": "0 9 * * *", "action": "security-audit" }]
  }
}
```

Scheduling is now project-aware and integrated with task management.

## Best Practices

1. **Start small** — Begin with file watching or scheduling, add automation rules incrementally
2. **Use meaningful rule IDs** — Makes debugging and logs clearer
3. **Set appropriate debounce intervals** — Balance responsiveness with noise reduction
4. **Monitor task queue depth** — Adjust `max_parallel_actions` if queue grows
5. **Review logs regularly** — Check `.aiwg/daemon/daemon.log` for issues
6. **Test automation rules** — Manually trigger events to verify behavior
7. **Document custom rules** — Add comments explaining business logic
8. **Version control daemon config** — Track `.aiwg/daemon.yaml` in git
9. **Set up log rotation** — Prevent disk space issues
10. **Use priorities wisely** — Reserve high priorities for truly urgent tasks

## FAQ

**Q: Can I run multiple daemons in different projects?**

Yes. Each project has its own daemon instance with separate state in `.aiwg/daemon/`.

**Q: Does the daemon survive system reboots?**

No. Use your OS service manager (systemd/launchd) to start the daemon automatically.

**Q: Can I submit tasks while the daemon is stopped?**

No. The daemon must be running to accept tasks. Start it with `aiwg daemon start`.

**Q: How do I upgrade the daemon after updating AIWG?**

Stop the daemon, update, restart:

```bash
aiwg daemon stop
npm update -g aiwg
aiwg daemon start
```

**Q: Can automation rules spawn other automation rules?**

Not directly, but tasks submitted by automation can emit events that trigger other rules.

**Q: What happens to running tasks when I stop the daemon?**

Running tasks receive SIGTERM with up to 10 seconds to exit gracefully (the CLI waits before SIGKILL). After that, they're killed.

**Q: How do I debug automation rules?**

Check the daemon log for trigger/action events:

```bash
tail -f .aiwg/daemon/daemon.log | grep automation
```

**Q: Can I pause rule processing without stopping the daemon?**

Remove or disable the `rules` in the daemon config and restart the daemon.

**Q: Can I use the daemon without messaging platforms?**

Yes. Messaging integration is optional. The daemon provides file watching, scheduling, and task management independently.

## Test coverage

The daemon + serve + sandbox seam is covered by a four-tier strategy in [`.aiwg/testing/test-strategy-daemon-serve-sandbox.md`](https://github.com/jmagly/aiwg/blob/main/.aiwg/testing/test-strategy-daemon-serve-sandbox.md):

- **Tier 1 (unit)** — `npm test` runs the mocked-transport unit suites under `test/unit/serve/` and `test/unit/mc-bridge/`.
- **Tier 2 (contract)** — `npm run test:conformance` replays the executor-contract v1 fixtures (#1183).
- **Tier 3 (integration)** — `npm run test:integration:serve` spawns real `aiwg serve` against the in-process fake-sandbox harness and drives full HTTP + WS proxy flows (#1174), including PTY bridge resilience scenarios for reconnect, bounded replay buffering, kill/respawn, write ordering, and resize propagation (#1175).
- **Tier 4 (live UAT)** — `npm run uat:serve-live` runs against a real agentic-sandbox at `AIWG_SANDBOX_ENDPOINT`; skips cleanly when unreachable (#1176).

Tiers 1–3 run in CI. Tier 4 is operator-driven before releases that touch the serve seam.

## Cross-References

- [Serve Guide](serve-guide.md) — Operator web dashboard, sandbox registration, HITL relay
- [Messaging Guide](messaging-guide.md) — Platform integration
- [Agent Loop Guide](agent-loop-guide.md) — Iterative task loops via daemon
- [Behaviors Guide](behaviors-guide.md) — Attaching capabilities to daemon and long-running agents
- [Housekeeper operator guide](https://github.com/jmagly/aiwg/blob/main/docs/housekeeper-operator-guide.md) — Deterministic maintenance profile
- `agentic/code/providers/capability-matrix.yaml` — Authoritative `daemon_tier` and feature data
- `agentic/code/behaviors/concierge/BEHAVIOR.md` — Concierge behavior definition
- `src/cli/handlers/mc.ts` — Mission Control with `--mode pty-orchestrator`
- `src/serve/pty-bridge.ts` — WebSocket PTY bridge
- `.aiwg/architecture/adr-daemon-as-headend.md` — DaemonSupervisor headend architecture
- `.aiwg/architecture/adr-native-web-operator-interface.md` — Web UI architecture decision
- `tools/daemon/README.md` — Developer documentation
- `tools/daemon/daemon-main.mjs` — Daemon entry point source
- `tools/daemon/pty-adapter.mjs` — PTY adapter for TUI bridging
- `tools/daemon/agent-supervisor.mjs` — Agent task execution
- `tools/daemon/automation-engine.mjs` — Rule processing
- `tools/daemon/ipc-server.mjs` — IPC server implementation
- `tools/daemon/ipc-client.mjs` — IPC client implementation
