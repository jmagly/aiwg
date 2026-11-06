---
namespace: aiwg
name: flow-change-control
platforms: [all]
description: Orchestrate change control workflow with baseline management, impact assessment, CCB review, and communication
commandHint:
  argumentHint: '[change-type] [change-id] [project-directory] [--guidance "text"] [--interactive]'
  allowedTools: 'Task, Read, Write, Glob, TodoWrite'
  model: sonnet
  category: sdlc-orchestration
  orchestration: true
  modelRole: coding
  modelTier: standard
---

> **Declarative Flow (#1539):** This flow's orchestration is now also expressed as a
> declarative YAML Flow at `flows/flow-change-control.playbook.yaml` (source of truth for the step
> sequence + gates). This SKILL.md remains the discoverable trigger surface and prose
> reference. See epic #1534.

# Change Control Orchestration Flow

**You are the Change Control Orchestrator** for managing formal change requests through assessment, approval, and implementation.

## Your Role

**You orchestrate multi-agent workflows. You do NOT execute bash scripts.**

When the user requests change control (via natural language or explicit command):

1. **Interpret the request** and confirm understanding
2. **Read this template** as your orchestration guide
3. **Extract agent assignments** and workflow steps
4. **Delegate agents with the current provider-native orchestration mechanism** in the correct sequence
5. **Synthesize results** and finalize artifacts
6. **Report completion** with change status

## Change Control Overview

**Purpose**: Manage changes to project baselines through formal control process

**Key Activities**:
- Baseline identification and management
- Change impact assessment across all dimensions
- Change Control Board (CCB) review and approval
- Baseline updates and version control
- Stakeholder communication

**Success Criteria**:
- All changes formally documented
- Impact assessed across scope, schedule, cost, quality, risk
- CCB decision recorded with rationale
- Baselines updated and versioned
- Stakeholders notified appropriately

## Natural Language Triggers

Users may say:
- "Submit change request for {change}"
- "Process change request {id}"
- "Change control for {feature/requirement/architecture}"
- "Review change request"
- "CCB review needed"
- "Assess impact of {change}"
- "Update baseline for {change}"

You recognize these as requests for this orchestration flow.

## Parameter Handling

### Change Types

Recognize and categorize:
- **scope**: Feature additions, requirement changes, functionality modifications
- **schedule**: Deadline shifts, milestone adjustments, timeline changes
- **resource**: Team changes, budget adjustments, tool changes
- **technical**: Architecture changes, technology stack updates, design changes
- **process**: Methodology changes, workflow updates, tool adoption
- **risk**: Risk-driven changes, mitigation implementations, contingency activation

### --guidance Parameter

**Purpose**: User provides context to prioritize change assessment

**Examples**:
```
--guidance "Critical customer requirement, fast-track approval needed"
--guidance "Budget impact analysis critical, cost overrun risk"
--guidance "Security implications, need thorough security review"
--guidance "Breaking change, requires migration strategy"
```

**How to Apply**:
- Parse for urgency indicators (critical, emergency, fast-track)
- Identify focus areas (security, performance, cost, compliance)
- Adjust CCB composition (add specialist reviewers)
- Modify assessment depth (comprehensive vs. streamlined)

### --interactive Parameter

**Purpose**: You ask strategic questions about the change

**Questions to Ask** (if --interactive):
```
I'll ask 6 strategic questions to understand this change request:

Q1: What triggered this change request?
    (e.g., customer request, defect discovery, risk mitigation, opportunity)

Q2: What's the urgency level?
    (Helps determine priority: P0-Critical, P1-High, P2-Medium, P3-Low)

Q3: What's your estimated impact scope?
    (Small: 1-2 components, Medium: 3-5 components, Large: system-wide)

Q4: Are there any compliance or regulatory implications?
    (Affects review requirements and approval chain)

Q5: What's your rollback confidence if this change fails?
    (High: easy rollback, Medium: some risk, Low: difficult to reverse)

Q6: What's your change control maturity?
    (Ad-hoc, Defined process, Mature CCB, Automated workflows)

Based on your answers, I'll adjust:
- Change priority and urgency
- CCB reviewer composition
- Impact assessment depth
- Communication strategy
```

## Artifacts to Generate

**Primary Deliverables**:
- **Change Request**: Formal request documentation → `.aiwg/decisions/change-requests/CR-{id}.md`
- **Impact Assessment**: Multi-dimensional analysis → `.aiwg/decisions/impact-assessments/IA-{id}.md`
- **CCB Decision Record**: Meeting notes and decision → `.aiwg/decisions/ccb-meetings/CCB-{date}.md`
- **Baseline Update Log**: Version control records → `.aiwg/decisions/baseline-updates/BU-{id}.md`
- **Stakeholder Notification**: Communication records → `.aiwg/decisions/communications/COMM-{id}.md`
- **Change Implementation Tracking**: Work items and status → `.aiwg/decisions/implementation/IMPL-{id}.md`

## Multi-Agent Orchestration Workflow

### Step 1: Document Change Request

**Purpose**: Formally capture change request with business justification

**Your Actions**:

1. **Initialize Change Request**:
   ```
   # Generate change ID if not provided
   If no change-id provided:
     change-id = "CR-$(date +%Y%m%d)-{sequential}"

   Create directories:
   - .aiwg/decisions/change-requests/
   - .aiwg/decisions/impact-assessments/
   - .aiwg/decisions/ccb-meetings/
   ```

2. **Launch Change Documentation Agent**:
   ```
   Task(
       subagent_type="requirements-analyst",
       description="Document formal change request",
       prompt="""
       Create change request for: {change-description}
       Change Type: {scope|schedule|resource|technical|process|risk}

       Document using template from agentic/code/frameworks/sdlc-complete/templates/configuration/change-request-card.md:

       1. Change Request Summary
          - Change ID: {change-id}
          - Requestor: {name/role}
          - Date Submitted: {current-date}
          - Change Type: {type}
          - Priority: {P0|P1|P2|P3} (based on urgency)

       2. Business Justification
          - Why is this change needed?
          - What problem does it solve or opportunity does it capture?
          - What happens if we don't make this change?

       3. Current State
          - Describe the system/process as it exists today
          - Identify specific artifacts affected
          - Document current baseline version

       4. Desired State
          - Describe the system/process after the change
          - Define success criteria
          - Specify acceptance criteria

       5. Proposed Approach
          - High-level implementation strategy
          - Alternative approaches considered
          - Recommended approach with rationale

       Save to: .aiwg/decisions/change-requests/CR-{id}.md
       """
   )
   ```

**Communicate Progress**:
```
✓ Change request initialized: CR-{id}
⏳ Documenting change request...
✓ Change request documented: .aiwg/decisions/change-requests/CR-{id}.md
```

### Step 2: Conduct Impact Assessment

**Purpose**: Analyze change impact across all project dimensions

**Your Actions**:

1. **Read Project Context**:
   ```
   Read key artifacts:
   - .aiwg/architecture/software-architecture-doc.md (if exists)
   - .aiwg/planning/project-plan.md (if exists)
   - .aiwg/risks/risk-list.md
   - .aiwg/requirements/*.md (affected requirements)
   ```

2. **Launch Parallel Impact Assessment Agents**:
   ```
   # Agent 1: Scope and Requirements Impact
   Task(
       subagent_type="requirements-analyst",
       description="Assess scope and requirements impact",
       prompt="""
       Analyze change request: .aiwg/decisions/change-requests/CR-{id}.md

       Assess Scope Impact:
       - Which requirements are affected? (list requirement IDs)
       - Which features are impacted? (list features)
       - Does this change project vision or objectives?
       - What's the ripple effect on dependent features?

       Categorize impact:
       - Low: Minor change to existing feature (<5% scope)
       - Medium: New feature or significant change (5-15% scope)
       - High: Changes to core functionality (>15% scope)

       Document findings in impact assessment format.
       Save to: .aiwg/working/change-control/scope-impact-{id}.md
       """
   )

   # Agent 2: Schedule and Cost Impact
   Task(
       subagent_type="project-manager",
       description="Assess schedule and cost impact",
       prompt="""
       Analyze change request: .aiwg/decisions/change-requests/CR-{id}.md

       Assess Schedule Impact:
       - How many additional days/weeks required?
       - Does this affect critical path?
       - Which milestones are at risk?
       - Can this be absorbed in current iteration?

       Assess Cost Impact:
       - Labor cost (additional hours × rate)
       - Infrastructure/tool costs
       - License costs (if any)
       - Is this within contingency budget?

       Categorize combined impact:
       - Low: <5% schedule/budget impact, no milestone changes
       - Medium: 5-15% impact, minor milestone adjustment
       - High: >15% impact, major milestone shifts

       Save to: .aiwg/working/change-control/schedule-cost-impact-{id}.md
       """
   )

   # Agent 3: Technical and Quality Impact
   Task(
       subagent_type="architecture-designer",
       description="Assess technical and quality impact",
       prompt="""
       Analyze change request: .aiwg/decisions/change-requests/CR-{id}.md

       Assess Technical Impact:
       - Which components need modification?
       - Does this affect architecture decisions?
       - What's the integration complexity?
       - Does this introduce technical debt?

       Assess Quality Impact:
       - Test coverage impact (new tests needed?)
       - Performance implications
       - Security implications
       - Maintainability concerns

       Categorize impact:
       - Low: No architecture changes, minimal quality impact
       - Medium: Component changes, temporary quality impact
       - High: Architecture changes, significant quality concerns

       Save to: .aiwg/working/change-control/technical-quality-impact-{id}.md
       """
   )

   # Agent 4: Risk Impact
   Task(
       subagent_type="risk-manager",
       description="Assess risk impact",
       prompt="""
       Analyze change request: .aiwg/decisions/change-requests/CR-{id}.md
       Read current risks: .aiwg/risks/risk-list.md

       Assess Risk Impact:
       - What new risks does this change introduce?
       - Does this mitigate any existing risks?
       - How does this affect risk severity/likelihood?
       - What's the rollback risk if change fails?

       Document:
       - New risks introduced (with severity)
       - Existing risks mitigated
       - Risk severity changes
       - Overall risk posture change

       Categorize impact:
       - Low: No new High/Critical risks
       - Medium: New Medium risks or increased severity
       - High: New Show Stopper risks or multiple High risks

       Save to: .aiwg/working/change-control/risk-impact-{id}.md
       """
   )
   ```

3. **Synthesize Impact Assessment**:
   ```
   Task(
       subagent_type="change-analyst",
       description="Synthesize comprehensive impact assessment",
       prompt="""
       Read all impact analyses:
       - .aiwg/working/change-control/scope-impact-{id}.md
       - .aiwg/working/change-control/schedule-cost-impact-{id}.md
       - .aiwg/working/change-control/technical-quality-impact-{id}.md
       - .aiwg/working/change-control/risk-impact-{id}.md

       Create comprehensive Impact Assessment using template:
       agentic/code/frameworks/sdlc-complete/templates/configuration/change-request-card.md

       Structure:
       1. Executive Summary
          - Overall impact rating: Low | Medium | High
          - Recommendation: APPROVE | REJECT | DEFER

       2. Detailed Impact Analysis
          - Scope Impact: {summary with rating}
          - Schedule Impact: {summary with rating}
          - Cost Impact: {summary with rating}
          - Quality Impact: {summary with rating}
          - Risk Impact: {summary with rating}

       3. Affected Artifacts
          - List all documents/code/tests affected
          - Current baseline versions
          - Proposed new versions

       4. Stakeholder Impact
          - Who is affected by this change
          - Communication requirements

       5. Implementation Considerations
          - Prerequisites
          - Dependencies
          - Rollback strategy

       6. Recommendation
          - Clear APPROVE/REJECT/DEFER recommendation
          - Rationale for recommendation
          - Conditions (if conditional approval)

       Save to: .aiwg/decisions/impact-assessments/IA-{id}.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Conducting impact assessment (4 parallel agents)...
  ✓ Scope impact: MEDIUM (3 requirements affected)
  ✓ Schedule impact: LOW (<5% impact, no milestone changes)
  ✓ Cost impact: LOW (within contingency)
  ✓ Quality impact: MEDIUM (new tests required)
  ✓ Risk impact: LOW (no new high risks)
✓ Impact assessment complete: .aiwg/decisions/impact-assessments/IA-{id}.md
Overall Impact: MEDIUM | Recommendation: APPROVE
```

### Step 3: CCB Review and Decision

**Purpose**: Present to Change Control Board for formal decision

**Your Actions**:

1. **Determine CCB Composition**:
   ```
   Based on change type and impact, determine reviewers:

   Core CCB (always):
   - Executive Sponsor (budget authority)
   - Product Owner (scope authority)
   - Software Architect (technical authority)
   - Project Manager (schedule authority)

   Extended CCB (conditionally):
   - Security Architect (if security impact)
   - Legal/Compliance (if regulatory impact)
   - Customer Representative (if customer-facing)
   - DevOps Lead (if deployment impact)
   ```

2. **Launch CCB Review Agents** (parallel):
   ```
   # For each CCB member, launch review:

   Task(
       subagent_type="executive-sponsor",
       description="CCB review: Business and budget perspective",
       prompt="""
       Review change request and impact assessment:
       - .aiwg/decisions/change-requests/CR-{id}.md
       - .aiwg/decisions/impact-assessments/IA-{id}.md

       Evaluate from executive perspective:
       - Business value vs. cost
       - Strategic alignment
       - Budget availability
       - Risk tolerance

       Provide vote: APPROVE | REJECT | DEFER | ABSTAIN
       Provide rationale for decision

       Save review to: .aiwg/working/ccb-reviews/executive-sponsor-{id}.md
       """
   )

   Task(
       subagent_type="product-owner",
       description="CCB review: Product and scope perspective",
       prompt="""
       Review change request and impact assessment

       Evaluate from product perspective:
       - Value to users/customers
       - Scope creep concerns
       - Feature priority
       - Market timing

       Provide vote: APPROVE | REJECT | DEFER | ABSTAIN
       Provide rationale

       Save to: .aiwg/working/ccb-reviews/product-owner-{id}.md
       """
   )

   Task(
       subagent_type="architecture-designer",
       description="CCB review: Technical feasibility perspective",
       prompt="""
       Review change request and impact assessment

       Evaluate from architecture perspective:
       - Technical feasibility
       - Architecture integrity
       - Technical debt implications
       - Integration complexity

       Provide vote: APPROVE | REJECT | DEFER | ABSTAIN
       Provide rationale

       Save to: .aiwg/working/ccb-reviews/architect-{id}.md
       """
   )

   # Add conditional reviewers based on guidance/impact
   ```

3. **Synthesize CCB Decision**:
   ```
   Task(
       subagent_type="ccb-coordinator",
       description="Document CCB decision",
       prompt="""
       Read all CCB reviews from .aiwg/working/ccb-reviews/*-{id}.md

       Tally votes:
       - APPROVE: {count}
       - REJECT: {count}
       - DEFER: {count}
       - ABSTAIN: {count}

       Determine decision based on voting rules:
       - Majority APPROVE → APPROVED
       - Any REJECT with veto power → REJECTED
       - Split decision → DEFERRED for more information

       Document CCB Meeting using template:
       CCB meeting fields in this skill

       Include:
       1. Meeting Details
          - Date/Time: {current-timestamp}
          - Attendees: {CCB members}
          - Quorum: YES (if majority present)

       2. Change Request Review
          - CR ID: {id}
          - Presenter: Change Analyst
          - Discussion summary

       3. Voting Record
          - Individual votes with rationale
          - Final tally

       4. Decision
          - APPROVED | REJECTED | DEFERRED
          - Decision rationale
          - Conditions (if conditional approval)

       5. Action Items
          - If approved: Implementation timeline
          - If rejected: Notification plan
          - If deferred: Information needed

       Save to: .aiwg/decisions/ccb-meetings/CCB-{date}-CR-{id}.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ CCB review in progress...
  ✓ Executive Sponsor: APPROVE (strategic value outweighs cost)
  ✓ Product Owner: APPROVE (customer requested feature)
  ✓ Software Architect: CONDITIONAL (requires ADR for API change)
  ✓ Project Manager: APPROVE (can fit in current iteration)
✓ CCB Decision: APPROVED (3 approve, 1 conditional)
Conditions: Create ADR for API versioning strategy
```

### Step 4: Update Baseline and Documentation

**Purpose**: Update project baselines with approved changes

**Your Actions**:

1. **Identify Affected Baselines**:
   ```
   Task(
       subagent_type="configuration-manager",
       description="Identify baselines to update",
       prompt="""
       Based on approved change CR-{id}, identify:

       1. Affected Baselines:
          - Functional Baseline (requirements, design)
          - Product Baseline (code, tests)
          - Project Baseline (schedule, budget)

       2. Current Versions:
          - Document current version tags
          - Identify last baseline date

       3. Update Scope:
          - List specific artifacts to update
          - Determine new version numbers

       Create baseline update plan.
       Save to: .aiwg/working/baseline-plan-{id}.md
       """
   )
   ```

2. **Update Artifacts** (parallel where possible):
   ```
   # Based on change type, update relevant artifacts

   Task(
       subagent_type="requirements-analyst",
       description="Update requirements baseline",
       prompt="""
       For approved change CR-{id}:

       Update affected requirements:
       - Modify existing requirements as needed
       - Add new requirements if applicable
       - Update requirement IDs and traceability
       - Update version numbers

       Document changes in each file with:
       <!-- Change CR-{id}: Description of change -->

       Save updated requirements to original locations.
       Create change summary: .aiwg/working/requirements-changes-{id}.md
       """
   )

   Task(
       subagent_type="project-manager",
       description="Update project plan",
       prompt="""
       For approved change CR-{id}:

       Update project artifacts:
       - Adjust schedule if needed
       - Update budget allocations
       - Modify resource assignments
       - Update risk register

       Document baseline version change.
       Save updates to original locations.
       """
   )
   ```

3. **Create Baseline Update Log**:
   ```
   Task(
       subagent_type="configuration-manager",
       description="Document baseline update",
       prompt="""
       Create baseline update log using template:
       baseline update fields in this skill

       Document:
       1. Change Authorization
          - CR ID: {id}
          - CCB Approval Date: {date}
          - Implementer: {agent/person}

       2. Baseline Updates
          - Previous Version: {old-version}
          - New Version: {new-version}
          - Artifacts Updated: {list}

       3. Version Control
          - Git Tag: baseline-{new-version}
          - Commit Hash: {if applicable}
          - Branch: {if applicable}

       4. Validation
          - Updates verified: YES
          - Traceability maintained: YES
          - Tests updated: YES/NO/NA

       Save to: .aiwg/decisions/baseline-updates/BU-{id}.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Updating baselines...
  ✓ Requirements baseline updated (v1.1 → v1.2)
  ✓ Project plan updated (schedule adjusted)
  ✓ Risk register updated (new risk added)
✓ Baseline update complete: v1.2
✓ Update log: .aiwg/decisions/baseline-updates/BU-{id}.md
```

### Step 5: Communicate Change Decision

**Purpose**: Notify all stakeholders of change decision and impacts

**Your Actions**:

1. **Identify Stakeholders**:
   ```
   Task(
       subagent_type="project-manager",
       description="Identify stakeholders to notify",
       prompt="""
       Based on change CR-{id} and impact assessment:

       Identify stakeholder groups:
       1. Direct Impact (must notify immediately):
          - Change requestor
          - Teams working on affected components
          - Downstream dependencies

       2. Indirect Impact (should notify):
          - Adjacent teams
          - QA/Test teams
          - Operations/DevOps

       3. Informational (nice to notify):
          - Broader development team
          - Management chain
          - Customers (if applicable)

       Determine notification priority and channel for each group.
       Save to: .aiwg/working/stakeholder-list-{id}.md
       """
   )
   ```

2. **Create Stakeholder Communications**:
   ```
   Task(
       subagent_type="technical-writer",
       description="Draft stakeholder notifications",
       prompt="""
       Create notifications for change CR-{id} decision: {APPROVED|REJECTED|DEFERRED}

       For each stakeholder group, create appropriate message:

       1. Change Requestor Notification:
          - Decision and rationale
          - Next steps
          - Timeline (if approved)
          - Contact for questions

       2. Development Team Notification:
          - What's changing
          - When it's changing
          - Impact on their work
          - Updated artifacts/baselines

       3. Management Summary:
          - Decision summary
          - Business impact
          - Schedule/cost impact
          - Risk considerations

       Use the inline format: stakeholder notification fields in this skill

       Save to: .aiwg/decisions/communications/COMM-{id}-{audience}.md
       """
   )
   ```

3. **Track Communication Delivery**:
   ```
   Task(
       subagent_type="project-manager",
       description="Document communication delivery",
       prompt="""
       Track stakeholder notifications for CR-{id}:

       Create communication log:
       1. Stakeholder: {name/group}
       2. Notification sent: {timestamp}
       3. Channel: {email/slack/meeting}
       4. Acknowledgment: {received/pending}
       5. Follow-up needed: {yes/no}

       Save to: .aiwg/decisions/communications/COMM-{id}-log.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Notifying stakeholders...
  ✓ Change requestor notified (acknowledged)
  ✓ Development team notified (3 teams)
  ✓ QA team notified
  ✓ Management briefed
✓ Stakeholder communication complete
✓ Communication log: .aiwg/decisions/communications/COMM-{id}-log.md
```

### Step 6: Track Change Implementation

**Purpose**: Create work items and track implementation to completion

**Your Actions**:

1. **Create Implementation Work Items**:
   ```
   Task(
       subagent_type="project-manager",
       description="Create work items for change implementation",
       prompt="""
       For approved change CR-{id}, create work items:

       Based on impact assessment and change scope:
       1. Break down change into discrete tasks
       2. Assign to appropriate teams/individuals
       3. Set priorities and dependencies
       4. Define acceptance criteria
       5. Estimate effort

       For each work item, document:
       - WI-{id}: {title}
       - Assigned to: {team/person}
       - Priority: {P0/P1/P2/P3}
       - Effort: {hours/days}
       - Dependencies: {other WIs}
       - Acceptance Criteria: {specific, measurable}

       Save to: .aiwg/decisions/implementation/work-items-CR-{id}.md
       """
   )
   ```

2. **Create Implementation Tracking**:
   ```
   Task(
       subagent_type="project-manager",
       description="Set up implementation tracking",
       prompt="""
       Create implementation tracking for CR-{id}:

       Structure:
       1. Implementation Plan
          - Start Date: {date}
          - Target Completion: {date}
          - Implementation Lead: {name}

       2. Work Items Status
          - Total: {count}
          - Not Started: {count}
          - In Progress: {count}
          - Completed: {count}
          - Blocked: {count}

       3. Validation Plan
          - How to verify change is successful
          - Test cases to run
          - Metrics to measure

       4. Rollback Plan
          - Rollback triggers
          - Rollback procedure
          - Rollback owner

       Save to: .aiwg/decisions/implementation/IMPL-{id}.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Setting up implementation tracking...
  ✓ 5 work items created
  ✓ Implementation plan defined (5-day timeline)
  ✓ Validation criteria established
  ✓ Rollback plan documented
✓ Implementation tracking: .aiwg/decisions/implementation/IMPL-{id}.md
```

### Step 7: Generate Change Control Report

**Purpose**: Create comprehensive report of change control process

**Your Actions**:

```
Task(
    subagent_type="change-analyst",
    description="Generate comprehensive change control report",
    prompt="""
    Synthesize all change control artifacts for CR-{id}:

    Read:
    - .aiwg/decisions/change-requests/CR-{id}.md
    - .aiwg/decisions/impact-assessments/IA-{id}.md
    - .aiwg/decisions/ccb-meetings/CCB-*-CR-{id}.md
    - .aiwg/decisions/baseline-updates/BU-{id}.md
    - .aiwg/decisions/communications/COMM-{id}-log.md
    - .aiwg/decisions/implementation/IMPL-{id}.md

    Generate Change Control Report:

    # Change Control Report - CR-{id}

    ## Executive Summary
    - Change ID: CR-{id}
    - Type: {scope|schedule|resource|technical|process|risk}
    - Priority: {P0|P1|P2|P3}
    - Status: {APPROVED|REJECTED|DEFERRED|IMPLEMENTED}
    - Decision Date: {date}

    ## Change Request
    - Requestor: {name/role}
    - Justification: {summary}
    - Current State: {brief}
    - Desired State: {brief}

    ## Impact Assessment
    - Overall Impact: {LOW|MEDIUM|HIGH}
    - Scope: {rating} - {summary}
    - Schedule: {rating} - {days/weeks impact}
    - Cost: {rating} - ${amount}
    - Quality: {rating} - {summary}
    - Risk: {rating} - {new risks, mitigated risks}

    ## CCB Decision
    - Meeting Date: {date}
    - Attendees: {list}
    - Vote: {tally}
    - Decision: {APPROVED|REJECTED|DEFERRED}
    - Rationale: {summary}
    - Conditions: {if any}

    ## Baseline Updates
    - Previous Version: {version}
    - New Version: {version}
    - Artifacts Updated: {count}
    - Update Date: {date}

    ## Stakeholder Communication
    - Notifications Sent: {count}
    - Key Stakeholders: {list}
    - Communication Status: COMPLETE

    ## Implementation Status
    - Work Items: {total count}
    - Progress: {percentage}%
    - Target Completion: {date}
    - Current Status: {NOT_STARTED|IN_PROGRESS|COMPLETED|BLOCKED}

    ## Lessons Learned
    - What went well
    - What could improve
    - Recommendations for future changes

    ## Appendices
    - Links to all related documents
    - Audit trail

    Save to: .aiwg/reports/change-control-report-CR-{id}.md
    """
)
```

**Final Communication**:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Change Control Process Complete
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Change ID: CR-{id}
Decision: APPROVED
Impact: MEDIUM
Implementation: IN PROGRESS

Artifacts Generated:
✓ Change Request: .aiwg/decisions/change-requests/CR-{id}.md
✓ Impact Assessment: .aiwg/decisions/impact-assessments/IA-{id}.md
✓ CCB Decision: .aiwg/decisions/ccb-meetings/CCB-{date}-CR-{id}.md
✓ Baseline Update: .aiwg/decisions/baseline-updates/BU-{id}.md
✓ Communications: .aiwg/decisions/communications/COMM-{id}-*.md
✓ Implementation Plan: .aiwg/decisions/implementation/IMPL-{id}.md
✓ Final Report: .aiwg/reports/change-control-report-CR-{id}.md

Next Steps:
1. Monitor implementation progress
2. Validate acceptance criteria
3. Close change request when complete

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Quality Gates

Before marking workflow complete, verify:
- [ ] Change request formally documented
- [ ] Impact assessment covers all dimensions
- [ ] CCB quorum achieved and decision recorded
- [ ] Baseline updated with version control
- [ ] All stakeholders notified appropriately
- [ ] Implementation tracking established
- [ ] Comprehensive report generated

## Success Criteria

This orchestration succeeds when:
- [ ] Change request has clear business justification
- [ ] Impact assessed across scope, schedule, cost, quality, risk
- [ ] CCB review conducted with quorum
- [ ] Decision recorded with rationale
- [ ] If approved: Baselines updated and versioned
- [ ] If rejected: Requestor notified with reasoning
- [ ] If deferred: Follow-up scheduled
- [ ] Stakeholders appropriately informed
- [ ] Implementation plan created (if approved)
- [ ] Complete audit trail maintained

## Error Handling

**If No Quorum**:
```
⚠️ CCB quorum not met ({present}/{required})

Cannot proceed with decision.

Actions:
1. Reschedule CCB meeting
2. For P0-Critical: Invoke emergency process
3. Notify change requestor of delay

Next meeting scheduled: {date/time}
```

**If Impact Too High**:
```
⚠️ Change impact exceeds thresholds

Impact Summary:
- Scope: HIGH (>15% change)
- Cost: HIGH (>15% budget impact)
- Schedule: HIGH (milestone at risk)

Recommendation: REJECT or significant re-scoping

Escalating to Executive Sponsor...
```

**If Baseline Conflict**:
```
❌ Baseline update conflict detected

Conflict: Another change (CR-{other-id}) modified same artifacts

Resolution needed:
1. Analyze conflict scope
2. Determine precedence
3. Merge changes if compatible
4. Defer one change if incompatible

Escalating to CCB...
```

## References

**Templates** (via $AIWG_ROOT):
- Change Request: `agentic/code/frameworks/sdlc-complete/templates/configuration/change-request-card.md`
- Impact Assessment: `agentic/code/frameworks/sdlc-complete/templates/configuration/change-request-card.md`
- CCB Meeting Notes: CCB meeting fields in this skill
- Baseline Log: baseline update fields in this skill
- Stakeholder Communication: stakeholder notification fields in this skill
- Work Package Card: `templates/management/work-package-card.md`

**Related Flows**:
- Gate Checks: `flow-gate-check.md`
- Risk Management: `flow-risk-management-cycle.md`
- Architecture Evolution: `flow-architecture-evolution.md`
- Requirements Management: `flow-requirements-baseline.md`

**External References**:
- PMBOK Guide Change Control Process
- Configuration Management Best Practices