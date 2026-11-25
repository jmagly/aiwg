# CI/CD gate criteria by phase

## Review process

These criteria govern the user's CI/CD lifecycle: assess → design → implement →
operate. They are review criteria, not executable FlowCapability YAML. Use existing
`flow.aiwg.io/v1` flows, `ops.aiwg.io/v1` capabilities and
`gates.aiwg.io/v1alpha1` GatePacks where automation is available.

For each checkbox record pass/fail/not applicable, evidence path/run ID plus
revision or digest, reviewer and date. Explain every not-applicable decision.
The delivery owner records go, conditional, or no-go with the required approvers.
Conditional decisions list owner, due date and re-review; unmet blocking safety or
promotion criteria remain no-go. Do not treat an unchecked item as a pass.

## Assess gate

Required approvers: delivery owner and repository/environment owners.
Evidence: [intake](../templates/cicd-intake-template.md) and
[assessment](../templates/ci-assessment-report-template.md).

- [ ] Each in-scope repository has forge/provider, current workflows, owners and
  deploy targets recorded; absent CI is explicitly recorded.
- [ ] Runner inventory, secret usage **references only**, environments and release
  cadence are complete; unknowns have collection owners and dates.
- [ ] Flake history, duration/cost and failure/queue baselines have a dated sample,
  source and numeric target; unavailable data has a collection plan.
- [ ] Gap review names `dev-pipeline-safety`, `dev-secret-hygiene`,
  `dev-idempotent-builds`, `dev-ci-self-contained` and `ci-action-pinning`; each gap
  has severity, owner and disposition.
- [ ] Progressive-delivery needs and existing SDLC flag-fit/card references plus
  `feature_flags.provider` are recorded without repeating SDLC intake.
- [ ] Scope, priorities and success measures have dated approval.

## Design gate

Required approvers: delivery, environment, security and release owners.
Evidence: [spec](../templates/ci-pipeline-spec-template.yaml),
[environment plan](../templates/ci-environment-plan-template.md) and, if needed,
[migration report](../templates/ci-migration-report-template.md).

- [ ] CIPipeline and every CIEnvironment validate against their canonical schemas;
  command, exit status and artifact revision are retained.
- [ ] Environment/capability/GatePack references resolve, inputs/parameters match
  their definitions and stage/job dependencies are acyclic.
- [ ] Trigger/protection mapping separates untrusted validation from privileged
  release paths and complies with all five named rules above.
- [ ] Progressive steps define allocation, metric source/threshold, observation
  window, blocking gate, stop action and rollback capability/owner.
- [ ] Provider/renderer support for every required behavior is evidenced; schema
  acceptance alone is not counted as support or an executed rollout.
- [ ] Environment access, secret references, protection reviews, artifact promotion,
  release coordination and rollback plan are approved.
- [ ] Provider A → B parity/cutover/rollback plan is reviewed, or migration is
  explicitly not applicable.

## Implement gate

Required approvers: delivery owner, trial operator and release/environment owners.
Evidence: [runbook](../templates/ci-pipeline-runbook-template.md), validated
rendered configuration and migration results when applicable.

- [ ] Spec digest, renderer/version, output paths/digests and provider validation
  result are retained for the same source revision.
- [ ] Controlled trial proves triggers, dependencies, isolated jobs, artifact
  identity and environment protection without unintended production writes.
- [ ] A failed progressive gate blocks promotion; rollback restores the recorded
  stable artifact and passes health verification within the planned objective.
- [ ] Spec/rendered semantics agree; every textual or provider-setting difference
  is explained and reviewed.
- [ ] Trial failures have causal fixes and regression tests; no re-run to green,
  skipped tests or weakened gates are used as acceptance evidence.
- [ ] Operators accept monitoring, incident routing, release coordination and the
  runbook; migration parity/cutover evidence is complete when applicable.

## Operate gate

Required approvers: operations/on-call and release owners; delivery owner accepts
the next improvement cycle. Repeat at the agreed interval and after incidents.
Evidence: current [runbook](../templates/ci-pipeline-runbook-template.md),
[incident reports](../templates/ci-pipeline-incident-template.md), refreshed
[assessment](../templates/ci-assessment-report-template.md).

- [ ] Dated reliability, flake, duration/cost and queue metrics are compared to
  targets, with owned corrective actions and dates for every missed target.
- [ ] Alert routing is tested; first-failure evidence and affected release/artifact
  identity are retained for incidents.
- [ ] Closed incidents, including flakes, include root cause, a regression test
  failing before/passing after repair and verification on the original path.
  Re-running to green never closes an incident or satisfies a gate.
- [ ] Pinned spec re-render and semantic comparison of files/provider settings
  have no unexplained drift; emergency edits are reconciled before promotion.
- [ ] Rollback rehearsal records artifact, duration and health evidence against
  the objective; release coordination records approvals, window and handoff.
- [ ] Remaining actions, updated runbook, reviewer decision and next review date
  are recorded; contract changes return to design and controlled implementation.
