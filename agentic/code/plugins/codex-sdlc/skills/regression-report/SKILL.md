---
namespace: aiwg
name: regression-report
platforms: [all]
description: Generate comprehensive regression analysis reports combining bisect, baseline, and metrics data with actionable recommendations

---

# regression-report

Generate comprehensive regression analysis reports combining bisect, baseline, and metrics data.

## Triggers


Alternate expressions and non-obvious activations (primary phrases are matched automatically from the skill description):

- "full regression report" → comprehensive regression analysis
- "test health" → regression summary report

## Purpose

This skill produces comprehensive regression reports by:
- Synthesizing data from bisect, baseline, and metrics
- Correlating regressions with code changes
- Identifying systemic issues and patterns
- Providing actionable recommendations
- Creating executive summaries
- Supporting postmortem analysis

## Behavior

When triggered, this skill:

1. **Gathers regression data**:
   - Load bisect reports for root cause
   - Import baseline comparison results
   - Fetch regression metrics and trends
   - Retrieve issue tracker data
   - Collect CI/CD logs

2. **Correlates information**:
   - Link regressions to code changes
   - Map to requirements and features
   - Identify common root causes
   - Connect to team/component ownership

3. **Analyzes impact**:
   - Assess user impact
   - Calculate downtime/degradation
   - Measure business cost
   - Evaluate reputation impact

4. **Identifies patterns**:
   - Recurring regression types
   - High-risk components
   - Time-based patterns
   - Process gaps

5. **Generates insights**:
   - Root cause categories
   - Prevention strategies
   - Process improvements
   - Tooling recommendations

6. **Produces reports**:
   - Executive summary
   - Technical deep-dive
   - Action plan
   - Lessons learned

## Report Types

### Incident Report

```yaml
incident_report:
  description: Single regression deep-dive
  scope: One specific regression incident
  audience: Technical team and stakeholders

  sections:
    - incident_summary
    - timeline
    - root_cause_analysis
    - impact_assessment
    - resolution_steps
    - prevention_measures
    - lessons_learned
```

### Sprint Regression Report

```yaml
sprint_report:
  description: All regressions in a sprint
  scope: Sprint boundary
  audience: Development team

  sections:
    - sprint_summary
    - regression_list
    - metrics_summary
    - hotspot_analysis
    - recommendations
    - goals_for_next_sprint
```

### Release Regression Report

```yaml
release_report:
  description: Regression analysis for release
  scope: Release cycle
  audience: Release management and stakeholders

  sections:
    - release_summary
    - regression_timeline
    - escape_analysis
    - quality_gates_review
    - lessons_learned
    - release_readiness
```

### Quarterly Regression Analysis

```yaml
quarterly_report:
  description: Strategic regression analysis
  scope: 3 months
  audience: Leadership and engineering managers

  sections:
    - executive_summary
    - trend_analysis
    - strategic_insights
    - investment_recommendations
    - process_improvements
    - success_metrics
```

## Comprehensive Report Format

```markdown
# Comprehensive Regression Report

**Period**: Sprint 13 (2026-01-14 to 2026-01-28)
**Project**: User Service
**Report Type**: Sprint Regression Analysis
**Generated**: 2026-01-28 17:00:00
**Analyzer**: regression-report skill

---

## Executive Summary

**Overall Assessment**: ⚠️ Acceptable Quality with Concerns

| Metric | Value | Status |
|--------|-------|--------|
| Regressions Detected | 4 | ✅ Within target (< 5) |
| Production Escapes | 1 | ⚠️ Above target (0 preferred) |
| Mean Time to Detect | 8.5h | ✅ Excellent |
| Mean Time to Fix | 18.7h | ⚠️ Close to target |
| User Impact | 500 users | ⚠️ Medium |

**Key Findings**:
- Regression rate within acceptable range but auth module concerning
- One production escape indicates staging test gap
- Detection speed excellent, fix time acceptable
- Systemic issue: Integration testing coverage insufficient

**Priority Actions**:
1. Add integration tests for authentication flows
2. Improve staging environment test coverage
3. Implement regression test requirement for all fixes

---

## Regression Inventory

### REG-001: JWT Issuer Validation Breaks Existing Sessions

**Severity**: High
**Status**: Fixed (deployed 2026-01-16)
**Detection**: Automated test failure
**Environment**: Staging

**Timeline**:
- 2026-01-15 14:32: Breaking commit merged (pqr901)
- 2026-01-15 16:15: CI test failure detected (2h MTTD)
- 2026-01-15 18:45: Root cause identified via bisect
- 2026-01-16 09:30: Fix deployed (15h MTTF)

**Root Cause**: Required `iss` claim in JWT validation without backward compatibility

**Impact**: All existing user sessions invalidated

**Files Changed**:
- src/auth/validate-token.ts (+15/-5)
- src/auth/generate-token.ts (+8/-2)

**Fix**: Added feature flag for gradual rollout

**Prevention**:
- [ ] Add integration tests for auth changes
- [ ] Require backward compatibility review

**References**:
- Bisect Report: @.aiwg/testing/regression-bisect-jwt.md
- Issue: #456
- PR: #789

---

### REG-002: User Profile Update Returns 500 on Invalid Email

**Severity**: Critical
**Status**: Fixed (deployed 2026-01-18)
**Detection**: Production monitoring
**Environment**: Production

**Timeline**:
- 2026-01-17 08:00: Deployed to production
- 2026-01-17 20:15: Error spike detected (12h MTTD)
- 2026-01-18 02:30: Root cause identified
- 2026-01-18 04:15: Hotfix deployed (8h MTTF)

**Root Cause**: Validation middleware error handling broken, returns 500 instead of 400

**Impact**:
- 500 users affected
- 45 support tickets
- 12 hours partial service degradation

**Files Changed**:
- src/api/validation-middleware.ts (+3/-8)

**Cost**:
- Engineering: 8 hours incident response
- Support: 12 hours ticket triage
- Reputation: Customer satisfaction impact

**Fix**: Restored proper error handling

**Prevention**:
- [ ] Add error code validation tests
- [ ] Improve staging test coverage
- [ ] Add monitoring for error rate spikes

**References**:
- Incident Report: @.aiwg/incidents/INC-2026-001.md
- Issue: #478
- Hotfix PR: #791

---

### REG-003: Password Reset Email Fails for Gmail Users

**Severity**: Medium
**Status**: Fixed (deployed 2026-01-22)
**Detection**: Manual QA testing
**Environment**: Staging

**Timeline**:
- 2026-01-20 11:00: Code merged
- 2026-01-21 15:30: QA detected (28.5h MTTD)
- 2026-01-22 10:00: Fix deployed (18.5h MTTF)

**Root Cause**: Email template contained invalid HTML characters rejected by Gmail

**Impact**: Password reset broken for ~40% of user base (Gmail users)

**Files Changed**:
- <project-root>/templates/email/password-reset.html (+5/-3)

**Fix**: HTML entity encoding for special characters

**Prevention**:
- [ ] Add email template validation
- [ ] Test with multiple email providers
- [ ] Add email delivery monitoring

**References**:
- Issue: #482
- PR: #794

---

### REG-004: Dashboard Widget Load Time Increased

**Severity**: Low
**Status**: Fixed (deployed 2026-01-26)
**Detection**: Performance baseline comparison
**Environment**: Staging

**Timeline**:
- 2026-01-24 09:00: Performance test detected slowdown
- 2026-01-24 10:15: Root cause identified (1.25h MTTD)
- 2026-01-26 08:00: Optimization deployed (45.75h MTTF)

**Root Cause**: N+1 query introduced in dashboard widget

**Impact**: Dashboard load time increased from 0.8s to 2.3s

**Files Changed**:
- src/dashboard/widgets/activity-feed.ts (+12/-5)

**Fix**: Added eager loading to eliminate N+1

**Prevention**:
- [ ] Add performance regression tests
- [ ] Code review focus on query optimization

**References**:
- Baseline Comparison: @.aiwg/testing/baseline-comparison-perf.md
- Issue: #485
- PR: #797

---

## Impact Analysis

### User Impact

| Regression | Users Affected | Duration | Severity |
|------------|----------------|----------|----------|
| REG-001 | 0 (staging) | N/A | High (avoided) |
| REG-002 | 500 | 12h | Critical |
| REG-003 | 0 (staging) | N/A | Medium (avoided) |
| REG-004 | 0 (staging) | N/A | Low (avoided) |

**Total Production Impact**: 500 users, 12 hours
**Escapes Prevented**: 3 of 4 regressions caught pre-production

### Business Impact

```
Direct Costs:
- Engineering incident response: 24 hours @ $150/h = $3,600
- Support ticket triage: 12 hours @ $75/h = $900
Total Direct: $4,500

Indirect Costs:
- Customer satisfaction impact (estimated)
- Reputation damage (1 production incident)
- Lost productivity (500 users × 12h)
Estimated Indirect: $8,000

Total Estimated Cost: $12,500
```

### Component Impact

| Component | Regressions | User Impact | Risk Level |
|-----------|-------------|-------------|------------|
| src/auth/ | 1 | High (avoided) | 🔴 High |
| src/api/ | 1 | Critical (500 users) | 🔴 High |
| templates/ | 1 | Medium (avoided) | 🟡 Medium |
| src/dashboard/ | 1 | Low (avoided) | 🟢 Low |

**High-Risk Components**: Auth and API modules require increased testing

---

## Root Cause Analysis

### Root Cause Categories

| Category | Count | % | Examples |
|----------|-------|---|----------|
| Missing integration tests | 2 | 50% | REG-001, REG-002 |
| Missing validation | 1 | 25% | REG-003 |
| Performance not tested | 1 | 25% | REG-004 |

**Systemic Issue**: Integration testing coverage insufficient (50% of regressions)

### Prevention Success Rate

| Prevention Measure | Present? | Effective? |
|-------------------|----------|------------|
| Unit tests | ✅ Yes | ⚠️ Partial |
| Integration tests | ❌ No | N/A |
| Performance tests | ⚠️ Partial | ⚠️ Partial |
| Email validation | ❌ No | N/A |
| Staging environment | ✅ Yes | ✅ Yes (caught 3/4) |

**Gap**: Integration tests would have prevented 50% of regressions

---

## Metrics Summary

### Sprint Performance

| Metric | Sprint 13 | Sprint 12 | Change |
|--------|-----------|-----------|--------|
| Regressions | 4 | 4 | → Stable |
| MTTD | 8.5h | 12h | ↓ Improved |
| MTTF | 18.7h | 28.4h | ↓ Improved |
| Escape Rate | 25% (1/4) | 0% | ↑ Worsened |

**Trend**: Detection and fix times improving, but production escape concerning

### Quality Gates

| Gate | Target | Actual | Status |
|------|--------|--------|--------|
| Unit test coverage | 80% | 85% | ✅ Pass |
| Integration test coverage | 60% | 42% | ❌ Fail |
| Performance baseline | No degradation | 1 regression | ⚠️ Warning |
| Security scan | No critical | Pass | ✅ Pass |

**Failed Gate**: Integration test coverage below target

---

## Recommendations

### Immediate (This Week)

**Priority 1: Add Integration Tests for Auth**
- Reason: 1 auth regression, staging escape
- Impact: Prevent auth-related regressions
- Effort: 2 days
- Owner: Test Engineer
- Target: +20% integration coverage

**Priority 2: Fix Email Template Validation**
- Reason: REG-003 could have been automated
- Impact: Catch email issues pre-deployment
- Effort: 1 day
- Owner: DevOps Engineer

**Priority 3: Implement Regression Test Requirement**
- Reason: 25% recurrence rate on fixes without tests
- Impact: Prevent regression recurrence
- Effort: Process change (1 hour)
- Owner: Tech Lead

### Short-term (This Sprint)

**Priority 4: Improve Staging Test Coverage**
- Reason: Production escape indicates gap
- Impact: Reduce escape rate to <5%
- Effort: 1 week
- Owner: Test Architect

**Priority 5: Add Performance Regression Tests**
- Reason: REG-004 caught late
- Impact: Earlier performance issue detection
- Effort: 3 days
- Owner: Performance Engineer

**Priority 6: Review Error Handling Standards**
- Reason: REG-002 returned 500 instead of 400
- Impact: Consistent error behavior
- Effort: 2 days (review + guidelines)
- Owner: API Designer

### Ongoing

**Priority 7: Require Integration Tests for Auth PRs**
- Reason: Auth module high-risk
- Impact: No auth regressions without tests
- Effort: PR template update
- Owner: Tech Lead

**Priority 8: Weekly Regression Review**
- Reason: Early pattern identification
- Impact: Faster response to trends
- Effort: 30 min/week
- Owner: Test Lead

---

## Lessons Learned

### What Went Well

1. **Fast Detection**: MTTD of 8.5h shows automation working
2. **Staging Environment**: Caught 3 of 4 regressions before production
3. **Bisect Tooling**: Root cause identification very fast
4. **Team Response**: Fast fix times (18.7h MTTF)

### What Didn't Go Well

1. **Production Escape**: REG-002 bypassed all pre-production testing
2. **Integration Coverage**: Too low to catch cross-component issues
3. **Email Validation**: No automated testing for email templates
4. **Backward Compatibility**: REG-001 broke existing sessions

### Process Improvements

| Issue | Improvement | Timeline |
|-------|-------------|----------|
| Production escape | Add integration test gates | This sprint |
| Missing email validation | Automate template testing | This sprint |
| Auth regressions | Require integration tests | Immediate |
| Performance regressions | Add performance baselines | Next sprint |

---

## Sprint Goals for Sprint 14

Based on this analysis, Sprint 14 regression goals:

| Goal | Target | Success Criteria |
|------|--------|------------------|
| Regression Rate | < 4 | Fewer total regressions |
| Integration Coverage | 60% | Meet quality gate |
| Escape Rate | 0% | No production regressions |
| MTTD | < 8h | Maintain current level |
| MTTF | < 18h | Slightly faster fixes |

**Focus Areas**: Integration testing, staging coverage, auth module

---

## Appendices

### A. Regression Timeline

```
2026-01-15: REG-001 introduced (auth JWT)
2026-01-15: REG-001 detected (2h)
2026-01-16: REG-001 fixed (15h)
2026-01-17: REG-002 introduced (validation)
2026-01-17: REG-002 escaped to production
2026-01-18: REG-002 detected (12h)
2026-01-18: REG-002 fixed (8h)
2026-01-20: REG-003 introduced (email)
2026-01-21: REG-003 detected (28.5h)
2026-01-22: REG-003 fixed (18.5h)
2026-01-24: REG-004 introduced (performance)
2026-01-24: REG-004 detected (1.25h)
2026-01-26: REG-004 fixed (45.75h)
```

### B. References

- Bisect Reports: @.aiwg/testing/regression-bisect-*/
- Baseline Comparisons: @.aiwg/testing/baseline-comparisons/
- Metrics Dashboard: @.aiwg/testing/regression-metrics-dashboard.md
- Incident Reports: @.aiwg/incidents/
- Issues: GitHub Issues (label: regression)

### C. Data Sources

- Regression test results: `.aiwg/testing/regression-results/`
- CI/CD logs: GitHub Actions
- Issue tracker: GitHub Issues
- Monitoring: Datadog
- User reports: Support tickets
```

## Usage Examples

### Generate Sprint Report

```
User: "Generate regression report for this sprint"

Skill executes:
1. Identify sprint boundary (Sprint 13)
2. Collect all regression data
3. Correlate with code changes
4. Analyze patterns and impact
5. Generate recommendations

Output:
"Sprint Regression Report Generated

Sprint 13 Summary:
- 4 regressions detected
- 1 production escape
- 8.5h MTTD, 18.7h MTTF
- 500 users impacted

Key Findings:
- Integration testing gap (50% of regressions)
- Auth module high-risk (needs attention)
- Staging caught 75% (good)

Top Recommendations:
1. Add integration tests for auth
2. Improve staging coverage
3. Require regression tests for fixes

Full report: .aiwg/testing/regression-report-sprint-13.md"
```

### Incident Postmortem

```
User: "Regression report for the validation incident"

Skill analyzes:
- REG-002 incident data
- Timeline and impact
- Root cause from bisect
- Related regressions

Output:
"Incident Postmortem: REG-002

Timeline: 12 hours (detection to fix)
Impact: 500 users, 45 support tickets
Cost: ~$12,500 (direct + indirect)

Root Cause: Validation middleware broken
Prevention: Integration tests missing

Recommendations:
- Add error code validation tests
- Improve staging coverage
- Add monitoring for error spikes

Lessons Learned:
- Fast response (8h MTTF)
- Staging gap allowed escape
- Need integration test gate

Full postmortem: .aiwg/testing/regression-postmortem-REG-002.md"
```

### Quarterly Analysis

```
User: "Quarterly regression analysis"

Skill generates:
"Quarterly Regression Analysis (Q1 2026)

Executive Summary:
- 58 total regressions (-35% vs Q4 2025)
- 3 production escapes (-70% vs Q4)
- MTTD: 9.2h (↓ from 24h)
- MTTF: 22h (↓ from 42h)

Strategic Insights:
- Automation investment paying off (76% faster detection)
- Integration testing gap remains (40% of regressions)
- Auth and API modules highest risk

Investment Recommendations:
- $50k: Integration test automation
- $30k: Performance testing platform
- $20k: Staging environment expansion

Full analysis: .aiwg/testing/regression-analysis-Q1-2026.md"
```

## Integration

This skill uses:
- `regression-bisect`: Import root cause analysis
- `regression-baseline`: Import drift data
- `regression-metrics`: Import statistical trends
- `project-awareness`: Detect sprints/releases
- `traceability-check`: Link to requirements

## Agent Orchestration

```yaml
agents:
  synthesis:
    agent: technical-writer
    focus: Report generation and clarity

  analysis:
    agent: metrics-analyst
    focus: Data correlation and insights

  recommendations:
    agent: test-architect
    focus: Prevention strategies
```

## Configuration

### Report Templates

```yaml
report_templates:
  incident:
    template: agentic/code/frameworks/sdlc-complete/templates/test/regression-report.md
    sections: [summary, timeline, root_cause, impact, prevention]

  sprint:
    template: agentic/code/frameworks/sdlc-complete/templates/test/regression-report.md
    sections: [summary, inventory, metrics, recommendations]

  quarterly:
    template: agentic/code/frameworks/sdlc-complete/templates/test/regression-report.md
    sections: [executive, trends, strategic, investments]
```

### Data Aggregation

```yaml
aggregation_config:
  sources:
    - bisect_reports: .aiwg/testing/regression-bisect-*/
    - baselines: .aiwg/testing/baseline-comparisons/
    - metrics: .aiwg/testing/regression-metrics-dashboard.md
    - issues: github_issues
    - incidents: .aiwg/incidents/

  correlation_rules:
    - link_bisect_to_issue
    - map_component_to_owner
    - calculate_business_impact
```

## Output Locations

- Reports: `.aiwg/testing/regression-report-{period}.md`
- Postmortems: `.aiwg/testing/regression-postmortem-{issue}.md`
- Quarterly: `.aiwg/testing/regression-analysis-Q{n}-{year}.md`

## References

- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/schemas/test/regression-report-schema.yaml
- @agentic/code/frameworks/sdlc-complete/templates/test/regression-report.md
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/agents/technical-writer.md
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/agents/metrics-analyst.md
