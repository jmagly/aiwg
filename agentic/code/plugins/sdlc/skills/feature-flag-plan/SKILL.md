---
namespace: aiwg
name: feature-flag-plan
platforms: [all]
description: Plan feature flags for a feature or story, assess fit, record accept or decline, and create requirement-linked feature toggle cards with removal tasks.
triggers:
  - plan feature flags
  - should this be behind a flag
  - create a feature flag plan
  - review feature flag debt
requires: [sdlc-complete]
---

# Feature Flag Plan

## Process

1. Read intake, solution profile, feature/story/REQ IDs, architecture, deployment
   strategy and existing decisions. Fetch `aiwg show rule feature-flag-fit --body`.
2. Apply that rule at intake, architecture / iteration planning and deployment.
   Record outcome, reason and scoped accept/decline in intake or ADR. Skip silently
   for excluded work or a prior decline. Offer once, default no. A recommend result
   invokes planning, but does not imply acceptance or permission to change production.
3. On acceptance, fill the existing
   `$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/deployment/feature-toggle-card.md`
   for each flag and link REQ/story IDs. Select kind separately from value type,
   dynamism and lifetime. Create a removal task with the flag ([Hodgson](https://martinfowler.com/articles/feature-toggles.html)).
   Confirm actual owner, safe default/rationale, rollout metrics, rollback procedure,
   test plan and removal criteria; unknowns remain explicit, never invented.
4. Use one decision point and deliberate defaults; plan current production,
   upcoming and default/fallback tests, optionally all-on
   ([testing](https://launchdarkly.com/docs/guides/flags/testing-code.md), [OpenFeature](https://openfeature.dev/docs/reference/concepts/evaluation-api)).
5. Resolve artifacts with `aiwg artifacts path --json --check-write`; put cards
   beneath `.aiwg/deployment/` and link decisions from intake/ADR. Read these
   cards at transition and retrospective; do not require a vendor connection.
6. For creation, rollout and debt/cleanup, consult the provider seam in
   `$AIWG_ROOT/docs/frameworks/sdlc-complete/feature-flags.md`. `none` is a no-op: cards and code guidance
   only. `openfeature` uses the neutral client. Discover installed addon skills
   before calling them; missing addon/capability falls back to cards and guidance.
   Routing does not grant production-write authority. [AIWG guidance]

## Repeatable local checks

Use the adjacent `scripts/flag-plan.mjs` with Node: `plan <input.json>`,
`debt <input.json>` or `readiness <input.json>`. It reads local JSON and card
frontmatter and prints JSON; it never contacts a vendor or writes artifacts.
The agent classifies inputs under `feature-flag-fit` before calling the helper.

`plan` input: `scope`, `requirements`, `feature_flags`, `facts` (booleans for
`production`, `blast_radius`, `low_risk_tolerance`, `trunk_unfinished`, `dark_launch`,
`migration`, `experiment`, `entitlement`, `external_kill_switch`, `llm_runtime`,
`user_facing`, `low_risk`, `infrequent_deploy`, `prototype`, `spike`, `docs_only`,
`library_no_runtime`, `one_off_script`, `static_no_runtime_no_js`, `very_small`),
optional `never_flags` (secrets, static_config, data_store, startup_config,
per_commit), `declined`, and `decision` (accepted/declined/pending).
On acceptance supply `cards` with all template frontmatter fields and body
sections `targeting_rollout`, `metrics_rollback`, `test_plan`. Output contains the
recorded decision and rendered cards; missing fields fail with actionable errors.

`debt`/`readiness` input: `cards` (local Markdown paths). Debt also takes `as_of`
(YYYY-MM-DD) and optional `temporary_flag_caps` mapping service names to counts.
Debt reports temporary cards past criteria or review-by, live counts versus caps,
and missing metadata. Criteria evidence stays in the card. Readiness fails live
cards missing an owner or removal criteria. [AIWG guidance]

## Examples

- High-risk production story, Low tolerance → recommend; accepted → linked cards
  and removal tasks. Provider none → code guidance only.
- Docs-only change → skip, no suggestion or cards. Prior decline → no repeat offer.
- Temporary card meets criteria or passes review-by → debt row; a permanent
  entitlement flag stays out of the temporary debt list.

All helper decisions are AIWG guidance; the rule and card cite their design basis.
