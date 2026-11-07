# Epic Card

## Metadata

- **ID**: `EP-{project}-{number}` (e.g., EP-PLATFORM-005)
- **Type**: Requirement Card (Epic)
- **Status**: Draft | Approved | In Progress | Done | Rejected | On Hold
- **Owner**: Product Owner / Product Manager
- **Contributors**: Business Analyst, Stakeholders, Technical Lead
- **Reviewers**: Executive Sponsor, Architecture Lead
- **Team**: Product Management
- **Stakeholders**: List key business and technical stakeholders
- **Created**: YYYY-MM-DD
- **Last Updated**: YYYY-MM-DD
- **Entry Gate**: [Required upstream deliverables verified]
- **Completion Gate**: [Acceptance checks and approver]
- **Operator Commitments**: [Supplied date/window and source, or none; never infer]
- **Priority**: Critical | High | Medium | Low
- **Strategic Theme**: [Product area or business objective]
- **Related**:
  - Business Case: `BC-{id}`
  - Vision: `VISION-{id}`
  - Features: `FEAT-{id1}`, `FEAT-{id2}`
  - User Stories: `US-{id1}`, `US-{id2}`, `US-{id3}`
  - Roadmap: `ROADMAP-{id}`
  - Architecture: `ADR-{id}`, `ARCH-{id}`
  - Risks: `RSK-{id}`
  - Dependencies: `DEP-{id}`

## Epic Overview

### Epic Statement

**As a** [user type/persona]
**I want** [large capability or initiative]
**So that** [significant business outcome or value]

**Example**:
**As a** job seeker
**I want** an advanced search and filtering system
**So that** I can quickly find relevant job opportunities that match my skills, location, and salary expectations

### Business Context

**Problem**: [What business problem or opportunity does this epic address?]

**Current State**: [How do users solve this problem today? What are the pain points?]

**Desired State**: [What will be possible after this epic is complete?]

**Market Context**: [Competitive landscape, market trends, or strategic imperatives]

## Value Proposition

### Business Value

**Revenue Impact**: [Expected revenue increase, new revenue streams, or cost savings]

**Strategic Alignment**: [How this epic advances company strategy or goals]

**Competitive Advantage**: [How this differentiates from competitors]

**Quantified Benefits**:

- [Metric 1]: [Expected improvement, e.g., "20% increase in user engagement"]
- [Metric 2]: [Expected improvement, e.g., "$500K annual revenue"]
- [Metric 3]: [Expected improvement, e.g., "30% reduction in support tickets"]

### User Value

**User Impact**: [How many users affected, which personas benefit]

**User Benefit**: [What users can now do that they couldn't before]

**User Pain Addressed**: [What frustration or limitation is removed]

**User Metrics**:

- [Metric 1]: [Expected change, e.g., "Reduce time-to-hire by 25%"]
- [Metric 2]: [Expected change, e.g., "Increase user satisfaction from 3.2 to 4.5"]

### Success Metrics

This epic is successful when:

- **Leading Indicator 1**: [Early signal of success, e.g., "50% of users enable new feature"]
- **Leading Indicator 2**: [Early signal, e.g., "10,000 searches/day within first month"]
- **Outcome Metric 1**: [Business result, e.g., "15% increase in conversions"]
- **Outcome Metric 2**: [Business result, e.g., "20% reduction in churn"]

**Measurement Plan**: [How and when metrics will be collected and reviewed]

## Scope

### In Scope

Features and capabilities included in this epic:

1. [Feature 1]: [Brief description]
2. [Feature 2]: [Brief description]
3. [Feature 3]: [Brief description]

### Out of Scope

Explicitly excluded to prevent scope creep:

1. [Excluded item 1]: [Reason for exclusion or future consideration]
2. [Excluded item 2]: [Reason for exclusion]

### Minimum Viable Epic (MVE)

The smallest subset that delivers meaningful value:

- [MVE Feature 1]: Must-have for any value
- [MVE Feature 2]: Core to the user experience
- [MVE Feature 3]: Necessary for business outcome

**MVE Success Criterion**: [What defines "good enough" for first release]

## Epic Breakdown

### Features

Large capabilities within this epic:

| Feature ID | Feature Name | Priority | Status | Owner | Review Passes | Dependencies |
|------------|--------------|----------|--------|-------|--------------|--------------|
| FEAT-042 | Advanced filter UI | High | In Progress | Design Lead | 2 | None |
| FEAT-043 | Search engine optimization | Critical | Done | Backend Lead | 3 | None |
| FEAT-044 | Saved searches | Medium | Not Started | Product Lead | 2 | FEAT-042 |
| FEAT-045 | Search analytics dashboard | Low | Backlog | Analytics Lead | 2 | FEAT-043 |

### User Stories

Smaller, implementable units:

| Story ID | Story Title | Feature | Priority | Status | Acceptance Gate | Prerequisite |
|----------|-------------|---------|----------|--------|--------------|--------|
| US-142 | Location autocomplete | FEAT-042 | High | Done | Autocomplete test passes | None |
| US-143 | Salary range filter | FEAT-042 | High | Done | Salary range test passes | None |
| US-144 | Experience level filter | FEAT-042 | Medium | In Progress | Experience filter test passes | Filter UI |
| US-145 | Save search preferences | FEAT-044 | Medium | Backlog | Saved preferences persist | Filter UI |
| US-146 | Email search alerts | FEAT-044 | Low | Backlog | Alert delivery test passes | Saved preferences |

**Total Stories**: 5 planned (2 complete, 1 in progress, 2 backlog)
**Scope Units**: 5 independently verified stories; count acceptance gates met and pending.

### Epics Can Contain Epics

For very large initiatives, break into sub-epics:

| Sub-Epic ID | Title | Status | Gates Met / Total |
|-------------|-------|--------|------------|
| EP-PLATFORM-005.1 | Search UX Foundation | In Progress | 3 / 5 |
| EP-PLATFORM-005.2 | Advanced Filters | Not Started | 0 / 3 |
| EP-PLATFORM-005.3 | Search Personalization | Backlog | 0 / 3 |

## Scope and Delivery Gates

### Scope, Roles, and Passes

**Scope Units**: [Named features and stories with acceptance checks]
**Prerequisites**: [Upstream gates; identify units that can run in parallel]
**Review Passes**: [Implementation, verification, and correction passes]

**Roles**: [Implementer, reviewer, test engineer, and rollout owner]
**Team Size**: [Number of people or agents allocated]

### Key Delivery Gates

| Gate | Prerequisite | Deliverable | Success Criteria | Status |
|-----------|------|-------------|------------------|--------|
| Alpha Release | Core filter tests pass | Basic search with 3 filters | 100 internal users testing | Complete |
| Beta Release | Alpha feedback resolved | Full filter set, saved searches | 1,000 beta users, <5% bug rate | In Progress |
| GA Release | Beta acceptance checks pass | Public launch with analytics | 50K searches/day, 4.0 rating | Planned |

### Phased Rollout Plan

**Phase 1: Internal (entry: core filter tests pass)**

- Audience: Internal employees and contractors
- Features: Core search with location and salary filters
- Goal: Validate functionality, gather feedback

**Phase 2: Beta (entry: internal feedback resolved)**

- Audience: 10% of active users (invited)
- Features: All filters, saved searches
- Goal: Measure performance, refine UX

**Phase 3: General Availability (entry: beta acceptance checks pass)**

- Audience: All users
- Features: Complete epic scope
- Goal: Achieve success metrics

## Dependencies

### Upstream Dependencies

Work that must complete before this epic can progress:

| Dependency ID | Description | Owner | Status | Impact if Delayed |
|---------------|-------------|-------|--------|-------------------|
| DEP-012 | Database schema migration | Data Team | Complete | Epic blocked entirely |
| DEP-013 | Design system update | Design Team | In Progress | UX consistency issues |

### Downstream Impact

Work that depends on this epic:

| Dependent Epic/Feature | Impact if This Epic Delayed |
|------------------------|----------------------------|
| EP-PLATFORM-007 (AI Recommendations) | Cannot personalize without search data |
| FEAT-088 (Mobile App Search) | Cannot launch mobile until web proven |

### External Dependencies

Third-party or cross-team dependencies:

| External System/Team | Dependency | Risk | Mitigation |
|----------------------|------------|------|------------|
| Location API Vendor | Geocoding service | Medium - vendor outage | Cache frequently used locations |
| Legal/Compliance | Privacy review of search data | Low - may delay analytics | Start review early, parallel path |

## Risks and Assumptions

### Risks

| Risk | Probability | Impact | Mitigation | Contingency |
|------|-------------|--------|------------|-------------|
| Search performance degrades at scale | Medium | High | Load testing, caching strategy | Degrade gracefully, queue searches |
| User adoption lower than expected | Low | High | Beta testing, user research | Invest in onboarding, simplify UI |
| Database migration fails | Low | Critical | Rollback plan, phased migration | Resolve migration blockers, reduce scope |

### Assumptions

| Assumption | Impact if Invalid | Validation Approach |
|------------|-------------------|---------------------|
| Users want advanced filters (not just keyword) | High - wasted effort | User research, surveys |
| Current database can handle search load | High - requires re-architecture | Load testing in staging |
| Legal approves storing search history | Medium - delays saved searches | Early legal review |

## Acceptance Criteria

This epic is "Done" when:

### Functional Criteria

- [ ] All committed user stories are complete and meet Definition of Done
- [ ] Users can search using all defined filter criteria
- [ ] Search results are accurate and relevant
- [ ] Saved searches persist across sessions
- [ ] Search performance meets non-functional requirements

### Non-Functional Criteria

- [ ] Search response time <2 seconds for 95th percentile
- [ ] System handles 10,000 concurrent searches
- [ ] Uptime >99.9% during business hours
- [ ] Mobile-responsive design (works on iOS/Android)
- [ ] Accessibility: WCAG 2.1 Level AA compliant
- [ ] Privacy: Search data encrypted at rest and in transit

### Business Criteria

- [ ] Success metrics achieved (see "Success Metrics" section)
- [ ] User satisfaction rating >4.0/5.0
- [ ] No critical or high-severity bugs in production
- [ ] Legal and compliance review passed
- [ ] Documentation and training materials complete

## Technical Considerations

**Note**: This section provides context, not prescriptive solutions.

### Architecture Patterns

- **Search Engine**: [Technology considerations, e.g., "Evaluate Elasticsearch vs PostgreSQL full-text"]
- **Caching Strategy**: [Approach to cache frequent searches]
- **API Design**: [RESTful, GraphQL, or other approach]

### Data Requirements

- **Schema Changes**: [New tables, columns, or indexes needed]
- **Data Volume**: [Expected search query volume, storage needs]
- **Data Privacy**: [PII handling, retention policies]

### Integration Points

- **Systems**: [External services or internal systems this epic touches]
- **APIs**: [New endpoints or modifications to existing]
- **Data Pipelines**: [ETL, analytics, or reporting integrations]

### Constraints

- **Performance**: [Response time, throughput targets]
- **Scalability**: [Concurrent users, data volume growth]
- **Security**: [Authentication, authorization, data protection]
- **Compliance**: [GDPR, CCPA, industry regulations]

## Notes & Attachments

### Conversation Log

Track key decisions and clarifications:

- **YYYY-MM-DD**: Decided to use PostgreSQL full-text search (ADR-023)
- **YYYY-MM-DD**: Approved 2-month extension for beta testing
- **YYYY-MM-DD**: Legal approved search history storage with 90-day retention

### Attachments

- **User Research**: [Link to research findings, user personas]
- **Wireframes**: [Link to design mockups]
- **Architecture Diagrams**: [Link to system design documents]
- **Market Analysis**: [Link to competitive analysis]

## Progress Tracking

### Completion Metrics

- **Features Complete**: 1/4 (3 pending)
- **Stories Complete**: 2/5 (3 pending)
- **Acceptance Gates**: 2/5 met
- **Remaining Scope**: Experience filter, saved preferences, email alerts

### Verification Passes

| Pass | Scope Reviewed | Gates Met | Pending Gates |
|--------|----------------------|------------------------|-----------|
| Implementation | 5 stories | 1 | 4 |
| Test and correction | 5 stories | 2 | 3 |
| Integration | 3 pending stories | (in progress) | 3 |

**Next Gate**: Verify experience filter before saved-preferences integration; repeat correction pass for failing checks.

## Related Templates

- `/docs/sdlc/templates/management/product-backlog-template.md` - Epic sits in product backlog
- `/docs/sdlc/templates/requirements/user-story-card.md` - Epics break down into stories
- `/docs/sdlc/templates/business-modeling/vision-document-template.md` - Epics align with vision
- `/docs/sdlc/templates/requirements/feature-specification-template.md` - Features within epics
- `/docs/sdlc/templates/management/risk-card.md` - Epic risks tracked here

## Agent Notes

### For Product Owner / Product Manager

- Define epic scope based on business value, not technical curiosity
- Break large epics into smaller epics or features (each with independently verifiable acceptance gates)
- Prioritize epics based on strategic goals and dependencies
- Review epic progress monthly, adjust scope or prerequisites as needed
- Be ruthless about "Out of Scope" - say no to scope creep

### For Requirements Analyst

- Ensure epic breaks down into features and stories logically
- Validate acceptance criteria are measurable and achievable
- Trace epics back to vision and business case
- Identify dependencies early, especially external ones
- Update epic progress as stories complete

### For Architecture Designer

- Review technical considerations early in epic lifecycle
- Flag architecture risks that could derail epic
- Ensure epic doesn't violate system constraints
- Recommend technology choices, but don't prescribe
- Validate non-functional requirements are realistic

### For Project Manager

- Track epic progress against scope units and delivery gates
- Monitor dependencies and escalate blockers
- Report epic status to stakeholders monthly
- Adjust sprint planning based on epic priorities
- Manage risks and assumptions proactively

### For Test Engineer

- Validate epic acceptance criteria are testable
- Plan test strategy for epic (unit, integration, E2E)
- Identify test data and environment needs early
- Define non-functional test approach (load, security)
- Track defect trends across epic lifecycle

## Quality Gates

**Epic is Ready for Work When**:

- [ ] Epic statement is clear and aligns with business goals
- [ ] Business value and success metrics are quantified
- [ ] Scope (in/out) is defined and agreed
- [ ] Epic breaks down into features or stories (at least high-level)
- [ ] Dependencies are identified
- [ ] Key risks are documented
- [ ] Stakeholders have reviewed and approved

**Epic is Complete When**:

- [ ] All committed features/stories are "Done"
- [ ] Acceptance criteria met (functional, non-functional, business)
- [ ] Success metrics achieved or progress toward them validated
- [ ] No critical or high-severity defects remain
- [ ] Documentation complete
- [ ] Stakeholder acceptance obtained

## Version Control

**Version**: 1.0
**Last Updated**: 2025-10-15
**Owner**: Requirements Analyst + Product Designer
**Change History**:

- 2025-10-15: Initial template created (v1.0)
