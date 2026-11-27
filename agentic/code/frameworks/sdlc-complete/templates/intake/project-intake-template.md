# Project Intake Form

## Metadata

- Project name: `name`
- Requestor/owner: `name/contact`
- Date: `YYYY-MM-DD`
- Stakeholders: `list`

## Problem and Outcomes

- Problem statement: `1–3 sentences`
- Target personas/scenarios: `bullets`
- Success metrics (KPIs): `e.g., activation +20%, p95 < 200ms`

## Scope and Constraints

- In-scope: `bullets`
- Out-of-scope (for now): `bullets`
- Timeframe: `e.g., MVP in 6 weeks`
- Budget guardrails: `e.g., <$X/mo infra`
- Platforms and languages (preferences/constraints): `list`

## Non-Functional Preferences

- Security posture: `Minimal | Baseline | Strong | Enterprise`
- Privacy & compliance: `None | GDPR | HIPAA | PCI | Other`
- Reliability targets: `Availability %, p95/p99, error budget`
- Scale expectations: `initial | 6 months | 2 years`
- Observability: `basic logs | logs+metrics | full tracing+SLOs`
- Maintainability: `low | medium | high`
- Portability: `cloud-locked | portable`

## Testing Strategy (REQUIRED)

> Testing is a first-class requirement. This section MUST be completed before proceeding to Inception.

### Test Coverage Requirements

- **Minimum coverage threshold**: `60% | 70% | 80% | 90%` (default: 80% for production systems)
- **Coverage measurement**: `Line | Branch | Both` (recommended: Both)
- **Critical path coverage**: `100%` (non-negotiable for core business logic)

### Test Levels Required

| Level | Required | Target Coverage | Automation |
|-------|----------|-----------------|------------|
| Unit tests | `Yes/No` | `__%` | `Manual | Automated | CI-gated` |
| Integration tests | `Yes/No` | `__%` | `Manual | Automated | CI-gated` |
| E2E/System tests | `Yes/No` | `__%` | `Manual | Automated | CI-gated` |
| Performance tests | `Yes/No` | `Baseline defined` | `Manual | Automated | CI-gated` |
| Security tests | `Yes/No` | `OWASP Top 10` | `Manual | Automated | CI-gated` |
| Accessibility tests | `Yes/No` | `WCAG level` | `Manual | Automated | CI-gated` |

### Test Automation Strategy

- **CI/CD integration**: `None | Tests run on PR | Tests block merge | Full pipeline`
- **Test environment**: `Local only | Shared dev | Dedicated test | Production-like`
- **Test data strategy**: `Fixtures | Factories | Snapshots | Production subset`

### Test Maturity Profile

Select the testing regime appropriate for project phase:

- [ ] **Prototype/Spike**: Minimal testing (manual verification acceptable, <40% coverage)
- [ ] **MVP**: Basic automation (unit tests required, 40-60% coverage, manual E2E)
- [ ] **Production**: Full automation (all levels automated, 80%+ coverage, CI-gated)
- [ ] **Enterprise**: Comprehensive (90%+ coverage, security/perf gates, audit trail)

### Existing Test Assessment (Brownfield Only)

> Complete this section if integrating with or enhancing existing codebase.

- Current test coverage: `__%`
- Test suite health: `Healthy | Flaky | Broken | None`
- Test debt assessment: `Low | Medium | High | Critical`
- Untested critical paths: `list or "None identified"`
- Test improvement roadmap required: `Yes/No`
- Target coverage by iteration: `Iteration N: __%, Iteration M: __%`

## Data

- Classification: `Public | Internal | Confidential | Restricted`
- PII/PHI present: `yes/no`
- Retention/deletion constraints: `notes`

## Integrations

- External systems/APIs: `list`
- Dependencies and contracts: `list`

## Architecture Preferences (if any)

- Style: `Monolith | Modular | Microservices | Event-driven`
- Cloud/infra: `vendor/regions`
- Languages/frameworks: `list`

## Risk and Trade-offs

- Risk tolerance: `Low | Medium | High`
- Priorities (weights sum 1.0):
  - Delivery speed: `0.0–1.0`
  - Cost efficiency: `0.0–1.0`
  - Quality/security: `0.0–1.0`
- Known risks/unknowns: `bullets`

## Release & Rollout

- Deploy cadence / trunk-based unfinished work: `notes`
- Production blast radius / risk tolerance: `notes / Low | Medium | High`
- Progressive rollout / experiments needed: `yes/no; reason`
- Migration risk / external dependency kill switch / entitlement gating: `notes`
- LLM prompt/model runtime control needed: `yes/no`
- Existing flag tool: `none | OpenFeature | vendor/addon-id`
- Flag-fit outcome and reason: `recommend | offer | skip; reason`
- Scope decision: `accepted | declined | pending; project/story/REQ scope`
- Flag cards / ADR / removal tasks: `links or not applicable`

Apply `feature-flag-fit`; declines suppress further suggestions for the scope.
Flags are optional advice, never an intake gate. [AIWG guidance]
See `$AIWG_ROOT/docs/frameworks/sdlc-complete/feature-flags.md`.

## Team & Operations

- Team size/skills: `notes`
- Operational support (on-call, SRE): `notes`

## Decision Heuristics (quick reference)

- Prefer simplicity vs power: `S/P`
- Prefer managed services vs control: `M/C`
- Prefer time-to-market vs robustness: `T/R`

## Attachments

- Solution profile: link to `solution-profile-template.md`
- Option matrix: link to `option-matrix-template.md`

## Kickoff Prompt (copy into orchestrator)

```text
Role: Executive Orchestrator
Goal: Initialize project from intake and start Concept → Inception flow
Inputs:
- Project Intake Form (this file)
- Solution Profile
- Option Matrix
Actions:
- Validate scope and NFRs; identify risks and needed spikes
- Select agents for Concept → Inception
- Produce phase plan and decision checkpoints
Output:
- phase-plan-inception.md
- risk-list.md
- initial ADRs for critical choices
```
