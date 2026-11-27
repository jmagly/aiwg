# Test Strategy Template

Adapted from the original RUP template: <https://files.defcon.no/RUP/webtmpl/templates/test/rup_tststr.htm>

### Feature flag state coverage (when flags are used)

- Required: current production state, upcoming state, and default/fallback path;
  record flag values, evaluation context and test IDs. Optional: all-on.
- Test the selected configurations, not every combination
  ([testing](https://launchdarkly.com/docs/guides/flags/testing-code.md), [Hodgson](https://martinfowler.com/articles/feature-toggles.html)).
- Flag off equals current behavior is a convention; document exceptions and
  deliberate defaults ([Hodgson](https://martinfowler.com/articles/feature-toggles.html)).
- Link accepted cards and removal tasks; cicd `flag-states-test` may run this set. [AIWG guidance]


## Purpose

Describe the guiding principles, methodologies, and standards governing the testing effort throughout the project
lifecycle.

## Ownership & Collaboration

- Document Owner: Test Architect
- Contributor Roles: Test Engineer, Configuration Manager, Project Manager
- Automation Inputs: Quality goals, architecture overview, tooling inventory
- Automation Outputs: `test-strategy.md` documenting sections 1–11

## Phase 1: Core Strategy (ESSENTIAL)

Complete these sections immediately when defining the test strategy:

### Context and Objectives

**Project Context**:

<!-- EXAMPLE: E-commerce platform with 50K daily users, payment processing, user authentication, inventory management. Expected to scale to 500K users within 2 years. -->

**Quality Goals**:

<!-- EXAMPLE:
- Defect escape rate <2% to production
- Code coverage >80% for new code
- P95 response time <500ms under normal load
- Zero critical security vulnerabilities in production
-->

**Testing Objectives**:

<!-- EXAMPLE:
1. Validate functional correctness of all user-facing features
2. Ensure system performance meets SLA requirements under expected load
3. Identify and mitigate security vulnerabilities before production
4. Maintain high code quality through automated testing and review
5. Enable fast, confident deployments through comprehensive test coverage
-->

### Test Levels and Scope

**Test Levels**: [Which types of testing will be performed]

<!-- EXAMPLE:
- **Unit Testing**: All business logic, utilities, pure functions (target: 85% coverage)
- **Integration Testing**: API contracts, database interactions, third-party service integrations (target: 70% coverage)
- **System Testing**: End-to-end user workflows, cross-component interactions (target: critical paths covered)
- **Acceptance Testing**: Business stakeholder validation of completed features
- **Performance Testing**: Load testing at 2x expected peak, stress testing to failure
- **Security Testing**: OWASP Top 10 validation, dependency scanning, penetration testing (quarterly)
- **Usability Testing**: User research sessions with representative users (monthly)
-->

**Scope Boundaries**:

**In Scope**:

<!-- EXAMPLE:
- All custom application code in src/ directory
- API endpoints and integration points
- Database migrations and schema changes
- User-facing UI components and workflows
- Third-party integrations (payment, email, auth)
-->

**Out of Scope**:

<!-- EXAMPLE:
- Third-party library internals (trust vendor testing)
- Infrastructure provisioning (covered by DevOps testing strategy)
- Manual exploratory testing (covered by QA team process)
-->

### Automation Strategy

**Automation Goals**:

<!-- EXAMPLE:
- 85% unit test coverage by end of each sprint
- All API endpoints have integration tests before merge
- Critical user paths covered by E2E tests
- All tests run in CI/CD pipeline (no manual test execution)
- Test execution time <10 minutes for unit/integration, <30 minutes for E2E
-->

**Frameworks and Tools**:

<!-- EXAMPLE:
- **Unit/Integration**: Jest (JavaScript/TypeScript)
- **E2E**: Playwright (cross-browser testing)
- **Performance**: k6 (load/stress testing)
- **Security**: Snyk (dependency scanning), OWASP ZAP (dynamic scanning)
- **Coverage**: Istanbul (code coverage reporting)
- **CI/CD**: GitHub Actions (automated test execution)
-->

## Phase 2: Methods & Environment (EXPAND WHEN READY)

<details>
<summary>Click to expand test techniques and environment strategy</summary>

### Test Types and Techniques

**Testing Techniques**:

<!-- EXAMPLE:
- **Test-Driven Development (TDD)**: Required for all new business logic
- **Behavior-Driven Development (BDD)**: Used for user story acceptance criteria
- **Exploratory Testing**: Weekly sessions with QA team
- **Risk-Based Testing**: Prioritize testing based on business impact and failure probability
- **Regression Testing**: Automated suite runs on every commit
- **Property-Based Testing**: For complex algorithms and data transformations
-->

**When to Apply Each**:

<!-- EXAMPLE:
| Technique | Phase | Trigger |
|-----------|-------|---------|
| TDD | Construction | New feature development |
| BDD | Elaboration → Construction | User story acceptance criteria definition |
| Exploratory | All phases | Weekly scheduled sessions |
| Risk-Based | Elaboration | During risk assessment |
| Regression | Construction → Transition | Every code commit |
| Property-Based | Construction | Complex algorithms (e.g., pricing, scheduling) |
-->

### Environment Strategy

**Test Environments**:

<!-- EXAMPLE:
| Environment | Purpose | Data | Deployment |
|-------------|---------|------|------------|
| Local Dev | Developer testing | Mocked/fixtures | Manual |
| CI | Automated testing | Fixtures + test DB | Auto on PR |
| QA | Manual validation | Anonymized prod clone | Auto nightly |
| Staging | Pre-production validation | Prod-like synthetic | Auto on merge |
| Production | Live system | Real user data | Manual approval |
-->

**Data Management**:

<!-- EXAMPLE:
- **Test Fixtures**: Version-controlled JSON/YAML fixtures for unit/integration tests
- **Seed Data**: Database seeding scripts for QA/staging environments
- **Data Anonymization**: Automated PII scrubbing for prod data clones
- **Synthetic Data**: Faker.js for generating realistic test data at scale
-->

**Environment Provisioning**:

<!-- EXAMPLE:
- Infrastructure-as-code (IaC)
- Docker Compose for local development environment
- GitHub Actions matrix for multi-browser/OS testing
- Ephemeral environments created per pull request
-->

### Defect Management

**Defect Lifecycle**:

<!-- EXAMPLE:
New → Triaged → Assigned → In Progress → Fixed → Verified → Closed
                    ↓
                Rejected (duplicate, won't fix, cannot reproduce)
-->

**Severity/Priority Scheme**:

<!-- EXAMPLE:
| Severity | Definition | SLA |
|----------|------------|-----|
| Critical | System down, data loss, security breach | Fix within 4 hours |
| High | Core feature broken, workaround exists | Fix within 24 hours |
| Medium | Minor feature broken, cosmetic issues | Fix in next sprint |
| Low | Enhancement, nice-to-have | Backlog |
-->

**Tooling**:

<!-- EXAMPLE:
- **Defect Tracking**: GitHub Issues with labels (bug, severity:high, priority:critical)
- **Integration**: Jest/Playwright failures auto-create issues
- **Reporting**: Weekly defect metrics dashboard (open, resolved, escape rate)
-->

</details>

## Phase 3: Governance & Improvement (ADVANCED)

<details>
<summary>Click to expand metrics, governance, and continuous improvement</summary>

### Metrics and Reporting

**Key Metrics**:

<!-- EXAMPLE:
- **Test Coverage**: Unit 85%, integration 70%, E2E critical paths
- **Defect Metrics**: Escape rate <2%, mean time to resolution <48h
- **Test Execution**: Pass rate >98%, execution time <10 min unit/integration
- **Velocity**: Tests written per story point (target: 3 tests/point)
- **Flakiness**: Flaky test rate <1% (tests with intermittent failures)
-->

**Dashboards**:

<!-- EXAMPLE:
- **Daily**: CI/CD test results, coverage trends, flaky test report
- **Weekly**: Defect burn-down, test velocity, new vs fixed defects
- **Monthly**: Quality scorecard, test ROI analysis, retrospective metrics
-->

**Review Cadence**:

<!-- EXAMPLE:
- Daily: Test failures reviewed in standup
- Weekly: QA team reviews defect trends, flaky tests
- Sprint: Retrospective on test effectiveness, coverage gaps
- Quarterly: Test strategy review with architecture team
-->

### Governance and Reviews

**Quality Gates**:

<!-- EXAMPLE:
| Gate | Criteria | Blocker |
|------|----------|---------|
| PR Merge | All tests pass, coverage >80% new code | Yes |
| Sprint Complete | No P0/P1 defects open, acceptance tests pass | Yes |
| Production Deploy | Staging tests pass, security scan clean | Yes |
| Release | Regression suite pass, performance benchmarks met | Yes |
-->

**Review Checkpoints**:

<!-- EXAMPLE:
- **Code Review**: All changes require peer review including tests
- **Test Plan Review**: Test Architect approves test approach for new features
- **Architecture Review**: Test strategy alignment with system design
- **Retrospective**: Team reviews test effectiveness after each sprint
-->

**Approval Workflows**:

<!-- EXAMPLE:
- Feature complete → QA sign-off → Product Owner acceptance → Merge
- Production deploy → Test Architect approval → DevOps lead approval → Deploy
-->

### Risk-Based Testing Approach

**Risk Mapping**:

<!-- EXAMPLE:
| Risk Area | Business Impact | Test Priority | Coverage Target |
|-----------|-----------------|---------------|-----------------|
| Payment processing | Critical | Highest | 100% |
| User authentication | Critical | Highest | 100% |
| Inventory management | High | High | 90% |
| Product search | Medium | Medium | 80% |
| UI styling | Low | Low | Manual only |
-->

**Contingency Triggers**:

<!-- EXAMPLE:
- **Coverage drop below 75%**: Mandatory test-writing sprint
- **Defect escape rate >5%**: Root cause analysis, process review
- **Flaky test rate >2%**: Dedicated sprint to fix or delete flaky tests
- **Test execution time >20 min**: Optimization sprint, parallel execution
-->

### Compliance and Standards

**Industry Standards**:

<!-- EXAMPLE:
- ISO 29119 (Software Testing Standard) - Adapted for agile context
- OWASP Testing Guide v4 - For security testing
- WCAG 2.1 Level AA - For accessibility testing
-->

**Organizational Policies**:

<!-- EXAMPLE:
- Company standard: 80% code coverage minimum
- Security policy: All dependencies scanned weekly
- Compliance: GDPR data handling validated in test cases
- Audit: Test results retained for 2 years (regulatory requirement)
-->

### Continuous Improvement

**Retrospectives**:

<!-- EXAMPLE:
- Sprint retrospective includes test effectiveness discussion
- Quarterly deep-dive on test strategy alignment with goals
- Annual review of test ROI and tool selection
-->

**Feedback Loops**:

<!-- EXAMPLE:
- Production incidents → New regression tests added
- Customer complaints → Enhanced acceptance testing
- Performance degradation → New benchmark tests
- Security vulnerabilities → Expanded security test suite
-->

**Learning Mechanisms**:

<!-- EXAMPLE:
- Monthly test engineering knowledge sharing sessions
- Quarterly training on new tools/techniques
- Post-incident reviews include test gap analysis
- Test Architect maintains lessons-learned knowledge base
-->

</details>

## Completion Checklist

Before finalizing this test strategy:

- [ ] All Phase 1 (ESSENTIAL) sections completed
- [ ] Test levels and scope clearly defined
- [ ] Automation strategy and tools selected
- [ ] Environment strategy documented
- [ ] Quality gates and metrics defined
- [ ] Compliance requirements identified
- [ ] Strategy aligns with business risks, architecture, and release cadence
- [ ] Test levels, methods, and responsibilities clearly delineated
- [ ] Automation and tooling approach defined across environments

## Agent Notes

- Keep strategy evergreen; revisit when significant architectural or process changes occur
- Align with Master Test Plan and Measurement Plan to ensure consistency
- Include links to tooling documentation or scripts maintained elsewhere in the repo
- Verify the Automation Outputs entry is satisfied before signaling completion
- Progressive disclosure: Define core strategy early (Phase 1), expand methods during elaboration (Phase 2), establish governance during construction (Phase 3)

## Related Templates

- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/test/master-test-plan-template.md - Detailed test plan
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/test/iteration-test-plan-template.md - Sprint-level testing
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/test/test-case-card.md - Individual test cases
- @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/management/quality-assurance-plan-template.md - Overall quality approach
