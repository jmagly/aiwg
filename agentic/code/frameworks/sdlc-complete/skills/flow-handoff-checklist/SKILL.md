---
namespace: aiwg
name: flow-handoff-checklist
platforms: [all]
description: Orchestrate handoff validation between SDLC phases and tracks (Discovery→Delivery, Delivery→Ops, phase transitions)
commandHint:
  argumentHint: <from-phase> <to-phase> [project-directory] [--guidance "text"] [--interactive]
  allowedTools: Task, Read, Write, Glob, TodoWrite
  model: sonnet
  category: sdlc-orchestration
  orchestration: true
  modelRole: coding
  modelTier: standard
---

> **Declarative Flow (#1539):** This flow's orchestration is now also expressed as a
> declarative YAML Flow at `flows/flow-handoff-checklist.playbook.yaml` (source of truth for the step
> sequence + gates). This SKILL.md remains the discoverable trigger surface and prose
> reference. See epic #1534.

# SDLC Handoff Checklist Flow

**You are the Core Orchestrator** for validating and executing handoffs between SDLC phases and tracks.

## Output template

For the accompanying agent handoff note use this template; retain the transition checklist: @$AIWG_ROOT/agentic/code/addons/aiwg-utils/templates/agent-handoff.md. Fill every required section; explain non-applicable fields and unrun checks.

## Threat-assessment gate

Before signoff or packaging, resolve the active workspace member's
`security.threatAssessment` policy and assess the synthesized handoff as
`handoff` with `tools/security/threat-assessment.mjs`. Store the report with
the handoff evidence. Audit mode records `wouldAction` without interrupting;
enforce-mode `flag`/`require-authorization` pauses and `reject` blocks the
handoff. Off mode disables only this AIWG classifier.

## Your Role

**You orchestrate multi-agent workflows. You do NOT execute bash scripts.**

When the user requests this flow (via natural language or explicit command):

1. **Interpret the request** and confirm understanding
2. **Read this template** as your orchestration guide
3. **Extract agent assignments** and workflow steps
4. **Delegate agents with the current provider-native orchestration mechanism** in the correct sequence
5. **Synthesize results** and finalize artifacts
6. **Report completion** with summary

## Natural Language Triggers

Users may say:
- "Check handoff readiness to Delivery"
- "Validate handoff from Discovery"
- "Verify handoff readiness for Operations"
- "Review handoff checklist"
- "Check if we're ready for phase transition"
- "Validate Definition of Ready"
- "Run operational readiness review"

You recognize these as requests for this orchestration flow.

## Parameter Handling

### --guidance Parameter

**Purpose**: User provides upfront direction to tailor handoff validation priorities

**Examples**:
```
--guidance "Focus on security compliance, SOC2 audit next month"
--guidance "Quick validation, team is waiting to start"
--guidance "Pay special attention to test coverage and documentation"
--guidance "First handoff, need detailed validation"
```

**How to Apply**:
- Parse guidance for keywords: security, documentation, testing, compliance, speed
- Adjust validation depth (comprehensive vs. essential checks)
- Modify agent assignments (add specialized validators)
- Influence priority ordering (critical checks first)

### --interactive Parameter

**Purpose**: You ask 5-7 strategic questions to understand handoff context

**Questions to Ask** (if --interactive):

```
I'll ask 7 strategic questions to tailor the handoff validation:

Q1: Is this your first handoff of this type?
    (Helps me determine validation thoroughness needed)

Q2: What's your biggest concern about this handoff?
    (e.g., incomplete requirements, missing tests, documentation gaps)

Q3: How urgent is this handoff?
    (Influences whether to do comprehensive or essential checks)

Q4: Are there any known gaps you're already aware of?
    (Helps focus validation on unknown issues)

Q5: Who are the key stakeholders who need to sign off?
    (Determines which reviewers to engage)

Q6: Are there any special compliance or regulatory requirements?
    (e.g., HIPAA, SOC2, PCI-DSS affects validation criteria)

Q7: What's your fallback plan if handoff is blocked?
    (Helps prepare contingency recommendations)

Based on your answers, I'll adjust:
- Validation depth (comprehensive vs. streamlined)
- Agent assignments (add specialized reviewers)
- Priority ordering (critical items first)
- Remediation recommendations
```

**Synthesize Guidance**: Combine answers into structured guidance for execution

## Supported Handoffs

### Phase Transitions
- **inception → elaboration**: Lifecycle Objective Milestone handoff
- **elaboration → construction**: Lifecycle Architecture Milestone handoff
- **construction → transition**: Operational Capability Milestone handoff
- **transition → operations**: Product Release Milestone handoff

### Track Handoffs
- **discovery → delivery**: Definition of Ready (DoR) validation
- **delivery → operations**: Operational Readiness Review (ORR)
- **delivery → discovery**: Feedback loop for rework/clarification

### Special Handoffs
- **intake → inception**: Project Intake to Inception kickoff
- **concept → inception**: Concept to Inception flow start

## Multi-Agent Orchestration Workflow

### Step 1: Identify and Load Handoff Checklist

**Purpose**: Determine which handoff checklist applies and load criteria

**Your Actions**:

1. **Parse Handoff Type**:
   ```
   Determine from user input:
   - From phase/track
   - To phase/track
   - Type: Phase transition, Track handoff, or Special
   ```

2. **Load Checklist Criteria**:
   ```
   Based on handoff type, identify:
   - Required artifacts
   - Validation criteria
   - Signoff requirements
   - Pass threshold
   ```

3. **Initialize Validation Workspace**:
   ```
   Create workspace structure:
   .aiwg/working/handoff/
   ├── artifacts/      # Artifact validation results
   ├── checklist/      # Checklist item validation
   ├── signoffs/       # Signoff status tracking
   └── report/         # Final handoff report
   ```

**Communicate Progress**:
```
✓ Handoff identified: {from-phase} → {to-phase}
✓ Checklist loaded: {checklist-name}
⏳ Starting validation...
```

### Step 2: Validate Required Artifacts

**Purpose**: Check presence and completeness of required artifacts

**Your Actions**:

1. **For Discovery → Delivery (Definition of Ready)**:
   ```
   Task(
       subagent_type="requirements-analyst",
       description="Validate Definition of Ready artifacts",
       prompt="""
       Check for required artifacts per backlog item:

       Requirements:
       - requirements/use-case-brief-{ID}.md
       - test/acceptance-test-card-{ID}.md

       Design (if applicable):
       - analysis-design/data-contract-card-{ID}.md
       - analysis-design/interface-card-{ID}.md

       Risk Management:
       - management/risk-card-{ID}.md (if high-risk)
       - analysis-design/spike-card-{ID}.md (if spike conducted)

       For each artifact:
       1. Check existence (file present)
       2. Validate completeness (all sections filled)
       3. Check approval status (stakeholder signoff)
       4. Verify currency (last updated within sprint)

       Output validation report:
       .aiwg/working/handoff/artifacts/dor-artifacts-validation.md
       """
   )
   ```

2. **For Delivery → Operations (Operational Readiness)**:
   ```
   Task(
       subagent_type="documentation-archivist",
       description="Validate Operational Readiness artifacts",
       prompt="""
       Check for required deployment artifacts:

       Deployment:
       - deployment/deployment-plan-template.md
       - deployment/release-notes-template.md
       - deployment/runbook-*.md

       Testing:
       - test/test-evaluation-summary-template.md
       - test/acceptance-test-results-*.md

       Operations:
       - deployment/operational-readiness-review-template.md
       - support/support-plan-template.md
       - training/user-guide-template.md

       For each artifact:
       1. Verify existence and completeness
       2. Check version currency (matches release)
       3. Validate technical accuracy
       4. Confirm operational procedures documented

       Output validation report:
       .aiwg/working/handoff/artifacts/orr-artifacts-validation.md
       """
   )
   ```

3. **For Phase Transitions**:
   ```
   Task(
       subagent_type="project-manager",
       description="Validate phase transition artifacts",
       prompt="""
       Based on transition {from-phase} → {to-phase}:

       For inception → elaboration:
       - intake/project-intake-template.md
       - requirements/vision-*.md
       - management/business-case-*.md
       - management/risk-list.md
       - security/data-classification-template.md

       For elaboration → construction:
       - analysis-design/software-architecture-doc-template.md
       - requirements/supplemental-specification-template.md
       - test/master-test-plan-template.md
       - management/development-case-template.md

       Validate each artifact:
       1. Present and complete
       2. Reviewed and approved
       3. Baselined (version tagged)

       Output validation report:
       .aiwg/working/handoff/artifacts/phase-artifacts-validation.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Validating artifacts...
✓ Required artifacts: {found}/{required}
✓ Artifact completeness: {percentage}%
```

### Step 3: Execute Checklist Validation (Multi-Agent)

**Purpose**: Validate all checklist items using specialized agents

**Your Actions**:

1. **Launch Parallel Checklist Validators**:

   ```
   # For Discovery → Delivery (DoR)

   # Requirements Validator
   Task(
       subagent_type="requirements-analyst",
       description="Validate requirements completeness",
       prompt="""
       Check Definition of Ready requirements criteria:

       - [ ] Use-case brief authored
       - [ ] Acceptance criteria defined
       - [ ] Pre-conditions and post-conditions documented
       - [ ] Happy path and alternative flows identified

       For each item:
       - Status: PASS | FAIL
       - Evidence: File path or reference
       - Issues: Description if failed

       Output: .aiwg/working/handoff/checklist/requirements-validation.md
       """
   )

   # Design Validator
   Task(
       subagent_type="architecture-designer",
       description="Validate design completeness",
       prompt="""
       Check Definition of Ready design criteria:

       - [ ] Data contracts defined (if new entities)
       - [ ] Interface specifications complete (if API changes)
       - [ ] Integration points identified
       - [ ] Backward compatibility validated

       For each item:
       - Status: PASS | FAIL
       - Evidence: Documentation reference
       - Issues: Gaps identified

       Output: .aiwg/working/handoff/checklist/design-validation.md
       """
   )

   # Risk Validator
   Task(
       subagent_type="project-manager",
       description="Validate risk management",
       prompt="""
       Check Definition of Ready risk criteria:

       - [ ] High-risk assumptions validated
       - [ ] Technical risks documented
       - [ ] Dependencies identified and resolved
       - [ ] No blocking risks without mitigation

       For each item:
       - Status: PASS | FAIL
       - Evidence: Risk cards, spike results
       - Issues: Unmitigated risks

       Output: .aiwg/working/handoff/checklist/risk-validation.md
       """
   )
   ```

2. **For Delivery → Operations (ORR)**:

   ```
   # Code Completeness
   Task(
       subagent_type="software-implementer",
       description="Validate code completeness",
       prompt="""
       Check code completeness criteria:

       - [ ] All planned features implemented
       - [ ] Code peer-reviewed and approved
       - [ ] Code merged to main branch
       - [ ] No compiler warnings or linter errors
       - [ ] Technical debt documented

       Validate against:
       - Pull request history
       - Code review comments
       - Build logs
       - Static analysis reports

       Output: .aiwg/working/handoff/checklist/code-validation.md
       """
   )

   # Test Completeness
   Task(
       subagent_type="test-engineer",
       description="Validate test completeness",
       prompt="""
       Check test completeness criteria:

       - [ ] Unit test coverage ≥ 80%
       - [ ] Integration tests passing 100%
       - [ ] Acceptance tests passing
       - [ ] Regression tests passing
       - [ ] Performance tests passing
       - [ ] Security scans passing

       Validate against:
       - Coverage reports
       - Test execution results
       - Performance benchmarks
       - Security scan reports

       Output: .aiwg/working/handoff/checklist/test-validation.md
       """
   )

   # Quality Gates
   Task(
       subagent_type="security-gatekeeper",
       description="Validate quality gates",
       prompt="""
       Check quality gate criteria:

       Security Gate:
       - [ ] SAST/DAST scans clean
       - [ ] No Critical/High vulnerabilities

       Reliability Gate:
       - [ ] SLIs within targets
       - [ ] Performance SLOs met

       Documentation Gate:
       - [ ] Release notes updated
       - [ ] Runbooks complete

       Traceability Gate:
       - [ ] Requirements → code → tests verified

       Output: .aiwg/working/handoff/checklist/gates-validation.md
       """
   )

   # Operational Readiness
   Task(
       subagent_type="operations-manager",
       description="Validate operational readiness",
       prompt="""
       Check operational readiness criteria:

       Deployment:
       - [ ] Deployed to dev/test/staging successfully
       - [ ] Feature flags configured
       - [ ] Configuration changes documented

       Operations:
       - [ ] Monitoring and alerting configured
       - [ ] Logging configured
       - [ ] Backup and recovery tested
       - [ ] Rollback plan tested

       Support:
       - [ ] Support plan in place
       - [ ] Operations team trained
       - [ ] Support team trained

       Output: .aiwg/working/handoff/checklist/operations-validation.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Running checklist validation (parallel agents)...
✓ Requirements validation: PASS
✓ Design validation: PASS
✓ Risk validation: CONDITIONAL
✓ Code validation: PASS
✓ Test validation: PASS
✓ Gates validation: PASS
✓ Operations validation: CONDITIONAL
```

### Step 4: Obtain Signoffs

**Purpose**: Track and obtain required signoffs from stakeholders

**Your Actions**:

1. **Identify Required Signoffs**:
   ```
   Based on handoff type, determine required signoffs:

   Discovery → Delivery:
   - Requirements Reviewer
   - Product Owner
   - Project Manager

   Delivery → Operations:
   - Deployment Manager
   - Reliability Engineer
   - Security Gatekeeper
   - Operations Lead
   - Support Lead

   Phase Transitions:
   - Executive Sponsor
   - Architecture Owner
   - Project Manager
   ```

2. **Generate Signoff Requests**:
   ```
   Task(
       subagent_type="project-manager",
       description="Generate signoff tracking",
       prompt="""
       Create signoff tracking for {handoff-type}:

       Required Signoffs:
       - {Role}: Status [OBTAINED | PENDING | DECLINED]
         - Request Date: {date}
         - Response Date: {date if obtained}
         - Comments: {feedback}

       For pending signoffs:
       - Generate request summary
       - List items requiring attention
       - Provide checklist status

       Output: .aiwg/working/handoff/signoffs/signoff-tracking.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Tracking signoffs...
✓ Signoffs obtained: {obtained}/{required}
⚠️ Pending: {list of pending signoffs}
```

### Step 5: Synthesize Handoff Report

**Purpose**: Generate comprehensive handoff validation report

**Your Actions**:

```
Task(
    subagent_type="documentation-synthesizer",
    description="Generate handoff validation report",
    prompt="""
    Read all validation results:
    - .aiwg/working/handoff/artifacts/*.md
    - .aiwg/working/handoff/checklist/*.md
    - .aiwg/working/handoff/signoffs/*.md

    Generate Handoff Validation Report:

    # Handoff Validation Report

    **Handoff**: {from-phase} → {to-phase}
    **Project**: {project-name}
    **Date**: {current-date}

    ## Overall Status

    **Readiness**: {READY | PARTIAL | BLOCKED}
    **Checklist Compliance**: {percentage}% ({passed}/{total} items)
    **Signoff Status**: {percentage}% ({obtained}/{required})

    **Handoff Decision**: {APPROVED | CONDITIONAL | REJECTED}

    ## Artifact Validation

    ### Required Artifacts ({passed}/{total})
    {for each required artifact}
    - [ ] {artifact-name}
      - Status: {PRESENT | MISSING | INCOMPLETE}
      - Location: {file-path}
      - Completeness: {percentage}%
      - Issues: {list problems}

    ## Checklist Results

    ### {Category} ({passed}/{total})
    {for each checklist item}
    - [ ] {criterion-description}
      - Status: {PASS | FAIL}
      - Evidence: {file-path or reference}
      - Issues: {description if failed}

    ## Signoff Status

    **Required Signoffs** ({obtained}/{required}):
    - [ ] {Role}: {OBTAINED | PENDING | DECLINED}
      - Comments: {feedback}

    ## Handoff Decision

    **Decision**: {APPROVED | CONDITIONAL | REJECTED}

    **Rationale**:
    {detailed reasoning based on validation results}

    **Conditions** (if CONDITIONAL):
    1. {condition that must be met}
    2. {condition that must be met}

    **Blockers** (if REJECTED):
    1. {critical issue blocking handoff}
    2. {critical issue blocking handoff}

    ## Gaps and Remediation

    ### Critical Gaps (Must Fix)
    {list critical missing items}

    **Remediation Actions**:
    1. {action} - Owner: {role} - Due: {date}
    2. {action} - Owner: {role} - Due: {date}

    ### Non-Critical Gaps (Can Defer)
    {list minor missing items}

    **Deferral Plan**:
    {how these will be addressed post-handoff}

    ## Next Steps

    **If APPROVED**:
    - [ ] Schedule {to-phase} kickoff
    - [ ] Transfer artifacts
    - [ ] Assign {to-phase} team

    **If CONDITIONAL**:
    - [ ] Complete conditions
    - [ ] Re-validate within {timeframe}

    **If REJECTED**:
    - [ ] Address critical gaps
    - [ ] Re-run validation
    - [ ] Target date: {date}

    ## Recommendations

    {process improvements}
    {risk mitigations}
    {communication adjustments}

    Save to: .aiwg/handoffs/handoff-report-{from}-to-{to}-{date}.md
    """
)
```

**Communicate Progress**:
```
⏳ Generating handoff report...
✓ Handoff report complete: .aiwg/handoffs/handoff-report-{from}-to-{to}.md
```

### Step 6: Execute Handoff Package Creation

**Purpose**: Create handoff package with all artifacts and context

**Your Actions**:

1. **For APPROVED Handoffs**:
   ```
   Task(
       subagent_type="documentation-archivist",
       description="Create handoff package",
       prompt="""
       Create handoff package for {from-phase} → {to-phase}:

       1. Tag artifacts in version control:
          git tag {phase}-handoff-{YYYY-MM-DD}

       2. Create handoff package:
          .aiwg/handoffs/{from}-to-{to}/
          ├── artifacts/      # Copy of all artifacts
          ├── context/        # Context transfer docs
          ├── report.md       # Handoff report
          └── README.md       # Package overview

       3. Generate context transfer document:
          - Key decisions made
          - Outstanding risks
          - Technical debt
          - Lessons learned
          - Team recommendations

       4. Schedule handoff meeting:
          - Date: Within 1 week
          - Attendees: From and To teams
          - Agenda: Context transfer

       Output: .aiwg/handoffs/{from}-to-{to}/README.md
       """
   )
   ```

2. **For CONDITIONAL Handoffs**:
   ```
   Task(
       subagent_type="project-manager",
       description="Create conditional handoff plan",
       prompt="""
       Create action plan for conditional handoff:

       1. List conditions to be met:
          - {condition 1} - Owner - Due date
          - {condition 2} - Owner - Due date

       2. Create tracking mechanism:
          - TodoWrite entries for each condition
          - Daily check-ins scheduled

       3. Set re-validation date:
          - Target: {date}
          - Validator: {role}

       4. Define escalation path:
          - If conditions not met by {date}
          - Escalate to: {executive}

       Output: .aiwg/handoffs/conditional-plan-{from}-to-{to}.md
       """
   )
   ```

**Communicate Progress**:
```
✓ Handoff package created: .aiwg/handoffs/{from}-to-{to}/
✓ Version tagged: {phase}-handoff-{date}
✓ Handoff meeting scheduled: {date}
```

## Quality Gates

Before marking workflow complete, verify:
- [ ] All required artifacts validated
- [ ] Checklist items assessed (100% coverage)
- [ ] Signoff status tracked
- [ ] Handoff decision clear (APPROVED/CONDITIONAL/REJECTED)
- [ ] Remediation plan provided for gaps
- [ ] Handoff package created (if approved)
- [ ] Next steps documented

## User Communication

**At start**: Confirm understanding and handoff type

```
Understood. I'll validate the {from-phase} → {to-phase} handoff.

This will check:
- Required artifacts presence and completeness
- Checklist criteria compliance
- Signoff status from stakeholders
- Overall handoff readiness

I'll coordinate multiple specialized agents for validation.
Expected duration: 10-15 minutes.

Starting handoff validation...
```

**During**: Update progress with clear indicators

```
✓ = Complete/Pass
⏳ = In progress
❌ = Failed/Missing
⚠️ = Warning/Conditional
```

**At end**: Summary report with decision and next steps

```
─────────────────────────────────────────────
Handoff Validation Complete
─────────────────────────────────────────────

**Handoff**: Discovery → Delivery
**Decision**: APPROVED

**Summary**:
✓ Artifacts: 12/12 complete
✓ Checklist: 95% compliant (19/20 items)
✓ Signoffs: 3/3 obtained

**Minor Gaps** (non-blocking):
- Performance test scenarios need enhancement
  → Can be addressed during sprint

**Next Steps**:
1. Review handoff report: .aiwg/handoffs/handoff-report-discovery-to-delivery.md
2. Handoff meeting scheduled: Tuesday 10am
3. Delivery team can begin sprint planning

**Artifacts Transferred**:
- 5 use case briefs
- 5 acceptance test cards
- 3 interface specifications
- 2 spike results

Ready to proceed with Delivery phase.
─────────────────────────────────────────────
```

## Error Handling

**Unknown Handoff**:
```
❌ Unknown handoff: {from-phase} → {to-phase}

Supported handoffs:
- Phase: inception→elaboration, elaboration→construction, construction→transition
- Track: discovery→delivery, delivery→operations
- Special: intake→inception, concept→inception

Please specify a valid handoff type.
```

**Missing Critical Artifacts**:
```
❌ Critical artifacts missing - handoff BLOCKED

Missing:
- {artifact-1}: Required for {reason}
- {artifact-2}: Required for {reason}

These must be completed before handoff.
Recommended actions:
1. Complete {artifact-1} using template
2. Obtain stakeholder approval
3. Re-run handoff validation

Impact: Cannot proceed to {to-phase} until resolved.
```

**Failed Checklist Items**:
```
⚠️ Checklist compliance: {percentage}% (target: 100%)

Failed items:
- {item-1}: {reason for failure}
- {item-2}: {reason for failure}

Recommendation: Address failed items or obtain exception approval
```

**Declined Signoff**:
```
❌ Signoff declined by {role}

Reason: {feedback from role}

Actions required:
1. Address concerns raised
2. Update artifacts as needed
3. Request re-review

Escalation: Contact Project Manager if disagreement persists
```

## Success Criteria

This orchestration succeeds when:
- [ ] Handoff type identified and validated
- [ ] All required artifacts checked for presence
- [ ] Artifact completeness assessed
- [ ] Checklist items validated (100% coverage)
- [ ] Signoff status determined
- [ ] Handoff decision clear (APPROVED/CONDITIONAL/REJECTED)
- [ ] Remediation plan provided for any gaps
- [ ] Handoff report generated
- [ ] Next steps documented

## Metrics to Track

**During orchestration, track**:
- Artifact completeness: % of required artifacts present and complete
- Checklist compliance: % of checklist items passing
- Signoff rate: % of required signoffs obtained
- Gap severity: Critical vs. non-critical gaps identified
- Remediation effort: Estimated hours to close gaps
- Handoff cycle time: Days from request to approval

## References

**Templates** (via $AIWG_ROOT):
- Handoff checklists: `flows/handoff-checklist-template.md`
- Gate criteria: `flows/gate-criteria-by-phase.md`
- ORR template: `deployment/operational-readiness-review-template.md`

**Related Commands**:
- Traceability: `commands/check-traceability.md`
- Gate checks: `commands/flow-gate-check.md`
- Phase transitions: `commands/flow-inception-to-elaboration.md`

**Handoff Patterns**:
- Definition of Ready: `docs/definition-of-ready-pattern.md`
- Operational Readiness: `docs/operational-readiness-pattern.md`
