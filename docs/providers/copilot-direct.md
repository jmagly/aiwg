# GitHub Copilot CLI direct-worker profile (B-OG-36, #2901)

This is the lightweight CLI profile for dispatching `copilot` (GitHub
Copilot CLI) as a direct worker.

## Bring your own key

> Use my OpenRouter key with Copilot CLI and qwen/qwen3.8-27b. Show the
> settings and ask before a paid verification run.

The operator's 2026-11-09 live run verified these environment settings:

```sh
export COPILOT_PROVIDER_BASE_URL=https://openrouter.ai/api/v1
export COPILOT_PROVIDER_TYPE=openai
export COPILOT_MODEL=qwen/qwen3.8-27b
```

Inject the key into `COPILOT_PROVIDER_API_KEY` through the child environment,
or set `COPILOT_PROVIDER_API_KEY_COMMAND` to a secret-store command that
returns the key directly to the harness. The command contains only a secret
reference, never the key. Use one credential source for the run.
Follow `aiwg show rule token-security --body`: disable tracing, keep secrets
scoped to the child at point of use and discard on exit. Never put keys on
argv, in deployed AIWG files, harness config, logs or receipts. BYOK runs bill
the user's key; paid runs need explicit operator approval, including verification.

After approval and secure injection:

```sh
printf '%s\n' 'Reply with exactly: byok-ok' | copilot --model qwen/qwen3.8-27b --no-ask-user
```

Check the reply and the Copilot harness log/session for the resolved model
`qwen/qwen3.8-27b` through the configured OpenRouter endpoint. Retain only
harness version, model and result. Accepted settings or a correct reply alone
do not verify routing. This manual route does not qualify the AIWG worker
parser or modify its cleared-environment profile.

## Direct-worker contract

The bundled `direct-shell` profile in
`agentic/code/providers/model-capabilities.v1.json` supports Copilot CLI
**1.0.106**, based on the 2026-11-10 BYOK OpenRouter run with
`qwen/qwen3.8-27b` (#4088). The adapter renders this invocation.

```sh
copilot --model "$MODEL" --reasoning-effort "$EFFORT" \
  -C "$WORKSPACE" --output-format json --no-ask-user \
  --no-custom-instructions --disable-builtin-mcps \
  --allow-tool write < "$BRIEF"
```

The brief is piped to stdin and read to EOF. Its contents stay off argv.
Omit `-p`/`--prompt` and `--attachment`. The 1.0.95 help-only attachment
path is **superseded**. Copilot 1.0.106 rejects `brief.md` with
`--attachment file type not supported (must be an image or native document): brief.md`.
When `-p` accompanies piped stdin, the capture shows the model looking for
missing instructions and using `bash`, `bash`, then `view` to read the brief
from the working directory. Stdin alone produced a single-turn exact reply
with an empty `toolRequests` array.

The adapter keeps model and reasoning effort explicit, refuses `auto` and
generic Ralph aliases, and binds the workspace with `-C`. Scoped
`--allow-tool` and optional repeated `--deny-tool` patterns carry the
resolved permissions. `--no-ask-user` disables the agent's question tool.
The profile uses an externally enforced sandbox boundary. Its controls
retain their existing unqualified status for dispatch. The capture covers
the stdin and answer contract, while tool approval outside the scoped
allow-list and other workspace-loading surfaces still need verification.

The cleared child environment allows `PATH` and the five BYOK variables
listed above, including `COPILOT_PROVIDER_API_KEY` and
`COPILOT_PROVIDER_API_KEY_COMMAND`. The successful capture records
`model.call_final_result.data` with `isByok: true`, model
`qwen/qwen3.8-27b` and result `success`.

### Captured answer contract

`--output-format json` emits JSONL, one JSON object per line. Extract the
last `assistant.message` event's `data.content`, trim surrounding whitespace,
and require a subsequent terminal `assistant.turn_end` or `assistant.idle`.
The final message must contain text and an empty `data.toolRequests` array.
A new turn, message fragment, user message or tool execution invalidates the
previous candidate until another settled assistant message arrives.
`model.call_final_result.data.result` is a status string. The answer lives
in `assistant.message.data.content`.

Malformed JSONL, duplicate JSON keys, non-object lines, error-shaped lines
(`type: "error"` or a non-null top-level `error`), unsuccessful model-call
results and nonzero result exits fail extraction. The adapter bounds output
to 10 MiB and validates UTF-8. `parseOutput` and `parseDirectFinal` return
`{ text }` for a settled candidate. `parseWorkerFinal` then applies the
existing strict `workerClaims` parser and trusted process-termination checks.
A smoke reply is plain text. A dispatched worker must supply the requested
claims JSON as its answer. Attempt verification uses the same extraction
and the existing attempt-terminal assertion. MCP final transport remains
unsupported by this direct-shell profile.

Health observation stays process-only. Terminal events identify a settled
answer within the stream. Host-observed process exit and termination provide
the completion evidence used by strict claims validation.

Sanitized excerpts from the supplied raw captures are retained in
`test/fixtures/providers/copilot/copilot-stdin-only.jsonl` and
`test/fixtures/providers/copilot/copilot-stdin.jsonl`. The excerpts preserve
event shapes and replace temporary paths and identifiers. The attachment
rejection is retained in `test/fixtures/providers/copilot/attachment-rejected.txt`.

## GitHub-account smoke run (2026-10-10) — BLOCKED on authentication

The old GitHub-account run on host `noodle`, Copilot 1.0.95, used a
`COPILOT_GITHUB_TOKEN` holding a classic `ghp_` personal access token. It
exited 1 with stderr `Classic Personal Access Tokens (ghp_) are not supported by Copilot`
and empty stdout. That run remains blocked on authentication. The BYOK
route was verified separately on 2026-11-09 and its stdin-only direct-worker
contract was captured on 2026-11-10. This preserves conformance CP19's
recorded auth-failure evidence.

## Manual stdin smoke

After approval and secure child-environment injection, run this command
with the selected exact model and scoped tool permission.

```sh
MODEL=qwen/qwen3.8-27b
d=$(mktemp -d)
printf '%s\n' 'Reply with exactly: copilot-smoke-ok' 'Do not use any tools.' > "$d/brief.md"
cat "$d/brief.md" | copilot --model "$MODEL" --reasoning-effort low \
  -C "$d" --output-format json --no-ask-user --no-custom-instructions \
  --disable-builtin-mcps --allow-tool write > "$d/out.jsonl" 2> "$d/err"
printf 'exit=%s\n' "$?"
```

Expect exit zero, valid JSONL, one `assistant.message` with trimmed
`data.content` equal to `copilot-smoke-ok`, empty `data.toolRequests`, and
terminal `assistant.turn_end`/`assistant.idle` events. Check that
`model.call_final_result.data` records the expected model, `isByok: true`
and `result: "success"`. Record version, model and result on the tracking
issue after an authorized run. Default tests replay sanitized captures and
execute a fake local CLI.
