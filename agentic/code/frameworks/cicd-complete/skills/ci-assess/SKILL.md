---
name: ci-assess
namespace: aiwg
platforms: [all]
description: Read-only assessment of current user-project pipelines, delivery risks, reliability baseline and prioritized improvements.
triggers:
  - "ci-assess"
  - "assess my CI pipeline"
  - "baseline pipeline reliability"
---

# CI Assessment

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

1. Load intake and inspect workflow files, runner/environment references,
   dependency locks, build scripts and existing redacted run evidence read-only.
2. Map triggers, stages, required checks, artifacts, cache boundaries, secrets,
   protections, release paths and rollback ownership. Distinguish missing data
   from a confirmed failing control.
3. Measure available failure/flake rates, build durations and coverage against
   agreed targets; record time range, sample size and data limitations.
4. Check supply-chain pins and evidence, gate bypasses, idempotency and flag-state
   dependencies. Route flag reads through the feature-flag boundary below.
5. Rank findings by impact, citing paths/run identities and proposing bounded
   improvements. Report and stop. Await explicit user authorization before any
   change, repair, run, cache invalidation or handoff that would apply a finding.

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

- `ci-assessment-report-template`

Scope and baseline; evidence window; stage/control inventory; severity-ranked findings with locations and impact; proposed changes; missing evidence; authorization pending.

## Example

“Assess my CI pipeline” returns a report identifying an unprotected publish path and a slow test stage; it does not edit either job or trigger a new run.

## Artifact handling

Before writing project artifacts, run `aiwg artifacts path --json --check-write`.
Resolve logical `.aiwg/frameworks/cicd-complete/` beneath the returned artifact
root; stop if unavailable. Keep drafts and reports there. Never write literal
secrets or raw credential-bearing logs. Resolve templates by name with discovery;
if a template or capability is absent, record the prerequisite and pending work.
Do not claim execution from schema validation or a proposed procedure.
