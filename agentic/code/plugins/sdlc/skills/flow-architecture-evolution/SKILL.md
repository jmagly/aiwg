---
namespace: aiwg
name: flow-architecture-evolution
platforms: [all]
description: Orchestrate architecture evolution workflow with ADR management, architecture review, breaking change analysis, and migration planning
commandHint:
  argumentHint: '[trigger-event] [project-directory] [--guidance "text"] [--interactive]'
  allowedTools: 'Task, Read, Write, Glob, TodoWrite'
  model: sonnet
  category: sdlc-orchestration
  orchestration: true
  modelRole: coding
  modelTier: standard
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


# Architecture Evolution Flow

> **Declarative Flow source of truth (#1547):** the orchestration structure of
> this flow — the step DAG, the **four-reviewer parallel panel + synthesis**, and
> the approval gate — is encoded declaratively in
> [`../../flows/flow-architecture-evolution.playbook.yaml`](../../flows/flow-architecture-evolution.playbook.yaml)
> (a `FlowPlaybook` whose review step is a `fanout` panel; capabilities under
> `../../flows/capabilities/`). This is the heavy-flow proof for the agentic
> fan-out extension (`adr-flow-agentic-steps.md`). The prose below remains the
> detailed orchestration guide and the discoverable trigger surface; the YAML is
> authoritative for the step sequence, the panel composition, and the gate.

**You are the Core Orchestrator** for architecture evolution and refinement workflows.

## Your Role

**You orchestrate multi-agent workflows. You do NOT execute bash scripts.**

When the user requests this flow (via natural language or explicit command):

1. **Interpret the request** and identify the architecture change trigger
2. **Read this template** as your orchestration guide
3. **Extract agent assignments** and workflow steps
4. **Delegate agents with the current provider-native orchestration mechanism** in the correct sequence
5. **Synthesize results** and finalize artifacts
6. **Report completion** with evolution summary

## Natural Language Triggers

Users may say:
- "Evolve architecture for scalability"
- "Update architecture for new requirements"
- "Architecture change for performance"
- "Refactor architecture for technical debt"
- "Need to change our database architecture"
- "We need to scale to handle more users"
- "Update SAD with new decisions"
- "Create ADR for technology change"

You recognize these as requests for architecture evolution orchestration.

## Architecture Evolution Overview

**Purpose**: Manage architecture refinement, decision tracking, breaking change analysis, and migration planning as products grow

**Key Activities**:
- Assess architecture evolution trigger and impact scope
- Review current architecture state and identify evolution needs
- Design architecture changes with ADR documentation
- Analyze breaking changes and migration requirements
- Plan migration strategy with rollback options
- Update architecture documentation (SAD, ADRs, diagrams)

**Success Criteria**:
- Architecture decision documented (ADR) and approved
- Breaking changes identified with migration plan
- SAD and diagrams updated to reflect new architecture
- Risk assessment complete with mitigation strategies

## Parameter Handling

### --guidance Parameter

**Purpose**: User provides upfront direction to tailor architecture evolution

**Examples**:
```
--guidance "Focus on security first, HIPAA compliance critical for healthcare data"
--guidance "Performance is critical path, need sub-100ms p95 response time"
--guidance "Tight timeline for migration, minimize breaking changes"
--guidance "Team has limited DevOps experience, need simple deployment model"
```

**How to Apply**:
- Parse for keywords: security, performance, compliance, timeline, breaking changes
- Adjust agent assignments (add security-architect for compliance focus)
- Modify migration strategy (blue-green vs phased based on risk tolerance)
- Influence decision criteria (performance-first vs security-first trade-offs)

### --interactive Parameter

**Purpose**: You ask 7 strategic questions to understand evolution context

**Questions to Ask** (if --interactive):

```
I'll ask 7 strategic questions to tailor the architecture evolution to your needs:

Q1: What's driving this architecture change?
    (e.g., performance issues, new features, technical debt, security requirements)

Q2: What are your top priorities for this evolution?
    (e.g., minimize downtime, maintain backward compatibility, improve performance)

Q3: What are your biggest constraints?
    (e.g., budget, timeline, team expertise, regulatory compliance)

Q4: What architectural risks concern you most?
    (e.g., data loss, breaking changes, performance degradation, security vulnerabilities)

Q5: How mature is your current architecture documentation?
    (e.g., comprehensive SAD exists, minimal docs, out of date)

Q6: What's your team's architecture review experience?
    (e.g., formal ADR process, informal decisions, no review process)

Q7: What's your target timeline for this evolution?
    (e.g., immediate hotfix, next sprint, next quarter, long-term roadmap)

Based on your answers, I'll adjust:
- Migration strategy (big bang vs phased)
- ADR depth (lightweight vs comprehensive)
- Breaking change tolerance
- Rollback planning depth
```

**Synthesize Guidance**: Combine answers into structured guidance for execution

## Architecture Evolution Triggers

### Common Triggers

- **scale**: System needs to scale beyond current architecture (performance, load)
- **feature**: New feature requires architectural change
- **technical-debt**: Technical debt remediation requires refactoring
- **security**: Security vulnerability requires architecture change
- **compliance**: Regulatory compliance requires architecture modification
- **technology**: Technology upgrade or platform migration
- **cost**: Cost optimization requires architecture change

## Artifacts to Generate

**Primary Deliverables**:
- **Architecture Decision Record (ADR)**: Major decision → `.aiwg/architecture/adr/ADR-*.md`
- **Updated SAD**: Architecture changes → `.aiwg/architecture/software-architecture-doc.md`
- **Migration Plan**: Step-by-step migration → `.aiwg/deployment/migration-plan-*.md`
- **Rollback Plan**: Emergency procedures → `.aiwg/deployment/rollback-plan-*.md`
- **Impact Assessment**: Breaking changes → `.aiwg/reports/impact-assessment-*.md`
- **Architecture Evolution Report**: Summary → `.aiwg/reports/architecture-evolution-*.md`

**Supporting Artifacts**:
- Component diagrams (updated)
- API specifications (if APIs change)
- Data migration scripts (if data model changes)

## Multi-Agent Orchestration Workflow

### Step 1: Architecture Review Trigger Assessment

**Purpose**: Document trigger event and assess impact scope

**Your Actions**:

1. **Read Current Architecture State**:
   ```
   Read and analyze:
   - .aiwg/architecture/software-architecture-doc.md (current state)
   - .aiwg/architecture/adr/*.md (past decisions)
   - .aiwg/risks/risk-list.md (architectural risks)
   ```

2. **Launch Impact Assessment**:
   ```
   Task(
       subagent_type="system-analyst",
       description="Assess architecture change trigger and impact",
       prompt="""
       Trigger event: {user-provided trigger description}

       Read current architecture from SAD and ADRs.

       Document in Impact Assessment:
       1. Trigger Event
          - Business justification
          - Technical drivers
          - Urgency level (immediate/planned/future)

       2. Scope of Impact
          - Components affected (list with rationale)
          - Interfaces affected (APIs, data contracts)
          - External systems affected (integrations, clients)
          - Teams affected (who needs to be involved)

       3. Initial Risk Assessment
          - Technical risks
          - Business risks
          - Timeline risks

       Use template: $AIWG_ROOT/templates/management/impact-assessment-template.md

       Save to: .aiwg/working/architecture-evolution/impact-assessment-draft.md
       """
   )
   ```

**Communicate Progress**:
```
✓ Architecture evolution triggered by: {trigger}
⏳ Assessing impact scope...
✓ Impact assessment complete: {X} components, {Y} interfaces affected
```

### Step 2: Architecture Options Analysis

**Purpose**: Identify and evaluate architecture options

**Your Actions**:

1. **Launch Parallel Analysis** (multiple agents):
   ```
   # Agent 1: Architecture Designer - Options
   Task(
       subagent_type="architecture-designer",
       description="Identify architecture options",
       prompt="""
       Based on trigger: {trigger}
       Impact assessment: .aiwg/working/architecture-evolution/impact-assessment-draft.md

       Identify at least 3 architecture options:

       For each option document:
       - Description (high-level approach)
       - Components changed
       - Technology changes (if any)
       - Estimated complexity (Low/Medium/High)
       - Rough cost estimate
       - Timeline estimate

       Consider patterns:
       - Strangler Fig (gradual replacement)
       - Big Bang (all at once)
       - Parallel Run (old and new together)
       - Blue-Green (instant switch)
       - Canary (gradual rollout)

       Save to: .aiwg/working/architecture-evolution/architecture-options.md
       """
   )

   # Agent 2: Senior Developer - Technical Feasibility
   Task(
       subagent_type="senior-developer",
       description="Evaluate technical feasibility",
       prompt="""
       Review architecture options: .aiwg/working/architecture-evolution/architecture-options.md

       For each option assess:
       - Technical complexity (implementation difficulty)
       - Team capability (do we have the skills?)
       - Technology maturity (proven vs experimental)
       - Integration complexity
       - Testing complexity

       Recommend prototypes if needed for high-risk options.

       Save to: .aiwg/working/architecture-evolution/feasibility-assessment.md
       """
   )
   ```

2. **Synthesize Option Matrix**:
   ```
   Task(
       subagent_type="architecture-designer",
       description="Create option comparison matrix",
       prompt="""
       Read all analyses:
       - Architecture options
       - Feasibility assessment

       Create option matrix using template:
       $AIWG_ROOT/templates/intake/option-matrix-template.md

       Score each option on:
       - Cost (1-5, lower is better)
       - Complexity (1-5, lower is better)
       - Risk (1-5, lower is better)
       - Timeline (weeks/months)
       - Benefits (1-5, higher is better)

       Calculate weighted score.
       Recommend preferred option with rationale.

       Save to: .aiwg/working/architecture-evolution/option-matrix.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Analyzing architecture options...
  ✓ 3 options identified
  ✓ Feasibility assessed
  ✓ Option matrix complete
✓ Recommended option: {option-name} (score: {score})
```

### Step 3: Create Architecture Decision Record (ADR)

**Purpose**: Document the architecture decision formally

**Your Actions**:

```
Task(
    subagent_type="architecture-designer",
    description="Create ADR for architecture decision",
    prompt="""
    Based on analysis:
    - Impact assessment
    - Option matrix (preferred option)

    Create comprehensive ADR using template:
    $AIWG_ROOT/templates/analysis-design/architecture-decision-record-template.md

    Structure:
    1. Title: Clear, descriptive (e.g., "Migration from PostgreSQL to DynamoDB")

    2. Status: PROPOSED (will become ACCEPTED after review)

    3. Context
       - What issue are we addressing?
       - Current state description
       - Business/technical drivers

    4. Decision
       - What we're changing
       - Chosen approach (from option matrix)
       - Key design details

    5. Consequences
       - Positive impacts (benefits)
       - Negative impacts (trade-offs)
       - Risks and mitigations

    6. Alternatives Considered
       - Other options from matrix
       - Why each was rejected

    Number sequentially based on existing ADRs in .aiwg/architecture/adr/

    Save to: .aiwg/architecture/adr/ADR-{number:03d}-{slug}.md
    """
)
```

**Communicate Progress**:
```
⏳ Creating Architecture Decision Record...
✓ ADR created: ADR-{number}-{title}
```

### Step 4: Breaking Change and Migration Analysis

**Purpose**: Identify breaking changes and plan migration

**Your Actions**:

1. **Launch Breaking Change Analysis** (parallel agents):
   ```
   # Agent 1: API Designer - Interface Changes
   Task(
       subagent_type="api-designer",
       description="Identify API breaking changes",
       prompt="""
       Compare current vs proposed architecture.

       Identify breaking changes:
       - API endpoint changes (removed, modified signatures)
       - Data contract changes (schema modifications)
       - Protocol changes (REST to gRPC, etc.)
       - Authentication changes

       For each breaking change:
       - Description of change
       - Affected consumers (internal/external)
       - Backward compatibility options
       - Migration approach

       Save to: .aiwg/working/architecture-evolution/api-breaking-changes.md
       """
   )

   # Agent 2: Data Architect - Data Changes
   Task(
       subagent_type="data-architect",
       description="Identify data model changes",
       prompt="""
       Analyze data architecture changes.

       Identify:
       - Schema changes (tables, columns, types)
       - Data migration requirements
       - Data integrity risks
       - Rollback data considerations

       Document migration strategy:
       - Online migration (zero downtime)
       - Offline migration (maintenance window)
       - Dual write period

       Save to: .aiwg/working/architecture-evolution/data-migration-analysis.md
       """
   )
   ```

2. **Create Migration Plan**:
   ```
   Task(
       subagent_type="deployment-manager",
       description="Create detailed migration plan",
       prompt="""
       Based on breaking changes and chosen architecture option.

       Use template: $AIWG_ROOT/templates/deployment/migration-plan-template.md

       Define migration strategy:
       - Pattern (Strangler Fig, Blue-Green, Canary, Big Bang)
       - Phases (if phased approach)
       - Timeline with milestones
       - Go/No-Go gates

       For each phase document:
       - Scope (what migrates)
       - Steps (detailed runbook)
       - Validation (how to verify success)
       - Rollback trigger conditions

       Include:
       - Pre-migration checklist
       - Migration runbook
       - Post-migration validation
       - Communication plan

       Save to: .aiwg/deployment/migration-plan-{date}.md
       """
   )
   ```

3. **Create Rollback Plan**:
   ```
   Task(
       subagent_type="deployment-manager",
       description="Create rollback plan",
       prompt="""
       Based on migration plan.

       Use template: $AIWG_ROOT/templates/deployment/rollback-plan-template.md

       Document:
       1. Rollback Triggers
          - Error thresholds
          - Performance degradation
          - Data corruption indicators

       2. Rollback Procedures
          - Step-by-step instructions
          - Data restoration steps
          - Configuration rollback

       3. Rollback Testing
          - How to test rollback in staging
          - Validation steps

       Save to: .aiwg/deployment/rollback-plan-{date}.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Analyzing breaking changes and migration requirements...
  ✓ API breaking changes: {count}
  ✓ Data migration requirements identified
  ✓ Migration plan created: {strategy} pattern
  ✓ Rollback plan documented
✓ Migration planning complete
```

### Step 5: Multi-Agent Architecture Review

**Purpose**: Review proposed changes with specialized architects

**Your Actions**:

**Launch Parallel Reviews**:
```
# Security Architect Review
Task(
    subagent_type="security-architect",
    description="Review architecture evolution security impact",
    prompt="""
    Review:
    - ADR: .aiwg/architecture/adr/ADR-{latest}.md
    - Migration plan: .aiwg/deployment/migration-plan-{date}.md

    Validate:
    - Security controls maintained/improved
    - Authentication/authorization impacts
    - Data encryption during migration
    - Audit trail continuity
    - Compliance implications

    Provide feedback:
    - Security risks identified
    - Required security controls
    - Recommendations

    Status: APPROVED | CONDITIONAL | NEEDS_WORK

    Save to: .aiwg/working/architecture-evolution/reviews/security-review.md
    """
)

# Test Architect Review
Task(
    subagent_type="test-architect",
    description="Review testability impact",
    prompt="""
    Review proposed architecture changes.

    Assess:
    - Test strategy updates needed
    - Test environment changes
    - Test data migration
    - Regression test scope
    - Performance test updates

    Provide recommendations for:
    - Migration testing approach
    - Rollback testing
    - Post-migration validation

    Save to: .aiwg/working/architecture-evolution/reviews/test-review.md
    """
)

# Performance Engineer Review (if performance-related)
Task(
    subagent_type="performance-engineer",
    description="Review performance implications",
    prompt="""
    Analyze performance impact of architecture changes.

    Review:
    - Scalability improvements/degradations
    - Latency impacts
    - Throughput changes
    - Resource utilization

    Recommend:
    - Performance testing requirements
    - Monitoring updates
    - Performance baselines

    Save to: .aiwg/working/architecture-evolution/reviews/performance-review.md
    """
)

# Legacy Modernizer Review (if modernizing legacy)
Task(
    subagent_type="legacy-modernizer",
    description="Review legacy system migration approach",
    prompt="""
    Review migration strategy for legacy components.

    Assess:
    - Legacy system dependencies
    - Data migration complexity
    - Integration point changes
    - Gradual vs big-bang approach

    Validate migration strategy minimizes risk.

    Save to: .aiwg/working/architecture-evolution/reviews/legacy-review.md
    """
)
```

**Communicate Progress**:
```
⏳ Conducting architecture reviews (4 parallel reviewers)...
  ✓ Security Architect: {status}
  ✓ Test Architect: {status}
  ✓ Performance Engineer: {status}
  ✓ Legacy Modernizer: {status}
✓ Reviews complete: {X}/4 APPROVED
```

### Step 6: Update Architecture Documentation

**Purpose**: Update SAD and related documentation

**Your Actions**:

1. **Update Software Architecture Document**:
   ```
   Task(
       subagent_type="architecture-documenter",
       description="Update SAD with architecture changes",
       prompt="""
       Update Software Architecture Document based on:
       - Approved ADR
       - Review feedback

       Updates needed:
       1. Component Architecture (if components change)
       2. Deployment Architecture (if deployment changes)
       3. Technology Stack (if technologies change)
       4. Integration Architecture (if integrations change)
       5. Security Architecture (if security changes)
       6. Data Architecture (if data model changes)
       7. Reference new ADR in decisions section

       Maintain version history.
       Mark sections as "Updated: {date}".

       Save to: .aiwg/architecture/software-architecture-doc.md
       """
   )
   ```

2. **Update Diagrams** (if needed):
   ```
   Task(
       subagent_type="architecture-documenter",
       description="Update architecture diagrams",
       prompt="""
       Based on architecture changes, update:

       1. Component diagrams (C4 Level 2)
       2. Deployment diagrams
       3. Data flow diagrams
       4. Sequence diagrams (if flows change)

       Use PlantUML or Mermaid syntax.
       Include before/after comparison if helpful.

       Save to: .aiwg/architecture/diagrams/
       """
   )
   ```

**Communicate Progress**:
```
⏳ Updating architecture documentation...
  ✓ SAD updated (version {version})
  ✓ Diagrams updated: {count} diagrams
✓ Documentation complete
```

### Step 7: Generate Architecture Evolution Report

**Purpose**: Create comprehensive summary for stakeholders

**Your Actions**:

```
Task(
    subagent_type="architecture-documenter",
    description="Generate Architecture Evolution Report",
    prompt="""
    Synthesize all artifacts into executive summary.

    # Architecture Evolution Report

    **Date**: {current-date}
    **Trigger**: {trigger-event}
    **Status**: PLANNING | IN_PROGRESS | COMPLETED

    ## Executive Summary
    Brief description of change and business justification

    ## Architecture Decision
    - ADR ID: {ADR-number}
    - Decision: {decision-summary}
    - Selected Option: {option-name}
    - Rationale: {brief-rationale}

    ## Impact Analysis
    - Components Affected: {count} - {list}
    - Breaking Changes: {count}
    - Teams Affected: {list}

    ## Migration Plan
    - Strategy: {migration-pattern}
    - Timeline: {start} to {end}
    - Phases: {count}
    - Rollback Plan: DEFINED

    ## Risk Assessment
    - Technical Risks: {list with mitigation}
    - Business Risks: {list with mitigation}

    ## Review Status
    - Security: {APPROVED/CONDITIONAL}
    - Testing: {APPROVED/CONDITIONAL}
    - Performance: {APPROVED/CONDITIONAL}

    ## Next Steps
    1. Obtain stakeholder approval
    2. Schedule migration windows
    3. Execute migration plan

    ## Artifacts Generated
    - ADR: .aiwg/architecture/adr/ADR-{number}.md
    - Migration Plan: .aiwg/deployment/migration-plan-{date}.md
    - Rollback Plan: .aiwg/deployment/rollback-plan-{date}.md
    - Updated SAD: .aiwg/architecture/software-architecture-doc.md

    Save to: .aiwg/reports/architecture-evolution-{date}.md
    """
)
```

**Present to User**:
```
─────────────────────────────────────────────
Architecture Evolution Complete
─────────────────────────────────────────────

**Trigger**: {trigger-event}
**Decision**: {architecture-decision}
**Migration Strategy**: {strategy}

**Key Changes**:
- {change-1}
- {change-2}
- {change-3}

**Breaking Changes**: {count}
**Migration Timeline**: {timeline}

**Review Status**:
✓ Security: APPROVED
✓ Testing: APPROVED
✓ Performance: APPROVED

**Artifacts Generated**:
- ADR-{number}: {title}
- Migration Plan: {strategy} approach
- Rollback Plan: Defined with triggers
- Updated SAD: Version {version}

**Next Steps**:
1. Review generated artifacts
2. Schedule stakeholder review meeting
3. Obtain formal approvals
4. Schedule migration windows
5. Execute migration plan

Full report: .aiwg/reports/architecture-evolution-{date}.md
─────────────────────────────────────────────
```

## Migration Patterns Reference

### Strangler Fig Pattern
- **Use Case**: Gradual legacy replacement
- **Advantages**: Low risk, incremental
- **Disadvantages**: Longer timeline, dual maintenance

### Blue-Green Deployment
- **Use Case**: Zero-downtime with instant rollback
- **Advantages**: Fast rollback, full testing
- **Disadvantages**: Double infrastructure cost

### Canary Deployment
- **Use Case**: Gradual rollout with monitoring
- **Advantages**: Early issue detection
- **Disadvantages**: Complex routing

### Big Bang Migration
- **Use Case**: Simple systems, maintenance window available
- **Advantages**: Fast, clean
- **Disadvantages**: High risk, downtime required

### Parallel Run
- **Use Case**: Validation without risk
- **Advantages**: Safe validation
- **Disadvantages**: Dual infrastructure, data sync complexity

## Quality Gates

Before marking workflow complete, verify:
- [ ] Impact assessment documented
- [ ] At least 3 options evaluated
- [ ] ADR created and reviewed
- [ ] Breaking changes identified
- [ ] Migration plan with rollback strategy
- [ ] Architecture documentation updated
- [ ] Review approvals obtained

## Error Handling

**If No Current Architecture Documentation**:
```
❌ No Software Architecture Document found

Cannot evolve architecture without baseline.
Recommendation: Create initial SAD first
- Run: /flow-inception-to-elaboration
- Or: Document current architecture manually
```

**If Migration Risk Too High**:
```
⚠️ High-risk migration detected

Critical risks identified:
- {risk-1}: {description}
- {risk-2}: {description}

Recommendation:
- Consider phased approach instead of big bang
- Add extensive rollback testing
- Plan for parallel run period
```

**If Review Conflicts**:
```
⚠️ Architecture review conflict

Conflict between reviewers:
- {Reviewer-1}: {position}
- {Reviewer-2}: {opposing-position}

Escalating to user for decision...
Trade-off analysis provided in review documents.
```

## Success Criteria

This orchestration succeeds when:
- [ ] Architecture evolution trigger assessed
- [ ] Multiple options analyzed (≥3)
- [ ] ADR created and approved
- [ ] Breaking changes documented
- [ ] Migration plan created with rollback
- [ ] Architecture documentation updated
- [ ] Review approvals obtained
- [ ] Evolution report generated

## Metrics to Track

- Decision velocity: Time from trigger to ADR approval
- Option quality: Number of viable options identified
- Breaking change ratio: Breaking vs non-breaking changes
- Review consensus: Approval rate across reviewers
- Migration complexity: Phases and timeline

## References

**Templates** (via $AIWG_ROOT):
- ADR: `templates/analysis-design/architecture-decision-record-template.md`
- Impact Assessment: `templates/management/impact-assessment-template.md`
- Migration Plan: `templates/deployment/migration-plan-template.md`
- Rollback Plan: `templates/deployment/rollback-plan-template.md`
- Option Matrix: `templates/intake/option-matrix-template.md`

**Related Flows**:
- `flow-inception-to-elaboration` - Initial architecture creation
- `flow-change-control` - Change approval process
- `flow-gate-check` - Gate validation

**Architecture Patterns**:
- Martin Fowler's Strangler Fig Pattern
- Blue-Green Deployment Pattern
- Canary Release Pattern