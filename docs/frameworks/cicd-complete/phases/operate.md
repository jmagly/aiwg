# Operate

## Purpose

Keep delivery reliable, explain failures and coordinate releases while keeping
pipeline specifications and rendered provider files aligned.

## Entry criteria

- [ ] Implement gate passed with spec/rendered revisions and trial evidence linked.
- [ ] Named operators have the runbook, dashboards, escalation path and access.
- [ ] Reliability targets, review interval and rollback authority are agreed.

## Activities

1. Monitor failure rate, flakes, duration/cost, queue time and delivery health
   against the assessment baseline over a dated observation window.
2. Triage failures by build, test, security, runner, deployment or provider cause.
   Preserve the first failing run, revision, redacted logs and environment context;
   assess release impact and stop promotion when blocking evidence is missing.
3. Root-cause flakes using controlled reproduction (seed, timing, isolation,
   dependencies and runner state). Add a regression test that fails before the
   repair and passes after it, then verify the original path. Never re-run to green,
   suppress failed attempts or weaken/skip tests to unblock a release. Diagnostic
   reproduction is evidence collection, not a replacement gate result.
4. Detect drift by re-rendering the pinned spec into a temporary location and
   comparing tracked output and actual provider settings. Compare trigger filters,
   privileges, gates, environments and artifact identity as well as bytes. Reconcile
   through a reviewed spec/renderer change and repeat validation; record emergency
   edits and back-port them before the next promotion.
5. Coordinate release owner, environment owner and on-call: record artifact digest,
   release window, dependencies, approvals, progressive gates, stop conditions,
   rollback decision and stakeholder update references. Read SDLC flag cards for
   flag-related rollout constraints; vendor operations stay in the relevant addon.
6. Rehearse rollback and review incidents. Feed new requirements into assess/design;
   repeat implement validation whenever spec, capabilities or rendering changes.

## Outputs (templates)

- [CI pipeline runbook](https://github.com/jmagly/aiwg/blob/main/agentic/code/frameworks/cicd-complete/templates/ci-pipeline-runbook-template.md): current
  procedures, release coordination, metrics and drift review.
- [CI pipeline incident](https://github.com/jmagly/aiwg/blob/main/agentic/code/frameworks/cicd-complete/templates/ci-pipeline-incident-template.md): triage,
  causal repair and regression evidence for every material failure.
- [CI assessment report](https://github.com/jmagly/aiwg/blob/main/agentic/code/frameworks/cicd-complete/templates/ci-assessment-report-template.md): refreshed
  baseline and improvement backlog for the next cycle.

## Exit gate: operational review (recurring)

Apply the [operate checklist](https://github.com/jmagly/aiwg/blob/main/agentic/code/frameworks/cicd-complete/flows/gate-criteria-by-phase.md#operate-gate).

- [ ] Dated metrics and alert checks meet targets or have owned corrective actions.
- [ ] Incident closures include causal repair and regression evidence, including flakes.
- [ ] No unexplained spec/rendered/provider drift remains before promotion.
- [ ] Rollback rehearsal, release handoff and next review have owners and evidence.

Record the review decision at the agreed cadence; operate continues after acceptance.
