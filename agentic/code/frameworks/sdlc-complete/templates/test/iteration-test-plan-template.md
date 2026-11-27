# Iteration Test Plan Template

### Feature flag state coverage (when flags are used)

- Required: current production state, upcoming state, and default/fallback path;
  record flag values, evaluation context and test IDs. Optional: all-on.
- Test the selected configurations, not every combination
  ([testing](https://launchdarkly.com/docs/guides/flags/testing-code.md), [Hodgson](https://martinfowler.com/articles/feature-toggles.html)).
- Flag off equals current behavior is a convention; document exceptions and
  deliberate defaults ([Hodgson](https://martinfowler.com/articles/feature-toggles.html)).
- Link accepted cards and removal tasks; cicd `flag-states-test` may run this set. [AIWG guidance]


## Purpose

Detail the testing scope, approach, and logistics for a specific iteration within Construction or Transition.

## Ownership & Collaboration

- Document Owner: Test Engineer
- Contributor Roles: Test Architect, Implementer
- Automation Inputs: Iteration scope, build availability, data refresh plan
- Automation Outputs: `iteration-<id>-test-plan.md` covering sections 1–11

## Completion Checklist

- Iteration objectives and acceptance criteria captured
- Test cases mapped to implemented stories/use cases
- Environment, data, and resource needs scheduled

## Document Sections

1. **Iteration Overview**
   - Provide iteration ID, dates, objectives, and primary features.
2. **Test Scope**
   - Enumerate features, use cases, or components under test this iteration.
3. **Test Approach**
   - Outline planned test types (functional, regression, exploratory, etc.).
4. **Test Cases and Suites**
   - Reference detailed test cases or automation suites with links.
5. **Environment and Data**
   - Specify environments, configurations, and data refresh requirements.
6. **Roles and Schedule**
   - Assign responsibilities, execution windows, and handoffs.
7. **Entry Criteria**
   - Define prerequisites (code freeze, build availability, defect thresholds).
8. **Exit Criteria**
   - State completion conditions (pass rate, defect severity thresholds).
9. **Risk and Contingency Plan**
   - Identify iteration-specific risks and fallback strategies.
10. **Reporting**
    - Describe reporting cadence, dashboards, and stakeholders to inform.
11. **Open Issues**
    - Track pending items or blockers.

## Agent Notes

- Keep plan lightweight but actionable; cross-check with iteration plan to avoid scope drift.
- Coordinate with Build/Integration plan for environment scheduling.
- Update status daily during execution and feed into iteration assessment.
- Verify the Automation Outputs entry is satisfied before signaling completion.
