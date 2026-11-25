---
name: ci-environment-plan-template
description: Plan CIEnvironment runners, secret references, protection and promotion boundaries.
outputKind: ci-environment-plan
aliases:
  - CI environment plan
  - ci runner environment planning
---

# CI environment plan

## Context and owners

Fill author/date, intake/assessment/spec revisions, environment owners, security
reviewer and availability/cost constraints. Link the user's existing inventory.

## Environment topology and runner capacity

Add one row per named environment; match `CIPipeline.spec.environments` exactly.
Document trust boundaries, network access, cleanup, capacity/concurrency and tooling
pins in linked inventory records. Never use privileged release credentials in
untrusted validation jobs.

| Environment / owner | Deployment target | Runner labels / image pin | Capacity / queue target | Network / isolation reference |
|---|---|---|---|---|
| [name, owner] | [platform, region, service] | [labels, digest] | [limits and target] | [reviewed reference] |

## CIEnvironment documents

Copy and adapt one document per environment; validate each against
`$AIWG_ROOT/agentic/code/frameworks/cicd-complete/schemas/ci-environment.schema.json`.
Fill labels, approved store references and protections. Record document paths and
validation commands/results separately. Do not add plan prose fields to the schema.

```yaml
apiVersion: cicd.aiwg.io/v1
kind: CIEnvironment
metadata:
  name: ci-production
spec:
  runner:
    labels: [ci-release-isolated]
  secrets:
    - name: ci-deploy-credential
      ref: vault://ci/production#deploy-credential
  protection:
    required_reviewers: 2
    branch_restrictions: [main]
```

## Access and secret references

List logical name/reference, consuming jobs, access scope, rotation owner and
redaction/audit policy. References only: never resolve or paste literal values.
Explain how provider bindings preserve environment and branch protection.

## Promotion and recovery

Fill immutable artifact flow between environments, reviewer authority, deployment
locks, release window, rollback artifact/owner/time objective and data compatibility
constraints. Link progressive gates and the SDLC feature-toggle cards as applicable.

## Validation and approval

Record schema results, reference resolution, dependency-cycle check and provider
protection validation, with command/status/revision. Review against
`dev-pipeline-safety`, `dev-secret-hygiene`, `dev-idempotent-builds`,
`dev-ci-self-contained` and `ci-action-pinning`. Fill environment/security approval,
date, conditions and the [design gate](../flows/gate-criteria-by-phase.md#design-gate)
decision; unknowns require an owner and resolution date.
