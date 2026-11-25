---
name: ci-pipeline-design
namespace: aiwg
platforms: [all]
description: Design and validate provider-neutral CIPipeline and CIEnvironment contracts with named capabilities, dependencies and gates.
triggers:
  - "ci-pipeline-design"
  - "design CI pipeline specs"
  - "plan CI environments and gates"
---

# CI Pipeline Design

## Bound rules

Before work, load and obey each rule below with `aiwg show rule <name> --body`.
If discovery is unavailable, read its canonical source. Stop if a required rule
cannot be loaded. These are mandatory operating instructions; rule-side
`bound_to` metadata is maintained by the rule owner, not by this component.

- `human-authorization` — `@$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/human-authorization.md`
- `dev-pipeline-safety` — `@$AIWG_ROOT/agentic/code/extensions/dev/rules/dev-pipeline-safety.md`
- `dev-secret-hygiene` — `@$AIWG_ROOT/agentic/code/extensions/dev/rules/dev-secret-hygiene.md`
- `dev-idempotent-builds` — `@$AIWG_ROOT/agentic/code/extensions/dev/rules/dev-idempotent-builds.md`
- `ci-action-pinning` — `@$AIWG_ROOT/agentic/code/frameworks/security-engineering/rules/ci-action-pinning.md`

## Process

1. Load intake and assessment, confirm desired behavior and compare provider
   targets `gitea-actions`, `github-actions` and `gitlab-ci` with `ci-architect`.
2. Draft `cicd.aiwg.io/v1` CIPipeline with `spec.triggers`, `environments`,
   `stages` and `render.targets`. Jobs require ids and capability names; use
   `depends_on` for stage/job order. Select `ci-checkout`, `ci-cache`,
   `ci-setup-runtime`, `ci-lint`, `ci-test`, `ci-coverage`, `ci-sbom`, `ci-sign`,
   `ci-artifact-upload` and `ci-deploy-handoff` as requirements warrant.
3. Plan container stages with `docker-build`, `image-scan` and `docker-push`.
   Separate untrusted tests from protected signing, push and deploy jobs.
   Draft CIEnvironment resources with runner labels, `{name, ref}` secrets,
   reviewer counts and branch restrictions. Never embed secret values.
4. Reference gates `aiwg:cicd-complete/coverage-floor`, `aiwg:cicd-complete/build-time-budget` and
   `aiwg:cicd-complete/progressive-rollout-health` after explicit stages. For rollout,
   plan canary, blue-green, rolling or flag steps with exactly one of `weight`
   or `percentage`, pauses, gates and rollback capability. Explicitly resolve
   omitted flag step capability to `progressive-rollout` in the consumer.
5. For flag-dependent jobs consider `flag-check`, `flag-states-test`,
   `flag-coderefs-scan` and `flag-cleanup-handoff`; apply the boundary below.
   Cleanup is a handoff, never permission to retire or remove flags.
6. Validate against `ci-pipeline.schema.json` and `ci-environment.schema.json`
   under `$AIWG_ROOT/agentic/code/frameworks/cicd-complete/schemas/`. Resolve
   capability/environment/gate references, validate inputs and reject missing
   dependencies and cycles. Schema defaults are annotations, not execution.
7. Present reviewable contracts, unresolved prerequisites and provider tradeoffs.
   After design acceptance, hand to `ci-render`; CI file installation still
   needs explicit authorization for the actual rendered diff.

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

- `ci-pipeline-spec-template`
- `ci-environment-plan-template`

CIPipeline and CIEnvironment drafts; provider rationale; reference/acyclicity validation; capability/gate availability; rollout and rollback plan; approval status.

## Example

“Design CI pipeline specs for my Go API” produces lint/test/build stages, protected signing and publishing, runner labels and coverage/build-time gates, ready for review before rendering.

## Artifact handling

Before writing project artifacts, run `aiwg artifacts path --json --check-write`.
Resolve logical `.aiwg/frameworks/cicd-complete/` beneath the returned artifact
root; stop if unavailable. Keep drafts and reports there. Never write literal
secrets or raw credential-bearing logs. Resolve templates by name with discovery;
if a template or capability is absent, record the prerequisite and pending work.
Do not claim execution from schema validation or a proposed procedure.
