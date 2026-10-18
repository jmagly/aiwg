---
namespace: aiwg
platforms: [all]
name: issue-planner
description: Research-grounded SDLC issue planner — dispatches parallel research, generates the supporting doc corpus, then files prioritized cross-referenced issues for human review.
requires:
  - objective: non-empty string describing the feature, capability, or initiative to plan
  - tracker: issue tracker accessible (gitea | github | local) — auto-detected from project config
ensures:
  - issues-filed: prioritized issue backlog with type/priority/phase labels and wave-ordered dependencies
  - research-brief: synthesized research findings at .aiwg/working/issue-planner/research-brief.md
  - sdlc-corpus: phase-appropriate SDLC artifacts (use cases, risk register, etc.)
  - "if --dry-run: plan preview table shown without filing"
  - "if --induct-research: reference induction tasks filed for discovered sources"
errors:
  - no-tracker-access: cannot reach issue tracker; check --provider or API credentials
  - research-failed: all three parallel research agents returned empty results; try --skip-research with existing docs
  - objective-too-vague: objective is too broad to plan without clarification; use --interactive
invariants:
  - human approval gate is mandatory before any issues are filed
  - no issues are filed unless user explicitly confirms the plan
  - every filed issue links to the SDLC artifact that generated it
commandHint:
  argumentHint: "<objective> [--interactive] [--dry-run] [--guidance \"text\"] [--provider gitea|github|local] [--induct-research <target>]"
  allowedTools: Read, Write, Glob, Grep, Bash, Agent, mcp__gitea__issue_write, mcp__gitea__issue_read, mcp__gitea__list_issues, WebSearch, WebFetch
  model: haiku
  category: planning
  modelRole: efficiency
  modelTier: economy
---

# Issue Planner

Before dispatch, declare the [context packet](https://github.com/jmagly/aiwg/blob/main/docs/context-engineering-contract.md) and [verification contract](https://github.com/jmagly/aiwg/blob/main/docs/verification-contracts.md). Record expected tracker artifacts, checks, outcomes, and evidence; missing or failed required evidence cannot be success. Choose execution mode with [autonomy and human roles](https://github.com/jmagly/aiwg/blob/main/docs/autonomy-and-human-roles.md).

Transform a high-level objective into a fully researched, SDLC-gated issue backlog — ready for `address-issues` — without a human having to manually research, write docs, or decide priority order.

## Artifact-root preflight (mandatory)

Before reading or writing any logical `.aiwg/...` path, run:

```bash
aiwg artifacts path --json --check-write
```

Use the returned `artifact_root` as the physical replacement for the logical
`.aiwg` prefix in every research, synthesis, requirements, planning, and report
path below. Do not create repository-local payload when the resolved root is
external. The only repository-local `.aiwg` exceptions are the control files
`AIWG.md`, `aiwg.config`, and `frameworks/registry.json`. If the resolved
external root is unavailable, stop with an actionable diagnostic; never fall
back to `<project>/.aiwg`. Path resolution does not synchronize Git remotes:
remote fetch/pull/push remains a separate, explicit operator workflow.

## Triggers

Alternate expressions and non-obvious activations (primary phrases are matched automatically from the skill description):

- "plan out <feature>" → full research + issue filing workflow
- "file issues for <objective>" → issue-planner with dry-run preview first
- "create a backlog for <objective>" → issue-planner with priority ordering
- "research and plan <topic>" → parallel research pass then issue filing
- "use the research team to plan <X>" → explicit parallel research dispatch
- "plan issues for <X> using SDLC gates" → gate-checked issue generation
- "I need issues for <X>" → issue-planner in interactive mode to confirm scope

## Parameters

### `<objective>` (required)
The feature, capability, integration, or initiative to plan. Can be a one-liner or a multi-paragraph brief.

### `--interactive` (optional)
Ask discovery questions before researching. Surfaces: scope constraints, excluded technologies, existing artifacts, target phase, priority bias (bugs-first vs value-first).

### `--dry-run` (optional)
Generate the full plan and issue list but do not file any issues. Outputs a preview table for human review.

### `--guidance "text"` (optional)
Upfront direction that shapes research focus, prioritization, and scope without interactive prompts.

Examples:
- `--guidance "We're in Construction phase, skip Inception artifacts"`
- `--guidance "Security is top priority, HIPAA compliance required"`
- `--guidance "Quick wins only — scope to 2-week sprint"`

### `--provider` (optional)
Override the default issue tracker (`gitea` | `github` | `local`). Defaults to project config in `.aiwg/config.yaml` or `CLAUDE.md`.

### `--skip-research` (optional)
Skip the parallel research pass and go straight to SDLC doc generation. Use when research was already done externally.

### `--phase` (optional)
Target SDLC phase for artifact generation (`inception` | `elaboration` | `construction` | `transition`). Determines which templates are used and which gate criteria are checked.

### `--induct-research <target>` (optional)
After research synthesis, extract all discovered references and file tracking tasks to induct them into a research repository. Can also be set via `AIWG_RESEARCH_REPO` environment variable.

**Target formats:**

| Format | Example | Behavior |
|--------|---------|----------|
| File path | `--induct-research .aiwg/research/queue/` | Creates one Markdown task file per reference in the specified directory |
| URI | `--induct-research https://git.integrolabs.net/roctinam/research` | Infers the system from the URL (Gitea, GitHub, Jira, etc.) and files issues via the appropriate API or MCP tool |
| Named MCP service | `--induct-research gitea` | Uses the named MCP service directly (e.g. `mcp__gitea__issue_write`) |
| Named MCP service | `--induct-research codehound` | Uses Hound MCP to register references in the Hound search index |

**Env var fallback:** If `AIWG_RESEARCH_REPO` is set, `--induct-research` is implied with the env var value as the target. Explicit flag overrides the env var.

**What gets inducted:** Every external URL, paper, RFC, repo, or specification surfaced during Phase 1 research — one tracking task per reference.

**Induction task body template:**

```markdown
## Reference Induction

**Source**: <URL or file path>
**Surfaced by**: issue-planner research phase for "<objective>"
**Research stream**: <best-practices | current-state | vendor-docs>

## Relevance Summary
<One paragraph from the research agent explaining why this reference matters>

## Suggested Priority
<high | medium | low> — <rationale>

## Induction Checklist
- [ ] Read and annotate full source
- [ ] Extract key insights as Zettelkasten notes
- [ ] Cross-reference with existing corpus
- [ ] Tag with topic taxonomy
- [ ] Mark inducted in research queue

## Links
- Objective: <top-level planning objective this was surfaced for>
- Research file: @.aiwg/working/issue-planner/research-<stream>.md
```

---

## Execution Flow

### Phase 0: Intake

1. Parse `<objective>` from the user's message.
2. If `--interactive`: ask discovery questions (see Interactive Mode below).
3. If `--guidance`: incorporate upfront direction throughout all phases.
4. Confirm understanding before launching:

```
Understood. Planning: <paraphrased objective>

Research pass: 3 parallel agents (best practices, current research, vendor docs)
Artifacts: requirements, architecture sketch, risk register, test strategy
Provider: gitea (roctinam/aiwg)
Mode: [dry-run | live filing]

Starting research...
```

---

### Phase 1: Parallel Research (3 agents, single message)

Dispatch three focused research agents simultaneously. Each writes its output to `.aiwg/working/issue-planner/`:

**Agent A — Best Practices**
```
Objective: <objective>
Task: Research industry best practices, design patterns, and architectural guidance relevant to this objective.
Output: .aiwg/working/issue-planner/research-best-practices.md
Include: patterns, anti-patterns, recommended approaches, key trade-offs
```

**Agent B — Current Research & Prior Art**
```
Objective: <objective>
Task: Survey recent research, conference talks, open-source implementations, and community knowledge relevant to this objective.
Output: .aiwg/working/issue-planner/research-current-state.md
Include: recent developments (≤2 years), noteworthy implementations, emerging standards
```

**Agent C — Vendor Documentation**
```
Objective: <objective>
Task: Review official vendor documentation, API references, and integration guides for all relevant tools and platforms.
Output: .aiwg/working/issue-planner/research-vendor-docs.md
Include: official capabilities, known limitations, version requirements, migration notes
```

Progress indicator during research:
```
⏳ Research pass (3 parallel agents)...
  ⏳ A: Best practices...
  ⏳ B: Current research...
  ⏳ C: Vendor docs...
```

---

### Phase 2: Research Synthesis

Read all three research outputs and synthesize a consolidated brief:

```
✓ A: Best practices complete
✓ B: Current research complete
✓ C: Vendor docs complete
⏳ Synthesizing research...
```

Synthesis output (`.aiwg/working/issue-planner/research-synthesis.md`):
- Key findings per research stream
- Consensus recommendations
- Identified risks and unknowns
- Technology/approach decisions surfaced by research
- Open questions requiring human input

---

### Phase 2b: Research Induction Queue (if `--induct-research` or `AIWG_RESEARCH_REPO` set)

Extract all external references discovered across the three research streams and queue them for induction.

**Steps:**

1. **Collect references** — scan all three research output files for external URLs, paper titles, RFC numbers, repo links, and named specifications
2. **Deduplicate** — remove references already present in the target repository (if queryable)
3. **Resolve target** — determine filing method from the provided target:
   - **File path**: write `.md` task files to the directory (create if needed)
   - **URI**: detect host (Gitea domain → `mcp__gitea__issue_write`, GitHub → `gh issue create`, Jira → REST API)
   - **Named MCP service**: call the service's write tool directly
4. **File one induction task per reference** using the standard induction body template
5. **Report** induction summary before proceeding to Phase 3

```
⏳ Research induction queue...
  Found 12 references across 3 research streams
  Target: gitea (roctinam/research)
  Filing induction tasks...
  ✓ Filed #301: RFC 9110 HTTP Semantics
  ✓ Filed #302: "Designing Data-Intensive Applications" (Kleppmann)
  ✓ Filed #303: github.com/expressjs/express
  ... (9 more)
✓ Induction queue: 12 tasks filed
```

If `--dry-run` is set, list the references that would be inducted without filing.

---

### Phase 3: SDLC Doc Corpus Generation

Using the research synthesis and SDLC gate requirements, generate the artifact set appropriate for the target phase. Each artifact cross-references the research documents.

**Standard artifact set (Elaboration-level)**:

| Artifact | Path | Template Source |
|----------|------|----------------|
| Use Cases / User Stories | `.aiwg/requirements/UC-<slug>-*.md` | sdlc-complete/templates/requirements/ |
| Architecture Sketch | `.aiwg/architecture/sketch-<slug>.md` | sdlc-complete/templates/analysis-design/ |
| Risk Register | `.aiwg/risks/risks-<slug>.md` | sdlc-complete/templates/risk/ |
| Test Strategy | `.aiwg/testing/test-strategy-<slug>.md` | sdlc-complete/templates/testing/ |
| Security Screening | `.aiwg/security/screening-<slug>.md` | sdlc-complete/templates/security/ |

Generate a lighter set for Inception, heavier for Construction (add ADRs, detailed test plans, CI/CD hooks).

After generation, run the SDLC gate check to confirm completeness:

```
✓ Use cases generated (N stories)
✓ Architecture sketch complete
✓ Risk register populated (N risks)
✓ Test strategy drafted
✓ Security screening done
⏳ Running gate check...
✓ Gate check: corpus complete for <phase> phase
```

If gate check fails, remediate before proceeding to issue generation.

---

### Phase 4: Issue Generation

Translate the artifact corpus and research synthesis into a structured issue backlog.

#### Issue Taxonomy

Every issue gets:

| Field | Options |
|-------|---------|
| **Type label** | `feat`, `docs`, `test`, `infra`, `spike`, `security`, `bug`, `refactor` |
| **Priority** | `P0-critical`, `P1-high`, `P2-medium`, `P3-low` |
| **Phase label** | `phase:inception`, `phase:elaboration`, `phase:construction`, `phase:transition` |
| **Area label** | `area:backend`, `area:frontend`, `area:data`, `area:infra`, `area:docs`, `area:security` |
| **Doc link** | Cross-reference to the artifact that spawned this issue |

#### Priority Assignment Rules

| Condition | Priority |
|-----------|----------|
| Blocks other issues (dependency head) | P0 |
| Security finding or SDLC gate blocker | P0 |
| Core capability required for the objective | P1 |
| Supporting implementation (tests, docs, integration) | P2 |
| Enhancement, optimization, future-proof work | P3 |
| Research spike with uncertain outcome | P2 (timebox) |

#### Dependency Ordering

Analyze issue dependencies and produce a recommended execution sequence:

```
Wave 1 (no dependencies): #N, #N+1
Wave 2 (depends on Wave 1): #N+2, #N+3
Wave 3 (depends on Wave 2): #N+4
```

This is the order to pass to `address-issues`.

#### Issue Body Template

Each filed issue uses this structure:

```markdown
## Summary
<One paragraph describing the work and why it matters for the objective>

## Context
**Objective**: <top-level objective>
**Phase**: <SDLC phase>
**Supporting Docs**:
- @.aiwg/requirements/UC-<slug>.md (use cases)
- @.aiwg/architecture/sketch-<slug>.md (architecture sketch)
- @.aiwg/risks/risks-<slug>.md (risks)

**Research Basis**:
- Best practices: @.aiwg/working/issue-planner/research-best-practices.md
- Vendor docs: @.aiwg/working/issue-planner/research-vendor-docs.md

## Acceptance Criteria
- [ ] <specific, testable criterion>
- [ ] <specific, testable criterion>
- [ ] Tests written and passing
- [ ] Docs updated if applicable

## Dependencies
- Depends on: #<issue numbers>
- Blocks: #<issue numbers>

## Notes
<Key findings from research synthesis relevant to this issue>
```

---

### Phase 5: Plan Preview and Human Approval

**Always** present the complete plan before filing any issues. Even in non-dry-run mode, this gate is mandatory.

Present as a table:

```
## Issue Plan: <objective>

### Research Summary
- N best practices identified
- N current implementations reviewed
- N vendor integrations mapped
- Key finding: <one-liner>

### Supporting Docs Generated
- .aiwg/requirements/UC-<slug>-*.md (N use cases)
- .aiwg/architecture/sketch-<slug>.md
- .aiwg/risks/risks-<slug>.md (N risks)
- .aiwg/testing/test-strategy-<slug>.md

### Issue Backlog (N issues)

| # | Title | Type | Priority | Phase | Depends On | Doc Ref |
|---|-------|------|----------|-------|------------|---------|
| 1 | <title> | feat | P1 | construction | — | UC-001 |
| 2 | <title> | test | P2 | construction | #1 | test-strategy |
| 3 | <title> | docs | P3 | construction | #1 | architecture |
| 4 | <title> | security | P0 | elaboration | — | screening |

### Recommended Execution Order
Wave 1 (parallel): #4, #1
Wave 2 (after Wave 1): #2, #3

### Open Questions
1. <question that needs human decision before work starts>
2. <question>

---
**Proceed to file N issues?** Reply "yes" / "no" / "revise: <guidance>"
```

Wait for explicit human approval before filing.

---

### Phase 6: Issue Filing

On approval, file issues in the order shown (Wave 1 first, then Wave 2, etc.) to ensure issue numbers reflect dependency order.

For each issue:
- File via configured provider (Gitea MCP, GitHub CLI, or local)
- Post a cross-link comment connecting the issue to the research docs
- Record filed issue numbers for the execution-order summary

After all issues filed:

```
## Filed Issues

| Issue | Title | Priority | URL |
|-------|-------|----------|-----|
| #N | <title> | P0 | <url> |
| #N+1 | <title> | P1 | <url> |
...

### Recommended address-issues invocation:
/address-issues <wave-1-numbers> --guidance "<objective summary>"
# Then after wave 1 is resolved:
/address-issues <wave-2-numbers>

Supporting docs: .aiwg/working/issue-planner/ and .aiwg/requirements/
```

---

## Interactive Mode

When `--interactive` is set, ask these questions before Phase 1:

1. **Scope**: Are there technologies, components, or approaches that are explicitly out of scope?
2. **Existing artifacts**: Are there existing requirements, architecture docs, or prior research I should read first?
3. **Phase target**: Which SDLC phase are we in? (inception / elaboration / construction / transition)
4. **Priority bias**: Should I favor security/compliance issues first, or core functionality first?
5. **Timeline**: Is there a sprint or milestone constraint that should influence priority?
6. **Filing approval**: Should I file issues automatically after you see the plan, or always wait for an explicit "yes"?

---

## Priority Order Rationale

The recommended issue order follows these heuristics, applied in sequence:

1. **Gate blockers first** — anything that blocks a phase transition
2. **Security and compliance** — before any feature work begins
3. **Spike/research issues** — resolve unknowns before implementation
4. **Dependency-free implementation** — parallelizable core work
5. **Dependent implementation** — work that needs prior issues resolved
6. **Tests and validation** — after implementation is stable
7. **Documentation** — after implementation and tests
8. **Enhancements and optimizations** — last

This order ensures `address-issues` can make forward progress without hitting dependency blocks.

---

## What Makes This Better Than a Simple Agent or Developer

| Capability | Simple agent | Developer | issue-planner |
|------------|-------------|-----------|---------------|
| Parallel research across 3 dimensions | ✗ | Slow (sequential) | ✓ (one message) |
| SDLC gate check before issue filing | ✗ | Manual | ✓ (automated) |
| Issue-to-artifact traceability | ✗ | Inconsistent | ✓ (every issue) |
| Dependency-aware priority ordering | ✗ | Manual judgment | ✓ (wave analysis) |
| Consistent issue body structure | ✗ | Varies | ✓ (template) |
| Human approval gate before filing | ✗ | Manual | ✓ (mandatory) |
| `address-issues` handoff instructions | ✗ | ✗ | ✓ (generated) |
| Open questions surfaced before work | ✗ | Sometimes | ✓ (systematic) |

---

## Examples

### Example 1: New Integration

**User**: "Plan out Codex plugins support using the research team. File issues, I'll approve before you file anything."

**Extracted**: objective="Codex plugins support", dry-run=false (will ask approval)

**Flow**:
1. Research: Codex plugin API, npm plugin patterns, AIWG deployment architecture
2. Artifacts: use cases (install/package/publish), architecture sketch (.codex-plugin/ format), risks (version drift, marketplace availability)
3. Issues: plugin manifest schema (P1), `package-plugin codex` command (P1), marketplace integration (P2), test coverage (P2), docs (P3)
4. Preview → approval → file

---

### Example 2: Guided Sprint Planning

**User**: "Plan issues for adding HIPAA compliance to the auth module. Use the research team. Focus on security and compliance items first. We're in construction phase already."

**Extracted**: `--guidance "HIPAA compliance, auth module, construction phase, security-first priority"`

**Flow**: Research → security-first issue ordering → HIPAA-specific labels applied → gate-checked against construction criteria

---

### Example 3: Dry Run Review

**User**: "Use the research team and SDLC process to plan out WebSocket support. Show me the issues but don't file them yet."

**Extracted**: `--dry-run`

**Output**: Full plan table with `[DRY RUN — issues not filed]` header. User can revise before committing.

---

### Example 4: Quick Backlog

**User**: "File issues for <my prompt> using the aiwg research team in parallel... SDLC gates... await review."

**This is the canonical trigger pattern.** issue-planner recognizes it and executes the full workflow.

---

### Example 5: Research Induction — Named MCP Service

**User**: "Plan out distributed tracing support. Induct any research you find into our Gitea research repo."

**Extracted**: `--induct-research gitea`

**Flow**:
1. Research pass discovers: OpenTelemetry spec, Jaeger docs, Zipkin paper, "Dapper" Google paper, 3 GitHub repos
2. Phase 2b files 7 induction tasks to the configured Gitea research repo (`mcp__gitea__issue_write`)
3. Each task includes source URL, relevance summary, and induction checklist
4. Continues to Phase 3 (SDLC corpus) → Phase 4 (issues) → Phase 5 (approval)

**Sample induction task filed:**
```
#301 [induct] OpenTelemetry Specification v1.35
Surfaced during: distributed tracing support planning
Stream: vendor-docs
Priority: high — this is the canonical standard we'll implement
```

---

### Example 6: Research Induction — File Path

**User**: "Plan WebAuthn support. Save any references you find to `.aiwg/research/queue/`"

**Extracted**: `--induct-research .aiwg/research/queue/`

**Flow**: Research discovers 9 references. Phase 2b writes `.md` task files to `.aiwg/research/queue/` — one per reference — formatted with the induction body template. These can later be processed with `/induct-research .aiwg/research/queue/`.

---

### Example 7: Research Induction — Environment Variable

**Shell**: `export AIWG_RESEARCH_REPO=https://git.integrolabs.net/roctinam/research`

**User**: "Plan OAuth2 refresh token rotation using the research team."

**Flow**: `AIWG_RESEARCH_REPO` is set; induction is implied. URI is a Gitea instance — issues filed via `mcp__gitea__issue_write` to that repo. No explicit flag needed.

---

## Composition

```
issue-planner <objective>
    │
    ├── Phase 0: Intake + optional interactive discovery
    ├── Phase 1: Parallel research (3 agents simultaneously)
    │   ├── Agent A: Best practices
    │   ├── Agent B: Current research / prior art
    │   └── Agent C: Vendor documentation
    ├── Phase 2: Research synthesis
    ├── Phase 2b: Research induction queue (if --induct-research)
    │   ├── Collect + deduplicate references from all 3 streams
    │   ├── Resolve target (file path | URI | named MCP service)
    │   └── File one induction task per reference → /induct-research
    ├── Phase 3: SDLC doc corpus generation
    │   └── /flow-gate-check <phase> (completeness gate)
    ├── Phase 4: Issue generation (taxonomy + priority + dependency waves)
    ├── Phase 5: Plan preview → HUMAN APPROVAL GATE
    └── Phase 6: Issue filing + address-issues handoff instructions
```

## References

- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/skills/address-issues/SKILL.md — Consume the filed issues
- @$AIWG_ROOT/agentic/code/frameworks/research-complete/skills/induct-research/SKILL.md — Research induction target skill
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/skills/issue-create/SKILL.md — Single issue creation
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/skills/issue-driven-al/SKILL.md — Agent loop per issue
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/flows/flow-gate-check.md — Phase gate criteria
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/ — Artifact templates
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/subagent-scoping.md — Parallel research constraints
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/context-budget.md — Parallel agent limits
