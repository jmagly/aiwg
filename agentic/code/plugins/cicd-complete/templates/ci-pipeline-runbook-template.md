---
name: ci-pipeline-runbook-template
description: Operate CI pipelines with trial evidence, drift checks, failure triage and coordinated releases.
outputKind: ci-pipeline-runbook
aliases:
  - CI pipeline runbook
  - ci pipeline operations runbook
---

# CI pipeline runbook

## Ownership and prerequisites

Fill pipeline/repository, operator/on-call, release/environment owners, escalation
contacts, required access references, artifact retention and last rehearsal date.
Link assessment, reviewed spec, CIEnvironment documents and gate decisions.

## Configuration and validation record

Record spec revision/digest, renderer/version/invocation, provider, generated file
paths/digests and actual provider-setting references. Fill schema/provider validation
commands, expected outputs, actual statuses, trial run IDs and redacted evidence.
Include a failed-gate trial proving blocked promotion and successful rollback.

## Operating procedures by reference

Link the user's completed procedures derived from these canonical sources, with
local adaptations and expected outcomes. Do not copy their command bodies here:

- Ops CI pipeline (`$AIWG_ROOT/agentic/code/frameworks/ops-complete/templates/ci-pipeline.yaml`): provider stage mapping.
- Ops dev pipeline (`$AIWG_ROOT/agentic/code/extensions/dev/templates/pipeline.md`): build/test/deploy commands and runner requirements.
- Ops dev release runbook (`$AIWG_ROOT/agentic/code/extensions/dev/templates/release-runbook.md`): release procedure and authorization gates.

Fill a procedure index: action, local procedure reference/revision, operator,
preconditions, expected result and stop/escalation condition. Review inherited
examples against `dev-pipeline-safety`, `dev-secret-hygiene`,
`dev-idempotent-builds`, `dev-ci-self-contained` and `ci-action-pinning`.

## Monitoring and failure triage

Fill dashboard/alert links, metric thresholds, observation windows and routing.
For a failure, retain the first failed run/revision and redacted logs, classify
build/test/security/runner/deploy/provider cause, assess affected releases and open
the [CI incident report](ci-pipeline-incident-template.md).
For flakes, capture seed/timing/isolation/dependencies, reproduce the cause and
add a regression test failing before/passing after repair. Never re-run to green,
skip tests or lower gates. Record the fix and verification of the original path.

## Spec, rendered file and provider drift

Fill comparison cadence/owner and the command to re-render the pinned spec into a
temporary directory. Record byte differences and semantic checks for triggers,
dependencies, permissions, secrets bindings, environment approvals and rollout gates.
Compare actual provider settings too. Link any reviewed spec/renderer correction,
new validation/trial results and reconciled emergency edits before promotion.

## Release coordination and rollback

Fill release ID, immutable artifact digest, dependent teams, environment window,
required approvals, release/on-call handoff and communication record references.
Link the release procedure and SDLC feature-toggle cards; consume
`feature_flags.provider` from project config when needed. Fill progressive step
thresholds, stop conditions, rollback capability, stable artifact, authority,
recovery objective and verification checks. Record measured rehearsal duration and
health results; do not advance a failed gate.

## Review and improvement

Compare dated failure/flake/duration/cost/queue metrics to the assessment targets.
Fill incidents/actions, owner/due dates, operator acceptance, last/next review and
the [implement](../flows/gate-criteria-by-phase.md#implement-gate) or recurring
[operate](../flows/gate-criteria-by-phase.md#operate-gate) decision with evidence.
