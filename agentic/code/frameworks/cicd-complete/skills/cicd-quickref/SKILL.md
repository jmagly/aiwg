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

This phrase resolves to the shipped quickref. Execution skills are planned
(#4424); do not invent discovery phrases for them. If discovery is unavailable,
read the canonical source under `$AIWG_ROOT/agentic/code/frameworks/cicd-complete/`.

## Capability domains

| Domain | Work and exit gate | Availability |
|---|---|---|
| assess | Inventory current pipelines and risks; agree scope and success measures. | Agents planned (#4423), skills planned (#4424). |
| design | Define triggers, stage/job dependencies, environments and gates; validate and review contracts. | CIPipeline and CIEnvironment schemas available; agents planned (#4423). |
| implement | Render provider configuration and integrate capabilities; pass provider validation and a controlled trial. | Skills planned (#4424), templates and capabilities planned (#4425). |
| operate | Monitor reliability and rehearse rollback; record ownership and verification. | Skills planned (#4424). |

## Which bundle is for what

| Bundle | Use for |
|---|---|
| cicd-complete | Your CI/CD lifecycle and pipeline/environment contracts. |
| ops-complete + ops `dev` extension | Infrastructure operations, existing CI builder patterns and fleet-wide tooling. |
| aiwg-dev | AIWG dev-mode tooling for developing AIWG itself. |
| sdlc-complete | Software lifecycle and feature-flag planning; owns `feature_flags.provider` configuration. |

## Governed contracts

Validate YAML or JSON documents against the canonical draft-07 schemas:

- CIPipeline: `@$AIWG_ROOT/agentic/code/frameworks/cicd-complete/schemas/ci-pipeline.schema.json`
- CIEnvironment: `@$AIWG_ROOT/agentic/code/frameworks/cicd-complete/schemas/ci-environment.schema.json`

Both use `apiVersion: cicd.aiwg.io/v1`. Jobs name OpsCapabilities; gates reference
GatePacks (`gates.aiwg.io/v1alpha1`). Environment secrets are references only:
`{name, ref}`. A literal `value` is rejected.

Stage rollout strategies are canary, blue-green, rolling and flag. For flag
rollout steps, consumers default omitted capability to `progressive-rollout` and
read the provider from project config `feature_flags.provider`. The pipeline
schema does not define flag lifecycle or provider configuration. Schema defaults
are annotations; validation alone does not execute or populate a rollout.

Extensions may declare WorkflowExtension `spec.extends: cicd-complete`.
OpsExtension stays ops-only. Provider rendering and execution remain planned
(#4424); do not claim a pipeline has run after validating its document.
