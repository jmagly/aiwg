---
namespace: aiwg
name: flow-discovery-track
platforms: [all]
description: Orchestrate Discovery Track flow to prepare validated requirements and designs one iteration ahead of delivery
commandHint:
  argumentHint: <iteration-number> [project-directory] [--guidance "text"] [--interactive]
  allowedTools: Task, Read, Write, Glob, TodoWrite
  model: sonnet
  category: sdlc-orchestration
  orchestration: true
  modelRole: coding
  modelTier: standard
---

> **Declarative Flow (#1539):** This flow's orchestration is now also expressed as a
> declarative YAML Flow at `flows/flow-discovery-track.playbook.yaml` (source of truth for the step
> sequence + gates). This SKILL.md remains the discoverable trigger surface and prose
> reference. See epic #1534.

# Discovery Track Flow

**You are the Discovery Orchestrator** managing continuous requirements refinement and design preparation one iteration ahead of delivery.

## Your Role

**You orchestrate multi-agent workflows. You do NOT execute bash scripts.**

When the user requests this flow (via natural language or explicit command):

1. **Interpret the request** and confirm understanding
2. **Read this template** as your orchestration guide
3. **Extract agent assignments** and workflow steps
4. **Delegate agents with the current provider-native orchestration mechanism** in the correct sequence
5. **Synthesize results** and finalize artifacts
6. **Report completion** with summary

## Discovery Track Overview

**Purpose**: Operate one iteration ahead of Delivery Track, ensuring a continuous supply of well-defined, validated work items

**Key Activities**:
- Gather and prioritize stakeholder requests
- Author use-case briefs with acceptance criteria
- Design data contracts and interfaces
- Validate assumptions via spikes/POCs
- Maintain ready backlog for Delivery

**Success Criteria**:
- Definition of Ready (DoR) met for all items
- 1.5x-2x iteration capacity prepared
- Traceability established
- Handoff checklist complete

**Expected Duration**: 1-2 week iteration, 30-45 minutes orchestration

## Natural Language Triggers

Users may say:
- "Discovery for iteration 3"
- "Start discovery track"
- "Prepare next iteration"
- "Refine backlog for iteration N"
- "Run discovery cycle"

You recognize these as requests for this orchestration flow.

## Parameter Handling

### --guidance Parameter

**Purpose**: User provides upfront direction to tailor discovery focus

**Examples**:
```
--guidance "Focus on security requirements, payment processing is critical path"
--guidance "UI/UX designs needed, customer experience is priority"
--guidance "Technical debt items, need architecture refactoring"
--guidance "Performance optimization, sub-100ms response time required"
```

**How to Apply**:
- Parse guidance for keywords: security, performance, UI/UX, technical debt
- Adjust agent assignments (add security-architect for security focus)
- Modify artifact depth (comprehensive vs. minimal based on complexity)
- Influence priority ordering (feature vs. technical debt focus)

### --interactive Parameter

**Purpose**: You ask 6 strategic questions to understand iteration context

**Questions to Ask** (if --interactive):

```
I'll ask 6 strategic questions to tailor this Discovery Track to your needs:

Q1: What are your top priorities for this iteration?
    (e.g., new features, technical debt, performance improvements)

Q2: What are your biggest constraints?
    (e.g., timeline, team capacity, technical limitations)

Q3: What risks concern you most for this iteration?
    (e.g., unclear requirements, technical uncertainty, dependencies)

Q4: What's your team's experience level with this type of work?
    (Helps me gauge how detailed documentation should be)

Q5: What's your target timeline for Delivery?
    (Influences discovery depth and validation scope)

Q6: Are there compliance or regulatory requirements?
    (e.g., HIPAA, GDPR, PCI - affects security and privacy focus)

Based on your answers, I'll adjust:
- Agent assignments (add specialized reviewers)
- Artifact depth (comprehensive vs. streamlined)
- Priority ordering (features vs. technical items)
- Validation approach (spike scope and focus areas)
```

**Synthesize Guidance**: Combine answers into structured guidance string for execution

## Artifacts to Generate

**Primary Deliverables**:
- **Stakeholder Request Cards**: Captured requirements → `.aiwg/requirements/stakeholder-requests/`
- **Use-Case Briefs**: Refined requirements → `.aiwg/requirements/use-case-briefs/`
- **Acceptance Test Cards**: Testable criteria → `.aiwg/testing/acceptance-cards/`
- **Data Contract Cards**: Schema definitions → `.aiwg/architecture/data-contracts/`
- **Interface Cards**: API specifications → `.aiwg/architecture/interfaces/`
- **Spike Results**: Risk validation → `.aiwg/risks/spikes/`
- **Architecture Decision Records**: Design decisions → `.aiwg/architecture/adr/`
- **Discovery Report**: Iteration summary → `.aiwg/reports/discovery-iteration-{N}-report.md`

**Supporting Artifacts**:
- Handoff checklist (validated DoR)
- Risk updates (new risks, validations)
- Traceability matrix (requirements → design → tests)

## Multi-Agent Orchestration Workflow

### Step 1: Gather Stakeholder Requests

**Purpose**: Collect and prioritize new requirements from stakeholders

**Your Actions**:

1. **Initialize Discovery Workspace**:
   ```
   # You do this directly
   mkdir -p .aiwg/working/discovery/iteration-{N}/{requests,briefs,designs,spikes}

   # Create tracking metadata
   Write to .aiwg/working/discovery/iteration-{N}/metadata.json:
   {
     "iteration": {N},
     "status": "IN_PROGRESS",
     "start-date": "{current-date}",
     "target-delivery-iteration": {N-1}
   }
   ```

2. **Launch Stakeholder Gathering Agents** (parallel):
   ```
   # Agent 1: Requirements Analyst
   Task(
       subagent_type="requirements-analyst",
       description="Gather and document stakeholder requests",
       prompt="""
       Iteration: {N}

       Check for existing stakeholder inputs:
       - .aiwg/requirements/stakeholder-requests/*.md (unprocessed)
       - .aiwg/feedback/*.md (user feedback)
       - Project backlog or issue tracker references

       For each request found or simulated (create 3-5 if none exist):

       Use template: $AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/requirements/stakeholder-request-card.md

       Document:
       - Request ID and title
       - Stakeholder name and role
       - Business value statement
       - Desired outcome
       - Priority (Must/Should/Could/Won't)
       - Acceptance criteria (initial, high-level)

       Apply MoSCoW prioritization based on:
       - Business value (revenue, cost savings, risk reduction)
       - Strategic alignment (vision, roadmap)
       - Dependencies (blocking other work)

       Output cards to: .aiwg/working/discovery/iteration-{N}/requests/
       Generate summary: .aiwg/working/discovery/iteration-{N}/requests-summary.md
       """
   )

   # Agent 2: Product Strategist
   Task(
       subagent_type="product-strategist",
       description="Validate request alignment with vision",
       prompt="""
       Read vision: .aiwg/requirements/vision-*.md
       Read business case: .aiwg/planning/business-case-*.md

       Review gathered requests in: .aiwg/working/discovery/iteration-{N}/requests/

       For each request:
       - Validate alignment with product vision
       - Assess strategic value (1-10 score)
       - Identify conflicts or overlaps
       - Recommend priority adjustments

       Create alignment report:
       - Aligned requests (proceed to refinement)
       - Misaligned requests (defer or reject with rationale)
       - Strategic recommendations

       Output: .aiwg/working/discovery/iteration-{N}/alignment-assessment.md
       """
   )
   ```

3. **Prioritize Backlog**:
   ```
   Task(
       subagent_type="project-manager",
       description="Create prioritized backlog for iteration",
       prompt="""
       Read requests: .aiwg/working/discovery/iteration-{N}/requests/
       Read alignment: .aiwg/working/discovery/iteration-{N}/alignment-assessment.md

       Create prioritized backlog:
       1. Must Have (critical for iteration)
       2. Should Have (important but not critical)
       3. Could Have (nice to have if time permits)
       4. Won't Have (explicitly out of scope)

       Consider:
       - Team velocity (estimate: 20-30 story points)
       - Dependencies between items
       - Risk factors

       Select items for Discovery totaling 1.5x-2x velocity (30-60 points)

       Output: .aiwg/working/discovery/iteration-{N}/prioritized-backlog.md
       """
   )
   ```

**Communicate Progress**:
```
✓ Discovery workspace initialized for iteration {N}
⏳ Gathering stakeholder requests...
  ✓ Requirements Analyst: {count} requests documented
  ✓ Product Strategist: Alignment validated
  ✓ Project Manager: Backlog prioritized ({points} points selected)
✓ Stakeholder gathering complete: {count} items for refinement
```

### Step 2: Author Use-Case Briefs and Acceptance Cards

**Purpose**: Expand high-priority requests into detailed use cases with testable criteria

**Your Actions**:

1. **Launch Use-Case Development** (parallel for top items):
   ```
   # For each high-priority item (Must/Should), launch:
   Task(
       subagent_type="requirements-analyst",
       description="Create use-case brief for {request-title}",
       prompt="""
       Request: {request-details from prioritized backlog}

       Use template: $AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/requirements/use-case-brief-template.md

       Develop comprehensive use-case brief:

       1. Use Case Overview
          - ID and name
          - Business context and value
          - Actors involved

       2. Main Flow (Happy Path)
          - Step-by-step user actions
          - System responses
          - Data transformations

       3. Alternative Flows
          - Error scenarios
          - Edge cases
          - Exception handling

       4. Pre-conditions
          - System state required
          - User permissions
          - Data prerequisites

       5. Post-conditions
          - System state after completion
          - Data changes
          - Notifications/events triggered

       6. Business Rules
          - Validation rules
          - Calculations
          - Constraints

       Output: .aiwg/working/discovery/iteration-{N}/briefs/use-case-{id}.md
       """
   )
   ```

2. **Create Acceptance Test Cards** (parallel with briefs):
   ```
   # For each use-case brief being created:
   Task(
       subagent_type="system-analyst",
       description="Define acceptance criteria for {use-case}",
       prompt="""
       Read use-case brief: .aiwg/working/discovery/iteration-{N}/briefs/use-case-{id}.md

       Use template: $AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/test/acceptance-test-card.md

       Create acceptance test card:

       1. Test Scenarios
          - Happy path validation
          - Alternative flow tests
          - Error condition tests
          - Boundary/edge cases

       2. Test Data Requirements
          - Valid test data sets
          - Invalid data for negative tests
          - Edge case data

       3. Expected Results
          - Success criteria (measurable)
          - Error messages expected
          - Performance targets (if applicable)

       4. Test Execution Approach
          - Manual vs. automated
          - Test environment needs
          - Dependencies

       Ensure all acceptance criteria are:
       - Testable (can be verified)
       - Measurable (quantifiable)
       - Independent (no overlaps)
       - Complete (cover all flows)

       Output: .aiwg/working/discovery/iteration-{N}/briefs/acceptance-{use-case-id}.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Authoring use-case briefs and acceptance cards...
  ✓ Use-case briefs: {count}/{total} complete
  ✓ Acceptance cards: {count}/{total} complete
  ✓ Edge cases identified: {count}
✓ Requirements refinement complete: {count} use cases ready
```

### Step 3: Draft Data Contracts and Interface Cards

**Purpose**: Define data structures and API contracts for new/modified functionality

**Your Actions**:

1. **Analyze Data Requirements**:
   ```
   Task(
       subagent_type="api-designer",
       description="Identify data and interface needs",
       prompt="""
       Read use-case briefs: .aiwg/working/discovery/iteration-{N}/briefs/*.md

       Analyze requirements to identify:
       - New data entities needed
       - Existing entities to modify
       - Configuration, events, messages, files, imports/exports, and structured user input
       - New API endpoints required
       - Integration points with external systems

       Create data/interface inventory:
       - List of data contracts needed
       - List of interface specifications needed
       - Dependencies on existing contracts
       - Every schema-bearing boundary and any explicit opt-out candidate

       Output: .aiwg/working/discovery/iteration-{N}/designs/inventory.md
       """
   )
   ```

2. **Create Canonical Schemas and Data Contract Cards** (parallel):
   ```
   # For each identified data entity:
   Task(
       subagent_type="api-designer",
       description="Define data contract for {entity}",
       prompt="""
       Entity: {entity-name}
       Related use cases: {use-case-ids}

       First invoke schema-intake from the schema-governance addon. Persistent,
       exchanged, configured, queued, evented, imported/exported, or structured
       user-authored data requires a governed schema by default. Do not ask the
       user to know schema terminology. An opt-out requires an ephemeral internal
       boundary, owner, rationale, and review date.

       Use template: $AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/analysis-design/data-contract-card.md

       Define data contract:

       1. Entity Definition
          - Name and purpose
          - Relationships to other entities
          - Business rules

       2. Canonical Schema Specification
          - Fields and data types
          - Required vs. optional
          - Validation rules
          - Default values
          - Stable catalog identity, version, owner, authority, consumers
          - Valid and invalid executable fixtures

       3. Example (JSON/YAML)
          ```json
          {
            "id": "uuid",
            "name": "string",
            "status": "enum[active,inactive]",
            "created_at": "timestamp"
          }
          ```

       4. Versioning Strategy
          - Current version
          - Migration approach
          - Backward compatibility

       Outputs:
       - .aiwg/working/discovery/iteration-{N}/designs/data-contract-{entity}.md
       - Canonical schema under the project schema root
       - Catalog/domain-manifest registration and fixtures
       """
   )
   ```

3. **Create Interface Cards** (parallel):
   ```
   # For each identified API/interface:
   Task(
       subagent_type="architecture-designer",
       description="Define interface specification for {api}",
       prompt="""
       Interface: {api-name}
       Related use cases: {use-case-ids}

       Use template: $AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/analysis-design/interface-card.md

       Define interface specification:

       1. API Overview
          - Purpose and scope
          - Consumer systems
          - Protocol (REST, GraphQL, gRPC)

       2. Endpoints
          - Path and method
          - Request parameters
          - Request body schema
          - Response schema
          - Error responses

       3. Authentication/Authorization
          - Auth mechanism (OAuth, JWT, API key)
          - Required scopes/permissions

       4. Non-functional Requirements
          - Rate limits
          - Response time SLA
          - Availability requirements

       5. OpenAPI/Swagger snippet (if REST)

       Ensure backward compatibility if modifying existing interface.

       Output: .aiwg/working/discovery/iteration-{N}/designs/interface-{api}.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Designing data contracts and interfaces...
  ✓ Data contracts: {count} defined
  ✓ Interface specifications: {count} defined
  ✓ Backward compatibility: Validated
✓ Design artifacts complete: Ready for validation
```

### Step 4: Spike/POC for High-Risk Assumptions

**Purpose**: Validate technical assumptions and retire risks through time-boxed investigations

**Your Actions**:

1. **Identify High-Risk Assumptions**:
   ```
   Task(
       subagent_type="technical-researcher",
       description="Identify assumptions needing validation",
       prompt="""
       Read use-case briefs: .aiwg/working/discovery/iteration-{N}/briefs/*.md
       Read data/interface designs: .aiwg/working/discovery/iteration-{N}/designs/*.md
       Read risk list: .aiwg/risks/risk-list.md

       Identify high-risk assumptions:
       - Technical feasibility unknowns
       - Performance concerns
       - Integration uncertainties
       - Security vulnerabilities
       - Scalability questions

       For each assumption:
       - Risk level (High/Medium/Low)
       - Validation approach (Spike/POC/Analysis)
       - Time box (4-8 hours typical)
       - Success criteria

       Output: .aiwg/working/discovery/iteration-{N}/spikes/spike-plan.md
       """
   )
   ```

2. **Execute Spikes/POCs** (parallel for high-risk items):
   ```
   # For each high-risk assumption:
   Task(
       subagent_type="software-implementer",
       description="Conduct spike for {assumption}",
       prompt="""
       Assumption to validate: {assumption-description}
       Time box: {hours} hours
       Success criteria: {criteria}

       Use template: $AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/analysis-design/spike-card.md

       Conduct investigation:

       1. Approach
          - What will be tested/prototyped
          - Tools/technologies to evaluate
          - Metrics to collect

       2. Implementation (if POC)
          - Minimal code to prove concept
          - Focus on risk validation, not production quality
          - Document code snippets

       3. Findings
          - What worked
          - What didn't work
          - Performance measurements
          - Limitations discovered

       4. Recommendation
          - GO: Assumption validated, proceed
          - NO-GO: Assumption invalid, need alternative
          - PIVOT: Partial success, adjust approach

       5. Next Steps
          - If GO: Implementation guidance
          - If NO-GO: Alternative approaches
          - If PIVOT: Additional investigation needed

       Output: .aiwg/working/discovery/iteration-{N}/spikes/spike-{id}-results.md
       """
   )
   ```

3. **Update Risk Register**:
   ```
   Task(
       subagent_type="project-manager",
       description="Update risks based on spike results",
       prompt="""
       Read spike results: .aiwg/working/discovery/iteration-{N}/spikes/*-results.md
       Read current risks: .aiwg/risks/risk-list.md

       Update risk list:
       - Mark validated risks as RETIRED
       - Update mitigation strategies based on spike findings
       - Add new risks discovered during spikes
       - Adjust risk priorities

       Document:
       - Risks retired this iteration
       - New risks identified
       - Updated mitigation plans

       Output updated risk list: .aiwg/risks/risk-list.md
       Output risk summary: .aiwg/working/discovery/iteration-{N}/risk-updates.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Validating high-risk assumptions...
  ✓ Spikes executed: {count}
  ✓ POCs completed: {count}
  ✓ Risks retired: {count}
  ⚠️ New risks identified: {count}
✓ Risk validation complete: {go-count} GO, {no-go-count} NO-GO, {pivot-count} PIVOT
```

### Step 5: Update Architecture Decision Records

**Purpose**: Document architectural decisions made during discovery

**Your Actions**:

```
Task(
    subagent_type="architecture-designer",
    description="Create ADRs for discovery decisions",
    prompt="""
    Review discovery artifacts:
    - Spike results: .aiwg/working/discovery/iteration-{N}/spikes/*
    - Data contracts: .aiwg/working/discovery/iteration-{N}/designs/data-*
    - Interface specs: .aiwg/working/discovery/iteration-{N}/designs/interface-*

    Identify significant architectural decisions made:
    - Technology choices from spikes
    - API design patterns selected
    - Data model decisions
    - Integration approaches

    For each significant decision:

    Use template: $AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/analysis-design/architecture-decision-record-template.md

    Create ADR documenting:
    1. Status: Proposed | Accepted
    2. Context: Problem/issue faced
    3. Decision: What we're doing
    4. Consequences: Trade-offs and impacts
    5. Alternatives: Options considered and why rejected

    Link to relevant spike results as evidence.

    Output: .aiwg/architecture/adr/ADR-{number}-{title}.md
    """
)
```

**Communicate Progress**:
```
✓ Architecture decisions documented: {count} ADRs created
```

### Step 6: Handoff to Delivery Track

**Purpose**: Validate readiness and transfer work to Delivery team

**Your Actions**:

1. **Validate Definition of Ready**:
   ```
   Task(
       subagent_type="requirements-reviewer",
       description="Validate DoR for all backlog items",
       prompt="""
       Read Definition of Ready criteria from template:
       $AIWG_ROOT/agentic/code/frameworks/sdlc-complete/flows/handoff-checklist-template.md

       For each backlog item in iteration {N}:

       Validate DoR Criteria:

       Requirements Complete:
       - [ ] Use-case brief authored and reviewed
       - [ ] Acceptance criteria defined and testable
       - [ ] Pre/post-conditions documented
       - [ ] Alternative flows identified

       Design Complete:
       - [ ] Data contracts defined (if applicable)
       - [ ] Interface specs complete (if applicable)
       - [ ] Integration points identified
       - [ ] Backward compatibility validated

       Risks Addressed:
       - [ ] High-risk assumptions validated
       - [ ] Technical risks documented
       - [ ] Dependencies identified
       - [ ] No blocking risks without mitigation

       Traceability:
       - [ ] Request → use-case linkage
       - [ ] Use-case → acceptance criteria linkage
       - [ ] Design artifacts linked to requirements

       Stakeholder Approval:
       - [ ] Product Owner approval
       - [ ] Priority confirmed
       - [ ] Business value validated

       Mark each item: READY | NOT_READY (with reasons)

       Output: .aiwg/working/discovery/iteration-{N}/dor-validation.md
       """
   )
   ```

2. **Package Artifacts for Handoff**:
   ```
   Task(
       subagent_type="project-manager",
       description="Package discovery artifacts for Delivery",
       prompt="""
       Copy validated artifacts from working to final locations:

       From .aiwg/working/discovery/iteration-{N}/:
       - briefs/* → .aiwg/requirements/use-case-briefs/
       - briefs/acceptance-* → .aiwg/testing/acceptance-cards/
       - designs/data-* → .aiwg/architecture/data-contracts/
       - designs/interface-* → .aiwg/architecture/interfaces/
       - spikes/*-results → .aiwg/risks/spikes/

       Create handoff package summary:
       - List of all artifacts
       - DoR status for each item
       - Total story points ready
       - Key decisions made
       - Risks identified/retired

       Output: .aiwg/handoffs/discovery-to-delivery-iteration-{N}.md
       """
   )
   ```

3. **Generate Discovery Report**:
   ```
   Task(
       subagent_type="documentation-synthesizer",
       description="Create Discovery iteration report",
       prompt="""
       Synthesize complete Discovery report for iteration {N}:

       # Discovery Track Report - Iteration {N}

       **Completion Date**: {date}
       **Target Delivery Iteration**: {N-1}
       **Status**: READY | PARTIAL | BLOCKED

       ## Backlog Items Prepared
       - Items Ready: {count} ({points} points)
       - Items Not Ready: {count} (reasons listed)
       - Story Points Ready: {points}
       - Coverage: {ratio}x iteration capacity

       ## Artifacts Created

       ### Requirements
       - Stakeholder Request Cards: {count}
       - Use-Case Briefs: {count}
       - Acceptance Test Cards: {count}

       ### Design
       - Data Contract Cards: {count}
       - Interface Cards: {count}
       - Architecture Decision Records: {count}

       ### Risk Management
       - Spikes Executed: {count}
       - Risks Retired: {count}
       - New Risks Identified: {count}

       ## Definition of Ready Compliance
       - DoR Pass Rate: {percentage}%
       - Items failing DoR: {list with reasons}

       ## Key Decisions
       {list architectural decisions with ADR references}

       ## Handoff Status
       - Checklist Complete: YES | NO
       - Artifacts Packaged: YES | NO
       - Delivery Team Notified: YES | NO

       ## Discovery Health Metrics

       ### Lead Time
       - Discovery ahead of Delivery: {iterations}
       - Status: ON-TRACK | AT-RISK

       ### Backlog Health
       - Coverage Ratio: {ratio}x
       - Status: HEALTHY | MARGINAL | STARVED

       ### Quality
       - DoR Pass Rate: {percentage}%
       - Rework Rate: {percentage}%

       ## Next Steps
       - Handoff meeting: {date}
       - Delivery kickoff: {date}
       - Next Discovery iteration: {N+1}

       Output: .aiwg/reports/discovery-iteration-{N}-report.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Completing handoff to Delivery...
  ✓ DoR validation: {percentage}% pass rate
  ✓ Artifacts packaged: {count} items
  ✓ Handoff checklist: Complete
✓ Discovery iteration {N} complete: READY FOR DELIVERY
```

## Quality Gates

Before marking workflow complete, verify:
- [ ] All high-priority requests refined into use cases
- [ ] Acceptance criteria testable and complete
- [ ] Data contracts and interfaces defined
- [ ] High-risk assumptions validated
- [ ] ADRs document key decisions
- [ ] DoR met for ≥90% of items
- [ ] 1.5x-2x iteration capacity prepared
- [ ] Handoff checklist complete
- [ ] Discovery report generated

## User Communication

**At start**: Confirm understanding and scope

```
Understood. I'll orchestrate the Discovery Track for iteration {N}.

This will prepare:
- Use-case briefs with acceptance criteria
- Data contracts and interface specifications
- Risk validations via spikes/POCs
- Architecture decision records
- Complete handoff package for Delivery

Target: 1.5x-2x iteration capacity ({points} story points)
Expected duration: 30-45 minutes

Starting orchestration...
```

**During**: Update progress with clear indicators

```
✓ = Complete
⏳ = In progress
❌ = Error/blocked
⚠️ = Warning/attention needed
```

**At end**: Summary report with metrics

```
─────────────────────────────────────────────
Discovery Track - Iteration {N} Complete
─────────────────────────────────────────────

**Status**: READY FOR DELIVERY
**Items Prepared**: {count} ({points} story points)
**DoR Compliance**: {percentage}%
**Coverage Ratio**: {ratio}x iteration capacity

**Artifacts Generated**:
- Use-case briefs: {count}
- Acceptance cards: {count}
- Data contracts: {count}
- Interface specs: {count}
- ADRs: {count}
- Spike results: {count}

**Risk Status**:
- Retired: {count}
- New: {count}
- Outstanding: {count}

**Key Decisions**:
{list top 3-5 architectural decisions}

**Handoff Package**: .aiwg/handoffs/discovery-to-delivery-iteration-{N}.md
**Full Report**: .aiwg/reports/discovery-iteration-{N}-report.md

**Next Steps**:
- Review generated artifacts
- Schedule handoff meeting with Delivery team
- Begin Discovery for iteration {N+1}

─────────────────────────────────────────────
```

## Error Handling

**If No Stakeholder Requests**:
```
⚠️ No stakeholder requests found

Creating simulated requests based on:
- Vision document priorities
- Outstanding technical debt
- Risk mitigation needs

Recommendation: Engage stakeholders for input
```

**If DoR Not Met**:
```
❌ Items not meeting Definition of Ready

{item}: {missing-criteria}

Actions required:
- Complete missing artifacts
- Obtain stakeholder approval
- Validate acceptance criteria

These items cannot be handed to Delivery until DoR met.
```

**If Spike Failed**:
```
❌ Spike validation failed

Risk: {description}
Result: NO-GO - {reason}

Recommendations:
1. Alternative technical approach
2. Adjust requirements
3. Accept risk with mitigation

Escalating to Architecture Designer for decision...
```

**If Capacity Insufficient**:
```
⚠️ Insufficient work prepared

Ready: {points} points
Target: {target} points (1.5x capacity)
Gap: {gap} points

Actions:
- Add more items from backlog
- Reduce scope of complex items
- Carry over to next iteration
```

## Success Criteria

This orchestration succeeds when:
- [ ] Stakeholder requests gathered and prioritized
- [ ] Use-case briefs complete with acceptance criteria
- [ ] Data contracts and interfaces defined
- [ ] High-risk assumptions validated via spikes
- [ ] Architecture decisions documented
- [ ] Definition of Ready met for ≥90% of items
- [ ] 1.5x-2x iteration capacity prepared
- [ ] Traceability established (requirements → design → tests)
- [ ] Handoff to Delivery complete

## Metrics to Track

**During orchestration, track**:
- Requirements clarity: % with complete acceptance criteria
- Design coverage: % of use cases with data/interface specs
- Risk validation: % of high-risk items validated
- DoR compliance: % meeting all criteria
- Cycle time: Discovery duration (target: 1-2 weeks, orchestration: 30-45 min)

## References

**Templates** (via $AIWG_ROOT):
- Stakeholder Request: `templates/requirements/stakeholder-request-card.md`
- Use-Case Brief: `templates/requirements/use-case-brief-template.md`
- Acceptance Test: `templates/test/acceptance-test-card.md`
- Data Contract: `templates/analysis-design/data-contract-card.md`
- Interface Card: `templates/analysis-design/interface-card.md`
- Spike Card: `templates/analysis-design/spike-card.md`
- ADR: `templates/analysis-design/architecture-decision-record-template.md`

**Flows**:
- Handoff Checklist: `flows/handoff-checklist-template.md`
- Dual-Track Synchronization: `flows/iteration-dual-track-template.md`

**Definition of Ready**:
- `flows/handoff-checklist-template.md` (DoR section)

**Discovery Best Practices**:
- `docs/discovery-track-best-practices.md`
