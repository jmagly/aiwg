---
name: ci-migrate
namespace: aiwg
platforms: [all]
description: Plan and stage a user-project CI provider migration with capability parity, explicit cutover approval and rollback.
triggers:
  - "ci-migrate"
  - "migrate my CI provider"
  - "move pipeline from Gitea to GitLab"
---

# CI Migration

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

1. Inventory source workflows, trigger semantics, required checks, protections,
   runners, caches, artifacts, secrets references and release destinations.
   Establish baseline run evidence and migration success criteria.
2. Map source behavior to CIPipeline/CIEnvironment and target capabilities.
   Document unsupported features, trust differences and manual decisions;
   secret references migrate, secret values never enter the report or spec.
3. Design parity for checks, artifact identities, coverage/build-time gates,
   progressive-rollout health and rollback. Apply the feature-flag boundary
   to existing flags; migration never changes flags or their provider config.
4. Use `ci-pipeline-design` and `ci-render` for reviewed target previews. Missing
   provider-extension templates (#4428) block rendering/cutover; do not handcraft
   replacement workflows or silently drop unsupported source controls.
5. Present staged file diff, trial plan, cutover ordering, duplicate-publish
   prevention and rollback. Require explicit authorization before any CI-file
   write, trial dispatch, source trigger disable or target trigger enable.
6. After scoped approval, validate parity in controlled trials with publication
   disabled unless separately authorized. Cut over only on reviewed evidence;
   preserve source configuration and record the approved rollback procedure.

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

- `ci-migration-report-template`
- `ci-pipeline-spec-template`
- `ci-environment-plan-template`

Source/target inventory; capability and gate parity matrix; gaps; rendered preview references; trial evidence; cutover approvals; duplicate-publish controls; rollback and acceptance status.

## Example

“Move pipeline from Gitea to GitLab” prepares a parity report and target preview; neither source triggers nor publication routing change until the concrete cutover is authorized.

## Artifact handling

Before writing project artifacts, run `aiwg artifacts path --json --check-write`.
Resolve logical `.aiwg/frameworks/cicd-complete/` beneath the returned artifact
root; stop if unavailable. Keep drafts and reports there. Never write literal
secrets or raw credential-bearing logs. Resolve templates by name with discovery;
if a template or capability is absent, record the prerequisite and pending work.
Do not claim execution from schema validation or a proposed procedure.
