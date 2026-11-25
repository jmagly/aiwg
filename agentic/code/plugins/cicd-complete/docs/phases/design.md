# Design

## Purpose

Turn the assessed delivery requirements into a provider-neutral CIPipeline and
CIEnvironment plan with explicit promotion and rollback decisions.

## Entry criteria

- [ ] The assess gate decision and reviewed intake/assessment revisions exist.
- [ ] Delivery, environment, security and release decision owners are named.
- [ ] Priority risks and measurable success targets are available.

## Activities

1. Define triggers, stage/job dependency graphs, artifact identity, caching and
   concurrency. Separate untrusted validation from privileged deployment.
2. Select OpsCapability resources (`ops.aiwg.io/v1`) and validate their inputs.
   Resolve every environment, capability and dependency; reject cycles.
3. Create CIEnvironment documents: runner labels, secret references and protection.
   Keep capacities, network needs and access ownership in the environment plan.
4. Define blocking GatePacks (`gates.aiwg.io/v1alpha1`), metric sources, thresholds,
   observation windows and failure actions. Plan canary/blue-green/rolling/flag
   promotion, rollback and release coordination as required by intake.
5. For flag rollout, consume SDLC's `feature_flags.provider` and feature-toggle card;
   use provider-neutral capabilities without duplicating flag lifecycle or vendor ops.
6. Review provider support, rendering paths, rule compliance and migration parity.
   Use existing FlowCapability (`flow.aiwg.io/v1`) coordination where needed.

## Outputs (templates)

- [CI pipeline spec](../../templates/ci-pipeline-spec-template.yaml): CIPipeline.
- [CI environment plan](../../templates/ci-environment-plan-template.md): decisions
  and linked CIEnvironment documents.
- [CI migration report](../../templates/ci-migration-report-template.md): provider
  A → B parity and cutover plan when migrating; otherwise record not applicable.

## Exit gate: reviewed design

Apply the [design checklist](../../flows/gate-criteria-by-phase.md#design-gate).

- [ ] CIPipeline and all CIEnvironment documents pass their canonical schemas.
- [ ] Reference resolution and dependency-cycle checks pass separately from schemas.
- [ ] Every progressive step has a metric threshold, gate, observation window and
  rollback owner; the selected consumer can enforce them.
- [ ] Environment/security owners approve protections and references; delivery and
  release owners approve provider mapping and cutover/rollback plans.

Continue to [implement](implement.md). Unsupported provider behavior returns to design.
