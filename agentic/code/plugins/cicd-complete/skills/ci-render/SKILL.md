---
name: ci-render
namespace: aiwg
platforms: [all]
description: Render reviewed pipeline and environment specs through installed provider-extension templates, preview the diff and authorize workflow installation.
triggers:
  - "ci-render"
  - "render my CI pipeline"
  - "generate workflows from CI specs"
---

# CI Render

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

1. Load reviewed specs with `ci-renderer`; validate schemas, references, cycles,
   capability inputs and gate parameters. Resolve provider targets explicitly.
2. Locate the installed provider WorkflowExtension extending `cicd-complete`
   and its rendering templates. Record identity/version and compatibility.
   Extensions arrive in #4428: if missing, report the prerequisite and stop.
   Do not fabricate templates or claim a working render from a design alone.
3. Render through those templates into an artifact preview, never directly into
   live workflow paths. Record input/template/output digests, versions, exact
   target mapping and repeat-render determinism.
4. Compare against current workflow files; preserve manual edits as findings.
   Validate preview syntax and provider semantics using available extension
   validators. Flag trust, secret, pinning or unsupported mapping failures.
5. Present the concrete diff, target paths and rollback copy for explicit user
   authorization. Only after that approval install the scoped files and run
   authorized validation. Pipeline dispatch is a separate approval boundary.
6. Record results and unresolved prerequisites. Hand read-only drift monitoring
   to `ci-drift-check`; do not schedule or run it without a user request.

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

Source/spec references; extension and template versions; deterministic render receipt; source/output mapping and digests; reviewed diff; validation; approval and installation status; rollback.

## Example

“Render my CI pipeline for GitHub Actions” yields a preview and scoped installation checkpoint when the provider extension is available, or a missing-template report until #4428 lands.

## Artifact handling

Before writing project artifacts, run `aiwg artifacts path --json --check-write`.
Resolve logical `.aiwg/frameworks/cicd-complete/` beneath the returned artifact
root; stop if unavailable. Keep drafts and reports there. Never write literal
secrets or raw credential-bearing logs. Resolve templates by name with discovery;
if a template or capability is absent, record the prerequisite and pending work.
Do not claim execution from schema validation or a proposed procedure.
