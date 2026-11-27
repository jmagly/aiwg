# Master Test Plan Template

---
template_id: master-test-plan
version: 2.0.0
reasoning_required: true
---

### Feature flag state coverage (when flags are used)

- Required: current production state, upcoming state, and default/fallback path;
  record flag values, evaluation context and test IDs. Optional: all-on.
- Test the selected configurations, not every combination
  ([testing](https://launchdarkly.com/docs/guides/flags/testing-code.md), [Hodgson](https://martinfowler.com/articles/feature-toggles.html)).
- Flag off equals current behavior is a convention; document exceptions and
  deliberate defaults ([Hodgson](https://martinfowler.com/articles/feature-toggles.html)).
- Link accepted cards and removal tasks; cicd `flag-states-test` may run this set. [AIWG guidance]


## Purpose

Establish the overarching testing strategy, scope, resources, and schedule across all phases of the project.

## Reasoning

> Complete this section BEFORE writing the detailed plan. Per @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/rules/reasoning-sections.md

1. **Test Scope**: What functionality is being validated?
   > [Define what the test plan covers - features, components, integration points, user workflows]

2. **Risk Priority**: What are the highest-risk areas to test?
   > [Identify critical paths, complex integrations, security-sensitive areas, performance bottlenecks]

3. **Coverage Strategy**: How do we achieve adequate coverage?
   > [Describe approach - unit test %, integration points, E2E scenarios, edge cases]

4. **Resource Assessment**: What resources and data are needed?
   > [Environments, test data, tools, team skills, timeline constraints]

5. **Quality Criteria**: What constitutes passing vs failing?
   > [Define thresholds - coverage %, defect density, performance benchmarks, security requirements]

## Ownership & Collaboration

- Document Owner: Test Architect
- Contributor Roles: Test Engineer, Project Manager
- Automation Inputs: Test strategy, iteration roadmap, environment plan
- Automation Outputs: `master-test-plan.md` with sections 1–14

## Completion Checklist

- Test objectives and scope aligned with Vision and SDP
- Environments, tools, and resource needs confirmed
- Entry/exit criteria for each test level documented

## Document Sections

1. **Introduction**
   - Purpose, scope, and references to governing documents.
2. **Test Objectives**
   - Define what the testing effort aims to validate or discover.
3. **Test Items**
   - List components, features, or systems under test with version identifiers.
4. **In-Scope vs Out-of-Scope**
   - Clarify inclusions and exclusions with rationale.
5. **Test Approach**
   - Describe strategy across test levels (unit, integration, system, UAT, performance, security).
6. **Test Deliverables**
   - Enumerate artifacts (plans, cases, scripts, reports) to be produced.
7. **Test Environment**
   - Detail hardware, software, data sets, and configuration requirements.
8. **Roles and Responsibilities**
   - Assign ownership for planning, execution, automation, and reporting.
9. **Schedule and Milestones**
   - Align test activities with iteration/release milestones.
10. **Entry and Exit Criteria**
    - Define gating conditions for each test phase.
11. **Risk Management**
    - Identify testing risks, mitigation strategies, and contingency plans.
12. **Metrics and Reporting**
    - Specify KPIs (defect density, coverage, pass rate) and reporting cadence.
13. **Tools and Automation**
    - Document test management tools, automation frameworks, and integration points.
14. **Approvals**
    - Capture sign-off requirements and responsible parties.

## References

Wire @-mentions for traceability:

- @.aiwg/requirements/use-cases/ - Use cases covered
- @.aiwg/architecture/software-architecture-doc.md - Architecture under test
- @.aiwg/requirements/nfr-modules/performance.md - Performance requirements
- @test/ - Test implementation directory
- @$AIWG_ROOT/src/ - Source code under test

## Agent Notes

- Keep terminology aligned with the Supplementary Specification and Risk List.
- Link to iteration-level plans and evaluation summaries for traceability.
- Update schedule and risks after each iteration assessment.
- Verify the Automation Outputs entry is satisfied before signaling completion.
- **Wire @-mentions** in References section when generating this document.
