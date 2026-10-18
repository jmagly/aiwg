# Artifact Index and Manifest Loading — Internals

> **Status**: Active — 2026.5.x
> **Companion to**: [`discovery-and-kernel-skills.md`](../discovery-and-kernel-skills.md) (operator-facing flow)
> **Reference**: epics [#1212](https://git.integrolabs.net/roctinam/aiwg/issues/1212), [#1217](https://git.integrolabs.net/roctinam/aiwg/issues/1217), [#1218](https://git.integrolabs.net/roctinam/aiwg/issues/1218), [#426](https://git.integrolabs.net/roctinam/aiwg/issues/426), [#726](https://git.integrolabs.net/roctinam/aiwg/issues/726), [#1044](https://git.integrolabs.net/roctinam/aiwg/issues/1044)

The discovery-and-kernel-skills guide explains *how to use* `aiwg discover` and `aiwg show`. This doc explains *where the data lives and how it gets there* — the index file layout, the manifest-driven graph configuration system, and the search/load pipeline. Read this when debugging stale results, adding a new graph, or implementing an integration that touches the index directly.

## Index file locations

Index artifacts are partitioned into **graphs**. Each graph has its own scan roots, file-type filters, and output directory. The output is always the same five files; the location depends on whether the graph is **shared** (one copy per machine) or **project-local** (one copy per workspace).

### Resolution rule

From `src/artifacts/types.ts:678` (`getGraphIndexDir`):

| Graph type | Output directory |
|---|---|
| `framework` (`shared: true`) | `$XDG_DATA_HOME/aiwg/index/framework/` (defaults to `~/.local/share/aiwg/index/framework/`) |
| Any other graph (`shared: false`) | `{cwd}/.aiwg/.index/<graph>/` |

The base name `.aiwg/.index` is the `INDEX_DIR` constant in `src/artifacts/types.ts:280`. Note the leading dot — the index directory is sibling to `.aiwg/` artifacts but hidden from `aiwg activity-log` style listings.

### The five files in every graph directory

| File | Contents |
|---|---|
| `metadata.json` | Per-node records — `id`, `type`, `path`, frontmatter, capability summary, triggers, kernel flag |
| `dependencies.json` | Edge list — `@`-mention graph and any derived references (extracted per the graph's `edgeExtraction` config) |
| `tags.json` | Inverted index from tag → node ids |
| `stats.json` | Counts by type/phase, graph-level metrics |
| `checksum-manifest.json` | Per-file SHA-256 hashes for incremental rebuild — only files whose hash changes get re-parsed |

### Built-in graphs

From `BUILTIN_GRAPH_CONFIGS` (`src/artifacts/types.ts:418`):

| Graph | `shared` | `defaultBuild` | Scan roots | Output |
|---|---|---|---|---|
| `framework` | `true` | `false` | `agentic/code/{frameworks,addons,extensions,agents,behaviors}`, `docs/` | `~/.local/share/aiwg/index/framework/` |
| `project` | `false` | `true` | `.aiwg/` | `.aiwg/.index/project/` |
| `codebase` | `false` | `true` | `src/`, `test/`, `tools/` | `.aiwg/.index/codebase/` |

The `framework` graph is **not** built by a default `aiwg index build` — that would have any project writing to the shared XDG location. It is built by:

1. `aiwg use` after deploying a framework (in `useHandler`, automatic — #1212/#1214)
2. `aiwg index build --graph framework` (manual rebuild)

The `project` and `codebase` graphs rebuild incrementally after every commit via the `post-commit-index-refresh` rule.

## Manifest-driven graph configuration

The set of graphs is not hard-coded beyond the three built-ins. Frameworks/addons can declare their own graphs in their `manifest.json`, and operators can declare graphs in `.aiwg/config.yaml`. The merge order is built-in → module-declared → user-declared; nothing can override a built-in name.

### Module-declared graphs

`loadModuleGraphConfigs()` at `src/artifacts/types.ts:548` walks the installed framework registry and merges any graphs the manifests declare:

```
.aiwg/frameworks/registry.json   ← which frameworks are installed (written by `aiwg use`)
        │
        ▼
agentic/code/{frameworks,addons}/<id>/manifest.json
        │
        │ index.graphs.<name> = { scanDirs, extensions, edgeExtraction, ... }
        ▼
GRAPH_CONFIGS[<name>]            ← merged into the runtime registry
```

First module wins on name collisions among modules. Built-ins are never overridden.

### User-declared graphs

`loadUserGraphConfigs()` at `src/artifacts/types.ts:625` layers `.aiwg/config.yaml` graph definitions on top. Operator config overrides module-declared graphs but still cannot override built-ins.

### Bundle manifests (project-local artifacts)

A separate Zod schema in `src/extensions/manifest.ts` validates project-local content bundles under `.aiwg/{extensions,addons,frameworks}/<name>/manifest.json` and marketplace delivery wrappers under `.aiwg/plugins/<name>/manifest.json`. This is the **bundle** manifest (a directory of artifacts), distinct from the **framework** `manifest.json` consumed by the graph-config loader above. Limits and rules:

| Constant | Value | Purpose |
|---|---|---|
| `MANIFEST_MAX_BYTES` | 64 KB | Upper bound on a single manifest |
| `MAX_BUNDLES_PER_PROJECT` | 200 | Cap on `.aiwg/{type}/*` count |
| `MAX_KEYWORDS_PER_MANIFEST` | 50 | Discovery keyword cap |
| `MAX_OVERRIDES_PER_MANIFEST` | 20 | Shadowing cap |

The bundle manifest schema is documented in `.aiwg/architecture/design-manifest-schema.md` (#1044). Validation is enforced by `aiwg list --project-local` and `aiwg doctor --project-local`.

### Safety-critical override flag

`src/extensions/upstream-registry.ts:92` reads `safety-critical: true` from each upstream bundle's `manifest.json` and emits a denylist. Project-local bundles cannot shadow safety-critical upstream artifacts without an explicit `overrides:` declaration (per `adr-override-shadow-policy.md`).

## File reference

Authoritative source paths for every piece of the index/manifest pipeline:

### Index core

| Concern | File |
|---|---|
| `INDEX_DIR` constant + path resolution | `src/artifacts/types.ts:280`, `:678` |
| Built-in graph configs | `src/artifacts/types.ts:418` |
| Module graph loading | `src/artifacts/types.ts:548` (`loadModuleGraphConfigs`) |
| User graph loading | `src/artifacts/types.ts:625` (`loadUserGraphConfigs`) |
| Index builder (walks scanDirs, writes files) | `src/artifacts/index-builder.ts` |
| Query engine (discover/show/query backend) | `src/artifacts/query-engine.ts` |
| Embedding index (optional vector search layer) | `src/artifacts/embedding-index.ts` |
| Index reader (low-level metadata.json loader) | `src/artifacts/index-reader.ts` |
| Hybrid query (graph + text + embeddings) | `src/artifacts/hybrid-query.ts` |
| Graph backends (graphology / json / sqlite) | `src/artifacts/backends/` |
| Watcher (incremental on filesystem events) | `src/artifacts/watcher.ts` |
| Checksum manifest format | `src/artifacts/checksum-manifest.ts` |

### Manifest validation and loading

| Concern | File |
|---|---|
| Bundle manifest Zod schema | `src/extensions/manifest.ts` |
| Per-artifact (Extension) schema | `src/extensions/validation.ts` |
| Upstream registry + safety-critical flag | `src/extensions/upstream-registry.ts` |
| Project-local bundle discovery | `src/extensions/project-local-discovery.ts` |
| Project-local doctor | `src/extensions/project-local-doctor.ts` |
| Framework registry (runtime state) | `.aiwg/frameworks/registry.json` |

### CLI dispatch

| Concern | File |
|---|---|
| Subcommand router (`build` / `query` / `discover` / `show` / `deps` / `stats` / …) | `src/artifacts/cli.ts:51` |
| `aiwg discover` top-level alias handler | `src/cli/handlers/subcommands.ts:1061` |
| `aiwg show` top-level alias handler | `src/cli/handlers/subcommands.ts:1120` |
| Command extension definitions | `src/extensions/commands/definitions.ts:972` (discover), `:1012` (show) |

## Search and load pipeline

```
 USER REQUEST
     │
     ▼
┌─────────────────────────────────┐
│ aiwg discover "<need>"          │   (or `aiwg show <type> <name>`)
└────────────────┬────────────────┘
                 │  top-level alias
                 ▼
   src/cli/handlers/subcommands.ts
     discoverHandler / showHandler
                 │  delegate
                 ▼
   src/artifacts/cli.ts
     switch(subcommand) → handleDiscover / handleShow / handleQuery / …
                 │
                 ▼
   src/artifacts/query-engine.ts
                 │  reads
                 ▼
┌──────────────────── METADATA SOURCES (merged) ─────────────────────┐
│                                                                     │
│  ~/.local/share/aiwg/index/framework/    ← shared, framework graph  │
│      metadata.json   dependencies.json   tags.json                  │
│      stats.json      checksum-manifest.json                         │
│                                                                     │
│  .aiwg/.index/project/                   ← per-project              │
│  .aiwg/.index/codebase/                  ← per-project              │
│  .aiwg/.index/<user-or-module-graph>/    ← optional                 │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                 ▲                                       ▲
                 │ written by `aiwg index build`         │ written by `aiwg use`
                 │ + post-commit hook (#964)             │ (post-deploy rebuild)
                 │                                       │
   ┌─────────────┴────────────┐         ┌────────────────┴─────────────┐
   │ src/artifacts/           │         │ Framework / addon manifests  │
   │   index-builder.ts       │ ◄scans─ │  agentic/code/{frameworks,   │
   └─────────────┬────────────┘         │   addons,extensions}/<id>/   │
                 │                      │   manifest.json              │
                 │ graph configs        │   + index.graphs.<name>      │
                 ▼                      └────────────────┬─────────────┘
   src/artifacts/types.ts                                │
     BUILTIN_GRAPH_CONFIGS                               │
     loadModuleGraphConfigs() ◄──────────────────────────┘
     loadUserGraphConfigs()  ◄── .aiwg/config.yaml
                             ◄── .aiwg/frameworks/registry.json
                             ◄── .aiwg/{extensions,addons,...}/<name>/
                                   manifest.json  (project-local bundles,
                                   validated by src/extensions/manifest.ts)
```

### Pipeline phases

1. **Graph config resolution** — `BUILTIN_GRAPH_CONFIGS` is the base; `loadModuleGraphConfigs()` merges manifests from installed frameworks; `loadUserGraphConfigs()` merges `.aiwg/config.yaml`. Each call writes into the shared `GRAPH_CONFIGS` object.
2. **Build** — `index-builder.ts` iterates `GRAPH_CONFIGS`, walks each graph's `scanDirs`, diffs file hashes against the previous `checksum-manifest.json`, and re-parses only the changed files. Writes the five JSON files into the resolved output directory.
3. **Query** — `query-engine.ts` loads `metadata.json` from one or more graphs, scores nodes against the query (keyword + capability + frontmatter tags), and returns ranked `{path, type, score}` envelopes. `aiwg discover` is this with a ranking emphasis; `aiwg show` is the same lookup followed by streaming the file body.
4. **Refresh** — Two triggers keep the index honest: post-commit rebuild for project/codebase graphs (incremental, fast), and post-deploy rebuild for the framework graph (triggered inside `useHandler`).

### Why agents never navigate the filesystem

Both `discover` and `show` return paths anchored to `$AIWG_ROOT` for framework artifacts and to `{cwd}` for project artifacts. Agents are required by the `skill-discovery` rule to fetch via `aiwg show` rather than reading the file path directly — this insulates them from layout changes (the kernel pivot in 2026.5 moved most skills out of provider-native directories, and the index made that invisible to callers).

## Common debugging entry points

| Symptom | First check |
|---|---|
| `aiwg discover` returns stale results | `aiwg index stats --graph <name>` to confirm timestamps; `aiwg index build --graph <name> --force` if recent edits aren't reflected |
| Discover returns nothing for a known skill | Confirm the skill's scanDir is in the graph's `scanDirs`; check `agentic/code/<framework>/manifest.json` `index.graphs` if a custom graph is expected |
| Framework graph empty after first install | `aiwg index build --graph framework` — confirm `~/.local/share/aiwg/index/framework/metadata.json` is non-empty |
| Project-local bundle not appearing | `aiwg doctor --project-local` (validates manifest); confirm content bundles are under `.aiwg/{extensions,addons,frameworks}/<name>/` and marketplace wrappers are under `.aiwg/plugins/<name>/` |
| Safety-critical denylist hit | `src/extensions/upstream-registry.ts` — confirm upstream `manifest.json` carries `safety-critical: true` and the project-local manifest lacks the required `overrides:` |

## See also

- [`discovery-and-kernel-skills.md`](../discovery-and-kernel-skills.md) — operator-facing usage guide for `aiwg discover` / `aiwg show`
- [`extensions/graph-backends.md`](../extensions/graph-backends.md) — graph backend selection (graphology / json / sqlite)
- [`configuration/setup-manifest.md`](../configuration/setup-manifest.md) — agentic-installer manifest (distinct from index/bundle manifests)
- [`project-local/manifest-reference.md`](../project-local/manifest-reference.md) — project-local bundle manifest reference
- `.aiwg/architecture/design-manifest-schema.md` — bundle manifest design (#1044)
- `agentic/code/addons/aiwg-utils/rules/skill-discovery.md` — the HIGH-enforcement rule that mandates discover-first
- `agentic/code/addons/aiwg-utils/rules/post-commit-index-refresh.md` — the rule that keeps project/codebase graphs current

## Scheduled index refresh

Run `aiwg index refresh --root ~/dev --json` to refresh workspaces containing
`.aiwg/` within four directory levels. The scan skips `node_modules`, `.git`,
worktree caches, and directory symlinks. Without `--root`, refresh uses the current
project; repeat `--workspace <path>` to select projects explicitly.

Refresh builds configured, existing, and default graphs incrementally, syncs
existing Fortemi Core caches, then discovers and imports existing session catalogs.
Session discovery uses only roots saved by an earlier authorized discovery;
`--full` rebuilds graphs and reindexes catalogs. Use `--only graphs|sessions|caches`
to narrow the work or `--dry-run` to inspect the plan without writes. Missing
SQLite support skips sessions with `aiwg features install sqlite` as the remedy.

A host lease prevents overlapping runs; `--lock-wait-ms <n>` optionally waits
(default: zero). A same-host dead PID lease is reclaimed. Checkpoints in
`$XDG_STATE_HOME/aiwg` (default `~/.local/state/aiwg`) resume matching interrupted
plans. The dispatch resource gate runs before each job, requiring at least 8 GiB
available memory and load per core at most 0.8, plus the dispatch PSI/disk limits
and any stricter project thresholds. A locked or resource-deferred run exits zero;
job errors exit nonzero. JSON reports use `contractVersion: "1.0.0"`, command
`index.refresh`, job outcomes and durations, and totals. Refresh does not deploy,
check for updates, log commands, or regenerate corpus views.

For a systemd user timer, save `~/.config/systemd/user/aiwg-index-refresh.service`
(replace `/home/you/.local/bin/aiwg` with the absolute path from `command -v aiwg`;
ensure Node 24 is on the service's PATH):

```ini
[Unit]
Description=Refresh AIWG indexes

[Service]
Type=oneshot
ExecStart=/home/you/.local/bin/aiwg index refresh --root %h/dev --json
```

Save `~/.config/systemd/user/aiwg-index-refresh.timer`:

```ini
[Unit]
Description=Refresh AIWG indexes hourly

[Timer]
OnCalendar=hourly
Persistent=true
RandomizedDelaySec=5m

[Install]
WantedBy=timers.target
```

Enable it with `systemctl --user daemon-reload` followed by
`systemctl --user enable --now aiwg-index-refresh.timer`. For cron, use a PATH
that includes AIWG and Node 24:

```cron
PATH=/home/you/.local/bin:/usr/local/bin:/usr/bin:/bin
17 * * * * aiwg index refresh --root ~/dev --json
```
