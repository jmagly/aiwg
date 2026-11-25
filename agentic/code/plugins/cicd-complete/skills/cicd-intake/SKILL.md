---
name: cicd-intake
namespace: aiwg
platforms: [all]
description: Capture user-project CI/CD goals, ownership, provider constraints and lifecycle scope before assessment or design.
triggers:
  - "cicd-intake"
  - "start CI/CD intake"
  - "capture pipeline delivery goals"
---

# CI/CD Intake

## Bound rules

Before work, load and obey each rule below with `aiwg show rule <name> --body`.
If discovery is unavailable, read its canonical source. Stop if a required rule
cannot be loaded. These are mandatory operating instructions; rule-side
`bound_to` metadata is maintained by the rule owner, not by this component.

- `human-authorization` — `@$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/human-authorization.md`
- `dev-secret-hygiene` — `@$AIWG_ROOT/agentic/code/extensions/dev/rules/dev-secret-hygiene.md`
- `dev-pipeline-safety` — `@$AIWG_ROOT/agentic/code/extensions/dev/rules/dev-pipeline-safety.md`

## Process

1. Identify the user's repository, delivery owner, runtime/build/test commands,
   current forge/runner setup and target environments. Separate observed facts
   from assumptions; do not import AIWG repository CI policies.
2. Capture delivery frequency, required checks, trust boundaries, artifact
   retention, release destinations, rollback objectives and approval owners.
   Record secrets by reference and owner only.
3. Establish the assess → design → implement → operate scope and success
   measures, including coverage floor and build-time budget requirements.
4. If progressive delivery is requested, apply the feature-flag boundary below;
   capture provider and existing flag-card references without changing config.
5. Present unanswered questions and agreed inputs. Hand off to `ci-assess`
   or `ci-architect` / `ci-pipeline-design`; do not bootstrap CI during intake.

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

- `cicd-intake-template`

Repository and owner; observed baseline; desired outcomes; environments; trust boundaries; provider/flag dependencies; approval owners; open questions; next lifecycle step.

## Example

“Start CI/CD intake for my Python service on GitLab” yields an intake draft with runtime, runner and delivery constraints plus questions about release protections. No workflow is installed.

## Artifact handling

Before writing project artifacts, run `aiwg artifacts path --json --check-write`.
Resolve logical `.aiwg/frameworks/cicd-complete/` beneath the returned artifact
root; stop if unavailable. Keep drafts and reports there. Never write literal
secrets or raw credential-bearing logs. Resolve templates by name with discovery;
if a template or capability is absent, record the prerequisite and pending work.
Do not claim execution from schema validation or a proposed procedure.
