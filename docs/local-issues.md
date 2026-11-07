# Local Issues

AIWG can keep a project-local issue tracker under `.aiwg/issues/` for projects that do not use Gitea or GitHub as the working tracker. The local tracker is a Git-friendly store: issue bodies live in markdown files, event metadata lives in JSONL files, and indexes are rebuildable.

During agent-led project setup, the assistant may use
`aiwg setup project --issue-provider local` to configure `.aiwg/aiwg.config` so
issue operations route to the local store by setting `remotes.issue_tracker` to
`local`. This does not migrate external issues by itself; use the import/export
commands below for explicit migration or synchronization work.

## Layout

> "Show me where local issues live in this project and what is canonical versus rebuildable."

Your assistant points to `.aiwg/issues/items/` and `events/` as canonical and `index/` as rebuildable cache.

```text
.aiwg/issues/
├── config.json
├── next-id
├── items/
│   └── ISSUE-0001.md
├── events/
│   ├── ISSUE-0001.jsonl
│   └── bodies/
│       └── evt-....md
├── index/
│   └── issues.index.json
└── locks/
```

The canonical files are `items/` and `events/`. The `index/` directory is a cache and can be rebuilt with `aiwg issue index rebuild`.

Index rebuilds skip parsing and rewriting when the issue file names and file
metadata are unchanged, preserving `rebuilt_at`. The cache records an optional
`inputFingerprint`; older caches rebuild once. Use `aiwg issue index rebuild
--force` to rebuild regardless of the fingerprint. Missing or malformed caches
are rebuilt automatically by the rebuild command.

## Basic Commands

> "File this as a local issue titled 'Fix import flow' using issue.md as the body."

Your assistant runs `aiwg issue plan` first for policy review, then `aiwg issue new` with the reviewed digest when required.

### Command reference

```bash
aiwg issue init --prefix PROJECT
aiwg issue plan --title "Improve setup" --body-file issue.md --json
aiwg issue new --title "Fix import flow" --body-file issue.md
aiwg issue list --status open --search import
aiwg issue show PROJECT-0001 --comments last:10
aiwg issue comment PROJECT-0001 --body "Started"
aiwg issue close PROJECT-0001 --reason "Done"
aiwg issue index rebuild
```

Local lists and creates require initialization with `aiwg issues init` and fail
with setup guidance when it is missing. A successful empty list prints
`No matching issues found.`; `--json` returns `{"issues":[],"nextCursor":null}`.
With a configured external tracker, use its tracker tools for queries or select
local storage explicitly with `--provider local`. Query failures never count as
a successful duplicate check. For mapped control workspaces, resolve the target
member and use its tracker config and actor directly, without local initialization.

Every new local issue is policy-planned before its first write. Safe drafts
remain one issue. Drafts that cross an enforced policy boundary are split into
independently assessed issues with stable provenance markers, dependency order,
and sibling links. Flagged drafts require the digest shown by `issue plan`:

```bash
aiwg issue new --title "..." --body-file issue.md \
  --authorize-policy <reviewed-plan-digest>
```

Rejected drafts that cannot be separated produce suggestions and make no
filesystem change. A partial multi-issue result includes the next segment and
all stable markers; retrying the same draft reuses matching issues instead of
duplicating them. The `issue-create` skill applies this same composer before
Gitea, GitHub, Jira, Linear, and higher-level workflow writes.

`aiwg issue list` can filter by status, label, type, priority, assignee, and
search text. `issue-audit --provider local` and `address-issues --provider
local` consume bounded slices from the same provider instead of reading the
whole backlog.

Label filters and workflow mutations should use stable roles from
`.aiwg/aiwg.config` `issues.labels`; see
[Issue Label Taxonomy](issue-label-taxonomy.md). A role may map to a
local-specific string through `provider_names.local`, while retaining the same
semantics used by Gitea and GitHub.

## Fortemi Core Migration Note

> "Do local issue commands change under the Fortemi Core migration preview?"

Your assistant keeps issue operations on the local provider and uses `aiwg index` commands for Fortemi Core artifact queries.

Local issue search remains served by the local issue provider in the Fortemi
Core migration preview. The rebuildable `.aiwg/issues/index/issues.index.json`
cache is still the source for `aiwg issue list --search` and related filters.
`aiwg issue` commands intentionally do not accept `--backend fortemi-core`; use
the local issue provider for issue operations and use `aiwg index` commands for
artifact-index Fortemi Core queries.
Fortemi exports may include `aiwg.issue` records if a later ADR joins local
issues into the shared artifact index, but this does not change the local issue
CLI contract or require a Fortemi backend for issue operations.

## Import And Export

> "Import this Gitea snapshot into local issues, then export PROJECT-0001 back to Gitea."

Your assistant uses `aiwg issue import` and `aiwg issue export` with snapshot files, adding `--live` only for direct API reads and writes.

### Command reference

Use snapshots to move issue state between local issues and external trackers:

```bash
aiwg issue import --from gitea --snapshot-file gitea-1463.json
aiwg issue import --from github --snapshot-file github-42.json
aiwg issue export PROJECT-0001 --to gitea --out project-0001.gitea.json
aiwg issue export PROJECT-0001 --to github --out project-0001.github.json
```

Use `--live` when the CLI should read from or write to the provider API directly instead of a snapshot file:

```bash
aiwg issue import --from gitea --live --repo org/repo --external-id 1463 --token-store gitea-production
aiwg issue import --from github --live --repo org/repo --external-id 42 --token-file "$HOME/.config/aiwg/github-token"
aiwg issue export PROJECT-0001 --to gitea --live --repo org/repo --token-store gitea-production
op read 'op://Engineering/GitHub/token' | aiwg issue export PROJECT-0001 --to github --live --repo org/repo --token-stdin
```

Live commands support `--token-interactive`, `--token-stdin`, `--token-file <path>`,
`--token-store <name>`, and `--token-env <NAME>` through the shared
[sensitive-value input guidance](cli/sensitive-values.md). Without a source flag,
an interactive terminal prompts without echo. Headless calls retain the existing
environment order (`AIWG_GITEA_TOKEN` then `GITEA_TOKEN`, or `AIWG_GITHUB_TOKEN`
then `GITHUB_TOKEN`); a missing token errors and lists the source flags. Private
files must be owned regular files without group/other access or links. The bearer
reaches only the in-process HTTP client; response and transport errors redact it.

Live export creates an external issue when the local issue has no matching `source.external_id`. If the local issue already points at the target provider, live export fetches the remote issue first and refuses to mutate when conflicts are present. Review conflicts with `aiwg issue sync conflicts` or pass `--force` only after choosing the local version as the winner. Posted comments are mapped back to local event metadata automatically.

An imported snapshot preserves the external issue ID and URL in the issue frontmatter:

```yaml
source:
  provider: gitea
  external_id: "1463"
  external_url: https://git.example.test/org/repo/issues/1463
links:
  external:
    - https://git.example.test/org/repo/issues/1463
```

Imported comments keep their external comment IDs on local event metadata. Exported comments include local event IDs so a later posting step can map external comment IDs back to local events.

```bash
aiwg issue sync map-comments PROJECT-0001 --map-file comment-map.json
```

`comment-map.json` is an array:

```json
[
  {
    "local_event_id": "evt-local",
    "external_comment_id": "51710"
  }
]
```

## Conflict Reports

> "Check PROJECT-0001 against this Gitea snapshot for conflicts before syncing."

Your assistant runs `aiwg issue sync conflicts` and waits for you to choose the winner when the conflicts array is non-empty.

### Command reference

Before any two-way sync mutates either side, generate and inspect a conflict report:

```bash
aiwg issue sync conflicts PROJECT-0001 --snapshot-file gitea-1463.json --out conflicts.json
```

The report compares local and external title, body, status, labels, and mapped comment bodies. A non-empty `conflicts` array means an operator or higher-level sync policy must choose the winner before writing changes.

## Backup Guidance

> "Back up local issues before this bulk sync so I can restore the canonical files."

Your assistant commits or archives `items/`, `events/`, `config.json`, and `next-id` and skips transient locks.

### Command reference

For local-only issue work, commit or stash canonical issue files before bulk operations:

```bash
git status -- .aiwg/issues
git add .aiwg/issues/items .aiwg/issues/events .aiwg/issues/config.json .aiwg/issues/next-id
git commit -m "backup local issue state before sync"
```

For one-off backups outside Git, archive the canonical files and skip transient locks:

```bash
zip -r aiwg-issues-backup.zip .aiwg/issues -x ".aiwg/issues/locks/*"
```

Do not store external tracker API tokens in `.aiwg/issues/`, `.aiwg/aiwg.config`, or snapshot files. Keep credentials in environment variables, the OS credential store, or provider-specific CLI configuration. Live sync reads `AIWG_GITEA_TOKEN` or `GITEA_TOKEN` for Gitea, and `AIWG_GITHUB_TOKEN` or `GITHUB_TOKEN` for GitHub. Use `--api-url` for non-default Gitea or GitHub Enterprise API endpoints.

## Git Conflict Guidance

> "Merge left a conflict in ISSUE-0001. Keep the canonical records and tell me what to rebuild."

Your assistant preserves `items/` frontmatter and every complete JSONL event line, then rebuilds the index.

Resolve conflicts by preserving canonical records first:

- `items/ISSUE-0001.md`: keep valid YAML frontmatter, then merge the markdown body normally.
- `events/ISSUE-0001.jsonl`: preserve every complete JSON line from both sides unless the same event ID appears twice.
- `events/bodies/*.md`: keep body files referenced by surviving JSONL events.
- `config.json` and `next-id`: keep the highest observed `next` value so IDs are not reused.
- `index/*`: rebuild after resolving canonical files.

After conflict resolution:

```bash
aiwg issue index rebuild
aiwg issue list --status open
```

If an event line is damaged, recover the body file first, then recreate the event as a new comment rather than hand-editing an uncertain event ID.
