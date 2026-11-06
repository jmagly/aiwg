---
audience: agent-operator
publication: agent-reference-redirect
stable_id: aiwg.agent-reference.cli.root-compat
---

# CLI Reference Moved

The authoritative agent and automation CLI reference is now
[`docs/cli/reference.md`](cli/reference.md).

This compatibility pointer remains in installed packages for older agent
artifacts. General users should follow
[Install, Connect, and Verify](getting-started/install-connect-verify.md).

## `aiwg rules` — operator rule pins

Inspect configured rules without changing deployment:

```bash
aiwg rules inventory --scope workspace --json
aiwg rules list --capability aiwg-utils --bodies
aiwg rules inventory --scope catalog --activation bound --tier critical,high
```

`workspace` means the current repository/workspace and its user configuration;
it does not scan other repositories. `user` selects user configuration and the
user installation registry; `installation` lists configured capabilities and
`catalog` also includes available, unconfigured installation sources. Capability,
activation, tier, and provider filters compose. Provider filtering uses recorded
deployment configuration, not proof that the provider loaded a rule. Each row
separates canonical and effective activation, pin reasons, binding metadata,
and delivery/session-load evidence. Unknown delivery or loading stays unknown.
`--bodies` includes complete source content and fails if indexed installed bodies
are missing. The MCP `rule-inventory` tool exposes the same operation.
The inventory does not deploy or change configuration; generic CLI hooks and
opt-in command logging retain their existing settings.

Pin full rule bodies to every request without editing canonical activation:

```bash
aiwg rules pin <rule>... [--tier critical,high] [--capability id,... | --group name]
aiwg rules pin --capability aiwg-utils [--all-tiers]
aiwg rules pin --all
aiwg rules unpin <rule>...                 # also accepts the same selector flags
aiwg rules pinned [--capability id] [--json]
aiwg rules group set <name> <capability>...
aiwg rules group list [--json]
```

Mutation flags: `--project` (default), `--user`, `--dry-run`, `--no-deploy`,
`--json`, `--allow-over-budget`. No prompts are required. Comma-separated tier
and capability lists are supported. Tiers are `critical`, `high`, `medium`,
`low`; omitted tiers include every tier. Selectors match conjunctively within an
entry and disjunctively across entries. Overlapping matches deploy once.
`unpin` removes exactly a selector, independent of list order. Dry runs show
rules and per-provider startup bytes; budget failures preserve prior config and
deployment. See [operator rule pins](configuration/aiwg-config.md#operator-rule-pins)
for config shape, scope precedence, and budget behavior.

## `aiwg checkpoint` — workflow resume positions and session handoffs

```bash
aiwg checkpoint create --name t1 --phase construction --step tests \
  --artifact docs/plan.md --artifact src/feature.ts --note "Continue validation"
aiwg checkpoint create --handoff --name next-session \
  --scope "Checkpoint feature; next session owns verification" \
  --note "Implementation complete; tests pending" \
  --todo "Run focused tests" --todo "Review diff" --constraint "Do not commit or push"
aiwg checkpoint list [--json]
aiwg checkpoint recover [<id|name>] [--json]
```

`create` prints the new ID and saves lightweight JSON under
`<artifact_root>/checkpoints/<id>.json`. The root uses the same resolver as
`aiwg artifacts path`, including `AIWG_ARTIFACTS_PATH` and `.aiwg-location`.
Unavailable external roots fail without falling back to local storage.
All create options are optional; supplied options require values. The record
contains `id`, optional `name`, ISO `createdAt`, `cwd`, `gitHead` when available,
optional `phase`, `step`, `note`, and an `artifacts` array.

`list` shows newest first (`--json` returns an array, including `[]` when empty).
`recover` defaults to newest; an ID takes precedence over a name, and duplicate
names select the newest match. It prints the saved record and resume position
without changing repository files or restoring Git HEAD. `--json` returns the
record object. Empty recovery, unknown IDs, and missing option values fail
without prompting.

`create --handoff` saves `<artifact_root>/checkpoints/<id>/checkpoint.json`
with sibling `handoff.md` and `next-session-prompt.md`, recording their absolute
paths as `handoffPath` and `nextSessionPromptPath`. It renders the shipped
[handoff template](../agentic/code/addons/aiwg-utils/templates/checkpoint-handoff.md).
`--scope` fills Scope and ownership; phase, step, and note fill State at handoff;
repeatable `--todo` fills To do (ordered); repeatable `--constraint` fills Binding
constraints; artifacts fill Links. Missing context stays as `[TODO: ...]`
placeholders. Scope, todo, and constraint flags require `--handoff`; empty or
missing flag values fail headlessly. `--handoff` itself takes no value.

`list` marks handoff records in a Handoff column. `recover` prints their saved
next-session prompt text and both document paths, without writing anything.
JSON output retains the record format with the two paths. Existing flat
checkpoints remain readable. Workflow checkpoint records currently have inline
validation and no governed schema; other checkpoint schema families govern
different data.
