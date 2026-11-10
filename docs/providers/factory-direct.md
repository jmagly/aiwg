# Factory (Droid) direct-worker profile (B-OG-37, #2902)

This is the lightweight CLI profile for dispatching `droid` as a direct
worker. It is unrelated to the `droid-bridge` MCP addon, which delegates
batch work to a separately-configured Droid account.

## Bring your own key

> Use my OpenRouter key with Factory Droid through a BYOK custom model. Show
> the exact model selector and safe key injection before asking to run it.

The operator's 2026-11-09 live run verified BYOK custom models. Register/select
the model through the harness-owned custom-model settings, using the exact
`custom:` identifier shown by Droid's model listing. A display name or upstream
API ID is not necessarily the CLI selector; do not manufacture the suffix or
index, or assume `qwen/qwen3.8-27b` is itself a valid Droid selector. Existing
[droid model fields](https://github.com/jmagly/aiwg/blob/main/docs/agents/providers/factory.md#key-fields) require a full
model ID. The #3969 fix replaced rejected `heavy`/`medium`/`light` tier aliases
with full built-in IDs (`claude-opus-5`, `claude-sonnet-5`,
`claude-haiku-4-5-20251001`); see [model configuration](../configuration/model-configuration.md).
Those built-in IDs are separate from BYOK custom selectors; confirm the
installed harness listing before choosing an ID.

Follow `aiwg show rule token-security --body`: keys come only from environment
or a secret-store command at point of use, scoped to the child, with tracing
disabled and credentials discarded on exit. Never place a key in argv,
deployed AIWG files, droid definitions, harness config (including `apiKey` in
`settings.json`), logs or receipts. Confirm the installed harness can consume
the secret without persisting it; if it requires a plaintext key in settings,
stop and choose a supported secure route with the operator. AIWG neither stores
keys nor supplies a new injection mechanism. `FACTORY_API_KEY` authenticates
Factory itself; it is not the OpenRouter inference key.
BYOK runs bill the user's key; paid runs need explicit operator approval.

After approval and secure injection, send the one-line prompt
`Reply with exactly: byok-ok` on stdin to `droid exec -m <custom-model-id>`.
Inspect the harness log/session for the resolved model matching the registered
upstream model. For custom models `-r` reasoning effort is ignored: the live
session reports `reasoning_effort none`. Do not claim `-r high` enforced high
reasoning. Record only harness version, resolved model, effort and result.
This does not change the direct-worker profile's qualification status.

## Direct-worker contract

The bundled `direct-shell` invocation profile in
`agentic/code/providers/model-capabilities.v1.json` is version-bound to
`droid-cli 1.0.0`. The titan eval (2026-11-06) help-verified `--auto low`,
`-m`, `-r`, `--cwd` and `-o stream-json`. The stdin brief was echoed as the
first stream-json message. That eval's built-in-model inference returned
`402 No active subscription`; the later BYOK run above uses a separate custom
model route. The direct profile stays `unqualified`. The terminal result
vocabulary remains documentation-sourced (`D`); help and stdin evidence (`H`)
do not establish successful inference. The adapter
(`tools/ralph-external/lib/factory-adapter.mjs`) renders:

```
droid exec [--auto low] -m <model> -r <effort> --cwd <workspace> \
  --output-format stream-json < <brief>
```

The brief always travels on stdin (no `prompt` argument is ever emitted);
the 1.0.0 eval verified ingestion when no `prompt` argument is given. `--auto low` is emitted only for the
`workspace-write` sandbox contract; the `read-only` contract omits `--auto`
entirely, since the CLI's own no-flags default already is read-only.
`--skip-permissions-unsafe` is never emitted by this profile.

## Manual smoke run

The conductor runs this once, by hand, after `droid` is installed and
`FACTORY_API_KEY` is exported in the environment, to record a pass/fail and
the observed CLI version on the tracking issue. It is not part of default CI
and performs exactly one live, billable call.

```sh
d=$(mktemp -d) && cd "$d" || exit 1
MODEL="gpt-6-luna"
echo 'Reply with exactly: factory-smoke-ok' \
  | droid exec --auto low -m "$MODEL" -r low --cwd "$d" \
    --output-format stream-json ; echo "exit=$?"
```

### Reading the result

- **Exit code**: `echo "exit=$?"` must print `exit=0`. Any non-zero exit is a
  fail.
- **A terminal `result` line on stdout, with the same affirmative rule the
  adapter's `observeHealthEvent` enforces**: `--output-format stream-json`
  writes newline-delimited JSON objects to stdout. Grep the captured output
  for the terminal line: `... | grep '"type":"result"'`. Success requires
  ALL of: the line parses as JSON with `"type":"result"`; `"subtype"` is
  exactly `"success"` (an `"interrupted"`, `"error_during_execution"`, or
  missing/unknown subtype is a fail even if other fields look clean);
  `"is_error"` is exactly `false` (not merely absent or non-`true`); and
  `"result"` is present and non-empty. A standalone `"type":"error"` line
  anywhere in the stream is also a fail, even alongside an otherwise-clean
  terminal line. A clean exit code alone is never sufficient.
- **`"result"` text**: the terminal line's `result` field should contain
  `factory-smoke-ok`.

Record the installed `droid --version` output, the command above, and the
pass/fail outcome (exit code + terminal `result` line contents) on the
tracking issue. This manual run is evidence only; it never marks the
registry profile as qualified for automated dispatch.
