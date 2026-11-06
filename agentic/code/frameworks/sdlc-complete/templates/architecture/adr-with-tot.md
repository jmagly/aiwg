# Architectural Decision Record (ADR) with Tree of Thoughts

---
template_id: adr-with-tot
version: 2.1.0
reasoning_required: true
---

**Template Version:** 2.1 (Tree of Thoughts Enhanced + Reasoning Section)
**Status:** [Proposed | Accepted | Rejected | Deprecated | Superseded]
**Date:** YYYY-MM-DD
**Deciders:** [List key decision makers]
**Decision ID:** ADR-XXX

## Reasoning

> Complete this section BEFORE detailed evaluation. Per @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/reasoning-sections.md

1. **Context Analysis**: What architectural concern does this address?
   > [Describe the specific architectural problem or opportunity driving this decision]

2. **Force Identification**: What forces are in tension?
   > [List competing concerns: performance vs maintainability, security vs usability, etc.]

3. **Option Evaluation**: What alternatives were considered with trade-offs?
   > [Brief overview of k options to be evaluated in detail below]

4. **Decision Justification**: Why is this the best choice given constraints?
   > [High-level rationale that will be supported by detailed scoring]

5. **Consequence Assessment**: What are the positive and negative impacts?
   > [Anticipated outcomes of this decision on the system and team]

## Context

[Describe the architectural problem or opportunity requiring a decision. Include:
- What is driving this decision?
- What constraints exist (technical, business, timeline)?
- What is the scope of impact?
- What NFRs are most relevant?]

## Evaluation Criteria

Define the weighted criteria for evaluating alternatives. Base weights on non-functional requirements (NFRs) priorities.

| Criterion | Weight | Description | Source NFR |
|-----------|--------|-------------|------------|
| Performance | 30% | Response time, throughput requirements | @.aiwg/requirements/nfr-modules/performance.md |
| Scalability | 25% | Ability to handle growth | @.aiwg/requirements/nfr-modules/scalability.md |
| Maintainability | 20% | Code clarity, testability, documentation | @.aiwg/requirements/nfr-modules/maintainability.md |
| Security | 15% | Authentication, authorization, data protection | @.aiwg/requirements/nfr-modules/security.md |
| Cost | 10% | Implementation and operational costs | @.aiwg/requirements/supplemental-specification.md |

**Minimum Acceptable Score:** 65/100

**Critical Criteria:** [List any criteria that are pass/fail regardless of weighted score]
- Example: MUST support GDPR compliance
- Example: MUST integrate with existing auth system

## Options Considered

This section follows the Tree of Thoughts (ToT) pattern: Generate k alternatives → Evaluate each → Score → Select best.

### Option 1: [Name]

**Description:**
[Detailed description of this architectural approach]

**Implementation Approach:**
- [Key technical decisions]
- [Technology choices]
- [Integration points]
- [Deployment model]

**Evaluation:**

| Criterion | Score (0-10) | Rationale |
|-----------|--------------|-----------|
| Performance | 8 | [Why this score?] |
| Scalability | 7 | [Why this score?] |
| Maintainability | 6 | [Why this score?] |
| Security | 9 | [Why this score?] |
| Cost | 5 | [Why this score?] |

**Weighted Score:** [Calculate: (8×0.30 + 7×0.25 + 6×0.20 + 9×0.15 + 5×0.10) × 10 = XX/100]

**Pros:**
- [Strength 1]
- [Strength 2]
- [Strength 3]

**Cons:**
- [Weakness 1]
- [Weakness 2]
- [Weakness 3]

**Critical Criteria Check:**
- [ ] GDPR compliance: [Pass/Fail - explain]
- [ ] Auth integration: [Pass/Fail - explain]

**Risks:**
- [Risk 1 and mitigation]
- [Risk 2 and mitigation]

### Option 2: [Name]

[Repeat structure from Option 1]

### Option 3: [Name]

[Repeat structure from Option 1]

### Option 4: [Name] (Optional)

[Repeat structure from Option 1]

### Option 5: [Name] (Optional)

[Repeat structure from Option 1]

## Options Comparison Matrix

| Option | Performance | Scalability | Maintainability | Security | Cost | **Total** | Pass/Fail? |
|--------|-------------|-------------|-----------------|----------|------|-----------|------------|
| Option 1 | 8 (2.4) | 7 (1.75) | 6 (1.2) | 9 (1.35) | 5 (0.5) | **71** | Pass |
| Option 2 | X (X.X) | X (X.X) | X (X.X) | X (X.X) | X (X.X) | **XX** | Pass/Fail |
| Option 3 | X (X.X) | X (X.X) | X (X.X) | X (X.X) | X (X.X) | **XX** | Pass/Fail |

*Numbers in parentheses show weighted contribution (score × weight)*

## Decision

**Selected Option:** [Option X - Name]

**Decision Rationale:**

[Explain why this option was selected based on:
1. Scoring results (quantitative)
2. Critical criteria satisfaction (qualitative)
3. Risk assessment
4. Stakeholder input
5. Context-specific factors]

This option scored **XX/100** against evaluation criteria, exceeding the minimum threshold of 65/100. It satisfies all critical criteria and presents acceptable risk levels.

**Key Trade-offs Accepted:**
- [Trade-off 1: What we're sacrificing and why it's acceptable]
- [Trade-off 2: What we're sacrificing and why it's acceptable]

## Consequences

### Positive

- [Benefit 1]
- [Benefit 2]
- [Benefit 3]

### Negative

- [Drawback 1 and how we'll manage it]
- [Drawback 2 and how we'll manage it]

### Neutral

- [Change 1 that's neither clearly good nor bad]
- [Change 2 that's neither clearly good nor bad]

## Implementation Notes

**Architectural Components Affected:**
- [Component 1]
- [Component 2]

**Migration Strategy:**
[If replacing existing architecture, describe transition approach]

**Validation Criteria:**
[How will we know this decision was correct? Define measurable outcomes]
- [Metric 1: Target value]
- [Metric 2: Target value]

**Backtracking Triggers:**
[When should we reconsider this decision? Define conditions that would trigger re-evaluation]
- [Trigger 1: Specific condition]
- [Trigger 2: Specific condition]

## Action Items

- [ ] [Task 1 - Owner - Due date]
- [ ] [Task 2 - Owner - Due date]
- [ ] Update architecture diagrams
- [ ] Update software architecture document
- [ ] Communicate decision to stakeholders

## References

- @.aiwg/requirements/supplemental-specification.md - NFR definitions
- @.aiwg/architecture/software-architecture-doc.md - System architecture context
- @.aiwg/requirements/use-cases/UC-XXX-relevant-use-case.md - Related use cases
- [External reference 1]
- [External reference 2]

## Review History

| Date | Reviewer | Status | Notes |
|------|----------|--------|-------|
| YYYY-MM-DD | [Name] | Approved | [Comments] |
| YYYY-MM-DD | [Name] | Approved | [Comments] |

---

## Template Usage Notes

**When to use this template:**
- Technology stack selection
- Architectural pattern choices (microservices vs monolith, event-driven vs request-response)
- Database selection
- Infrastructure decisions (cloud provider, orchestration platform)
- API design approaches
- Security architecture choices

**ToT Decision Process:**
1. **Generate:** Create 3-5 distinct alternatives (k=3 minimum, k=5 recommended)
2. **Evaluate:** Score each against defined criteria with rationale
3. **Compare:** Use comparison matrix to identify highest-scoring option
4. **Select:** Choose best option, documenting trade-offs
5. **Validate:** Define backtracking triggers for re-evaluation

**Evaluation Tips:**
- Use 0-10 scale for scoring (0=completely fails criterion, 10=perfectly meets criterion)
- Base criterion weights on project NFR priorities
- Document scoring rationale to enable future review
- Critical criteria are pass/fail gates independent of weighted score
- Minimum acceptable score should align with project risk tolerance

**Common Pitfalls:**
- Generating alternatives that differ only superficially (ensure real architectural differences)
- Biasing evaluation toward pre-selected option (score objectively)
- Ignoring context-specific factors not captured in criteria
- Failing to define backtracking triggers (how will you know if decision was wrong?)

## Metadata

- **Template Type:** architecture-adr
- **SDLC Phase:** Elaboration, Construction
- **Primary Agent:** @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/agents/architecture-designer.md
- **Related Templates:**
  - @agentic/code/frameworks/sdlc-complete/templates/analysis-design/software-architecture-doc-template.md
  - @agentic/code/frameworks/sdlc-complete/templates/requirements/supplementary-spec-template.md
- **Version:** 2.0.0
- **Last Updated:** 2026-01-25
- **Change Summary:** Added Tree of Thoughts evaluation methodology per issue #97
