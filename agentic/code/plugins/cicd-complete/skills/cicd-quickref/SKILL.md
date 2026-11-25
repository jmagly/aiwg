---
name: cicd-quickref
namespace: aiwg
platforms: [all]
kernel: true
description: AUTO-INVOKE when user mentions CI/CD, pipeline design, pipeline environments or progressive delivery. CI/CD framework quick reference — assess, design, implement and operate end-user pipelines with governed CIPipeline and CIEnvironment contracts.
triggers:
  - "cicd-quickref"
  - "design my CI/CD pipeline"
  - "CI/CD framework"
  - "CI pipeline schema"
---

# CI/CD Framework — Quick Reference

This is the always-loaded directory for **cicd-complete**, the end-user CI/CD
framework. Help users design and run their own delivery pipelines.

## Canonical access pattern: discover → show

Use discovery before selecting a component. Inspect the metadata card, then fetch
its body or a needed section. Fetch required rules with `--rules
--with-rule-bodies` before governed work. Do not enumerate skills from memory or
browse provider skill directories; they expose deployment state, not the catalog.

```bash
aiwg discover "cicd-quickref"
aiwg show skill cicd-quickref --body
```

This phrase resolves to the shipped quickref. Capability definitions and gate packs
are available below; discover an execution skill before invoking it. If discovery is unavailable,
read the canonical source under `$AIWG_ROOT/${CLAUDE_PLUGIN_ROOT}/`.

## Capability domains

| Domain | Work and exit gate | Availability |
|---|---|---|
| assess | Inventory current pipelines and risks; agree scope and success measures. | Skills `cicd-intake`, `ci-assess`; agent `ci-architect`; intake and assessment templates. |
| design | Define triggers, stage/job dependencies, environments and gates; validate and review contracts. | Skill `ci-pipeline-design`; agent `ci-architect`; CIPipeline/CIEnvironment schemas; spec and environment-plan templates. |
| implement | Render provider configuration and integrate capabilities; pass provider validation and a controlled trial. | Skills `ci-render`, `ci-builder`, `ci-migrate`; agents `ci-renderer`, `supply-chain-guard`; runbook and migration templates. Provider-extension templates are still planned (#4428). |
| operate | Monitor reliability, triage failures, root-cause flakes, coordinate releases and rehearse rollback. | Skills `ci-failure-triage`, `ci-flake-hunt`, `ci-drift-check`, `ci-pipeline-audit`, `ci-release-coordinate`; agents `ci-doctor`, `ci-release-engineer`; runbook and incident templates. |
| CI capability library | Checkout, cache, runtime, lint, tests, coverage, SBOM, signing, artifact upload and deploy handoff. | `capabilities/ci-*.yaml`; reuse ops-complete `dev-pipeline-validate`, `docker-build`, `image-scan`, `docker-push`. Apply `dev-pipeline-safety`, `dev-secret-hygiene`, `dev-idempotent-builds`, `dev-ci-self-contained` and `ci-action-pinning`. |
| Flag delivery | Check flag cards, test both states, scan code references, ramp exposure and hand off cleanup. | `capabilities/flag-*.yaml` and `progressive-rollout.yaml`; implementations resolve through `feature_flags.provider`, with a manual approval gate for `none`. Card authority: `$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/deployment/feature-toggle-card.md`. |
| Gate packs | Enforce coverage, build duration and post-propagation error-rate/latency limits with poll/backoff parameters. | `gate-packs/`: `aiwg:cicd-complete/coverage-floor`, `aiwg:cicd-complete/build-time-budget`, `aiwg:cicd-complete/progressive-rollout-health`; compose with existing `aiwg:dev/ci-flake` at `$AIWG_ROOT/agentic/code/extensions/dev/gate-packs/ci-flake.gatepack.yaml`. |

## Skills, agents and templates

Use these discovery phrases, then `aiwg show <type> <name> --body`:

```bash
aiwg discover "cicd-intake"                  # → skill: CI/CD intake
aiwg discover "ci-assess"                    # → skill: assess current CI
aiwg discover "ci-pipeline-design"           # → skill: design a CIPipeline
aiwg discover "ci-render"                    # → skill: render provider workflows
aiwg discover "ci-drift-check"               # → skill: spec vs rendered drift
aiwg discover "ci-failure-triage"            # → skill: triage a failing pipeline
aiwg discover "ci-flake-hunt"                # → skill: root-cause flaky jobs
aiwg discover "ci-migrate"                   # → skill: migrate CI providers
aiwg discover "ci-pipeline-audit"            # → skill: audit a pipeline
aiwg discover "ci-builder"                   # → skill: self-contained CI builder
aiwg discover "ci-release-coordinate"        # → skill: coordinate a release
aiwg discover "CI/CD intake"                 # → cicd-intake-template
aiwg discover "CI assessment report"         # → ci-assessment-report-template
aiwg discover "CI pipeline spec"             # → ci-pipeline-spec-template
aiwg discover "CI environment plan"          # → ci-environment-plan-template
aiwg discover "CI pipeline runbook"          # → ci-pipeline-runbook-template
aiwg discover "CI pipeline incident"         # → ci-pipeline-incident-template
aiwg discover "CI migration report"          # → ci-migration-report-template
```

Agents: `ci-architect`, `ci-renderer`, `ci-doctor`, `ci-release-engineer`, `supply-chain-guard`.

Phase guidance: [assess](../../docs/phases/assess.md),
[design](../../docs/phases/design.md), [implement](../../docs/phases/implement.md),
[operate](../../docs/phases/operate.md). Apply the checkable
[gate criteria](../../flows/gate-criteria-by-phase.md) at each handoff and recurring
operational review. YAML spec template frontmatter is metadata: copy and validate
the second YAML document as CIPipeline. Schema validation does not resolve
capability/environment/GatePack references or prove execution.

## Which bundle is for what

| Bundle | Use for |
|---|---|
| cicd-complete | Your CI/CD lifecycle and pipeline/environment contracts. |
| ops-complete + ops `dev` extension | Infrastructure operations, existing CI builder patterns and fleet-wide tooling. |
| aiwg-dev | AIWG dev-mode tooling for developing AIWG itself. |
| sdlc-complete | Software lifecycle and feature-flag planning; owns `feature_flags.provider` configuration. |

## Governed contracts

Validate YAML or JSON documents against the canonical draft-07 schemas:

- CIPipeline: `@$AIWG_ROOT/${CLAUDE_PLUGIN_ROOT}/schemas/ci-pipeline.schema.json`
- CIEnvironment: `@$AIWG_ROOT/${CLAUDE_PLUGIN_ROOT}/schemas/ci-environment.schema.json`

Both use `apiVersion: cicd.aiwg.io/v1`. Jobs name OpsCapabilities; gates reference
GatePacks (`gates.aiwg.io/v1alpha1`). Environment secrets are references only:
`{name, ref}`. A literal `value` is rejected.

Stage rollout strategies are canary, blue-green, rolling and flag. For flag
rollout steps, consumers default omitted capability to `progressive-rollout` and
read the provider from project config `feature_flags.provider`. The pipeline
schema does not define flag lifecycle or provider configuration. Schema defaults
are annotations; validation alone does not execute or populate a rollout.

Extensions may declare WorkflowExtension `spec.extends: cicd-complete`.
OpsExtension stays ops-only. Definition validation does not execute provider
rendering or delivery; do not claim a pipeline has run after validating its document.
