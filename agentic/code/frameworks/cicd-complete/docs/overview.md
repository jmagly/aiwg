# CI/CD Complete overview

Use cicd-complete to design, review and improve your project's delivery
pipelines with an AI assistant. Begin with a concrete request:

```text
Assess our current CI, propose a provider-neutral pipeline with measurable
gates, and prepare a reviewed workflow preview for our chosen forge. Keep
unknowns visible and carry the design, validation and rollback records forward.
```

The [quickstart](quickstart.md) walks through assessment, canary design,
provider rendering, failure triage, flag delivery and migration. The framework
organizes work into [assess](phases/assess.md), [design](phases/design.md),
[implement](phases/implement.md) and [operate](phases/operate.md). Each phase has
review criteria; an artifact draft alone does not establish that its gate passed.

## Pipeline and environment contracts

**CIPipeline** describes delivery intent independently of the forge. Its
`cicd.aiwg.io/v1` document names triggers, environments, stages, jobs and render
targets. Stage and job `depends_on` references define ordering. Jobs name
capabilities and provide inputs; stages may add rollout steps and rollback.
Top-level gates bind to named stages. `render.targets` selects provider mappings.

**CIEnvironment** describes a named execution/protection boundary using the same
API version. It requires runner labels and can name secret-store references,
required reviewer counts and branch restrictions. Secrets use `{name, ref}`;
literal `value` fields are rejected. Capacity, network access, ownership and
recovery decisions belong in the accompanying environment plan.

The draft-07 schemas check document shape. Consumers must additionally resolve
references, check capability inputs and gate parameters, reject cycles, and
verify provider semantics. Schema defaults are annotations; they do not populate
or execute a pipeline. See [schema ownership and compatibility](ci-schema-contracts.md).

## Capabilities and gate packs

An **OpsCapability** (`ops.aiwg.io/v1`) names a bounded operation with inputs,
outputs and verification requirements. The CI library covers checkout, caching,
runtime setup, lint, tests, coverage, SBOMs, signing, artifact upload and deployment
handoff. Container pipelines can reuse ops capabilities such as `docker-build`,
`image-scan` and `docker-push`. A definition does not supply every project's
implementation: the binding plan must identify actual tools/adapters and inputs.

A **GatePack** (`gates.aiwg.io/v1alpha1`) describes how evidence permits or
blocks progression. The shipped packs are:

| Pack | Evidence and parameter examples | Blocking behavior |
|---|---|---|
| `aiwg:cicd-complete/coverage-floor` | Coverage for the tested revision; `minCoveragePercent` (default 80) | Below threshold or missing evidence: HOLD |
| `aiwg:cicd-complete/build-time-budget` | Build elapsed seconds, including retries; `maxBuildSeconds` (default 600) | Over budget or missing evidence: HOLD |
| `aiwg:cicd-complete/progressive-rollout-health` | Propagation age, error fraction and p95 latency; `maxErrorRate` (default 0.01), `maxLatencyMs` (default 500) | Propagation/missing evidence: HOLD; observed health failure: ROLLBACK |

Defaults are starting points to review against your service. The health pack
also describes bounded polling and backoff; the rollout consumer performs the
waiting and evidence collection. Gate evaluation itself does not poll or deploy.
Use separate flake policy, such as the existing `aiwg:dev/ci-flake` pack, rather
than treating coverage as proof of test reliability.

## Rollout strategies and feature flags

A stage rollout selects `canary`, `blue-green`, `rolling` or `flag`. Ordered steps
specify exactly one of `weight` or `percentage`, optional pauses, gates and
capability overrides. Rollback names a capability and signals such as
`gate-failure` or `manual`. The provider binding must implement the selected
strategy, preserve immutable artifact identity and verify recovery.

Flag rollout consumes the existing SDLC feature-toggle card and project
`feature_flags.provider`; provider and lifecycle fields do not belong in
CIPipeline. Consumers resolve an omitted flag-step capability to
`progressive-rollout`. The provider addon owns vendor-specific operations and
must establish experiment-linked rollout safety. Provider `none` requires a
manual approval gate with recorded evidence; absent or unknown configuration
is unresolved. Cleanup capability output hands lifecycle work back to SDLC.
It does not authorize flag creation, toggling, retirement or deletion.

## Provider extensions

The first-wave WorkflowExtensions extend `cicd-complete` and supply
agent-interpreted rendering recipes, provider safety guidance and action pin
manifests:

| Extension | Render target | Intended workflow directory |
|---|---|---|
| `cicd-gitea-actions` | `gitea-actions` | `.gitea/workflows/` |
| `cicd-github-actions` | `github-actions` | `.github/workflows/` |

A render needs accepted pipeline/environment documents, resolved capabilities
and gate packs, and a binding plan for runners, runtime, artifacts, protections
and implementations. The receipt records input/template/pin/output digests,
versions, paths and mappings. Unsupported mappings must be reported as blockers,
not silently dropped. Although the schema permits `gitlab-ci`, these two
extensions do not implement GitLab rendering.

Provider recipes refer to project-owned `ci/*.mjs` adapters for capability,
gate, rollout and approval enforcement. They are contracts for implementations
the project must supply and validate, not bundled runtime scripts. Gitea requires
server/runner-specific compatibility and explicit approval enforcement. GitHub
native environment settings must be configured and verified; reviewer eligibility
alone does not prove the required number of distinct approvals.

## Choose the right bundle

| Bundle | Use it for |
|---|---|
| `cicd-complete` | Your application's CI/CD lifecycle, pipeline/environment contracts, rendering review, failures and migration |
| `ops-complete` with the ops `dev` extension | Operational infrastructure, runbooks, fleets, existing builder and container capability patterns; CI/CD reuses these definitions where appropriate |
| `aiwg-dev` | Development-mode tooling for maintaining AIWG itself; it is not your project's delivery framework |
| `sdlc-complete` flag planning | Flag-fit decisions, feature-toggle cards and lifecycle ownership; vendor operations use provider addons selected through `feature_flags.provider` |

A CI forge provider and a feature-flag provider are separate choices. Installing
a forge extension neither provisions runners nor selects or configures flag
services. WorkflowExtension can extend cicd-complete; OpsExtension remains
ops-only.

## What completion means

The framework supplies assistant instructions and contracts. Rendering is
agent-interpreted, with repeat-render consistency to verify; there is no
standalone CI render engine or pipeline executor here. Nothing in installation,
schema validation or rendering executes a pipeline. Execution belongs to your
provider and reviewed project implementations under explicit authorization.

Review the rendered diff before installing or committing it. Retain validation
results for actual provider controls, then authorize a bounded trial separately.
Only observed trial evidence can establish gate enforcement, promotion and
rollback. Missing adapters, validators, settings or health observations remain
explicit prerequisites. During operation, preserve original failures, diagnose
flakes with bounded experiments, and reconcile drift through the reviewed
specification and rendering inputs.
