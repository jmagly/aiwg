---
name: ci-builder
namespace: aiwg
platforms: [all]
description: Adapt the ops dev-ci-builder self-contained builder pattern for a user project, with reviewed previews and authorized CI integration.
triggers:
  - "ci-builder"
  - "create a self-contained CI builder"
  - "plan my project builder image"
---

# CI Builder

## Bound rules

Before work, load and obey each rule below with `aiwg show rule <name> --body`.
If discovery is unavailable, read its canonical source. Stop if a required rule
cannot be loaded. These are mandatory operating instructions; rule-side
`bound_to` metadata is maintained by the rule owner, not by this component.

- `human-authorization` — `@$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/human-authorization.md`
- `dev-ci-self-contained` — `@$AIWG_ROOT/agentic/code/extensions/dev/rules/dev-ci-self-contained.md`
- `dev-idempotent-builds` — `@$AIWG_ROOT/agentic/code/extensions/dev/rules/dev-idempotent-builds.md`
- `dev-pipeline-safety` — `@$AIWG_ROOT/agentic/code/extensions/dev/rules/dev-pipeline-safety.md`
- `dev-secret-hygiene` — `@$AIWG_ROOT/agentic/code/extensions/dev/rules/dev-secret-hygiene.md`
- `ci-action-pinning` — `@$AIWG_ROOT/agentic/code/frameworks/security-engineering/rules/ci-action-pinning.md`

## Process

1. Load and follow the existing ops dev extension's `dev-ci-builder` guidance:
   `@$AIWG_ROOT/agentic/code/extensions/dev/skills/dev-ci-builder.md`.
   Adapt its pattern by reference; do not copy the upstream skill or rule and
   do not automatically execute its registry/push/end-to-end steps.
2. Inventory runtime, compiler, lint/test tools, system dependencies and locks.
   Define a project-owned `ci/Dockerfile.builder` preview with pinned base
   image digest and versioned/checksummed tools, plus a separate update path.
3. Follow `dev-ci-self-contained`: build/test tools reside in the builder;
   runtime CI must not clone an external repository for tooling or install
   ad hoc dependencies. Separate explicitly network-dependent integration tests.
4. Present builder diff, local validation commands and repeat-build digest
   comparison. Require explicit authorization before writing project builder
   or CI files, executing builds or using registry credentials.
5. After approval, test tool availability and the project's actual suite in
   the builder, with build/test network isolation. Record both outcomes and
   artifact digests; failure blocks adoption. Use `docker-build`, `image-scan`,
   `ci-sbom` and `ci-sign` according to project policy through existing drivers.
6. Obtain separate registry/publish approval for `docker-push`. Only adopt the
   verified immutable image through an authorized `ci-render` diff, retaining
   `ci-action-pinning` pin-manifest updates and the previous builder rollback.

## Authorization checkpoint

Prepare the concrete proposed diff, affected paths, validation plan and rollback
before applying anything. Require explicit user authorization covering those CI
files before writing, replacing or deleting project workflows, builder files or
CI scripts. A design, review finding or generated preview grants no permission.
Record the approved scope; stop at its boundary. Execution, registry pushes,
trigger changes and live delivery require their own explicit authorization.

## Output template

Resolve the #4423 templates by these names:

- `ci-environment-plan-template`
- `ci-pipeline-runbook-template`

Upstream guidance reference; dependency inventory; builder preview; approved file scope; isolated test and repeat-build evidence; image digest; registry approval status; update and rollback procedure.

## Example

“Create a self-contained CI builder for my Rust app” adapts dev-ci-builder into a reviewed project builder preview; workflow installation and registry publishing each wait for scoped authorization.

## Artifact handling

Before writing project artifacts, run `aiwg artifacts path --json --check-write`.
Resolve logical `.aiwg/frameworks/cicd-complete/` beneath the returned artifact
root; stop if unavailable. Keep drafts and reports there. Never write literal
secrets or raw credential-bearing logs. Resolve templates by name with discovery;
if a template or capability is absent, record the prerequisite and pending work.
Do not claim execution from schema validation or a proposed procedure.
