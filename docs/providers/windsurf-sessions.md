# Devin Desktop session ingestion (`devin-desktop`)

The canonical session provider ID is `devin-desktop`. AIWG accepts `windsurf`
as a deprecated compatibility alias through at least 2027-07-27 and for one
major release after this policy ships. The current product and documentation
surface is **Devin Desktop**. The legacy Windsurf Cascade Hooks URL redirects to Devin Docs. This adapter was
verified against the current Devin Desktop hook contract, not an archived legacy Windsurf schema.

Alias resolution happens before stable session identity derivation. Both names
therefore use the historical `windsurf` identity seed and resolve to the same
normalized session/event rows. On catalog open, older source/session JSON and
`native.windsurf` envelopes migrate in place to `devin-desktop` and
`native.devin-desktop`; stable IDs and receipts do not change. Recovery is to
restore the catalog backup made by the operator before an application upgrade.
Rollback code may continue reading the compatibility envelope during the
window. The alias can be removed only after telemetry shows no supported
clients use it, the documented date has passed, and a major-version migration
with rollback instructions is available.

Ingestion is strictly opt-in. AIWG neither discovers nor edits system, user, or workspace hook
configuration. A user or administrator enables `post_cascade_response_with_transcript`, then explicitly
selects one of its JSONL outputs for import. The adapter does not read credentials or environment variables.

The transcript is treated as provisional even though each hook fires after a completed Cascade response:
it is not a live-token feed, does not prove complete historical capture, and Devin Desktop retains at most
100 transcript files before evicting the oldest by modification time. Records preserve trajectory and
execution IDs, timestamps, model labels, provider status, sensitive-content warnings, and unknown fields.
Unknown schema majors, mixed schemas, mixed trajectories, malformed steps, and ambiguous timestamps fail
closed. Legacy private protobuf stores remain unsupported.

The hook transcript can contain workspace files, command output, tool arguments, search results, rules, and
conversation history. AIWG records that warning as provenance; it does not inspect credentials or
environment variables. Recursive repository policy classifies and sanitizes
native attributes before persistence, while normalized text follows the same
redaction boundary.

## Current evidence

Verified 2026-07-27:

- <https://docs.devin.ai/desktop/cascade/hooks>
- <https://windsurf.com/switch/cursor>

The current hook contract names `trajectory_id`, `execution_id`, `timestamp`, `model_name`, and `tool_info`;
documents the `post_cascade_response_with_transcript` JSONL path and step shape; warns that step structures
may evolve; specifies `0600` transcript permissions; and documents the 100-file retention cap.
