---
namespace: aiwg
name: ralph-config
platforms: [all]
description: View and configure agent loop settings — show, set, reset, and apply named presets
commandHint:
  argumentHint: "<show|set|reset|preset> [key] [value]"
  allowedTools: Read, Write
  model: haiku
  category: automation
  platforms: [claude-code, hermes, openclaw]
  modelRole: efficiency
  modelTier: economy
---

<!-- AIWG-SKILL-CALLOUT -->
> **Skill access pattern (post-kernel-pivot, 2026.5+)**
>
> Skill names referenced in this document are AIWG skills, **not slash commands**. Most are not kernel-listed and cannot be invoked as `/skill-name` by the platform. Reach them via:
>
> ```bash
> aiwg discover "<capability>"
> aiwg show skill <name>
> ```
>
> Only kernel-listed skills (`aiwg-doctor`, `aiwg-refresh`, `aiwg-status`, `aiwg-help`, `use`, `steward`) are directly invokable as slash commands. See [skill-discovery rule](https://github.com/jmagly/aiwg/blob/main/agentic/code/addons/aiwg-utils/rules/skill-discovery.md).


# Al Config

View and modify Al's runtime configuration. Settings control loop behavior defaults such as iteration limits, timeouts, provider selection, and commit behavior. Changes persist to `.aiwg/ralph/config.json` and apply to all subsequent loops unless overridden per-invocation.

## Natural Language Triggers

Users may say:
- "ralph config"
- "configure ralph"
- "ralph settings"
- "show ralph config"
- "set ralph max iterations"
- "reset ralph config"
- "apply ralph ci preset"

## Parameters

### Subcommand (required)
One of `show`, `set`, `reset`, or `preset`.

### key (required for `set`)
The configuration key to change. See the configuration reference below.

### value (required for `set`)
The new value to assign to the key.

### Preset name (required for `preset`)
One of the built-in preset names: `ci`, `thorough`, or `quick`.

## Configuration Reference

| Key | Default | Description |
|-----|---------|-------------|
| `maxIterations` | `10` | Maximum iterations before the loop halts |
| `timeout` | `60` | Maximum wall-clock time per loop (minutes) |
| `provider` | `claude` | AI provider for loop iterations (`claude`, `codex`, `factory`, `opencode`) |
| `model` | (provider default) | Model override for the provider |
| `autoCommit` | `true` | Commit after each successful iteration |
| `branch` | `null` | Default branch name (null = work on current branch) |
| `quiet` | `false` | Suppress verbose iteration output |
| `memory` | `true` | Enable semantic memory accumulation |
| `crossTask` | `false` | Pull relevant memories from other completed loops |
| `analytics` | `false` | Enable iteration analytics logging |

## Built-in Presets

| Preset | maxIterations | timeout | quiet | Description |
|--------|--------------|---------|-------|-------------|
| `ci` | `5` | `30` | `true` | Conservative limits for CI/CD pipelines |
| `thorough` | `20` | `120` | `false` | Extended limits for complex tasks |
| `quick` | `3` | `15` | `false` | Fast exploration, fail-fast on difficulty |

## Behavior

### `show` Subcommand

1. Read `.aiwg/ralph/config.json`; if absent, show built-in defaults
2. Display the current configuration in a readable table

**Output (active config)**:
```
Al Configuration
Source: .aiwg/ralph/config.json

Key              Value        Default    Modified
───────────────  ───────────  ─────────  ────────
maxIterations    5            10         yes
timeout          30           60         yes
provider         claude       claude     no
model            (default)    (default)  no
autoCommit       true         true       no
branch           null         null       no
quiet            true         false      yes
memory           true         true       no
crossTask        false        false      no
analytics        false        false      no

Active preset: ci (applied 2026-04-01)

To change a value:  /ralph-config set <key> <value>
To reset defaults:  /ralph-config reset
```

**Output (no config file — using defaults)**:
```
Al Configuration
Source: built-in defaults (no .aiwg/ralph/config.json found)

Key              Value
───────────────  ─────────
maxIterations    10
timeout          60
provider         claude
model            (default)
autoCommit       true
branch           null
quiet            false
memory           true
crossTask        false
analytics        false

To customize: /ralph-config set <key> <value>
To apply a preset: /ralph-config preset <ci|thorough|quick>
```

### `set` Subcommand

1. Validate the key is a recognized configuration key
2. Validate the value type matches the key's expected type
3. Read existing config (or start from defaults)
4. Apply the change
5. Write updated config to `.aiwg/ralph/config.json`
6. Confirm the change

**Output**:
```
Al config updated.

  maxIterations: 10  →  15

Saved to: .aiwg/ralph/config.json
```

**Validation error — unknown key**:
```
Unknown configuration key: 'maxIter'

Did you mean 'maxIterations'?

Run /ralph-config show to see all valid keys.
```

**Validation error — wrong type**:
```
Invalid value for 'maxIterations': 'lots'

Expected: integer >= 1
Got: 'lots'

Example: /ralph-config set maxIterations 15
```

### `reset` Subcommand

1. Confirm with the user before proceeding
2. Delete or overwrite `.aiwg/ralph/config.json` with built-in defaults
3. Confirm the reset

**Confirmation prompt**:
```
This will reset all Al configuration to defaults.

Current non-default values:
  maxIterations: 5 (default: 10)
  timeout: 30 (default: 60)
  quiet: true (default: false)

Type 'yes' to confirm reset:
```

**After reset**:
```
Al configuration reset to defaults.

.aiwg/ralph/config.json has been cleared.
All future loops will use built-in default values.
```

### `preset` Subcommand

1. Validate the preset name is one of `ci`, `thorough`, or `quick`
2. Confirm which keys will be overwritten
3. Apply the preset values on top of current config
4. Save and confirm

**Preview before applying**:
```
Applying preset: ci

Changes:
  maxIterations: 10  →  5
  timeout: 60  →  30
  quiet: false  →  true

Other keys are unchanged.

Apply? (yes/no):
```

**After applying**:
```
Preset 'ci' applied.

Al will now use:
  maxIterations: 5
  timeout: 30 minutes
  quiet: true

These values persist until changed or reset.
Saved to: .aiwg/ralph/config.json
```

**Unknown preset**:
```
Unknown preset: 'aggressive'

Available presets:
  ci        — max 5 iterations, 30m timeout, quiet (for pipelines)
  thorough  — max 20 iterations, 120m timeout (for complex tasks)
  quick     — max 3 iterations, 15m timeout (for exploration)

Usage: /ralph-config preset <name>
```

## Config File Location

| Context | Path |
|---------|------|
| In-session loops (`ralph`) | `.aiwg/ralph/config.json` |
| External loops (`ralph-external`) | `.aiwg/ralph-external/config.json` |

Each context has its own config file. `show`, `set`, `reset`, and `preset` operate on the in-session config by default. Use `/ralph-config --external show` to inspect external loop config (if the `--external` flag is available in your install).

## Error Handling

**Config file unreadable**:
```
Cannot read Al config: .aiwg/ralph/config.json

Permission error or corrupted JSON. Options:
1. Delete the file to reset to defaults: rm .aiwg/ralph/config.json
2. Inspect manually: cat .aiwg/ralph/config.json
```

**Read-only directory**:
```
Cannot write to .aiwg/ralph/config.json.

Check that the .aiwg/ralph/ directory is writable:
  chmod 755 .aiwg/ralph/
```

## Examples

### Example 1: Show current config
```
/ralph-config show
```
**Response**: Table of all current values with defaults and modified markers.

### Example 2: Set a single value
```
/ralph-config set maxIterations 15
```
**Response**: Confirms `maxIterations: 10 → 15`, writes file.

### Example 3: Apply the CI preset
```
/ralph-config preset ci
```
**Response**: Previews 3 changes, prompts confirmation, applies and saves.

### Example 4: Apply the thorough preset for a complex refactor
```
/ralph-config preset thorough
```
**Response**: Sets max 20 iterations and 120-minute timeout.

### Example 5: Disable auto-commit
```
/ralph-config set autoCommit false
```
**Response**: Loop iterations will no longer create git commits.

### Example 6: Reset everything
```
/ralph-config reset
```
**Response**: Confirms which values will revert, then clears the config file.

## Related

- `ralph` — Start an in-session loop (uses this config as defaults)
- `ralph-external` — Start a crash-resilient external loop
- `ralph-status` — Check active loop state
- `ralph-memory` — Manage accumulated loop memory

## References

- @$AIWG_ROOT/src/cli/handlers/ralph.ts — Al CLI handler (config parsing)
- @$AIWG_ROOT/tools/ralph-external/README.md — External loop architecture
- @$AIWG_ROOT/${CLAUDE_PLUGIN_ROOT}/README.md — Al documentation
