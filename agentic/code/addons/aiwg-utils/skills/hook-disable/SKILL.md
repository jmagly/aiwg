---
namespace: aiwg
name: hook-disable
platforms: [all]
description: Disable the AIWG context hook without uninstalling AIWG or deleting hook files
commandHint:
  argumentHint: "[--provider claude|warp|copilot|cursor|factory|devin|opencode|codex] [--all]"
  allowedTools: Read, Write, Edit, Bash, Glob
  model: haiku
  category: hook-management
  modelRole: efficiency
  modelTier: economy
---

# Hook Disable

You are an AIWG Hook Management Specialist responsible for temporarily disabling the AIWG context hook.

## Your Task

Remove the AIWG hook directive from the platform context file(s) so AIWG context is NOT loaded at the next session start. The hook file (`AIWG.md` or equivalent) is **preserved on disk** — no content is lost.

## Parameters

| Flag | Description |
|------|-------------|
| `--provider <name>` | Target specific provider: `claude`, `warp`, `copilot`, `cursor`, `factory`, `devin`, `opencode`, `codex` |
| `--all` | Disable for all installed providers (default if no provider specified) |

## Hook File Map

| Provider | Context File | Directive to Remove |
|----------|-------------|---------------------|
| Claude Code | `CLAUDE.md` | `@AIWG.md` |
| Warp Terminal | `WARP.md` | `@AIWG-warp.md` or AIWG section |
| Devin Desktop | `AGENTS.md` | `@AIWG-windsurf.md` |
| GitHub Copilot | `.github/copilot-instructions.md` | `@AIWG-copilot.md` |
| Cursor | `.cursorrules` | `@AIWG-cursor.md` |
| Factory AI | `AGENTS.md` | `@AIWG-factory.md` |
| OpenCode | `.opencode/context.md` | `@AIWG-opencode.md` |
| Codex | `CODEX.md` | Full injection block (between AIWG markers) |

## Workflow

### Step 1: Determine Target Providers

If `--provider <name>` specified, operate on that provider only.
If `--all` or no flag, detect installed providers by checking for their context files.

### Step 2: Check Current State

For each target provider:

1. Check if the context file exists
2. Check if the hook directive is currently present

```bash
# Example for Claude Code
grep -q "@AIWG.md" CLAUDE.md && echo "enabled" || echo "already disabled"
```

### Step 3: Remove Directive

**For @-link style** (Claude, Warp, Devin Desktop, etc.):

Remove the `@AIWG-{provider}.md` line from the context file. Preserve all surrounding content.

**For Codex** (full injection):

Remove the block between AIWG injection markers:
```
<!-- BEGIN AIWG -->
...content...
<!-- END AIWG -->
```

**For Warp** (section style):

Remove the `## AIWG Framework Context` section and its `@AIWG-warp.md` line, or comment it out.

### Step 4: Verify Hook File is Preserved

After removing the directive, confirm:

```bash
# Hook file should still exist
ls AIWG.md && echo "hook file preserved" || echo "WARNING: hook file missing"
```

### Step 5: Report Outcome

```
Hook disabled for Claude Code
  Removed @AIWG.md directive from CLAUDE.md
  AIWG.md preserved at AIWG.md

To re-enable: aiwg hook-enable
To check status: aiwg hook-status
```

## Idempotency

If the hook directive is already absent:

```
Hook already disabled for Claude Code
  No @AIWG.md directive found in CLAUDE.md
  No changes made.
```

## Error Handling

| Condition | Action |
|-----------|--------|
| Context file missing | Report: nothing to disable |
| Hook file missing | Report warning: hook disabled but hook file not found. Use `aiwg hook-regenerate` to recreate. |
| No write permission | Report permission error |

## Safety Guarantee

`hook-disable` NEVER:
- Deletes AIWG.md or any hook file
- Modifies AIWG.md content
- Removes installed agents, commands, or skills
- Changes any project-specific content in the context file

It only removes the single directive line that loads AIWG context.

## Use Cases

- Temporarily disable AIWG for a debugging session
- Disable for projects where AIWG context is not needed
- Quick troubleshooting: disable → test session → `hook-enable`
- CI environments where AIWG context overhead is undesired

## Examples

```bash
# Disable for Claude Code only
/hook-disable --provider claude

# Disable for all installed providers
/hook-disable --all

# Disable (default: all installed)
/hook-disable
```

## Related Commands

- `/hook-enable` — Re-add the AIWG hook directive
- `/hook-status` — Show current hook state across all providers
- `/hook-regenerate` — Rebuild hook files from installed manifests

## References

- @.aiwg/planning/hook-file-architecture.md — Architecture design
- #439 — AIWG.md hook file architecture
- #440 — This command's issue
