# Test Suite Card

## Purpose

Organize related test cases into logical groups for coordinated execution, reporting, and quality gating. Test suites enable systematic testing at different scopes (smoke, regression, release) and integrate with CI/CD pipelines.

## Ownership

- Owner: Test Engineer
- Contributors: Test Architect (suite strategy), DevOps Engineer (CI integration)
- Reviewers: Test Architect

## Metadata

- ID: TS-{project}-{number} (e.g., TS-SHOP-001)
- Suite Name: {Descriptive name} (e.g., "Authentication Smoke Tests")
- Owner: {name/team}
- Contributors: {list}
- Reviewers: {list}
- Team: {team}
- Suite Type: smoke | regression | feature | component | release | nightly | on-demand
- Scope: unit | integration | system | acceptance | performance | security | accessibility | all
- Status: active | deprecated | maintenance
- Dates: created {YYYY-MM-DD} / updated {YYYY-MM-DD} / last_executed {YYYY-MM-DD}
- Related: REQ-{id}, UC-{id}, FEATURE-{id}, TS-{id}
- Tags: #{domain}, #{scope}, #{priority}
- Links: {CI pipeline job, test report dashboard}

## Suite Definition

### Suite Purpose

**What does this suite validate?**

Describe the overall objective of grouping these tests together.

**Example**: Validate that core authentication flows (login, logout, password reset) function correctly. This suite serves as a smoke test to verify authentication service health before running comprehensive tests.

### Suite Classification

**Type**: {smoke | regression | feature | component | release | nightly | exploratory}

**Definitions**:

- **Smoke**: Fast, critical-path tests that verify basic functionality (run on every commit)
- **Regression**: Comprehensive tests that prevent rework (run on every PR or nightly)
- **Feature**: Tests for a specific feature or user story (run during feature development)
- **Component**: Tests for a specific system component or module (run when component changes)
- **Release**: Comprehensive tests required before production deployment (run pre-release)
- **Nightly**: Long-running or resource-intensive tests (run overnight)
- **Exploratory**: Guided manual testing charters (run on-demand)

**Scope**: {Which test levels are included: unit, integration, system, acceptance, performance, security, etc.}

**Example**:

- Type: Smoke
- Scope: Integration (API-level tests, no UI)

## Test Case Inventory

### Included Test Cases

List all test cases in this suite with metadata for tracking and reporting.

| Test Case ID | Title | Priority | Type | Status | Last Run | Result | Duration |
|--------------|-------|----------|------|--------|----------|--------|----------|
| TC-SHOP-042 | Login with valid credentials | P0 | Integration | Passing | 2025-10-15 | Pass | 1.2s |
| TC-SHOP-043 | Login with invalid password | P0 | Integration | Passing | 2025-10-15 | Pass | 0.8s |
| TC-SHOP-044 | Logout clears session | P0 | Integration | Passing | 2025-10-15 | Pass | 0.5s |
| TC-SHOP-045 | Password reset sends email | P1 | Integration | Passing | 2025-10-15 | Pass | 2.1s |

**Total Test Cases**: {count}

**Priority Breakdown**:

- P0 (Critical): {count}
- P1 (High): {count}
- P2 (Medium): {count}
- P3 (Low): {count}

### Test Case Selection Criteria

**What determines if a test belongs in this suite?**

Define clear inclusion/exclusion rules:

**Example**:

- **Include**: All tests validating authentication service endpoints
- **Include**: Tests that complete in < 5 seconds (smoke test requirement)
- **Exclude**: Performance tests (those belong in TS-SHOP-005 Performance Suite)
- **Exclude**: UI-based tests (those belong in TS-SHOP-010 E2E Suite)

### Test Dependencies

**Do tests in this suite have execution dependencies?**

- **Independent**: Tests can run in any order, parallel execution supported
- **Sequential**: Tests must run in specified order
- **Prerequisite**: Certain tests must pass before others run

**Example**:

- Tests are **independent** (no shared state)
- Parallel execution: Up to 4 tests concurrently

**Dependency Graph** (if sequential):

```text
TC-042 (Login) → TC-044 (Logout)
               ↘ TC-045 (Password Reset)
```

## Execution Configuration

### Execution Environment

**Where does this suite run?**

- Local development (developer machines)
- CI pipeline (automated on commit/PR)
- Dedicated test environment (scheduled runs)
- Staging environment (pre-release validation)
- Production-like environment (performance/load testing)

**Example**: CI pipeline (GitHub Actions, on every pull request)

### Environment Prerequisites

**What infrastructure must be available?**

- Application deployment (version, configuration)
- Backing services (databases, caches, message queues)
- External dependencies (third-party APIs, mock services)
- Test data (fixtures, seed data)

**Example**:

- Authentication service: v2.3.1, deployed to test environment
- PostgreSQL: v14, seeded with test users
- Redis: v7, session store available
- Email service: Mocked (no real emails sent)

### Test Data Configuration

**What data does this suite require?**

- Data source: {fixtures, database seed, factory-generated, anonymized production}
- Data scope: {minimal, representative, comprehensive, production-like}
- Data refresh: {before-suite, before-each-test, manual}
- Data cleanup: {after-suite, after-each-test, manual}

**Example**:

- **Source**: Database seed scripts (`seeds/auth_users.sql`)
- **Scope**: 5 test users with various roles (admin, user, guest)
- **Refresh**: Before suite (reset database state)
- **Cleanup**: After suite (rollback transaction)

### Execution Order

**How are tests executed?**

- **Parallel**: All tests run concurrently (fastest, requires independence)
- **Sequential**: Tests run one at a time (slowest, handles dependencies)
- **Batched**: Tests grouped into batches, batches run sequentially, tests within batch run in parallel

**Example**: Parallel (4 concurrent workers)

### Execution Timeout

**How long should this suite take?**

- **Expected Duration**: {time}
- **Timeout**: {time} (fail suite if exceeds)

**Example**:

- Expected: 5 seconds (total, all tests)
- Timeout: 15 seconds (fail if slower, investigate performance issue)

### Retry Policy

**What happens when a test fails?**

- **No retry**: Fail immediately (for stable tests)
- **Retry N times**: Retry flaky tests up to N times
- **Quarantine**: Skip known-flaky tests, run separately

**Example**:

- Retry policy: None (smoke tests must be stable)
- Quarantine: Tests with < 90% pass rate moved to TS-SHOP-099 (Flaky Tests Quarantine)

## Pass/Fail Criteria

### Suite Pass Criteria

**When does the entire suite pass?**

Define thresholds and conditions:

- **All tests pass**: 100% pass rate (strict, for smoke tests)
- **Pass rate threshold**: ≥ X% tests pass (flexible, for regression)
- **Critical tests pass**: All P0 tests pass, P1+ failures allowed
- **No regressions**: No newly failing tests (previously passing tests still pass)

**Example**:

- **Criteria**: 100% pass rate (all 4 tests must pass)
- **Rationale**: Authentication is critical path; any failure blocks deployment

### Suite Fail Criteria

**When does the entire suite fail?**

- Any P0 test fails
- Pass rate below threshold
- Suite timeout exceeded
- Environment setup fails

**Example**: Suite fails if any test fails (smoke test strictness)

### Partial Success Handling

**What if some tests pass and some fail?**

- **Report partial success**: Indicate which tests passed, which failed
- **Categorize failures**: Critical vs. non-critical
- **Allow conditional proceed**: Release gate may pass if only low-priority tests fail

**Example**: Not applicable (100% pass required for smoke suite)

## CI/CD Integration

### Execution Triggers

**When does this suite run automatically?**

- On commit (pre-push hook, continuous testing)
- On pull request (PR gate, block merge if fails)
- On merge to main (post-merge validation)
- Scheduled (nightly, weekly)
- On deployment (post-deploy smoke test)
- Manual (on-demand execution)

**Example**:

- **Trigger**: On pull request
- **Frequency**: Every PR (approx. 20-50 times/day)

### Pipeline Integration

**Where in the CI pipeline does this suite run?**

**Example**:

- **Pipeline**: GitHub Actions workflow `test.yml`
- **Stage**: `smoke-tests` (runs before `integration-tests` stage)
- **Job**: `auth-smoke-tests`
- **Command**: `npm test -- --suite=smoke-auth`

### Failure Actions

**What happens when the suite fails?**

- **Block merge**: Prevent PR from merging (CI status check fails)
- **Notify team**: Send alert to Slack/email
- **Create issue**: Auto-create bug ticket
- **Rollback deployment**: Automatically revert deployment (if post-deploy smoke test)

**Example**:

- **Action**: Block PR merge (required status check)
- **Notification**: Slack alert to #qa-alerts channel
- **Escalation**: If failure persists > 30 minutes, page on-call engineer

## Reporting

### Test Results

**Where are results published?**

- CI dashboard (GitHub Actions, Jenkins, CircleCI)
- Test report artifacts (JUnit XML, HTML reports, screenshots)
- Metrics dashboard (test pass rate trends, duration trends)

**Example**:

- **Dashboard**: GitHub Actions PR status checks
- **Report**: HTML report published to GitHub Pages (`https://example.com/test-reports/auth-smoke/`)
- **Metrics**: Grafana dashboard (`https://grafana.example.com/d/test-auth`)

### Metrics Tracked

**What metrics are collected?**

- **Pass rate**: % of tests passing
- **Duration**: Total suite execution time
- **Flakiness**: % of tests with intermittent failures
- **Coverage**: Code coverage (if applicable)
- **Trends**: Pass rate and duration over time

**Example**:

- Pass rate: 100% (last 30 days)
- Duration: Avg 4.2s, Max 6.1s
- Flakiness: 0% (no flaky tests)

### Notification Settings

**Who gets notified of results?**

- **Always notify**: {roles/channels}
- **Notify on failure**: {roles/channels}
- **Notify on recovery**: {roles/channels}

**Example**:

- **On failure**: Slack #qa-alerts, email QA team
- **On recovery**: Slack #qa-alerts (resolved message)

## Quality Gates

### Release Gates

**Does this suite block releases?**

- **Yes**: Suite must pass before deployment to staging/production
- **No**: Suite is informational, failures do not block

**Example**: Yes (smoke tests are release blockers)

### Gate Thresholds

**What are the quality thresholds?**

| Gate | Threshold | Action if Below |
|------|-----------|-----------------|
| Pass Rate | 100% | Block deployment |
| Duration | < 15s | Investigate performance |
| Flakiness | < 5% | Stabilize or remove flaky tests |

## Maintenance

### Suite Ownership

**Who maintains this suite?**

- **Owner**: {person/team responsible for suite health}
- **Review Cadence**: {monthly, quarterly, when tests added/removed}

**Example**:

- Owner: QA Team (Lead: Jane Doe)
- Review: Monthly (first Monday of each month)

### Suite Health Indicators

**How do we know if this suite is healthy?**

- **Green**: Pass rate ≥ 98%, duration stable, no flaky tests
- **Yellow**: Pass rate 90-98%, or duration increasing, or 1-2 flaky tests
- **Red**: Pass rate < 90%, or duration doubled, or 3+ flaky tests

**Current Status**: Green (100% pass rate, 4.2s avg duration, 0 flaky)

### Known Issues

**Are there any known limitations or issues?**

**Example**:

- Test TC-SHOP-045 (password reset) occasionally times out in CI due to email service mock latency. Investigating root cause. Mitigation: Retry policy planned for next sprint.

### Planned Changes

**What updates are planned for this suite?**

**Example**:

- **2025-11**: Add TC-SHOP-050 (OAuth login) when OAuth feature ships
- **2025-12**: Migrate from Jest to Vitest (framework upgrade)

## Related Templates

- `agentic/code/frameworks/sdlc-complete/templates/test/test-case-card.md` - Individual test specifications
- `agentic/code/frameworks/sdlc-complete/templates/test/test-evaluation-summary-template.md` - Test results reporting
- `agentic/code/frameworks/sdlc-complete/templates/test/defect-card.md` - Track suite failures
- `agentic/code/frameworks/sdlc-complete/templates/deployment/deployment-plan-template.md` - Release gates and criteria

## Examples

### Example: Smoke Test Suite

**ID**: TS-SHOP-001
**Name**: Authentication Smoke Tests
**Type**: Smoke
**Scope**: Integration
**Tests**: 4 critical authentication flows
**Execution**: On every PR
**Pass Criteria**: 100% (all tests must pass)
**Duration**: 5 seconds
**Purpose**: Verify authentication service is functional before running comprehensive tests

### Example: Regression Test Suite

**ID**: TS-SHOP-002
**Name**: Full Regression Suite
**Type**: Regression
**Scope**: All (unit, integration, system)
**Tests**: 437 test cases
**Execution**: Nightly
**Pass Criteria**: 95% pass rate, all P0 tests pass
**Duration**: 45 minutes
**Purpose**: Comprehensive validation to prevent regressions across entire application

### Example: Feature Test Suite

**ID**: TS-SHOP-015
**Name**: Shopping Cart Feature Tests
**Type**: Feature
**Scope**: Integration + E2E
**Tests**: 23 test cases
**Execution**: On PR modifying cart code
**Pass Criteria**: 100% (all cart tests must pass)
**Duration**: 2 minutes
**Purpose**: Validate shopping cart functionality (add, remove, update quantity, checkout)

### Example: Performance Test Suite

**ID**: TS-SHOP-020
**Name**: API Performance Benchmarks
**Type**: Performance
**Scope**: System
**Tests**: 12 load tests
**Execution**: Nightly
**Pass Criteria**: All endpoints meet SLA (95th percentile < 500ms)
**Duration**: 30 minutes
**Purpose**: Ensure API performance meets service level agreements under load

## Checklist: Test Suite Completeness

Before marking test suite as "active", verify:

- [ ] Metadata complete (ID, name, type, scope, owner)
- [ ] Test case inventory documented (list of included tests)
- [ ] Execution configuration specified (environment, data, order)
- [ ] Pass/fail criteria defined (thresholds, gates)
- [ ] CI/CD integration configured (triggers, pipeline, notifications)
- [ ] Reporting and metrics established (dashboard, alerts)
- [ ] Quality gates assigned (release blockers identified)
- [ ] Suite reviewed by Test Architect

This suite is ready for execution when all checklist items are complete.

## Automation Outputs

For agents automating suite execution and reporting:

### Input Requirements

- Test case IDs (list of tests in suite)
- Execution environment (target environment URL, credentials)
- Test data (fixture paths, seed scripts)
- Configuration (parallel workers, timeout, retry policy)

### Output Artifacts

- Test results (JUnit XML, JSON, HTML report)
- Metrics (pass rate, duration, flakiness)
- Logs (console output, application logs)
- Screenshots/videos (for UI tests)
- Coverage report (if applicable)

### Integration Points

- CI/CD status (pass/fail status back to pipeline)
- Notification system (Slack, email)
- Dashboard (push metrics to Grafana, Datadog)
- Issue tracker (create defect cards for failures)
