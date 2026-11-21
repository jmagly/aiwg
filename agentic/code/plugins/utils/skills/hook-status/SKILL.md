---
namespace: aiwg
name: hook-status
platforms: [all]
description: Show AIWG hook state across all installed providers
commandHint:
  argumentHint: "[--provider <name>] [--verbose]"
  allowedTools: Read, Bash, Glob
  model: haiku
  category: hook-management
  modelRole: efficiency
  modelTier: economy
---

# Hook Status

You are an AIWG Hook Management Specialist responsible for reporting the current state of AIWG context hooks across all installed providers.

## Your Task

Inspect all known platform context files and report whether the AIWG hook is enabled, disabled, or missing for each.

## Parameters

| Flag | Description |
|------|-------------|
| `--provider <name>` | Check only a specific provider |
| `--verbose` | Show hook file size and content summary |

## Detection Logic

For each provider, check:

1. **Context file exists?** — If no, provider not installed (skip)
2. **Hook directive present?** — If yes, `enabled`; if no, `disabled`
3. **Hook file exists?** — If no, `enabled (hook file missing)` — warn

### Directive Patterns to Search

| Provider | Context File | Pattern |
|----------|-------------|---------|
| Claude Code | `CLAUDE.md` | `@AIWG.md` |
| Warp Terminal | `WARP.md` | `@AIWG-warp.md` or `## AIWG` section |
| Devin Desktop | `AGENTS.md` | `@AIWG-windsurf.md` |
| GitHub Copilot | `.github/copilot-instructions.md` | `@AIWG-copilot.md` |
| Cursor | `.cursorrules` | `@AIWG-cursor.md` |
| Factory AI | `AGENTS.md` | `@AIWG-factory.md` |
| OpenCode | `.opencode/context.md` | `@AIWG-opencode.md` |
| Codex | `CODEX.md` | `<!-- BEGIN AIWG -->` |

## Output Format

```
AIWG Hook Status
────────────────────────────────────────

  claude     ✓ enabled    (@AIWG.md in CLAUDE.md, 312 lines)
  warp       ✓ enabled    (@AIWG-warp.md in WARP.md)
  copilot    ✗ disabled   (AIWG-copilot.md exists but no directive)
  devin   - not found  (AGENTS.md not present)
  cursor     - not found  (.cursorrules not present)
  factory    ✗ disabled   (AIWG-factory.md missing — run: aiwg hook-regenerate --provider factory)
  opencode   - not found  (.opencode/context.md not present)
  codex      - not found  (CODEX.md not present)

Summary: 2 enabled, 2 disabled, 4 not found

Tip: Run `aiwg hook-enable` to enable all disabled hooks.
```

## Status Key

| Symbol | Meaning |
|--------|---------|
| `✓ enabled` | Hook directive present in context file and hook file exists |
| `✗ disabled` | Context file present but hook directive absent |
| `⚠ enabled (hook file missing)` | Directive present but hook file doesn't exist on disk |
| `- not found` | Context file not present (provider not installed/configured) |

## Verbose Output

With `--verbose`, include hook file details:

```
  claude   ✓ enabled
    Context file:  CLAUDE.md (14 lines)
    Hook file:     AIWG.md (312 lines, 14.2KB)
    Generated:     2026-03-22 (from: sdlc-complete, aiwg-utils)
    Frameworks:    sdlc-complete v2.1.0, aiwg-utils v1.5.0
```

## Workflow

1. For each provider returned by the authoritative provider registry, check context file existence
2. If context file exists, grep for hook directive
3. If directive found, check hook file existence
4. Format output with status symbols
5. Print summary line with counts
6. Print actionable tip if any hooks are disabled or missing

## Examples

```bash
# Check all providers
/hook-status

# Check only Claude Code
/hook-status --provider claude

# Verbose with hook file details
/hook-status --verbose
```

## Related Commands

- `/hook-enable` — Enable AIWG hook
- `/hook-disable` — Disable AIWG hook
- `/hook-regenerate` — Rebuild hook files from installed manifests

## References

- #439 — AIWG.md hook file architecture
- #440 — hook-enable/hook-disable (this command is part of that issue)
