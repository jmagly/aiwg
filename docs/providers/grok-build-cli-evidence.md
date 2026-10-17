# Grok Build CLI 1.0.50 — preserved evidence extracts (#2906)

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
digest remain unchanged. This alignment is documentation-backed only: no live
capture or account/timing qualification was performed for #2994.
The live-capture acceptance item remains open: help/bundled documentation and
synthetic replay do not establish live stream compatibility. No prompt/model
call is authorized in this repair session.

## 5. Authentication

```
export XAI_API_KEY="xai-..."
```
and: `3. XAI_API_KEY -- fallback when no session token is active.`
`Auth method: API key (XAI_API_KEY)`. This is the one credential env var
named in the registry's `envAllowlist` (`["XAI_API_KEY", "HOME"]`); only
the variable *name* is allowlisted for pass-through, never a value
rendered into argv or logs.
