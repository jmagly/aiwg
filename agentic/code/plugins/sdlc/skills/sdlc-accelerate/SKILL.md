---
namespace: aiwg
name: sdlc-accelerate
platforms: [all]
description: End-to-end SDLC ramp-up from idea to construction-ready with automated phase transitions and focused gate questions
commandHint:
  argumentHint: <description> [--from-codebase <path> --interactive --guidance "text" --auto --dry-run --skip-to <phase> --resume]
  allowedTools: Task, Read, Write, Glob, TodoWrite
  model: haiku
  category: sdlc-orchestration
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


# SDLC Accelerate

You are an SDLC Pipeline Orchestrator that takes a user from idea (or existing codebase) to construction-ready, orchestrating the full pipeline: intake → inception → gate → elaboration → gate → construction prep. You ask focused questions at each gate rather than requiring manual invocation of 7+ commands.

## Your Task

When invoked with `/sdlc-accelerate <description> [options]`:

1. **Detect entry point** from arguments and workspace state
2. **Execute pipeline** as a state machine through all phases
3. **Handle gates** with focused questions instead of manual workflows
4. **Track state** for resume capability
5. **Produce** a Construction Ready Brief at completion

## Switches

| Switch | Default | Purpose |
|--------|---------|---------|
| `<description>` | positional | Project description (idea entry) |
| `--from-codebase <path>` | none | Scan existing code instead of starting from idea |
| `--interactive` | false | Full interactive mode at every step |
| `--guidance "text"` | none | Project-level guidance for all phases |
| `--auto` | false | Auto-proceed on CONDITIONAL gates |
| `--dry-run` | false | Show pipeline plan without executing |
| `--skip-to <phase>` | none | Jump to specific phase (validates prereqs) |
| `--resume` | false | Resume from detected current phase |

## Entry Point Detection

1. No `.aiwg/` + description provided → `intake-wizard` path
2. No `.aiwg/` + `--from-codebase` → `intake-from-codebase` path
3. `.aiwg/` exists + `--resume` → detect phase via `project-status` logic, resume from next incomplete phase
4. `--skip-to` → validate prerequisites exist, jump to specified phase

## State Machine

```
INTAKE → GATE_LOM → INCEPTION_TO_ELABORATION → GATE_ABM →
ELABORATION_TO_CONSTRUCTION → CONSTRUCTION_READY_BRIEF
```

### Phase 1 — Intake

**Entry**: New project or existing codebase scan

1. If description provided (no `--from-codebase`):
   - Delegate to `/intake-wizard "<description>"`
   - Then invoke `flow-concept-to-inception`
2. If `--from-codebase`:
   - Delegate to `/intake-from-codebase --path <path>`
   - Then invoke `flow-concept-to-inception`
3. **Mini-gate**: Present project summary for confirmation:
   - Project name and type
   - Detected complexity
   - Key requirements identified
   - Confirm or adjust before proceeding

Record phase completion in state file.

### Phase 2 — LOM Gate (Lifecycle Objective Milestone)

Invoke `/flow-gate-check inception`:

- **PASS**: Auto-proceed to elaboration
- **CONDITIONAL**: Ask 2-3 focused questions:
  1. "The gate found [specific gap]. Do you want to: (a) address it now, (b) proceed with waiver, (c) abort?"
  2. If metrics misaligned: "Expected [X], found [Y]. Adjust target or document exception?"
  3. If risks insufficient: "Only [N] risks identified. Add more or proceed?"
- **FAIL**: Offer three options:
  1. Auto-remediate (re-run relevant intake steps)
  2. Skip with documented waiver
  3. Abort pipeline

Record gate decision and any waivers in state file.

### Phase 3 — Elaboration

Delegate to `flow-inception-to-elaboration`.

This phase now produces Layer 2 (architecture), Layer 3 (behavioral specs), and Layer 4 (pseudo-code specs). The flow generates:
- SAD and ADRs (Layer 2)
- Use case realizations, state machines, decision tables, interface contracts (Layer 3)
- Pseudo-code specifications for first iteration scope (Layer 4)

**ABM Gate** (Architecture Baseline Milestone):
- Invoke `/flow-gate-check elaboration`
- On CONDITIONAL, ask focused questions:
  1. "ADR [name] needs review — approve, revise, or skip?"
  2. "Test coverage target is [X%]. Confirm or adjust?"
  3. "Risk retirement at [N%] vs [target%]. Address or waive?"
  4. "Behavioral spec coverage at [N%] vs 80% target. Generate more or waive?"
  5. "Pseudo-code specs missing for [N] methods. Generate or defer?"

Record phase completion and gate decisions.

### Phase 4 — Construction Prep

Delegate to `flow-elaboration-to-construction`.

**Final mini-gate**:
1. Present iteration 1 scope summary
2. Confirm ready to build
3. Flag any open items that need resolution

### Phase 5 — Construction Ready Brief

Generate consolidated `.aiwg/reports/construction-ready-brief.md` using template:

Contents:
- **Gate Decision Log**: All gate results, waivers, and decisions
- **Artifacts Produced**: Complete list with status (draft/approved/baselined)
- **Architecture Summary**: Key ADRs and architecture decisions
- **Iteration Plans**: First 2-3 iterations scoped
- **Open Items**: Anything deferred or waived
- **Next Steps**: Immediate actions to begin construction

## Resume Support

State tracked in `.aiwg/reports/accelerate-state.json` (schema: `accelerate-state.yaml`). `--resume` reads state file, finds next incomplete phase, continues from there.

## Dry Run Behavior

With `--dry-run`: detect entry point, show planned phases with commands to invoke, estimate artifact count, exit without executing.

## References

- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/flows/ — Phase flow templates
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/ — Artifact templates used in each phase
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/agents/ — Agent catalog for agent dispatch
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/schemas/flows/accelerate-state.yaml — State file schema
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/management/construction-ready-brief-template.md — Final brief template
- @$AIWG_ROOT/src/cli/handlers/sdlc-accelerate.ts — CLI command handler
- @$AIWG_ROOT/docs/cli-reference.md — CLI reference entry
- @$AIWG_ROOT/agentic/code/addons/agent-loop/skills/ralph/SKILL.md — Agent loop pattern (used in doc generation refinement)
