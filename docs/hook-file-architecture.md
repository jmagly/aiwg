# Hook File Architecture

**Issue:** #439
**Version:** 2026.2.0
**Status:** Active

## Overview

AIWG loads its framework context into each platform via a dedicated hook file (`AIWG.md` and provider equivalents) rather than by injecting content directly into your project's context file. This keeps platform context files (`CLAUDE.md`, `WARP.md`, etc.) clean and under developer control while still making AIWG context available at session start.

## The Problem it Solves

Before this architecture, `aiwg use sdlc` injected 400–500 lines of framework context directly into `CLAUDE.md`. This created several problems:

- Merging updates required diff surgery across a large injected block
- The project's own notes were buried after hundreds of lines of AIWG content
- Disabling AIWG temporarily meant removing content manually (and re-adding it later)
- CI environments had no clean way to skip AIWG context overhead

The hook file architecture solves all of these by separating concerns: your context file contains only your project notes plus one directive line, and AIWG context lives in a separate, regenerable file.

## How It Works

Current AIWG context generation has three layers:

```
.aiwg/AIWG.md      ← Normalized project-local AIWG context and stable skill/rule reference
WORKSPACE.md       ← Canonical provider-neutral project/operator context
AIWG.md            ← Generated cross-provider companion, finalized from workspace state
CLAUDE.md/AGENTS.md← Minimal provider adapters, read WORKSPACE.md then AIWG.md
WARP.md/.hermes.md/.github/copilot-instructions.md
                   ← Provider-facing twins when that provider needs a distinct context file
```

`CLAUDE.md` contains a single line that loads AIWG context:

```markdown
# My Project Notes

...your notes here...

@AIWG.md
```

`.aiwg/AIWG.md` is created by `aiwg init` and refreshed by `aiwg use` / `aiwg regenerate`. Root `AIWG.md` is generated from provider context plus a context-finalization pass that reads `.aiwg/aiwg.config`, records installed frameworks/addons and provider deployments, and inlines the discover-first protocol (`aiwg discover` then `aiwg show`). It is safe to delete generated bridge files; regeneration recreates them.

`aiwg regenerate` has three explicit branches. `--workspace` (the default)
refreshes `WORKSPACE.md`, `AIWG.md`, and provider adapters without inferring
project facts. `--existing-project` previews or transactionally applies a
bounded, source-attributed project snapshot and provider-context migration.
`--full-inject` (alias `--legacy`) embeds normalized AIWG context between legacy
markers for compatibility and does not create `WORKSPACE.md`. The deployed
selector links to a separate skill for each branch.

## Hook File Map

Each platform has a context file you own and a generated hook file managed by AIWG:

| Provider | Your Context File | AIWG Hook File | Directive Style |
|----------|------------------|----------------|-----------------|
| Claude Code | `CLAUDE.md` | `AIWG.md` | `@AIWG.md` |
| Warp Terminal | `WARP.md` | `AIWG-warp.md` | `@AIWG-warp.md` |
| Devin Desktop | `AGENTS.md` | `AIWG-windsurf.md` | `@AIWG-windsurf.md` |
| GitHub Copilot | `.github/copilot-instructions.md` | `AIWG-copilot.md` | `@AIWG-copilot.md` |
| Cursor | `.cursorrules` | `AIWG-cursor.md` | `@AIWG-cursor.md` |
| Factory AI | `AGENTS.md` | `AIWG-factory.md` | `@AIWG-factory.md` |
| OpenCode | `.opencode/context.md` | `AIWG-opencode.md` | `@AIWG-opencode.md` |
| Codex | `WORKSPACE.md` | `AGENTS.md` + `AIWG.md` | Explicit prose instruction; no native Markdown include claim |

Codex discovers `AGENTS.md` but does not treat a Markdown link as a native include.
The canonical adapter therefore explicitly instructs the agent to read
`WORKSPACE.md` and then `AIWG.md`. Inline markers are emitted only by the opt-in
legacy `aiwg regenerate --full-inject` branch.

## Commands

### hook-status

Shows the current state of AIWG hooks across all installed providers.

```bash
/hook-status
/hook-status --provider claude
/hook-status --verbose
```

Example output:

```
AIWG Hook Status
────────────────────────────────────────

  claude     ✓ enabled    (@AIWG.md in CLAUDE.md, 312 lines)
  warp       ✓ enabled    (@AIWG-warp.md in WARP.md)
  copilot    ✗ disabled   (AIWG-copilot.md exists but no directive)
  devin   - not found  (AGENTS.md not present)

Summary: 2 enabled, 1 disabled, 1 not found

Tip: Run `aiwg hook-enable` to enable all disabled hooks.
```

Status key: `✓ enabled` = directive present and hook file exists; `✗ disabled` = context file present but no directive; `⚠ enabled (hook file missing)` = directive present but hook file deleted; `- not found` = provider not installed.

### hook-enable

Re-adds the AIWG hook directive to one or all provider context files. If the hook file does not exist on disk, it is regenerated automatically before the directive is added.

```bash
/hook-enable                        # All installed providers (default)
/hook-enable --provider claude      # Claude Code only
/hook-enable --all                  # Explicit all-providers flag
```

Idempotent — if the directive is already present, no changes are made.

### hook-disable

Removes the AIWG hook directive from one or all provider context files. The hook file itself is preserved on disk — no content is lost.

```bash
/hook-disable                       # All installed providers (default)
/hook-disable --provider claude     # Claude Code only
```

Use cases:
- Temporarily disable AIWG context for a debugging session
- Disable for CI environments where the overhead is not needed
- Troubleshoot: disable → test session → re-enable

`hook-disable` never deletes AIWG.md, modifies installed agents or commands, or changes any project-owned content in the context file. It only removes the single directive line.

### hook-regenerate

Rebuilds AIWG hook files from the manifests of currently installed frameworks. Use this after installing or removing a framework, or after upgrading AIWG.

```bash
/hook-regenerate                    # Regenerate all hook files
/hook-regenerate --provider claude  # Claude Code hook only
/hook-regenerate --dry-run          # Show what would be written
/hook-regenerate --verbose          # Show each fragment included
```

The generated file includes a header identifying which frameworks contributed content:

```markdown
# AIWG Framework Context
<!-- Generated by aiwg hook-regenerate — do not edit manually -->
<!-- Frameworks: sdlc-complete v2.1.0, aiwg-utils v1.5.0 -->
<!-- Generated: 2026-03-23T00:00:00Z -->
<!-- Regenerate: aiwg hook-regenerate -->
<!-- Disable: aiwg hook-disable -->
```

Content is assembled in priority order from each installed framework's `contextContributions.hookFragment`. Core AIWG CLI reference and the rules index pointer are always included regardless of which frameworks are installed.

### migrate-hook

Migrates existing projects that have AIWG content injected directly into their context file to the hook file architecture. Detects the injected block, extracts it to a hook file, and replaces it with a single directive line. All user-owned content is preserved verbatim.

```bash
/migrate-hook                       # Migrate all detected providers
/migrate-hook --provider claude     # Claude Code only
/migrate-hook --dry-run             # Preview without writing
/migrate-hook --no-backup           # Skip .bak files (CI environments)
/migrate-hook --force               # Skip confirmation prompt
```

Detection is high-confidence when explicit `<!-- BEGIN AIWG -->` markers are present, and heuristic-based (structural heading detection) when they are not. Ambiguous cases require manual marking before migration proceeds.

After migration:
- `CLAUDE.md` shrinks from ~500 lines to ~20 lines (your notes + one directive)
- `AIWG.md` contains the extracted framework content
- `CLAUDE.md.bak` preserves the original (delete once you have verified the result)

Post-migration verification:
```bash
aiwg hook-status          # Should show ✓ enabled
cat CLAUDE.md             # Should show your notes + @AIWG.md
wc -l AIWG.md             # Should show the expected line count
```

## When hook-regenerate Runs Automatically

`aiwg use <framework>` and `aiwg remove <framework>` both call `hook-regenerate` automatically at the end of their operation. You only need to run it manually when:

- You have edited a framework's hook fragment source and want to refresh without a full deployment
- You want to preview the current regenerated output with `--dry-run`
- A hook file was accidentally deleted

## Committing Hook Files

Whether to commit `AIWG.md` and its equivalents depends on your team's preference:

| Approach | Pros | Cons |
|----------|------|------|
| Commit hook files | All team members get consistent AIWG context | File changes on every `aiwg use` operation |
| Gitignore hook files | Context files stay clean | Each team member must run `aiwg hook-regenerate` after pulling |

A common middle ground: commit `AIWG.md` but add it to `.gitignore`'s comment list with a note that it is auto-generated, and include a `make setup` or `npm run setup` target that runs `aiwg hook-regenerate`.

## References

- @.claude/commands/hook-enable.md — Command implementation
- @.claude/commands/hook-disable.md — Command implementation
- @.claude/commands/hook-regenerate.md — Command implementation
- @.claude/commands/migrate-hook.md — Command implementation
- @.claude/commands/hook-status.md — Command implementation
- @docs/hook-patterns.md — PreToolUse and quality gate hook patterns
