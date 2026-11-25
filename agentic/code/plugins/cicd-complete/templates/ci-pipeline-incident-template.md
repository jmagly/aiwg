---
name: ci-pipeline-incident-template
description: Triage pipeline failures and flakes with causal repair, regression tests and release impact evidence.
outputKind: ci-pipeline-incident
aliases:
  - CI pipeline incident
  - ci flake incident report
---

# CI pipeline incident

## Incident and impact

Fill incident ID, severity, status, owner, first detection/timezone, repository,
spec/rendered revisions, provider/run/job IDs, affected artifacts/environments,
blocked releases and user impact. Link the current runbook and alert.

## Evidence and timeline

Retain the first failure, redacted logs, runner image, dependency versions, seed,
clock/network/isolation context and failure signature. Use references and retention
locations, never secret values. Record each event, hypothesis and mitigation with
timestamp, actor and evidence. Keep failed attempts visible after later successes.

## Root cause and flake reproduction

Classify build/test/security/runner/deploy/provider/drift cause. Document a minimal
reproducer, controls and expected failure. For intermittent failures state the
causal timing/state condition and why earlier checks missed it. Diagnostic runs
test hypotheses; never re-run to green or count a lucky pass as resolution.

## Mitigation and repair

Fill containment, stopped promotions, rollback decision/authority, stable artifact,
commands/procedure references and observed health. Link the causal code/spec/runner
repair and review. Reconcile drift through the spec and renderer, then revalidate
provider configuration. Assign owner/date for any incomplete repair; keep it open.

## Regression and recovery evidence

Fill the regression test path/case, command, failing result before repair and
passing result after repair, plus the repaired revision and original-path result.
Do not skip/weaken tests or substitute repeated unchanged runs for the causal test.
Record recovery duration versus objective and remaining impact.

| Check | Revision / command | Expected / actual | Evidence reference |
|---|---|---|---|
| Regression before repair | [revision, command] | [causal failure, observed] | [run/log] |
| Regression after repair | [revision, command] | [pass, observed] | [run/log] |
| Original pipeline path | [revision, command/run ID] | [gate and health outcomes] | [run/log] |

## Prevention and closure

Fill actions, regression coverage gaps, alerts, runbook updates, release/on-call
communication references and owner/due date for each follow-up. Review relevant
`dev-pipeline-safety`, `dev-secret-hygiene`, `dev-idempotent-builds`,
`dev-ci-self-contained` and `ci-action-pinning` findings by reference. Record
reviewer/date, causal closure evidence and the next operational review.

## Existing incident record reference

Link the completed detailed postmortem derived from
Ops dev pipeline incident (`$AIWG_ROOT/agentic/code/extensions/dev/templates/pipeline-incident.md`).
Reuse its impact/timeline analysis by reference; this record adds CI/CD-specific
spec drift, flake causality, regression and progressive-release evidence.
