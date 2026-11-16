# Session Catalog CLI

`aiwg session` remains the provider launcher. Catalog management uses the
plural `aiwg sessions` namespace.

## Catalog location

The default catalog is `.aiwg/sessions/catalog.sqlite` in the inferred
AIWG/Git project root, or the canonical cwd when there is no project.
Override it with `--db <path>` (relative to cwd). `--workspace <path-or-id>`
selects a workspace within that catalog; it does not select a different database.
Read-only commands infer the workspace from an explicit `--workspace`, the
canonical current project root, a matching canonical cwd in the catalog, or
a sole catalog workspace, in that order. An empty catalog uses the canonical
cwd. Multiple unmatched candidates fail
with `WORKSPACE_AMBIGUOUS`; AIWG never chooses between them. Mutation commands
continue to require an explicit workspace. Install and verify the optional
SQLite runtime before using catalog commands:

```sh
aiwg features install sqlite
aiwg features info sqlite --json
```

The installer places the exact supported `better-sqlite3` release in AIWG's
user-owned feature root, allows only its required lifecycle script, and fails
unless the native module loads. Catalog commands resolve that feature root
before the base AIWG installation. If no compatible prebuild is available,
the package falls back to `node-gyp`; install Python 3, `make`, and a C/C++
compiler supported by your Node platform, then repeat the feature install.
`aiwg sessions doctor --json` reports `CATALOG_UNAVAILABLE` with the same
installer command when the package is absent or unusable.

Imports for another workspace remain in the selected catalog. The
`import-discovered` result names the database and gives a read-back command.
For example, after importing `/work/other` from `/work/project`, read the same
sessions from either directory with:

```sh
aiwg sessions list --workspace /work/other --db /work/project/.aiwg/sessions/catalog.sqlite
aiwg sessions show <native-session-id> --workspace /work/other --db /work/project/.aiwg/sessions/catalog.sqlite
```

From `/work/other` (without a project), `--db` is necessary: the default
catalog there is a separate `/work/other/.aiwg/sessions/catalog.sqlite`.
With the importing project's `--db`, the matching cwd selects `/work/other`
without `--workspace`, for `list`, `timeline`, and `search`.

`list` and `timeline` report `coverage.catalogScope`, including the selected
database, total visible sessions, other workspace IDs and their counts, and
a hint naming `--workspace` and `--db`. `show` and `search` report the same
information in `catalogScope`; a missing `show` includes it in error details.
Counts exclude tombstoned sessions and uncommitted imports. `list`, `timeline`
and `search` remain scoped to the selected workspace.

`show` accepts an internal `session_…` ID, an exact provider-native ID, or
a unique prefix of either. Exact IDs take precedence over prefixes. Without
`--workspace`, native references search the whole selected catalog, so the
importing project can show a uniquely identified imported transcript directly.
Internal `session_…` references retain the inferred workspace scope. Explicit
`--workspace` scopes all references. Ambiguous native IDs or prefixes return
`SESSION_AMBIGUOUS`, listing each candidate's internal ID, provider and workspace
in both text and JSON errors. Select `--workspace` or an internal ID from `list`.
When Claude subagent artifacts repeat the parent's native ID, a unique parent
takes precedence only when every other match is identified as a subagent by
the adapter's stored boolean metadata, within the same provider and workspace.

## Commands

```text
aiwg sessions sources [--expected-providers <comma-separated-ids>] [--json]
aiwg sessions discover --workspace <path>
                       [--expected-providers <comma-separated-ids>]
                       [--codex-root <authorized-path>]... [--muse-root <authorized-path>]
                       [--omp-root <authorized-path>] [--dsh-root <authorized-path>]
                       [--grok-root <authorized-path>] [--grok-active-sessions <path>]
                       [--hermes-root <authorized-path>]
                       [--manifest <path>] [--dry-run] [--json]
aiwg sessions import-discovered --workspace <path>
                                [--manifest <path>] [--confirm|--yes]
                                [--expected-providers <comma-separated-ids>]
                                [--resume] [--lock-wait-ms <n>]
                                [--dry-run] [--json]
aiwg sessions import <file> --source-id <id> [--workspace <id>] [--dry-run] [--json]
aiwg sessions import --from-dir <dir> [--source-id <prefix>] [--provider <id>]
                       [--workspace <id>] [--dry-run] [--json]
aiwg sessions list [--provider <id>] [--workspace <id>] [--tag <tag>]
                   [--limit <1..500>] [--cursor <opaque>]
                   [--min-coverage <0..1>] [--json]
aiwg sessions timeline [--workspace <id>] [--gap <duration>]
                       [--min-coverage <0..1>] [--json]
aiwg sessions show <session-id> [--workspace <path-or-id>] [--json]
aiwg sessions search <query> [--workspace <path-or-id>]
                     [--provider <id>] [--date-from <rfc3339>] [--date-to <rfc3339>]
                     [--participant <role>] [--model <id>] [--role <role>]
                     [--tool <name>] [--tag <tag>] [--entity <entity>]
                     [--sensitivity <class>] [--extraction-state <state>]
                     [--control-events exclude|include|only]
                     [--limit <1..500>] [--cursor <opaque>] [--json]
aiwg sessions extract [session-id] --workspace <id>
                      [--policy-version <semver>] [--min-confidence <0..1>]
                      [--dry-run] [--json]
aiwg sessions export plan --workspace <id> --out <selection.json>
                          <session-id...> [--json]
aiwg sessions export build --plan <selection.json> --out <directory>
                           [--shard-name <name.shard>] [--json]
aiwg sessions export verify --input <evidence.shard> [--json]
aiwg sessions export unpack --input <evidence.shard> --out <directory> [--json]
aiwg sessions candidates [--state <state>] [--json]
aiwg sessions review <candidate-id> <version> <state>
                     --reviewer <id> --reason <text>
                     [--acknowledge-security-risk] [--dry-run] [--json]
aiwg sessions promote <candidate-id> <version> --consumer <id>
                      --reviewer <id> [--confirm] [--dry-run] [--json]
aiwg sessions tag <session-id> <tag> [--dry-run] [--json]
aiwg sessions relocate <source-id> <file> [--dry-run] [--json]
aiwg sessions reindex (--workspace <path-or-id> | --all-workspaces)
                      [--db <catalog.sqlite>] [--dry-run] [--json]
aiwg sessions delete <session-id> [--confirm] [--dry-run] [--json]
aiwg sessions restore <session-id> [--dry-run] [--json]
aiwg sessions purge <session-id> [--confirm] --actor-class <class>
                    --reason-code <code>
                    [--dependent-action revoke|supersede|retain|origin_unavailable]
                    [--basis <text>] [--dry-run] [--json]
aiwg sessions audit --workspace <id> [--limit <1..500>] [--cursor <opaque>]
                    [--otel] [--json]
aiwg sessions analytics summary --workspace <id> [filters] [--json]
aiwg sessions analytics tool-calls --workspace <id>
                        [--group-by tool|session|provider] [filters] [--json]
aiwg sessions analytics escalations --workspace <id> [filters] [--json]
aiwg sessions analytics hitl --workspace <id> [filters] [--json]
aiwg sessions forensics timeline <session-id|query> --workspace <id>
                        --authorize-forensics [--markdown] [filters] [--json]
aiwg sessions forensics indicators --workspace <id>
                        --authorize-forensics [filters] [--json]
aiwg sessions forensics evidence <event-id|fact-id|candidate-id>
                        --workspace <id> --authorize-forensics [--json]
aiwg sessions doctor [--json]
```

Reindex requires an explicit `--workspace` or `--all-workspaces`. The latter
rebuilds search indexes and analytics for every workspace in the selected catalog;
it does not scan for other catalogs or discover provider histories. Use `--db`
to select a catalog outside the current project. These scope options cannot be
combined. JSON receipts include `operation`, `allWorkspaces`, and sorted
`workspaceIds`; dry runs list the same planned scopes with status `preview` and
do not rebuild indexes. An empty catalog reports `workspaceIds: []` when all
workspaces are selected.

`aiwg sessions list` returns sessions newest first by `updatedAt`, with session
IDs descending to break timestamp ties. Sessions without an update timestamp
appear last. `--limit N` returns the N most recently updated sessions; pass the
opaque `page.nextCursor` as `--cursor` with the same filters to continue through
older sessions.

## Discover and import a workspace history

Discovery scans only provider roots associated with the explicitly authorized
workspace. Claude, Cursor, and Factory have workspace-keyed local roots. Codex
rollouts use shared roots. Repeat `--codex-root` to authorize multiple roots,
or configure `sessions.codex_roots` in the workspace's `.aiwg/aiwg.config`:

```json
{
  "sessions": {
    "codex_roots": ["/home/operator/.codex/sessions", "./exported-codex"]
  }
}
```

Configured paths resolve relative to the workspace; CLI paths resolve relative
to the current directory. Both lists are combined and add to any defaults
separately authorized by `--provider-home <home>`: `<home>/.codex/sessions`,
`<home>/.codex/roles-runtime/*/.codex/sessions`, and `$CODEX_HOME/sessions` when
set. Without explicit roots or provider-home authorization, Codex remains
`SHARED_ROOT_AUTHORIZATION_REQUIRED`. Without `--provider-home`, only explicit
roots are scanned. Maintenance refreshes scan only the roots saved in the
manifest, including previously authorized role roots; new role roots and changes
to `$CODEX_HOME` require a new authorized discovery.

Canonical root aliases are scanned once. Matching Codex rollouts are deduplicated
by their `session_meta` ID (falling back to the filename UUID, then content digest).
The Codex provider's `rootCounts` reports each root's status, retained
`sourceCount`, and skipped `duplicateCount`; counts apply after workspace matching.
Unavailable roots have zero counts. Root reports redact paths and include
a `rootId` hash to distinguish roots with the same leaf name; exact roots remain
in the persisted manifest's `authorizedRoots`.

OMP and DeepSeek Harness also require an
explicit authorized root through `--omp-root` or `--dsh-root`. Harness imports
raw v2 JSONL; compressed histories require a reviewed raw export. Grok Build
requires `--grok-root` (native `chat_history.jsonl` discovery, synthetic v1
schema) with optional `--grok-active-sessions` for live detection; Hermes
requires `--hermes-root` (read-only `state.db` backup snapshot, needs Hermes
running and the optional sqlite backend). Providers that
require an API or manual
export remain visible as `export-required`.

Codex, Muse, and OMP match recorded workspace/cwd evidence to the workspace
itself or its subfolders after resolving symlinks, using directory boundaries
(`/work/foo` does not include `/work/foobar`). Linked Git worktrees outside the
workspace are also included by default when their `.git` file, reciprocal
`gitdir`, and `commondir` identify the main repository's `.git` directory inside
the workspace. Missing cwd paths cannot establish a match, and unresolved Git
metadata cannot establish worktree attribution. Provider root authorization
still applies.

Discovery runs one workspace at a time. A directory containing its own
`.aiwg/sessions` directory owns its subtree: enclosing workspaces exclude those
sessions, so the deepest initialized catalog wins. Initialize nested catalogs
before discovering their parents. A catalog enclosing the physical worktree
takes precedence over attribution to a separate repository workspace. When a
catalog encloses both paths, a deeper catalog enclosing the main repository
owns its worktree sessions. This rule uses the conventional catalog directory
even when `--db` selects an external database.
The discovery JSON includes `matchedBySubfolder` and `matchedByWorktree` in each
provider report and in public `totals`, counting selected sources after
deduplication. Exact matches are included in `sourceCount` but not these two
counts. Muse inspection receipts also include `matchKind` for positive matches.

```sh
aiwg sessions discover --workspace "$PWD" --codex-root ~/.codex/sessions --json
aiwg sessions import-discovered --workspace "$PWD" --dry-run --json
aiwg sessions import-discovered --workspace "$PWD" --confirm
```

Discovery writes `.aiwg/sessions/discovery-manifest.json` by default. The
manifest binds canonical workspace identity, provider dispositions, source
IDs, sizes, timestamps, and SHA-256 content digests. Public output redacts
source locators. `import-discovered` reads that exact manifest and refuses a
workspace or source-content mismatch. `--confirm` is the interactive/scripted
confirmation; `--yes` is the documented non-interactive equivalent.

For a fresh rebuild, retain both the old catalog and its saved manifest, and
select a separate destination:

```sh
aiwg sessions import-discovered --workspace "$PWD" \
  --manifest /scratch/saved-discovery-manifest.json \
  --carry-forward /scratch/old-catalog.sqlite \
  --db /scratch/rebuilt-catalog.sqlite --confirm --json
```

`--carry-forward` opens the old catalog read-only. It refreshes saved source
fingerprints and reimports available files using current import limits,
exclusions, redaction, and provider identity rules. Sessions whose files are
missing, or whose exact locators are no longer available in the manifest, are
recovered from committed stored events. Keep the original manifest: catalog
locators are redacted and cannot locate files by themselves. An available file
that fails current import policy is reported as rejected; it is never silently
replaced with its old catalog content. Correct the rejection and repeat the
same rebuild into the same destination.

Every carried string passes through the current redaction gate. Codex child
identity is recovered from the first stored rollout metadata and lineage;
phantom parent rows and duplicate Codex native IDs are consolidated. FTS,
session intent, and analytics are regenerated from sanitized events, with no
old search or analytics content copied. Tags also pass through current
redaction. Repeating the rebuild is idempotent. The JSON receipt includes
`carryForward.byProvider` session counts for `reimported`, `carried`,
`droppedAsDuplicate`, and `excluded`. Keep the old copy until rejected sources
are resolved and counts and redaction scans have been checked.

Claude discovery checks project directories for subfolders and linked
worktrees using transcript `cwd` and nearest-workspace ownership (#324).
The exact mapping is `<provider-home>/.claude/projects/<claudeProjectKey(cwd)>`:
non-alphanumeric characters other than hyphens become hyphens, and long keys
use the existing 200-character/hash rule. Since these keys are lossy, AIWG
checks `cwd` rather than decoding the directory name. A nested catalog owns
its subtree; transcripts without `cwd` retain only the exact-project fallback.
The saved manifest records the exact selected project directories and sources.

A batch has a deterministic run ID and durable per-source dispositions.
Sources are staged and remain invisible to list, search, extraction, and
timeline reads until every source reaches a terminal disposition. One short
publication transaction exposes all accepted sources together. A cancelled or
failed process leaves a resumable run; repeat `import-discovered --resume
--confirm` to process only incomplete or rejected sources. Repeated resume is
idempotent.

Batch receipts and newly saved runs use schema `2.0.0`. A finished run reports
`run.status: complete` when all discovered sources were accepted (including
duplicates and previously committed sources), even if other providers are
unavailable or require exports. Rejected or skipped sources make the run
`partial`; pending work leaves it `interrupted`. An empty manifest completes
acquisition unless an explicitly expected provider remains unresolved.
When discovery used `--expected-providers`, unresolved providers in that saved
scope also make the run `partial`.

Single and batch imports acquire `<catalog>.import.lock`. The lease records run
ID, PID, host, start time, heartbeat, and (on Linux) boot ID and process start
ticks to distinguish a reused PID. A second writer waits up to
`--lock-wait-ms` (default 5000) and then returns `IMPORT_LOCKED` with safe owner
metadata and recovery guidance. A same-host lease is reclaimed immediately when
its process is confirmed dead or its recorded process identity no longer matches.
Live or unverifiable owners and foreign-host leases are never broken automatically.
After acquiring the lease, either import command marks orphaned `running` batch
runs as `interrupted` and records `interruptedAt` (the recovery timestamp). The
batch receipt's `interruptedRuns` lists their run IDs and timestamps; single-source
imports report the same list beside `receipts`. A resumed batch retains
`run.interruptedAt` after completion. WAL readers remain available while an
importer owns the lease.

### Intake-directory batch import

Single-file `import` covers one provider export at a time. When an intake
directory accumulates several exports -- for example repeated Claude.ai
account downloads -- import them in one pass with `--from-dir`:

```sh
aiwg sessions import --from-dir ./claude-intake \
  --provider claude --source-id claude-admin --workspace default --json
```

`--from-dir` extends `sessions import`; it adds no new top-level command.
Files are processed in sorted order. Every recognised file (`.json` or
`.jsonl`) imports through the same single-file path, with `--source-id` as
an optional per-file prefix (`claude-admin/<filename>`). Files already
imported are skipped by content digest; unrecognised files are skipped with a
reason; failures are reported per file without stopping the rest. The receipt
holds one entry per file plus a `summary` (`total`, `imported`,
`alreadyImported`, `skipped`, `rejected`, inserts). Repeating the batch
imports nothing. `--dry-run` previews the file plan without writing.

The full operator journey -- export download, single and batch import with
exact commands and expected receipts, read-back, and shard export -- is
walked through in [Claude admin intake
walkthrough](../providers/claude-code-sessions.md#claude-admin-intake-walkthrough).

## Coverage and timeline

`list` and `timeline` include coverage schema `2.0.0`. Coverage distinguishes
checked, unavailable, export-required, and not-checked providers and reconciles
discovered, accepted, rejected, skipped, duplicate, previously committed, and
pending sources. It also reports event/session totals, source/import date
ranges, manifest age, stable rejection counts, and remediation commands.
Status is `complete`, `partial`, `stale`, or `unknown`. The independent
`acquisitionStatus` is `complete`, `partial`, or `unknown`; database/index health
is reported separately by `doctor`, and semantic review is `not-assessed`.
`coverage.unresolvedProviders` lists provider gaps independently of acquisition.
`coverage.status` retains the broader provider/runtime coverage assessment and
manifest freshness, so it can remain `partial` or `stale` after a complete
acquisition. Installation drift affects that coverage assessment independently
of source acquisition.

Use `--expected-providers claude,codex,muse` on `sources` and `discover` to declare
the authorized investigation scope independently of the running adapter registry.
Unknown provider IDs are retained as `missing-adapter` entries, not discarded.
Without this flag the declared canonical provider set is inventoried; unresolved
providers remain visible without making source acquisition partial. Supplying
the flag on `import-discovered` must match the saved scope; changing it requires
new discovery.

`preflight` records expected/supported sets, runtime version, loaded package root,
executable and installation identity, plus one coverage disposition per expected
provider. The manifest identity binds this preflight; batch runs retain discovery
runtime identity and recheck the current import runtime. Missing adapters or
installation drift require deliberate runtime selection or a supported authorized
export, never an automatic upgrade or source switch. Old manifests remain readable
but cannot prove complete provider coverage without a new explicit preflight.
Stored `1.0.0` runs remain readable; coverage is calculated using the `2.0.0`
semantics, and replay saves the run with the new version.

Unavailable/unauthorized roots, missing exports, zero sources, empty/rejected
imports and omitted scope remain provider coverage gaps. They keep acquisition
partial when those providers are explicitly expected; rejected, pending or
skipped sources always keep acquisition partial. Muse's explicit `--muse-root`
discovery covers matching parent logs only: nested subagent logs and full
approval-review scope remain unresolved even when parent import succeeds. A source
coverage ratio of 1 does not establish complete provider or session-tree coverage.

Use `--min-coverage 0.95` in an audit or CI job. A lower or unknown ratio emits
`COVERAGE_BELOW_THRESHOLD` and exit code 8 while retaining the coverage report
in the JSON envelope.

`timeline` derives activity segments without changing canonical session
identity:

```sh
aiwg sessions timeline --gap 30m
aiwg sessions timeline --workspace /work/project --gap 6h --json
```

Segments sort across providers by absolute time and show provider, session ID,
start/end, duration, event count, boundary basis, and confidence. Explicit
provider pause/resume/continuation evidence takes precedence over inferred
gaps. Durations accept `ms`, `s`, `m`, `h`, or `d`.

Historical lifecycle inference uses a timezone-safe 24-hour inactivity
threshold by default. Set `--inactivity-threshold 12h` (or another duration)
on `import` or `import-discovered` to configure it for that run. Later
continuation or resume evidence can revise an earlier inferred inactive state;
explicit provider lifecycle evidence always takes precedence. When provider
records have no timestamps, AIWG uses the authorized source file's modification
time as content-free lifecycle evidence rather than treating every historical
session as currently active.

## User intent and control events

Normalized events retain provider bootstrap, workspace instructions, and tool
control data for provenance, but classify origin separately. Session intent is
derived only from the first confidently user-authored message; ambiguous
content remains `unknown` and native provider titles are not used as intent.

Search and extraction exclude control events by default. Search can opt into
all events or control-only evidence:

```sh
aiwg sessions search "bootstrap term" --control-events include
aiwg sessions search "control term" --control-events only
```

Generic imports accept only the declared, versioned AIWG interchange. Provider
logs are never modified. `delete` previews by default and only tombstones the
AIWG-owned normalized session after `--confirm`.

## Tombstone and purge

`delete` is reversible: it hides the session from list, search, extraction, and
health counts without removing provider logs or AIWG event rows. `restore`
returns that catalog copy to active service.

`purge` is terminal for the selected AIWG-owned session copy and previews by
default. Its plan counts sessions, events, search-index rows, embeddings,
candidates, snapshots, tags, and promoted dependents. Confirmation requires an
actor class and reason code. When promoted dependents exist,
`--dependent-action` and `--basis` are also mandatory; the explicit disposition
is recorded as `revoke`, `supersede`, `retain`, or `origin_unavailable`.

The committed transaction removes normalized events, FTS rows, tags,
candidates, and candidate receipts, then performs orphan checks. The retained
deletion receipt contains only opaque operation/dependent IDs, layer counts,
actor/reason classifications, outcome, time, and orphan counts—never transcript
content, source paths, or stable content hashes. Retrying after completion
returns the same terminal receipt. Provider-owned logs are never opened or
modified by tombstone, restore, or purge.

## Mutation audit

Every committed catalog mutation emits a versioned, content-free event in the
same SQLite transaction as its state change. Import event time and observation
time remain distinct. Events identify only safe workspace/target classes,
operation and correlation IDs, bounded counts, outcome, schema/policy/adapter
versions, resource, and instrumentation scope. They never contain transcript
text, prompts, candidate assertions, review reasons, native payloads, source
paths, or destination content.

`sessions audit` requires an explicit workspace and uses checksummed keyset
pagination. Cursors cannot be replayed against another workspace. Integrity
digests are verified on every read. `--otel` maps the same envelope to the
OpenTelemetry Logs data-model shape without adding an OpenTelemetry runtime
dependency.

Transcript content, mutation audit, skill-usage telemetry, and orchestration
telemetry remain separate physical stores and retention classes. Mutation audit
uses the catalog lifecycle and is retained until an operator applies the
catalog retention/disposal policy; transcript purge does not silently remove
its content-free accountability record. Skill-usage JSONL follows its own
documented rotation policy, while orchestration telemetry remains governed by
the service telemetry configuration.

## Analytics and forensic evidence

Session import maintains a versioned, content-free analytics index in the same
catalog transaction boundary as normalized events. Repeated import is
idempotent. `reindex` deterministically rebuilds both FTS and analytics facts;
tombstone, restore, and purge remove or restore derived facts with the session
lifecycle.

The `analytics` views report tool calls/results, retry groups, escalation
decisions, HITL decisions, lifecycle boundaries, and indicators. Filters compose
over provider, workspace, session, date range, tool, status, participant/actor,
tag, sensitivity, and extraction state. Escalation status distinguishes
requested, granted, denied, timed-out, unsupported, and provider-unknown.
Three or more closely repeated calls with the same normalized tool/input
identity emit the `tool-quota-pressure` indicator, matching the repository's
tool-quota loop semantics.

Facts contain stable citations to normalized event, import run, source, and
safe locator-class identity. They never store transcript text, command
arguments, URLs, secret values, or native payloads. Provider extensions are
already allowlisted/redacted before classification; opaque or malformed
extensions yield indicators rather than executable content.

Import redacts credential patterns in all canonical string fields and object
keys before persistence or indexing. Events record classification counts in
`extensions["native.redaction"].decisions` as `{ classification, count }` entries;
matched values are never recorded. Native content, including attachment byte
arrays and data URLs, is replaced by policy markers. Export omits these removed
attachments and does not reopen redacted file URLs. Separately registered output
files retain their explicit export workflow.

Forensic views require `--authorize-forensics` on every invocation. This is an
explicit local-operator authorization boundary, not a persistent preference.
Timeline and indicator output is reconstructed from cited normalized facts.
Evidence output returns bounded normalized metadata and removes candidate
quotes. Historical commands, URLs, payloads, and instructions are never
executed or replayed.

`--markdown` emits a sanitized, investigator-friendly timeline table suitable
for incident review or handoff to the AIWG forensics framework. JSON remains
the stable automation contract. Both formats retain evidence IDs so an
authorized operator can inspect the corresponding normalized catalog event.

The initial derived schema is `1.0.0`. Provider-specific fields remain under
the existing `native.<provider>` envelope, while analytics classifications are
provider-neutral. HITL facts may link prompt type and task/session transition;
approval workflow routing remains owned by #1565.

## Search authorization and citations

Search uses SQLite FTS5 over policy-approved normalized text. `--workspace` is
required so authorization scope is applied before matching, scoring, or
snippet generation. `--provider` can narrow that scope further. Metadata
filters are combined with the lexical query.

Every hit carries a stable citation containing provider, session, event,
import-run, source, and source-locator-class identity. Snippets contain only
the already-redacted normalized text. Tombstoned sessions, staged imports, and
records outside the authorized workspace/provider scope cannot contribute hits
or snippets.

Search cursors are opaque snapshots. A cursor fixes the maximum visible event
row for the query, so imports committed between pages do not reorder or insert
hits into the active traversal. Start a new search without the cursor to
include newly imported events.

Terms, quoted phrases, Unicode tokens, prefixes (`term*`), and explicit boolean
operators use FTS5 query syntax. Malformed syntax returns the stable
`INVALID_SEARCH_QUERY` contract error without database error text. Results use
FTS5 relevance with event ID as the deterministic tie-breaker. Bounded snippets
place `⟦` and `⟧` around matching context.

`--participant` identifies a normalized actor, while `--role` identifies the
message role. Tool name/call ID, model, entity, and extraction-state filters
read normalized event fields only; provider-native extension keys cannot
satisfy them. Citations include native event identity when supplied by the
provider and never expose unsafe source locators.

Session-list cursors are opaque, checksummed keyset cursors bound to the
workspace/filter scope and catalog snapshot. They are not numeric offsets.

## Candidate extraction and review

`extract` consumes only normalized, redacted events from the explicitly named
workspace. The built-in structural extractor recognizes fixed labels such as
`Decision:`, `Requirement:`, `Risk:`, `Entity:`, and
`Relationship: subject | predicate | object`. Transcript text remains inert
data: it is never evaluated as a command, tool request, URL, template, or
workflow.

Extractor output is validated with a strict schema and the same hostile-content
policy is applied to structural and model-based extractors. Every candidate
separates its proposed assertion from the exact redacted evidence quote, span,
and digest, and includes extractor/policy versions, confidence, sensitivity,
project/temporal scope, typed security warnings, and conflict/supersession
links. Uncited, out-of-scope, unsupported-by-evidence, malformed-span,
unknown-field, or relationship-incomplete output is rejected before
persistence.

Candidates begin in `pending`. Supported review transitions are:

```text
pending  -> accepted | rejected | deferred
deferred -> pending | accepted | rejected
accepted -> superseded
promoted -> superseded
```

Each review transition requires a reviewer and reason and creates a content-free
receipt. `accepted -> promoted` is reserved for the promotion gateway and its
destination receipt. Rejected and superseded versions are terminal. Extraction and review
do not write durable memory; `durableMemoryWrites` remains zero. Repeating an
unchanged extraction returns the existing candidate version, while changed
content under the same evidence identity creates a new pending version.
Candidates with instruction-like, structure-breaking, active-content, secret,
control-character, bidirectional-control, or mixed-script-confusable warnings
cannot be accepted without `--acknowledge-security-risk`. The receipt records
only warning categories and the acknowledgment decision, never the hostile
payload.

`promote` requires an exact accepted candidate version and a named consumer
whose manifest declares an `.aiwg/` memory topology. It previews by default,
showing the destination, before/after hashes, evidence event IDs, conflicts,
supersession links, and a confirmation-bound operation ID. `--confirm` writes
the derived memory page and records the source-event → candidate → destination
lineage receipt. Repeating the same promotion returns the original receipt as
a duplicate and does not write again. Unreviewed candidates are never promoted
automatically. Promotion rechecks suspicious-content acknowledgment and writes
the assertion as encoded, explicitly untrusted data; transcript frontmatter,
Markdown, HTML, links, controls, and bidirectional text cannot alter the
destination document structure.

## Optional semantic and Fortemi integration

`SessionSearchService` keeps lexical SQLite/FTS5 search as the standalone
default. Hybrid retrieval is opt-in and uses a two-step contract:

1. `preview(options, backend)` reports the exact workspace, backend, approved
   candidate count, text-transfer status, and whether network/model use occurs.
2. `search(...)` requires approval carrying that preview's operation ID.

The operation ID covers the query digest and every authorized candidate event
ID. A scope, lifecycle, or candidate-set change invalidates prior approval.
Only normalized, classified, redacted events that pass workspace and metadata
filters are offered to a backend. Returned IDs are checked against that
allowlist before fusion, so stale, deleted, or cross-workspace candidates
cannot become hits. Omitting the backend or selecting lexical mode performs no
model/network work.

`FortemiSessionBackend` is capability-gated. It remains unavailable until
Fortemi provides source-addressed upsert, typed metadata predicates, and
evidence locators (Fortemi issues 1090–1092); this does not block local search.
Its injected client boundary supports conformance tests without starting a
service.

`convertSessionEventsToKnowledgeShard()` exports approved event text and stable
evidence metadata through the internal Knowledge Shard v1 boundary. This is an
in-memory, differently-versioned helper (`knowledge-shard-v1`, contract
`1.0.0`) that never calls `@fortemi/core` -- it does not produce a real
`.shard` archive. Its conversion report includes typed losses for
provider-native extensions and raw byte or sequence locators that v1 cannot
represent. Callers must inspect `lossless` and `losses`; a record count match
is not a claim of parity.

## Native session-to-Fortemi shard export

`aiwg sessions export` produces a real, portable `.shard` archive built by
`@fortemi/core`'s `aiwgFortemiIndexToKnowledgeShardWithReport` -- a different,
later capability from the in-memory helper above. It is a four-step, plan-then-build
workflow so a selection is reviewable before any archive is written, and a
plan generated today is rejected at build time if the underlying session data
has changed since (`SCHEMA_DRIFT`), rather than silently exporting stale data.

```sh
# 1. Import a source (see "Discover and import a workspace history" above,
#    or a Claude web/account export -- docs/providers/claude-code-sessions.md).
aiwg sessions import ./transcript.jsonl --provider claude --source-id my-project

# 2. Find the session ids to export.
aiwg sessions list --workspace default --json

# 3. Plan the export: binds an exact selection to source/event digests, and
#    discovers any registered analysis outputs (aiwg.output-registration.v1)
#    associated with the selected sessions.
aiwg sessions export plan --workspace default \
  --out selection.json \
  session_<id-1> session_<id-2>

# 4. Build the archive. Written atomically (temp file + rename) with a
#    receipt written only after a successful readback, so an interrupted
#    write can never be mistaken for a completed export.
aiwg sessions export build --plan selection.json --out ./export

# Opt in when locally available attachment and registered-output bytes must be
# portable too. Each attachment is bounded to 64 MiB by default.
aiwg sessions export build --plan selection.json --out ./export-with-bytes \
  --include-bytes --max-attachment-bytes 67108864

# 5. Verify -- cross-checks the shard against its receipt.json when present.
aiwg sessions export verify --input ./export/evidence.shard

# 6. Recover -- writes the shard's full record graph back out as JSON.
#    This does not re-import into a session catalog; it recovers the
#    portable record graph to disk for inspection or downstream tooling.
aiwg sessions export unpack --input ./export/evidence.shard --out ./recovered
```

This exact sequence -- import, list/search selection, plan, build
(`--include-bytes`), verify, unpack with byte-exact attachment recovery --
runs offline against the packaged CLI (`node bin/aiwg.mjs` in a mkdtemp
workspace) in
`test/unit/cli/handlers/sessions-export-packaged.test.ts`, reusing the
`claude/web-export.json` fixture. The same file covers the negative paths:
a missing attachment, digest drift after planning (`SCHEMA_DRIFT`), and an
existing shard or recovery without `--force` (`OUTPUT_EXISTS`). Three
further offline negatives -- a generic-interchange source, an interrupted
shard write, and a malformed plan profile -- run in-process against the same
handler in `test/unit/cli/handlers/sessions-export-negatives.test.ts`.

What the archive contains: one `aiwg.session` record per selected session,
one `aiwg.session-event` record per event (linked to its parent session via a
`parent-session` relationship), and one `aiwg.session-output` record per
registered analysis output matched to a selected session (#2566). Session
event text, identifiers (native session/event id, source id, provider,
model, tool-call id), and timestamps are preserved and verified lossless by a
build/recover round-trip test against the real `@fortemi/core` library.

Byte embedding requires `--include-bytes`. New imports remove provider-native
attachment payloads and file URLs before storage; export omits those removed
attachments. Registered outputs remain reference records with their locator,
digest, and media type by default. With `--include-bytes`, registered-output
files and available legacy catalog attachments are packed into the native
`blobs/<blake3>` sidecar and linked from the owning Fortemi note.
Remote URLs are never fetched. Build re-hashes every selected output and local
attachment against the reviewed plan, rejects drift, rejects symlinks and
paths outside the project, and enforces `--max-attachment-bytes` (64 MiB by
default). `export unpack` verifies each sidecar's size and BLAKE3 digest and
recovers it beneath `attachments/<record-id>/`.

Export destinations are non-overwriting by default. Repeating a build against
an existing shard or receipt fails with `OUTPUT_EXISTS`; `--force` is required
to replace them. The same rule applies to recovered `index.json` and attachment
files during unpack.

### Archive profile: full-v1/2.0.0

The built archive's manifest declares `profile: "full-v1"`, `version:
"2.0.0"` -- the same declared target #2564 asked for, and the same function
AIWG's own artifact-index shard export (`src/artifacts/fortemi-shard-export.ts`)
uses for its `full-v1` tuple (`aiwgFortemiIndexToKnowledgeShardWithReport`).

An earlier version of this mapping used ad-hoc `facets`/`compatibility`
fields to carry AIWG-specific bookkeeping (provider, lifecycle, kind, role,
native ids, model, sequence, ...). The strict full-v1 converter refuses to
produce an archive at all (`success: false`) for fields it doesn't recognize
as a native component -- so that shape only ever built against the more
permissive `core-v1` path, which silently embeds the whole input record
verbatim as opaque note metadata regardless of whether it maps to anything.

The mapping now represents that same bookkeeping through fields the
converter genuinely understands: `tags` (`provider:claude`, `kind:message`,
`entity:<name>`, ...) and `provenance_events` (native ids, model, sequence,
etc. carried in each event's `attributes` bag). Every build reports
`lossless`/`losses` directly from `@fortemi/core`'s own conversion report
(`result.lossless`, `result.losses`) in the receipt -- not asserted, read.

**Recovery caveat**: `@fortemi/core`'s own `aiwgFortemiIndexFromKnowledgeShard`
only recovers archives built by the plain (`core-v1`) converter -- it looks
for the opaque `aiwg_fortemi_index` metadata blob that converter embeds,
which the strict full-v1 converter deliberately does not write (even AIWG's
own artifact-shard-export test round-trips through that function using
`profile: "core-v1"` specifically). `export verify`/`export unpack` use a
purpose-built reader (`src/sessions/fortemi-shard-recovery.ts`) that inverts
this module's own mapping directly from the shard's native `notes.jsonl`,
`links.jsonl`, and `provenance_activities.jsonl` files instead.

A `full-v1` archive has no per-archive AIWG metadata sidecar, so there is no
native place to carry the index-level wrapper's `source.repo`/`privacy`
fields. The mapping closes that gap with a synthetic
`aiwg.session-catalog-export-manifest` record (`EXPORT_MANIFEST_RECORD_ID`,
sorts last as `zzz-...` so it never collides with real session/event ids)
that carries `source.repo`/`privacy`/`generatedAt` through the same
`provenance_events[].attributes` mechanism every other record uses. The
recovery reader extracts that record, restores the index-level wrapper from
it, and excludes it from the recovered `items` -- it is bookkeeping, not a
session, event, or output. Every record's own identity, source, privacy,
tags, relationships, and provenance round-trip exactly -- verified by
`test/unit/sessions/fortemi-shard-recovery.test.ts` and a full CLI
`plan -> build -> verify -> unpack` smoke test against a rebuilt `dist/`.

### Support matrix

Only combinations backed by an actual test run in this codebase are listed
as supported; everything else is unverified, not assumed to work.

| Combination | Status | Evidence |
|---|---|---|
| Packaged CLI (`node bin/aiwg.mjs`, built by `npm run build:cli`) in a mkdtemp workspace: import -> list/search select -> `export plan/build --include-bytes/verify/unpack`, exact attachment set recovered | Verified | `test/unit/cli/handlers/sessions-export-packaged.test.ts`, reusing the `claude/web-export.json` fixture |
| Missing attachment, digest drift after planning, existing shard/recovery without `--force` | Verified (fail closed) | `test/unit/cli/handlers/sessions-export-packaged.test.ts` (`SCHEMA_DRIFT`, `OUTPUT_EXISTS`); stale-plan, tag-drift, and corrupt-shard paths in `test/unit/cli/handlers/sessions-export.test.ts` |
| Claude local JSONL/hook -> `export plan/build/verify/unpack` | Verified | `test/unit/cli/handlers/sessions-export.test.ts`; packaged-CLI journey in `test/unit/cli/handlers/sessions-export-packaged.test.ts` |
| Claude web/account `manual-export` -> `export plan/build/verify/unpack` | Verified | same two test files, using the `web-export.json` fixture |
| Registered output lineage (#2566) included in the built shard | Verified | `test/unit/sessions/output-lineage.test.ts`, `test/unit/cli/handlers/sessions-export.test.ts` |
| Built shard is a genuine, lossless `full-v1`/`2.0.0` archive (`@fortemi/core`'s own conversion report) | Verified | `test/unit/sessions/fortemi-export-mapping.test.ts`, `test/unit/cli/handlers/sessions-export.test.ts` |
| Built shard recovers exactly via the purpose-built full-v1 reader (not `aiwgFortemiIndexFromKnowledgeShard`, which only supports `core-v1`) | Verified | `test/unit/sessions/fortemi-shard-recovery.test.ts` |
| Index-level wrapper (`source.repo`/`privacy`) recovered from a `full-v1` archive via the synthetic export-manifest record | Verified | `test/unit/sessions/fortemi-shard-recovery.test.ts`, `test/unit/cli/handlers/sessions-export.test.ts`, `test/unit/cli/handlers/sessions-export-packaged.test.ts` |
| Codex -> `export plan/build/verify` | Verified | `test/unit/cli/handlers/sessions-export.test.ts`, using the `codex/threads.app-server.jsonl` fixture |
| OpenCode -> `export plan/build/unpack` with provider-native attachment payloads omitted by import policy | Verified | `test/unit/cli/handlers/sessions-export.test.ts`, using the `opencode/complete.json` fixture (plan carries zero attachments; no `attachments/` directory is recovered) |
| Registered-output bytes embedded with `--include-bytes` and recovered exactly | Verified | `test/unit/cli/handlers/sessions-export.test.ts`; packaged-CLI journey in `test/unit/cli/handlers/sessions-export-packaged.test.ts`; native BLAKE3 blob sidecars validated by `@fortemi/core` |
| Generic interchange (`generic` manual-export) -> `export plan/build/verify/unpack` | Verified | `test/unit/cli/handlers/sessions-export-negatives.test.ts`, using the `generic/valid-v1.jsonl` fixture |
| Interrupted shard write leaves no partial shard or receipt; a re-run succeeds | Verified (fail closed) | `test/unit/cli/handlers/sessions-export-negatives.test.ts` (injected temp-write failure against the atomic temp+rename in `src/cli/handlers/sessions.ts`) |
| Plan with an unsupported profile version refused before any output (`UNKNOWN_SCHEMA_MAJOR`) | Verified (fail closed) | `test/unit/cli/handlers/sessions-export-negatives.test.ts` |
| Remaining provider sources (Copilot, Cursor, Hermes, etc.) -> `export plan/build` | Unverified but expected to work | The mapping in `src/sessions/fortemi-export-mapping.ts` reads only the normalized `Session`/`SessionEvent` catalog, not provider-specific fields -- Claude and Codex both pass through it unmodified, but no dedicated test exercises the remaining providers through the export pipeline yet |
| A real external Fortemi consumer application importing the built shard | Verified (CI job `producer-consumer-receipt`) | `.gitea/workflows/fortemi-shard-conformance.yml` imports the synthetic Claude fixture into a temporary catalog and builds a full-v1 shard. It then checks the pinned Fortemi consumer's import, note and provenance APIs, and semantic re-export. First passing run: Gitea Actions run 92878 (2026-10-28). The job reruns on every main push that touches the session-export paths. The semantic re-export check allows one class of difference: when the source shard carries no embedding data, Fortemi returns the embedding infrastructure its database seeds (at most one default embedding configuration with `is_default: true`, at most one system set with slug `default` linked to it, and that set's memberships for notes the shard already holds), with no embeddings. Any other added, removed or changed record fails, and every failing file is reported (#4217). |
| Remote or provider-reference-only attachment bytes | Not available | Never fetched; providers such as Claude web exports expose metadata/extracted text rather than original bytes |
| Edited or branched Claude web-export conversations | Unverified | No fixture represents this; see `docs/providers/claude-code-sessions.md` known limitations |
| `export unpack` re-importing recovered records back into a session catalog | Not implemented | `unpack` writes the recovered record graph to `index.json`; it does not reconstruct catalog rows |

## Reference performance

The reproducible production-path benchmark is:

```bash
npm run benchmark:sessions
```

It uses the real adapter, importer, repository, metadata, lexical search, and
extraction paths. The command records its generator seed, machine/dependency
profile, raw samples, throughput, heap/RSS, bounded-failure result, budgets,
and overall status in `test-results/session-performance.json`. Set
`AIWG_SESSION_BENCH_EVENTS=1000000` for release-scale evidence.

## JSON contract

Every `--json` response has the same versioned top-level shape:

```json
{
  "contractVersion": "1.0.0",
  "command": "sessions.list",
  "status": "ok",
  "data": {},
  "error": null
}
```

Fields may be added within major version 1, but existing fields retain their
meaning. List order is stable and list pagination uses a deterministic numeric
cursor; search pagination uses a deterministic opaque snapshot cursor.
Unsupported providers return `UNSUPPORTED_OPERATION`; this is distinct
from a successful query with an empty `items` array.

Exit codes are stable within major version 1:

| Code | Meaning |
|---:|---|
| 0 | Success or preview |
| 2 | Invalid command or arguments |
| 3 | Unsupported operation |
| 4 | Requested catalog object unavailable |
| 5 | Source or contract validation failure |
| 6 | Catalog/storage unavailable |
| 7 | Import lease contention |
| 8 | Coverage below requested threshold |
