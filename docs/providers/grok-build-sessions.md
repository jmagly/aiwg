# Grok Build session ingestion

AIWG registers `grok-build` separately from `grokbot`. Prefer Grok Build's public
CLI for workspace discovery and transcript export:

```sh
aiwg sessions grok-list --workspace "$PWD" --json
aiwg sessions grok-search "query" --workspace "$PWD" --json
aiwg sessions grok-export <session-id> --workspace "$PWD" --out /authorized/exports
aiwg sessions import /authorized/exports/<session-id>.md \
  --provider grok-build --source-id grok-build-<session-id> --workspace "$PWD"
```

These routes call `grok --no-auto-update sessions list`, `sessions search
<query>`, and `export <id>`, without a shell or model invocation. They honor
`$GROK_HOME` (default `~/.grok`), reject unsafe roots and symlink components, bound
execution to 15 seconds and output to 2 MB, and return only session IDs from
list/search. `--grok-bin` selects an absolute executable. Exports use exclusive,
owner-only `<session-id>.md` files; existing files are never overwritten.
AIWG never reads Grok Bot or Cursor stores through this adapter.

To extract an ID from an already captured headless run, use `aiwg sessions
grok-id <file> --format json|streaming-json`. This reads a bounded regular file
and validates the captured output grammar and one consistent UUID. It does not
run a prompt. Unknown list/search rows, result envelopes or streaming event
types fail closed with `SCHEMA_DRIFT`; inspect the CLI version before retrying.
The captured stream has `available_commands`, `text`, `thought`, `usage`,
`tool_call`, `tool_call_update`, and a final `end` event carrying the session ID.

## CLI export and privacy

`grok export <id> <file>` produces Markdown with exact `## User`, `## Assistant`,
and `## Tools` sections. AIWG imports prompts, assistant output, and tool command
summaries, including multiline commands. Keep the UUID as the filename. Unknown
headings or malformed blocks fail with `MALFORMED_SOURCE` or `SCHEMA_DRIFT`.
Message Markdown can resemble section headings; retain rejected exports for
review rather than guessing their structure. Replaying the same source is
deterministic; the existing importer uses stable identities and checkpoints
for idempotent import. Adapter version 1.3.0 adds TUI checkpoint metadata to the
extended native projection and checked cursors; use a separate source when
migrating from older adapter versions.

**The CLI export omits tool output.** It also omits event timestamps, model,
Grok version, cwd, compaction, parent/child lineage, subagents, attachments and
snapshots. AIWG records these limits in `native.grok-build` provenance and leaves
unavailable fields unknown. A durable `toolOutputAvailable: false` flag records
the CLI omission even after metadata redaction. AIWG does not infer lineage from
transcript prose.

Imported sessions can contain private prompts, tool commands, file content,
source code, secrets, attachment names and local paths. Native tool results can
contain complete file contents. Review sources before import and restrict root
authorization. AIWG does not import attachment or file-snapshot bytes; acquiring
those would further increase privacy exposure and requires ownership evidence.

## Experimental native projection: exact 1.0.77 only

The 2026-11-09 interactive and 2026-11-10 headless/ACP/TUI captures of Grok Build
1.0.77 establish the store layout of
`$GROK_HOME/sessions/<url-encoded cwd>/<session-id>/`. Direct reads remain
experimental and require **both** variables for every discovery/import/refresh
or tail operation:

```sh
AIWG_GROK_BUILD_NATIVE_EXPERIMENTAL=1 AIWG_GROK_BUILD_NATIVE_VERSION=1.0.77 \
aiwg sessions discover --workspace /work/project --expected-providers grok-build \
  --grok-root /authorized/grok-home/sessions --json
```

The version pin is an operator assertion about the source binary, not a live
binary probe. No other version string or range enables native reads. Authorize
only the sessions directory with `--grok-root`; an opt-in grants no filesystem
access. Symlinked roots/components and filesystem roots are rejected. Discovery
matches the encoded cwd against the authorized workspace and ignores unrelated
stores and files. Native reads require a sibling `summary.json` with matching
session ID/cwd and `chat_format_version: 1`.

The reader projects observed text user/assistant records, assistant tool calls
and `tool_result` records from `chat_history.jsonl`. Per-record model IDs are
preserved when present; cwd, the pinned version, session creation/update times
and the summary current model ID are recorded in provenance. Explicit
`summary.json` `session_kind` values become provenance `sessionKind`. The
interactive 2026-11-09, ACP and set-b TUI summaries omit that field; their kind
remains unknown. Explicit null also means unknown. Neither absence nor null is
converted to `interactive` or `headless`.

Session timestamp epoch milliseconds survive existing string/path redaction;
raw cwd and timestamp strings remain subject to that privacy policy. Native chat
records expose no per-event timestamp. Stable event IDs use source positions,
without claiming provider event IDs. System content, synthetic system reminders,
compaction context and encrypted reasoning are excluded with a loss report.
Attachment, snapshot, resource-state and credential files are never opened.

### Resume, fork and subagent lineage

Same-ID resumes append turns to the existing session. Forks preserve the explicit
`parent_session_id` and `forked_at` as `lineage.parentSessionId` and
`lineage.forkedAt`, including copied history under the new session identity.
Lineage survives normalization on both events and session extensions.

The reader also authorizes bounded, symlink-checked
`subagents/<uuid>/meta.json` and optional `output.json` siblings. It records a
sorted `lineage.subagents` list on the parent, retaining only exposed subagent,
parent and child IDs, status and output. Child session directories are discovered
normally. Their captured summaries omit parent IDs; the relationship remains on
the parent's metadata rather than being invented on the child. Missing output
or optional metadata fields stay absent; a missing/malformed `meta.json` fails
closed. Subagent output can contain private file contents and receives the
existing content redaction policy on normalized extensions.

### Compaction and checkpoints

Compaction rewrites `chat_history.jsonl` with `compaction_meta` context. For
text-only sessions with a sibling `updates.jsonl`, AIWG projects the retained
`user_message_chunk` and `agent_message_chunk` records from that log, including
`/compact` when exposed. The set-b TUI capture has no `/compact` message update;
AIWG does not invent one. It uses this projection before and after compaction so
original turns keep their identities. It never combines those turns with the shortened chat
history. Streaming chunks remain separate events. Exposed update timestamps and
model IDs are retained; none are inferred for missing fields.

`auto_compact_completed` becomes one `compaction` event with token counts in
its extensions. The TUI's preceding `compaction_checkpoint` contributes only
`checkpointId` and `promptIndexAtCompaction` to that event. Its schema, UUID,
timestamp and relative file reference are validated; the referenced file is
never opened. The prompt index must match the retained prompt prefix. Malformed,
duplicate or unfinished checkpoints fail closed. ACP logs without this checkpoint
retain their existing projection. Known housekeeping/thought updates are
excluded. Checkpoints validate a digest of the retained projected prefix, independent of mutable
summary metadata; appending turns resumes once, and changed or truncated
projected history or TUI checkpoint identity fails with `SCHEMA_DRIFT`. The
adapter treats the primary history file as a snapshot because compaction can
rewrite or replace it.

A compacted history without the retained update log fails closed, as does a
compacted tool session: the supplied compaction capture qualifies text turns
only. Uncompacted tool sessions retain the chat projection. Truncated JSON,
unknown chat/update types, invalid lineage and missing `summary.json` fail with
`SCHEMA_DRIFT`; use `grok export <session-id> <session-id>.md` for review/import.
No partial tail is silently imported.

An unknown native record or changed summary format fails closed. Explicit CLI
imports with the experimental opt-in automatically fall back to bounded public
CLI export when native parsing is unavailable, including an absent/changed
version pin. The selected file must belong to the configured `$GROK_HOME/sessions`
store; mismatched homes and unsafe paths never trigger export. The temporary
owner-only export is removed after validation/import, and provenance records
`nativeFallback: true` and the CLI tool-output limitation. Unknown CLI output
still fails with `SCHEMA_DRIFT`.

Export checkpoints validate the transcript prefix with a `grok-export:` cursor.
Fallback checkpoints use a separate `grok-cli:` prefix with the same digest check
so replay retains CLI acquisition. An existing native checkpoint rejects an acquisition change with
`SCHEMA_DRIFT`; restart using a separate CLI export source. Direct adapter API
callers supply CLI options to enable automatic fallback; otherwise the error
provides the explicit export/import route.
The legacy optional `--grok-active-sessions` registry remains synthetic and
unqualified; it is not evidence of released-binary live detection.

## Evidence and deferred coverage

`test/fixtures/sessions/grok-build/captured-1.0.77/` contains small sanitized
projections of the supplied released-binary captures. System prompt text, local
paths, user/host identifiers and session/request/tool IDs are removed or replaced.
Public harness revision: `4247f661689354b831191f11eeeac8424993fe3d`.

The earlier `coverage.json` describes synthetic loss assertions only. The
[captured-1.0.77-20261110 fixtures](../../test/fixtures/sessions/grok-build/captured-1.0.77-20261110/README.md)
add headless same-ID resumes, fork metadata, two subagent metadata/output pairs
with separate child stores, and ACP-backed compaction with retained turns and
recall. Regression tests exercise deterministic replay, repository checkpoints,
and sanitized partial/corrupt mutations. These mutations are not captures of a
live corrupted store.

The [set-b TUI fixtures](../../test/fixtures/sessions/grok-build/captured-1.0.77-20261110b/README.md)
add an unknown-kind session with `compaction_meta`, `compaction_checkpoint`,
`prompt_index_at_compaction`, `auto_compact_completed` and recall. Tests cover
the original prefix, rewritten history, appended recall and idempotent replay.

The set-b headless `--prompt-json` image attempt did not reach the model and
stored no image block in `chat_history.jsonl`. There is no headless attachment
record to qualify in 1.0.77; accepting an image input does not establish native
attachment persistence. TUI attachments remain deferred.

Deferred: uncaptured TUI features, attachments and snapshot ownership,
compaction involving tools, Windows paths, native active registry and
cross-version drift. The absence of session kind or child-summary parent fields
is recorded as missing evidence, not filled from transcript prose. ACP transport
setup, cancellation and worktree management are outside session-store ingestion.

Reference contracts: [sessions](https://docs.x.ai/build/features/sessions) and
[headless scripting](https://docs.x.ai/build/cli/headless-scripting). This change
uses the supplied offline captures and does not run Grok or a model.
