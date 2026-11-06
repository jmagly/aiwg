---
enforcement: medium
activation: paths
summary: Include a numbered Reasoning section in artifact templates, documenting constraints, alternatives, decision rationale, and risks before finalizing content.
bound_to:
  skills:
    - artifact-orchestration
  agents:
    - requirements-analyst
    - architecture-designer
    - test-documenter
    - technical-writer
  flows: []
paths:
  - agentic/code/frameworks/sdlc-complete/templates/**
  - .aiwg/requirements/**
  - .aiwg/architecture/**
  - .aiwg/testing/**
triggers:
  - what reasoning sections do SDLC templates need
---

# Reasoning Sections Rules

**Enforcement Level**: MEDIUM
**Scope**: All artifact-generating templates
**Research Basis**: REF-016 Chain-of-Thought Prompting
**Issue**: #157

## Overview

These rules mandate explicit reasoning sections in all artifact templates following Chain-of-Thought patterns for improved quality and transparency.

## Research Foundation

From REF-016 Chain-of-Thought Prompting (Wei et al., 2022):
- CoT prompting improves reasoning task performance by 2-4x
- Explicit reasoning chains reduce errors in complex tasks
- Numbered steps structure thinking effectively
- Reasoning transparency enables better review and validation

## Required Reasoning Structure

### Standard Reasoning Section

All artifact templates MUST include a `## Reasoning` section with numbered steps:

```markdown
## Reasoning

1. **Problem Analysis**: [What is the core challenge?]
2. **Constraint Identification**: [What are the key constraints?]
3. **Alternative Consideration**: [What options were evaluated?]
4. **Decision Rationale**: [Why this approach?]
5. **Risk Assessment**: [What could go wrong?]
```

### Reasoning Steps by Artifact Type

#### Use Cases

```markdown
## Reasoning

1. **Actor Analysis**: Who are the stakeholders and what are their goals?
2. **Scope Definition**: What is in/out of scope for this use case?
3. **Flow Identification**: What is the primary success path?
4. **Exception Handling**: What can go wrong and how should we handle it?
5. **Dependency Analysis**: What other use cases or systems are involved?
```

#### Architecture Decisions (ADR)

```markdown
## Reasoning

1. **Context Analysis**: What architectural concern does this address?
2. **Force Identification**: What forces are in tension?
3. **Option Evaluation**: What alternatives were considered with trade-offs?
4. **Decision Justification**: Why is this the best choice given constraints?
5. **Consequence Assessment**: What are the positive and negative impacts?
```

#### User Stories

```markdown
## Reasoning

1. **User Need**: Why does the user need this capability?
2. **Value Proposition**: What value does this deliver?
3. **Acceptance Definition**: How will we know this is complete?
4. **Implementation Consideration**: What technical approach is suggested?
5. **Risk Identification**: What could prevent successful delivery?
```

#### Test Plans

```markdown
## Reasoning

1. **Test Scope**: What functionality is being validated?
2. **Risk Priority**: What are the highest-risk areas to test?
3. **Coverage Strategy**: How do we achieve adequate coverage?
4. **Resource Assessment**: What resources and data are needed?
5. **Quality Criteria**: What constitutes passing vs failing?
```

#### Requirements

```markdown
## Reasoning

1. **Need Justification**: Why is this requirement necessary?
2. **Stakeholder Impact**: Who benefits from this requirement?
3. **Feasibility Assessment**: Is this technically achievable?
4. **Priority Rationale**: Why this priority level?
5. **Verification Strategy**: How will we verify this is met?
```

## Template Integration

### Template Structure

Every artifact template MUST include:

```markdown
---
template_id: {template_id}
version: {version}
reasoning_required: true
---

# {Artifact Title}

## Summary
[Brief description]

## Reasoning
[Required numbered reasoning section]

## Content
[Main artifact content]

## References
[Supporting references]
```

### Agent Instruction

Agents MUST be instructed to populate reasoning sections:

```markdown
## Instructions

When creating {artifact_type}:

1. BEFORE writing the main content, complete the Reasoning section
2. Use numbered steps (1. 2. 3. format)
3. Be explicit about trade-offs and alternatives
4. Document any assumptions made
5. The reasoning section is NOT optional
```

## Validation Rules

### Pre-Commit Validation

Before committing artifacts, validate:

1. **Reasoning section exists**
2. **Minimum 3 reasoning steps**
3. **Steps are numbered**
4. **Steps are substantive** (>10 words each)

### Quality Checks

| Check | Pass Criteria |
|-------|---------------|
| Section present | `## Reasoning` heading exists |
| Step count | >= 3 numbered steps |
| Step format | Numbered (1. 2. 3.) |
| Step content | Each step > 10 words |
| Bold headers | Each step has **bold** header |

## Agent Protocol

### During Artifact Generation

```yaml
generate_artifact:
  steps:
    - load_template
    - understand_context
    - COMPLETE_REASONING_FIRST
    - generate_main_content
    - validate_reasoning_section
    - finalize_artifact
```

### Reasoning-First Pattern

```yaml
reasoning_first:
  instruction: |
    Before generating {artifact_type}, work through these
    reasoning steps and document them in the Reasoning section:

    1. **Problem Analysis**: What problem are we solving?
    2. **Constraint Identification**: What limits our options?
    3. **Alternative Consideration**: What other approaches exist?
    4. **Decision Rationale**: Why is our approach best?
    5. **Risk Assessment**: What could go wrong?

    Only after completing reasoning, proceed to main content.
```

## Examples

### Good Example

```markdown
## Reasoning

1. **Problem Analysis**: The authentication system needs to support
   both internal users (employees) and external users (customers)
   with different security requirements and access patterns.

2. **Constraint Identification**: We must comply with SOC2 requirements,
   support existing LDAP infrastructure for internal users, and provide
   self-service registration for external users.

3. **Alternative Consideration**: Evaluated (a) single auth provider for
   all users, (b) separate auth systems, (c) federated identity. Option
   (c) provides flexibility while maintaining security boundaries.

4. **Decision Rationale**: Federated identity chosen because it allows
   different security policies per user type while presenting a unified
   authentication experience to applications.

5. **Risk Assessment**: Federation complexity may increase debugging
   difficulty. Mitigation: comprehensive logging and monitoring.
```

### Bad Example (Insufficient)

```markdown
## Reasoning

1. We need authentication
2. Using OAuth
3. Done
```

## Templates to Update

The following templates MUST include reasoning sections:

| Template | Location |
|----------|----------|
| Use Case | `agentic/code/frameworks/sdlc-complete/templates/requirements/use-case-spec-template.md` |
| User Story | `agentic/code/frameworks/sdlc-complete/templates/requirements/user-story-card.md` |
| ADR | `agentic/code/frameworks/sdlc-complete/templates/governance/adr-template.md` |
| Test Plan | `agentic/code/frameworks/sdlc-complete/templates/test/master-test-plan-template.md` |
| Requirement | `agentic/code/frameworks/sdlc-complete/templates/requirements/stakeholder-request-card-template.md` |
| Architecture | `agentic/code/frameworks/sdlc-complete/templates/analysis-design/software-architecture-doc-template.md` |

## Benefits

1. **Quality Improvement**: Explicit reasoning catches errors earlier
2. **Review Efficiency**: Reviewers can evaluate reasoning, not just output
3. **Knowledge Transfer**: Reasoning documents decision context
4. **Consistency**: Structured thinking produces consistent artifacts
5. **Learning**: Reasoning sections enable learning from past decisions

## References

- @.aiwg/research/findings/REF-016-chain-of-thought.md - CoT research
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/ - Templates to update
- @.aiwg/research/synthesis/topic-03-cognitive-scaffolding.md - Cognitive patterns
- #157 - Implementation issue

---

**Rule Status**: ACTIVE
**Last Updated**: 2026-01-25
