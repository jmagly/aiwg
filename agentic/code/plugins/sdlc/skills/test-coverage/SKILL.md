---
namespace: aiwg
name: test-coverage
platforms: [all]
description: Analyze test coverage reports, identify gaps by priority, and recommend test improvements with trend tracking
triggers:
  - "help check quality"
  - "find the highest-risk quality gap first"
  - "run a focused quality or test coverage check"
  - "test coverage"

---

# test-coverage

Analyze test coverage, identify gaps, and recommend test improvements.

## Triggers


Alternate expressions and non-obvious activations (primary phrases are matched automatically from the skill description):

- "lcov" / "istanbul" / "c8" → coverage tool-specific queries
- "coverage holes" in testing context → gap analysis
- "what's not tested" → coverage gap discovery

## Purpose

This skill provides comprehensive test coverage analysis by:
- Parsing coverage reports from multiple formats
- Identifying coverage gaps by priority
- Mapping coverage to requirements
- Recommending test additions
- Tracking coverage trends over time

## Behavior

When triggered, this skill:

1. **Locates coverage data**:
   - Find coverage reports (lcov, cobertura, istanbul, etc.)
   - Identify test directories and conventions
   - Load historical coverage data

2. **Analyzes coverage metrics**:
   - Line coverage percentage
   - Branch coverage percentage
   - Function coverage percentage
   - File-level breakdown

3. **Identifies critical gaps**:
   - Untested critical paths
   - Low-coverage high-change files
   - Untested public APIs
   - Missing edge case coverage

4. **Maps to requirements**:
   - Cross-reference with traceability data
   - Identify untested requirements
   - Flag coverage by priority

5. **Generates recommendations**:
   - Prioritized list of tests to add
   - Estimated effort per test
   - Coverage improvement projection

6. **Tracks trends**:
   - Coverage over time
   - Coverage by component
   - Impact of recent changes

## Coverage Metrics

### Line Coverage

```yaml
line_coverage:
  description: Percentage of code lines executed by tests
  calculation: (lines_executed / total_lines) * 100
  targets:
    excellent: ">= 90%"
    good: ">= 80%"
    acceptable: ">= 70%"
    poor: "< 70%"
```

### Branch Coverage

```yaml
branch_coverage:
  description: Percentage of decision branches executed
  calculation: (branches_taken / total_branches) * 100
  targets:
    excellent: ">= 85%"
    good: ">= 75%"
    acceptable: ">= 65%"
    poor: "< 65%"
  importance: Critical for logic paths
```

### Function Coverage

```yaml
function_coverage:
  description: Percentage of functions called by tests
  calculation: (functions_called / total_functions) * 100
  targets:
    excellent: ">= 95%"
    good: ">= 90%"
    acceptable: ">= 80%"
    poor: "< 80%"
```

### Statement Coverage

```yaml
statement_coverage:
  description: Percentage of statements executed
  calculation: (statements_executed / total_statements) * 100
  note: Similar to line coverage but counts multi-statement lines
```

## Coverage Report Format

```markdown
# Test Coverage Analysis Report

**Date**: 2025-12-08
**Project**: User Service
**Analyzer**: test-coverage skill

## Executive Summary

| Metric | Current | Target | Status |
|--------|---------|--------|--------|
| Line Coverage | 78.5% | 80% | ⚠️ Below Target |
| Branch Coverage | 72.3% | 75% | ⚠️ Below Target |
| Function Coverage | 91.2% | 90% | ✅ Meets Target |
| Files with 0% | 3 | 0 | ❌ Action Required |

**Overall Assessment**: Coverage below targets in 2 of 4 metrics. Focus on branch coverage and untested files.

## Coverage by Component

| Component | Lines | Branches | Functions | Trend |
|-----------|-------|----------|-----------|-------|
| src/auth/ | 92% | 88% | 100% | ↑ +2% |
| src/user/ | 85% | 78% | 95% | → 0% |
| src/api/ | 76% | 68% | 88% | ↓ -3% |
| src/utils/ | 65% | 55% | 82% | → 0% |
| src/db/ | 58% | 45% | 75% | ↓ -5% |

## Critical Gaps

### Priority 1: Untested Files

Files with 0% coverage that require immediate attention:

| File | Lines | Risk | Action |
|------|-------|------|--------|
| src/db/migrations.ts | 145 | High | Add migration tests |
| src/api/webhooks.ts | 89 | High | Add webhook handler tests |
| src/utils/retry.ts | 42 | Medium | Add retry logic tests |

### Priority 2: Low-Coverage Critical Paths

Business-critical code with insufficient coverage:

| File | Current | Target | Gap | Critical Path |
|------|---------|--------|-----|---------------|
| src/auth/oauth.ts | 55% | 90% | 35% | User authentication |
| src/api/payments.ts | 62% | 90% | 28% | Payment processing |
| src/user/permissions.ts | 68% | 85% | 17% | Authorization |

### Priority 3: Branch Coverage Gaps

Files with low branch coverage (complex logic undertested):

| File | Branch % | Uncovered Branches | Example |
|------|----------|-------------------|---------|
| src/api/router.ts | 45% | 12 | Error handling paths |
| src/utils/validator.ts | 52% | 8 | Edge case validations |
| src/db/query-builder.ts | 48% | 15 | Query variations |

## Uncovered Code Analysis

### src/auth/oauth.ts (55% line coverage)

```
Lines not covered:
- 45-67: Token refresh error handling
- 89-112: OAuth provider fallback logic
- 134-145: Session invalidation edge cases

Recommended tests:
1. Test token refresh with expired token
2. Test provider unavailable fallback
3. Test concurrent session invalidation
```

### src/api/payments.ts (62% line coverage)

```
Lines not covered:
- 78-95: Payment retry logic
- 123-140: Refund edge cases
- 167-180: Currency conversion errors

Recommended tests:
1. Test payment retry with transient failure
2. Test partial refund scenarios
3. Test invalid currency handling
```

## Requirements Coverage

Cross-reference with traceability data:

| Requirement | Test Coverage | Status |
|-------------|---------------|--------|
| UC-001: User Login | 95% | ✅ Covered |
| UC-002: User Registration | 88% | ✅ Covered |
| UC-003: Password Reset | 45% | ⚠️ Partial |
| UC-004: OAuth Login | 55% | ⚠️ Partial |
| REQ-001: Input Validation | 78% | ⚠️ Partial |
| NFR-001: Performance | 30% | ❌ Insufficient |

## Test Recommendations

### High Priority (This Sprint)

| # | Test to Add | File | Est. Effort | Coverage Gain |
|---|-------------|------|-------------|---------------|
| 1 | OAuth token refresh tests | oauth.test.ts | 2h | +15% |
| 2 | Payment retry scenarios | payments.test.ts | 3h | +12% |
| 3 | Migration execution tests | migrations.test.ts | 4h | +100% (new) |
| 4 | Webhook handler tests | webhooks.test.ts | 2h | +100% (new) |

### Medium Priority (Next Sprint)

| # | Test to Add | File | Est. Effort | Coverage Gain |
|---|-------------|------|-------------|---------------|
| 5 | Permission edge cases | permissions.test.ts | 2h | +8% |
| 6 | Router error paths | router.test.ts | 3h | +20% branch |
| 7 | Validation edge cases | validator.test.ts | 2h | +15% branch |

### Projected Impact

If all high-priority tests added:
- Line coverage: 78.5% → 85.2% (+6.7%)
- Branch coverage: 72.3% → 79.1% (+6.8%)
- Untested files: 3 → 1

## Coverage Trends

### Last 30 Days

```
Week 1: 82.1% ──────────────────────────
Week 2: 80.5% ────────────────────────
Week 3: 79.2% ──────────────────────
Week 4: 78.5% ─────────────────────
                    ↓ Declining trend
```

### By Sprint

| Sprint | Coverage | Change | Notes |
|--------|----------|--------|-------|
| Sprint 10 | 82.1% | - | Baseline |
| Sprint 11 | 80.5% | -1.6% | New auth module |
| Sprint 12 | 79.2% | -1.3% | Payment integration |
| Sprint 13 | 78.5% | -0.7% | API expansion |

**Trend Analysis**: Coverage declining due to new feature velocity without proportional test additions. Recommend test-first approach for new features.

## Action Plan

### Immediate (This Week)
- [ ] Add OAuth token refresh tests
- [ ] Add payment retry tests
- [ ] Set up coverage gates in CI (minimum 80%)

### Short-term (This Sprint)
- [ ] Create migration test suite
- [ ] Create webhook test suite
- [ ] Address UC-003 and UC-004 coverage gaps

### Ongoing
- [ ] Require tests with new feature PRs
- [ ] Weekly coverage review in standup
- [ ] Quarterly coverage target adjustment

## Configuration

Coverage thresholds for CI gates:

```yaml
coverage_gates:
  global:
    lines: 80
    branches: 75
    functions: 90
    statements: 80

  per_file:
    lines: 70
    branches: 65

  new_code:
    lines: 90
    branches: 85
```
```

## Usage Examples

### Full Coverage Analysis

```
User: "Analyze test coverage"

Skill executes:
1. Locate coverage reports
2. Parse metrics
3. Identify gaps
4. Generate recommendations

Output:
"Test Coverage Analysis Complete

Overall: 78.5% line, 72.3% branch

Status: ⚠️ Below targets

Critical Findings:
- 3 files with 0% coverage
- 2 critical paths undertested
- Branch coverage declining

Top Recommendations:
1. Add OAuth tests (+15% gain, 2h effort)
2. Add payment retry tests (+12% gain, 3h effort)
3. Add migration tests (new coverage, 4h effort)

Report: .aiwg/testing/coverage-analysis.md"
```

### Find Untested Code

```
User: "What's not tested in auth module?"

Skill analyzes:
- src/auth/ directory
- Identifies untested paths

Output:
"Auth Module Coverage: 92% lines, 88% branches

Untested Code:

1. oauth.ts (lines 45-67)
   - Token refresh error handling
   - Test: expired token scenario

2. oauth.ts (lines 89-112)
   - Provider fallback logic
   - Test: provider timeout scenario

3. session.ts (lines 134-145)
   - Session invalidation edge cases
   - Test: concurrent invalidation

Recommended Test Additions:
- 3 test cases
- Estimated: 3 hours
- Expected gain: +8% coverage"
```

### Coverage Trend

```
User: "Coverage report over time"

Skill returns:
"Coverage Trend (Last 4 Sprints):

Sprint 10: 82.1% ██████████████████████
Sprint 11: 80.5% █████████████████████
Sprint 12: 79.2% ████████████████████
Sprint 13: 78.5% ███████████████████
                 ↓ Declining (-3.6%)

Cause: New feature velocity outpacing test additions

Recommendation:
- Enforce 90% coverage on new code
- Add test task to feature tickets
- Schedule 'test debt' sprint"
```

## Integration

This skill uses:
- `traceability-check`: Map coverage to requirements
- `project-awareness`: Identify test conventions
- `artifact-metadata`: Track coverage reports

## Agent Orchestration

```yaml
agents:
  analysis:
    agent: test-architect
    focus: Coverage analysis and strategy

  implementation:
    agent: test-engineer
    focus: Test recommendations and implementation

  review:
    agent: code-reviewer
    focus: Coverage quality assessment
```

## Configuration

### Coverage Tool Detection

```yaml
coverage_tools:
  javascript:
    - istanbul/nyc: coverage/lcov.info
    - jest: coverage/coverage-final.json
    - c8: coverage/lcov.info

  python:
    - coverage.py: .coverage, coverage.xml
    - pytest-cov: coverage.xml

  java:
    - jacoco: target/site/jacoco/jacoco.xml
    - cobertura: target/site/cobertura/coverage.xml

  go:
    - go test: coverage.out
```

### Priority Calculation

```yaml
priority_factors:
  critical_path:
    weight: 3
    paths: [auth, payments, permissions]

  recent_changes:
    weight: 2
    lookback: 30 days

  complexity:
    weight: 1.5
    metric: cyclomatic_complexity

  bug_history:
    weight: 2
    source: issue_tracker
```

## Output Locations

- Coverage reports: `.aiwg/testing/coverage/`
- Analysis reports: `.aiwg/testing/coverage-analysis.md`
- Trends: `.aiwg/testing/coverage-trends.json`
- Recommendations: `.aiwg/testing/coverage-recommendations.md`

## References

- Test strategy: .aiwg/testing/test-strategy.md
- Traceability matrix: .aiwg/reports/traceability-matrix.csv
- Coverage templates: agentic/code/frameworks/sdlc-complete/templates/test/test-evaluation-summary-template.md
