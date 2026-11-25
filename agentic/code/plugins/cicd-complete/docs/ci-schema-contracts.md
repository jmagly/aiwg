# CI/CD v1 schema ownership and compatibility

## Brief and authority

CI/CD Complete models end-user delivery pipelines independently of a forge.
The owner of **CIPipeline** and **CIEnvironment** is `cicd-complete`.
The canonical authorities are the framework's `schemas/ci-pipeline.schema.json`
and `schemas/ci-environment.schema.json`, with unique identities under
`https://aiwg.io/schemas/cicd/v1/`. Both use draft-07 and
`apiVersion: cicd.aiwg.io/v1`. Catalog registration lives in
`schemas/catalog/domains/cicd-complete.json` at the AIWG repository root.

Consumers are pipeline-design agents and provider extensions. Execution agents,
renderers and capabilities are planned (#4423–#4425); these schemas establish
contracts before those consumers are implemented. Generated plugin schema copies
are projections, verified byte-for-byte by the fixture suite and plugin-copy lint.
There is no independent TypeScript or provider-specific contract in this change.

## Contract shape

Both resources require `apiVersion`, `kind`, `metadata.name` and `spec`.
Metadata may carry string labels. Governed objects reject unknown properties;
labels, capability inputs and GatePack parameters are intentionally open maps.

CIPipeline requires `spec.triggers`, `environments`, `stages` and `render`.
Triggers are objects with `type: push | pull_request | schedule | manual`, optional
`branches` and `paths`; schedule triggers require `cron`. Stage and job dependency
lists contain ids. Each job requires `id` and an OpsCapability `capability` name.
Retry uses positive `max_attempts` and a consumer-interpreted `backoff` string.

A stage may include `rollout`, with a strategy, steps, gates and rollback policy.
Each step sets exactly one of `weight` or `percentage` (0–100), and may set `pause`,
`gate` or `capability`. Pauses are duration strings. Gate references are objects
with `pack` (a GatePack metadata id), `after` (a stage id) and optional `parameters`.
Step `gate` strings name a GatePack id. GatePacks use `gates.aiwg.io/v1alpha1`;
the existing `aiwg:dev/ci-flake` pack is a reference example, not a dependency.
Rollback names a capability and triggers on `gate-failure` and/or `manual`.

For `strategy: flag`, a consumer defaults an omitted step capability to
`progressive-rollout`. JSON Schema defaults are annotations; validation does not
populate documents. Agents read the provider from project configuration
`feature_flags.provider`, owned by sdlc-complete's feature-flags work. No flag
provider or lifecycle fields belong in CIPipeline. `render.targets` supports
`gitea-actions`, `github-actions` and `gitlab-ci`.

CIEnvironment requires `spec.runner.labels`. Optional `secrets` contain only
`{name, ref}`; `ref` is a nonempty secret-store reference string whose resolution
and store-specific syntax belong to the consumer. `value` is always rejected.
Optional protection specifies a nonnegative `required_reviewers` count and
`branch_restrictions` patterns.

Consumers resolve environment, capability, stage/job dependency and GatePack
references, detect dependency cycles, apply defaults and validate provider-specific
inputs. Structural schema validation does not establish reference integrity or
execute a rollout.

## Compatibility and verification

Version **v1** permits additive changes only (optional fields or compatible
relaxations). Removing fields, changing meaning or adding required fields needs
a new API version and migration guidance. WorkflowExtension now accepts both
`ops-complete` and `cicd-complete` parents, a backward-compatible widening;
OpsExtension remains ops-only.

Valid and invalid fixtures live under `test/fixtures/cicd/{valid,invalid}`.
`test/unit/workflow/ci-schema-validation.test.ts` checks every fixture and expected
rejection keyword, rollout bounds, object closure and packaged projections.
`workflow-schema-validation.test.ts` covers both supported extension parents and
rejects unknown frameworks while preserving the ops-only contract.
