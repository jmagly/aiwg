# Grok Build 1.0.77 capture projections (2026-11-10)

Small sanitized projections of operator-supplied released-binary captures. No live
calls are made by tests. Paths and every retained session, agent, request, event
and tool ID are synthetic. System prompts, tool definitions, encrypted reasoning,
background user context and unrelated updates are omitted. Synthetic context
replaces reminder/compaction text; only text/tool turns needed by tests remain.

Session UUID suffixes identify:
- `001`: same-ID resume, two appended turns (the initial prefix is tested separately).
- `002`: fork of `001`, copied history plus a new turn; summary exposes lineage.
- `003`: headless subagent parent, two explicit metadata/output pairs.
- `004`, `005`: child sessions; summaries have no parent field (do not infer one).
- `006`: ACP-backed compacted history, compaction_meta and surviving turns;
  updates retain the original three turns, /compact and auto_compact_completed.

Missing summaries, unknown record types and truncated tails are test mutations,
not claims of captured corruption. No attachment ownership or uncaptured TUI-only
feature is qualified. The earlier 2026-11-09 interactive summary omits session_kind;
absence alone does not identify a transport or kind.
