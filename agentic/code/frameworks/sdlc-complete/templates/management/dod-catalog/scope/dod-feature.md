---
dod_id: dod-feature
name: Feature Definition of Done
scope: scope
category: feature
version: 1.0.0
extensible: true
---

# Feature Definition of Done

## Purpose

Confirms that a cohesive feature — a group of related stories delivering a complete capability — is ready for stakeholder demonstration, integration into the release, and potential early access or beta delivery. Prevents half-built features from entering a release candidate.

## Criteria

### Required

- [ ] Every story within the feature meets dod-story criteria (no open stories)
- [ ] Feature-level integration tests cover all cross-story interactions
- [ ] All integration tests pass in the CI environment targeting the integration branch
- [ ] Feature behaves correctly end-to-end in a staging or production-like environment
- [ ] No P0 or P1 defects are open against this feature
- [ ] Feature flag (if used) follows the accepted card, including deliberate safe default and removal task
- [ ] Feature demonstrated to Product Owner in a working environment; PO accepts it
- [ ] User-facing documentation or release notes entry written and reviewed

### Recommended

- [ ] Feature walkthrough recorded or documented for async stakeholder review
- [ ] Performance impact of the feature measured and within agreed bounds
- [ ] Analytics events for key feature interactions instrumented and verified in staging
- [ ] Backwards compatibility with existing data or API consumers confirmed
- [ ] Security review completed for any new attack surface introduced

## Verification

**Automated checks:**
- CI integration test suite: all feature-scoped tests green
- Feature flags: required current production, upcoming and default/fallback path tests; optional all-on, not every combination ([testing](https://launchdarkly.com/docs/guides/flags/testing-code.md)). Flag off equals current behavior is a convention; document exceptions ([Hodgson](https://martinfowler.com/articles/feature-toggles.html)).
- Static analysis: no new critical findings introduced by feature's changes

**Manual steps:**
- Product Owner demo session: feature works end-to-end with real or representative data
- Documentation review: a team member not on the feature reads the docs and confirms accuracy
- Defect triage: bug tracker shows zero open P0/P1 issues tagged to this feature

## Tailoring Guide

**Add criteria when:**
- Feature introduces a new data model: require data migration plan and rollback procedure reviewed
- Feature is externally facing (API, UI): require API contract tests and browser/device coverage checklist
- Feature has SLA implications: require load test confirming throughput at expected peak
- Feature spans multiple services: require contract or integration tests between all service pairs

**Remove or relax criteria when:**
- Feature is internal tooling with no external users: may skip analytics and documentation requirements
- Feature is behind a long-lived flag with no near-term activation: defer performance measurement to activation gate
- Team uses continuous delivery without feature flags: fold feature DoD into iteration DoD

## Extension Points

- `ext-feature-compliance` — regulatory or audit criteria applicable to the feature's domain
- `ext-feature-nfr` — non-functional requirements (performance thresholds, SLOs) contributed by project config
- `ext-feature-platform` — platform-specific acceptance (mobile stores, browser matrix, accessibility audit)
