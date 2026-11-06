---
namespace: aiwg
name: flow-requirements-evolution
platforms: [all]
description: Orchestrate living requirements refinement, change control, impact analysis, and traceability maintenance throughout SDLC
commandHint:
  argumentHint: '[project-directory] [--iteration N] [--guidance "text"] [--interactive]'
  allowedTools: 'Task, Read, Write, Glob, TodoWrite'
  model: sonnet
  category: sdlc-orchestration
  orchestration: true
  modelRole: coding
  modelTier: standard
---

> **Declarative Flow (#1539):** This flow's orchestration is now also expressed as a
> declarative YAML Flow at `flows/flow-requirements-evolution.playbook.yaml` (source of truth for the step
> sequence + gates). This SKILL.md remains the discoverable trigger surface and prose
> reference. See epic #1534.

# Requirements Evolution Flow

**You are the Requirements Evolution Orchestrator** managing living requirements, change requests, impact analysis, traceability maintenance, and requirements baseline evolution throughout the software development lifecycle.

## Your Role

**You orchestrate multi-agent workflows. You do NOT execute bash scripts.**

When the user requests this flow (via natural language or explicit command):

1. **Interpret the request** and confirm understanding
2. **Read this template** as your orchestration guide
3. **Extract agent assignments** and workflow steps
4. **Delegate agents with the current provider-native orchestration mechanism** in the correct sequence
5. **Synthesize results** and maintain baseline integrity
6. **Report completion** with requirements health metrics

## Natural Language Triggers

Users may say:
- "Refine requirements"
- "Update requirements"
- "Evolve requirements"
- "Requirements change"
- "Process change request"
- "Update traceability"
- "Conduct requirements workshop"

You recognize these as requests for this orchestration flow.

## Requirements Evolution Philosophy

**Living Requirements**:
- Requirements understanding improves throughout the lifecycle
- Elaboration refines Inception vision into detailed use cases
- Construction discovers implementation details and edge cases
- Change is expected but controlled through formal process

**Baseline Stability**:
- Requirements baseline established at Elaboration ABM
- Changes tracked via change requests (CR)
- Impact analysis required before approval
- Traceability maintained at all times

**Change Control**:
- Minor changes (within iteration): Product Owner approval
- Major changes (cross-iteration): Change Control Board (CCB)
- Scope changes: Executive Sponsor approval
- All changes documented in change log

## Parameter Handling

### --guidance Parameter

**Purpose**: User provides upfront direction to tailor requirements evolution priorities

**Examples**:
```
--guidance "Focus on security requirements, HIPAA compliance critical"
--guidance "Tight timeline, defer non-critical enhancements"
--guidance "Performance critical, prioritize NFR refinement"
--guidance "Stakeholder expectations volatile, strengthen change control"
```

**How to Apply**:
- Parse guidance for keywords: security, performance, compliance, timeline, stability
- Adjust agent assignments (add security-architect for compliance requirements)
- Modify change approval thresholds (stricter for stability focus)
- Influence workshop priorities (NFRs vs functional requirements)

### --interactive Parameter

**Purpose**: You ask 6 strategic questions to understand requirements context

**Questions to Ask** (if --interactive):

```
I'll ask 6 strategic questions to tailor requirements evolution to your needs:

Q1: What are your top priorities for this requirements activity?
    (e.g., clarifying ambiguities, addressing new needs, stabilizing baseline)

Q2: What are your biggest constraints?
    (e.g., timeline pressure, budget limits, team availability)

Q3: What risks concern you most for requirements management?
    (e.g., scope creep, changing stakeholder expectations, missing requirements)

Q4: What's your team's experience level with requirements management?
    (Helps determine facilitation depth and guidance needed)

Q5: What's your target timeline for this iteration?
    (Influences how many changes to process in this cycle)

Q6: Are there compliance or regulatory requirements affecting this?
    (e.g., HIPAA, SOC2, PCI-DSS - affects requirements documentation depth)

Based on your answers, I'll adjust:
- Agent assignments (specialized reviewers)
- Change approval thresholds
- Workshop focus areas
- Traceability validation depth
```

**Synthesize Guidance**: Combine answers into structured guidance string for execution

### --iteration Parameter

**Purpose**: Specify which iteration's requirements to refine

**Default**: Current iteration based on project phase
**Usage**: `--iteration 3` to focus on Iteration 3 requirements

## Multi-Agent Orchestration Workflow

### Step 1: Conduct Requirements Refinement Workshop

**Purpose**: Schedule and facilitate regular requirements elaboration sessions

**Workshop Frequency**:
- **Inception**: Weekly (vision elaboration)
- **Elaboration**: Bi-weekly (use case detailing)
- **Construction**: Per iteration (acceptance criteria refinement)
- **Transition**: Ad-hoc (operational requirements)

**Your Actions**:

1. **Load Current Requirements Baseline**:
   ```
   Read and analyze:
   - .aiwg/requirements/vision-*.md
   - .aiwg/requirements/use-case-spec-*.md
   - .aiwg/requirements/supplemental-specification-*.md
   - .aiwg/requirements/change-request-*.md (pending)
   - .aiwg/management/traceability-matrix.md
   ```

2. **Launch Workshop Facilitator**:
   ```
   Task(
       subagent_type="requirements-analyst",
       description="Facilitate requirements refinement workshop",
       prompt="""
       Conduct requirements refinement workshop for iteration {N}:

       Workshop Agenda (2 hours):

       1. Review Previous Iteration (15 min)
          - Implemented requirements status
          - Discovered gaps or ambiguities
          - Feedback from testing and demos

       2. Refine Next Iteration Requirements (60 min)
          - Review prioritized backlog items
          - Elaborate acceptance criteria (Given/When/Then)
          - Identify data contracts and interfaces
          - Validate technical feasibility
          - Estimate complexity (story points or days)

       3. Clarify Open Questions (20 min)
          - Ambiguous requirements
          - Missing acceptance criteria
          - Edge cases and error scenarios
          - Integration dependencies

       4. Update Requirements Artifacts (15 min)
          - Create/update use-case briefs
          - Update supplemental specifications (NFRs)
          - Document decisions in ADRs (if needed)
          - Assign owners and target iterations

       5. Review Change Requests (10 min)
          - Pending change requests triage
          - Quick impact assessment
          - Schedule CCB review if needed

       Refinement Techniques:
       - User Story Mapping: Visualize user journey and identify gaps
       - Example Mapping: Use concrete examples to clarify requirements
       - Acceptance Criteria Workshop: Given/When/Then format for testability
       - Dependency Mapping: Identify cross-team and external dependencies
       - Risk-Based Refinement: Prioritize high-risk requirements

       Output: .aiwg/requirements/refinement-summary-{date}.md
       """
   )
   ```

3. **Coordinate Supporting Participants** (parallel):
   ```
   # Product Owner perspective
   Task(
       subagent_type="product-owner",
       description="Provide business priorities and acceptance criteria",
       prompt="""
       Review iteration requirements and provide:
       - Business value priorities
       - Acceptance criteria validation
       - Trade-off decisions
       - Stakeholder feedback integration

       Focus on value delivery and user needs.
       """
   )

   # Architecture perspective
   Task(
       subagent_type="software-architect",
       description="Validate technical feasibility",
       prompt="""
       Review refined requirements and assess:
       - Technical feasibility
       - Architecture constraints
       - Component impacts
       - Integration challenges

       Identify any requirements needing architecture changes.
       """
   )

   # Test perspective
   Task(
       subagent_type="test-architect",
       description="Ensure testability of requirements",
       prompt="""
       Review refined requirements for:
       - Testability (can we verify this?)
       - Acceptance test approach
       - Test data needs
       - Test environment impacts

       Ensure all requirements have clear acceptance criteria.
       """
   )
   ```

**Communicate Progress**:
```
✓ Requirements refinement workshop initiated
⏳ Facilitating workshop with 4 participants...
  ✓ Previous iteration reviewed
  ✓ Requirements refined (12 items)
  ✓ Open questions clarified (8 resolved, 2 escalated)
  ✓ Change requests triaged (3 items)
✓ Workshop complete: .aiwg/requirements/refinement-summary-{date}.md
```

### Step 2: Triage Change Requests

**Purpose**: Evaluate incoming change requests and route for appropriate approval

**Your Actions**:

1. **Collect Pending Change Requests**:
   ```
   Glob pattern: .aiwg/requirements/change-request-*.md
   Filter: Status = PENDING or NEW
   ```

2. **Launch Change Request Triage**:
   ```
   Task(
       subagent_type="requirements-analyst",
       description="Triage change requests",
       prompt="""
       Review pending change requests and perform triage:

       Change Request Types:
       1. Enhancement (CR-E): New feature not in original scope
       2. Clarification (CR-C): Ambiguous requirement needs clarification
       3. Bug Fix (CR-B): Defect in implemented requirement
       4. Scope Change (CR-S): Major feature addition or removal

       Triage Criteria:
       | Impact Level | Schedule Impact | Cost Impact | Approval Authority | Process |
       |--------------|----------------|-------------|-------------------|---------|
       | Minor | <1 day | <$1K | Product Owner | Direct approval |
       | Major | 1-5 days | $1K-$10K | Change Control Board | CCB meeting |
       | Scope | >5 days | >$10K | Executive Sponsor | Formal review |

       For each change request:
       1. Categorize type (Enhancement, Clarification, Bug Fix, Scope Change)
       2. Quick impact assessment (hours/days, cost estimate)
       3. Identify affected artifacts
       4. Make triage decision:
          - APPROVED: Minor change, Product Owner approves
          - DEFERRED: Low priority, add to backlog
          - REJECTED: Out of scope, not aligned with vision
          - CCB REVIEW: Major or scope change

       Output: .aiwg/requirements/change-request-triage-{date}.md
       """
   )
   ```

3. **Quick Impact Assessment** (for major changes):
   ```
   Task(
       subagent_type="system-analyst",
       description="Perform quick impact assessment",
       prompt="""
       For change requests marked CCB REVIEW, perform quick assessment:
       - Schedule impact (estimated days)
       - Cost impact (labor, infrastructure)
       - Affected artifacts (use cases, code, tests)
       - Risk assessment

       Create impact summary for CCB review.
       """
   )
   ```

**Communicate Progress**:
```
⏳ Triaging change requests...
  ✓ 8 change requests reviewed
  ✓ Approved (Product Owner): 3
  ✓ Deferred: 2
  ✓ Rejected: 1
  ✓ CCB Review Required: 2
✓ Triage complete: .aiwg/requirements/change-request-triage-{date}.md
```

### Step 3: Conduct Impact Analysis (for Major Changes)

**Purpose**: Perform comprehensive impact analysis before CCB review

**Your Actions**:

1. **Identify Changes Needing Full Analysis**:
   ```
   Filter triaged CRs where decision = "CCB REVIEW"
   ```

2. **Launch Parallel Impact Analysis Agents**:
   ```
   # Requirements Impact
   Task(
       subagent_type="requirements-analyst",
       description="Analyze requirements impact",
       prompt="""
       For change request {CR-ID}:

       Analyze Scope Impact:
       - Requirements affected (new, modified, deleted)
       - Use cases impacted
       - NFRs affected (performance, security, etc.)
       - Acceptance criteria changes

       Document dependencies and ripple effects.

       Output: .aiwg/working/impact-analysis/{CR-ID}-requirements.md
       """
   )

   # Architecture Impact
   Task(
       subagent_type="software-architect",
       description="Analyze architecture impact",
       prompt="""
       For change request {CR-ID}:

       Analyze Architecture Impact:
       - Components modified
       - New components needed
       - Interfaces changed (API, data contracts)
       - ADRs requiring update
       - Technical risk assessment

       Output: .aiwg/working/impact-analysis/{CR-ID}-architecture.md
       """
   )

   # Test Impact
   Task(
       subagent_type="test-architect",
       description="Analyze test impact",
       prompt="""
       For change request {CR-ID}:

       Analyze Test Impact:
       - Affected test cases
       - New test coverage needed
       - Regression test impact
       - Test effort estimation

       Output: .aiwg/working/impact-analysis/{CR-ID}-testing.md
       """
   )

   # Schedule/Cost Impact
   Task(
       subagent_type="project-manager",
       description="Analyze schedule and cost impact",
       prompt="""
       For change request {CR-ID}:

       Analyze Schedule/Cost Impact:
       - Development effort (days)
       - Testing effort (days)
       - Total schedule impact
       - Labor cost calculation
       - Infrastructure cost
       - Opportunity cost

       Output: .aiwg/working/impact-analysis/{CR-ID}-schedule-cost.md
       """
   )
   ```

3. **Synthesize Impact Analysis Report**:
   ```
   Task(
       subagent_type="system-analyst",
       description="Create comprehensive impact analysis",
       prompt="""
       Read all impact analyses:
       - {CR-ID}-requirements.md
       - {CR-ID}-architecture.md
       - {CR-ID}-testing.md
       - {CR-ID}-schedule-cost.md

       Synthesize into comprehensive Change Impact Analysis Report:

       1. Change Summary
       2. Impact Analysis (scope, architecture, schedule, cost)
       3. Options Analysis (approve, defer, reject, partial)
       4. Recommendation with rationale
       5. Approvals required

       Output: .aiwg/requirements/impact-analysis-{CR-ID}.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Conducting impact analysis for CR-{ID}...
  ✓ Requirements impact assessed
  ✓ Architecture impact assessed
  ✓ Test impact assessed
  ✓ Schedule/cost calculated
✓ Impact analysis complete: .aiwg/requirements/impact-analysis-{CR-ID}.md
  - Total impact: {days} days, ${cost}
  - Recommendation: {APPROVE | DEFER | REJECT}
```

### Step 4: Facilitate Change Control Board Approval

**Purpose**: For major changes, conduct CCB meeting for formal approval

**Your Actions**:

1. **Prepare CCB Meeting Materials**:
   ```
   Task(
       subagent_type="project-manager",
       description="Prepare CCB meeting agenda",
       prompt="""
       Create CCB meeting agenda including:

       1. Previous meeting action items
       2. Change requests for review (with impact summaries)
       3. Baseline health report
       4. Next meeting planning

       For each CR:
       - Requestor and type
       - Impact summary (days, cost)
       - Recommendation
       - Time allocation (15 min)

       Output: .aiwg/management/ccb-agenda-{date}.md
       """
   )
   ```

2. **Simulate CCB Review** (multi-agent deliberation):
   ```
   # Launch CCB members in parallel for review
   Task(
       subagent_type="project-manager",
       description="Chair CCB meeting",
       prompt="""
       As CCB Chair, review each change request and coordinate decision.
       Consider schedule, cost, and resource impacts.
       """
   )

   Task(
       subagent_type="product-owner",
       description="Provide business perspective",
       prompt="""
       Review change requests from business value perspective.
       Consider stakeholder needs and market priorities.
       """
   )

   Task(
       subagent_type="software-architect",
       description="Provide technical perspective",
       prompt="""
       Review change requests for technical feasibility and architectural integrity.
       Assess technical debt and long-term maintainability.
       """
   )
   ```

3. **Document CCB Decisions**:
   ```
   Task(
       subagent_type="project-manager",
       description="Document CCB decisions",
       prompt="""
       Create CCB Decision Record including:

       For each CR reviewed:
       - Decision: APPROVED | DEFERRED | REJECTED
       - Rationale for decision
       - Conditions (if approved)
       - Implementation plan (if approved)
       - Action items

       Output: .aiwg/management/ccb-decision-record-{date}.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Facilitating CCB review...
  ✓ CCB agenda prepared
  ✓ Impact analyses reviewed
  ✓ Multi-perspective evaluation complete
✓ CCB decisions recorded:
  - CR-001: APPROVED (implement in iteration 4)
  - CR-002: DEFERRED (re-evaluate for v2.0)
```

### Step 5: Update Requirements Baseline

**Purpose**: For approved changes, update all requirements artifacts and version the baseline

**Your Actions**:

1. **Update Requirements Artifacts**:
   ```
   Task(
       subagent_type="requirements-analyst",
       description="Update requirements with approved changes",
       prompt="""
       For each approved change request:

       1. Update requirements artifacts:
          - Modify vision document (if scope change)
          - Update use case specifications
          - Update supplemental specification (NFRs)
          - Update acceptance criteria

       2. Update related artifacts:
          - Architecture Decision Records (if needed)
          - Component specifications (if architecture impact)
          - Interface specifications (if API change)

       3. Update change log:
          - Record CR ID and summary
          - Document baseline version change
          - Note approval date and approver

       Maintain full traceability throughout updates.

       Output: Updated requirements in .aiwg/requirements/
       """
   )
   ```

2. **Version Requirements Baseline**:
   ```
   Task(
       subagent_type="requirements-analyst",
       description="Version requirements baseline",
       prompt="""
       Create new baseline version:

       Versioning scheme:
       - Major version (1.0, 2.0): Scope changes
       - Minor version (1.1, 1.2): Major changes (CCB)
       - Patch version (1.1.1): Minor changes (PO)

       Document baseline update:
       - Previous version
       - New version
       - Changes in this baseline
       - Statistics (total requirements, status breakdown)

       Output: .aiwg/requirements/baseline-update-v{version}.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Updating requirements baseline...
  ✓ Requirements artifacts updated
  ✓ Related artifacts synchronized
  ✓ Change log updated
✓ Baseline versioned: v1.2 (was v1.1)
  - 3 requirements modified
  - 1 new requirement added
  - Stability: 85%
```

### Step 6: Maintain Traceability Matrix

**Purpose**: Continuously validate and update traceability links throughout the lifecycle

**Your Actions**:

1. **Validate Current Traceability**:
   ```
   Task(
       subagent_type="traceability-manager",
       description="Validate traceability completeness",
       prompt="""
       Read current traceability matrix and validate:

       Forward Traceability (Requirements → Implementation):
       - All requirements traced to use cases
       - All use cases traced to components
       - All components traced to code
       - All code traced to tests

       Backward Traceability (Implementation → Requirements):
       - All tests traced to requirements
       - All code traced to use cases
       - All use cases traced to requirements

       Identify gaps:
       - Orphaned requirements (no tests)
       - Orphaned code (no requirements)
       - Orphaned tests (no requirements)

       Output: .aiwg/working/traceability-validation.md
       """
   )
   ```

2. **Update Traceability Links**:
   ```
   Task(
       subagent_type="traceability-manager",
       description="Update traceability matrix",
       prompt="""
       Based on requirements changes and validation results:

       1. Add new traceability links
       2. Update existing links
       3. Remove obsolete links
       4. Validate bidirectional traceability

       Ensure traceability completeness:
       - 100% of critical requirements
       - 100% of high-priority requirements
       - ≥90% of all requirements

       Output: .aiwg/management/traceability-matrix.md (updated)
       """
   )
   ```

3. **Generate Traceability Health Report**:
   ```
   Task(
       subagent_type="traceability-manager",
       description="Generate traceability health report",
       prompt="""
       Create comprehensive traceability report:

       1. Overall completeness metrics
       2. Traceability by priority level
       3. Gaps identified (orphaned items)
       4. Gate readiness assessment
       5. Action items to close gaps

       Output: .aiwg/reports/traceability-health-{date}.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Maintaining traceability...
  ✓ Traceability validated
  ✓ Links updated (12 new, 8 modified, 3 removed)
  ✓ Gaps identified: 2 orphaned requirements
✓ Traceability health: 94% complete (target: ≥90%)
  - Critical: 100% traced
  - High: 100% traced
  - Medium: 92% traced
  - Action items: 2 gaps to close
```

### Step 7: Generate Requirements Status Report

**Purpose**: Create comprehensive requirements health report for stakeholders

**Your Actions**:

1. **Collect Requirements Metrics**:
   ```
   Task(
       subagent_type="requirements-analyst",
       description="Calculate requirements metrics",
       prompt="""
       Analyze requirements baseline and calculate:

       - Total requirements count
       - Status breakdown (implemented, in progress, planned)
       - Priority distribution
       - Change rate (changes per iteration)
       - Baseline stability (% unchanged in 2 weeks)
       - Requirements churn (% modified this period)

       Output: .aiwg/working/requirements-metrics.md
       """
   )
   ```

2. **Generate Executive Report**:
   ```
   Task(
       subagent_type="requirements-analyst",
       description="Generate requirements status report",
       prompt="""
       Create comprehensive Requirements Status Report including:

       1. Executive Summary
          - Baseline health status
          - Key highlights
          - Top concerns

       2. Requirements Progress
          - By status and priority
          - Iteration progress

       3. Change Management
          - Change requests processed
          - Change rate and trends
          - Baseline versions

       4. Baseline Stability
          - Stability metrics
          - Churn analysis
          - Trend assessment

       5. Traceability Health
          - Completeness metrics
          - Gap analysis

       6. Risks and Issues
          - Requirements risks
          - Action items

       7. Gate Readiness
          - Criteria status
          - Recommendations

       Output: .aiwg/reports/requirements-status-{date}.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Generating requirements status report...
  ✓ Metrics calculated
  ✓ Executive summary prepared
✓ Requirements Status Report complete: .aiwg/reports/requirements-status-{date}.md
  - Baseline health: STABLE
  - Requirements complete: 45%
  - Change rate: 3 per iteration (target: <5)
  - Traceability: 94% (target: ≥90%)
```

## Quality Gates

Before marking workflow complete, verify:
- [ ] Requirements refinement workshop conducted with stakeholder participation
- [ ] Change requests triaged with clear approval decisions
- [ ] Impact analysis completed for major changes
- [ ] Change Control Board approval obtained for scope changes
- [ ] Requirements baseline updated with approved changes
- [ ] Traceability matrix maintained with ≥90% completeness
- [ ] Requirements status report generated for stakeholders

## User Communication

**At start**: Confirm understanding and scope

```
Understood. I'll orchestrate requirements evolution for iteration {N}.

This will include:
- Requirements refinement workshop
- Change request triage and impact analysis
- CCB facilitation (if major changes)
- Baseline updates
- Traceability maintenance
- Status reporting

I'll coordinate multiple agents for comprehensive management.
Expected duration: 10-15 minutes.

Starting orchestration...
```

**During**: Update progress with clear indicators

```
✓ = Complete
⏳ = In progress
❌ = Error/blocked
⚠️ = Warning/attention needed
```

**At end**: Summary report with results

```
─────────────────────────────────────────────
Requirements Evolution Complete
─────────────────────────────────────────────

**Iteration**: {N}
**Baseline Version**: v1.2 (was v1.1)

**Workshop Results**:
- Requirements refined: 12
- Open questions resolved: 8
- New questions identified: 2

**Change Management**:
- Change requests processed: 8
  - Approved: 4
  - Deferred: 2
  - Rejected: 1
  - CCB Review: 1
- Baseline updated with 4 changes

**Traceability Health**: 94% complete
- Gaps identified: 2
- Action items created: 2

**Baseline Stability**: 85%
- Churn rate: 15% (acceptable)
- Change rate: 3/iteration (target: <5)

**Key Artifacts**:
- Refinement Summary: .aiwg/requirements/refinement-summary-{date}.md
- Change Triage Report: .aiwg/requirements/change-request-triage-{date}.md
- CCB Decision Record: .aiwg/management/ccb-decision-record-{date}.md
- Baseline Update: .aiwg/requirements/baseline-update-v1.2.md
- Traceability Matrix: .aiwg/management/traceability-matrix.md
- Status Report: .aiwg/reports/requirements-status-{date}.md

**Next Steps**:
- Review updated requirements with development team
- Close traceability gaps (2 items)
- Schedule next refinement workshop
- Monitor baseline stability trend

─────────────────────────────────────────────
```

## Error Handling

**No Change Requests Submitted**:
```
ℹ️ No change requests submitted this period

This may indicate:
- Requirements are stable (good!)
- Stakeholders unaware of CR process
- Team not capturing needed changes

Recommendation: Verify stakeholders know how to submit change requests
```

**Change Request Missing Impact Analysis**:
```
⚠️ CR-{ID} lacks impact analysis

Cannot proceed to CCB review without:
- Schedule impact assessment
- Cost impact calculation
- Risk assessment

Action: Conducting impact analysis now...
```

**Traceability Gaps Exceed Threshold**:
```
⚠️ Traceability completeness 78% (target: ≥90%)

Gaps identified:
- Orphaned requirements: 5
- Orphaned code: 12
- Missing test coverage: 8

Impact: Gate criteria at risk

Launching traceability remediation...
```

**Baseline Instability**:
```
⚠️ Baseline churn 35% (target: <20%)

High churn indicates:
- Requirements discovery incomplete
- Stakeholder alignment issues
- Scope not well-defined

Recommendations:
- Strengthen change control
- Defer non-critical changes
- Consider requirements freeze
```

## Success Criteria

This orchestration succeeds when:
- [ ] Requirements refinement workshop conducted with stakeholder participation
- [ ] Change requests triaged with clear approval decisions
- [ ] Impact analysis completed for major changes
- [ ] Change Control Board approval obtained for scope changes
- [ ] Requirements baseline updated with approved changes
- [ ] Traceability matrix maintained with ≥90% completeness
- [ ] Requirements status report generated for stakeholders

## Metrics to Track

**During orchestration, track**:
- Requirements count: Trend over time (should stabilize by Construction)
- Baseline stability: % unchanged per iteration (target: >80%)
- Change request rate: Count per iteration (target: <5)
- Traceability completeness: % (target: ≥90%)
- Requirements churn: % modified per iteration (target: <20%)
- Change approval rate: % approved vs deferred/rejected

**Target Metrics by Phase**:
- **Inception**: 10-20 high-level requirements (vision-level)
- **Elaboration**: 50-100 detailed requirements (use cases + NFRs)
- **Construction**: Baseline stable (churn <20%), change rate <5 per iteration
- **Transition**: Baseline frozen, only critical bug fixes allowed

## References

**Templates** (via $AIWG_ROOT):
- Vision: `templates/requirements/vision-template.md`
- Use Case: `templates/requirements/use-case-spec-template.md`
- Change Request: `agentic/code/frameworks/sdlc-complete/templates/configuration/change-request-card.md`
- Supplemental Spec: `agentic/code/frameworks/sdlc-complete/templates/requirements/supplementary-spec-template.md`
- Traceability Matrix: `agentic/code/frameworks/sdlc-complete/templates/management/traceability-matrix-template.csv`

**Gate Criteria**:
- `flows/gate-criteria-by-phase.md`

**Orchestrator Architecture**:
- `docs/orchestrator-architecture.md`

**Natural Language Translations**:
- `docs/simple-language-translations.md`