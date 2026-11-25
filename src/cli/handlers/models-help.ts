// Documents the existing model maintenance and resolution commands.
export const MODELS_HELP = `Usage: aiwg models <subcommand> [options]

Subcommands:
  list                         List discovered agent and skill model policies
  audit                        Compile selected policies and report diagnostics
  resolve                      Resolve artifact policies, or a direct worker invocation
  validate                     Validate selected artifact policies (not worker configuration)
  sources                      Show the effective model catalog without network refresh
  refresh                      Refresh model discovery (may access the network)
  set-default <TIER>           Write defaults.tier to models.json
  set --tier <TIER>            Update selected agent/skill frontmatter; requires a selector or --all
  migrate                      Add canonical role/tier hints to legacy skills

Artifact selectors and options:
  --agent <name>  --skill <name>  --glob <pattern>  --role <role>
  --tier <tier>  --framework <name>  --all
  --provider <provider>         Provider for artifact compilation (default: claude)
  --model <id>                  Explicit Grok Build model for artifact resolve
  --target <directory>         Artifact/project root (default: current directory)
  --propose <file>             Review pair edits (--parallelism/--worker-selection JSON files)
  --apply <file>               Apply with --authorize DIGEST or --standing-authorization FILE
  --recover                    Restore retained pair with the original authorization
  --scope project|user         set-default destination (default: project)
  --dry-run                    Preview mutations without writing
  --json                       Emit JSON (refresh: counts, cache path and warnings)
  --drift                      Include catalog drift for sources/refresh
  --url <url>                  Remote catalog URL for refresh
  --help, -h                   Show this reference
  TIER: economy | standard | premium | flagship (alias: max-quality)

Direct worker resolution (plans an invocation; does not launch it):
  aiwg models resolve --role <role> --task <class> --group <group>
    --brief <file> --workdir <tree> --final-output <file>
    [--transport shell|mcp] [--format json|shell] [--authorize-premium]
  --role                       efficiency | coding | reasoning | configured project alias
  --task                       Task class from defaults.workerSelection.taskClasses
                               Built-ins: inventory, implementation, architecture, review
  --group                      Group from parallelism.groups and the role's guidance
  --brief                      Absolute path to the task brief
  --workdir                    Absolute path to the worker tree
  --final-output               Absolute path for the final result
  --transport                  Must match group execution transport (default: shell)
  --format                     JSON plan or POSIX shell command (default: json)
  --json                       Alias for --format json
  --max-attempts <count>        Tighten total attempts, including the initial attempt
  --timeout-ms <ms>             Tighten the hard stop; positive multiple of 1000 (whole seconds)
  --max-output-tokens <count>   Tighten the existing task token budget (tokens)
  --max-usd <amount>            Tighten the task cost ceiling (costUsd)
                               Limits may only tighten resolved policy; larger values fail
                               JSON includes ceilings and their origins
  --authorize-premium          Authorize premium for this resolution only
                               Agents require explicit human confirmation of escalation

Use models sources --json or the refresh cachePath for the complete catalog.

Worker groups live in .aiwg/aiwg.config; role guidance lives in project-root models.json.
Configure both, then run aiwg doctor --probe-workers --qualify.
See docs/getting-started/worker-dispatch.md for a complete example.`;
