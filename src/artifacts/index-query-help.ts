// Public query help, including the source-body size policy for each backend.
export function printIndexQueryHelp(): void {
  console.log(`Usage: aiwg index query [text] [options]

Options:
  --fulltext                  BM25 search over source bodies
  --backend fortemi-core|local Search backend (default: fortemi-core)
  --graph <name>              Graph to search (default: project on Fortemi Core)
  --type <type>               Filter by artifact type
  --phase <phase>             Filter by phase
  --tags <tag,...>            Filter by tags
  --path <glob>               Filter by source path
  --updated-after <date>      Filter by update date
  --limit <n>                 Maximum results (default: 20)
  --semantic                  Semantic query mode
  --hybrid                    Fortemi Core hybrid query mode
  --json                      Machine-readable results
  --help, -h                  Show this help

--fulltext source sizes:
  Fortemi Core: searches text bodies captured at sync, without a size cap.
  Binary and unreadable sources remain metadata-only. Re-run 'aiwg index sync'
  to replace older caches that omitted bodies larger than 256 KiB.
  local: reads current source files at query time, without a size cap.
  Neither backend truncates text bodies by size during fulltext search.`);
}
