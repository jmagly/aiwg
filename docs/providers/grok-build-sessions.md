# Grok Build session ingestion

AIWG registers `grok-build` separately from `grokbot`. Session ingestion uses
the public Grok Build CLI contract:

```bash
grok sessions list
grok sessions search "query"
grok export <session-id> <session-id>.md
aiwg sessions import <session-id>.md \
  --provider grok-build \
  --source-id grok-build-<session-id> \
  --workspace "$PWD"
```

Keep the UUID session ID as the export filename. AIWG uses it as native
identity, parses only the documented CLI Markdown headings (`User`,
`Assistant`, and `Tools`), and fails with `MALFORMED_SOURCE` or `SCHEMA_DRIFT`
when the filename or export shape changes. Reimporting the same file is
deterministic and idempotent.

Grok Build resolves its own storage under `$GROK_HOME/sessions` (default
`~/.grok/sessions`). AIWG does not read that tree, follow session-store
symlinks, or inspect Grok Bot and Cursor stores. Native parsing remains disabled
until sanitized files from a released binary qualify the schema and exact
version range. Use `grok sessions list` or `search` for discovery and `grok
export` for acquisition.

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
sanitized synthetic CLI Markdown exports aligned to public harness revision
`4247f661689354b831191f11eeeac8424993fe3d`. The adapter tests cover exact
heading parsing, prompts, assistant output, tool calls, native identity,
provenance, unavailable fields, changed output, unsupported native/Cursor
locators, symlink escape rejection, deterministic replay, and idempotency.
