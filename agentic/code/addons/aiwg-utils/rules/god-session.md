---
activation: summary
summary: "Keep agent definitions and sessions focused on bounded responsibilities; decompose broad scopes before context or coherence degrades."
bound_to:
  agents:
    - agentsmith
  skills:
    - add-agent
    - devkit-create-agent
    - smith-agenticdef
triggers:
  - "agent has too many responsibilities"
  - "how do I keep an agent focused"
  - "avoid a god session"
enforcement: high
---

# God-Session Antipattern

**Enforcement Level**: HIGH
**Scope**: All tool-using agents across all platforms
**Addon**: aiwg-utils (core, universal)
**Issue**: #648

## Overview

A god-session is a single agent or session that tries to do everything — research, implementation, testing, documentation, review, and deployment all in one context. God sessions are hard to debug, impossible to parallelize, and produce inconsistent results as the agent runs out of context and coherence.

## Problem Statement

God sessions arise when:
- An agent accumulates responsibilities across multiple domains without decomposing
- A session that starts as a focused task gradually absorbs adjacent work
- An agent definition lists >7 distinct responsibilities or capability areas
- A single prompt asks the agent to "do everything for feature X"

This causes:
- Context exhaustion as the session fills with unrelated information
- Quality degradation in later steps due to early-session focus drift
- Inability to parallelize — everything depends on one sequential thread
- Debugging difficulty — failures are buried in a long, mixed-purpose context
- Inconsistent output quality — early work is coherent; late work is rushed

Delegate bounded independent reads and verification according to `subagent-scoping` Rule 4a (“Delegate by default”), including its mode, cheapest-capable selection and keep-local exits. Coupled work may stay with one focused worker; the orchestrator verifies condensed returns centrally.

## Mandatory Rules

### Rule 1: Bounded Agent Scope

Agent definitions must have a focused, bounded scope. If an agent's responsibilities list contains more than 5–7 distinct domains, it must be decomposed into specialized agents.

**FORBIDDEN**:
```yaml
# Agent with 10+ responsibilities
responsibilities:
  - Research best practices
  - Write requirements
  - Design architecture
  - Implement code
  - Write tests
  - Review code
  - Update documentation
  - Check compliance
  - Deploy to staging
  - Monitor for errors
```

**REQUIRED**:
```
Decompose into focused agents:
  - Research Agent: best practices only
  - Requirements Analyst: requirements only
  - Architecture Designer: design only
  - Software Implementer: implementation only
  - Test Engineer: tests only
  - Code Reviewer: review only
```

### Rule 2: Session Scope Detection

Before starting a session, estimate whether the task spans multiple domains. If it does, decompose before starting — not partway through.

**Warning signs of an impending god session**:

| Signal | Risk |
|--------|------|
| Task description contains 4+ distinct verbs from different domains | High |
| Task touches code, docs, tests, and deployment | High |
| "And also..." appears more than twice in the task | High |
| The task would take a human multiple specialties to complete | High |
| Estimated steps > 20 before the first deliverable | Medium |

### Rule 3: Resist Scope Creep Mid-Session

If a session that started focused discovers adjacent work, resist absorbing it:

**FORBIDDEN**:
```
Task: Fix bug in auth module

Mid-session discovery: Tests are outdated, docs are wrong, security review needed

Action: Absorb all of it and keep going in this session
```

**REQUIRED**:
```
Task: Fix bug in auth module

Mid-session discovery: Tests are outdated, docs are wrong, security review needed

Action:
  1. Fix the bug (stay in scope)
  2. File issues for: test update, doc update, security review
  3. Note discoveries in completion comment
  4. Let separate agents handle the adjacent work
```

### Rule 4: Agent Definition Review

When creating or reviewing agent definitions:
- Count distinct responsibility domains
- If >7: propose decomposition before proceeding
- Ensure each agent has a clear "does not do" list alongside its capabilities

## Detection Patterns

| Symptom | Likely Cause |
|---------|-------------|
| Session runs >2 hours without delivering anything | God session in progress |
| Agent output quality visibly degrades after step 5 | Context overload |
| Agent skips or rushes later steps | God session, running out of space |
| Agent produces contradictory output late in session | Context drift |
| Debugging the agent requires reading >50 steps of history | God session scope |

## Integration with Other Rules

- **subagent-scoping**: God-session prevents at the agent definition level; subagent-scoping prevents at the delegation level
- **instruction-comprehension**: Large instructions that describe god-session tasks should be decomposed before execution
- **context-budget**: God sessions will always exceed context budgets

## References

- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/subagent-scoping.md
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/context-budget.md
- OpenProse antipatterns guidance (research: #617)

---

**Rule Status**: ACTIVE
**Last Updated**: 2026-04-02
