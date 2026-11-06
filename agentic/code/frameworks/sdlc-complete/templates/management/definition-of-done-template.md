# Definition of Done Template

## Purpose

Establish clear, measurable quality criteria at story, iteration, and release levels. The Definition of Done (DoD) ensures consistent quality standards across the team and prevents incomplete work from moving forward.

## Ownership

- Owner: Project Manager
- Contributors: Test Architect, Architecture Designer, Software Implementer
- Reviewers: Product Owner, Stakeholders

## Three-Level Quality Framework

### Story-Level Definition of Done

Work is complete when an individual user story, task, or defect meets these criteria.

#### Functional Completeness

- [ ] All acceptance criteria validated
- [ ] Happy path functionality demonstrated
- [ ] Edge cases identified and handled
- [ ] Error conditions handled gracefully
- [ ] Business rules implemented correctly

#### Technical Quality

- [ ] Code follows team coding standards
- [ ] Code reviewed by at least one peer
- [ ] No critical or high-severity static analysis warnings
- [ ] Unit tests written and passing (coverage: ___%)
- [ ] Integration points tested
- [ ] Performance expectations met (specify: ___ms response time, ___MB memory)

#### Documentation

- [ ] Inline code comments for complex logic
- [ ] API documentation updated (if applicable)
- [ ] User-facing documentation updated
- [ ] README or setup instructions current

#### Integration

- [ ] Code integrated to main branch
- [ ] All automated tests passing in CI pipeline
- [ ] No merge conflicts
- [ ] Deployment scripts updated (if needed)

#### Verification

- [ ] Product Owner or proxy accepted the work
- [ ] Demonstrated in team review
- [ ] Traceability links complete (requirements → design → code → tests)

### Iteration/Sprint-Level Definition of Done

The iteration is complete when the body of work meets cumulative quality standards.

#### Scope Completion

- [ ] All committed stories meet story-level DoD
- [ ] Velocity targets achieved or variance explained
- [ ] Sprint goal met or adjusted with stakeholder approval
- [ ] All incomplete work moved to backlog with status notes

#### Quality Metrics

- [ ] Code coverage maintained or improved (target: ___%)
- [ ] Defect discovery rate within expected range (___defects per story)
- [ ] Test pass rate above threshold (target: ___%)
- [ ] No P0/critical defects open
- [ ] All P1/high defects triaged with resolution plan

#### Integration Stability

- [ ] All features integrated without breaking existing functionality
- [ ] Regression test suite passing
- [ ] No deployment blockers
- [ ] Environment stability verified (no infrastructure issues)

#### Documentation

- [ ] Architecture decision records (ADRs) updated
- [ ] Iteration retrospective completed
- [ ] Known issues documented in release notes
- [ ] User-facing changes documented

#### Stakeholder Engagement

- [ ] Sprint demo completed and stakeholder feedback captured
- [ ] Product Owner accepted all stories
- [ ] Feedback incorporated into backlog

### Release-Level Definition of Done

The release is production-ready when it meets comprehensive quality and operational criteria.

#### Feature Completeness

- [ ] All release-planned features complete and tested
- [ ] Feature flags configured for controlled rollout (if applicable)
- [ ] Backward compatibility verified
- [ ] Migration scripts tested (if schema changes)

#### Quality Assurance

- [ ] All test levels executed and passing:
  - [ ] Unit tests (target: ___% coverage)
  - [ ] Integration tests (target: ___% coverage)
  - [ ] System tests (target: ___% critical path coverage)
  - [ ] Acceptance tests (target: 100% of acceptance criteria)
  - [ ] Performance tests (benchmarks met: ___)
  - [ ] Security tests (no critical/high vulnerabilities)
  - [ ] Accessibility tests (WCAG 2.1 AA compliance)
- [ ] Exploratory testing completed
- [ ] User acceptance testing (UAT) completed and signed off
- [ ] Production-like environment testing completed

#### Non-Functional Requirements

- [ ] Performance benchmarks met (specify: ___requests/sec, ___ms latency)
- [ ] Scalability tested to expected load (specify: ___concurrent users)
- [ ] Reliability targets met (specify: ___% uptime, MTBF, MTTR)
- [ ] Security requirements validated (penetration testing, vulnerability scanning)
- [ ] Data protection and privacy compliance verified (GDPR, CCPA, etc.)
- [ ] Accessibility compliance validated (WCAG, ADA, Section 508)

#### Operational Readiness

- [ ] Deployment runbook complete and tested
- [ ] Rollback procedure validated
- [ ] Monitoring and alerting configured
- [ ] Logging and diagnostics verified
- [ ] Performance baselines established
- [ ] Backup and disaster recovery tested
- [ ] On-call procedures updated
- [ ] Incident response plan current

#### Documentation

- [ ] User documentation complete and published
- [ ] Administrator documentation complete
- [ ] API documentation current and published
- [ ] Release notes finalized
- [ ] Known issues and workarounds documented
- [ ] Training materials ready (if required)

#### Compliance and Governance

- [ ] Security review completed and signed off
- [ ] Legal review completed (license, terms, privacy policy)
- [ ] Compliance requirements met (industry-specific: HIPAA, PCI-DSS, SOC 2)
- [ ] Audit trail complete (traceability from requirements to tests)
- [ ] Risk assessment current
- [ ] Change management approvals obtained

#### Stakeholder Sign-Off

- [ ] Product Owner approval
- [ ] Technical Lead approval
- [ ] Security Architect approval
- [ ] Deployment Manager approval
- [ ] Executive sponsor approval (if required)

## Tailoring Guidance

Different project types require different DoD emphasis. Adjust criteria based on your context.

### By Project Type

#### Web Application (Public SaaS)

**Emphasis**:

- Security testing (OWASP Top 10 coverage)
- Accessibility (WCAG 2.1 AA)
- Performance (page load < 3s)
- Privacy compliance (GDPR, CCPA)
- Browser compatibility (latest 2 versions of major browsers)

**Additional Story-Level Criteria**:

- [ ] Cross-browser testing completed
- [ ] Mobile responsive design verified
- [ ] Analytics instrumented

**Additional Release-Level Criteria**:

- [ ] CDN configured and tested
- [ ] DDoS protection verified
- [ ] Rate limiting configured

#### Enterprise Internal Tool

**Emphasis**:

- Integration with enterprise systems (SSO, LDAP, etc.)
- Role-based access control (RBAC)
- Audit logging
- Data retention policies
- Change management process

**Additional Story-Level Criteria**:

- [ ] Permission model tested
- [ ] Audit logs verified

**Additional Release-Level Criteria**:

- [ ] Enterprise SSO integration tested
- [ ] Audit compliance verified
- [ ] IT change ticket approved

#### Mobile Application

**Emphasis**:

- Offline functionality
- Battery and data usage optimization
- App store compliance (Apple, Google policies)
- Push notification reliability
- Device compatibility testing

**Additional Story-Level Criteria**:

- [ ] Offline mode tested
- [ ] Battery impact measured

**Additional Release-Level Criteria**:

- [ ] App store submission assets ready
- [ ] Crash reporting configured
- [ ] Beta testing completed (TestFlight, Google Play Beta)

#### Embedded System

**Emphasis**:

- Hardware integration testing
- Resource constraints (memory, CPU, power)
- Real-time performance
- Firmware update mechanism
- Safety-critical validation (if applicable)

**Additional Story-Level Criteria**:

- [ ] Memory profiling completed
- [ ] Power consumption measured

**Additional Release-Level Criteria**:

- [ ] Hardware compatibility tested
- [ ] Firmware update tested
- [ ] Safety certification obtained (if required)

#### API/Service

**Emphasis**:

- API contract stability
- Versioning strategy
- Rate limiting and quotas
- Authentication and authorization
- API documentation accuracy

**Additional Story-Level Criteria**:

- [ ] API contract tests passing
- [ ] Breaking changes avoided or documented

**Additional Release-Level Criteria**:

- [ ] API documentation published
- [ ] Deprecation notices sent (if applicable)
- [ ] Client SDK compatibility verified

### By Development Methodology

#### Agile/Scrum

- Emphasize iteration-level DoD
- Demo to stakeholders every iteration
- Maintain sustainable velocity
- Retrospective-driven improvements

#### Kanban

- Emphasize story-level DoD
- Continuous delivery focus
- WIP limits enforced
- Cycle time tracked

#### Waterfall/Phase-Gate

- Emphasize release-level DoD
- Formal phase reviews
- Comprehensive documentation
- Sign-off at each gate

### By Risk Profile

#### High-Risk (Healthcare, Finance, Safety-Critical)

**Additional Release Criteria**:

- [ ] Independent verification and validation (IV&V)
- [ ] Formal hazard analysis completed
- [ ] Regulatory submission approved (FDA, SEC, etc.)
- [ ] Clinical trials or field testing completed
- [ ] Insurance and liability coverage confirmed

#### Medium-Risk (E-Commerce, Business Tools)

**Additional Release Criteria**:

- [ ] Payment processing tested in production-like environment
- [ ] Fraud detection mechanisms validated
- [ ] Data backup and recovery tested
- [ ] Business continuity plan tested

#### Low-Risk (Internal Tools, Prototypes)

**Relaxed Release Criteria**:

- May reduce test coverage requirements
- May reduce documentation requirements
- May skip security review (use caution)
- May reduce approval chain

## Verification Checklist

Use this summary checklist to verify DoD compliance before marking work complete.

### Quick Story Checklist

- [ ] All acceptance criteria met
- [ ] Code reviewed and approved
- [ ] Tests written and passing
- [ ] CI pipeline green
- [ ] Product Owner accepted

### Quick Iteration Checklist

- [ ] All stories meet story DoD
- [ ] Sprint goal achieved
- [ ] Regression tests passing
- [ ] Demo completed
- [ ] Retrospective held

### Quick Release Checklist

- [ ] All test levels passing
- [ ] Non-functional requirements met
- [ ] Documentation complete
- [ ] Operational readiness verified
- [ ] Stakeholders signed off

## Monitoring and Continuous Improvement

Track DoD compliance over time to identify patterns and improve standards.

### Metrics to Track

- **DoD Escape Rate**: % of work marked "done" that later fails criteria
- **Rework Rate**: % of completed work requiring additional effort
- **Quality Gate Pass Rate**: % of work passing DoD on first attempt
- **Defect Leakage**: Defects found in later phases that should have been caught

### Review Cadence

- **Monthly**: Review DoD escape rate and rework rate
- **Quarterly**: Adjust DoD criteria based on lessons learned
- **Annually**: Comprehensive DoD framework review

### Red Flags

- DoD consistently bypassed ("we'll fix it later")
- High variance in DoD interpretation across team members
- DoD not updated as project context changes
- Quality metrics degrading over time

## Template Customization

Copy this template and customize for your project:

1. **Fill in specific thresholds**: Replace "___" placeholders with your targets
2. **Add project-specific criteria**: Include domain requirements (compliance, certifications)
3. **Remove irrelevant sections**: Tailor to your project type and risk profile
4. **Get team agreement**: Review and approve DoD with the entire team
5. **Make it visible**: Post DoD in team workspace and CI dashboard
6. **Update regularly**: Treat DoD as living document, not static policy

## Related Templates

- `agentic/code/frameworks/sdlc-complete/templates/management/iteration-plan-template.md` - Iteration planning and commitments
- `agentic/code/frameworks/sdlc-complete/templates/management/quality-assurance-plan-template.md` - Quality metrics and gates
- `agentic/code/frameworks/sdlc-complete/templates/test/test-evaluation-summary-template.md` - Test results verification
- `agentic/code/frameworks/sdlc-complete/templates/deployment/deployment-plan-template.md` - Operational readiness criteria
- `agentic/code/frameworks/sdlc-complete/templates/deployment/automated-quality-gate-template.md` - Security quality gates

## Notes

- The Definition of Done is a **team agreement**, not a mandate. Collaborate to define what "done" means for your context.
- Resist the temptation to make DoD so strict that nothing ever finishes. Balance rigor with pragmatism.
- DoD is not a replacement for acceptance criteria. Acceptance criteria define **what** is built; DoD defines **how well** it's built.
- When in doubt, prioritize safety, security, and user experience over speed to market.
