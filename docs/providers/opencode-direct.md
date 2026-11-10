# OpenCode direct-worker profile (B-OG-39, #2904)

This is the lightweight CLI profile for dispatching `opencode` as a direct
worker (not the Ralph-loop session driver documented in
[`opencode-sessions.md`](./opencode-sessions.md), which covers deployment
and transcript handling).

## Bring your own key

> Use my OpenRouter key with OpenCode and qwen/qwen3.8-27b. Show the settings
> and wait for approval before spending on a verification call.

The operator's 2026-11-09 live run verified the OpenRouter provider using
`OPENROUTER_API_KEY` from the environment and the model selector
`openrouter/qwen/qwen3.8-27b`. The leading `openrouter/` identifies the harness
provider; the upstream model ID is `qwen/qwen3.8-27b`.
Follow `aiwg show rule token-security --body`: environment or secret-store
command injection only, scoped to the child at point of use, with tracing
disabled and credentials discarded on exit. Never put keys on argv, in
deployed AIWG files, harness config, logs or receipts. BYOK runs bill the user's
key; paid runs need explicit operator approval, including verification.

After approval, with the key securely injected into the child environment:

```sh
opencode run --format json -m openrouter/qwen/qwen3.8-27b \
  'Reply with exactly: byok-ok' </dev/null
```

Check the reply and the OpenCode harness log/session for the resolved model
`qwen/qwen3.8-27b` with provider `openrouter`. A correct reply alone is not a
model check. Retain only harness version, model and result. This manual CLI
example does not change AIWG's attached-brief worker profile or its environment
allowlist; do not add an effort variant unless the model declares it.

## Direct-worker contract

The bundled `direct-shell` invocation profile in
`agentic/code/providers/model-capabilities.v1.json` is version-bound to
`opencode 2.0.26` and help-evidenced only (`H:` evidence grade, captured
from `opencode --help` / `opencode run --help` on host `noodle`,
2026-10-10). It stays `unqualified` for dispatch until a human qualifier
reviews a live run. The adapter
(`tools/ralph-external/lib/opencode-adapter.mjs`) renders:

```
opencode run --format json -m <model>[#<effort>] -f <briefPath> "Follow the instructions in the attached file exactly."
```

**Stdin is confirmed unsupported, not merely undocumented.** `opencode run
--help` shows only a positional `[<message...>]` argument, and the
conductor went further and disassembled the installed `opencode` 2.0.26
binary on host `noodle`: the compiled chunk implementing `run` has no
stdin/isTTY handling at all. The brief therefore travels as an attached
file via `--file`/`-f` ("File to attach to the message"), and the
positional argument carries only a fixed, content-free instruction —
`buildWorkerArgs` never places brief text there. This is recorded verbatim
in the profile's `pitfalls`. **An attachment only proves the file reached
the process; it does not prove the model treats its contents as
instructions the way stdin or a prompt would.** The manual smoke run below
is the check for that, not the `-f` wiring alone.

**`#variant` is a reasoning-effort selector, but the id set is
model-specific.** Disassembly of the installed binary found the function
that builds each model's variant list (minified as `qU(model, manual)`):
it maps that model's own `capabilities.supports.reasoning_effort` list
(e.g. low/medium/high) directly onto variant ids, or — for
extended-thinking models exposing `max_thinking_budget` instead — onto two
fixed ids, `"max"` and `"high"`. So an explicit effort is appended as
`#<effort>` (`gpt-5#high`); which ids a given model actually accepts is
not enumerated by this profile. **What the real CLI does with an id the
model does not declare is unverified**: the conductor's binary search found
no rejection path, so it may silently fall back to the model's default
reasoning. Effort is therefore **unqualified** for this profile: use only a
variant the target model declares, and confirm it with the smoke run.

**Permission-request behavior without `--auto` is not fully resolved.**
Disassembly shows a shared `permission.asked`/`permission.replied`
protocol: an unanswered or unselected request resolves to a `"reject"`
outcome (`requestPermission(...).catch(()=>{return})` on no responder,
then `_==="once"||_==="always"?_:"reject"`) — evidence of reject-on-no-answer
rather than an indefinite hang, but that code path is traced through the
ACP/session-protocol layer and was not independently reproduced against
plain, non-interactive `opencode run`. Approval therefore stays
`unqualified`/unavailable rather than asserted either way. The only
permission-adjacent flag, `--auto` ("Auto-approve permissions that are not
explicitly denied"), is a blanket bypass and is never emitted; sandboxing
is therefore external to the CLI (`capabilities.sandboxModes: ["external"]`).

## Manual smoke run

The conductor runs this once, by hand, after `opencode` is installed, to
record a pass/fail and the observed CLI version on the tracking issue. It
is not part of default CI and performs exactly one live, billable call.

```sh
MODEL="<provider>/<model>"   # fill in an exact observed model id
d=$(mktemp -d) && cd "$d"
echo 'Reply with exactly: opencode-smoke-ok' > brief.md
opencode run --format json -m "$MODEL" -f brief.md \
  'Follow the instructions in the attached file exactly.' </dev/null
echo "exit=$?"
```

`</dev/null` is deliberate: stdin is confirmed unsupported (see above), so
closing it removes any chance of the process waiting on a terminal that
will never answer.

### Reading the result

A live 2.0.26 smoke run on this exact command (host `noodle`, 2026-10-10,
saved at `.aiwg/working/s1-scratch/smoke-opencode.jsonl`) succeeded with
exit 0 and the correct reply, but the stdout stream was exactly **one**
`text` event — no `step_start`, no `step_finish`. Binary disassembly
explains why there can never be a stronger signal: the `run` command's
event loop returns silently on `session.execution.succeeded` in every
mode, so there is no positive whole-run terminal event in this CLI's JSON
output at all. `parseOutput` (`tools/ralph-external/lib/
opencode-adapter.mjs`) encodes the rule below; apply it by hand when
reading a smoke run:

- **Exit code**: `echo "exit=$?"` must print `exit=0`. Any non-zero exit is
  a fail.
- **No `error` event**: `... | grep '"type":"error"'` must find nothing.
  `error` is emitted for `session.step.failed`/`session.execution.failed`
  and a non-user `session.execution.interrupted`; its presence is a fail
  even at exit 0.
- **If a `step_finish` line is present**, grep for it and confirm its
  `part.reason` is `"stop"`; any other reason is a fail even at exit 0.
  `step_finish` is optional — its absence is not a fail by itself (the
  2.0.26 smoke run above had none).
- **At least one complete `text` part**: every `text` event's `part.text`
  must be a string, and at least one must carry a `part.time.end` value —
  a `text` event with no recorded end (e.g. a dropped mid-stream
  connection) does not count. If no `step_finish` was present, this is the
  only positive signal available, so it is required.
- **Reply text**: the `text` events' `part.text` should concatenate to the
  literal string `opencode-smoke-ok`.
- **No malformed or trailing lines**: every stdout line must parse as
  JSON, and nothing may follow a `step_finish` line.

**Residual risk, stated plainly**: a provider that truncates the stream
right after flushing one complete `text` part, before any further content
or an `error` event, is indistinguishable from a genuine single-part
success with this CLI's `run --format json` output — there is no stronger
signal available to rule that out.

Record the installed `opencode --version` output, the command above, and
the pass/fail outcome (exit code + event shape + reply text) on the
tracking issue. This manual run is evidence only; it never marks the
registry profile as qualified for automated dispatch.
