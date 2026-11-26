# CI/CD Complete

Design, build, operate and evolve **your own CI/CD pipelines** with AIWG.
This end-user framework is separate from AIWG's repository CI and release tooling.

## Lifecycle

| Phase | Purpose | Exit gate |
|---|---|---|
| assess | Inventory delivery needs, current pipelines and risks. | Scope, baseline and success measures are agreed. |
| design | Model stages, environments, capabilities and gates. | Pipeline and environment documents validate and the design is reviewed. |
| implement | Render and integrate the chosen provider configuration. | Rendered configuration passes provider validation and a controlled trial. |
| operate | Monitor delivery, rehearse rollback and improve reliability. | Operational ownership, monitoring and rollback verification are recorded. |

## Available now

The package ships the kernel [cicd-quickref](skills/cicd-quickref/SKILL.md),
[CIPipeline](schemas/ci-pipeline.schema.json) and
[CIEnvironment](schemas/ci-environment.schema.json) draft-07 schemas.
It also ships five agents (`ci-architect`, `ci-renderer`, `ci-doctor`,
`ci-release-engineer`, `supply-chain-guard`), eleven lifecycle skills, seven
templates, phase guides with gate criteria, a CI capability library with the
provider-neutral flag capabilities, and three gate packs. Provider recipes live in
the `cicd-gitea-actions` and `cicd-github-actions` extensions.

What each layer does: the schemas give **structural validation**; the agents and
provider recipes produce **rendered workflow files** for you to review; nothing in
this framework **executes** pipelines, and rendered files reference capability
adapters and bindings that your project must supply and review before use. See
the [quickstart](docs/quickstart.md) and [overview](docs/overview.md).

```bash
aiwg use cicd-complete
# Short alias: aiwg use cicd
aiwg discover "cicd-quickref"
aiwg show skill cicd-quickref --body
```

## Which bundle is for what

| Bundle | Ownership |
|---|---|
| cicd-complete | End-user CI/CD lifecycle and governed pipeline/environment contracts. |
| ops-complete + ops `dev` extension | Operational infrastructure, existing CI builder patterns and fleet tooling. |
| aiwg-dev | AIWG development-mode tooling for maintaining AIWG itself. |
| sdlc-complete | Software lifecycle and feature-flag planning, including `feature_flags.provider`. |

Extensions can target this framework through WorkflowExtension `spec.extends:
cicd-complete`. OpsExtension remains ops-only. Jobs reference OpsCapability names;
GatePack references identify `gates.aiwg.io/v1alpha1` packs. Referenced capabilities,
environments and gates must be resolved by consumers; schema validation checks shape.
See [schema ownership and compatibility](docs/ci-schema-contracts.md).

## User guides

- [Quickstart: assess, design, render and operate a pipeline](docs/quickstart.md)
- [Overview: concepts, bundles and execution boundaries](docs/overview.md)
