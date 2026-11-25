# Implement

## Purpose

Integrate the reviewed spec with the user's provider and prove its behavior in a
controlled trial. Schema validation alone is not execution evidence.

## Entry criteria

- [ ] Design gate passed with immutable spec and environment revisions recorded.
- [ ] Selected capabilities, GatePacks and renderer/adapter versions are available.
- [ ] Trial environment, operator, release window and rollback authority are agreed.

## Activities

1. Render or translate the reviewed spec into the selected provider configuration.
   Record spec digest, renderer/version, command and every output path/digest.
2. Validate provider syntax and event/protection behavior. Check least privilege,
   immutable action/image pins, isolated jobs and reproducible dependencies against
   the referenced rules; do not copy legacy examples without adapting them.
3. Exercise the stage graph, artifact promotion, gates and failure paths in an
   isolated trial. Demonstrate that a failed canary gate halts promotion and invokes
   rollback; record health and artifact identity after recovery.
4. Compare spec intent to rendered semantics, not just text. Check triggers,
   environment approvals, dependencies, secret bindings and progressive steps.
5. When migrating, compare provider A and B on the same source/artifact without
   duplicate production writes. Resolve parity gaps before the approved cutover.
6. Populate operating procedures, monitoring and incident routing. Repair failed
   tests at their cause and add regression tests; never re-run to green.

## Outputs (templates)

- [CI pipeline spec](../../templates/ci-pipeline-spec-template.yaml): reviewed inputs
  plus linked rendered files and validation records in the runbook.
- [CI pipeline runbook](../../templates/ci-pipeline-runbook-template.md): trial,
  drift comparison, rollback and operational handoff evidence.
- [CI migration report](../../templates/ci-migration-report-template.md): parity and
  cutover results when moving providers.

## Exit gate: proven integration

Apply the [implement checklist](../../flows/gate-criteria-by-phase.md#implement-gate).

- [ ] Provider validation and the controlled trial pass for the recorded revision.
- [ ] Failed-gate behavior and rollback were exercised with retained evidence.
- [ ] Spec/rendered semantic comparison has no unexplained differences.
- [ ] Runbook, alerts, operator handoff and any migration parity are accepted.

Continue to [operate](operate.md). Changes to contracts return through design.
