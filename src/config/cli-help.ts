// Documents the existing config commands and reviewed worker maintenance flags.
export function printUsage(): void {
  console.log(`Usage: aiwg config <subcommand> [options]

Subcommands:
  get <key>                       Read a user config value
  get --project <key>             Read a project config value or merged defaults.workerSelection
    [--origins]                  Include model policy sources, pointers and input digests
  set <key> <value>               Write a user config value
  set --project <key> <value>     Write a project config value (validates enums)
  list                Show all user config
  show --project      Show resolved project config and artifact root
  validate            Validate user config files
  validate --project  Validate resolved project config taxonomy/index semantics
    [--provider gitea|github|local] [--available-label NAME ...]
  reset [<key>]       Reset key or all config to defaults
  path                Print config directory path
  edit                Open config in $EDITOR/$VISUAL (requires a terminal)
  edit --print-path   Print the config file path instead of opening an editor
  authorization       Inspect/validate/preview/enable/revoke bounded HITL policy; list/show/search/explain/verify grants
  gitignore           Show/check/fix .gitignore AIWG entries

Reviewed worker policy pair (project scope, no prompts):
  set --project --parallelism FILE --worker-selection FILE --propose FILE
  set --project --apply FILE --authorize DIGEST
  set --project --apply FILE --standing-authorization FILE
  set --project --recover --authorize DIGEST
  --target DIRECTORY selects the project. Proposal inputs are JSON files.

Global flags:
  --config-dir <path> Override config directory

Examples:
  aiwg config get defaults.provider
  aiwg config set defaults.verbosity quiet
  aiwg config set updates.channel next
  aiwg config list
  aiwg config show --project
  aiwg config show --project --json
  aiwg config get --project delivery.mode
  aiwg config set --project delivery.mode pr-required
  aiwg config set --project delivery.merge_style squash
  aiwg config get --project parallelism
  aiwg config get --project defaults.workerSelection --origins
  aiwg config set --project parallelism.max_parallel_subagents 6
  aiwg config reset --project parallelism
  aiwg config validate
  aiwg config path
  aiwg config reset defaults.provider
  aiwg config --config-dir /custom/path list
  aiwg config gitignore
  aiwg config gitignore --fix
  aiwg config gitignore --check`);
}

