# Plan feature flags with SDLC

Start with a prompt:

> Should this be behind a flag? The payment change has production blast radius,
> Low risk tolerance, and spans two iterations. Link it to REQ-PAY-12 and US-PAY-9.

AIWG applies `feature-flag-fit`, records recommend/offer/skip and its reason in
intake or an ADR, then records your scoped acceptance or decline. An accepted plan
uses the existing feature-toggle card. A decline suppresses repeat suggestions for
that scope. Flags are optional advice, never an SDLC gate. [AIWG guidance]

> Plan feature flags for this story using provider none. Include safe defaults,
> cohorts, rollback metrics, tests and the removal task.

Each card separates flag kind (release, kill-switch, experiment, migration,
operational, permission/entitlement) from value type, dynamism and lifetime
([Hodgson](https://martinfowler.com/articles/feature-toggles.html),
[flag kinds](https://launchdarkly.com/docs/guides/flags/creating-flags.md),
[value types](https://launchdarkly.com/docs/home/flags/types.md)). Record an
accountable owner, deliberate default and rationale, targeting/rollout,
metrics/rollback, test plan, removal criteria and a removal task created with the
flag. Criteria remain primary; a review-by date is optional. [AIWG guidance]
Removal tasks, inventory caps and expiration reviews are described by
[Hodgson](https://martinfowler.com/articles/feature-toggles.html) and
[Unleash](https://docs.getunleash.io/guides/feature-flag-best-practices.md).

> Review my docs-only change for flag fit.

Docs, prototypes, scripts and libraries without runtime config skip silently.
A static site skips only if it has neither runtime nor client JavaScript.
Small changes may not justify upkeep. Never use flags as secrets, credential
selectors, static config stores, data stores, startup-blocking config, or a flag
per commit/sprint. The software-specific skips are AIWG guidance; see
[technical debt](https://launchdarkly.com/docs/guides/flags/technical-debt.md) and
[static sites](https://launchdarkly.com/docs/guides/flags/static-sites.md) for the
sourced exclusions. [AIWG guidance]

> Show the tests for current production, upcoming and default/fallback behavior.

That set is required when flags are used; all-on is optional. Every combination
is unnecessary. Flag off equals current behavior is a convention, so document
exceptions and the safe default
([testing](https://launchdarkly.com/docs/guides/flags/testing-code.md),
[Hodgson](https://martinfowler.com/articles/feature-toggles.html)).

> Review temporary flag debt from our cards, including review dates, removal
> criteria and a cap of five live temporary flags in the payments service.

Retrospective and transition review work without a vendor tool. They list cards
past criteria or review-by, the owner/removal task and counts versus any service
cap. Missing metadata is reported. Local labels are "ready for code removal" and
"ready to archive" after code removal verification. An overdue review date alone
requires review and does not establish removal eligibility. These labels do not assert a
vendor status. LaunchDarkly has its own eligibility rules
([flag lifecycle](https://launchdarkly.com/docs/home/flags/flag-status.md)).
[AIWG guidance]

## Solution-profile contract and provider seam

This is an AIWG integration contract, shared with cicd-complete. [AIWG guidance]

```yaml
feature_flags:
  provider: none
  policy: suggest
# Optional AIWG card-inventory control, not a provider setting:
temporary_flag_caps:
  payments: 5
```

Keep field names and values exact: `provider: none|openfeature|<addon-id>` and
`policy: suggest|always|never`. Default is `none` / `suggest`. `always` requests
planning for eligible work; it does not override a recorded decline, a silent
skip or never-flag exclusion. `never` suppresses suggestions. Explicitly reopen a
declined scope to reconsider it. [AIWG guidance]

| Provider | Planning (A4) | Release (A7) | Debt (A8) |
|---|---|---|---|
| `none` | Cards and code guidance | Local rollout/rollback plan | Read cards |
| `openfeature` | Cards and neutral client guidance | Local plan; no vendor management assumed | Read cards |
| Installed addon ID | Discover creation skill | Discover rollout skill | Discover cleanup/audit skill |
| Missing addon or capability | Cards and code guidance | Local plan | Read cards |

Addon authors register their skills in their own manifest with discoverable
provider-specific descriptions/triggers for creation, rollout and cleanup/audit.
At each A4/A7/A8 step, verify the addon is installed, discover the relevant skill,
fetch its body, and pass linked card/REQ/story IDs, evaluation context, default
value and environment. Do not guess skill names or equate an SDK provider with a
management API. A future addon may map creation to a name such as `ld-flag-create`;
Part A ships no such implementation or vendor dependency. [AIWG guidance]

The optional helper's `installed_addons` and `provider_capabilities` inputs are
resolved by the agent from installed metadata, for example a map of addon IDs to
`create`, `rollout`, `cleanup` skill names. The helper reports a route and never
executes those skills. Missing capabilities retain local outputs. Routing grants
no production-write authority; obtain the approval required by the selected
provider workflow before any production change. [AIWG guidance]

Use OpenFeature terms: provider, evaluation context, default value and hooks
([concepts](https://openfeature.dev/docs/reference/concepts)). Deploy-time config
stays in environment variables ([12-Factor](https://12factor.net/config)); decisions
that must change at runtime/per request use a provider. Static release toggles
may remain in source/config when runtime changes are unnecessary
([Hodgson](https://martinfowler.com/articles/feature-toggles.html),
[Unleash](https://docs.getunleash.io/guides/feature-flag-best-practices.md)).

## Discover and verify locally

```bash
aiwg discover "plan feature flags"
aiwg discover "should this be behind a flag"
aiwg show skill feature-flag-plan --body
aiwg show rule feature-flag-fit --body
```

`feature-flag-plan/scripts/flag-plan.mjs` offers deterministic `plan`, `readiness`
and `debt` checks on classified JSON inputs. It prints JSON and performs no vendor
calls or writes. Card frontmatter is the shared input to readiness/debt; populate
it from the accepted card and verify `removal_criteria_met` with linked evidence.
Use `node <skill-directory>/scripts/flag-plan.mjs <mode> <input.json>`; the skill
body documents fields. Readiness fails live cards missing owner/removal criteria;
no flags is not applicable. [AIWG guidance]
