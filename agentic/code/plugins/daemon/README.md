# Daemon Session

Persistent daemon session capabilities: Concierge front-end, session memory, and interaction rules.

## Overview

The daemon addon packages the interaction layer for the AIWG persistent daemon. It provides a hotel-concierge-style front-end that greets users contextually, routes requests silently to the right agent or skill, composes responses with consistent professional warmth, and maintains session memory across interactions.

```
User input
    |
[ Concierge ] -- intake: classify intent, load memory
    |
[ Router ] --> skill / agent / flow
    |
[ Concierge ] -- output: reframe, apply tone, compose
    |
User output
```

## Installation

```bash
aiwg use daemon
```

## Components

| Component | Type | Description |
|-----------|------|-------------|
| `concierge` | Behavior | Session-scoped front-end with greeting, routing, translation, and composition |
| `concierge` | Agent | Agent definition for routing and response composition |
| `daemon-status` | Skill | Show daemon health, active sessions, and task queue |
| `daemon-interaction` | Rule | Tone, discretion, and error handling enforcement |

## Provider Support

| Provider | Level | Notes |
|----------|-------|-------|
| Claude Code | Full | Behavior emulated via pre/post hooks |
| OpenClaw | Full (native) | Native behavior activation |
| Warp | Full | Session wrapper in WARP.md |
| Copilot, Cursor, Windsurf, OpenCode, Factory, Codex | Partial | Agent + rules; per-interaction activation |

## Quick Start

```bash
# Install
aiwg use daemon

# Start the daemon
aiwg daemon start

# The concierge activates automatically on session start
```

## Configuration

```yaml
# .aiwg/config.yaml
daemon:
  concierge:
    enabled: true
    tone: professional-warm
    verbosity: concise
```

## Documentation

See [Daemon Addon Guide](docs/daemon-addon-guide.md) for full details.

## Dependencies

- **Required**: `aiwg-utils`
- **Optional**: `voice-framework` (enhanced tone profiles), `ralph` (iterative task execution)

## Related

- [Daemon Guide](https://github.com/jmagly/aiwg/blob/main/docs/daemon-guide.md) — Daemon architecture and operations
- Issue #605 — Tracking issue
- Issue #602 — Concierge specification
- Issue #603 — BEHAVIOR.md format specification
