# ADR-001: unified extension registry for built-in CLI dispatch

Status: **Accepted; documents the implemented 2026.11.x design.**

## Context

Commands need stable IDs, aliases, capability metadata and a handler lookup. A
large switch statement makes these contracts drift apart. Content artifacts and
commands already share extension metadata, while contributed bundle modules need
a separate, project-selected loading boundary.

## Decision

Represent built-in command definitions with the unified Extension model.
`loadRegistry` registers `commandDefinitions`, registers aliases from the selected
handlers, optionally creates the capability index, and returns a handler map.
`run` resolves a built-in ID before looking for a bundle CLI namespace.

The operational meaning of `skill` in command metadata does not mean every
instructional `SKILL.md` is executable. `aiwg run skill` separately resolves an
indexed `script` declaration. Nor does the unified registry replace the bundle
manifest: `BundleManifestSchema` validates a directory of artifacts, while
`Extension` describes an individual capability.

## Consequences

- Built-ins and their aliases always win namespace clashes.
- The discovery startup path can link a small handler subset without importing
  all implementations; all command definitions still register.
- Contributed `.mjs` commands load through the project CLI registry and execute
  in process. They do not acquire an isolation boundary from the registry model.
- Adding a built-in requires keeping its definition and handler aligned. Adding
  a bundle subcommand uses `cli_commands` instead of a new top-level core command.

The [component diagram](index.md#cli-core-components) is the visual view of this
decision. See the [authoring guide](extending-cli.md) for the bundle contract.

Drawn from:

- [`src/extensions/types.ts`](../../../src/extensions/types.ts): `Extension` model.
- [`src/extensions/commands/definitions.ts`](../../../src/extensions/commands/definitions.ts): `commandDefinitions`.
- [`src/extensions/loader.ts`](../../../src/extensions/loader.ts): `loadRegistry`, `linkHandlers`.
- [`src/extensions/registry.ts`](../../../src/extensions/registry.ts): `register`, `registerAlias`, `resolveCommand`.
- [`src/cli/router.ts`](../../../src/cli/router.ts): `initRouter`, `run`.
