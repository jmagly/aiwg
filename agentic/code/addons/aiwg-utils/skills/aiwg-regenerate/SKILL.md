---
namespace: aiwg
name: aiwg-regenerate
platforms: [all]
kernel: true
description: Select and execute the canonical refresh, existing-project extraction, or legacy AIWG context regeneration branch
triggers:
  - "regenerate context files"
  - "refresh project context"
script:
  entrypoint: run.sh
  runtime: bash
  cwd: project-root
  argsHint: '[--workspace|--existing-project|--full-inject] [--provider <name>] [--dry-run|--apply] [--force]'
---

# Regenerate Context — Branch Selector

The CLI is the deterministic source of truth for context regeneration. An
unqualified invocation previews transactional adoption for an established,
not-yet-extracted repository; fresh or already-adopted projects route to the
canonical refresh. Mutation of an inferred adoption always requires an explicit
`--apply`. Do not make users choose a branch unless they want to override the
selection.

Select and load exactly one linked branch before execution:

- [Canonical workspace graph](../aiwg-regenerate-workspace/SKILL.md) — default
  refresh for new and already-migrated projects.
- [Existing-project extraction](../aiwg-regenerate-existing-project/SKILL.md) —
  transactional adoption of stable project metadata and provider context into
  the canonical graph; preview is the default and `--apply` is required.
- [Legacy full injection](../aiwg-regenerate-legacy/SKILL.md) — compatibility
  branch; embeds normalized AIWG context inside the provider startup file.

## Commands

```bash
# Intelligent default (recommended user surface)
aiwg run skill aiwg-regenerate

# Canonical default
aiwg regenerate --workspace [--provider <name>] [--dry-run] [--force]

# Existing-project transactional adoption
aiwg regenerate --existing-project [--provider <name>] [--dry-run|--apply]

# Legacy compatibility
aiwg regenerate --full-inject [--provider <name>] [--dry-run]
```

`--legacy` aliases `--full-inject`. The CLI rejects conflicting branches,
unknown options, and missing provider values with usage status.

`--existing-project` rejects `--force` and all `--no-*-md` partial-write flags.
It refuses possible credentials and ambiguous directive conflicts, previews the
exact extracted block and transaction targets, and prints the rollback command
after apply.

Explicit branch flags always win. Without one, the executable selector checks
the canonical extractor's complete stable-source inventory and managed markers.
A first-time established project is previewed; rerun with `--apply` to adopt it.
An already-extracted or genuinely signal-free project uses `--workspace`.

Supported shared controls are `--dry-run`, `--provider <name>`, `--force`,
`--no-aiwg-md`, `--no-agents-md`, and `--no-workspace-md`. The last option is
implicit in legacy mode.

## Execution Contract

1. For an established project, preview the selected branch first.
2. Preserve operator-authored content outside managed regions.
3. Never copy possible credentials into generated context.
4. Execute with `aiwg run skill aiwg-regenerate -- <flags>` when the provider
   supports executable skills, or run the equivalent `aiwg regenerate` command.
5. Report the selected branch, provider, changed targets, backups, warnings,
   validation result, and rollback path.

Use `aiwg refresh` instead when frameworks, agents, skills, rules, commands, or
provider deployments also need to be updated.
