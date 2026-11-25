---
name: ci-flake-hunt
namespace: aiwg
platforms: [all]
description: Find nondeterministic CI root causes using bounded experiments, preserved failures and regression tests rather than reruns to green.
triggers:
  - "ci-flake-hunt"
  - "hunt a flaky CI test"
  - "diagnose intermittent pipeline failure"
---

# CI Flake Hunt

## Bound rules

Before work, load and obey each rule below with `aiwg show rule <name> --body`.
If discovery is unavailable, read its canonical source. Stop if a required rule
cannot be loaded. These are mandatory operating instructions; rule-side
`bound_to` metadata is maintained by the rule owner, not by this component.

- `human-authorization` — `@$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/human-authorization.md`
- `dev-pipeline-safety` — `@$AIWG_ROOT/agentic/code/extensions/dev/rules/dev-pipeline-safety.md`
- `dev-secret-hygiene` — `@$AIWG_ROOT/agentic/code/extensions/dev/rules/dev-secret-hygiene.md`
- `dev-idempotent-builds` — `@$AIWG_ROOT/agentic/code/extensions/dev/rules/dev-idempotent-builds.md`

## Process

1. Preserve failing and passing run identities for the same revision with
   runner, seed, order, timezone, locale, concurrency and dependency versions.
   Record sample size and observed failure rate without overstating certainty.
2. Form testable hypotheses: races, shared mutable state, clock dependence,
   resource pressure, external network, stale cache or flag-state mismatch.
3. Agree a bounded local experiment matrix with a fixed attempt budget and
   stop condition. Record every outcome. Repetitions serve diagnosis only;
   never rerun to green, enable blanket retries or replace the original failure.
4. Isolate the cause and propose a deterministic fix plus a regression test
   exposing the original race/state defect. Do not skip/quarantine checks,
   weaken assertions, increase timeouts without causal evidence or suppress CI.
5. Obtain explicit authorization for fixes and any workflow change. After
   approved repair, verify regression failure before and success after, plus
   relevant neighbors and the bounded matrix. Retain contrary results; if no
   cause is proven, report partial diagnosis and the next bounded experiment.

## Authorization checkpoint

Prepare the concrete proposed diff, affected paths, validation plan and rollback
before applying anything. Require explicit user authorization covering those CI
files before writing, replacing or deleting project workflows, builder files or
CI scripts. A design, review finding or generated preview grants no permission.
Record the approved scope; stop at its boundary. Execution, registry pushes,
trigger changes and live delivery require their own explicit authorization.

## Feature-flag boundary

When flag state matters, read `feature_flags.provider` from project config.
For a configured provider, discover its skills and use its read-only state checks;
never infer a vendor from credentials or installed tools. With provider `none`,
produce a manual approval step for each flag-dependent gate. Missing or unknown
configuration is an unresolved prerequisite, never an implicit pass.
Never create, change, toggle, retire or delete flags, including through delegated
execution. Hand lifecycle decisions to sdlc-complete flag planning, referencing
`@$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/deployment/feature-toggle-card.md`.
Provider operations belong to the provider's skills; lifecycle handoff conveys
no authorization to mutate flags. Pipeline progression may use approved observed
flag state; flag mutations remain outside this component.

## Output template

Resolve the #4423 templates by these names:

- `ci-pipeline-incident-template`

Flake signature; all run/attempt ids; hypothesis and controlled variables; experiment budget and outcome matrix; root cause/confidence; proposed fix; regression evidence; authorization status.

## Example

“Hunt a flaky CI test that depends on test order” produces a seeded order experiment and a shared-state regression test. Passing one later run never proves the flake fixed.

## Artifact handling

Before writing project artifacts, run `aiwg artifacts path --json --check-write`.
Resolve logical `.aiwg/frameworks/cicd-complete/` beneath the returned artifact
root; stop if unavailable. Keep drafts and reports there. Never write literal
secrets or raw credential-bearing logs. Resolve templates by name with discovery;
if a template or capability is absent, record the prerequisite and pending work.
Do not claim execution from schema validation or a proposed procedure.
