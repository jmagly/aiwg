# Grok Build 1.0.77 headless excerpts (2026-11-09)

Derived offline from the operator-supplied `cli/headless-*.out` captures.
These are reduced shape fixtures, not complete transcripts: one frame per
stream event type, assistant/user rounds collapsed, text/tool content replaced
with synthetic strings, command catalogs emptied, paths and all IDs replaced.
No system prompt, local identities, signatures or tool output is retained.
Usage, cost, model names, stop reasons and result error fields are captured values.
The plain fixture is synthetic text representing the captured plain format.

`stream.ndjson` ends successfully; `result.json` and `messages.ndjson` were
cancelled in the captures. Success/error mutations in tests are synthetic.
Message-stream success, ACP, native agent frontmatter, native fan-out caps,
worktree dispatch and Windows execution are not established by these captures.
