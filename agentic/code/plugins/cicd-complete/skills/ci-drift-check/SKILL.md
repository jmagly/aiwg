---
name: ci-drift-check
namespace: aiwg
platforms: [all]
description: Read-only comparison of pipeline specs, provider-template versions and existing rendered workflows, reporting drift without repair.
triggers:
  - "ci-drift-check"
  - "check CI spec drift"
  - "compare CI specs with workflows"
---

# CI Drift Check

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

1. Load current specs, environment plans, render receipts, extension versions
   and existing workflow files read-only. Record observed digests and paths.
2. Validate contracts and resolve the original provider-template revision.
   If receipts or templates are missing, report unverifiable drift; never guess
   the original rendering inputs or invoke a replacement renderer.
3. Re-render only to an artifact preview through available extension templates.
   Compare canonical provider structures and raw content, separating semantic
   changes from formatting, manual edits and template-version changes.
4. Identify missing/extra generated files, source spec changes and invalid
   references. Map each finding to its source, expected/observed digest and
   delivery impact. Do not delete extra files or normalize existing workflows.
5. Return findings and a proposed reconciliation direction: update spec, render
   version or workflow. Report and stop for explicit authorization before any
   change; never call `ci-render` in apply mode as part of this analysis.

## Authorization checkpoint

Prepare the concrete proposed diff, affected paths, validation plan and rollback
before applying anything. Require explicit user authorization covering those CI
files before writing, replacing or deleting project workflows, builder files or
CI scripts. A design, review finding or generated preview grants no permission.
Record the approved scope; stop at its boundary. Execution, registry pushes,
trigger changes and live delivery require their own explicit authorization.

## Output template

Resolve the #4423 templates by these names:

- `ci-assessment-report-template`
- `ci-pipeline-runbook-template`

Input and template identities; comparison method; semantic/text drift findings; expected/observed mapping and digests; unknowns; proposed reconciliation; authorization pending.

## Example

“Check CI spec drift after a manual test-job edit” reports the modified job and conflicting source contract. It leaves both files intact and awaits an authorized reconciliation task.

## Artifact handling

Before writing project artifacts, run `aiwg artifacts path --json --check-write`.
Resolve logical `.aiwg/frameworks/cicd-complete/` beneath the returned artifact
root; stop if unavailable. Keep drafts and reports there. Never write literal
secrets or raw credential-bearing logs. Resolve templates by name with discovery;
if a template or capability is absent, record the prerequisite and pending work.
Do not claim execution from schema validation or a proposed procedure.
