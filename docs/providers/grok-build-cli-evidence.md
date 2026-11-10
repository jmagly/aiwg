# Grok Build CLI 1.0.50 — preserved evidence extracts (#2906)

Current headless update (#2577, 2026-11-09): supplied 1.0.77 captures accept
`--no-auto-update`, so the bounded headless transport restores that switch.
It now also parses `streaming-messages-json` separately from `streaming-json`.
The [sanitized excerpts](../../test/fixtures/providers/grok-build/headless-1.0.77/README.md)
and [replay tests](../../test/unit/providers/grok-build-headless.test.ts) cover
the observed successful stream and cancelled JSON/message results. See the
[claim dispositions](grok-build-native-agents.md) for limits. Historical 1.0.50
flag observations below do not override this later captured invocation.

This file preserves the exact documentation extracts the `grok-build`
direct-shell profile's safety claims rely on, so they are independently
checkable rather than taken on an agent's paraphrase.

**Binary**: `grok 1.0.50 (c58f321264ba, stable)`, `~/.grok/bin/grok` on host
`noodle`. Confirmed via `grok --version` → `grok 1.0.50 (c58f321264ba)
[stable]`.

**Commands used to gather this evidence** (help/version syntax and read-only
documentation extraction only; `grok` was never run with a prompt or any
other argument that could start a turn):

```sh
ssh noodle 'PATH=$HOME/.grok/bin:$PATH grok --help'
ssh noodle 'PATH=$HOME/.grok/bin:$PATH grok --version'
ssh noodle 'PATH=$HOME/.grok/bin:$PATH grok agent --help'
ssh noodle 'strings -n 3 ~/.grok/bin/grok'   # bundled markdown docs embedded in the compiled binary
```

`sha256sum ~/.grok/bin/grok` was **not** captured in this pass (the binary
was reachable only over SSH under time pressure); re-run and record it
before treating this evidence as durable. The full captured root `--help`
output is at `.aiwg/working/s1-scratch/cli-help/grok-1.0.50.txt`.

## 1. Permission modes (`--permission-mode <MODE>`)

Root `--help`:

```
--permission-mode <MODE>
        Permission mode

        [possible values: default, acceptEdits, auto, dontAsk, bypassPermissions, plan]
```

The installed binary's own bundled documentation (extracted via `strings`)
gives the per-mode semantics table verbatim:

```
## Permission modes
When Grok edits a file, runs a command, or calls an external tool, it may pause for approval. Permission modes control how often that happens.
Modes set a baseline. Allow, ask, and deny rules still apply on top of any mode.
### Available modes
| Mode | What runs without asking | Best for |
| ---- | ------------------------ | -------- |
| `default` (**ask**) | Read-only tools and built-in read-only shell commands | Interactive day-to-day use |
| `acceptEdits` | File edits without a prompt | Local coding while you review diffs later |
| `plan` | Accepted for compatibility; use plan mode for gated planning | Claude-compatible settings |
| `auto` | Work the safety check allows; other calls are blocked or escalated | Interactive sessions that want fewer prompts |
| `dontAsk` | Only pre-approved tools and built-in read-only handling | Strict CI allowlists |
| `bypassPermissions` (**always-approve**) | Tool calls in general (`deny` rules, hooks, and some shell `ask` rules still apply) | Trusted automation and agent servers |
```

Supporting detail on `dontAsk`'s deny-by-default behavior (same bundled
doc, hook-interaction section):

```
`dontAsk` mode denies whatever it would have to prompt for, so there an ask turns an otherwise-approved call into a denial.
```

**Why `dontAsk` and not another mode** (reasoned from the table above, not
assumed): `default` prompts interactively and would hang a headless run
waiting for an answer that never arrives. `acceptEdits` only auto-approves
file edits — other tool calls (e.g. shell commands) can still prompt.
`plan` is a planning mode; its exact execution behavior is unverified here. `bypassPermissions` ("always-approve") is
the blanket-bypass mode the project's rules forbid. `auto`'s own
description ("other calls are blocked or escalated") does not document
what "escalated" means for a non-interactive run — it is NOT selected here
because that escalation path is unqualified, not because it is proven
unsafe. `dontAsk` is therefore the only mode the help text positively
documents as both non-interactive ("Strict CI allowlists") and non-bypass
(denies rather than auto-approves anything outside what was pre-approved).

**What remains unverified**: whether a tool call that `dontAsk` denies
produces an immediate failure, a silent no-op, or a hang waiting on
`ask_user_question` is not stated by this documentation and was not tested
live. The registry entry and `docs/providers/grok-build-direct.md` mark
this as an open risk, not a settled behavior.

## 2. Sandbox profiles (`--sandbox <PROFILE>`, `GROK_SANDBOX`)

Root `--help`:

```
--sandbox <PROFILE>
        Sandbox profile for filesystem and network access

        [env: GROK_SANDBOX=]
```

Bundled environment-variable reference (`strings`-extracted):

```
| `GROK_SANDBOX` | Sandbox profile (off, workspace, devbox, read-only, strict; or a custom profile name) |
```

Bundled sandbox documentation, profile resolution order and per-profile
semantics (verbatim):

```
Profile resolution order for a **new** session:
1. An explicit `--sandbox <profile>` flag or `GROK_SANDBOX` environment variable
2. The `[sandbox] profile` in your config
3. `off` (no sandbox)

### Profile Details
**workspace** -- The recommended profile for everyday development. The agent can read any file on the system (for understanding dependencies, system libraries, etc.) but can only write to the current working directory, `~/.grok/`, and temp directories (`/tmp`, `/var/tmp`, plus the macOS temp dirs). Network access is allowed for tools like `web_search` and MCP servers.
**devbox** -- A reserved built-in profile for disposable development VMs. The agent can read everywhere and write to every top-level directory except `/data` and the virtual filesystems (`/proc`, `/sys`, `/dev`), including the home directory. Network access is allowed.
**read-only** -- Use when you want the agent to analyze code without modifying your project files. The agent can read everything but can only write to `~/.grok/` (needed for session persistence) and temp directories. Child-process network access is blocked on Linux (no-op on macOS).
**strict** -- The most restrictive profile, for reviewing untrusted code. The agent can read the current working directory, essential system paths, and `~/.grok`. Writes are limited to CWD, `~/.grok/sessions`, and temp directories -- not the whole `~/.grok` tree. Child-process network access is blocked on Linux (no-op on macOS).
```

**Why `read-only` → `read-only` and `workspace-write` → `workspace`, and
never `off`/`devbox`/`strict`**: `off` is explicitly "no sandbox" — the
resolution order above shows it is also the silent default when no flag is
passed at all, which is exactly why this profile always emits `--sandbox`
explicitly. `devbox` is documented as "read everywhere and write to every
top-level directory except `/data`" — broader than this profile's two
semantic modes need. `strict` is more restrictive than `workspace-write`
needs and was not selected for either of the profile's two modes to keep
the mapping to exactly the two documented profiles whose own descriptions
match "read-only" and "read-write limited to the workspace" respectively.

## 3. Reasoning effort values (`--reasoning-effort <EFFORT>`, alias `--effort`)

Root `--help` lists the flag but not its value enum. The installed
binary's own error-message text (`strings`-extracted) gives the full,
authoritative value set:

```
invalid reasoning effort: '%s' (expected one of: none, minimal, low, medium, high, xhigh, max)
```

## 4. `--output-format` values and the two distinct event shapes

Root `--help`:

```
--output-format <OUTPUT_FORMAT>
        Output format for headless mode

        Possible values:
        - plain
        - json
        - streaming-json:          NDJSON: one ACP session update per line, the agent's native format
        - streaming-messages-json: NDJSON in the Anthropic Messages API wire format

        [default: plain]
```

Bundled output-format documentation (`strings`-extracted), confirming
`json` is a **single object**, structurally different from `streaming-json`:

```
### json
A single JSON object emitted after the response completes: response text,
stop reason, session ID, request ID (plus `thought` when reasoning is present).
```
example fields: `text`, `stopReason`, `sessionId`, `requestId`, `num_turns`, `usage`, `modelUsage`, `total_cost_usd`.

```
### streaming-json
Newline-delimited JSON, one `type`-tagged object per line, derived from the agent's ACP session updates.
```
```json
{"type":"thought","data":"Analyzing the directory structure..."}
{"type":"tool_call","toolCallId":"call_1","title":"Read","kind":"read","status":"in_progress","toolName":"read_file","rawInput":{"path":"src/main.rs"},"content":[],"locations":[]}
{"type":"tool_call_update","toolCallId":"call_1","status":"completed","content":[],"rawOutput":{"lines":42},"locations":[]}
{"type":"text","data":"Here's a summary"}
{"type":"usage","messageId":"resp_1","stopReason":"end_turn","usage":{...},"signature":"..."}
{"type":"end","stopReason":"end_turn","sessionId":"abc123","requestId":"xyz789","usage":{...},"num_turns":7,"modelUsage":{...}}
```
Event-type table (verbatim):
```
| Type               | Description |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `text`              | A chunk of the agent's response text |
| `thought`           | Internal reasoning (thinking tokens) |
| `tool_call`         | A tool call the agent started (`toolCallId`, `toolName`, `kind`, `status`, `rawInput`, `content`, `locations`) |
| `tool_call_update`  | Progress or result for a tool call (`status`, `rawOutput`, `content`, `locations`) |
| `usage`             | Per-response boundary (`messageId`, `stopReason`, `usage`, `signature`), one per model response |
| `plan`              | The agent's current plan (`entries`) |
| `available_commands`| Tool and slash command lists (`tools`, `commands`) |
| `end`               | Final event with metadata and spend fields when available |
| `error`             | An error occurred (carries `message`, and spend fields if any) |
```
"`end` is always the last event." `end.stopReason` values (verbatim):
`end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`.

**Legacy transport alignment (#2994):** `src/providers/grok-build-headless.ts`,
the shared `grok-build` health observer and the native smoke now interpret this
same ACP vocabulary. JSON mode requires the single result object's `text`
string and validates its `stopReason`; streaming mode requires `end_turn` on
`end`, latches failed tool calls and errors, and rejects events after a terminal
event. Headless and smoke reject unknown or legacy `message`/`result` frames
even before a successful `end`; smoke uses the existing shared health observer
to recognize ACP events. The unsupported
`--no-auto-update` flag was removed from legacy headless/smoke argv. Their
synthetic fixtures under `test/fixtures/providers/grok-build/health/` mirror
these documented events. The merged direct adapter and its approved module
digest remain unchanged. The initial alignment was documentation-backed:
no live capture or account/timing qualification was performed in that repair.
The supplied 1.0.38 capture below now backs stream compatibility for #2994;
it does not qualify the 1.0.50 direct-shell invocation or its permission modes.

### Live capture (1.0.38, 2026-10-25)

An authenticated **grok 1.0.38** run captured on **2026-10-25** used
`--output-format streaming-json` with the prompt
`Run the shell command 'echo hi' then reply with exactly: ok`.
The supplied evidence is retained as the scrubbed
[stream fixture](../../test/fixtures/providers/grok-build/health/live-1.0.38-stream.ndjson)
and a separate
[single JSON result fixture](../../test/fixtures/providers/grok-build/health/live-1.0.38-result.json).
The adjacent [README](../../test/fixtures/providers/grok-build/health/README.md)
records provenance and scrubbing. No additional Grok invocation was made to
prepare or replay these fixtures.

Observed order: two `available_commands`, thirteen `text` chunks,
`available_commands`, `usage`, `tool_call`, four `tool_call_update`, final
`text` (`ok`), `available_commands`, `usage`, `end`. All 26 events use the
documented ACP vocabulary. Differences from the 1.0.50 documentation examples:

- The initial `tool_call.status` is `pending`, rather than the example's
  `in_progress`. Update statuses are `null`, `in_progress`, `in_progress`,
  `completed`; the null-status update also has `rawOutput: null`.
- Both `usage` events contain only `type`, `usage`, and `signature`:
  `messageId` and `stopReason` are absent. The first usage boundary precedes
  tool execution, and the second follows the final answer. Usage is also
  aggregated on `end`, consistent with the documented placement.
- `end` contains `stopReason: end_turn`, `sessionId`, `requestId`, `usage`,
  `num_turns: 2`, `modelUsage`, `total_cost_usd`, and the additional
  `total_cost_usd_ticks` field. Usage uses snake_case token names; model
  usage uses camelCase. No documented field-name conflict was observed.
- Tool output includes nested ACP content wrappers and a structured `Bash`
  `rawOutput` (byte-array output, exit code, paths and execution metadata),
  rather than the documentation's minimal example object.

The separate JSON capture is one object with `text: ok`, `stopReason:
end_turn`, IDs, aggregate usage, `num_turns: 1`, both cost fields and
`modelUsage`; it is not an NDJSON event. The transport's JSON test preserves
that distinction.

No parser or observer behavior change was needed: existing handling permits
pending/null tool updates, treats usage as activity without requiring its
optional identifiers, and recognizes `end_turn` as terminal success. Offline
tests replay the live fixtures through the headless parser, shared health
observer, and direct adapter (per-event parity, chunked health framing, and
final-answer extraction across usage/tool boundaries). `thought`, `plan`,
`error`, and failure stop reasons remain covered by synthetic vectors; they
were not observed in this successful capture. Account/timing qualification
and a live 1.0.50 run remain outside this evidence.

## 5. Authentication

```
export XAI_API_KEY="xai-..."
```
and: `3. XAI_API_KEY -- fallback when no session token is active.`
`Auth method: API key (XAI_API_KEY)`. This is the one credential env var
named in the registry's `envAllowlist` (`["XAI_API_KEY", "HOME"]`); only
the variable *name* is allowlisted for pass-through, never a value
rendered into argv or logs.


## Supplied 1.0.77 capture update (2026-11-09)

The [Linux capture review](grok-build-evidence/2026-11-09.md) supersedes older
flag assumptions for **1.0.77**: `--no-auto-update` is present in the captured
headless command, alongside `--allow "Bash(aiwg *)"`, `--max-turns 6`, and the
four `--output-format` values. No new CLI or model invocation was performed.

The single-result key set includes `cwd` and `thought` as well as usage, cost,
turn count and session/request metadata. Observed streaming types are `text`,
`thought`, `tool_call`, `tool_call_update`, `available_commands`, `usage`, and
`end`. The [structural snapshot](../../test/fixtures/providers/grok-build/capture-1.0.77/snapshot.json)
backs an offline schema comparison; it does not substitute for full CLI help,
config/InspectReport JSON schemas, ACP negotiation, or negative transport cases.
The [drift procedure](grok-build-qualification.md#clischema-drift-check-and-proposed-scheduling)
keeps those missing captures explicit and proposes operator-approved scheduling.
