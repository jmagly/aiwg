---
namespace: aiwg
name: flow-gate-check
platforms: [all]
description: Orchestrate SDLC phase gate validation with multi-agent review and comprehensive reporting
commandHint:
  argumentHint: <phase-or-gate-name> [project-directory] [--guidance "text"] [--interactive]
  allowedTools: Task, Read, Write, Glob, TodoWrite
  model: sonnet
  category: sdlc-orchestration
  orchestration: true
  modelRole: coding
  modelTier: standard
---

> **Declarative Flow (#1539):** This flow's orchestration is now also expressed as a
> declarative YAML Flow at `flows/flow-gate-check.playbook.yaml` (source of truth for the step
> sequence + gates). This SKILL.md remains the discoverable trigger surface and prose
> reference. See epic #1534.

# SDLC Gate Check Orchestration

**You are the Core Orchestrator** for SDLC phase gate validation.

## Delegation

Follow [Worker delegation](references/delegation.md) before every worker launch.

## Output template

Required for the gate audit record; retain phase-specific criteria: @$AIWG_ROOT/agentic/code/addons/testing-quality/templates/gate-audit-record.md. Fill every required section; explain non-applicable fields and unrun checks.

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
- "Can we transition to {phase}?"
- "Are we ready for {phase}?"
- "Validate gate criteria"
- "Check if we can proceed"
- "Gate validation for {phase}"
- "Check {phase} readiness"
- "Is the {milestone} complete?"
- "Run gate check for {phase}"
- "Validate our readiness to move forward"

You recognize these as requests for this orchestration flow.

## Parameter Handling

### Phase/Gate Identification

**Supported Gates**:

**Phase Milestones**:
- `inception` / `LOM` - Lifecycle Objective Milestone
- `elaboration` / `ABM` - Architecture Baseline Milestone
- `construction` / `IOC` - Initial Operational Capability
- `transition` / `PR` - Product Release

**Workflow Gates**:
- `discovery` - Discovery Track Definition of Ready
- `delivery` - Delivery Track Definition of Done
- `security` - Security validation
- `reliability` - Performance and SLO compliance
- `test-coverage` - Test coverage thresholds
- `documentation` - Documentation completeness
- `traceability` - Requirements → code → tests
- `12-factor` - 12-factor app methodology compliance (opt-in, cloud-native targets)

**Special Gates**:
- `all` - Run all applicable gates
- `pre-deploy` - Pre-deployment readiness
- `orr` - Operational Readiness Review

### --guidance Parameter

**Purpose**: User provides upfront direction to tailor validation priorities

**Examples**:
```
--guidance "Focus on security compliance, HIPAA critical"
--guidance "Time-constrained, prioritize minimum viable gates"
--guidance "Enterprise deployment, need full compliance validation"
```

**How to Apply**:
- Parse guidance for keywords: security, compliance, timeline, quality
- Adjust validation depth (comprehensive vs. essential)
- Influence agent assignments (add specialized validators)
- Modify reporting detail level

### --interactive Parameter

**Purpose**: You ask 3-5 strategic questions to understand context

**Questions to Ask** (if --interactive):

```
I'll ask strategic questions to tailor the gate validation:

Q1: What's your primary concern for this gate check?
    (e.g., compliance readiness, technical quality, team preparedness)

Q2: Are there any known issues or gaps you're concerned about?
    (Help me focus validation on problem areas)

Q3: What's your timeline for passing this gate?
    (Influences whether to report quick-fixes vs. comprehensive remediation)

Q4: Who needs to sign off on this gate?
    (Helps identify which specialized reviewers to involve)

Q5: What happens if the gate doesn't pass?
    (Helps determine how strict validation should be)
```

## Multi-Agent Orchestration Workflow

### Step 1: Determine Gate Context

**Purpose**: Identify which gate to validate and current project state

**Your Actions**:

1. **Parse Gate Parameter**:
   ```
   Map user input to gate type:
   - "inception" | "LOM" → Lifecycle Objective Milestone
   - "elaboration" | "ABM" → Architecture Baseline Milestone
   - "construction" | "IOC" → Initial Operational Capability
   - "transition" | "PR" → Product Release
   - Others → Workflow or special gates
   ```

2. **Scan Project State**:
   ```
   Use Glob to check for phase indicators:
   - .aiwg/intake/* → Likely in Inception
   - .aiwg/architecture/software-architecture-doc.md → Likely post-Elaboration
   - .aiwg/testing/test-results/* → Likely in Construction
   - .aiwg/deployment/production-deploy.md → Likely in Transition
   ```

**Communicate Progress**:
```
✓ Gate identified: {gate-name}
⏳ Scanning project state...
✓ Current phase detected: {phase}
```

### Step 2: Phase Gate Validation (LOM/ABM/IOC/PR)

#### 2.1: Inception Gate (LOM) Validation

**When**: User requests "inception", "LOM", or system detects Inception phase

**Launch Validation Agents**:

```
# Primary Validator
Task(
    subagent_type="project-manager",
    description="Validate Lifecycle Objective Milestone criteria",
    prompt="""
    Read gate criteria from: $AIWG_ROOT/agentic/code/frameworks/sdlc-complete/flows/gate-criteria-by-phase.md

    Check for required Inception artifacts:
    - .aiwg/intake/project-intake.md (COMPLETE)
    - .aiwg/requirements/vision-*.md (APPROVED)
    - .aiwg/planning/business-case-*.md (APPROVED)
    - .aiwg/risks/risk-list.md (BASELINED)
    - .aiwg/security/data-classification.md (COMPLETE)

    Validate LOM criteria:
    - Vision document APPROVED (stakeholder signoff ≥75%)
    - Business case APPROVED (funding secured)
    - Risk list BASELINED (5-10 risks, top 3 have mitigation)
    - Data classification COMPLETE
    - Initial architecture documented
    - Executive Sponsor approval obtained

    Generate validation report:
    - Status: PASS | FAIL | CONDITIONAL
    - Missing artifacts list
    - Failed criteria with reasons
    - Signoff status
    - Remediation actions

    Save to: .aiwg/gates/lom-validation-report.md
    """
)

# Parallel Specialized Reviewers
Task(
    subagent_type="business-analyst",
    description="Validate business readiness for LOM",
    prompt="""
    Review business artifacts:
    - Business case viability
    - Stakeholder alignment
    - Funding adequacy
    - Vision clarity

    Report business readiness: READY | GAPS | BLOCKED
    Save to: .aiwg/gates/lom-business-review.md
    """
)

Task(
    subagent_type="security-architect",
    description="Validate security readiness for LOM",
    prompt="""
    Review security artifacts:
    - Data classification completeness
    - Initial threat assessment
    - Compliance requirements identified
    - Security risks documented

    Report security readiness: READY | GAPS | BLOCKED
    Save to: .aiwg/gates/lom-security-review.md
    """
)
```

#### 2.2: Elaboration Gate (ABM) Validation

**When**: User requests "elaboration", "ABM", or system detects Elaboration phase

**Launch Validation Agents**:

```
# Primary Validator
Task(
    subagent_type="project-manager",
    description="Validate Architecture Baseline Milestone criteria",
    prompt="""
    Read gate criteria from: $AIWG_ROOT/agentic/code/frameworks/sdlc-complete/flows/gate-criteria-by-phase.md

    Check for required Elaboration artifacts:
    - .aiwg/architecture/software-architecture-doc.md (BASELINED)
    - .aiwg/architecture/adr/*.md (3-5 ADRs)
    - .aiwg/requirements/supplemental-specification.md (COMPLETE)
    - .aiwg/testing/master-test-plan.md (APPROVED)
    - .aiwg/risks/risk-retirement-report.md

    Check for Layer 3 behavioral specifications:
    - .aiwg/requirements/realizations/DES-UCR-*.md (use case realizations)
    - .aiwg/architecture/state-machines/DES-SM-*.md (state machine specs)
    - .aiwg/architecture/decision-tables/DES-DT-*.md (decision tables)
    - .aiwg/architecture/method-contracts/DES-MIC-*.md (method interface contracts)
    - .aiwg/architecture/activity-diagrams/DES-ACT-*.md (activity diagrams)

    Validate ABM criteria:
    - Architecture BASELINED and peer-reviewed
    - ADRs documented (3-5 major decisions)
    - Risks ≥70% retired or mitigated
    - Requirements baseline established
    - Test strategy approved
    - Development case tailored
    - Behavioral spec coverage ≥80% of architecturally significant use cases
    - Every behavioral spec has a completeness checklist satisfied
    - Traceability: UC → behavioral spec IDs present in realizations

    Generate validation report:
    - List each use case and whether it has a behavioral spec (realization)
    - Report behavioral spec coverage percentage
    - Flag use cases without realizations as GAPS
    - Overall status: PASS requires ≥80% coverage of architecturally significant UCs

    Save to: .aiwg/gates/abm-validation-report.md
    """
)

# Architecture validation specialist
Task(
    subagent_type="architecture-designer",
    description="Deep validation of architecture readiness",
    prompt="""
    Validate architecture completeness:
    - All views documented (logical, physical, deployment)
    - Technology decisions justified
    - Integration points defined
    - Security architecture complete
    - Performance architecture validated

    Check architecture risks retired via POCs
    Report: READY | GAPS | BLOCKED
    Save to: .aiwg/gates/abm-architecture-review.md
    """
)

# Behavioral specification validation
Task(
    subagent_type="requirements-analyst",
    description="Validate behavioral specifications (Layer 3) completeness",
    prompt="""
    Validate Layer 3 behavioral specifications:

    Check for use case realizations:
    - .aiwg/requirements/realizations/DES-UCR-*.md
    - ≥80% coverage of architecturally significant use cases

    Check for supporting specs:
    - .aiwg/architecture/state-machines/DES-SM-*.md (stateful entities)
    - .aiwg/architecture/decision-tables/DES-DT-*.md (branching logic)
    - .aiwg/architecture/method-contracts/DES-MIC-*.md (method interfaces)
    - .aiwg/architecture/activity-diagrams/DES-ACT-*.md (complex flows)

    For each use case in .aiwg/requirements/:
    - List whether it has a corresponding realization
    - Report coverage percentage
    - Flag gaps

    Report: READY | GAPS | BLOCKED
    Include per-UC coverage table in report
    Save to: .aiwg/gates/abm-behavioral-spec-review.md
    """
)

# Test readiness specialist
Task(
    subagent_type="test-architect",
    description="Validate test strategy readiness",
    prompt="""
    Review test planning:
    - Master Test Plan completeness
    - Test environment readiness
    - Test data strategy defined
    - Automation approach clear
    - Coverage targets established

    Report: READY | GAPS | BLOCKED
    Save to: .aiwg/gates/abm-test-review.md
    """
)
```

#### 2.3: Construction Gate (IOC) Validation

**When**: User requests "construction", "IOC", or system detects Construction complete

**Launch Validation Agents**:

```
# Primary Validator
Task(
    subagent_type="project-manager",
    description="Validate Initial Operational Capability",
    prompt="""
    Check for Construction completeness:
    - All use cases implemented
    - Test coverage targets met
    - Performance within SLOs
    - Security scans passing
    - Documentation current

    Check pseudo-code spec coverage (Layer 4):
    - Every implemented method has a DES-PSC-*.md spec
    - Spec coverage ≥80% of critical-path methods (configurable threshold)
    - Error handling trees exist for critical paths
    - Data structure specs match implementation

    Validate IOC criteria:
    - Unit test coverage ≥80%
    - Integration tests 100% passing
    - Acceptance tests validated
    - No High/Critical vulnerabilities
    - Release notes complete
    - Runbooks documented
    - Traceability complete: UC → behavioral → pseudo-code → code → test

    Generate comprehensive IOC report with:
    - Behavioral spec → pseudo-code coverage matrix
    - Spec-to-code traceability gaps
    Save to: .aiwg/gates/ioc-validation-report.md
    """
)

# Quality validation team (parallel)
Task(
    subagent_type="test-engineer",
    description="Validate test coverage and quality",
    prompt="""
    Analyze test metrics:
    - Unit coverage percentage
    - Integration test results
    - Acceptance test status
    - Performance test results
    - Regression test status

    Validate against Master Test Plan targets
    Report: PASS | FAIL with specific gaps
    Save to: .aiwg/gates/ioc-test-validation.md
    """
)

Task(
    subagent_type="security-gatekeeper",
    description="Security gate validation",
    prompt="""
    Review security posture:
    - SAST/DAST results
    - Vulnerability scan status
    - Dependency analysis
    - Secret scanning results
    - OWASP compliance

    Validate: No High/Critical without mitigation
    Report: PASS | FAIL with remediation
    Save to: .aiwg/gates/ioc-security-validation.md
    """
)

Task(
    subagent_type="reliability-engineer",
    description="Performance and reliability validation",
    prompt="""
    Validate SLOs:
    - Response time (p50, p95, p99)
    - Throughput capacity
    - Error rates
    - Resource utilization
    - Scalability validation

    Compare against targets in supplemental spec
    Report: PASS | FAIL with metrics
    Save to: .aiwg/gates/ioc-reliability-validation.md
    """
)
```

#### 2.4: Transition Gate (PR) Validation

**When**: User requests "transition", "PR", "orr", or system detects Transition phase

**Launch Validation Agents**:

```
# Primary Validator
Task(
    subagent_type="project-manager",
    description="Validate Product Release readiness",
    prompt="""
    Validate Transition/Release criteria:
    - Operational Readiness Review complete
    - Production deployment validated
    - User training materials ready
    - Support plan established
    - Monitoring configured
    - Rollback tested

    Check for:
    - User acceptance signoff
    - Operations team readiness
    - Support team training
    - Business stakeholder approval

    Generate Product Release validation report
    Save to: .aiwg/gates/pr-validation-report.md
    """
)

# Operations readiness team
Task(
    subagent_type="devops-engineer",
    description="Validate operational readiness",
    prompt="""
    Review deployment readiness:
    - Infrastructure provisioned
    - Monitoring/alerting configured
    - Logging established
    - Backup/recovery tested
    - Rollback procedures validated
    - Runbooks complete

    Report: READY | GAPS | BLOCKED
    Save to: .aiwg/gates/pr-operations-review.md
    """
)

Task(
    subagent_type="support-engineer",
    description="Validate support readiness",
    prompt="""
    Review support preparedness:
    - Support documentation complete
    - Known issues documented
    - Escalation paths defined
    - Support team trained
    - User guides available
    - FAQ/troubleshooting ready

    Report: READY | GAPS | BLOCKED
    Save to: .aiwg/gates/pr-support-review.md
    """
)
```

### Step 3: Workflow Gate Validation

**For non-phase gates** (security, reliability, test-coverage, etc.):

```
# Dispatch to appropriate specialist
if gate == "security":
    Task(
        subagent_type="security-gatekeeper",
        description="Run security gate validation",
        prompt="""
        Comprehensive security validation:
        - Run/review SAST results
        - Run/review DAST results
        - Check dependency vulnerabilities
        - Scan for secrets
        - Validate OWASP Top 10
        - Review security architecture

        Pass criteria: No High/Critical without accepted risk
        Generate detailed findings
        Save to: .aiwg/gates/security-gate-report.md
        """
    )

elif gate == "reliability":
    Task(
        subagent_type="reliability-engineer",
        description="Run reliability gate validation",
        prompt="""
        Validate performance and reliability:
        - Load test results
        - Stress test results
        - SLI/SLO compliance
        - Resource utilization
        - Scalability validation

        Pass criteria: All SLOs met
        Generate metrics report
        Save to: .aiwg/gates/reliability-gate-report.md
        """
    )

elif gate == "test-coverage":
    Task(
        subagent_type="test-engineer",
        description="Run test coverage validation",
        prompt="""
        Analyze test coverage:
        - Unit test coverage
        - Integration coverage
        - Critical path coverage
        - Error handling coverage
        - Edge case coverage

        Pass criteria: Meet Master Test Plan thresholds
        Generate coverage report
        Save to: .aiwg/gates/test-coverage-report.md
        """
    )

elif gate == "documentation":
    Task(
        subagent_type="technical-writer",
        description="Run documentation gate validation",
        prompt="""
        Validate documentation completeness:
        - User documentation
        - API documentation
        - Release notes
        - Runbooks
        - Architecture docs
        - README files

        Pass criteria: All user-facing docs complete
        Generate completeness report
        Save to: .aiwg/gates/documentation-gate-report.md
        """
    )

elif gate == "traceability":
    Task(
        subagent_type="requirements-analyst",
        description="Run traceability validation",
        prompt="""
        Validate bidirectional traceability:
        - Requirements → Code
        - Code → Tests
        - Tests → Requirements
        - Risks → Mitigations
        - Decisions → Implementation

        Pass criteria: 100% traceability
        Generate traceability matrix
        Save to: .aiwg/gates/traceability-gate-report.md
        """
    )

elif gate == "12-factor":
    # 12-Factor App methodology compliance gate (opt-in, cloud-native targets)
    # Combines declarative lint (fast, deterministic) with architecture-designer
    # review (semantic quality of SAD process architecture).
    # Reference: .aiwg/reports/12-factor-gap-analysis.md, issue #821

    # Layer 1: Declarative lint — structural checks (seconds)
    Task(
        subagent_type="project-manager",
        description="Run SDLC 12-factor lint ruleset",
        prompt="""
        Run the SDLC 12-factor lint ruleset against the project artifacts:

        Command: aiwg lint .aiwg/ --ruleset sdlc --format json --ci --fail-on warn

        The ruleset checks 10 structural conditions covering all 12 factors:
        - dependency-manifest-present (II)
        - sad-process-architecture (VI, VIII)
        - sad-backing-services-locator (IV)
        - sad-logging-architecture (XI)
        - deployment-plan-deployments-table (I)
        - deployment-plan-rolling-restart (IX)
        - deployment-plan-admin-tasks (XII)
        - env-parity-matrix (X)
        - env-var-catalog (III)
        - admin-processes-documented (XII)

        Parse JSON output. Group diagnostics by factor.
        Pass criteria: 0 errors; warnings documented with rationale if not addressed.
        Save to: .aiwg/gates/12-factor-lint-report.md
        """
    )

    # Layer 2: Architecture review — semantic quality of Process Architecture
    Task(
        subagent_type="architecture-designer",
        description="Validate Process Architecture section of SAD",
        prompt="""
        Deep review of the Software Architecture Document Section 9a (Process Architecture).
        See .aiwg/architecture/software-architecture-doc.md.

        Assess semantic quality (lint covers only presence, not correctness):

        9a.1 Process Types — every process archetype listed with scaling axis, concurrency limits
        9a.2 Process State Model — every state kind externalized to backing service, no in-process state
        9a.3 Disposability — startup < 10s target stated, SIGTERM handlers confirmed, crash recovery described
        9a.4 Port Binding — self-contained services, no dependency on external web server (or ADR)
        9a.5 Backing Services — every resource via env var, swap criteria realistic
        9a.6 Logging Architecture — stdout/JSON, no file handlers, correlation IDs propagated

        For each: PASS | GAP | RISK | N/A-with-ADR

        Flag any section that lists state, disk writes, or log files that violate the corresponding rule:
        - rules/stateless-processes.md
        - rules/disposable-processes.md
        - rules/logs-as-event-streams.md
        - rules/config-in-environment.md

        Save to: .aiwg/gates/12-factor-architecture-review.md
        """
    )

    # Layer 3: Deployment readiness — does the deployment plan reflect the process model?
    Task(
        subagent_type="deployment-manager",
        description="Validate deployment plan 12-factor compliance",
        prompt="""
        Review deployment artifacts for 12-factor deployment readiness.
        See .aiwg/deployment/deployment-plan.md and deployment-environment.md.

        Check:
        - Deployments Table: every target environment enumerated? (Factor I)
        - Rolling Restart Strategy: grace periods realistic? match SAD disposability SLA? (Factor IX)
        - Admin Tasks: all migrations/backfills reference admin-processes catalog? (Factor XII)
        - Tech Stack Parity Matrix: dev/staging/prod use same tech? parity violations ADR'd? (Factor X)
        - Environment Variable Catalog: matches .env.example at project root? (Factor III)

        Pass criteria: all 5 sections present and consistent with SAD Section 9a.
        Save to: .aiwg/gates/12-factor-deployment-review.md
        """
    )
```

### Step 4: Synthesize Results

**Purpose**: Combine all validation results into comprehensive gate report

```
Task(
    subagent_type="project-manager",
    description="Synthesize gate validation results",
    prompt="""
    Read all validation reports from .aiwg/gates/*.md

    Create comprehensive Gate Validation Report:

    # Gate Validation Report

    **Gate**: {gate-name}
    **Date**: {current-date}
    **Overall Status**: PASS | FAIL | CONDITIONAL

    ## Summary
    - Pass Rate: X% (Y/Z criteria)
    - Decision: GO | NO-GO | CONDITIONAL GO

    ## Validation Results

    ### Required Artifacts
    - List each with status (PRESENT/MISSING/INCOMPLETE)

    ### Quality Gates
    - List each gate with PASS/FAIL status

    ### Failed Criteria
    - Detailed list with reasons

    ### Signoff Status
    - List required signoffs with status

    ## Remediation Plan
    - Prioritized list of actions to pass gate
    - Owner assignments
    - Timeline estimates

    ## Recommendations
    - Process improvements
    - Risk mitigations
    - Next steps

    ## Decision
    - Clear GO/NO-GO/CONDITIONAL recommendation
    - Rationale based on findings
    - Conditions if CONDITIONAL

    Save to: .aiwg/reports/gate-validation-{gate}-{date}.md
    """
)
```

### Step 5: Present Results to User

**Your Direct Communication**:

```
─────────────────────────────────────────────
{Gate Name} Validation Complete
─────────────────────────────────────────────

**Overall Status**: {PASS | FAIL | CONDITIONAL}
**Decision**: {GO | NO-GO | CONDITIONAL GO}

**Validation Summary**:
✓ Required Artifacts: {X/Y} complete
✓ Quality Gates: {X/Y} passed
✓ Signoffs: {X/Y} obtained

{If FAIL or CONDITIONAL:}
**Critical Issues**:
- {Issue 1 with impact}
- {Issue 2 with impact}

**Remediation Required**:
1. {Action} - Owner: {role} - Est: {time}
2. {Action} - Owner: {role} - Est: {time}

**Reports Generated**:
- Full Report: .aiwg/reports/gate-validation-{gate}-{date}.md
- Specialist Reviews: .aiwg/gates/*.md

**Next Steps**:
{If PASS}: Proceed to {next-phase}
{If FAIL}: Complete remediation, then re-validate
{If CONDITIONAL}: Address conditions within {timeframe}

─────────────────────────────────────────────
```

## Special Gate Orchestration

### "All" Gates

When user requests "all":
1. Detect current phase from artifacts
2. Run all applicable gates for that phase
3. Generate consolidated report

### "Pre-Deploy" Gates

When user requests "pre-deploy":
1. Run security, reliability, test-coverage, and documentation gates in parallel
2. All must pass for deployment approval
3. Generate deployment readiness report

## Quality Assurance

Before completing orchestration:
- [ ] All requested gates validated
- [ ] Results from all agents collected
- [ ] Synthesis report generated
- [ ] Clear pass/fail decision provided
- [ ] Remediation actions specific and actionable

## User Communication

**At start**:
```
Understood. I'll orchestrate gate validation for {gate-name}.

This will involve:
- Checking required artifacts
- Running quality validations
- Collecting specialist reviews
- Generating comprehensive report

Expected duration: 5-10 minutes.

Starting validation...
```

**During execution**:
```
✓ = Complete
⏳ = In progress
❌ = Failed check
⚠️ = Issue found
```

**At end**: Present synthesized results (see Step 5)

## Error Handling

**Unknown Gate**:
```
❌ Unknown gate: {input}

Supported gates:
- Phase gates: inception, elaboration, construction, transition
- Workflow gates: security, reliability, test-coverage, documentation, traceability, 12-factor
- Special: all, pre-deploy, orr

Please specify a valid gate.
```

**Missing Critical Artifacts**:
```
⚠️ Cannot validate - critical artifacts missing:
- {artifact-1}: Expected at {path}
- {artifact-2}: Expected at {path}

These artifacts are required for {gate} validation.
Create them using appropriate templates or commands.
```

**Conflicting Results**:
```
⚠️ Validation conflict detected:
- {Agent-1}: PASS
- {Agent-2}: FAIL

Reviewing details to determine overall status...
[Then provide reasoned decision based on criticality]
```

## Success Criteria

This orchestration succeeds when:
- [ ] Appropriate gate criteria identified
- [ ] All validations completed by specialists
- [ ] Results synthesized into clear report
- [ ] Pass/fail decision justified with evidence
- [ ] Remediation plan specific and actionable
- [ ] User receives clear guidance on next steps

## References

**Templates** (via $AIWG_ROOT):
- Gate criteria: `flows/gate-criteria-by-phase.md`
- Handoff checklists: `flows/handoff-checklist-template.md`

**Multi-Agent Pattern**:
- `docs/multi-agent-documentation-pattern.md`

**Orchestrator Architecture**:
- `docs/orchestrator-architecture.md`