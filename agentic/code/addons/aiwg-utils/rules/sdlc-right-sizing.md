---
activation: summary
summary: Choose the smallest SDLC workflow and artifact set justified by the change; reserve intake and phase ceremony for work whose scope warrants them.
bound_to:
  skills:
    - address-issues
    - flow-architecture-evolution
    - flow-change-control
    - flow-compliance-validation
    - flow-concept-to-inception
    - flow-construction-to-transition
    - flow-cross-team-sync
    - flow-delivery-track
    - flow-deploy-to-production
    - flow-discovery-track
    - flow-elaboration-to-construction
    - flow-gate-check
    - flow-guided-implementation
    - flow-handoff-checklist
    - flow-hypercare-monitoring
    - flow-inception-to-elaboration
    - flow-incident-response
    - flow-iteration-dual-track
    - flow-knowledge-transfer
    - flow-performance-optimization
    - flow-release
    - flow-requirements-evolution
    - flow-retrospective-cycle
    - flow-risk-management-cycle
    - flow-security-review-cycle
    - flow-team-onboarding
    - flow-test-strategy-execution
    - intake-from-campaign
    - intake-from-codebase
    - intake-start
    - intake-start-campaign
    - intake-wizard
    - sdlc-accelerate
  flows:
    - flow-agentloop-lfd-controls
    - flow-architecture-evolution
    - flow-change-control
    - flow-compliance-validation
    - flow-concept-to-inception
    - flow-construction-to-transition
    - flow-cross-team-sync
    - flow-delivery-track
    - flow-deploy-to-production
    - flow-discovery-track
    - flow-elaboration-to-construction
    - flow-gate-check
    - flow-guided-implementation
    - flow-handoff-checklist
    - flow-hypercare-monitoring
    - flow-inception-to-elaboration
    - flow-incident-response
    - flow-iteration-dual-track
    - flow-knowledge-transfer
    - flow-performance-optimization
    - flow-release
    - flow-requirements-evolution
    - flow-retrospective-cycle
    - flow-risk-management-cycle
    - flow-security-review-cycle
    - flow-team-onboarding
    - flow-test-strategy-execution
triggers:
  - how much SDLC process does this change need
  - should a small bug fix need intake
  - choose a lightweight workflow
enforcement: high
---

# SDLC Right-Sizing

**Enforcement Level**: HIGH
**Scope**: All agents that touch AIWG SDLC artifacts or flows
**Addon**: aiwg-utils (core, universal)

## Overview

AIWG ships a full SDLC framework: intake, solution profile, option matrix, use cases, ADRs, SAD, phase gates, etc. The full set is the right answer for **substantial new work** — new addons, new tracks, refactors, major features. It is the wrong answer for most day-to-day changes.

The default reflex of "user asked for a feature → run intake → Inception phase → ADR → SAD → use cases" is over-engineering for any work that doesn't cross a meaningful threshold. Most features need an issue, maybe an ADR for a real design decision, and direct implementation. Not a phase pipeline.

This rule defines when to escalate to formal SDLC artifacts and when to keep it lightweight.

## Problem Statement

Agents frequently over-reach the SDLC pipeline:

- Treating every feature request as an intake-worthy project
- Writing a solution profile for a bug fix
- Opening Inception for a docs update
- Producing an ADR for a routine pattern application
- Asking the user "should I run intake?" when the work is clearly small

This wastes user time, pollutes `.aiwg/` with stale artifacts, and signals that AIWG is heavyweight when most use of it shouldn't be.

The opposite failure is also real: skipping intake on work that genuinely warrants it (a new addon that ships to users, a refactor crossing module boundaries) produces undocumented decisions and missing traceability.

The right behavior is **right-sizing**: match the artifact set to the actual scope of the change.

## Mandatory Rules

### Rule 1: Default to the lightest sufficient artifact set

For any work, ask: "what's the minimum that captures the decision and enables reproducibility?"

| Change shape | Default artifacts |
|---|---|
| Bug fix, small enhancement, docs typo, dependency bump | Commit. Maybe an issue. No ADR unless the fix encodes a non-obvious design choice. |
| Small feature (single component, well-bounded) | Issue. ADR only if a non-trivial design decision is made. No intake. No phase gates. |
| Milestone containing bounded engineering issues | `address-issues --milestone <name> --dispatch workers`; triage, briefs, independent checks, policy delivery and post-merge CI. |
| Medium feature (cross-component, new public surface, security implications) | Issue. ADR. Plan document if helpful. Lightweight option matrix if multiple paths considered. Intake is optional, not default. |
| Large feature / new addon / new framework / new track | Intake + ADR. Plan document. Use cases for the user-facing surface. Phase-gate discipline. |
| Refactor crossing module boundaries / architectural shift | Full SDLC: intake + Inception phase + SAD + ADRs + phase gates. |

### Rule 2: Trigger criteria for formal intake

Initiate intake (`intake-wizard` or `intake-start`) when **two or more** of these are true:

- The work creates a new publicly-deployable artifact (addon, framework, schema, agent shipped to users)
- The work touches more than one framework or addon
- The work involves stakeholders beyond the requester (security review, compliance, ops)
- The work changes a contract that downstream code depends on (API, schema, command surface)
- The work is expected to span more than one logical phase (research → design → impl → release)
- The work is a refactor touching >20% of a component
- The user explicitly requests intake, Inception, or "let's plan this properly"

If fewer than two are true, do NOT default to intake. Surface lighter alternatives.

### Rule 3: When in doubt, ask one question — don't presume

If the agent cannot confidently right-size from the user's request, ask one specific question:

> "This sounds like [scope X]. I can either [light path] or [heavier path]. Which fits?"

Do not present a four-option menu of "plan-doc, intake, ADR, full pipeline" by default. That itself is over-engineering the meta.

If the user pre-authorizes ("just plan it", "make this happen", "small change"), interpret literally and don't escalate.

### Rule 4: ADRs are cheap; use them when there's a real decision

An ADR captures a design decision with rationale and alternatives considered. It's NOT a full SDLC artifact — it's a focused, one-page-ish document.

Write an ADR when:

- A non-obvious technical choice is being made (library X vs Y, protocol A vs B, pattern P vs Q)
- The choice has long-term implications (will live in code for months/years)
- Future readers will reasonably ask "why did we do it this way?"
- A trade-off was made (e.g., chose security over convenience, or vice versa)

Don't write an ADR for:
- "Used the existing pattern" (no decision)
- "Fixed a bug" (no design choice)
- "Followed the framework's recommendation" (no alternative)
- Reflexively after every feature

ADRs are encouraged independent of intake. A small feature with a real design choice merits an ADR even without intake.

### Rule 5: Issues are the unit of work, not artifacts

For most work, the issue tracker (per `delivery-policy`'s `remotes.issue_tracker`) is the right place to record:

- What was asked
- What was done
- What was decided
- Cross-repo dependencies

Resist the urge to convert every issue into an intake form. Issues are lower-friction, more familiar to users, and the canonical way to track work. Reach for `.aiwg/intake/` only when Rule 2's criteria fire.

### Rule 6: Right-size BEFORE launching flows

For "work through this milestone with workers", "work this milestone", or
"get the engineering track going", prefer the **address-issues milestone mode**.
Load `aiwg show skill address-issues --body`; use `--dry-run` for a triage and
dispatch preview. Reserve Delivery Track for a requested full iteration with
quality gates and iteration assessment. A handful of bounded issues needs the
milestone loop; it does not by itself trigger intake or phase ceremony.

Before invoking any SDLC flow command (`flow-inception-to-elaboration`, `flow-architecture-evolution`, etc.):

1. Identify the actual change shape (Rule 1 table)
2. Identify whether intake criteria fire (Rule 2)
3. If not, do not launch the flow — surface the lighter path

The `sdlc-orchestration` rule layers this step in explicitly.

## Signals from the user

| User says | Interpret as |
|---|---|
| "fix this", "small change", "quick X", "just make it work" | Lightweight; commit + maybe issue |
| "work this milestone", "get the engineering track going" | Address-issues milestone mode; workers within caps, then independent verification and CI |
| "add feature X" without scope qualifier | Medium-default; one focused question if scope unclear |
| "let's plan a new addon / framework / track" | Intake-worthy if substantial |
| "start an intake for X" | Explicit invocation — do intake |
| "run inception on X" | Explicit invocation — full SDLC |
| "what would it take to..." | Plan document, not intake |
| "research X" | Research, not intake |
| "refactor X across the codebase" | Likely intake-worthy if cross-module |

## Agent self-check

Before producing intake, solution profile, option matrix, or invoking an SDLC flow:

- [ ] Does the change meet ≥2 of Rule 2's criteria?
- [ ] Did the user explicitly request the heavier artifact?
- [ ] If neither: do I have a specific reason to escalate, or am I over-reaching?

If self-check returns "over-reaching": produce the lighter set, surface it to the user, and offer the heavier path as a follow-up if they want it.

## Detection patterns (anti-patterns to avoid)

| Symptom | Likely cause |
|---|---|
| `.aiwg/intake/` accumulates partial forms abandoned mid-fill | Intake defaulted-to for too-small work |
| Agent presents "intake or no-intake?" question on every feature | Missing right-sizing step |
| ADRs proliferating for non-decisions ("Added the function") | ADRs treated as obligatory artifact, not decision-records |
| Solution profile written for a bug fix | Phase-launch reflex without right-sizing |
| User has to say "no, just do it" repeatedly | Agent defaulting to heavyweight path |

## Right-sized examples (this conversation as reference)

| Real example from this conversation | Right size | What was done |
|---|---|---|
| Adding `--extension` flag to a role JSON | Light: edit + commit | Done lightweight, no SDLC artifacts |
| Updating sysops `claude-role` install to wire the playwright role | Light: commit + activity log | Done lightweight |
| Designing the `browser-control` addon | Intake-worthy: new addon, new public surface, security implications, multi-component | Intake + plan + ADR + scaffold (correct) |
| Writing this rule | Medium: real governance change | This rule + sdlc-orchestration update + skill clarification (right-sized) |

## Cross-references

- `agentic/code/frameworks/sdlc-complete/rules/sdlc-orchestration.md` — orchestrator layers Rule 6 into flow-launch
- `agentic/code/frameworks/sdlc-complete/skills/intake-wizard/SKILL.md` — clarified scope per this rule
- `agentic/code/addons/aiwg-utils/rules/human-authorization.md` — analogous restraint principle for taking action
- `agentic/code/addons/aiwg-utils/rules/instruction-comprehension.md` — interpreting user signals
- `agentic/code/addons/aiwg-utils/rules/research-before-decision.md` — research-first, separate concern from artifact-size

---

**Rule Status**: ACTIVE
**Last Updated**: 2026-05-22
