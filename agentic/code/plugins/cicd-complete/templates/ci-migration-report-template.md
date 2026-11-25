---
name: ci-migration-report-template
description: Plan and verify provider A to B migration with behavioral parity, controlled cutover and rollback.
outputKind: ci-migration-report
aliases:
  - CI migration report
  - ci provider migration report
---

# CI provider migration report

## Scope and migration decision

Fill provider A → provider B/version, repositories, rationale, delivery owner,
release/environment approvers, source/spec revisions and intake/assessment links.
List exclusions, deadlines and numeric reliability/duration/cost goals.

## Behavioral parity matrix

Add a row for every workflow/event, dependency, runner/toolchain, permissions,
cache/artifact rule, secret binding, environment protection and rollout/gate behavior.
Link settings and rendered paths, report unsupported semantics explicitly and
assign each gap an owner/due date. Never treat similar YAML as proven parity.

| Behavior / acceptance check | Provider A reference | Provider B reference | Trial evidence / result | Gap / owner / due |
|---|---|---|---|---|
| [behavior and expected result] | [path/settings/revision] | [path/settings/revision] | [run ID, observed result] | [action or none] |

## Environments, capabilities and secret references

Link reviewed CIPipeline/CIEnvironment documents and each OpsCapability/GatePack
mapping. Record runner/network/protection differences and secret-store references
only, with access/rotation owners. Keep `feature_flags.provider` and SDLC flag cards
as references; vendor operations belong in the applicable addon.

## Controlled comparison and rule compliance

Record schema/provider validation commands/statuses and pinned renderer/output
digests. Compare A and B on the same source/artifact in isolated environments;
prevent duplicate publishing/deployment writes. Prove failed gates stop promotion
and rollback restores health. Record flakes/failures and causal regression tests;
never re-run to green. Review all five rules: `dev-pipeline-safety`,
`dev-secret-hygiene`, `dev-idempotent-builds`, `dev-ci-self-contained`,
`ci-action-pinning`. Link findings and fixes without copying rule text.

## Cutover and rollback coordination

Fill release window, freeze/trigger-disable order, single active publisher,
artifact identity, approval gates, dependent teams, operator/on-call handoff and
communication references. Define numeric stop criteria, provider A reactivation
procedure, rollback owner/objective and compatibility constraints. Link the user's
release procedure based on
Ops dev release runbook (`$AIWG_ROOT/agentic/code/extensions/dev/templates/release-runbook.md`).
Record actual cutover/rollback trial timestamps, outcomes and authority.

## Results and acceptance

Compare dated post-cutover failure/flake/duration/cost/queue metrics to A's baseline
and goals. Link spec/rendered/provider drift comparison. Fill residual gaps,
owners/dates, retention and provider A decommission criteria. Record reviewer,
date, revision and [design](../flows/gate-criteria-by-phase.md#design-gate)/
[implement](../flows/gate-criteria-by-phase.md#implement-gate) gate decisions;
defer cutover if blocking parity or recovery evidence is missing.
