# Flow: `aiwg new-bundle` → `aiwg use`

[Architecture](index.md) · [Worked authoring example](extending-cli.md#worked-example)

Scaffolding creates canonical bundle files beneath the resolved artifact root.
The source shape stays usable when promoted upstream. Deployment is a later,
explicit operation.

```mermaid
sequenceDiagram
  actor O as Bundle author
  box Local CLI boundary
    participant N as newBundleHandler
    participant S as scaffoldProjectLocalBundle
    participant I as Project graph builder
    participant U as UseHandler
    participant V as Discovery and shadow resolver
  end
  box Project filesystem boundary
    participant B as Artifact root bundle directory
    participant P as Provider outputs and installed registry
  end
  O->>N: new-bundle name --type addon --starter skill
  N->>N: parse type aliases, starter and description
  N->>S: scaffoldProjectLocalBundle(options)
  S->>B: stat destination; refuse overwrite
  alt --dry-run
    S-->>N: planned paths without writes
  else Create bundle
    S->>B: buildManifest; write manifest, README and starter
    S-->>N: bundlePath and filesCreated
    N->>I: buildIndex(cwd, graph=project)
    I->>B: scan project source metadata
    I-->>N: new capability discoverable
  end
  N-->>O: scaffold result
  O->>B: edit skill, rule and optional cli_commands module
  O->>U: use name --provider claude
  U->>V: discoverProjectLocalBundles; validate and resolveShadows
  V->>B: load manifest and contained artifacts
  V-->>U: selected bundle or refusal
  U->>U: deployProjectLocalBundles → deployOneProjectLocalBundle
  U->>P: deploy artifacts; register CLI namespace and record hashes
  U-->>O: deployment result
```

Drawn from:

- [`src/cli/handlers/subcommands-bundles.ts`](../../../src/cli/handlers/subcommands-bundles.ts): `newBundleHandler.execute`.
- [`src/extensions/project-local-scaffold.ts`](../../../src/extensions/project-local-scaffold.ts): `scaffoldProjectLocalBundle`, `buildManifest`.
- [`src/config/project-artifacts.ts`](../../../src/config/project-artifacts.ts): `projectAiwgPath` facade.
- [`src/artifacts/index-builder.ts`](../../../src/artifacts/index-builder.ts): `buildIndex`.
- [`src/extensions/project-local-discovery.ts`](../../../src/extensions/project-local-discovery.ts): `discoverProjectLocalBundles`.
- [`src/extensions/shadow-resolver.ts`](../../../src/extensions/shadow-resolver.ts): `resolveShadows`.
- [`src/cli/handlers/use.ts`](../../../src/cli/handlers/use.ts): `UseHandler.execute`, `deployProjectLocalBundles`, `deployOneProjectLocalBundle`.

`new-extension`, `new-addon`, `new-framework`, `new-plugin` and `new-provider` are
type-selecting aliases. Extension/addon scaffolds normally start with a skill;
framework/plugin/provider scaffolds default to minimal. Plugin payloads need
their own valid content before deployment; provider bundles select a base layout.

The scaffold validates the name and refuses an existing directory. Discovery and
deployment enforce the bundle schema and shadow policy after author edits.
Run `aiwg doctor --project-local` to inspect validation, undeployed bundles and drift.
Promotion and removal are covered in the [existing customization guides](../../customization/project-local-quickstart.md).
