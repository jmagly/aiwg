# Sanitized Grok Build 1.0.77 projections

Source: operator-supplied captures dated 2026-11-09, public harness revision
`4247f661689354b831191f11eeeac8424993fe3d`. These are small shape-preserving
projections, not full transcripts. They contain no system prompt text, original
local paths, user/host identifiers, session/request/tool IDs or encrypted reasoning.
All retained identifiers and paths are synthetic. Tool commands are data only.

- UUID Markdown file: TUI CLI export with multiline tool commands and no tool output.
- `sessions-list.txt`, `sessions-search.txt`: captured CLI row/heading grammar.
- `headless.json`: result key/type projection; no prompt/response content retained.
- `streaming.jsonl`: one event per observed type; no full response, tools or commands.
- `chat_history.jsonl`, `summary.json`: observed native text/tool record and metadata
  shapes with synthetic content; copied under an encoded cwd/UUID layout in tests.

The old `native-layout/` fixtures now use these observed record shapes with their
existing synthetic test content and matching summary metadata. They are not
additional captures. `native-active-sessions.json` remains synthetic/unqualified.

Missing evidence: ACP, compaction, resume/fork parent/child identity, subagents,
attachment/snapshot ownership, Windows paths, native headless storage, active
registry, cross-version drift, and live interrupted/corrupt stores. Test mutations
cover partial/corrupt/unknown records without claiming these missing captures.
