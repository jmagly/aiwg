---
id: FT-example
kind: release
value_type: boolean
dynamism: static
lifetime: temporary
owner: "<name/team>"
service: "<service>"
live: false
default_value: false
default_rationale: "<why this value is safe on evaluation error>"
requirements: [REQ-example, US-example]
removal_criteria: "<observable criteria; primary cleanup trigger>"
removal_criteria_met: false
removal_task: "<task created when flag is created>"
review_by: null
code_removed: false
---

# Feature Toggle Card

## Decision and identity

- Name/key and scope: `key; service/environments`
- Accepted decision / intake or ADR: `link; reason`
- Flag kind: `release | kill-switch | experiment | migration | operational | permission (entitlement)`
- Value type: `boolean | string | number | JSON`
- Decision dynamism: `static | per-request`
- Lifetime: `temporary | permanent`; accountable owner: `name/team`
- Related: `REQ/story/release IDs`; created/updated: `YYYY-MM-DD`

Kind, longevity and dynamism inform design ([Hodgson](https://martinfowler.com/articles/feature-toggles.html));
[value types](https://launchdarkly.com/docs/home/flags/types.md).
The frontmatter mirrors these decisions for card-only readiness/debt review;
set `live` when serving, `removal_criteria_met` only with evidence. [AIWG guidance]

## Evaluation and safety

- Provider / evaluation location / decision point: `notes`
- Evaluation context / PII handling / hooks: `notes`
- Default value plus rationale: `value; why safe on error`
- Dependencies, guardrails and consistency boundary: `notes`

Use a deliberate default ([OpenFeature](https://openfeature.dev/docs/reference/concepts/evaluation-api)); evaluate
sensitive decisions server-side ([Unleash](https://docs.getunleash.io/guides/feature-flag-best-practices.md)).

## Targeting and rollout

- Environments, cohorts, rollout stages and advancement criteria: `plan`
- Metrics, thresholds and observation windows: `measures`
- Rollback-by-flag value, trigger, operator and verification: `procedure`
- Irreversible data effects / deployment rollback limits: `notes`

## Test plan

Required: current production state, upcoming state, and default/fallback path;
optional all-on. Record values, assertions, test IDs and evaluation context.
Every combination is unnecessary ([testing](https://launchdarkly.com/docs/guides/flags/testing-code.md),
[Hodgson](https://martinfowler.com/articles/feature-toggles.html)). Flag off equals current behavior is a convention,
not an invariant: document exceptions and the safe default.

## Removal and review

- Removal criteria and evidence: `criteria; link`
- Removal task created with flag: `task ID/link` ([Hodgson](https://martinfowler.com/articles/feature-toggles.html))
- Optional review-by date: `YYYY-MM-DD or null`; criteria remain primary. [AIWG guidance]
- Code removal verification / archive follow-up: `evidence; owner`
- Permanent flag: `justify ongoing purpose; periodic review; retirement task`

Expiration reviews and optional limits on live temporary flags are supported by
[Hodgson](https://martinfowler.com/articles/feature-toggles.html) and [Unleash](https://docs.getunleash.io/guides/feature-flag-best-practices.md).
See `$AIWG_ROOT/docs/frameworks/sdlc-complete/feature-flags.md` for provider routing and debt review.
