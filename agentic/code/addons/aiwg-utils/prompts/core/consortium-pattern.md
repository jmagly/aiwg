# Agent Consortium Pattern

Coordinated multi-agent decision-making for complex technical choices.

## Research Foundation

- **REF-001**: BP-5 - Multi-agent consensus improves decision quality
- **REF-002**: Archetype 2 - Multiple perspectives prevent over-helpfulness

## When to Use

Use consortium pattern when:

1. Decision has significant impact (architecture, security, cost)
2. Multiple valid approaches exist
3. Trade-offs require diverse expertise
4. Stakeholder buy-in matters
5. Risk of single-perspective bias

## Pattern Structure

```
        ┌─────────────────┐
        │   Coordinator   │
        │   (opus)        │
        └────────┬────────┘
                 │ Present decision
                 ▼
    ┌────────────┼────────────┐
    ▼            ▼            ▼
┌───────┐   ┌───────┐   ┌───────┐
│Expert1│   │Expert2│   │Expert3│
│(sonnet│   │(sonnet│   │(sonnet│
└───┬───┘   └───┬───┘   └───┬───┘
    │           │           │
    └─────────┬─────────────┘
              ▼ Perspectives
        ┌─────────────────┐
        │   Coordinator   │
        │   Synthesize    │
        └────────┬────────┘
                 │
                 ▼
         Final Recommendation
```

## Implementation

### Step 1: Frame the Decision

```python
Task(
  subagent_type="consortium-coordinator",
  model="opus",
  prompt="""
    Decision to make: [DECISION_TOPIC]
    Context: [RELEVANT_CONTEXT]
    Constraints: [CONSTRAINTS]

    Frame this decision for consortium review:
    1. State the decision clearly
    2. Identify 2-4 candidate approaches
    3. List evaluation criteria
    4. Note any non-negotiable constraints

    Output: .aiwg/working/consortium/decision-frame.md
  """
)
```

### Step 2: Gather Expert Perspectives (PARALLEL)

**CRITICAL**: Launch ALL experts in a SINGLE message:

```python
# All experts in ONE message for parallel execution
Task(
  subagent_type="security-architect",
  prompt="""
    Review decision: .aiwg/working/consortium/decision-frame.md

    Provide security perspective:
    - Risk assessment for each approach
    - Security implications
    - Recommended mitigations
    - Your ranking with rationale

    Output: .aiwg/working/consortium/perspectives/security.md
  """
)

Task(
  subagent_type="architecture-designer",
  prompt="""
    Review decision: .aiwg/working/consortium/decision-frame.md

    Provide architecture perspective:
    - Scalability implications
    - Maintainability assessment
    - Technical debt considerations
    - Your ranking with rationale

    Output: .aiwg/working/consortium/perspectives/architecture.md
  """
)

Task(
  subagent_type="devops-engineer",
  prompt="""
    Review decision: .aiwg/working/consortium/decision-frame.md

    Provide operations perspective:
    - Deployment complexity
    - Monitoring requirements
    - Operational overhead
    - Your ranking with rationale

    Output: .aiwg/working/consortium/perspectives/operations.md
  """
)
```

### Step 3: Synthesize Consensus

```python
Task(
  subagent_type="consortium-coordinator",
  model="opus",
  prompt="""
    Read all perspectives from: .aiwg/working/consortium/perspectives/

    Synthesize consortium recommendation:

    1. AGREEMENT ANALYSIS
       - Where do experts agree?
       - Where do they diverge?
       - What's driving disagreements?

    2. TRADE-OFF MATRIX
       | Approach | Security | Architecture | Operations | Overall |
       |----------|----------|--------------|------------|---------|

    3. RECOMMENDATION
       - Primary recommendation with rationale
       - Dissenting views acknowledged
       - Conditions/caveats

    4. DECISION RECORD
       - Document as ADR if architectural

    Output: .aiwg/working/consortium/recommendation.md
  """
)
```

## Expert Perspective Format

Each expert should produce:

```markdown
# [Domain] Perspective

**Expert**: [Agent Type]
**Decision**: [Decision Topic]
**Date**: [Timestamp]

## Assessment

### Approach A: [Name]
- **Strengths**: [List]
- **Risks**: [List with severity]
- **Score**: [1-5]

### Approach B: [Name]
- **Strengths**: [List]
- **Risks**: [List with severity]
- **Score**: [1-5]

## Ranking

1. [Best] - [Rationale]
2. [Second] - [Rationale]
3. [Third] - [Rationale]

## Critical Concerns

[Any blocking issues or must-address items]

## Recommended Mitigations

[Specific mitigations regardless of approach chosen]
```

## Consortium Coordinator Agent

```yaml
name: consortium-coordinator
description: Coordinates multi-agent consensus decisions
model: claude-opus-5
tools:
  - Task
  - Read
  - Write

role: |
  You coordinate consortium decisions by:
  1. Framing decisions clearly
  2. Assigning appropriate experts
  3. Synthesizing diverse perspectives
  4. Producing actionable recommendations

  You NEVER make decisions unilaterally.
  You ALWAYS acknowledge dissenting views.
  You DOCUMENT trade-offs transparently.
```

## Common Consortium Compositions

### Architecture Decision

| Expert | Focus |
|--------|-------|
| architecture-designer | Scalability, patterns |
| security-architect | Security implications |
| devops-engineer | Operational impact |
| test-architect | Testability |

### Technology Selection

| Expert | Focus |
|--------|-------|
| architecture-designer | Technical fit |
| devops-engineer | Operational maturity |
| domain-expert | Business alignment |
| legal-liaison | Licensing, compliance |

### Security Decision

| Expert | Focus |
|--------|-------|
| security-architect | Threat assessment |
| privacy-officer | Data protection |
| legal-liaison | Regulatory compliance |
| devops-engineer | Implementation feasibility |

## Anti-Patterns

### ❌ Single Expert Decides

```python
# WRONG - No consortium
Task(architecture-designer, "Make the database decision")
```

### ❌ Sequential Without Synthesis

```python
# WRONG - Experts see each other's work (anchoring bias)
Task(expert-1, "...")
# wait
Task(expert-2, "... also read expert-1's output")  # Bias!
```

### ❌ Coordinator Overrides Experts

```python
# WRONG - Coordinator should synthesize, not override
"Ignore the security concerns and proceed with Option A"
```

## Success Metrics

| Metric | Target |
|--------|--------|
| Expert participation | 100% assigned respond |
| Perspective independence | No cross-contamination |
| Dissent documentation | 100% acknowledged |
| Decision clarity | Single recommendation |

## Related

- `multi-agent-pattern.md` - Base multi-agent pattern
- `parallel-hints.md` - Parallel execution
- `flow-architecture-evolution.md` - Uses consortium for ADRs
