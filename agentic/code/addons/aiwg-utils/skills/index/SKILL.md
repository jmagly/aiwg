---
namespace: aiwg
name: index
platforms: [all]
description: Build, query, inspect dependencies, sync Fortemi Core cache, and report status for the searchable index of SDLC artifacts in .aiwg/
---

# Artifact Index

You manage the AIWG artifact index — building or rebuilding the searchable index of all SDLC artifacts in `.aiwg/`, querying it by text, inspecting dependency graphs, and reporting index statistics.

> **Scope: the JSON artifact graph AND research-corpus markdown views.** This skill manages the JSON artifact graph under `.aiwg/.index/*` (nodes, edges, checksums). As of #1490, `aiwg index build` **also** renders research-corpus markdown views (`indices/by-topic.md`, `indices/by-year.md`, `indices/authors.md`, `citation-network`, …) natively, in the same process — one command produces both from one config (`.aiwg/aiwg.config` `index.graphs`, #1491). The former standalone `corpus-index-build` `build.py` is retired; that skill now points back to `aiwg index build`. Markdown views render only when the project has a `documentation/references/` corpus, so this is a no-op in ordinary SDLC projects.

## Triggers

Alternate expressions and non-obvious activations (primary phrases are matched automatically from the skill description):

- "index my artifacts" → build
- "find requirements about authentication" → query "authentication"
- "what depends on UC-001" → deps .aiwg/requirements/UC-001.md
- "show neighboring artifacts" → neighbors --node <id>
- "compare related artifacts" → set --op intersection --node-a <id> --node-b <id>
- "how many artifacts are indexed" → stats
- "is the index healthy" → status
- "export the index for Fortemi" → export --format fortemi
- "sync the Fortemi cache" → sync
- "refresh the index" → build --force

## Trigger Patterns Reference

| Pattern | Example | Action |
|---------|---------|--------|
| Build index | "build the artifact index" | Run `aiwg index build` |
| Post-clone bootstrap | "I just cloned this, queries return nothing" / "the index is missing" | Run `aiwg index build --all` (the index is gitignored, not committed — see note below) |
| Force rebuild | "rebuild the index from scratch" | Run `aiwg index build --force --verbose` |
| Text search | "search artifacts for authentication" | Run `aiwg index query "authentication"` |
| Dependency graph | "show dependencies for the SAD" | Run `aiwg index deps .aiwg/architecture/software-architecture-doc.md` |
| Neighbor graph | "show related nodes for REF-001" | Run `aiwg index neighbors --graph <name> --node REF-001` |
| Set operation | "what overlaps between these two nodes" | Run `aiwg index set --graph <name> --op intersection --node-a <id> --node-b <id>` |
| Statistics | "how many artifacts are indexed?" | Run `aiwg index stats` |
| Health/status | "is the index stale?" | Run `aiwg index status --json` |
| JSON output | "get index stats as JSON" | Run `aiwg index stats --json` |
| Fortemi export | "export this index for Fortemi" | Run `aiwg index export --format fortemi --schema-version v2` |
| Fortemi cache | "sync the Fortemi Core index" | Run `aiwg index sync` |

> **`.aiwg/.index/` is a regenerable build artifact, not committed.** It is gitignored by default (`aiwg use` / `aiwg regenerate` / scaffolding add it to `.gitignore`), so a fresh clone has no index — `aiwg index build --all` is the standard bootstrap. `aiwg doctor` flags a missing index (`info`, when an `index` block is declared in `.aiwg/aiwg.config` — the canonical home as of #1491 — or legacy `.aiwg/config.yaml`) or a stale one (`warn`, when recorded source files changed) and points back to `aiwg index build`.

## Behavior

When triggered:

1. **Identify the subcommand**:
   - Is the user building, searching, inspecting dependencies, or checking stats?
   - Is a specific artifact path or query mentioned?
   - Is `--force`, `--verbose`, or `--json` appropriate?

2. **Run the appropriate command**:

   ```bash
   # Build or rebuild the index
   aiwg index build

   # Full rebuild with progress output
   aiwg index build --force --verbose

   # Semantic search across all artifacts
   aiwg index query "<text>"

   # Machine-readable search results
   aiwg index query "<text>" --json

   # default Fortemi Core static-cache query
   aiwg index query "<text>" --json

   # Fortemi static semantic and filtered hybrid query modes
   aiwg index query "<text>" --semantic --json
   aiwg index query "<text>" --hybrid --type adr --tags search --json

   # Show dependency graph for an artifact
   aiwg index deps <artifact-path>

   # Machine-readable dependency graph
   aiwg index deps <artifact-path> --json

   # Inspect neighbor traversal or set relationships
   aiwg index neighbors --graph <name> --node <node-id> --json
   aiwg index set --graph <name> --op intersection --node-a <node-id> --node-b <node-id> --json

   # Show index statistics
   aiwg index stats

   # Machine-readable statistics
   aiwg index stats --json

   # Health/status, including optional Fortemi Core cache state
   aiwg index status --json

   # Export and sync the default Fortemi Core static cache
   aiwg index export --format fortemi --schema-version v2
   aiwg index sync
   ```

3. **Report the result** — surface the relevant matches, dependencies, or counts.

### Fortemi Core Backend

Fortemi Core is the default artifact search backend after `aiwg index sync`.
Use `--backend local` only for the legacy local fallback during the phase-out
window. If the Fortemi cache is missing or stale, run `aiwg index sync`.
A valid synced Fortemi cache with zero items is not stale:
query/fulltext return empty results, discover reports a Fortemi static-cache
no-match hint, and show does not fall back to the local AIWG corpus when the
Fortemi backend was explicit.

### Full-text Source Sizes

`aiwg index query "<text>" --fulltext` uses BM25 over source bodies:

- **Fortemi Core (default)** searches text bodies captured at sync, without a
  size cap or truncation. Binary and unreadable sources remain metadata-only.
  `aiwg index sync` reports that zero bodies were omitted for size.
- **`--backend local`** reads current source files at query time, without a
  size cap or truncation; missing or unreadable sources are skipped.

Re-run `aiwg index sync --graph <name>` to replace older Fortemi caches that
omitted bodies larger than 256 KiB. The standalone `index export` API retains
its default 256 KiB source-body cap; sync explicitly lifts that cap.

## Examples

### Example 1: Build the index

**User**: "Build the artifact index"

**Extraction**: Build subcommand, no flags

**Action**:
```bash
aiwg index build
```

**Response**: "Index built. Indexed 47 artifacts across 8 categories in .aiwg/. Run `aiwg index query` to search."

### Example 2: Force rebuild with progress

**User**: "Rebuild the index from scratch"

**Extraction**: Build subcommand, --force --verbose

**Action**:
```bash
aiwg index build --force --verbose
```

**Response**: "Full rebuild complete. Scanned 52 files, indexed 47 artifacts (5 skipped: working/). Categories: requirements (12), architecture (8), testing (7), security (5), deployment (4), planning (6), risks (5)."

### Example 3: Text search

**User**: "Search artifacts for anything about authentication"

**Extraction**: Query subcommand, text = authentication

**Action**:
```bash
aiwg index query "authentication"
```

**Response**: "5 artifacts match 'authentication': UC-003-user-authentication.md (requirements), SAD section 4.2 (architecture), threat-model-v1.md (security), test-plan-auth.md (testing), deployment-runbook.md (deployment)."

### Example 4: Dependency inspection

**User**: "What does UC-001 depend on, and what depends on it?"

**Extraction**: Deps subcommand, artifact = .aiwg/requirements/UC-001.md

**Action**:
```bash
aiwg index deps .aiwg/requirements/UC-001.md
```

**Response**: "UC-001 (User Registration) dependencies: none (root artifact). Dependents: UC-003-user-authentication.md, test-plan-registration.md, SAD section 3.1, deployment-runbook.md."

### Example 5: Index statistics

**User**: "How many artifacts are indexed?"

**Extraction**: Stats subcommand

**Action**:
```bash
aiwg index stats
```

**Response**: "Index contains 47 artifacts. Coverage: 90% (5 unindexed files in working/). Last built: 2026-04-01T14:22:00Z. Categories with highest artifact count: requirements (12), architecture (8), testing (7)."

## Clarification Prompts

If the user's intent is ambiguous:

- "Are you looking to search for existing artifacts, or rebuild the index so new artifacts are discoverable?"
- "Do you want to see what an artifact depends on, or what other artifacts depend on it? (I can show both)"

## References

- @$AIWG_ROOT/src/cli/handlers/subcommands.ts — Index subcommand handler
- @$AIWG_ROOT/docs/cli-reference.md — CLI reference (index section)
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/README.md — SDLC artifact structure
