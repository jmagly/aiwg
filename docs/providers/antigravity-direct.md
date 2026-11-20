# Antigravity (`agy`) direct-worker profile (B-OG-43, #2908)

This is the lightweight CLI profile for dispatching `agy` (Google
Antigravity CLI) as a direct worker.

The bundled `direct-shell` invocation profile in
`agentic/code/providers/model-capabilities.v1.json` is version-bound to
`agy >=1.5.10 <1.6.0` and stays `unqualified` for dispatch until a human qualifier
reviews a live run. The adapter (`tools/ralph-external/lib/antigravity-adapter.mjs`)
renders:

```
agy --input-format stream-json --output-format stream-json \
  --model gemini-4-neon-low --sandbox \
  --disable-slash-commands <<< '{"event":"user","message":{"content":<brief>}}'
```

## agy 1.5.10 correction (#4348, 2026-11-19)

The #3005 manual smoke reported two failures: `gemini-3-pro --effort low`
is rejected, and a string-valued `message` cannot decode into
`printmode.StreamInputUserMessage`. The reported `agy models` list includes
`gemini-4-{neon,argon,hydrogen}-{low,medium,high,xhigh}` and
`gemini-pro-orchestrator-neon`.

The adapter maps the selected effort into the Gemini 4 model suffix,
replacing an existing suffix when present. It emits no `--effort`. `max`,
legacy models, the orchestrator, and unknown models are refused because
no compatible effort mapping is evidenced. Catalog role pins now use
`gemini-4-neon-high`, `gemini-4-argon-medium`, and `gemini-4-hydrogen-low`.
They remain unverified for dispatch.

**The nested `message: {content: brief}` is a candidate.** The error proves
that `message` must be an object, but does not identify its fields. The
offline host has agy 1.2.12; its help does not establish the 1.5.10 fields.
`buildAntigravityStdinFrame` isolates this candidate. Synthetic tests prove
framing and mapping only. The conductor must run the exact probe below on
titan with agy 1.5.10 and confirm the content field before claiming success.

## Fix round 1 (conductor-run LIVE argument-parse probes, 2026-10-11)

No login exists on the probe host, so **nothing reached a model**; only
the CLI's own argv/stream parser ran. These replaced round 0's incorrect
`--print`-based argv, which is broken on the real CLI:

- **A** `agy --print --output-format bogus-format </dev/null` -> `Error:
  --print took "--output-format" as its prompt, so the intended prompt
  was left as an argument and ignored. Attach the prompt to the flag
  (--print='your prompt') and move --output-format elsewhere on the
  command line.`
- **B** `agy --output-format bogus-format --print </dev/null` -> `flag
  needs an argument: -print`
- **C** `echo probe | agy --print= --output-format stream-json` -> `error:
  Error: empty prompt. Usage: agy --print "your prompt here"` AND a real
  stdout event: `{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"Error: empty prompt. Usage: agy --print \"your prompt here\""}}`
- **D** `echo probe | agy --input-format stream-json --output-format
  stream-json` -> passes argument parsing, stops at `Error: authentication
  required. Run 'agy' to log in, then retry.`
- **E** `echo probe | agy --output-format stream-json` (no `--print`) ->
  the same authentication stop
- **F** `agy --print=x --input-format bogus --output-format stream-json`
  -> `Error: unknown --input-format "bogus" (want text or stream-json)`
  (flag validation happens before auth)

**A/B/C prove `--print` is unsafe and this profile now never emits it**:
it requires a value, swallows the following argv token when none is
attached, and still hard-errors on an explicit empty value. **D/E prove
`--input-format stream-json --output-format stream-json` passes argument
validation and reaches execution with no `--print` flag at all.** The
brief therefore travels as exactly ONE NDJSON line on stdin, never argv.

The earlier binary strings established `event` and `message` field names,
but not the type of `message`. Round 1 provisionally sent a string; #4348
proved that representation wrong on 1.5.10. The candidate builder now
JSON-encodes a nested content object so embedded newlines stay in one turn.

**C is also the first LIVE observation of the `result` event shape**:
`event:"result"`, nested `result.conversation_id`/`result.status`/
`result.response`/`result.error`. It is an ERROR-status terminal with NO
preceding `init` — so the adapter's strict parser does NOT require `init`
before a non-`SUCCESS` terminal, only before an affirmative `SUCCESS` one
(the still-carried-forward, not-independently-live-confirmed
`init -> step_update -> result` success sequence from
`tools/providers/antigravity-transport.mjs`/`worker-health.mjs`). **The
quoted C text proves the grammar only — it establishes NEITHER exit code
0 NOR a `SUCCESS` terminal**, and the adapter's parser still rejects it
(`status !== 'SUCCESS'`).

The shared `adapter-frame` stdin kind calls the installed adapter's pure
`buildWorkerStdinFrame(brief)` hook. It returns the exact one NDJSON line
from `buildAntigravityStdinFrame`, bounded to 1 MiB, delivered only on stdin
and closed at EOF. Both the launcher and shell framer reuse the installed
driver path; an unknown kind or missing hook is refused. The stdin control
remains unqualified until one authenticated smoke run confirms the envelope.

## Unchanged invariants

`--model` encodes both the model family and selected reasoning effort
for the supported Gemini 4 ids. `--effort` is never emitted. **Only the `read-only` sandbox contract is
accepted**: there is no evidence `--mode accept-edits` is scoped to
workspace-write only rather than a blanket approval, so `workspace-write`
is refused outright; `--dangerously-skip-permissions` and
`--remote-control` are never emitted. `--sandbox` (bare boolean) and
`--disable-slash-commands` are always emitted. `--print-timeout` is not
emitted: its documented default (0) already waits for the turn, and its
effect without `--print` is unverified.

**A bare headless run soft-denies, it does not hang or silently approve**
(changelog v1.1.3, strings-read). The exact stderr wording is **not**
evidenced, and stderr content is not passed to
`parseWorkerFinal`/`parseOutput` — so a soft-denied-but-"SUCCESS" turn is
an open, honestly-marked detection gap (`ANTIGRAVITY_SOFT_DENY_RISK_NOTE`
in the adapter), not a repaired one. **This quote by itself establishes
neither exit code 0 nor a SUCCESS terminal.**

## Authentication prerequisites

Probes D/E prove this CLI's non-interactive failure mode for missing auth
is `Error: authentication required. Run 'agy' to log in, then retry.` —
an **interactive Google-account login** under the default configuration.
The [official authentication guide](https://antigravity.google/docs/install/)
(reviewed 2026-10-26 for #3624) also documents `GEMINI_API_KEY`, provided
`~/.gemini/antigravity-cli/settings.json` sets `modelProvider` to `gemini`.
The key alone has no effect. Both session and worker lists retain this
confirmed variable. The earlier probes did not select that provider and do
not disprove key authentication. This documentation does not qualify the
version-bound worker profile or establish a successful authenticated
run. **The manual smoke run remains blocked until an operator configures
valid provider authentication on the target host.**

## Manual smoke run (candidate envelope; conductor confirmation required)

```sh
d=$(mktemp -d) && cd "$d" || exit 1
agy --version
MODEL="gemini-4-neon-low"
printf '%s\n' '{"event":"user","message":{"content":"Reply with exactly: antigravity-smoke-ok"}}' \
  | agy --input-format stream-json --output-format stream-json \
    --model "$MODEL" --sandbox --disable-slash-commands \
    > out.jsonl 2> err.txt
code=$?
printf 'exit=%s\n' "$code"
cat out.jsonl
printf 'stderr-bytes=%s\n' "$(wc -c < err.txt)"
cat err.txt
```

### Reading the result

- **Exit code**: `echo "exit=$?"` must print `exit=0`. Any non-zero exit
  is a fail.
- **Reject the whole stream on any malformed line or unknown event**:
  every line of `out.jsonl` must be valid JSON with an `event` field of
  exactly `init`, `step_update`, or `result`.
- **The affirmative terminal `result` line**: exactly one line is
  `"event":"result"`, it is the LAST line, `result.status` is exactly
  `"SUCCESS"` (an `"ERROR"` status — live-confirmed shape above — is
  always a fail even with a well-formed result object), and
  `result.response` is present and non-empty, preceded by an `init` line.
- **`result.response` text**: should contain `antigravity-smoke-ok`.
- **Check stderr for a soft-deny notice too**: if stderr is non-empty,
  treat the run as unresolved/fail even if exit was 0 and the terminal
  line looks clean — per the soft-deny risk documented above, this quote
  establishes the behavior exists but not its exact wording.

Record the installed `agy --version` output, the command above, and the
pass/fail outcome (exit code + stream check + terminal `result` line
contents + stderr) on the tracking issue. This manual run is evidence
only; it never marks the registry profile as qualified for automated
dispatch.

#3005's Antigravity row must remain unticked until this probe yields
`init → step_update → result(SUCCESS)`, `antigravity-smoke-ok`, exit 0,
and zero stderr bytes on agy 1.5.10. This offline worker cannot record a
successful live result or write to the tracker.
