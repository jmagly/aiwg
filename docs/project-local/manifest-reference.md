---
title: Project-Local Manifest Reference
description: Pointer to the canonical bundle manifest schema.
---

# Project-Local Manifest Reference

> The manifest format that previously lived here described the old
> `.aiwg/.project/manifest.json` design. The as-shipped manifest is the
> unified bundle manifest used by every project-local artifact type.

## Canonical sources of truth

| Source | What it contains |
|--------|------------------|
| [Extending the CLI](../architecture/cli/extending-cli.md#manifest-contract) | Bundle contract and worked example |
| [`src/extensions/manifest.ts`](../../src/extensions/manifest.ts) | Zod schema (executable contract) |
| [`src/extensions/types.ts`](../../src/extensions/types.ts) | TypeScript types |

## Minimal valid manifest

```json
{
  "id": "my-bundle",
  "type": "extension",
  "name": "My Bundle",
  "version": "0.1.0",
  "description": "A short, accurate description",
  "manifestVersion": "1",
  "platforms": { "claude": "full" },
  "keywords": ["custom", "project-local"],
  "deployment": { "pathTemplate": ".{platform}/skills/{id}.md" }
}
```

For each `type`, the matching nested config is required:

| `type` | Required nested config |
|--------|----------------------|
| `extension` | `extensionConfig` (optional — extensions may omit it) |
| `addon` | `addonConfig` |
| `framework` | `frameworkConfig` |
| `plugin` | `pluginConfig` |
| `provider` | `providerConfig` with `extends` |

Path-traversal in `entry` paths (`../../etc`) is refused at validation
time. The manifest must be ≤ 64 KB. See the executable schema for the full
constraint set.

## Addon-contributed CLI commands

Addon-shaped project-local bundles can register an expandable CLI namespace
without adding a one-off command to AIWG core:

```json
{
  "cli_commands": {
    "namespace": "my-addon",
    "description": "My addon commands",
    "entry": "commands/",
    "subcommands": {
      "check": {
        "file": "check.mjs",
        "description": "Check project state"
      }
    }
  }
}
```

Each module exports a default async function accepting `(args, context)`.
Paths must remain within the bundle and use local basename `.mjs` modules. Plugin wrappers
may instead place this block in the manifest at their validated addon payload.
`aiwg use <bundle>` registers the namespace in
`cli-extensions.json` under the resolved artifact root (normally `.aiwg/`).

**Trust boundary:** CLI modules are dynamically imported and run inside the AIWG
process with the invoking user's permissions, with **no sandbox**. Only install
bundles you trust. Built-in commands and aliases always win namespace clashes.
Path validation does not restrict what a loaded module can do.

Sources inside the project are registered relative to the project root, not the
registry's parent directory. External sources retain absolute paths; re-run
`aiwg use <bundle>` after moving those sources or cloning to another machine.
Relative parent traversal and symlink escapes are rejected. Doctor warns about
missing source directories, including stale committed registries. See
[portable registration](../architecture/cli/extending-cli.md#portable-cli-registration)
for the format and removal limits.

## Generate a valid manifest automatically

```bash
aiwg new-bundle <name> --type extension --starter skill
```

Produces `.aiwg/extensions/<name>/manifest.json` with all required
fields filled. You only need to edit `description`, bump `version` to
`1.0.0` when stable, and add platforms beyond `claude` if needed.
