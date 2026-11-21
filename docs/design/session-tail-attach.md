# Design: Observe live provider sessions

- Status: Proposed; design only
- Issue: [jmagly/aiwg#311](https://github.com/jmagly/aiwg/issues/311)
- Baseline: `0a2d20867`

## Goals and non-goals

Expose `aiwg sessions tail` for one authorized session, starting after its last
committed catalog cursor. Follow newly available normalized events within two
seconds of a complete record becoming readable locally, under the limits below.
Support every qualified live source class through its existing adapter's
`stream()` semantics; report explicit capability failures for export-only sources.
Keep observation read-only unless the caller explicitly requests `--import`.

“Attach” means observing a fixed session here. Interactive terminal attachment,
prompt injection, resuming agents, process control, remote cockpit transport,
provider login, cloud downloads, automatic export commands, multi-session watch,
and opening undocumented stores are outside this proposal. No implementation or
test changes accompany this document.

## Current state and constraints

References below point to the baseline; line numbers describe existing code.

- The CLI has discovery/import, catalog reads, and provider export helpers, but no
  tail verb: [sessions.ts:146](../../src/cli/handlers/sessions.ts#L146).
  Its JSON envelope is versioned, but emitted as one pretty-printed object:
  [sessions.ts:138](../../src/cli/handlers/sessions.ts#L138),
  [sessions.ts:2283](../../src/cli/handlers/sessions.ts#L2283).
- All 18 registered adapters expose `stream`, including manual exports:
  [adapter-registry.ts:21](../../src/sessions/adapter-registry.ts#L21).
  The interface describes finite `AsyncIterable<ProviderRecord>` reads, without
  polling, cancellation, or a live-source capability:
  [contracts.ts:372](../../src/sessions/contracts.ts#L372),
  [contracts.ts:416](../../src/sessions/contracts.ts#L416).
  Registry operation checks currently return `UNSUPPORTED_OPERATION`, and
  `UNSUPPORTED_PROVIDER` is absent from the error schema:
  [discovery.ts:51](../../src/sessions/discovery.ts#L51),
  [contracts.ts:72](../../src/sessions/contracts.ts#L72).
- The importer resumes with adapter-specific cursors, normalizes/redacts records,
  and persists batches. Its normalizer is private, so invoking import just to
  observe would write: [importer.ts:91](../../src/sessions/importer.ts#L91),
  [importer.ts:197](../../src/sessions/importer.ts#L197),
  [importer.ts:225](../../src/sessions/importer.ts#L225),
  [importer.ts:301](../../src/sessions/importer.ts#L301).
  Checkpoints carry cursor kind, versions, generation and continuity evidence:
  [contracts.ts:183](../../src/sessions/contracts.ts#L183).
- Catalog source records contain `redactedLocator`, not an openable path:
  [contracts.ts:93](../../src/sessions/contracts.ts#L93).
  Private discovery manifests retain locators and roots; public projections
  remove them: [workspace-discovery.ts:368](../../src/sessions/workspace-discovery.ts#L368),
  [workspace-discovery.ts:398](../../src/sessions/workspace-discovery.ts#L398).
  Ordinary discovery source IDs include a content digest, which changes after
  append: [workspace-discovery.ts:416](../../src/sessions/workspace-discovery.ts#L416).
- Existing catalog opening creates directories, enables WAL and initializes
  schema: [sessions.ts:1878](../../src/cli/handlers/sessions.ts#L1878),
  [repository.ts:269](../../src/sessions/repository.ts#L269).
  A genuinely read-only tail requires a separate opening path.
- Workspace read selection already exists, while `show` permits catalog-wide
  native-ID lookup: [sessions.ts:1991](../../src/cli/handlers/sessions.ts#L1991),
  [sessions.ts:415](../../src/cli/handlers/sessions.ts#L415).
  Tail must scope before matching; it must not expose those cross-workspace
  ambiguity candidates. The local-owner context is not a shared-service ACL:
  [repository.ts:155](../../src/sessions/repository.ts#L155).
- The JSONL reader treats provisional parse failures as an incomplete tail and
  estimates line bytes with `+1`; it does not establish strict newline framing:
  [readers.ts:64](../../src/sessions/readers.ts#L64).
  A live reader must distinguish a partial final line from corrupt interior data,
  account for CRLF/UTF-8 exactly, and retain a complete last line without newline.
- Sandbox session inventory is a separate cockpit concern, not a catalog source
  binding: [sandbox-registry.ts:92](../../src/serve/sandbox-registry.ts#L92).

## Provider analysis

Disposition describes import support, not liveness. All rows currently support
`stream`; most are `implemented`, while Warp and generic are `manual-only`.
Proposed live eligibility is per locator class, never inferred from method
presence, filename extension, or provider disposition alone.

| Provider | Existing source/cursor evidence | Proposed live handling |
| --- | --- | --- |
| Claude | Transcript/hook JSONL; normalized output index; web export JSON. [claude.ts:159](../../src/sessions/adapters/claude.ts#L159) | First wave: append transcript/hook classes; web export remains unsupported for live tail. Prefix replay currently restores parser context. |
| Codex | Rollout/app-server JSONL; output index; restores session metadata on replay. [codex.ts:108](../../src/sessions/adapters/codex.ts#L108) | First wave: both recorded JSONL classes. No implicit App Server connection. |
| Muse | Native JSONL uses output index, including retained-frame children; trajectory JSON is export-only. Native reader currently requires complete JSONL. [muse.ts:267](../../src/sessions/adapters/muse.ts#L267), [muse.ts:420](../../src/sessions/adapters/muse.ts#L420) | First wave: native class after partial-tail handling; retain omission markers as diagnostics, not invented events. No following trajectory exports. |
| Grok Bot | Native replica is a rewritten JSON snapshot with `native:<seq>`; generic export delegates to interchange. [grokbot.ts:186](../../src/sessions/adapters/grokbot.ts#L186), [grokbot.ts:256](../../src/sessions/adapters/grokbot.ts#L256) | First wave: reopen allowlisted replica on replacement, validate conversation/sequence, detect evicted windows. Export class remains unsupported. |
| Pi | JSONL v3; `stream` accepts decimal byte offsets and emits unprefixed byte cursors. [pi.ts:47](../../src/sessions/adapters/pi.ts#L47) | First wave requires cursor reconciliation: importer only recognizes `byte:`/`native:` prefixes and otherwise saves record counts. Preserve header identity and absolute sequence on resume; basename fallback is insufficient. |
| Factory | Droid JSONL output index; other formats read through `readSource`. [factory.ts:98](../../src/sessions/adapters/factory.ts#L98) | Second wave: qualified Droid append class; separately qualify other recorded JSONL classes. |
| Cursor | CLI/cloud-event JSONL output index; agent transcript and Markdown use whole-source parsing; editor SQLite rejected. [cursor.ts:134](../../src/sessions/adapters/cursor.ts#L134), [cursor.ts:216](../../src/sessions/adapters/cursor.ts#L216) | Second wave: CLI, recorded cloud events, agent transcript after append conformance. No cloud fetch, Markdown follow, or editor DB reads. |
| OMP | JSONL v3, `byte:` cursor, full prefix replay; validated mutable title preamble. [omp.ts:48](../../src/sessions/adapters/omp.ts#L48) | Second wave: retain preamble exception and header/parent identity; partial tails become provisional waits. |
| DeepSeek Harness | Raw JSONL v2, `byte:` cursor; validates contiguous native sequence from header. [deepseek-harness.ts:60](../../src/sessions/adapters/deepseek-harness.ts#L60) | Second wave: raw append source; retain sequence checks and sensitive-payload suppression. Compressed sources remain unsupported. |
| Devin Desktop | Hook transcript JSONL, record index; legacy protobuf rejected. [windsurf.ts:66](../../src/sessions/adapters/windsurf.ts#L66), [windsurf.ts:118](../../src/sessions/adapters/windsurf.ts#L118) | Second wave: already enabled hook output only; canonical ID `devin-desktop`, alias `windsurf`. Tail never installs hooks. |
| OpenHuman | Explicit raw/enriched JSONL, output index; bounded thread/turn joins. [openhuman.ts:112](../../src/sessions/adapters/openhuman.ts#L112) | Third wave: explicitly bound append files, retaining enrichment context across polls or replay. No discovery guesses. |
| OpenCode | Recorded SSE JSONL with output index and session/message joins; export/API paths separate. [opencode.ts:127](../../src/sessions/adapters/opencode.ts#L127) | Third wave: recorded SSE append source. Exports stay unsupported; live API/SSE transport qualification is a separate issue. |
| Hermes | Explicit export/snapshot JSONL, output index; optional local API; raw state DB rejected. [hermes.ts:111](../../src/sessions/adapters/hermes.ts#L111), [hermes.ts:164](../../src/sessions/adapters/hermes.ts#L164) | Third wave: qualify externally maintained append export feed only. Frozen backups and one-time exports cannot claim liveness; no automatic API access. |
| OpenClaw | Export/backup JSONL, output index; optional Gateway; incognito and host checks. [openclaw.ts:119](../../src/sessions/adapters/openclaw.ts#L119), [openclaw.ts:192](../../src/sessions/adapters/openclaw.ts#L192) | Third wave: qualify explicit ongoing JSONL projection only. Preserve incognito denial; no raw DB, automatic backup refresh or Gateway calls. |
| Copilot | VS Code JSON export, record index; no native workspace-store discovery. [copilot.ts:59](../../src/sessions/adapters/copilot.ts#L59) | `UNSUPPORTED_PROVIDER` for live tail; import/show remain available. |
| Grok Build | CLI Markdown export, block index; native sessions store explicitly prohibited. [grok-build.ts:25](../../src/sessions/adapters/grok-build.ts#L25) | `UNSUPPORTED_PROVIDER`; existing grok-list/export do not establish a live native contract. |
| Warp | Markdown export, record index, `manual-only`. [warp.ts:25](../../src/sessions/adapters/warp.ts#L25) | `UNSUPPORTED_PROVIDER`; no internal SQLite/protobuf probing. |
| Generic | Interchange export, legacy event index or `byte:` cursor, `manual-only`. [generic.ts:126](../../src/sessions/adapters/generic.ts#L126) | `UNSUPPORTED_PROVIDER` in this release. A future explicit producer-feed contract could qualify append observation without claiming a native session. |

There is an acceptance ambiguity: “every adapter supporting stream” includes
export-only adapters today. Interpret it as every qualified live locator class
using `stream`, with explicit unsupported results for export-only classes. This
design does not change existing export/import operations or promise live data
from frozen snapshots. Product confirmation is needed before implementation.

## CLI and selection contract

```text
aiwg sessions tail <session-id> [--provider p] [options]
aiwg sessions tail --provider p --latest [options]
options: --workspace <path-or-id> --follow --json --import --include-content
         --db <path> --manifest <path> --source <file> --source-root <dir>
         --interval-ms <250..1000> --limit <1..10000> --duration <1s..24h>
```

- Require exactly one selector. IDs may be internal, native, or unique prefixes;
  apply workspace/provider scope first. Ambiguity returns only authorized opaque
  IDs and a selection hint. Unknown providers retain `UNKNOWN_PROVIDER`.
- Workspace follows existing read defaults: explicit selection, current project,
  matching cwd, then sole catalog workspace. Never silently widen to all workspaces.
- `--latest` chooses the most recently observed eligible source/session in that
  scope, ordered by trusted file observation time then opaque session ID. Resolve
  once; do not switch when a newer session appears. Report lifecycle as unknown
  unless evidenced; newest does not prove a provider process is running.
- Resolve known catalog IDs first. Authorized discovery may select an uncataloged
  native session without saving a manifest/catalog; use existing workspace-root
  rules and explicit shared-root flags (`--codex-root`, `--muse-root`,
  `--grokbot-root`, `--omp-root`, `--dsh-root`, `--provider-home`).
  Providers lacking discovery require a saved binding or explicit source/root.
- A private manifest binds an existing source ID to its locator, class, workspace
  and authorized root. Validate manifest integrity/ownership, then current source
  continuity; do not apply batch import's exact-current-digest requirement to a
  growing file. Never reconstruct a path from `redactedLocator`.
  `--source` requires `--source-root`; validate provider/session identity before
  accepting a replacement binding. Missing binding returns `SOURCE_BINDING_REQUIRED`.
- Preserve a known source ID after append rather than recomputing its content-based
  discovery ID. For uncataloged sources derive an ephemeral stable ID from the
  authorized workspace/provider/class/native identity and pin it for this run;
  the future import path must adopt the same identity if `--import` is selected.
- Default start is the last committed compatible source checkpoint. No checkpoint
  means beginning of the selected source, explicitly indicated in `ready`.
  An incompatible checkpoint fails with `CHECKPOINT_INCOMPATIBLE`; never reinterpret
  a count as bytes or silently replay from the beginning. Staged checkpoints are
  invisible. Manual-export-only selection fails before any transcript read.
- Without `--follow`, drain a finite view captured at invocation and exit. With
  follow, drain then poll until cancellation, duration, or event limit. EOF and
  turn-end are not proof of permanent session completion; remain attached.
  Limit defaults to 1000 events for one-shot, unlimited total events for follow;
  every poll remains bounded. No `attach`/`watch` alias in the first release.

## Service API, normalization and cursor ownership

Proposed `tailSessions(request): AsyncIterable<TailFrame>` accepts resolved
selection, authorization, source bindings, output policy, follow/import options,
limits and `AbortSignal`. Keep resolution, reading, normalization, rendering and
optional persistence separate. Export a pure normalizer shared with the importer
so stable IDs, redaction, origin and adapter classification cannot diverge.

Add per-locator capability metadata to the session registry: `mode` is
`append | snapshot | unsupported`, with `cursorKind`, continuity policy, supported
versions and content-free reason/remediation. Expose it through `sessions sources`;
do not mutate import disposition to describe tail support. Unqualified live
classes report `LIVE_SOURCE_NOT_QUALIFIED` until their rollout gate passes.

Extend `stream(source, cursor?, options?)` with an optional bounded live-read
context: signal, captured EOF/snapshot identity, strict framing, reader limits,
and adapter-owned progress reporting. Existing two-argument imports keep their
behavior. Progress reports a safe next cursor only after all children of a native
record are consumed; it also handles headers/ignored records that emit no event.
Cancellation inside a fanout leaves the previous safe cursor and may replay
already emitted children; event IDs allow deduplication. Adapters own cursor
encoding, skipped-record accounting and parser context; the service never guesses
from `sequence` or increments an opaque native token.

Use distinct read, emitted and durable cursors. The service walks the whole
source cursor even when filtering a multi-session source, but emits only the
selected session. Never advance a durable shared-source import cursor past
unimported sibling events. With `--import`, persist all authorized records covered
by that source cursor, transactionally, while stdout remains session-filtered;
reject mixed-workspace sources rather than importing unauthorized siblings.

Reuse checkpoint version/generation checks. Pi needs a versioned compatibility
decision because current catalog checkpoints can contain counts where its adapter
expects bytes; require a validated migration or explicit reimport outside tail.
Retain absolute event identity/sequence when seeking into Pi and other stateful
formats. Initial replay may restore headers and joins; do not rescan unbounded
history every second. Qualification requires bounded parser state or indexed seek
support for sources beyond the replay budget.

For append files, verify open descriptor identity, size and committed-prefix
continuity. Reject truncate, rewrite or rotation with `SOURCE_CHANGED`; do not
automatically follow another session's file. Honor OMP's validated mutable preamble.
Grok Bot is different: allow atomic snapshot replacement only after reauthorization
and native conversation/schema/monotonic-sequence validation. A repeated native ID
with changed content is a conflict. If the retained window outruns the last cursor,
emit a content-free `gap` with `historyUnavailable:true`, then continue available
events; do not assume every skipped sequence represented a supported event.

`--import` explicitly authorizes catalog writes, schema initialization and the
existing workspace import lease. Commit a bounded batch before advertising its
durable cursor; contention returns `IMPORT_LOCKED`, with no fallback to read-only
success. Concurrent independent importers must reread checkpoints under the lease
and deduplicate by existing stable IDs. Default tail uses no lease or catalog write.

## JSON and human output

`--json` is NDJSON in both modes: one compact envelope per line, never a surrounding
array. Keep existing fields `contractVersion:"1.0.0"`, `command:"sessions.tail"`,
`status`, `data`, `error`; add `data.streamVersion:"1.0.0"` and a frame `type`.
Existing commands retain their current single-object JSON behavior.

```json
{"contractVersion":"1.0.0","command":"sessions.tail","status":"ok","data":{"streamVersion":"1.0.0","type":"event","sessionId":"session_example","event":{"eventId":"event_example","sequence":2,"kind":"message","role":"assistant","occurredAt":null,"consistency":"provisional"}},"error":null}
```

Frames: `ready` carries opaque session/source/workspace IDs, canonical provider,
live mode, start basis (`catalog|beginning`), content policy and checkpoint status;
`event` carries the normalized allowlisted projection above; `checkpoint` follows
a safe boundary with opaque `cursor` and nullable `durableCursor`; `gap` and
`warning` carry codes/counts; `end` carries counts, reason, last safe cursor and
whether persistence committed. `error` uses `status:"error"`, a stable error code,
generic message and safe resume metadata. No frame includes raw locators, native
extensions, import-run IDs for unpersisted events, or provider payload dumps.
Cursor tokens encode only numeric positions/versions and opaque scope identities;
they are informational in v1, not an authorization capability or CLI resume input.

Human output prints time, kind, role and opaque event ID; warnings go to stderr.
Both renderers default to metadata only. `--include-content` adds redacted
`searchableText` to event output after workspace authorization. No snippets or
session titles appear otherwise. Strip terminal escapes and control characters.
Text is untrusted data and is never executed or treated as instructions.

Exit codes reuse CLI categories: 0 for a drained/limited/timed run; 2 for invalid
selection/arguments; 3 for `UNSUPPORTED_PROVIDER` or `LIVE_SOURCE_NOT_QUALIFIED`;
4 for unavailable session/source/binding; 5 for authorization, checkpoint,
continuity, schema or resource failures; 6 for catalog errors; 7 for import lease
contention. SIGINT/SIGTERM close iterators/timers/watchers and exit 130/143;
emit `end` if stdout remains usable. EPIPE stops cleanly without further output.
Add the new typed codes to the contract; never surface raw exceptions.

## Security and authorization

Authorize workspace/provider selection before resolving candidates or opening
transcripts. A workspace flag selects a scope; OS ownership and the local-owner
policy establish access. Shared mode must deny unless an external authorization
policy grants that workspace/source; this feature does not invent authentication.
Checkpoints and source IDs must resolve through that same authorized scope.

Reuse [policy.ts:22](../../src/sessions/policy.ts#L22) root/regular-file checks,
but close the check/open race: open read-only without following symlinks where
supported, compare descriptor identity to the authorized canonical path, and
reauthorize every reopen. Validate parent/root replacement as well. Never scan a
whole home when a workspace subdirectory suffices. Muse and Grok Bot have no guessed
root; Grok Bot lacks native workspace evidence, so bind one conversation explicitly
or require a manifest already assigned to this workspace. A broad Grok root alone
must not authorize `--latest` over unrelated conversations.

Provider stores are read-only: no sidecars, locks, chmod, checkpoints, hook install,
backup creation or provider subprocesses. Catalog reads use an existing SQLite
read-only connection with no migration, mkdir, journal-mode change or schema init;
do not use immutable mode against a live WAL catalog. Missing catalog is permitted
only for explicitly authorized native discovery/source selection. An older schema
requiring migration returns a remediation instead of mutating it.

No network, telemetry, transcript caches or automatic remote promotion. Apply
existing text redaction and native sanitization before any output/persistence:
[policy.ts:126](../../src/sessions/policy.ts#L126),
[policy.ts:206](../../src/sessions/policy.ts#L206).
Use allowlisted metadata enums and opaque IDs; free-form native kind/role/name
strings cannot bypass metadata-only output. Redaction is not a guarantee that all
sensitive prose is recognized, so content remains an explicit local disclosure.
Diagnostics/audit contain codes, versions and counts only, including parse errors;
never filenames, paths, prompts, tool arguments/results or text excerpts.

## Resource limits and failure modes

Poll every 1000 ms by default (250–1000 configurable), with one read in flight.
Optional filesystem watching only wakes that poller; periodic polling remains the
fallback for lost events, unavailable inotify and rename-swapped replicas.
The two-second target starts when a complete record/snapshot is readable locally,
with caught-up state, within-budget input and a draining consumer. Provider flush
and cloud-replication delays are outside that clock; do not claim remote liveness.

Per read: at most 1000 emitted records, 8 MiB new bytes, 1 MiB per native record,
JSON depth 64, 10,000 parser join states and 16 MiB output queue. Allow at most
16 MiB initial replay or snapshot parsing; stop larger sources with
`RESOURCE_LIMIT_EXCEEDED` and a safe cursor. Check limits while framing/decoding,
before allocating a complete line or snapshot; one oversized fanout fails atomically.
Release file descriptors between polls; at most one source read and one catalog
connection. Respect stdout backpressure without dropping events; after 30 seconds
of stalled output, stop with a content-free resource error. Follow has no default
wall-clock expiry; optional duration and cancellation bound operator runs.

An incomplete final JSONL record waits without advancing its cursor. Malformed
newline-terminated interior data, unknown schema majors, identity changes and
sequence regression fail closed. An unstable snapshot gets at most one retry on
the next poll after reauthorization; persistent malformed data then fails. File
removal/access loss ends the run; append rotation requires explicit rebinding.
No-event EOF sleeps, never busy-spins. A slow or oversize source cannot claim the
latency acceptance gate. Errors preserve the last fully emitted and durable
boundaries separately; persistence never implies downstream output was consumed.

## Test plan and acceptance gates

Implementation tests belong beside existing adapter/CLI suites; fixtures are
temporary copies containing minimal synthetic events, never real transcripts.

1. Extend `test/unit/sessions/provider-conformance.test.ts` with one registry-driven
   case per adapter: seed, capture cursor, append one complete synthetic event,
   invoke tail, assert exactly the new selected-session event and stable identity.
   Grok Bot instead appends an entry to the snapshot and atomically replaces it.
   Each export-only adapter gets an executable `UNSUPPORTED_PROVIDER` test that
   asserts no transcript read. Test every qualified locator class, not just one
   representative class per provider; matrix omissions fail the gate.
2. In each existing `*-adapter.test.ts`, cover cursor kinds, multi-output records,
   skipped headers/markers, partial UTF-8 and CRLF appends, valid JSON without final
   newline, corruption before EOF, empty sources, and version/identity drift.
   Pi additionally tests header ID differing from filename and legacy checkpoint
   incompatibility; Muse tests retained children; Grok Bot tests eviction/rename,
   conflicting IDs and regression; stateful adapters test restored joins.
3. New `test/unit/sessions/tail.test.ts`: fake clock polling/watcher fallback,
   one-shot captured EOF, deterministic latest pinning, backpressure, cancellation,
   limits, sibling filtering, missing binding, tombstones and unauthorized scopes.
   Check catalog/provider file hashes and directory entries remain unchanged in
   default mode; spy on database writes/migrations and forbidden provider opens.
4. New `test/unit/cli/handlers/sessions-tail.test.ts`: selector validation, all
   NDJSON frame schemas/exits, metadata-only output and sanitized explicit content.
   Assert diagnostics expose no synthetic canary prose/path across stdout/stderr,
   errors, ambiguity lists and audit; shared access without a grant fails closed.
5. Targeted integration: start follow against a temporary authorized source, wait
   for `ready`, append/replace, observe output within 2000 ms. Use a monotonic clock,
   a five-second process deadline and cleanup on every outcome. Repeat across all
   qualified adapters; disable watchers once to prove polling fallback. Import
   cases verify lease contention, atomic checkpoint commit, crash/restart replay,
   no lost siblings and no writes without `--import`.

## Phased delivery and product questions

Issue-sized work items, each with its focused tests and provider documentation:

1. Define typed tail capabilities, frames/errors, limits and shared pure normalizer.
2. Add read-only catalog access, workspace-scoped source binding and checkpoint
   compatibility validation; no CLI release before the authorization tests pass.
3. Add bounded live framing/progress and observer service, CLI one-shot/follow,
   cancellation and synthetic latency harness. Qualify Claude and Codex.
4. Qualify Muse native partial tails/retained frames and Grok Bot snapshot windows
   as separate adapter changes; reconcile Pi cursors/identity in another change.
5. Add optional transactional `--import` with lease and sibling-source coverage.
6. Qualify Factory/Cursor, then OMP/DeepSeek Harness/Devin hook sources in separate
   provider-sized changes. Release only classes whose append/latency gates pass.
7. Qualify explicitly bound OpenHuman/OpenCode/Hermes/OpenClaw feeds individually;
   report export-only providers clearly. Update the conformance matrix, help and
   session-history docs; assess API transports in separate future issues.

Before implementation, the product owner should resolve:

- Confirm live-locator eligibility resolves the `stream` acceptance ambiguity,
  including unsupported generic interchange and frozen provider exports.
- Accept metadata-only default with explicit redacted content, or choose a
  different disclosure policy and update authorization tests before release.
- Should “latest” mean newest observed, newest active, or latest catalog import?
  This proposal uses newest observed and pins it; idle sessions remain observable.
- Approve strict failure on append rotation and incompatible Pi checkpoints, or
  sponsor explicit rebinding/migration UX. Never silently reset a cursor.
- Accept source-wide authorized sibling import under `--import`, or require
  per-session checkpoints as a prerequisite for that flag.
- Confirm the two-second local-visibility scope and initial limits; API-only
  remote providers need separate transport, authorization and latency decisions.
