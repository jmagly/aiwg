// Keep discover usage shared between top-level help and the index alias.
export function printDiscoverUsage(): void {
  console.log(`Usage: aiwg discover [<phrase> | --stdin] [options]
       aiwg index discover [<phrase> | --stdin] [options]

  --stdin                  Read and trim the phrase from stdin; excludes positional text
  --type <kinds>           Filter comma-separated artifact types (e.g. skill,template)
  --limit N                Maximum results (default: 5)
  --json                   Emit JSON (--format json|text also supported)
  --pretty | --compact     JSON formatting (default: pretty)
  --graph <name>           Search a specific graph
  --backend local|fortemi-core
  --resource-source local|web|auto
  --aiwg-version <version|range|digest|channel>
  --offline                Require cached web resources
  --no-build               Read cached local metadata only
  --verbose, --debug       Show cache fallback diagnostics
  --help, -h               Show this help

Pass shell-sensitive requests with a quoted heredoc:
aiwg discover --stdin <<'AIWG_REQUEST'
<the request, verbatim>
AIWG_REQUEST`);
}
