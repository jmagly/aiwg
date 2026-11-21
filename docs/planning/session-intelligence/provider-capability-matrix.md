# Provider Capability Matrix

Evidence date: 2026-07-26

Classification describes the best supported acquisition path. Provider
versions and schemas must be probed at runtime; the versions below are research
baselines, not compatibility promises.

| ID | Surface and baseline | Classification | Initial implementation | Confidence |
|---|---|---|---|---|
| `claude` | Claude Code documented JSONL and hooks | `documented_local_adapter` | Complete-record JSONL snapshots; lifecycle hooks for active/provisional state | High |
| `codex` | Codex App Server and rollout JSONL | `native_api_export` | App Server first; version-tolerant rollout JSONL fallback | High |
| `copilot` | VS Code chat JSON export/session sync | `native_api_export` | Explicit JSON export first; experimental local-store adapter separately gated | High |
| `cursor` | CLI/cloud streams; editor Markdown export | `native_api_export` | CLI/cloud adapters plus lossy editor Markdown import; no supported SQLite collector | High |
| `factory` | Droid API/Exec and SDK-documented JSONL | `documented_local_adapter` | Local versioned JSONL; optional organization API/stream capability | High |
| `hermes` | Hermes 0.19.0 exports; schema 23 SQLite | `native_api_export` | Native JSONL export first; local API or consistent SQLite snapshot fallback | High |
| `opencode` | CLI export, HTTP API, SDK, SSE | `native_api_export` | Sanitized export for closed sessions; API/SSE for active sessions | High |
| `openclaw` | OpenClaw 2026.7.2 schema 16/event v3 | `documented_local_adapter` | Gateway or consistent SQLite/event acquisition; bounded APIs are degraded projections | High |
| `openhuman` | OpenHuman 0.63.1 transcript schema 1 | `documented_local_adapter` | `session_raw` JSONL plus thread/turn enrichment; preserve compaction and interruption | Medium-high |
| `warp` | User-initiated Markdown export | `manual_import_only` | Explicit Markdown import; no SQLite/protobuf reverse engineering | High |
| `devin-desktop` (`windsurf` alias) | Opt-in post-response transcript hook | `documented_local_adapter` | Current hook JSONL capture; legacy protobuf unsupported | High |
| `generic` | AIWG-owned declared interchange | `manual_import_only` | Versioned generic envelope only; opaque guessed JSON/JSONL unsupported | High |

## Provider-Specific Constraints

### Claude

Documented transcripts reside below `~/.claude/projects/`. Resume appends and
fork creates a new session. Read only complete newline records from active
files. Project cleanup defaults and prompt-history retention are separate.

Sources: [session persistence](https://code.claude.com/docs/en/how-claude-code-works),
[local storage](https://code.claude.com/docs/en/claude-directory),
[hooks](https://code.claude.com/docs/en/hooks).

### Codex

App Server exposes thread listing, reading, turn pagination, status, fork,
archive, and deletion. Rollout JSONL under `~/.codex/sessions/` is the durable
local replay format; SQLite is an index.

Sources: [App Server](https://learn.chatgpt.com/docs/app-server),
[protocol](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs).

### Copilot

VS Code supports explicit JSON export and GitHub session synchronization.
Current local stores use version-dependent JSON/JSONL operation logs, but that
storage is not a stable public API.

Sources: [chat sessions](https://code.visualstudio.com/docs/chat/chat-sessions),
[session sync](https://code.visualstudio.com/docs/agents/sessions/session-sync).

### Cursor

CLI and cloud agents have structured events and durable run APIs. Editor chat
has a supported Markdown export but no current stable SQLite contract.

Sources: [CLI output](https://cursor.com/docs/cli/reference/output-format),
[SDK](https://cursor.com/blog/typescript-sdk),
[data use](https://cursor.com/data-use).

### Factory

The SDK documents project-grouped session JSONL under `~/.factory/sessions/`.
Organization APIs are richer but not universally available.

Sources: [Sessions API](https://docs.factory.ai/api-reference/sessions/list-sessions),
[SDK discovery](https://github.com/Factory-AI/droid-sdk-typescript/blob/c35b42b12a043f9f10053e854ff0d9306d2d60e9/src/session-discovery.ts).

### Hermes

Canonical history is `state.db`; native exports include JSONL, Markdown, QMD,
HTML, and trace formats. Active exports are mutable. Archive and compaction do
not prove deletion.

Sources: [storage](https://hermes-agent.nousresearch.com/docs/developer-guide/session-storage),
[sessions](https://hermes-agent.nousresearch.com/docs/user-guide/sessions/).

### OpenCode

OpenCode exposes sanitized JSON export, OpenAPI/SDK session APIs, and SSE.
Direct SQLite access is not the normal adapter.

Sources: [CLI](https://opencode.ai/docs/cli/),
[server](https://opencode.ai/docs/server/),
[sharing](https://opencode.ai/docs/share/).

### OpenClaw

The Gateway owns durable state. Event history includes window, lineage,
compaction, reset, and tree identity. HTML/history surfaces can omit tool or
backend content and are not universal lossless exports.

Sources: [database schemas](https://docs.openclaw.ai/reference/database-schemas),
[sessions](https://docs.openclaw.ai/concepts/session),
[security](https://docs.openclaw.ai/gateway/security/).

### OpenHuman

`session_raw` is the full-fidelity append-only source. Thread deletion does not
delete matching raw transcripts, and attachment bytes may expire independently.

Source: [transcript implementation](https://github.com/tinyhumansai/openhuman/blob/ee1fa76081bc03a9e18d7684e9150ecd0f186f69/src/openhuman/agent/harness/session/transcript.rs).

### Warp

Warp documents user-initiated Markdown export but no stable bulk transcript
API. Internal SQLite/protobuf parsing is out of scope.

Sources: [slash commands](https://docs.warp.dev/agent-platform/capabilities/slash-commands),
[privacy](https://docs.warp.dev/support-and-community/privacy-and-security/privacy).

### Devin Desktop

The transcript hook writes full Cascade JSONL to an opt-in directory, has
bounded retention, and explicitly permits schema change. Legacy protobuf files
remain unsupported.

Source: [Cascade hooks](https://docs.devin.ai/desktop/cascade/hooks).

### Generic

Generic import requires an AIWG-owned versioned envelope with explicit identity,
ordering, lifecycle, timestamps, and provenance. AIWG must not infer those
semantics from arbitrary field names.
