# Grok Build session ingestion

AIWG registers `grok-build` separately from `grokbot`. The `sessions` command
can call the public Grok Build CLI and return only session IDs, keeping private
titles, prompt snippets, and CLI diagnostics out of its JSON response:

```bash
aiwg sessions grok-list --workspace "$PWD" --json
aiwg sessions grok-search "query" --workspace "$PWD" --json
aiwg sessions grok-export <session-id> --workspace "$PWD" --out /authorized/exports
aiwg sessions import /authorized/exports/<session-id>.md \
  --provider grok-build --source-id grok-build-<session-id> --workspace "$PWD"
```

The commands invoke `grok --no-auto-update` without a shell, cap output at 2 MB
and execution at 15 seconds, reject unsafe or symlinked `$GROK_HOME` and output
roots, and never overwrite an existing export. `--grok-bin` accepts an absolute
operator-selected executable path. The export is written with owner-only file
permissions. CLI listing/search remains Grok's workspace-scoped behavior;
AIWG does not inspect its native session store.

For a session ID from a separately captured headless run, use `aiwg sessions
grok-id <file> --format json|streaming-json`. It reads a bounded regular file,
requires one consistent UUID `sessionId`, and returns only the ID. It does not
run a prompt or include headless response content in its output.

Equivalent direct Grok CLI commands are:

```bash
grok sessions list
grok sessions search "query"
grok export <session-id> <session-id>.md
```

Keep the UUID session ID as the export filename. AIWG uses it as native
identity, parses only the documented CLI Markdown headings (`User`,
`Assistant`, and `Tools`), and fails with `MALFORMED_SOURCE` or `SCHEMA_DRIFT`
when the filename or export shape changes. Reimporting the same file is
deterministic and idempotent. Unknown top-level `##` headings and malformed or
oversized tool blocks fail closed before a CLI export is written or imported.
Because raw message text can itself contain Markdown headings, this
conservative check can reject a legitimate transcript; retain the original
export for review rather than silently treating an unfamiliar section as data.

Grok Build resolves its own storage under `$GROK_HOME/sessions` (default
`~/.grok/sessions`). AIWG does not read that tree, follow session-store
symlinks, or inspect Grok Bot and Cursor stores. Native parsing remains disabled
until sanitized files from a released binary qualify the schema and exact
version range. Use `grok sessions list` or `search` for discovery and `grok
export` for acquisition.

On Mutsu, the pinned macOS ARM64 1.0.38 binary returned `No sessions found.`
from a fresh isolated `GROK_HOME`; `grok sessions search` returned `Total: 0`
with an authentication warning. These observations prove the bounded CLI
failure behavior only; they do not establish native storage schema, lineage,
or an authenticated session fixture.

## Export limits and privacy

The CLI Markdown export contains prompts, assistant output, and compact tool
call summaries. It does not expose timestamps, model or Grok version, working
directory, tool results, compaction records, parent/child lineage, subagent
records, attachments, or file snapshots. AIWG leaves those fields unknown and
records the loss in `native.grok-build` provenance; it does not infer them.

Prompts, assistant output, tool summaries, attachment names, and file paths can
still contain private source code, personal data, secrets, or workspace
structure. Review the Markdown before importing it and authorize only its
containing directory. Native snapshots and tool output would increase that
privacy exposure substantially, which is another reason native ingestion stays
off until it has a separately reviewed, version-gated implementation.

## Verification evidence

The conformance fixtures under `test/fixtures/sessions/grok-build/` are
sanitized synthetic CLI Markdown projections aligned to public harness revision
`4247f661689354b831191f11eeeac8424993fe3d`. Their `coverage.json` maps
TUI, headless, ACP, compaction, resume/fork, subagent, attachments/snapshots,
partial, and corrupt cases, and marks native-only evidence as missing. These
are not claimed as captures from a released binary. The adapter tests cover exact
heading parsing, prompts, assistant output, tool calls, native identity,
provenance, unavailable fields, changed output, unsupported native/Cursor
locators, symlink escape rejection, deterministic replay, and idempotency.
