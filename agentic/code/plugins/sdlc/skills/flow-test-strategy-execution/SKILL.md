---
namespace: aiwg
name: flow-test-strategy-execution
platforms: [all]
description: Orchestrate comprehensive test strategy with test suite execution, coverage validation, defect triage, and regression analysis
commandHint:
  argumentHint: <test-level> [target-component] [project-directory] [--guidance "text"] [--interactive]
  allowedTools: Task, Read, Write, Glob, TodoWrite
  model: sonnet
  category: sdlc-orchestration
  orchestration: true
  modelRole: coding
  modelTier: standard
---

> **Declarative Flow (#1539):** This flow's orchestration is now also expressed as a
> declarative YAML Flow at `flows/flow-test-strategy-execution.playbook.yaml` (source of truth for the step
> sequence + gates). This SKILL.md remains the discoverable trigger surface and prose
> reference. See epic #1534.

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


# Test Strategy Execution Flow

**You are the Test Orchestrator** for comprehensive test strategy execution and quality validation.

## Your Role

**You orchestrate multi-agent test workflows. You do NOT execute bash scripts or run tests directly.**

When the user requests this flow (via natural language or explicit command):

1. **Interpret the request** and confirm understanding
2. **Read this template** as your orchestration guide
3. **Extract agent assignments** and workflow steps
4. **Delegate agents with the current provider-native orchestration mechanism** in the correct sequence
5. **Synthesize test results** and quality metrics
6. **Report test execution status** with recommendations

## Test Execution Overview

**Purpose**: Execute comprehensive test strategy with multi-agent coordination

**Key Activities**:
- Test suite execution (unit, integration, e2e)
- Coverage analysis and validation
- Defect detection and triage
- Regression analysis
- Quality gate validation

**Expected Duration**: 30-60 minutes orchestration (varies by test scope)

## Natural Language Triggers

Users may say:
- "Run tests"
- "Execute test suite"
- "Validate tests"
- "Test the system"
- "Run unit tests"
- "Execute integration tests"
- "Run full regression"
- "Check test coverage"
- "Test this component"

You recognize these as requests for this test orchestration flow.

## Test Levels

- **unit**: Execute unit tests for component or module
- **integration**: Execute integration tests for service interactions
- **e2e**: Execute end-to-end tests for user journeys
- **regression**: Execute full regression suite
- **performance**: Execute performance and load tests
- **security**: Execute security test suite
- **smoke**: Execute smoke tests (critical path validation)
- **acceptance**: Execute user acceptance tests

## Parameter Handling

### --guidance Parameter

**Purpose**: User provides upfront direction to tailor test execution priorities

**Examples**:
```
--guidance "Focus on security tests, OWASP Top 10 coverage critical"
--guidance "Tight timeline, prioritize smoke tests over comprehensive coverage"
--guidance "Performance is critical, need sub-100ms p95 validation"
--guidance "New feature testing, focus on component X integration"
```

**How to Apply**:
- Parse guidance for keywords: security, performance, coverage, timeline, feature
- Adjust test suite selection (prioritize relevant test types)
- Modify coverage targets (minimal vs comprehensive based on timeline)
- Influence defect triage severity (critical for security issues)

### --interactive Parameter

**Purpose**: You ask 6 strategic questions to understand test context

**Questions to Ask** (if --interactive):

```
I'll ask 6 strategic questions to tailor test execution to your needs:

Q1: What test levels are you targeting?
    (unit, integration, e2e, regression, performance, security)

Q2: What's your current test coverage?
    (Helps me set realistic coverage improvement targets)

Q3: What are your top quality concerns?
    (Security, performance, functionality, usability)

Q4: What's your test automation maturity?
    (Manual, partial automation, fully automated)

Q5: What's your acceptable test execution time?
    (Minutes for CI/CD, hours for nightly, days for release)

Q6: What's your team's testing expertise?
    (Helps determine level of detail in reports)

Based on your answers, I'll adjust:
- Test suite selection and execution order
- Coverage targets and validation depth
- Defect triage priorities
- Report detail level
```

**Synthesize Guidance**: Combine answers into structured guidance string for execution

## Artifacts to Generate

**Primary Deliverables**:
- **Test Execution Report**: Comprehensive results → `.aiwg/testing/test-execution-report.md`
- **Coverage Report**: Code coverage analysis → `.aiwg/testing/coverage-report.md`
- **Defect List**: Triaged defects by severity → `.aiwg/testing/defects/`
- **Regression Report**: New failures vs baseline → `.aiwg/testing/regression-report.md`
- **Quality Gate Report**: Pass/fail criteria → `.aiwg/gates/test-quality-gate.md`

**Supporting Artifacts**:
- Test execution logs (archived)
- Performance metrics (if applicable)
- Security scan results (if applicable)

## Multi-Agent Orchestration Workflow

### Step 1: Test Execution Planning

**Purpose**: Define test scope and execution strategy

**Your Actions**:

1. **Read Test Context**:
   ```
   Read and verify presence of:
   - .aiwg/testing/master-test-plan.md (if exists)
   - .aiwg/requirements/use-case-*.md
   - .aiwg/architecture/software-architecture-doc.md
   - Previous test results (if any)
   ```

2. **Launch Test Planning Agent**:
   ```
   Task(
       subagent_type="test-architect",
       description="Plan test execution strategy",
       prompt="""
       Test level requested: {test-level}
       Target component: {target-component}
       Guidance: {guidance}

       Read available test artifacts:
       - Master Test Plan (if exists)
       - Previous test results
       - Architecture documentation

       Create Test Execution Plan:
       1. Test Scope
          - Components to test
          - Test types to execute
          - Test suites to run

       2. Execution Order
          - Unit → Integration → E2E (typical)
          - Or risk-based prioritization

       3. Coverage Targets
          - Line coverage: ≥80%
          - Branch coverage: ≥75%
          - Critical path coverage: 100%

       4. Pass/Fail Criteria
          - All tests pass
          - Coverage thresholds met
          - No P0/P1 defects
          - Performance within SLAs

       5. Resource Requirements
          - Test environments needed
          - Test data requirements
          - Tool requirements

       Save to: .aiwg/working/test-execution/test-execution-plan.md
       """
   )
   ```

**Communicate Progress**:
```
✓ Initialized test execution planning
⏳ Creating test execution strategy...
✓ Test execution plan complete
```

### Step 2: Execute Unit Test Suite

**Purpose**: Run unit tests with coverage analysis

**Your Actions**:

1. **Launch Unit Test Execution** (parallel agents if multiple components):
   ```
   Task(
       subagent_type="test-engineer",
       description="Execute unit test suite",
       prompt="""
       Component: {target-component}
       Coverage target: ≥80% line, ≥75% branch

       Execute unit tests:
       1. Identify test framework (Jest, Pytest, JUnit, etc.)
       2. Run tests with coverage enabled
       3. Collect results:
          - Total tests
          - Passed/Failed/Skipped
          - Execution time
          - Coverage metrics

       4. Identify coverage gaps:
          - Uncovered lines
          - Uncovered branches
          - Critical paths without tests

       5. Document failures:
          - Test name
          - Failure reason
          - Stack trace
          - Component affected

       Generate Unit Test Report:
       - Test results summary
       - Coverage analysis
       - Failure details
       - Recommendations

       Save to: .aiwg/working/test-execution/unit-test-results.md
       """
   )
   ```

2. **Launch Coverage Analysis**:
   ```
   Task(
       subagent_type="test-engineer",
       description="Analyze code coverage",
       prompt="""
       Read unit test results
       Coverage data from test execution

       Analyze coverage:
       1. Overall Metrics
          - Line coverage %
          - Branch coverage %
          - Function coverage %
          - Statement coverage %

       2. Coverage by Component
          - Identify well-tested areas
          - Identify gaps
          - Critical path coverage

       3. Coverage Trends
          - Compare to baseline
          - Improvement/degradation

       4. Recommendations
          - Priority areas for new tests
          - Acceptable uncovered code
          - Technical debt items

       Save to: .aiwg/working/test-execution/coverage-analysis.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Executing unit tests...
  ✓ Unit tests complete: 245 passed, 3 failed, 2 skipped
  ✓ Coverage: 82% line, 76% branch (targets met)
✓ Unit test execution complete
```

### Step 3: Execute Integration Test Suite

**Purpose**: Test service interactions and data flows

**Your Actions**:

```
Task(
    subagent_type="test-engineer",
    description="Execute integration tests",
    prompt="""
    Scope: Service interactions, API contracts, database operations

    Execute integration tests:
    1. Test Categories
       - API endpoint tests
       - Database integration
       - External service mocks
       - Message queue interactions

    2. Validate
       - Data contracts (request/response schemas)
       - Error handling (4xx, 5xx responses)
       - Transaction boundaries
       - Service dependencies

    3. Collect Metrics
       - API coverage %
       - Response times
       - Error rates
       - Data consistency

    4. Document Issues
       - Contract violations
       - Performance bottlenecks
       - Integration failures
       - Configuration issues

    Generate Integration Test Report:
    - Results by service/API
    - Contract validation
    - Performance metrics
    - Integration health

    Save to: .aiwg/working/test-execution/integration-test-results.md
    """
)
```

**Communicate Progress**:
```
⏳ Executing integration tests...
  ✓ API tests: 45/48 passed
  ✓ Database tests: 22/22 passed
  ✓ External service tests: 15/16 passed
✓ Integration test execution complete
```

### Step 4: Execute E2E and Acceptance Tests

**Purpose**: Validate complete user journeys and business logic

**Your Actions**:

1. **Launch E2E Test Execution**:
   ```
   Task(
       subagent_type="qa-engineer",
       description="Execute end-to-end tests",
       prompt="""
       Execute E2E test suites:

       1. Critical User Journeys
          - User registration/login
          - Core business workflows
          - Payment/checkout (if applicable)
          - Data export/import

       2. Cross-browser Testing
          - Chrome, Firefox, Safari
          - Mobile responsive

       3. Test Execution
          - Setup test data
          - Execute test scenarios
          - Capture screenshots on failure
          - Record execution videos

       4. Results Collection
          - Journey completion rates
          - Step-level pass/fail
          - Performance metrics
          - UI/UX issues

       Document:
       - Critical path coverage
       - Failed journeys
       - Performance bottlenecks
       - Accessibility issues

       Save to: .aiwg/working/test-execution/e2e-test-results.md
       """
   )
   ```

2. **Launch UAT Validation** (if acceptance level):
   ```
   Task(
       subagent_type="product-owner",
       description="Validate acceptance criteria",
       prompt="""
       Read use case specifications
       Read e2e test results

       Validate:
       1. Use case coverage
          - All use cases tested
          - Acceptance criteria met
          - Business rules validated

       2. User Experience
          - Workflow efficiency
          - Error messaging
          - Help/documentation

       3. Business Logic
          - Calculations correct
          - Rules properly enforced
          - Edge cases handled

       Acceptance Decision:
       - ACCEPTED: Ready for production
       - CONDITIONAL: Minor issues, can proceed
       - REJECTED: Major issues, must fix

       Save to: .aiwg/working/test-execution/uat-validation.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Executing E2E tests...
  ✓ Critical journeys: 8/10 passed
  ✓ Cross-browser: All passed
  ✓ UAT validation: CONDITIONAL (2 minor issues)
✓ E2E test execution complete
```

### Step 5: Defect Triage and Root Cause Analysis

**Purpose**: Analyze failures and assign severity

**Your Actions**:

1. **Collect All Test Failures**:
   ```
   Read all test results:
   - Unit test failures
   - Integration test failures
   - E2E test failures
   ```

2. **Launch Defect Triage** (parallel agents for different severities):
   ```
   # QA Lead for overall triage
   Task(
       subagent_type="qa-lead",
       description="Triage all test failures",
       prompt="""
       Read all test failure reports

       For each failure:
       1. Assign Severity
          - P0 (Critical): System down, data loss, security breach
          - P1 (High): Major feature broken, significant impact
          - P2 (Medium): Minor feature issue, workaround exists
          - P3 (Low): Cosmetic, minimal impact

       2. Categorize
          - Functional bug
          - Performance issue
          - Security vulnerability
          - Usability problem
          - Test issue (false positive)

       3. Assign Owner
          - Component team
          - Specific developer (if known)
          - Priority queue

       4. Set Resolution Target
          - P0: 4 hours
          - P1: 24 hours
          - P2: 3 days
          - P3: Next iteration

       Create defect cards for each issue:
       - Defect ID
       - Title and description
       - Severity and category
       - Steps to reproduce
       - Expected vs actual
       - Owner and due date

       Save to: .aiwg/working/test-execution/defects/
       """
   )

   # Component Owner for root cause
   Task(
       subagent_type="component-owner",
       description="Root cause analysis for P0/P1 defects",
       prompt="""
       Analyze high-severity defects:

       For each P0/P1 defect:
       1. Root Cause Analysis
          - Code defect
          - Configuration issue
          - Environment problem
          - Test data issue
          - External dependency

       2. Impact Analysis
          - Affected components
          - User impact
          - Data integrity risk
          - Performance impact

       3. Fix Strategy
          - Quick fix available?
          - Full fix timeline
          - Workaround options
          - Rollback needed?

       Document root cause analysis
       Save to: .aiwg/working/test-execution/root-cause-analysis.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Triaging test failures...
  ✓ Total defects: 11
  ✓ P0 (Critical): 0
  ✓ P1 (High): 2 (assigned, 24hr fix)
  ✓ P2 (Medium): 6
  ✓ P3 (Low): 3
✓ Defect triage complete
```

### Step 6: Regression Analysis and Reporting

**Purpose**: Compare to baseline and generate final report

**Your Actions**:

1. **Launch Regression Analysis**:
   ```
   Task(
       subagent_type="test-architect",
       description="Analyze regression vs baseline",
       prompt="""
       Read current test results
       Read baseline results (previous release/iteration)

       Regression Analysis:
       1. New Failures
          - Tests that passed before, fail now
          - Root cause (code change, environment)
          - Severity of regression

       2. Fixed Tests
          - Previously failing, now passing
          - Verify fix is intentional

       3. Test Health Metrics
          - Flaky test rate (intermittent failures)
          - Test execution time trends
          - Coverage trends

       4. Quality Trends
          - Defect discovery rate
          - Defect escape rate
          - Test effectiveness

       Generate Regression Report:
       - New regressions (must fix)
       - Improvements (fixes verified)
       - Test health status
       - Quality metrics

       Save to: .aiwg/working/test-execution/regression-analysis.md
       """
   )
   ```

2. **Generate Comprehensive Test Report**:
   ```
   Task(
       subagent_type="test-manager",
       description="Generate test execution report",
       prompt="""
       Synthesize all test results:
       - Unit test results
       - Integration test results
       - E2E test results
       - UAT validation
       - Defect list
       - Regression analysis

       Create Test Execution Report:

       # Test Execution Report - {test-level}

       ## Executive Summary
       - Overall Status: PASS | FAIL | CONDITIONAL
       - Go/No-Go: {recommendation}
       - Critical Issues: {list}

       ## Test Results by Level

       ### Unit Tests
       - Tests Run: {count}
       - Pass Rate: {percentage}%
       - Coverage: {line}% line, {branch}% branch
       - Execution Time: {duration}

       ### Integration Tests
       - Tests Run: {count}
       - Pass Rate: {percentage}%
       - API Coverage: {percentage}%
       - Performance: p95 {latency}ms

       ### E2E Tests
       - Journeys Tested: {count}
       - Pass Rate: {percentage}%
       - Critical Paths: {status}
       - Browser Coverage: {list}

       ## Coverage Analysis
       - Line Coverage: {current}% (target: {target}%)
       - Branch Coverage: {current}% (target: {target}%)
       - Uncovered Critical Paths: {list or none}

       ## Defect Summary
       - P0 (Critical): {count}
       - P1 (High): {count}
       - P2 (Medium): {count}
       - P3 (Low): {count}

       Top Issues:
       {list with severity and owner}

       ## Regression Status
       - New Regressions: {count}
       - Fixed Since Baseline: {count}
       - Flaky Test Rate: {percentage}%

       ## Quality Gates
       - Unit Test Gate: {PASS | FAIL}
       - Integration Gate: {PASS | FAIL}
       - E2E Gate: {PASS | FAIL}
       - Coverage Gate: {PASS | FAIL}
       - Defect Gate: {PASS | FAIL}

       ## Recommendations
       {specific actions based on results}

       ## Next Steps
       1. {action 1}
       2. {action 2}
       3. {action 3}

       Save to: .aiwg/testing/test-execution-report.md
       """
   )
   ```

3. **Generate Quality Gate Report**:
   ```
   Task(
       subagent_type="project-manager",
       description="Validate quality gates",
       prompt="""
       Read test execution report
       Read quality gate criteria

       Validate Gates:
       1. Test Pass Rate
          - Criteria: ≥95% pass rate
          - Result: {actual}%
          - Status: PASS | FAIL

       2. Coverage Thresholds
          - Criteria: ≥80% line, ≥75% branch
          - Result: {line}% line, {branch}% branch
          - Status: PASS | FAIL

       3. Critical Defects
          - Criteria: 0 P0, ≤2 P1
          - Result: {P0} P0, {P1} P1
          - Status: PASS | FAIL

       4. Performance SLAs
          - Criteria: p95 < 500ms
          - Result: p95 = {actual}ms
          - Status: PASS | FAIL

       Overall Gate Decision:
       - PASS: All criteria met
       - CONDITIONAL: Minor gaps, can proceed with plan
       - FAIL: Major gaps, must fix before proceeding

       Save to: .aiwg/gates/test-quality-gate.md
       """
   )
   ```

**Communicate Progress**:
```
⏳ Generating test reports...
  ✓ Regression analysis complete
  ✓ Test execution report generated
  ✓ Quality gate validation complete
✓ Test reporting complete
```

### Step 7: Present Results and Recommendations

**Purpose**: Summarize results for user decision

**Your Actions**:

```
Read final reports and present summary:

─────────────────────────────────────────────
Test Execution Summary
─────────────────────────────────────────────

**Test Level**: {test-level}
**Component**: {target-component}
**Status**: {PASS | FAIL | CONDITIONAL}

**Test Results**:
✓ Unit Tests: 245/248 passed (98.8%)
  Coverage: 82% line, 76% branch
⚠ Integration Tests: 82/86 passed (95.3%)
  3 API contract issues, 1 timeout
✓ E2E Tests: 8/10 critical paths passed (80%)
  2 non-critical UI issues

**Defect Summary**:
- P0 (Critical): 0
- P1 (High): 2 (fix in progress)
- P2 (Medium): 6 (scheduled)
- P3 (Low): 3 (backlog)

**Quality Gates**:
✓ Test Pass Rate: PASS (96% > 95%)
✓ Coverage: PASS (82% > 80%)
⚠ Critical Defects: CONDITIONAL (2 P1s)
✓ Performance: PASS (p95 = 287ms)

**Overall Decision**: CONDITIONAL PASS
- Can proceed with P1 fixes in parallel
- Must resolve before production deployment

**Recommendations**:
1. Fix 2 P1 defects within 24 hours
2. Add tests for uncovered critical path in auth module
3. Investigate flaky integration test (payment service)
4. Schedule P2 fixes for next iteration

**Artifacts Generated**:
- Test Execution Report: .aiwg/testing/test-execution-report.md
- Coverage Report: .aiwg/testing/coverage-report.md
- Defect List: .aiwg/testing/defects/ (11 files)
- Regression Report: .aiwg/testing/regression-report.md
- Quality Gate Report: .aiwg/gates/test-quality-gate.md

─────────────────────────────────────────────
```

## Quality Gates

Before marking workflow complete, verify:
- [ ] Test execution plan created and approved
- [ ] All requested test suites executed
- [ ] Coverage analysis completed
- [ ] Defects triaged by severity
- [ ] Regression analysis completed
- [ ] Test reports generated
- [ ] Quality gates validated

## User Communication

**At start**: Confirm understanding and test scope

```
Understood. I'll orchestrate test execution for {test-level} testing.

Target: {target-component}
Scope: {test types to run}

This will:
- Execute relevant test suites
- Analyze code coverage
- Triage any failures
- Compare to baseline
- Generate comprehensive reports

Expected duration: 30-60 minutes.

Starting test orchestration...
```

**During**: Progress indicators

```
✓ = Complete
⏳ = In progress
❌ = Failed
⚠️ = Warning/issues found
```

**At end**: Summary with recommendations (see Step 7)

## Error Handling

**Test Environment Unavailable**:
```
❌ Test environment not accessible

Issue: {environment} is down/unreachable
Impact: Cannot execute {test-type} tests

Actions:
1. Check environment status
2. Restart services if needed
3. Use alternate environment
4. Or defer testing with risk acknowledgment

Escalating to DevOps team...
```

**Coverage Below Threshold**:
```
⚠️ Coverage below target

Current: {actual}% line coverage
Target: {threshold}%
Gap: {delta}%

Uncovered areas:
- {component}: {coverage}%
- {component}: {coverage}%

Recommendation: Add tests before proceeding
Or: Accept technical debt with plan
```

**Critical Defects Found**:
```
❌ Critical defects blocking release

P0 Defects: {count}
- {defect-1}: {description}
- {defect-2}: {description}

P1 Defects: {count}
- {list}

Decision: NO-GO for release
Action: Fix P0/P1 defects before proceeding
```

## Success Criteria

This orchestration succeeds when:
- [ ] Test execution completed for requested level
- [ ] Coverage thresholds met or gap acknowledged
- [ ] All failures documented and triaged
- [ ] Regression analysis completed
- [ ] Quality gates evaluated
- [ ] Clear go/no-go recommendation provided
- [ ] All artifacts saved to .aiwg/testing/

## References

**Templates** (via $AIWG_ROOT):
- Master Test Plan: `templates/test/master-test-plan-template.md`
- Test Case: `templates/test/test-case-card.md`
- Use Case Test: `templates/test/use-case-test-card.md`
- Defect Card: `templates/test/defect-card.md`
- Test Evaluation: `templates/test/test-evaluation-summary-template.md`

**Related Commands**:
- `flow-gate-check` - Quality gate validation
- `flow-risk-management-cycle` - Risk assessment
- `check-traceability` - Requirements coverage

**Test Strategies**:
- Test Pyramid (unit > integration > e2e)
- Risk-Based Testing (prioritize by impact)
- Shift-Left Testing (early detection)
- Continuous Testing (automated pipeline)