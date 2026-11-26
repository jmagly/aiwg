---
enforcement: medium
activation: bound
summary: Pass task-critical facts and file paths to subagents; omit irrelevant history, full documents, and background that cannot affect the result.
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

# Context-Bloat Antipattern

**Enforcement Level**: MEDIUM
**Scope**: All tool-using agents across all platforms
**Addon**: aiwg-utils (core, universal)
**Issue**: #648

## Overview

Context-bloat occurs when an orchestrator passes excessive, unrequested context to a sub-agent. The sub-agent receives full conversation histories, entire file trees, or comprehensive background documentation when it only needs a focused slice. Bloated context degrades output quality, wastes tokens, and often causes the agent to address the wrong portions of its input.

This rule provides a cost-focused angle on the broader scoping concerns in `subagent-scoping.md`. Where subagent-scoping focuses on task scope, context-bloat focuses specifically on the information passed with that task.

## Problem Statement

Context-bloat arises from:
- Forwarding the entire parent conversation history to a sub-agent
- Passing all files in a module when the agent only touches one
- Including full project documentation when the agent needs a single fact
- Pre-loading "background" the agent didn't ask for

This causes:
- Token waste and increased cost per call
- Agent attention diluted across irrelevant context
- Earlier, relevant parts of context displaced by later irrelevant additions
- Hallucination risk increases as the agent pattern-matches against noise

Delegate bounded independent reads and verification according to `subagent-scoping` Rule 4a (“Delegate by default”), including its mode, cheapest-capable selection and keep-local exits. Coupled work may stay with one focused worker; the orchestrator verifies condensed returns centrally.

## Mandatory Rules

### Rule 1: Pass File Paths, Not File Contents (When Agent Will Read Itself)

When a sub-agent will read files as part of its task, pass the path — not the content.

**FORBIDDEN**:
```
Sub-agent prompt:
  Here is the full content of auth.ts (2,400 tokens):
  [entire file]

  Here is the full content of userService.ts (3,100 tokens):
  [entire file]

  Task: Check if validateEmail() handles null input.
```

**REQUIRED**:
```
Sub-agent prompt:
  File: src/auth/validators.ts
  Function: validateEmail()
  Task: Verify null input handling. Read the function directly.
```

### Rule 2: Conversation History Is Almost Never Needed

Sub-agents rarely need the parent session's conversation history. They need facts, not narrative.

**FORBIDDEN**:
```
Sub-agent prompt:
  [50 messages of parent conversation history...]
  Based on all of the above, please check if the tests pass.
```

**REQUIRED**:
```
Sub-agent prompt:
  Context: Refactoring auth module. Tests were green before changes.
  Task: Run npm test and report which tests fail, with error messages.
```

### Rule 3: Limit Background to What the Task Actually Uses

Before including background documentation, ask: "Will the agent's output change if I remove this?" If no, remove it.

**FORBIDDEN**:
```
Sub-agent prompt:
  [Full project architecture document]
  [Full requirements spec]
  [Team profile]
  Task: Fix the null pointer in userService.ts line 42.
```

**REQUIRED**:
```
Sub-agent prompt:
  File: src/services/userService.ts, line 42 (null pointer exception)
  Error: TypeError: Cannot read property 'id' of undefined
  Task: Fix the null pointer. The user object may be undefined — add a guard.
```

### Rule 4: Context Budget Review Before Dispatch

Before dispatching a sub-agent, estimate its context size. If >50% of available context window is background rather than task-critical information, trim aggressively.

| Content Type | Include? | Trim to |
|-------------|----------|---------|
| Task description | Always | Full |
| Relevant code (agent will modify) | Always | Relevant sections only |
| Error messages | Always | Full |
| Related files (agent won't modify) | Rarely | File paths only |
| Project background | Only if load-bearing | Key facts, not documents |
| Conversation history | Almost never | Summary sentence |
| Entire module contents | Never | Specific function/section |

## Detection Patterns

| Symptom | Likely Cause |
|---------|-------------|
| Sub-agent addresses wrong section of input | Attention diluted by context-bloat |
| Sub-agent cost is 5-10× expected | Context far larger than task |
| Sub-agent output summarizes context instead of doing the task | Overwhelmed by input volume |
| Sub-agent references irrelevant prior conversation | History forwarded unnecessarily |

## Integration with Other Rules

- **subagent-scoping**: This rule addresses context quantity; subagent-scoping addresses task scope
- **context-budget**: Context-bloat directly wastes the budget allocated per sub-agent call
- **implicit-dependencies**: The inverse failure — passing too little explicit context (see `implicit-dependencies.md`)

## References

- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/subagent-scoping.md
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/context-budget.md
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/implicit-dependencies.md
- OpenProse antipatterns guidance (research: #617)

---

**Rule Status**: ACTIVE
**Last Updated**: 2026-04-02
