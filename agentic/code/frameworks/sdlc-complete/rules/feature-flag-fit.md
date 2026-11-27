---
name: feature-flag-fit
enforcement: medium
activation: summary
summary: "Advise recommend, offer or skip for feature flags at intake, architecture, iteration planning and deployment; honor declines and never-flag cases. Never a gate."
bound_to:
  skills: [intake-start, intake-wizard, intake-from-codebase, architecture-evolution, flow-architecture-evolution, flow-elaboration-to-construction, flow-iteration-dual-track, flow-construction-to-transition, feature-flag-plan]
  flows: [flow-concept-to-inception, flow-architecture-evolution, flow-elaboration-to-construction, flow-construction-to-transition]
triggers:
  - plan feature flags
  - should this be behind a flag
  - assess feature flag fit
---

# Feature Flag Fit

**Enforcement Level**: MEDIUM

## When to apply

At intake, architecture / iteration planning, and deployment-strategy selection,
read `feature_flags` from the solution profile and the existing scope decision.
Record outcome and reason in intake or an ADR. This assessment is advice, never
an acceptance gate. Flags remain optional. [AIWG-J: AIWG guidance]

## Decision order

1. Honor a recorded project or scope decline; do not suggest again for that scope.
   `policy: never` skips silently. `suggest` is the default; `always` requests
   planning for eligible work, without overriding a decline or never-flag case.
   A user may explicitly reopen a decision. [AIWG-J: AIWG guidance]
2. Apply the never-flag exclusions, then the silent skips below.
3. Recommend if any recommend trigger applies. Otherwise offer for the specified
   low-risk user-facing case, or skip. [AIWG-J: AIWG guidance]
4. On recommend, invoke `feature-flag-plan` to record accept/decline and, if
   accepted, create cards. An offer is one line, default no; no cards until accepted.
   Skip creates no user-facing suggestion; retain an internal reason. [AIWG-J]

## Recommend

- Production change with real blast radius and Low risk tolerance. [AIWG-J]
- Trunk-based delivery merging unfinished work, or a multi-iteration feature
  shipping dark: release flags ([Hodgson](https://martinfowler.com/articles/feature-toggles.html)).
- Data/service migration, experiment or metric-driven decision, or permission
  (entitlement) gating ([flag kinds](https://launchdarkly.com/docs/guides/flags/creating-flags.md),
  [migration](https://launchdarkly.com/docs/guides/flags/migrations.md), [Hodgson](https://martinfowler.com/articles/feature-toggles.html)).
- External dependency needing a kill switch
  ([kill switches](https://launchdarkly.com/docs/home/flags/killswitch.md)).
- LLM prompt/model changes needing runtime control. [AIWG-J: AIWG guidance]

## Offer

One line, default no: user-facing change, low risk and infrequent deployments.
Record acceptance or decline for the scope. [AIWG-J: AIWG guidance]

## Skip silently

- Prototypes, spikes, docs-only changes, libraries without runtime configuration,
  or one-off scripts. [AIWG-J: AIWG guidance]
- Static site with no runtime **and no client-side JavaScript**; client JS may
  qualify ([static sites](https://launchdarkly.com/docs/guides/flags/static-sites.md)).
- Very small changes whose flag upkeep outweighs their value
  ([technical debt](https://launchdarkly.com/docs/guides/flags/technical-debt.md)).
- Existing project/scope decline or `policy: never`. [AIWG-J]

## Never-flag cases

Never use a flag for secrets or targeting on credentials; static or rarely
changing configuration; a data store; startup-blocking configuration; or one
flag per commit or sprint ([technical debt](https://launchdarkly.com/docs/guides/flags/technical-debt.md)).
Deploy-time configuration belongs in environment variables ([12-Factor](https://12factor.net/config)).
Static release toggles may remain in source/config if no runtime change is
needed ([Hodgson: prefer static configuration](https://martinfowler.com/articles/feature-toggles.html)); do not turn
ordinary static settings into provider-managed flags.

## Planning contract

Use OpenFeature terms: provider, evaluation context, default value and hooks
([concepts](https://openfeature.dev/docs/reference/concepts)). Choose kind
separately from value type. Use the existing feature-toggle card; link REQ/story
IDs and a removal task created with the flag ([Hodgson](https://martinfowler.com/articles/feature-toggles.html)).
Provider routing and no-addon behavior: `$AIWG_ROOT/docs/frameworks/sdlc-complete/feature-flags.md`.
The helper in `feature-flag-plan/scripts/flag-plan.mjs` makes classified inputs
repeatable; the agent must classify facts from the work, not invent them. [AIWG-J]
