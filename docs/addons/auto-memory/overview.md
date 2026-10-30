# auto-memory Overview

The auto-memory addon gives Claude Code projects a useful starting structure for Automatic Memory. Use it when you
want local memory files to begin with places for testing patterns, debugging notes, and architecture decisions instead
of starting empty.

## Common Use Cases

- Start a new Claude Code project with memory sections aligned to AIWG workflows.
- Keep recurring debugging lessons local to the developer machine while sharing stable instructions in `CLAUDE.md`.
- Promote repeated loop failures or learned project patterns into a reviewed memory file.
- Prune memory files when older observations become stale or superseded.

## What Automatic Memory Is

Automatic Memory, when supported by Claude Code, maintains persistent, evolving knowledge about your project in
`~/.claude/projects/<project>/memory/`. Unlike `CLAUDE.md`, which you maintain manually and commit to git, automatic
memory is maintained by Claude Code as it learns project-specific patterns during development.

The distinction between the two:

| Aspect | Automatic Memory | CLAUDE.md |
|--|-----------------|-----------|
| **Location** | `~/.claude/projects/<project>/memory/` | Repository root |
| **Updated by** | Claude Code automatically | Developer manually |
| **Content** | Learned patterns, debugging history | Static instructions, team conventions |
| **In git** | No — local to each developer | Yes — shared with team |
| **Scope** | Per-developer, per-machine | Team-wide |

Use CLAUDE.md for stable team conventions. Use automatic memory for project-specific patterns that emerge during development.

## The Four Seed Templates

The addon provides four structured seed files:

### MEMORY.md

Central index file. Contains:
- AIWG framework concepts (phases, commands, artifact structure)
- Links to topic-specific memory files
- Empty sections for project conventions that get populated automatically

### testing.md

Testing knowledge structure including:
- Test framework detection and configuration (populated on first test run)
- Common test patterns for the project (populated as patterns are observed)
- Known gotchas — async issues, flaky tests, environment dependencies
- Debug strategies for common failures

### debugging.md

Debugging pattern structure including:
- Common issues and their resolutions (populated as issues are encountered and solved)
- Systematic debugging process
- Stack-specific error patterns
- Performance debugging strategies

### architecture.md

Architectural decision structure including:
- Key design choices and rationale (populated from ADRs and observed patterns)
- Technology stack and justifications
- Cross-cutting concerns (security, performance, scalability)
- Patterns used across the codebase

## How Seeds Work

Seeds are starting templates — they provide structure and AIWG-specific guidance, then fill in over time as Claude Code learns the project. An initial seed looks like:

```markdown
## Common Patterns

<!-- Learned during development -->
```

After several sprints, the same section looks like:

```markdown
## Common Patterns

### Test-First Development

**Pattern**: Test → Implement → Refactor
- Write failing test first (learned from UC-001 implementation)
- Implement minimal code to pass
- Refactor while keeping tests green

**Observed**: 15/20 features follow this pattern (as of 2026-02-06)
```

## Installation

### Automatic (via `aiwg new`)

When creating a new project:

```bash
aiwg new my-project
```

If a supported Claude Code Automatic Memory installation is detected, memory seeds are copied to `~/.claude/projects/my-project/memory/`.

### Manual

For an existing project:

```bash
cp agentic/code/addons/auto-memory/seeds/*.md ~/.claude/projects/$(basename $(pwd))/memory/
```

### Verify

```bash
ls -la ~/.claude/projects/$(basename $(pwd))/memory/
# MEMORY.md  testing.md  debugging.md  architecture.md
```

## Memory Maintenance

As the project evolves, memory files may need pruning:
- Remove patterns no longer applicable after refactors
- Mark superseded decisions with "SUPERSEDED" and reference the replacement
- Add new topic files as new concerns emerge (`deployment.md`, `security.md`)

### Confidence Annotation Convention

Memory entries can be annotated with a confidence tier to distinguish well-established knowledge from emerging patterns or speculative decisions. This helps future sessions weigh entries appropriately and surfaces candidates for compaction.

Three tiers (matching OpenProse user-memory):

| Tier | Meaning | Example |
|------|---------|---------|
| `established` | Validated in production, confirmed by multiple sessions or ADR | `[confidence: established — see ADR-012]` |
| `emerging` | Observed repeatedly but not yet codified | `[confidence: emerging — seen in 3 of last 5 sprints]` |
| `speculative` | One-off observation or tentative decision | `[confidence: speculative — needs validation]` |

**Format:** append inline at the end of the entry, in square brackets:

```markdown
Use JWT RS256 for all service tokens. [confidence: established — see ADR-012]

Consider Redis session store for web-facing services. [confidence: emerging — evaluated in sprint 4]

Try CQRS for the reporting module. [confidence: speculative]
```

Confidence annotations are optional but recommended for any architectural decision entry. Established entries should have a rationale reference (ADR, commit, date).

### Self-Compaction Invariant

**Trigger:** When any memory file exceeds 400 lines, the next session must compact it before adding new entries.

**Compaction process:**
1. Merge redundant entries that say the same thing in different words
2. Mark superseded decisions with "SUPERSEDED by [replacement]" and archive at bottom
3. Promote repeated speculative entries to `emerging` confidence
4. Summarize clusters of related observations into a single general entry
5. Target: reduce to ≤300 lines, retaining all `established` entries and high-value `emerging` ones

The 400-line trigger (not 500) gives a 100-line buffer to add new content before the next compaction cycle. A file that regularly hits 500+ lines without compaction is accumulating noise, not knowledge.

**Compaction marker:** Add a comment at the top of the file after compaction:
```markdown
<!-- Last compaction: 2026-04-03 — reduced from 487 to 298 lines -->
```

## Relationship to Agent Loop Debug Memory

Both mechanisms maintain debugging history but serve different purposes:

| Aspect | Automatic Memory | Agent Loop Debug Memory |
|--------|-----------------|-------------------|
| Scope | Project-wide recurring patterns | Single loop execution state |
| Lifetime | Permanent (manually pruned) | Per-loop (ephemeral) |
| Location | `~/.claude/projects/<project>/memory/` | `.aiwg/ralph/debug-memory/` |
| Use case | "We always have async test issues" | "Iteration 3 failed with timeout error" |

When the same issue appears in agent loop debug memory across multiple loops, it is a candidate for promotion to automatic memory's `debugging.md` as a known pattern.

## Platform Notes

Automatic memory is Claude Code-specific. Other platforms have their own persistence mechanisms:
- **Cursor**: Project-level memory with a different file structure
- **GitHub Copilot**: No equivalent automatic memory feature
- **Warp/OpenCode**: No equivalent

If you switch platforms, the knowledge in automatic memory files is transferable — copy the content into the new platform's equivalent mechanism, or promote it to CLAUDE.md as static instructions.

## Next Step

For a new Claude Code project, use `aiwg new <project>` and verify that the
memory files exist before relying on them. For an existing project, copy the
seed files into the Claude Code project memory directory, then ask Claude Code
to summarize the current testing and debugging patterns into the seeded
sections.

## References

- `@$AIWG_ROOT/agentic/code/addons/auto-memory/seeds/` — Seed template files
- `@$AIWG_ROOT/agentic/code/addons/agent-loop/schemas/debug-memory.yaml` — agent loop debug memory schema
