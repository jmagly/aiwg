# Grok Build ACP live capture — 2026-11-21

`acp-live.json` retains all 72 timestamped in/out JSON-RPC frames and the
conductor's result summary from the live titan run, reported CLI version
1.0.77, using an existing grok.com login. No model calls are made by replay.
The initialize payload advertises `_meta.agentVersion: 1.0.92`; this differs
from the conductor's CLI version and is preserved without reinterpretation.

The supplied source was `grok-1.0.77-acp-live-20261121.json`, SHA-256
`3dca744bb4571f931966bead7f690e5914ae3ac06908ef941919679ae132810e`.
Temporary project/home paths were already placeholders and the conductor
reported no credential-like strings. No auth/token files were read.
The only additional sanitization replaces each of the three
`available_commands_update.availableCommands` inventories with the captured
generic `compact`, `context`, and `session-info` entries. Operator-installed
skill entries are omitted. All other protocol fields, ids, offsets, summaries,
notifications, chunks, usage and cancellation metadata are unchanged. The
4,276 stderr bytes are a count in the summary; stderr logs were not supplied.

Observed sequence: initialize (protocol 1, `cached_token` + `grok.com`, default
`cached_token`), session/new without authenticate, first prompt (`OK`,
`end_turn`, `_meta.modelId: grok-4.7`, usage key `grok-4.7-build`), second
prompt followed 1,500 ms later by session/cancel (`cancelled`,
`cancellationCategory: MidTurnAbort`). Process exit was 0. Update kinds include
`available_commands_update`, `agent_thought_chunk`, and `agent_message_chunk`.

`test/unit/providers/grok-build-acp.test.ts` uses `replay-acp.mjs` to validate
each outgoing request and replay every incoming frame in order. Only JSON-RPC
request/response ids and the outgoing temporary cwd are remapped. Replies are
gated by requests rather than wall-clock offsets; cancellation completion is
withheld until session/cancel arrives. It tests cached login selection both
without an API key and with a synthetic key when API-key auth is not offered.

This satisfies #2577 criterion 5's live ACP protocol check for this Linux login
state. It does not establish resident lifecycle, cross-platform support,
combined fan-out guard enforcement, or managed-dispatch admission. No new
live qualification runner or evidence schema is introduced.
