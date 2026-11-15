# Flow: `aiwg use <bundle>`

[Architecture](index.md) · [Provider internals](provider-deployment.md)

`UseHandler` selects scope, providers and source bundles. Canonical multi-provider
preparation and project-local deployment are distinct paths; the diagram shows
both rather than suggesting that every `use` invokes the coordinator.

```mermaid
sequenceDiagram
  actor O as Operator
  box Local CLI process
    participant U as UseHandler
    participant P as Provider preparation coordinator
    participant L as Project-local discovery and shadows
    participant C as CLI namespace registration
    participant H as Managed hook installer
  end
  box Deployment execution and filesystem boundary
    participant D as Provider deployer
    participant F as Provider outputs and ownership receipts
  end
  O->>U: execute(bundle, provider and scope flags)
  U->>U: executeDeployment; resolve sources, providers and scope
  alt Canonical multi-provider preparation selected
    U->>P: prepareProviderDeployments(frameworkRoot, jobs)
    P->>D: preflightOnly for each job, then prepare(maxConcurrency=2)
    P-->>U: prepared session
    U->>P: run(work), commit(index), finalizePreparedProvider
    P->>D: finalizeOnly for prepared provider
    D->>F: write translated artifacts and ownership
  else Direct project-local bundle or reconciliation
    U->>L: deployProjectLocalBundles; discover and resolveShadows
    L-->>U: validated bundles and blocked IDs
    loop Each permitted artifact-bearing bundle
      U->>U: deployOneProjectLocalBundle; count artifacts and CLI contributions
      U->>D: deploy-agents with source, provider, copy-all and project-local owner
      D->>F: write provider artifacts, markers and sidecars
      D-->>U: exit status
      opt Successful bundle with cli_commands
        U->>C: registerSourceCliCommands then registerCliCommands
        C->>F: write cli-extensions.json with portable source
      end
      U->>F: update installed entry, hashes and deployment record
    end
  end
  opt Managed Claude hooks enabled on applicable use path
    U->>H: installAiwgHooks
    H->>F: copy managed scripts; merge settings and retain backup
  end
  U-->>O: deployment result; context rollback details on failure
```

Drawn from:

- [`src/cli/handlers/use.ts`](../../../src/cli/handlers/use.ts): `UseHandler.execute`, `executeDeployment`, `deployProjectLocalBundles`, `deployOneProjectLocalBundle`, `registerSourceCliCommands`.
- [`src/cli/provider-deployment-plan.ts`](../../../src/cli/provider-deployment-plan.ts): `buildProviderDeploymentPlan`.
- [`src/cli/services/provider-prepare-coordinator.ts`](../../../src/cli/services/provider-prepare-coordinator.ts): `prepareProviderDeployments`, `finalizePreparedProvider`.
- [`tools/agents/providers/provider-prepare-coordinator.mjs`](../../../tools/agents/providers/provider-prepare-coordinator.mjs): prepared session `run`, `commit`, `dispose`.
- [`tools/agents/deploy-agents.mjs`](../../../tools/agents/deploy-agents.mjs): `main`.
- [`src/extensions/project-local-discovery.ts`](../../../src/extensions/project-local-discovery.ts): `discoverProjectLocalBundles`.
- [`src/extensions/shadow-resolver.ts`](../../../src/extensions/shadow-resolver.ts): `resolveShadows`.
- [`src/cli/cli-extension-loader.ts`](../../../src/cli/cli-extension-loader.ts): `loadCliCommandsContribution`, `registerCliCommands`.
- [`src/extensions/claude-hooks-installer.ts`](../../../src/extensions/claude-hooks-installer.ts): `installAiwgHooks`.
- [`src/providers/deployment-ownership.mjs`](../../../src/providers/deployment-ownership.mjs): `captureDeploymentOutputs`, `recordDeploymentOutputs`.
- [`src/providers/skill-ownership.mjs`](../../../src/providers/skill-ownership.mjs): `canDeploySkill`, `mergeArtifactOwnership`.
- [`src/smiths/context-pipeline/context-file-safety.ts`](../../../src/smiths/context-pipeline/context-file-safety.ts): `ContextWriteJournal`.

A project-local provider bundle selects a provider definition; it is not copied as
an artifact bundle. Plugin wrappers resolve to their validated payload first.
Shadows are checked before copying. Successful project-local deployments reconcile
skill assets, register CLI modules, then record source/deployed hashes in config.
Receipt-write errors can be warnings after deployment has already succeeded.

`--dry-run` avoids deployment writes. The top-level context journal can restore
context outputs on failure; it does not make every provider output one atomic
transaction. Ownership sidecars and markers support later refresh/removal decisions.
