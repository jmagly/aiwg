---
name: ci-failure-triage
namespace: aiwg
platforms: [all]
description: Diagnose a specific failed CI run, preserve its signal and propose a root-cause repair with regression verification.
triggers:
  - "ci-failure-triage"
  - "triage a failed CI job"
  - "explain my pipeline failure"
---

# CI Failure Triage

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

1. With `ci-doctor`, identify repository, revision, run/job/attempt, failed
   command, runner/runtime versions and redacted failure evidence. Preserve
   the original result and distinguish upstream cancellation from root failure.
2. Classify code/test defect, runner resource, dependency, cache, permissions,
   provider or environment failure. State the hypothesis and alternatives.
   Read flag state only through the feature-flag boundary when relevant.
3. Design a bounded diagnostic reproduction with inputs, expected signal,
   attempt limit and stop condition. Obtain authorization for side effects or
   CI dispatch. Never rerun to green or treat a lucky pass as a repair.
4. Present a causal fix and regression test that exposes the original failure.
   Request explicit scoped authorization before applying any fix, particularly
   CI-file changes. Do not skip, suppress or weaken the failed check.
5. After authorized repair, verify the regression before/after and relevant
   neighbors. Record evidence and remaining unknowns. For suspected flakiness,
   hand to `ci-flake-hunt`, carrying the original failing run and hypothesis.

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

Failure signature and immutable run identity; evidence; causal hypotheses; diagnostic plan/results; proposed patch; regression test; approval status; verification and unresolved risks.

## Example

“Triage a failed CI job at revision abc123” diagnoses an expired cache assumption, proposes a cache-key fix and regression test, and waits for approval before workflow changes.

## Artifact handling

Before writing project artifacts, run `aiwg artifacts path --json --check-write`.
Resolve logical `.aiwg/frameworks/cicd-complete/` beneath the returned artifact
root; stop if unavailable. Keep drafts and reports there. Never write literal
secrets or raw credential-bearing logs. Resolve templates by name with discovery;
if a template or capability is absent, record the prerequisite and pending work.
Do not claim execution from schema validation or a proposed procedure.
