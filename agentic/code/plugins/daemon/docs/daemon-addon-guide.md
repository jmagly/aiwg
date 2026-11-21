# Daemon Addon Guide

The daemon addon packages persistent-session capabilities into a single deployable unit. It provides the Concierge front-end, session memory, and interaction rules for the AIWG daemon.

## What's Included

| Component | Type | Description |
|-----------|------|-------------|
| `concierge.behavior.md` | Behavior | Session-scoped front-end that greets, routes, translates, and composes |
| `concierge.md` | Agent | Agent definition for platforms without native behavior support |
| `daemon-status` | Skill | Show daemon health, active sessions, task queue |
| `daemon-interaction.md` | Rule | Tone, discretion, and error handling enforcement |

## Installation

```bash
# Deploy the daemon addon
aiwg use daemon

# Deploy to a specific provider
aiwg use daemon --provider openclaw    # native behavior support
aiwg use daemon --provider claude-code # hook-emulated behaviors

# Verify
aiwg list
```

## Provider Support

| Provider | Support | Behavior Mechanism |
|----------|---------|-------------------|
| Claude Code | Full | Pre/post-tool hooks emulate behavior lifecycle |
| OpenClaw | Full (native) | `~/.openclaw/behaviors/` — native behavior activation |
| Warp | Full | WARP.md behavior section with session wrapper |
| Copilot | Partial | Agent + rules; no persistent session, concierge activates per-interaction |
| Cursor | Partial | Agent + rules; behavior emulated via rules |
| Devin Desktop | Partial | Agent + rules; behavior emulated via rules |
| OpenCode | Partial | Agent + rules |
| Factory | Partial | Agent (droid) + rules |
| Codex | Partial | Agent + rules |

**Full support** means the provider can activate behaviors at session boundaries (start, end, pre-response). **Partial support** deploys the agent and rules but cannot hook into session lifecycle — the concierge activates per-interaction instead of persistently.

## Architecture

```
User input
    |
[ Concierge behavior ] -- session-start hook activates
    |                   -- classifies intent
    |                   -- loads session memory
    |
[ Router ] --> skill / agent / flow
    |
[ Concierge behavior ] -- pre-response hook activates
    |                   -- reframes output
    |                   -- applies tone rules
    |
User output
```

The concierge intercepts at both ends — intake and output — so it can reframe raw technical output into composed, appropriate responses.

## Configuration

Configuration is set in `.aiwg/config.yaml` or per-session:

```yaml
daemon:
  concierge:
    enabled: true
    tone: professional-warm      # or: technical-authority, friendly-explainer
    verbosity: concise           # or: detailed, minimal
    escalation: absorb-by-default  # or: surface-immediately
  session:
    memory: true
    crossSession: true
```

### Tone Options

| Tone | Use Case |
|------|----------|
| `professional-warm` | Default — hotel concierge register |
| `technical-authority` | For teams that prefer direct technical communication |
| `friendly-explainer` | For less technical users or onboarding |

## Relationship to Other Components

### Daemon Infrastructure

The daemon addon provides the **interaction layer** on top of the daemon infrastructure:

- `tools/daemon/daemon-main.mjs` — Process lifecycle (start/stop/status)
- `tools/ralph-external/daemon-supervisor.mjs` — Agent subprocess management
- `src/cli/handlers/daemon.ts` — CLI handler

The addon does not replace these — it adds the concierge experience layer.

### Voice Framework

The concierge uses the voice framework for tone consistency. If the voice-framework addon is installed, the concierge can reference voice profiles directly. Without it, the addon's built-in tone rules are sufficient.

### Agent Loop

The daemon addon works alongside Al for task execution. The concierge routes iterative tasks to agent loops and presents results through its composition layer.

## Dependencies

| Dependency | Required | Purpose |
|-----------|----------|---------|
| `aiwg-utils` | Yes | Core utilities |
| `voice-framework` | No | Enhanced tone/voice profiles |
| `ralph` | No | Iterative task execution |

## Blocked By

This addon's behavior component depends on:

- **#603** — BEHAVIOR.md cross-platform format spec (defines the schema)
- **#602** — Concierge feature specification (defines the behavior content)

The current behavior file is a draft aligned with these issue specifications. It will be updated when those issues are finalized.

## Uninstalling

```bash
aiwg remove daemon
```

This removes all deployed artifacts. Daemon infrastructure (`tools/daemon/`) is unaffected.

## References

- @$AIWG_ROOT/docs/daemon-guide.md — Daemon architecture
- @$AIWG_ROOT/${CLAUDE_PLUGIN_ROOT}/behaviors/concierge.behavior.md — Concierge behavior
- @$AIWG_ROOT/${CLAUDE_PLUGIN_ROOT}/agents/concierge.md — Concierge agent
- @$AIWG_ROOT/${CLAUDE_PLUGIN_ROOT}/skills/daemon-status/SKILL.md — Status skill
- @$AIWG_ROOT/${CLAUDE_PLUGIN_ROOT}/rules/daemon-interaction.md — Interaction rules
- Issue #605 — This addon's tracking issue
- Issue #603 — BEHAVIOR.md spec (blocking)
- Issue #602 — Concierge spec (blocking)
