---
namespace: aiwg
name: flow-delivery-track
platforms: [all]
description: Orchestrate Delivery Track flow with test-driven development, quality gates, and iteration assessment
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
> declarative YAML Flow at `flows/flow-delivery-track.playbook.yaml` (source of truth for the step
> sequence + gates). This SKILL.md remains the discoverable trigger surface and prose
> reference. See epic #1534.

# Delivery Track Flow

**You are the Core Orchestrator** for the critical Delivery Track iteration implementation.

## Delegation

Follow [Worker delegation](references/delegation.md) before every worker launch.

## Your Role

**You orchestrate multi-agent workflows. You do NOT execute bash scripts.**

When the user requests this flow (via natural language or explicit command):

1. **Interpret the request** and confirm understanding
2. **Read this template** as your orchestration guide
3. **Extract agent assignments** and workflow steps
4. **Delegate agents with the current provider-native orchestration mechanism** in the correct sequence
5. **Synthesize results** and finalize artifacts
6. **Report completion** with summary

## Delivery Track Overview

**Purpose**: Execute prioritized work items with test-driven development and quality gates

**Key Principle**: Each iteration produces production-ready increments through rigorous quality control

**Iteration Duration**: 1-2 weeks typical, 20-30 minutes orchestration

**Success Metrics**:
- All work items meet Definition of Done (DoD)
- Quality gates passed (security, performance, coverage)
- Tests written before implementation (TDD)
- Continuous integration maintained

## Natural Language Triggers

Users may say:
- "Execute delivery for iteration 3"
- "Start delivery track"
- "Execute current iteration"
- "Run implementation sprint"
- "Begin construction iteration"

You recognize these as requests for this orchestration flow.

## Parameter Handling

### Iteration Number

**Required**: The iteration number to execute (e.g., 3, 5, 12)

### --guidance Parameter

**Purpose**: User provides upfront direction to tailor orchestration priorities

**Examples**:
```
--guidance "Focus on security, we have a pen test next week"
--guidance "Performance critical, must maintain sub-100ms response times"
--guidance "Code coverage is slipping, prioritize test completion"
--guidance "New team members, extra code review emphasis needed"
```

**How to Apply**:
- Parse guidance for keywords: security, performance, testing, quality
- Adjust agent assignments (add security-architect for security focus)
- Modify gate thresholds (stricter performance limits if critical)
- Influence priority ordering (tests first vs. features first)

### --interactive Parameter

**Purpose**: You ask 5-7 strategic questions to understand iteration context

**Questions to Ask** (if --interactive):

```
I'll ask 7 strategic questions to tailor the Delivery Track to your needs:

Q1: What are your top priorities for this iteration?
    (e.g., feature completion, tech debt, bug fixes, performance)

Q2: Are there any blocked dependencies or risks?
    (Helps me plan mitigation strategies)

Q3: What's your current test coverage percentage?
    (Influences test-first emphasis and coverage targets)

Q4: Are there any compliance or security requirements this iteration?
    (e.g., security audit preparation, compliance features)

Q5: What's your team's current velocity trend?
    (Helps calibrate iteration scope)

Q6: Any operational concerns for this release?
    (e.g., database migrations, API changes, performance impacts)

Q7: What's the deployment target after this iteration?
    (e.g., staging only, production release, demo environment)

Based on your answers, I'll adjust:
- Agent assignments (add specialized reviewers)
- Quality gate thresholds
- Test coverage requirements
- Security scan depth
```

**Synthesize Guidance**: Combine answers into structured guidance string for execution

## Artifacts to Generate

**Primary Deliverables**:
- **Iteration Plan**: Task breakdown with estimates → `.aiwg/planning/iteration-{N}-plan.md`
- **Implementation Code**: Feature implementation with tests → Project source files
- **Test Results**: Unit, integration, and acceptance tests → `.aiwg/testing/iteration-{N}-test-results.md`
- **Quality Gate Report**: Security, performance, coverage → `.aiwg/gates/iteration-{N}-quality-report.md`
- **Release Notes**: User-facing changes → `.aiwg/deployment/release-notes-iteration-{N}.md`
- **Iteration Assessment**: Velocity and lessons learned → `.aiwg/reports/iteration-{N}-assessment.md`

**Supporting Artifacts**:
- Work package cards (task definitions)
- Design class cards (implementation details)
- Test evaluation summaries
- Defect reports
- Runbook updates

## Multi-Agent Orchestration Workflow

### Step 1: Validate Iteration Readiness

**Purpose**: Ensure backlog items are ready for implementation (DoR met)

**Your Actions**:

1. **Check for Ready Backlog**:
   ```
   Read and verify presence of:
   - .aiwg/planning/iteration-{N}-backlog.md (or discovery output)
   - .aiwg/requirements/use-case-*.md (acceptance criteria)
   - .aiwg/architecture/software-architecture-doc.md (design context)
   ```

2. **Launch Readiness Validation**:
   ```
   Task(
       subagent_type="project-manager",
       description="Validate iteration {N} readiness",
       prompt="""
       Read backlog items for iteration {N}

       Validate Definition of Ready (DoR):
       - User stories have acceptance criteria
       - Technical designs documented
       - Dependencies identified
       - Test criteria defined
       - Estimates provided

       Calculate:
       - Total story points planned
       - Number of work items
       - Risk items to address

       Status: READY | BLOCKED | PARTIAL

       If BLOCKED or PARTIAL, list gaps

       Save validation to: .aiwg/reports/iteration-{N}-readiness.md
       """
   )
   ```

3. **Decision Point**:
   - If READY → Continue to Step 2
   - If BLOCKED → Report gaps, recommend Discovery Track completion
   - If PARTIAL → Proceed with ready items only

**Communicate Progress**:
```
✓ Initialized iteration {N} validation
⏳ Validating backlog readiness...
✓ Iteration readiness: [READY | BLOCKED | PARTIAL]
```

### Step 2: Plan Task Slices and Assignments

**Purpose**: Break down work into 1-2 hour implementable tasks

**Your Actions**:

1. **Read Iteration Context**:
   ```
   Read:
   - .aiwg/planning/iteration-{N}-backlog.md (work items)
   - .aiwg/reports/iteration-{N-1}-assessment.md (velocity history)
   - .aiwg/team/team-profile.yaml (team capacity)
   ```

2. **Launch Task Planning Agents** (parallel):
   ```
   # Agent 1: Software Implementer
   Task(
       subagent_type="software-implementer",
       description="Break down implementation tasks",
       prompt="""
       Read iteration backlog items

       For each user story/feature:
       - Break into 1-2 hour tasks (max 4 hours)
       - Define technical approach
       - Identify test requirements
       - Estimate effort in hours

       Document using work package template:
       - Task ID and name
       - Acceptance criteria
       - Test strategy (unit, integration)
       - Dependencies
       - Estimated hours

       Output: .aiwg/working/iteration-{N}/task-breakdown.md
       """
   )

   # Agent 2: Test Engineer
   Task(
       subagent_type="test-engineer",
       description="Define test-first strategy",
       prompt="""
       Read task breakdown

       For each task, define:
       - Test cases to write BEFORE implementation
       - Unit test scenarios
       - Integration test requirements
       - Acceptance test criteria
       - Expected test coverage

       Create test-first checklist:
       - Which tests block implementation start
       - Test data requirements
       - Mock/stub needs

       Output: .aiwg/working/iteration-{N}/test-first-strategy.md
       """
   )

   # Agent 3: Project Manager
   Task(
       subagent_type="project-manager",
       description="Create iteration plan with assignments",
       prompt="""
       Read task breakdown and test strategy

       Create iteration plan:
       1. Task sequence (considering dependencies)
       2. Owner assignments (load balancing)
       3. Critical path identification
       4. Risk mitigation tasks
       5. Daily milestone targets

       Calculate:
       - Total effort hours
       - Team capacity utilization
       - Iteration burndown forecast

       Template: $AIWG_ROOT/.../management/iteration-plan-template.md

       Output: .aiwg/planning/iteration-{N}-plan.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Planning iteration {N} tasks...
  ✓ Implementation tasks defined ({count} tasks)
  ✓ Test-first strategy created
  ✓ Iteration plan finalized
✓ Iteration plan complete: .aiwg/planning/iteration-{N}-plan.md
```

### Step 3: Implement with Test-Driven Development

**Purpose**: Write tests first, then implement code to pass tests

**Your Actions**:

1. **For Each Task in Plan, Execute TDD Cycle**:
   ```
   # Step 3.1: Write Tests First
   Task(
       subagent_type="test-engineer",
       description="Write tests for task {task-id}",
       prompt="""
       Task: {task-description}
       Acceptance criteria: {criteria}

       Write comprehensive tests BEFORE implementation:

       1. Unit tests for core logic
       2. Integration tests for APIs/services
       3. Edge cases and error conditions
       4. Performance benchmarks (if applicable)

       Use project test framework (Jest, pytest, etc.)
       Tests should FAIL initially (no implementation yet)

       Output test files to project test directories
       Document test count and coverage targets

       Report: .aiwg/working/iteration-{N}/tests/{task-id}-tests.md
       """
   )

   # Step 3.2: Implement Code
   Task(
       subagent_type="software-implementer",
       description="Implement task {task-id} to pass tests",
       prompt="""
       Task: {task-description}
       Tests written: {test-count}

       Implement code to make ALL tests pass:

       1. Follow architecture patterns from SAD
       2. Use coding standards defined in project
       3. Write clean, maintainable code
       4. Add inline documentation
       5. Ensure commits reference task ID

       Run tests continuously during implementation
       All tests must pass before marking complete

       Design documentation: Use design-class-card template if needed

       Report: .aiwg/working/iteration-{N}/implementation/{task-id}-complete.md
       """
   )

   # Step 3.3: Code Review
   Task(
       subagent_type="code-reviewer",
       description="Review implementation for task {task-id}",
       prompt="""
       Review code implementation:

       Check for:
       - Acceptance criteria met
       - Tests comprehensive and passing
       - Code quality (readability, maintainability)
       - Security best practices
       - Performance considerations
       - Documentation completeness

       Provide feedback:
       - Required changes (blockers)
       - Suggested improvements
       - Approval status: APPROVED | NEEDS_CHANGES

       If NEEDS_CHANGES, be specific about required fixes

       Review report: .aiwg/working/iteration-{N}/reviews/{task-id}-review.md
       """
   )
   ```

2. **Iterate Until All Tasks Complete**:
   - Track completion percentage
   - Handle review feedback loops
   - Ensure all tests remain passing

**Communicate Progress**:
```
⏳ Implementing iteration {N} ({total} tasks)...
  ✓ Task 1: Tests written (12), implementation complete, APPROVED
  ✓ Task 2: Tests written (8), implementation complete, APPROVED
  ⏳ Task 3: Tests written (15), implementing...
Progress: {completed}/{total} tasks complete
```

### Step 4: Execute Comprehensive Testing

**Purpose**: Run full test suites and achieve coverage targets

**Your Actions**:

1. **Launch Test Execution** (parallel):
   ```
   # Unit Test Suite
   Task(
       subagent_type="test-engineer",
       description="Execute unit test suite",
       prompt="""
       Run complete unit test suite for iteration {N}

       Execute:
       - All new tests from this iteration
       - Full regression suite
       - Coverage analysis

       Target: ≥80% code coverage (or project standard)

       Document:
       - Tests run: {count}
       - Tests passed: {count}
       - Coverage: {percentage}%
       - Failed tests (if any) with details

       Output: .aiwg/testing/iteration-{N}-unit-test-results.md
       """
   )

   # Integration Test Suite
   Task(
       subagent_type="test-engineer",
       description="Execute integration test suite",
       prompt="""
       Run integration tests for iteration {N}

       Test:
       - API endpoints
       - Service interactions
       - Database operations
       - External system integrations

       All integration tests must pass (100%)

       Document:
       - Tests run: {count}
       - Tests passed: {count}
       - Performance metrics
       - Failed tests with root cause

       Output: .aiwg/testing/iteration-{N}-integration-test-results.md
       """
   )

   # End-to-End Test Suite
   Task(
       subagent_type="test-engineer",
       description="Execute E2E acceptance tests",
       prompt="""
       Run end-to-end tests for user journeys

       Validate:
       - Critical user paths work correctly
       - Cross-component interactions
       - User acceptance criteria met

       Document:
       - Scenarios tested: {count}
       - Scenarios passed: {count}
       - UI/UX issues found
       - Performance observations

       Output: .aiwg/testing/iteration-{N}-e2e-test-results.md
       """
   )
   ```

2. **Fix Any Test Failures**:
   ```
   If test failures detected:
   Task(
       subagent_type="software-implementer",
       description="Fix test failures from iteration {N}",
       prompt="""
       Test failures detected:
       {list failures}

       For each failure:
       1. Analyze root cause
       2. Determine if bug in code or test
       3. Fix issue
       4. Re-run affected tests
       5. Document fix in commit message

       All tests must pass before proceeding

       Output: .aiwg/working/iteration-{N}/test-fixes.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Executing test suites...
  ✓ Unit tests: 156/156 passed (85% coverage)
  ✓ Integration tests: 42/42 passed
  ✓ E2E tests: 8/8 scenarios passed
✓ All tests passing, coverage targets met
```

### Step 5: Validate Quality Gates

**Purpose**: Ensure code meets security, performance, and quality standards

**Your Actions**:

1. **Launch Quality Gate Checks** (parallel):
   ```
   # Security Gate
   Task(
       subagent_type="security-gatekeeper",
       description="Run security gate validation",
       prompt="""
       Perform security analysis for iteration {N}:

       1. Run SAST (static analysis) scan
       2. Check for vulnerable dependencies
       3. Validate secure coding practices
       4. Review authentication/authorization changes

       Gate criteria:
       - No Critical vulnerabilities
       - No High vulnerabilities (or documented exceptions)
       - OWASP Top 10 compliance

       Status: PASS | FAIL | CONDITIONAL

       If FAIL, list vulnerabilities requiring fix

       Output: .aiwg/gates/iteration-{N}-security-gate.md
       """
   )

   # Performance Gate
   Task(
       subagent_type="devops-engineer",
       description="Validate performance metrics",
       prompt="""
       Run performance validation for iteration {N}:

       1. Execute performance test suite
       2. Compare against baseline metrics
       3. Check SLO compliance
       4. Identify regressions

       Gate criteria:
       - No performance regressions >10%
       - Response time p95 < {target}ms
       - Throughput > {target} req/s
       - Memory usage stable

       Status: PASS | FAIL | WARNING

       Document performance profile and any issues

       Output: .aiwg/gates/iteration-{N}-performance-gate.md
       """
   )

   # Code Quality Gate
   Task(
       subagent_type="code-reviewer",
       description="Validate code quality standards",
       prompt="""
       Assess code quality for iteration {N}:

       1. Run static analysis (linting, complexity)
       2. Check code coverage percentage
       3. Review technical debt introduced
       4. Validate documentation completeness

       Gate criteria:
       - Code coverage ≥80% (or project standard)
       - Cyclomatic complexity <10
       - No critical linting errors
       - Public APIs documented

       Status: PASS | FAIL | WARNING

       Output: .aiwg/gates/iteration-{N}-code-quality-gate.md
       """
   )
   ```

2. **Consolidate Gate Results**:
   ```
   Task(
       subagent_type="project-manager",
       description="Consolidate quality gate results",
       prompt="""
       Read all gate reports:
       - Security gate status
       - Performance gate status
       - Code quality gate status

       Generate consolidated quality report:

       Overall Status: PASS (all gates pass) | BLOCKED (any gate fails)

       If BLOCKED:
       - List failing gates
       - Required fixes
       - Remediation timeline

       Output: .aiwg/gates/iteration-{N}-quality-report.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Validating quality gates...
  ✓ Security gate: PASS (0 vulnerabilities)
  ✓ Performance gate: PASS (no regressions)
  ✓ Code quality gate: PASS (82% coverage)
✓ All quality gates passed
```

### Step 6: Integration and Documentation

**Purpose**: Merge code and update all documentation

**Your Actions**:

1. **Merge to Main Branch**:
   ```
   Task(
       subagent_type="devops-engineer",
       description="Integrate iteration {N} to main",
       prompt="""
       With all gates passed, merge iteration work:

       1. Merge feature branches to main/trunk
       2. Run CI/CD pipeline
       3. Validate build success
       4. Deploy to dev environment
       5. Run smoke tests

       Document:
       - Commits merged: {count}
       - Build status: SUCCESS | FAILURE
       - Deployment status
       - Smoke test results

       Output: .aiwg/deployment/iteration-{N}-integration.md
       """
   )
   ```

2. **Update Documentation** (parallel):
   ```
   # Release Notes
   Task(
       subagent_type="technical-writer",
       description="Generate release notes",
       prompt="""
       Create user-facing release notes for iteration {N}:

       Sections:
       - New Features (user-visible changes)
       - Improvements (performance, UX enhancements)
       - Bug Fixes (issues resolved)
       - Known Issues (if any)

       Write in user-friendly language
       Include relevant screenshots/examples if applicable

       Template: $AIWG_ROOT/.../deployment/release-notes-template.md

       Output: .aiwg/deployment/release-notes-iteration-{N}.md
       """
   )

   # Runbook Updates
   Task(
       subagent_type="operations-manager",
       description="Update operational runbooks",
       prompt="""
       Review iteration {N} for operational changes:

       Update runbooks if:
       - New configuration added
       - Deployment process changed
       - New monitoring/alerts added
       - Database migrations required
       - API changes affecting operations

       Document all operational impacts

       Output: .aiwg/deployment/runbook-updates-iteration-{N}.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Finalizing integration...
  ✓ Code merged to main branch
  ✓ CI/CD pipeline successful
  ✓ Deployed to dev environment
  ✓ Release notes generated
  ✓ Runbooks updated
✓ Integration complete
```

### Step 7: Generate Iteration Assessment

**Purpose**: Calculate velocity metrics and capture lessons learned

**Your Actions**:

1. **Calculate Metrics**:
   ```
   Task(
       subagent_type="project-manager",
       description="Calculate iteration {N} metrics",
       prompt="""
       Analyze iteration {N} completion:

       Calculate:
       - Story points planned vs completed
       - Tasks planned vs completed
       - Velocity (points/iteration)
       - Defects found and fixed
       - Test coverage achieved
       - Quality gate pass rate

       Compare to previous iterations:
       - Velocity trend (improving/declining)
       - Quality trend
       - Team productivity

       Output metrics summary
       """
   )
   ```

2. **Generate Assessment Report**:
   ```
   Task(
       subagent_type="project-manager",
       description="Generate iteration {N} assessment",
       prompt="""
       Create comprehensive iteration assessment:

       1. Goals Achievement
          - Planned vs completed work
          - Success percentage

       2. Velocity Metrics
          - Points completed
          - Velocity trend analysis

       3. Quality Metrics
          - Test coverage
          - Defect rates
          - Gate pass rates

       4. Risks
          - New risks identified
          - Risks retired
          - Risk mitigation status

       5. Lessons Learned
          - What went well
          - What needs improvement
          - Action items for next iteration

       6. Team Performance
          - Capacity utilization
          - Collaboration effectiveness

       Template: $AIWG_ROOT/.../management/iteration-assessment-template.md

       Output: .aiwg/reports/iteration-{N}-assessment.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Generating iteration assessment...
✓ Iteration {N} assessment complete
  - Velocity: {points} story points
  - Completion: {percentage}%
  - Quality gates: {pass-rate}%
```

## Definition of Done (DoD) Checklist

Before marking iteration complete, verify:

### Implementation Complete
- [ ] All acceptance criteria met
- [ ] Code peer-reviewed
- [ ] Code merged to main
- [ ] No outstanding review comments

### Tests Complete
- [ ] Unit tests written and passing
- [ ] Integration tests passing
- [ ] E2E tests passing
- [ ] Coverage targets met

### Documentation Complete
- [ ] Code comments added
- [ ] Release notes updated
- [ ] Runbooks updated
- [ ] Traceability maintained

### Quality Gates Passed
- [ ] Security gate passed
- [ ] Performance gate passed
- [ ] Code quality gate passed
- [ ] No critical defects

### Deployment Ready
- [ ] Deployed to dev successfully
- [ ] Smoke tests passing
- [ ] Configuration documented

## User Communication

**At start**: Confirm understanding and list deliverables

```
Understood. I'll orchestrate Delivery Track for iteration {N}.

This will include:
- Task planning and breakdown
- Test-driven development
- Comprehensive testing
- Quality gate validation
- Documentation updates
- Iteration assessment

I'll coordinate multiple agents for implementation and review.
Expected duration: 20-30 minutes.

Starting orchestration...
```

**During**: Update progress with clear indicators

```
✓ = Complete
⏳ = In progress
❌ = Error/blocked
⚠️ = Warning/attention needed
```

**At end**: Summary report with locations

```
─────────────────────────────────────────
Iteration {N} Delivery Complete
─────────────────────────────────────────

**Status**: COMPLETE
**Velocity**: {points} story points
**Quality Gates**: ALL PASSED

**Work Completed**:
- Tasks: {completed}/{planned}
- Tests: {test-count} written
- Coverage: {percentage}%
- Defects: {fixed-count} fixed

**Artifacts Generated**:
- Iteration plan: .aiwg/planning/iteration-{N}-plan.md
- Test results: .aiwg/testing/iteration-{N}-test-results.md
- Quality report: .aiwg/gates/iteration-{N}-quality-report.md
- Release notes: .aiwg/deployment/release-notes-iteration-{N}.md
- Assessment: .aiwg/reports/iteration-{N}-assessment.md

**Next Steps**:
- Review iteration assessment
- Plan next iteration
- Deploy to staging if ready

─────────────────────────────────────────
```

## Error Handling

**If Backlog Not Ready**:
```
❌ Iteration {N} backlog not ready

Missing:
- {list missing items}

Recommendation: Complete Discovery Track first
Run: /flow-discovery-track {N}
```

**If Tests Fail**:
```
⚠️ Test failures detected

Failed tests: {count}
- {test names}

Action: Fixing test failures before proceeding...
```

**If Quality Gate Fails**:
```
❌ Quality gate failed: {gate-name}

Issue: {specific problem}
Required fix: {description}

Cannot proceed until gate passes.
Initiating remediation...
```

**If Integration Fails**:
```
❌ Integration build failed

Error: {build error}
Action: Investigating build failure...

May need manual intervention.
```

## Success Criteria

This orchestration succeeds when:
- [ ] All planned work items complete
- [ ] Definition of Done met for all items
- [ ] All tests passing
- [ ] Quality gates passed
- [ ] Code integrated to main
- [ ] Documentation updated
- [ ] Iteration assessment generated

## Metrics to Track

**During orchestration, track**:
- Task completion rate
- Test coverage percentage
- Defect discovery rate
- Gate pass/fail rate
- Velocity (story points)
- Cycle time per task

## References

**Templates** (via $AIWG_ROOT):
- Iteration Plan: `templates/management/iteration-plan-template.md`
- Work Package: `templates/management/work-package-card.md`
- Test Plan: `templates/test/iteration-test-plan-template.md`
- Release Notes: `templates/deployment/release-notes-template.md`
- Assessment: `templates/management/iteration-assessment-template.md`

**Related Flows**:
- Discovery Track: `commands/flow-discovery-track.md`
- Gate Check: `commands/flow-gate-check.md`
- Handoff: `commands/flow-handoff-checklist.md`

**Quality Standards**:
- DoD Criteria: `flows/definition-of-done.md`
- Gate Criteria: `flows/gate-criteria-by-phase.md`