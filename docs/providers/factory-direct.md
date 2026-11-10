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

### Local custom-model discovery

> Make my Factory BYOK model ready for worker selection. Check its documented
> input context limit and configure my coding role for models without selectable
> reasoning effort, then show me the resolved worker command.

`aiwg models refresh` discovers BYOK models from `$HOME/.factory/settings.json`
without a model turn or endpoint request. AIWG bounds the file read and parses
only `customModels` model-selection fields: `model`, `displayName`, `baseUrl`,
`provider`, `maxOutputTokens` and `maxContextLimit`. Credential fields (`apiKey`, `api_key`) are
dropped during parsing: their values are never inspected, expanded, hashed,
logged or included in observations, caches, doctor output or approval receipts.
Discovery does not check whether a key exists or works. Keep using secure
environment injection as described above. `settings.json` is the locally
documented custom-model source; no undocumented `config.json` fallback is used.

Set `maxContextLimit` in Droid's custom model entry before using
`aiwg models resolve`. Factory's [BYOK documentation](https://docs.factory.com/cli/byok/overview)
defines it as the input-token context window. If the provider's window also
counts output tokens, set it to that window minus `maxOutputTokens`. AIWG
records the configured positive safe integer directly as `contextTokens`, with
settings provenance; it does not subtract output tokens again. If omitted,
`contextTokens` stays null and resolve blocks with `OG_MODEL_UNAPPROVED` at
`/worker/contextTokens`, even after the worker qualifies. Invalid limits reject
that model entry. Refresh the catalog after changing the setting.

For the verified display-name form, Droid's selector is `custom:` followed by
the display name with spaces replaced by hyphens. For example,
`AIWG OpenRouter Qwen 3.8 27B` becomes
`custom:AIWG-OpenRouter-Qwen-3.8-27B`. AIWG adds no numeric suffix and rejects
ambiguous display names. The catalog's older suffix-relabeling caveat describes
runtime reporting; confirm the selector against your installed Droid version.
Observations use this exact executable selector for both `id` and `apiModelId`;
the upstream `model` is retained separately in configuration provenance.
`llmProvider` reflects the endpoint host (`openrouter` for `openrouter.ai`),
rather than treating `generic-chat-completion-api` as an inference provider.

Discovery records the settings source, observation time and `droid --version`.
Refresh binds a single configured Factory installation's accountScope label;
`aiwg doctor --probe-workers --qualify --cli factory` rereads custom-model
settings using the targeted installation's probed version and configured
accountScope (default `local-account`). Approval remains an explicit doctor
step. Labels do not detect login changes or prove account entitlement. BYOK
effort is `not-applicable`; in `models.json`, set
`defaults.workerSelection.roleGuidance.<role>` for the role that selects these
models to `initialEffort: null`, `effortLadder: []` and
`allowNotApplicableEffort: true`. The custom invocation
omits `-r` rather than claiming it enforces reasoning effort. Other unknown
facts, including data-use policy and context size when no limit is configured,
remain unknown.

Built-in Factory plan models have no non-interactive listing command. Their
static catalog pins remain available and are never promoted to observations
by reading custom-model settings.

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
