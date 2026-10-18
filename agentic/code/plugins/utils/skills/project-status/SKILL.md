---
namespace: aiwg
name: project-status
platforms: [all]
description: Cross-framework project status aggregator — discovers contributors from installed frameworks, runs declarative detection, produces a unified status report.
triggers:
  - "help me know what is next"
  - "tell me where this project stands and what to do next"
  - "generate or refresh project status"
  - "project status"
commandHint:
  argumentHint: "[project-directory=.] [--json] [--guidance \"text\"]"
  allowedTools: Read, Glob, Grep, Bash
  model: haiku
  category: aiwg-utility
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


# Project Status (Cross-Framework Aggregator)

## Task

Produce a unified status report covering every installed framework, addon, or
extension that ships a `kind: status` contributor and is in active use on this
project.

This is the cross-framework aggregator described in ADR-023 §Reference
contributor frontmatter. It replaces the prior SDLC-only project-status
behavior. SDLC-specific reporting now lives in the SDLC framework's status
contributor at `agentic/code/frameworks/sdlc-complete/status/contributor.md` —
when SDLC is the only contributor in use, the resulting report is functionally
equivalent to the prior behavior.

## Parameters

- **`[project-directory]`** (optional): Path to project root. Default: current directory `.`
- **`--json`** (optional): Emit machine-readable JSON instead of human-readable markdown
- **`--guidance "text"`** (optional): Extra context the agent should weigh while interpreting contributor blocks

## Workflow

### Step 1: Locate the registry and project root

Read `.aiwg/frameworks/registry.json` from the project root. The registry lists
installed frameworks/addons/extensions by `id`. If the file is missing, treat
it as zero installed frameworks — discovery still finds project-local
contributors.

```bash
cat ./.aiwg/frameworks/registry.json 2>/dev/null
```

### Step 2: Discover candidate contributors

Two sources, processed in order:

1. **Framework-shipped contributors** — for each `id` in the registry, look up
   its source path under the AIWG installation. Try in order:
   - `<AIWG_ROOT>/agentic/code/frameworks/<id>/status/contributor.md`
   - `<AIWG_ROOT>/agentic/code/addons/<id>/status/contributor.md`
   - `<AIWG_ROOT>/agentic/code/extensions/<id>/status/contributor.md`

   Use `Glob` to discover, then `Read` to load the contributor file.

2. **Project-local contributors** — every `*.md` file in
   `<project-root>/.aiwg/contributors/status/`. These are user-authored
   contributors that do not require forking a framework.

### Step 3: Validate and run detection

For each candidate file:

1. Parse YAML frontmatter. Skip with a warning if frontmatter is malformed
   or missing required fields (`kind`, `domain`, `description`, `detect.glob`).
   The schema is published at
   `<AIWG_ROOT>/agentic/code/addons/aiwg-utils/skills/project-status/contributor.schema.json`
   — `aiwg validate-metadata` enforces it at deploy time, so most files
   reaching this step are valid.
2. Run the contributor's `detect.glob` patterns against the project root using
   `Glob`. Deduplicate matches. If unique match count is less than
   `detect.minCount` (default 1), the contributor is **installed but not in
   use** — silently filter out.
3. For surviving contributors, the agent reads the contributor file's body
   to learn what to report and how to format it.

### Step 4: Gather state per contributor

For each in-use contributor, follow its body's guidance to read source files
and compute reported state. Contributors are descriptive — they tell the
agent what to look at; they do not run code.

Keep blocks compact. Per ADR-023 §Output voice, contributors emit observed
state (counts, dates, phase names). Do **not** synthesize prescriptive
"recommended commands" inside a contributor's block.

### Step 5: Render the unified report

Default (markdown) output shape:

```
Project: <project-name> (<detected-domain-summary>)
├─ <Domain 1>: <one-line summary> (origin: <framework-id>)
│  ├─ <fact 1>
│  ├─ <fact 2>
│  └─ <fact N>
├─ <Domain 2>: <one-line summary> (origin: <framework-id>)
│  └─ ...
└─ <Domain K>: <one-line summary> (origin: project-local)
   └─ ...
```

Every block carries an **`origin:`** stamp — the framework id (e.g.
`sdlc-complete`, `media-curator`) or the literal `project-local`. This lets
the user see at a glance whether a finding came from a framework's
contributor or a project-specific override.

### Step 6: Handle empty discovery

If discovery returns zero in-use contributors:

- **In a project that has frameworks installed but none are in use yet**:
  surface "No active framework contributors detected. Run
  `intake-wizard` if this is a new project, or check
  `.aiwg/frameworks/registry.json` to confirm what's installed."
- **In a project with no `.aiwg/`**: defer to the heuristic fallback
  described in `<AIWG_ROOT>/agentic/code/addons/aiwg-utils/skills/project-status/heuristic-fallback.md`
  (added by issue #941). When that file is not yet present, surface a
  short "No project state detected" message.

## --json output

Returns a structured array of contributor blocks. Stable shape:

```json
{
  "project_root": "/abs/path",
  "contributors": [
    {
      "origin": "sdlc-complete",
      "domain": "SDLC",
      "summary": "Construction phase, iteration 12, 3 open risks",
      "detail": [
        { "label": "Phase", "value": "Construction (entered 2026-04-01)" },
        { "label": "Iteration", "value": "12 of 18 planned" }
      ]
    }
  ],
  "skipped": [
    { "origin": "media-curator", "reason": "detection-no-match" }
  ]
}
```

Downstream tooling (CI status badges, dashboards) consumes this shape directly.

## Failure mode

Per ADR-023 §Failure mode:

- A contributor that fails frontmatter parsing or validation is **skipped**
  with reason `schema-violation`; aggregation continues.
- A contributor whose detection throws (rare — only filesystem permission
  errors should cause this) is skipped with reason `detection-error`.
- One bad contributor never aborts the whole report.

When `--json` is set, skips appear under the `skipped` array. In markdown
output, skips are summarized under a `─ Skipped contributors` footer when
non-empty.

## Anti-Patterns

- **Do not invent contributor state.** If a contributor's detection matches
  but its source files are absent or unreadable, emit the block with a
  clear "details unavailable" note rather than fabricating values.
- **Do not merge or reorder contributor blocks.** Registry order and
  project-local-last is the contract per ADR-023 §Discovery Algorithm.
  Users rely on it for predictable diffs over time.
- **Do not call into other AIWG commands** (`aiwg index build`, `aiwg run …`)
  from this skill. Status reporting is read-only. If a contributor needs
  built indexes, surface their absence rather than building them mid-report.

## References

- @.aiwg/architecture/decisions/ADR-023-contributor-discovery-convention.md — Convention this skill implements
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/skills/project-status/contributor.schema.json — Published JSON Schema for `kind: status` frontmatter
- @$AIWG_ROOT/src/contributors/discover.ts — TS reference implementation used by `aiwg validate-metadata`; demonstrates the discovery algorithm in code
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/status/contributor.md — Reference status contributor (SDLC framework)
- @$AIWG_ROOT/agentic/code/frameworks/media-curator/status/contributor.md — Reference status contributor (media archives)
- @$AIWG_ROOT/agentic/code/frameworks/research-complete/status/contributor.md — Reference status contributor (research corpora)
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/skills/project-health-check/SKILL.md — Complementary skill: code and team health metrics (out of scope for project-status)
