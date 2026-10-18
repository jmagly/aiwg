---
namespace: aiwg
name: ralph-memory
platforms: [all]
description: Manage Al semantic memory entries — list, query, and clear lessons learned across loop iterations
commandHint:
  argumentHint: "<list|query|clear> [--loop-id <id>] [--query <text>] [--since <date>]"
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


# Al Memory

Inspect and manage the semantic memory that Al accumulates across loop iterations. Memory entries record lessons learned, failure patterns, and success patterns so that later iterations — and future loops on similar tasks — benefit from what earlier attempts discovered.

## Natural Language Triggers

Users may say:
- "ralph memory"
- "ralph memories"
- "list ralph memory"
- "query ralph memory"
- "what has ralph learned"
- "show ralph lessons"
- "clear ralph memory"

## Parameters

### Subcommand (required)
One of `list`, `query`, or `clear`.

### --loop-id (optional)
Scope the operation to a specific loop's memory. If omitted, operates on the global memory store (`.aiwg/ralph/memory.json`).

```
/ralph-memory list --loop-id abc123
```

### --query (optional, used with `query` subcommand)
Text to search for in memory entries. Matches against `lesson`, `pattern`, `context`, and `tags` fields.

```
/ralph-memory query --query "auth mocks"
```

### --since (optional)
Filter entries created on or after this date. Accepts ISO 8601 date (`2026-04-01`) or relative expressions (`7d`, `2w`).

```
/ralph-memory list --since 7d
```

## Memory Entry Schema

Each entry in `.aiwg/ralph/memory.json` follows this structure:

```json
{
  "id": "mem_a1b2c3",
  "loopId": "abc123",
  "iteration": 2,
  "createdAt": "2026-04-01T10:42:00Z",
  "type": "failure_pattern",
  "lesson": "Auth mocks must be initialized inside beforeEach, not at module scope",
  "context": "src/auth/auth.test.ts iteration 2 failure",
  "tags": ["auth", "mocks", "jest"],
  "confidence": 0.9
}
```

**Entry types**:
- `lesson_learned` — General insight extracted from an iteration
- `failure_pattern` — Recurring error pattern to avoid
- `success_pattern` — Approach that worked and should be repeated

## Behavior

### `list` Subcommand

1. Read the memory store (scoped to `--loop-id` if provided, otherwise global)
2. Apply `--since` filter if provided
3. Display a formatted table of all entries, sorted by `createdAt` descending

**Output**:
```
Al Memory — 8 entries

| ID       | Type            | Loop   | Iter | Lesson                                              | Date       |
|----------|-----------------|--------|------|-----------------------------------------------------|------------|
| mem_a1b2 | failure_pattern | abc123 | 2    | Auth mocks must be in beforeEach, not module scope  | 2026-04-01 |
| mem_c3d4 | lesson_learned  | abc123 | 3    | Use jest.resetAllMocks() in afterEach               | 2026-04-01 |
| mem_e5f6 | success_pattern | def456 | 5    | ESM imports require .js extension in TypeScript     | 2026-03-28 |
| mem_g7h8 | failure_pattern | def456 | 2    | ts-node does not support isolatedModules by default | 2026-03-28 |
...

Use /ralph-memory query --query "<text>" to search.
```

**If no entries exist**:
```
No memory entries found.

Al accumulates memory as it runs loops. Start a loop:
  /ralph "your task" --completion "criteria"
```

### `query` Subcommand

1. Read all memory entries (filtered by `--loop-id` and `--since` if provided)
2. Score each entry against the `--query` text using substring and tag matching
3. Return the top matches, ranked by relevance score descending

**Output**:
```
Al Memory — query: "auth mocks"

3 matching entries (ranked by relevance):

1. [mem_a1b2] failure_pattern — confidence 0.90
   Lesson: Auth mocks must be initialized inside beforeEach, not at module scope
   Context: src/auth/auth.test.ts iteration 2
   Tags: auth, mocks, jest
   Loop: abc123, Iter: 2, Date: 2026-04-01

2. [mem_c3d4] lesson_learned — confidence 0.80
   Lesson: Use jest.resetAllMocks() in afterEach to prevent mock state leakage
   Context: src/auth/auth.test.ts iteration 3
   Tags: auth, jest, cleanup
   Loop: abc123, Iter: 3, Date: 2026-04-01

3. [mem_x9y0] failure_pattern — confidence 0.60
   Lesson: Passport mock must stub req.user before middleware chain
   Context: src/auth/middleware.test.ts
   Tags: auth, passport, mocks
   Loop: ghi789, Iter: 1, Date: 2026-03-25
```

**No matches**:
```
No memory entries match "auth mocks".

Try broader terms or list all entries:
  /ralph-memory list
```

### `clear` Subcommand

1. If `--loop-id` is provided, delete only entries belonging to that loop
2. Otherwise, prepare to clear the entire memory store
3. Show a confirmation prompt before deleting

**Confirmation prompt**:
```
This will permanently delete 8 memory entries.

Entries by loop:
  abc123 — 3 entries (Fix auth tests, 2026-04-01)
  def456 — 4 entries (ESM migration, 2026-03-28)
  ghi789 — 1 entry  (Middleware fix, 2026-03-25)

Type 'yes' to confirm:
```

**After clearing**:
```
Al memory cleared. 8 entries deleted.

Memory file reset: .aiwg/ralph/memory.json
```

**Loop-scoped clear**:
```
Cleared 3 memory entries for loop abc123.

Remaining entries: 5 (in other loops)
```

## Memory File Locations

| Scope | Path |
|-------|------|
| Global (all loops) | `.aiwg/ralph/memory.json` |
| External loop global | `.aiwg/ralph-external/memory.json` |
| Per-loop (external) | `.aiwg/ralph-external/loops/<id>.json` (embedded `learnings` field) |

## Error Handling

**Memory file missing**:
```
No Al memory found at .aiwg/ralph/memory.json.

Al has not accumulated any memory yet. Run a loop first:
  /ralph "your task" --completion "criteria"
```

**Corrupted memory file**:
```
Memory file is not valid JSON: .aiwg/ralph/memory.json

Options:
1. Delete and start fresh: rm .aiwg/ralph/memory.json
2. Inspect manually to repair
```

**Missing --query for query subcommand**:
```
Error: --query is required for the 'query' subcommand.

Usage:
  /ralph-memory query --query "auth mocks"
  /ralph-memory query --query "typescript" --since 7d
```

## Examples

### Example 1: List all memory entries
```
/ralph-memory list
```
**Response**: Table of all accumulated Al memory entries, newest first.

### Example 2: List entries from the last week
```
/ralph-memory list --since 7d
```
**Response**: Only entries created in the last 7 days.

### Example 3: Query for relevant memories before starting a task
```
/ralph-memory query --query "typescript esm"
```
**Response**: Top matching entries about TypeScript ESM, ranked by relevance.

### Example 4: List memories from a specific loop
```
/ralph-memory list --loop-id abc123
```
**Response**: Only entries generated during loop `abc123`.

### Example 5: Clear memories from a completed loop
```
/ralph-memory clear --loop-id abc123
```
**Response**: Prompts confirmation, then deletes the 3 entries for loop abc123.

### Example 6: Full reset
```
/ralph-memory clear
```
**Response**: Prompts confirmation listing all entries by loop, then deletes everything.

## Related

- `ralph` — Loop that generates memory entries
- `ralph-external` — External loop with its own memory layer
- `ralph-status` — Check loop status and iteration history
- `ralph-reflect` — Deeper reflection and memory promotion

## References

- @$AIWG_ROOT/src/cli/handlers/ralph.ts — Al CLI handler
- @$AIWG_ROOT/tools/ralph-external/memory-manager.mjs — Memory storage and retrieval
- @$AIWG_ROOT/tools/ralph-external/lib/semantic-memory.mjs — Semantic memory layer
- @$AIWG_ROOT/tools/ralph-external/lib/memory-retrieval.mjs — Memory query logic
- @$AIWG_ROOT/tools/ralph-external/lib/memory-promotion.mjs — Cross-task memory promotion
- @$AIWG_ROOT/${CLAUDE_PLUGIN_ROOT}/README.md — Al documentation

## Storage Routing (#934, #967)

This skill's persistence flows through `resolveStorage('memory')`. On the default `fs` backend the agent-loop memory lives at `.aiwg/ralph/memory.json` (and `.aiwg/ralph-external/memory.json` for external loops). To redirect into Obsidian, Logseq, Fortemi, or another backend without changing this skill, configure `roots.memory` or `backends.memory` in `.aiwg/storage.config` (#934).

When this skill needs to read/write loop memory from a Bash step, prefer the storage-routed CLI:

```bash
aiwg memory get ralph/memory.json                # read global ralph memory
echo '{"loop_id":"x","learnings":[]}' | aiwg memory put ralph/memory.json
echo '{"event":"learned","ts":"..."}' | aiwg memory append-log ralph/learning.jsonl
```

The legacy direct-fs paths (`.aiwg/ralph/memory.json`) continue to work on the default `fs` backend — they're byte-identical to what the adapter writes — but only the adapter route honors `storage.config` redirection.
