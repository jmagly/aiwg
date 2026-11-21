---
namespace: aiwg
name: soul-disable
platforms: [all]
description: Disable soul enforcement without deleting SOUL.md or soul files
commandHint:
  argumentHint: "[--provider claude|warp|copilot|cursor|factory|devin|opencode|codex] [--all]"
  allowedTools: Read, Write, Edit, Bash, Glob
  model: haiku
  category: soul-management
  modelRole: efficiency
  modelTier: economy
---

# Soul Disable

You are a Soul Management Specialist responsible for disabling SOUL.md enforcement.

## Your Task

Remove the soul directive from platform context file(s) and remove the enforcement rule so SOUL.md is NOT loaded at the next session start. The SOUL.md file itself is **preserved on disk** — no content is lost.

## Parameters

| Flag | Description |
|------|-------------|
| `--provider <name>` | Target specific provider: `claude`, `warp`, `copilot`, `cursor`, `factory`, `devin`, `opencode`, `codex` |
| `--all` | Disable for all installed providers (default if no provider specified) |

## Workflow

### Step 1: Determine Target Providers

If `--provider <name>` specified, operate on that provider only.
If `--all` or no flag, detect installed providers by checking for their context files.

### Step 2: Check Current State

For each target provider:

1. Check if the context file exists
2. Check if the `@SOUL.md` directive is currently present

```bash
# Example for Claude Code
grep -q "@SOUL.md" CLAUDE.md && echo "enabled" || echo "already disabled"
```

### Step 3: Remove Directive

**For @-link style** (Claude, Warp, Devin Desktop, Copilot, Cursor, Factory, OpenCode):

Remove the `@SOUL.md` line from the context file. Preserve all surrounding content.

**For Codex** (inline injection):

Remove the block between soul injection markers:

```
<!-- BEGIN SOUL -->
...content...
<!-- END SOUL -->
```

### Step 4: Remove Enforcement Rule

```bash
# Remove the enforcement rule
rm -f .claude/rules/soul-enforcement.md
```

### Step 5: Revert Agent Soul Wiring (if present)

Check if any agent definitions have soul identity sections added by `soul-enable --agents`. If found, remove them:

```bash
# Check for soul-wired agents
grep -rl "See @.*\.soul\.md" .claude/agents/ 2>/dev/null
```

Remove the `## Identity` section that references the soul file from each wired agent.

### Step 6: Verify SOUL.md is Preserved

After removing directives and rule, confirm the soul file still exists:

```bash
ls SOUL.md .aiwg/SOUL.md 2>/dev/null && echo "soul file preserved" || echo "no soul file found"
```

### Step 7: Report Outcome

```
Soul enforcement disabled

Changes made:
  ~ CLAUDE.md (@SOUL.md directive removed)
  - .claude/rules/soul-enforcement.md (removed)

SOUL.md preserved at ./SOUL.md
Agent soul wiring preserved (agent definitions unchanged)

To re-enable: /soul-enable
To check status: /soul-status
```

## Idempotency

If soul enforcement is already disabled:

```
Soul already disabled for Claude Code
  No @SOUL.md directive found in CLAUDE.md
  No enforcement rule found
  No changes made.
```

## Safety Guarantee

`soul-disable` NEVER:
- Deletes SOUL.md or any `.soul.md` file
- Modifies SOUL.md content
- Removes installed agents, commands, or skills
- Changes any project-specific content beyond the soul directive

It only removes the directive line that loads soul context and the enforcement rule.

## Error Handling

| Condition | Action |
|-----------|--------|
| Context file missing | Report: nothing to disable |
| SOUL.md missing | Report warning: soul disabled but SOUL.md not found on disk |
| No write permission | Report permission error |
| Enforcement rule missing | Skip removal, note already absent |

## Use Cases

- Disable soul for utility/automation sessions where persona is unnecessary
- Quick troubleshooting: disable soul to test without persona influence
- CI environments where soul context overhead is undesired
- Projects where soul was enabled experimentally and needs to be turned off

## Examples

```bash
# Disable for all installed providers
/soul-disable

# Disable for Claude Code only
/soul-disable --provider claude

# Disable for Warp
/soul-disable --provider warp
```

## Related Commands

- `/soul-enable` — Enable soul enforcement
- `/soul-status` — Show current soul state
- `/hook-disable` — Reference implementation (same directive-removal mechanism)

## References

- #437 — SOUL.md compatibility overview
- #438 — Soul enforcement commands (this command)
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/commands/hook-disable.md — Reference pattern
