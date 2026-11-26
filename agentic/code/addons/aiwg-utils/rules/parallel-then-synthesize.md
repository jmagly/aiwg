---
enforcement: medium
activation: bound
summary: Verify task independence before parallel dispatch; use one focused agent when a unified assessment would require reconciling competing conclusions.
bound_to:
  skills:
    - agent-loop
    - agent-loop-ext
    - aiwg-mission
    - artifact-orchestration
    - chunk
    - fanout
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
    - mission-control
    - orchestrate-project
    - parallel-dispatch
    - ralph
    - ralph-external
    - ralph-resume
    - rlm-batch
    - rlm-mode
    - rlm-prep
    - rlm-query
    - rlm-search
    - rlm-status
  agents:
    - aiwg-orchestrator
    - executive-orchestrator
    - recovery-orchestrator
    - rlm-agent
    - ralph-loop
    - ralph-verifier
    - consortium-coordinator
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
---

# Parallel-Then-Synthesize Antipattern

**Enforcement Level**: MEDIUM
**Scope**: All tool-using agents across all platforms
**Addon**: aiwg-utils (core, universal)
**Issue**: #648

## Overview

Parallel-then-synthesize is a nuanced antipattern: spawning parallel agents for *related* analytical work that feeds into one conclusion, when a single focused agent would do it more efficiently. This is distinct from legitimate parallelism — it specifically targets situations where the tasks are so tightly coupled that coordination overhead and context fragmentation outweigh parallelism benefits.

**Important caveat**: This rule does NOT discourage parallelism for independent tasks. See the distinction table below.

## Problem Statement

Inappropriate parallelism introduces:
- Synthesis overhead that consumes the savings from parallelism
- Context fragmentation — each agent sees a different slice; the synthesizer must reconcile conflicting framings
- Coordination complexity — dependent tasks stall on upstream results
- Redundant work — parallel agents frequently re-analyze the same files with different foci

A single focused agent analyzing one codebase holistically often produces more coherent, internally consistent output than three parallel agents each analyzing a third of it and a synthesizer trying to merge conflicting assessments.

Delegate bounded independent reads and verification according to `subagent-scoping` Rule 4a (“Delegate by default”), including its mode, cheapest-capable selection and keep-local exits. Coupled work may stay with one focused worker; the orchestrator verifies condensed returns centrally.

## Mandatory Rules

### Rule 1: Verify Independence Before Parallelizing

Before spawning parallel agents, verify that each agent's task is genuinely independent — no shared state, no shared output, no need to reconcile conflicting conclusions.

**Independence test**:
- Can each agent complete its task without reference to other agents' work?
- If the agents produce conflicting assessments, is the conflict meaningful (different modules) or a problem (different angles on the same thing)?
- Does the synthesis step require judgment calls about which agent was "right"?

If synthesis requires choosing between conflicting assessments rather than combining complementary outputs, the tasks were not truly independent.

### Rule 2: Prefer Single Agent for Unified Analysis

When tasks are "analyze different aspects of the same codebase/document/system to form a single assessment," use one agent with broader scope rather than parallel specialized agents.

**QUESTIONABLE** (parallel but tightly related):
```
Analysis goal: Is the auth module secure?

Parallel agents:
  Agent A: Review session management
  Agent B: Review password handling
  Agent C: Review token validation

Synthesizer: Merge A, B, C into one security assessment
```

**BETTER** (single focused agent):
```
Analysis goal: Is the auth module secure?

Single agent:
  - Review session management, password handling, and token validation
  - Produce unified security assessment with consistent severity scale
  - Cross-reference findings across all three areas
```

**Note**: The parallel approach may be justified if each analysis is large enough to exceed a single context window, or if the three areas are truly isolated components.

### Rule 3: Legitimate Parallelism Patterns

The following ARE appropriate for parallel dispatch:

| Pattern | Why Legitimate |
|---------|---------------|
| Each agent works on a different file | Outputs never need reconciliation |
| Each agent implements a different feature | Completely independent deliverables |
| Each agent writes tests for a different function | No shared conclusions |
| Broad research sweep (3 sources, 3 agents) | Outputs are additive, not competing |
| One agent drafts, another reviews | Sequential dependency, not parallelism conflict |

### Rule 4: Decision Threshold

Use this heuristic to decide:

```
Ask: "If agents A and B disagree, who wins?"

If the answer is: "The synthesizer must decide" → Single agent is better
If the answer is: "They're about different things, both are right" → Parallel is fine
```

## Legitimate Parallelism Reference

From `subagent-scoping.md` Rule 4 — parallel dispatch IS correct for:
- Multi-file refactoring (one subagent per file)
- Test generation for a module (one subagent per function)
- Security audit of microservices (one subagent per service)

These cases all have the property that each subagent's output stands alone — there is no need to reconcile competing conclusions.

## Detection Patterns

| Symptom | Likely Cause |
|---------|-------------|
| Synthesizer spends more time reconciling conflicts than combining outputs | Tasks were not independent |
| Parallel agents produce redundant findings | Overlapping analytical scope |
| Final synthesis is lower quality than a single-agent draft would be | Context fragmentation hurt coherence |
| Synthesizer discards one agent's work entirely | That agent's task was not independent |

## Integration with Other Rules

- **subagent-scoping**: This rule adds nuance — parallelism is often correct, but not always
- **context-budget**: Inappropriate parallelism wastes budget on coordination overhead
- **god-session**: The opposite failure — one agent absorbing everything when parallelism would help

## References

- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/subagent-scoping.md
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/context-budget.md
- OpenProse antipatterns guidance (research: #617)

---

**Rule Status**: ACTIVE
**Last Updated**: 2026-04-02
