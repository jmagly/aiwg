---
name: ci-pipeline-audit
namespace: aiwg
platforms: [all]
description: Read-only CI control and supply-chain audit covering safety signals, secrets, immutable pins, SBOM, signing and provenance.
triggers:
  - "ci-pipeline-audit"
  - "audit my CI controls"
  - "review pipeline supply chain"
---

# CI Pipeline Audit

## Bound rules

Before work, load and obey each rule below with `aiwg show rule <name> --body`.
If discovery is unavailable, read its canonical source. Stop if a required rule
cannot be loaded. These are mandatory operating instructions; rule-side
`bound_to` metadata is maintained by the rule owner, not by this component.

- `human-authorization` — `@$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/human-authorization.md`
- `dev-pipeline-safety` — `@$AIWG_ROOT/agentic/code/extensions/dev/rules/dev-pipeline-safety.md`
- `dev-secret-hygiene` — `@$AIWG_ROOT/agentic/code/extensions/dev/rules/dev-secret-hygiene.md`
- `dev-idempotent-builds` — `@$AIWG_ROOT/agentic/code/extensions/dev/rules/dev-idempotent-builds.md`
- `dev-ci-self-contained` — `@$AIWG_ROOT/agentic/code/extensions/dev/rules/dev-ci-self-contained.md`
- `ci-action-pinning` — `@$AIWG_ROOT/agentic/code/frameworks/security-engineering/rules/ci-action-pinning.md`

## Process

1. Establish audit scope and inspect workflows/specs, builder definitions,
   redacted run evidence, pin manifest and artifact records read-only. Do not
   trigger workflows or download/execute untrusted project code for review.
2. Check required signals cannot be bypassed, secret access excludes untrusted
   execution, environment protections apply and dependencies are reproducible.
3. With `supply-chain-guard`, inspect full action SHA pins and version comments,
   versioned image digests, installer checksums and matching pin-manifest rows.
4. Trace `ci-sbom`, `ci-sign` and provenance to exact artifact/source digests,
   trusted builder/signer identities, policy verification and retention. Report
   unavailable verification as unknown, never as passed evidence.
5. Check coverage/build-time gates and progressive delivery health/rollback
   controls. If reading flag state, apply the feature-flag boundary below.
6. Produce severity-ranked findings with locations, evidence, impact and
   concrete recommendations. Report and stop for explicit user authorization
   before any change. Never update pins, permissions, gates or CI files as
   an audit side effect, even when remediation appears straightforward.

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

Audit scope; controls and evidence matrix; findings by severity with file/run references; unknown verification; remediation proposals; owner and approval pending.

## Example

“Audit my CI controls” reports a mutable container tag and missing provenance verification. The audit does not update a digest or disable publishing.

## Artifact handling

Before writing project artifacts, run `aiwg artifacts path --json --check-write`.
Resolve logical `.aiwg/frameworks/cicd-complete/` beneath the returned artifact
root; stop if unavailable. Keep drafts and reports there. Never write literal
secrets or raw credential-bearing logs. Resolve templates by name with discovery;
if a template or capability is absent, record the prerequisite and pending work.
Do not claim execution from schema validation or a proposed procedure.
