---
namespace: aiwg
name: config
platforms: [all]
description: Manage the user-level AIWG configuration file for persistent preferences across all projects

---

# Config

You manage the user-level AIWG configuration file. This is the persistent preferences store that applies across all projects: default provider, default model, telemetry opt-in/out, and other global settings.

## Triggers

Alternate expressions and non-obvious activations (primary phrases are matched automatically from the skill description):

- "what's my default provider" → get subcommand for `provider`
- "turn off telemetry" → set subcommand for `telemetry`
- "where is the aiwg config file" → path subcommand
- "reset aiwg to defaults" → reset subcommand
- "open config in my editor" → edit subcommand
- "is my config valid" → validate subcommand

## Trigger Patterns Reference

| Pattern | Example | Action |
|---------|---------|--------|
| List all settings | "show my aiwg config" | Run `aiwg config list` |
| Read a value | "what's my default model?" | Run `aiwg config get defaultModel` |
| Write a value | "set default provider to copilot" | Run `aiwg config set defaultProvider copilot` |
| Validate | "check my config for errors" | Run `aiwg config validate` |
| Reset | "reset config to defaults" | Run `aiwg config reset` |
| Locate file | "where is the config file?" | Run `aiwg config path` |
| Open editor | "edit config" | Run `aiwg config edit` |

## Behavior

When triggered:

1. **Extract intent**:
   - Which subcommand: `list`, `get`, `set`, `validate`, `reset`, `path`, or `edit`?
   - For `get`/`set`: what is the key? For `set`: what is the new value?
   - Is a custom config directory specified via `--config-dir`?

2. **Resolve config directory** (in order):
   1. `AIWG_CONFIG` environment variable
   2. `--config-dir <path>` flag
   3. `~/.aiwg/config.json`
   4. `~/.config/aiwg/config.json`

3. **Run the appropriate command**:

   ```bash
   # Show all configuration values
   aiwg config list

   # Read a specific key
   aiwg config get <key>

   # Write a value
   aiwg config set <key> <value>

   # Validate the config file
   aiwg config validate

   # Reset to factory defaults
   aiwg config reset

   # Show resolved config file path
   aiwg config path

   # Open in $EDITOR
   aiwg config edit

   # Use a custom config directory
   aiwg config list --config-dir /path/to/config
   ```

4. **Common configuration keys**:

   | Key | Type | Description |
   |-----|------|-------------|
   | `defaultProvider` | string | Active provider (e.g., `claude-code`, `copilot`) |
   | `defaultModel` | string | Model override (e.g., `claude-opus-5`) |
   | `telemetry` | boolean | Usage telemetry opt-in |
   | `updateChannel` | string | `stable`, `next`, or `nightly` |
   | `configDir` | string | Custom config directory path |

5. **Report results** — For `list`/`get`, display the value(s). For `set`, confirm what changed. For `validate`, show any errors found. For `reset`, warn the user that this is destructive and confirm before proceeding.

## Examples

### Example 1: Show all settings

**User**: "Show me my AIWG configuration"

**Extraction**: List all settings

**Action**:
```bash
aiwg config list
```

**Response**: Displays all keys and their current values, e.g.:
```
defaultProvider  claude-code
defaultModel     (not set — using platform default)
telemetry        true
updateChannel    stable
```

---

### Example 2: Change default provider

**User**: "Set my default provider to GitHub Copilot"

**Extraction**: Set `defaultProvider` to `copilot`

**Action**:
```bash
aiwg config set defaultProvider copilot
```

**Response**: "Set `defaultProvider` to `copilot`. This will be used as the default for `aiwg use` and `aiwg sync` going forward."

---

### Example 3: Disable telemetry

**User**: "Turn off telemetry"

**Extraction**: Set `telemetry` to `false`

**Action**:
```bash
aiwg config set telemetry false
```

**Response**: "Telemetry disabled. AIWG will no longer send usage data."

---

### Example 4: Locate config file

**User**: "Where does AIWG store its config?"

**Extraction**: Path lookup

**Action**:
```bash
aiwg config path
```

**Response**: "Config file: `~/.aiwg/config.json` (exists)"

---

### Example 5: Validate after manual edit

**User**: "I edited the config manually — check if it's valid"

**Extraction**: Validate request

**Action**:
```bash
aiwg config validate
```

**Response**: "Config valid. No errors found." — or lists specific schema errors if invalid.

---

### Example 6: Custom config directory

**User**: "Check config using the team shared config dir at /opt/aiwg-team"

**Extraction**: List with `--config-dir`

**Action**:
```bash
aiwg config list --config-dir /opt/aiwg-team
```

**Response**: Displays config values loaded from `/opt/aiwg-team/config.json`.

## Clarification Prompts

If the user's intent is ambiguous:

- "Which config key are you asking about? (run `aiwg config list` to see all keys)"
- "What value should I set `<key>` to?"
- "`aiwg config reset` will overwrite all settings with factory defaults. Proceed?"

## References

- @$AIWG_ROOT/src/cli/handlers/subcommands.ts — Config command handler
- @$AIWG_ROOT/docs/cli-reference.md — CLI reference
