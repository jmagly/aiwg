# Grok Build CLI direct-worker profile (B-OG-41, #2906)

This is the lightweight CLI profile for dispatching `grok` (Grok Build CLI)
as a direct worker.

The exact `--help` and bundled-documentation extracts this profile's safety
claims (permission-mode semantics, sandbox-profile semantics, the
reasoning-effort value set, and the `json`-vs-`streaming-json` event shape
distinction) rely on are preserved verbatim, with the command used and
binary version, in
[`grok-build-cli-evidence.md`](./grok-build-cli-evidence.md).

The bundled `direct-shell` invocation profile in
`agentic/code/providers/model-capabilities.v1.json` is version-bound to
`grok 1.0.50 (c58f321264ba, stable)` and help-evidenced only (`H:` evidence
grade, captured from `grok --help` on host `noodle`, 2026-10-10;
`.aiwg/working/s1-scratch/cli-help/grok-1.0.50.txt`, plus the installed
binary's own bundled docs read with `strings` — never a live prompted run).
It stays `unqualified` for dispatch until a human qualifier reviews a live
run. The adapter (`tools/ralph-external/lib/grok-build-adapter.mjs`)
renders:

```
grok --prompt-file <briefPath> -m <model> --reasoning-effort <effort> \
  --permission-mode dontAsk --sandbox <profile> --cwd <workspace> \
  --output-format streaming-json --no-subagents --disallowed-tools workflow --no-plan \
  --no-alt-screen --disable-web-search \
  [--allow <rule> ...] [--deny <rule> ...]
```

**The brief rides on `--prompt-file`, never argv text or stdin.**
`-p/--single <PROMPT>` and `--prompt-json <JSON>` only accept inline argv
text/JSON; `--prompt-file <PATH>` ("Single-turn prompt from a file") is a
standalone single-turn trigger, so this profile uses it alone and never
emits `-p`.

The 2026-11-10 1.0.77 [capture replay tests](../../test/unit/providers/grok-build-headless.test.ts)
show `workflow` spawning two children despite `--no-subagents`. This profile
also emits `--disallowed-tools workflow`; [conformance tests](../../test/conformance/orchestration-v1/grok-build-direct.test.ts)
check both the template and rendered argv. Combined live enforcement and
compatibility with the older pinned 1.0.50 profile remain unverified.

**`--permission-mode dontAsk` remains the profile's fixed permission mode.**
Root `--help` lists `[possible values: default, acceptEdits, auto, dontAsk,
bypassPermissions, plan]`. The installed binary's own bundled
permission-modes documentation (read via `strings`, not invented)
describes each: `default` prompts interactively; 1.0.77 headless captures cancel
approval-requiring `spawn_subagent` and `workflow` calls with “a headless run
cannot ask for approval”, including a spawn attempt with `--allow spawn_subagent`.
`--permission-mode auto` ran these tools in the captures; AIWG keeps its defaults.
`acceptEdits` only auto-approves file edits, other tool calls may still
prompt; `plan` is a planning mode (its exact execution behavior is unverified); `bypassPermissions` ("always-approve") is
the blanket bypass this profile must never select (same family as
`--always-approve`, also never emitted). `dontAsk` ("Only pre-approved
tools and built-in read-only handling" / "Strict CI allowlists" / "denies
whatever it would have to prompt for") is
documented for strict allowlists, so this profile fixes it and never parameterizes it.
Because `dontAsk` denies anything not pre-approved, a write-capable run
needs explicit `--allow`/`--deny` rules (e.g. `Edit`, `Bash(git *)`) from
the resolved permission tuple; a rule starting with `-`, containing a
control character, or equal to a banned blanket-bypass spelling (including
a bare `*`) is refused before argv is built.

**An explicit sandbox profile is emitted for every mode, including
read-only.** The CLI's own bundled sandbox documentation names the
built-in profiles as `off, workspace, devbox, read-only, strict` (or a
custom profile from `sandbox.toml`), and states the default with no flag
at all is `off` (no sandbox). This profile never relies on that default:
`read-only` maps to the CLI's own `read-only` profile and `workspace-write`
maps to the CLI's `workspace` profile ("the recommended profile for
everyday development"). `devbox` (near-unrestricted write) and `off` are
never emitted. `capabilities.sandboxModes` is `["read-only",
"workspace-write"]`.

**No `--no-ask-user`-equivalent flag is in this version's printed `--help`
for the root command.** An internal `no-ask-user`/`NO_ASK_USER` argument
name exists in the compiled binary's own strings, but it is not in the
captured `--help` text, so — per the help-listed-spellings rule — it is
never emitted here. Whether an `ask_user_question` tool call blocks
indefinitely under `dontAsk` in a genuinely non-interactive run is
therefore **not evidenced** and stays an open risk, not invented away.

**The ACP-derived `streaming-json` event grammar is unusually
well-evidenced for a compiled binary.** `--output-format streaming-json`
is "NDJSON: one ACP session update per line, the agent's native format"
per `--help`. The installed binary's own bundled output-format
documentation (read via `strings`, not invented) gives the full event
vocabulary and an example stream:

```json
{"type":"thought","data":"Analyzing the directory structure..."}
{"type":"tool_call","toolCallId":"call_1","title":"Read","kind":"read","status":"in_progress","toolName":"read_file","rawInput":{"path":"src/main.rs"},"content":[],"locations":[]}
{"type":"tool_call_update","toolCallId":"call_1","status":"completed","content":[],"rawOutput":{"lines":42},"locations":[]}
{"type":"text","data":"Here's a summary"}
{"type":"usage","messageId":"resp_1","stopReason":"end_turn","usage":{...},"signature":"..."}
{"type":"end","stopReason":"end_turn","sessionId":"abc123","requestId":"xyz789","usage":{...},"num_turns":7,"modelUsage":{...}}
```

`end` is documented as always the last event; its `stopReason` is one of
`end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`. Both
`observeHealthEvent` and the adapter's own `parseDirectFinal` treat only
`stopReason === 'end_turn'` as success: a standalone `error` event, or any
`tool_call`/`tool_call_update` with `status: 'failed'`, fails the run even
if it exits zero or is followed by a clean-looking `end` — a later success
never repairs an earlier failure. This grammar is read from the compiled
binary's own bundled strings and is **never live-observed**.

**This grammar is distinct from `--output-format json`.** The bundled docs
confirm `json` emits ONE object
(`text`/`stopReason`/`sessionId`/`requestId`/`usage`/...), not NDJSON lines.
The current bounded `src/providers/grok-build-headless.ts` transport also
parses these two formats separately and rejects legacy `type: "message"` /
`type: "result"` frames. Its fixtures live under
`test/fixtures/providers/grok-build/health/`. This direct-shell profile's
ACP fixtures live separately under
`test/fixtures/providers/grok-build/direct-health/`.

**No flag disables a user/project-configured MCP server.** Grok has no
*built-in* MCP server to disable (unlike Copilot's bundled
`github-mcp-server`); `--disable-web-search` removes the one evidenced
built-in external-network tool (`web_search`/`web_fetch`) so the AIWG
`worker-invoke` bridge remains the one external route this profile
authorizes. Whether a project's own `mcp.json` servers load regardless of
this profile's flags is unqualified, not invented away.

The 2026-10-26 source review of public commit
`2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8` found one additive streaming
change: whole-turn totals also emit `{"type":"usage","usage":{...}}`,
without `messageId`, `stopReason`, or `signature`. These frames are activity,
not completion proof. The existing parser preserves the final text through
consecutive response/turn usage frames and still requires a successful `end`.
This source review does not requalify the version-bound 1.0.50 direct profile
or establish a live run.

### Manual smoke run

Live qualification is an open S1 blocker. `grok` authenticates via
`XAI_API_KEY` (or a cached `grok login` session) — the conductor's smoke
run needs a key from the operator, supplied through the environment only,
never argv:

```sh
MODEL="<exact observed model id>"   # e.g. from `grok models`; never 'auto'/'default'
d=$(mktemp -d) && cd "$d"
echo 'Reply with exactly: grok-smoke-ok' > brief.md
XAI_API_KEY="$XAI_API_KEY" grok --prompt-file brief.md -m "$MODEL" \
  --reasoning-effort low --permission-mode dontAsk --sandbox read-only \
  --cwd "$d" --output-format streaming-json --no-subagents --disallowed-tools workflow --no-plan \
  --no-alt-screen --disable-web-search </dev/null
echo "exit=$?"
```

`</dev/null` is deliberate: stdin is never used by this profile, so
closing it removes any chance of waiting on a terminal that will never
answer.

### Reading the result

- **Exit code**: `echo "exit=$?"` must print `exit=0`. Any non-zero exit is
  a fail.
- **Every stdout line is a JSON object with a `type`**, and the **last**
  line is `{"type":"end",...}` with `"stopReason":"end_turn"`. Any
  malformed line, any `{"type":"error",...}` line anywhere, any
  `tool_call`/`tool_call_update` line with `"status":"failed"`, or an `end`
  whose `stopReason` is not `end_turn`, is a fail — even if the process
  exits zero (the adapter's `parseDirectFinal` already rejects all of
  these; see `tools/ralph-external/lib/grok-build-adapter.mjs`).
- **No hang**: the run must exit on its own within a short bound. A
  process still running past the expected completion window is a fail.
- **Reply content**: concatenate every `{"type":"text","data":...}` chunk
  and confirm it contains the literal `grok-smoke-ok`.

Record the installed `grok --version` output, the command above, and the
pass/fail outcome (exit code + JSONL validity + `end_turn` + reply content)
on the tracking issue. This manual run is evidence only; it never marks the
registry profile as qualified for automated dispatch.
