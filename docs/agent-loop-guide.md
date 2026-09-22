# Agent Loop Guide

Iterative AI task execution with automatic recovery - **iteration beats perfection**.

## Overview

Al transforms single-pass AI execution into iterative completion loops. Instead of hoping a task succeeds on the first try, Al keeps iterating until verifiable completion criteria are met.

```
┌──────────────────────────────────────────┐
│            AGENT LOOP                    │
│                                          │
│   Execute → Verify → Learn → Iterate     │
│      ↑                          │        │
│      └──────────────────────────┘        │
│                                          │
│   Until: criteria met OR limits reached  │
└──────────────────────────────────────────┘
```

## Three Modes

| Mode | Command | Best For | Session Duration |
|------|---------|----------|------------------|
| **Internal** | `/ralph` | Tasks that fit in one session | Minutes to ~1 hour |
| **External** | `/ralph-external` | Long-running tasks (6-8 hours) | Multiple sessions |
| **Daemon** | `aiwg daemon start` | Always-on supervision | Continuous (days/weeks) |

## Quick Start

### Internal Al (Single Session)

```bash
# Fix all failing tests
/ralph "Fix all failing tests" --completion "npm test passes"

# TypeScript migration
/ralph "Convert src/ to TypeScript" --completion "npx tsc --noEmit passes" --max-iterations 20

# Coverage target
/ralph "Add tests until 80% coverage" --completion "npm run coverage shows >= 80%"
```

### External Al (Multi-Session)

```bash
# Long-running migration with crash recovery
/ralph-external "Migrate codebase to TypeScript" \
  --completion "npx tsc --noEmit exits 0" \
  --max-iterations 20 \
  --budget 5.0

# With Codex provider instead of Claude
/ralph-external "Implement auth feature" \
  --completion "npm test -- --testPathPattern=auth passes" \
  --provider codex

# With enhanced memory and cross-task learning
/ralph-external "Fix all failing tests" \
  --completion "npm test passes" \
  --memory complex \
  --cross-task
```

## Commands Reference

### Internal Al

| Command | Description |
|---------|-------------|
| `/ralph` | Start iterative task loop |
| `/ralph-status` | Check current loop status |
| `/ralph-abort` | Abort running loop |
| `/ralph-resume` | Resume interrupted loop |

### External Al

| Command | Description |
|---------|-------------|
| `/ralph-external` | Start external supervisor loop |
| `/ralph-external-status` | Check external loop status |
| `/ralph-external-abort` | Abort external loop and cleanup |

## Natural Language Triggers

Al also responds to natural language:

- "ralph this: [task]"
- "keep trying until [condition]"
- "loop until [criteria]"
- "iterate on [task] until [done]"
- "run crash-resilient loop to..." (external)

## Writing Completion Criteria

**Good** (objectively verifiable):

```
"npm test passes"
"npx tsc --noEmit exits with code 0"
"npm run lint passes"
"coverage report shows >= 80%"
```

**Poor** (subjective):

```
"code is good"
"feature is complete"
```

The criteria must be a command that returns a clear pass/fail status.

## When to Use Al

Al is a power tool. Used correctly, it delivers overnight. Used incorrectly, it burns tokens producing junk.

| Situation | Use Al? | Instead |
|-----------|------------|---------|
| Greenfield with no docs | NO | Use AIWG intake/flows first |
| Vague requirements | NO | Write use cases first |
| Clear spec, need implementation | YES | - |
| Tests failing, need fixes | YES | - |
| Migration with clear rules | YES | - |

**Key insight**: Al excels at HOW to build, but thrashes on WHAT to build. Define your requirements first, then let Al implement.

## Internal vs External

### Use Internal (`/ralph`) When:

- Task fits within a single session
- Context corruption isn't a concern
- Fast iteration cycles needed
- Simple verification criteria

### Use External (`/ralph-external`) When:

- Task may take 6-8 hours
- Need crash recovery
- Context corruption is a risk
- Progress tracking across sessions is important
- Running overnight or unattended

## External Al Features

External Al provides additional capabilities:

| Feature | Description |
|---------|-------------|
| **Multi-Provider Support** | Target Claude or Codex via `--provider` |
| **Pre/Post Snapshots** | Captures git status, .aiwg state before/after each session |
| **Session Transcript** | Full CLI transcript capture |
| **Two-Phase Assessment** | Orient (understand) → Generate (continue) |
| **Crash Recovery** | Resume from last checkpoint on failure |
| **Research-Backed Options** | Memory capacity, cross-task learning, best output selection, early stopping |
| **Provider Adapter** | Capability-based degradation across providers |

### Configuration Options

```bash
/ralph-external "<task>" --completion "<criteria>" [options]

Core Options:
  --max-iterations <n>         Max external iterations (default: 5)
  --model <name>               Model to use (default: opus)
  --budget <usd>               Budget per iteration in USD (default: 2.0)
  --timeout <min>              Timeout per iteration in minutes (default: 60)
  --mcp-config <json>          MCP server configuration JSON
  --gitea-issue                Create/link Gitea issue for tracking
  --provider <name>            CLI provider: claude (default), codex

Research-Backed Options (REF-015, REF-021):
  -m, --memory <n|preset>      Memory capacity Ω: 1-10 or preset name
                               Presets: simple(1), moderate(3), complex(5), maximum(10)
                               Default: 3 (moderate)
  --cross-task                 Enable cross-task learning (default: true)
  --no-cross-task              Disable cross-task learning
  --no-analytics               Disable iteration analytics
  --no-best-output             Disable best output selection (use final)
  --no-early-stopping          Disable early stopping on high confidence

Commands:
  -r, --resume                 Resume interrupted loop
  -s, --status                 Show current loop status
  --abort                      Abort current loop
```

### Multi-Provider Support

Agent loops can target different CLI providers via `--provider`. Each provider maps AIWG model names to provider-specific models:

| AIWG Model | Claude | Codex |
|------------|--------|-------|
| `opus` | claude-opus-5 | gpt-5.6-sol |
| `sonnet` | claude-sonnet-5 | gpt-5.6-terra |
| `haiku` | claude-haiku-4-5 | gpt-5.6-luna |

```bash
# Run with Codex instead of Claude
/ralph-external "Migrate to TypeScript" \
  --completion "npx tsc --noEmit exits 0" \
  --provider codex \
  --budget 3.0

# Default (Claude)
/ralph-external "Fix tests" --completion "npm test passes"
```

The provider adapter handles capability differences automatically. If the target provider lacks a capability (e.g., MCP support), Al degrades gracefully and logs a warning.

## State & Artifacts

### Internal Al

```
.aiwg/ralph/
├── current-loop.json       # Loop state (for resume)
├── iterations/             # Iteration history
│   ├── iteration-1.md
│   └── ...
└── completion-*.md         # Final reports
```

### External Al

```
.aiwg/ralph-external/
├── session-state.json      # Active loop state
├── iterations/
│   └── 001/
│       ├── prompt.md           # Prompt used
│       ├── stdout.log          # Captured stdout
│       ├── stderr.log          # Captured stderr
│       ├── pre-snapshot.json   # State before session
│       ├── post-snapshot.json  # State after session
│       ├── analysis.json       # Output analysis
│       └── checkpoints/        # Periodic checkpoints
└── completion-report.md    # Final summary
```

## Persistent Al via Daemon

The daemon mode extends Al into always-on project supervision. Instead of manually launching agent loops, the daemon can trigger them automatically based on file changes, schedules, or messaging commands.

### When to Use Daemon Mode

| Scenario | Use This Mode |
|----------|---------------|
| One-off task, quick fix | Internal (`/ralph`) |
| Multi-hour migration, overnight task | External (`/ralph-external`) |
| Continuous monitoring, auto-triggered tasks | Daemon (`aiwg daemon start`) |

### How It Works

The daemon watches your project and can submit tasks to the Agent Supervisor, which spawns `claude -p` subprocesses — the same mechanism Al uses internally.

```bash
# Start the daemon
aiwg daemon start

# Submit a task via IPC
aiwg daemon task submit "Fix all failing tests"

# Or trigger automatically via automation rules in .aiwg/daemon.json:
{
  "rules": [{
    "id": "auto-fix-tests",
    "trigger": { "event": "file.changed", "pattern": "src/**/*.ts" },
    "condition": { "check": "npm test", "expect": "failure" },
    "action": { "type": "agent", "prompt": "Fix the failing tests" }
  }]
}
```

### Daemon + Messaging

When messaging adapters are enabled (Slack, Discord, Telegram), you can interact with Ralph-like workflows from chat:

```
/ask What tests are currently failing?
/status
/approve gate-123
```

The `/ask` command spawns a `claude -p` process with full project context, just like Al does.

### Setup

See the [Daemon Guide](daemon-guide.md) for full setup instructions and the [Messaging Guide](messaging-guide.md) for platform integration.

## Best Practices

1. **Be specific** - "Fix auth tests" > "Fix tests"
2. **Use verifiable criteria** - Commands with exit codes work best
3. **Set reasonable limits** - 10-20 iterations for most tasks
4. **Enable auto-commit** - Track progress via git history
5. **Define requirements first** - Al implements, doesn't design
6. **Use external for long tasks** - Crash recovery is worth the overhead

## Philosophy

> "Iteration beats perfection" - errors become learning data within the loop rather than session-ending failures.

Al inverts traditional AI optimization from "unpredictable success" to "predictable failure with automatic recovery."

## Examples

See the addon documentation for detailed walkthroughs:

- [Test Fixes](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/ralph/docs/examples/test-fix-loop.md)
- [Migrations](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/ralph/docs/examples/migration.md)
- [Coverage](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/ralph/docs/examples/coverage.md)
- [When to Use Al](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/ralph/docs/when-to-use-ralph.md)
- [Best Practices](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/ralph/docs/best-practices.md)

## Technical Details

For implementation details:

- [Internal Al Addon](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/ralph/README.md)
- [External Al Tools](https://github.com/jmagly/aiwg/blob/main/tools/ralph-external/README.md)

## Credits

Based on the [iterative agent loop methodology](https://dev.to/ibrahimpima/the-ralf-wiggum-breakdown-3mko).
