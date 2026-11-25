---
name: ci-release-coordinate
namespace: aiwg
platforms: [all]
description: Coordinate user-project tag, publish and progressive delivery with exact artifact identity, scoped approvals, health gates and rollback.
triggers:
  - "ci-release-coordinate"
  - "coordinate my pipeline release"
  - "plan approved progressive rollout"
---

# CI Release Coordination

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

1. With `ci-release-engineer`, load the user's release policy, version scheme,
   source revision, reviewed specs, destination registry and environment plan.
   Do not apply AIWG's own release tooling or versioning to the user's project.
2. Verify required check results and exact artifact digest with `ci-sbom`,
   `ci-sign`, provenance and `ci-artifact-upload` receipts. Resolve trusted
   signer/builder identity and protected-branch/environment requirements.
3. Draft a runbook with ordered tag creation/push, publication, promotion and
   rollback steps, responsible owners and idempotency/recovery behavior.
   Present exact destinations and irreversible effects for explicit approval;
   one approval must not silently cover other environments or registry targets.
4. For flag-aware delivery, use `flag-check` and `flag-states-test` with the
   provider routing below. `flag-coderefs-scan` informs readiness;
   `flag-cleanup-handoff` routes future lifecycle work to sdlc. Neither changes
   flags. Provider `none` requires a manual approval step at each dependent gate.
5. After scoped authorization, coordinate `ci-deploy-handoff` and execute
   `progressive-rollout` through the existing OpsCapability driver; do not
   build a new engine. Enforce step pauses/observation windows and
   `aiwg:cicd-complete/progressive-rollout-health`. Stop on unhealthy or unknown state;
   perform only a previously authorized rollback. If execution requires a
   flag mutation, stop and hand off instead of performing it.
6. Record tag/publish identities and per-step receipts, verify destination
   digest and health, and report completed versus pending operations. On failure
   retain the failed signal and use the incident template; never rerun to green.

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

- `ci-pipeline-runbook-template`
- `ci-pipeline-incident-template`

Release identity and policy; readiness evidence; tag/publish/promotion approval ledger; capability and gate receipts; observed health; destination digest verification; rollback results; lifecycle handoffs.

## Example

“Coordinate my pipeline release to staging” produces an approval-ready runbook. After scoped approval it coordinates only staging promotion; publication and production require their own explicit approval.

## Artifact handling

Before writing project artifacts, run `aiwg artifacts path --json --check-write`.
Resolve logical `.aiwg/frameworks/cicd-complete/` beneath the returned artifact
root; stop if unavailable. Keep drafts and reports there. Never write literal
secrets or raw credential-bearing logs. Resolve templates by name with discovery;
if a template or capability is absent, record the prerequisite and pending work.
Do not claim execution from schema validation or a proposed procedure.
