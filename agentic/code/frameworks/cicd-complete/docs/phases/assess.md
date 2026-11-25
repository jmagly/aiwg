# Assess

## Purpose

Agree the scope and reliability baseline for the user's delivery system before
choosing a provider or changing workflows.

## Entry criteria

- [ ] A delivery owner and repository maintainers are named.
- [ ] Repository/workflow metadata and redacted run history are available, or
  missing access has an owner and a collection plan.
- [ ] The reason for change and affected services are identified.

## Activities

1. Complete intake: repositories, forge/provider, existing CI, deployment targets,
   environments, release cadence and progressive-delivery requirements.
2. Inventory workflow files, triggers, runners, capabilities, secret references
   and protection settings. Record unknowns explicitly; never collect secret values.
3. Measure a dated sample of run duration, cost, queue time and flake history.
   Keep failed attempts in the sample; a later success does not erase a failure.
4. Assess gaps against `dev-pipeline-safety`, `dev-secret-hygiene`,
   `dev-idempotent-builds`, `dev-ci-self-contained` and `ci-action-pinning`.
5. Read the existing SDLC flag-fit decision and feature-toggle card. Record the
   `feature_flags.provider` seam by reference; SDLC owns that decision.
6. Agree numeric improvement targets, risks, owners and design priorities.

## Outputs (templates)

- [CI/CD intake](../../templates/cicd-intake-template.md): agreed scope and references.
- [CI assessment report](../../templates/ci-assessment-report-template.md): inventory,
  measured baseline, rule gaps and prioritized actions.

## Exit gate: assessed baseline

Apply the [assess checklist](../../flows/gate-criteria-by-phase.md#assess-gate).
The delivery owner records a decision only when:

- [ ] Every in-scope repository, workflow and environment has an inventory row.
- [ ] Baseline measurements include sample period, source and numeric targets;
  unavailable measurements have explicit collection actions.
- [ ] Every rule gap and unresolved access issue has an owner and disposition.
- [ ] Scope, release constraints and progressive-delivery needs are approved with
  reviewer, date and artifact revision recorded.

Continue to [design](design.md); return here when scope or provider constraints change.
