# Hermes direct-worker profile (B-OG-48, #2912)

This is the lightweight CLI profile for dispatching `hermes` as a direct
worker (not the session-import tooling documented in
[`hermes-sessions.md`](./hermes-sessions.md)).

## Bring your own key

> Use my OpenRouter key with Hermes and qwen/qwen3.8-27b. Explain the settings
> and cost, then wait for my approval before a verification call.

The operator's 2026-11-09 live run verified `OPENROUTER_API_KEY` from the
environment with `--provider openrouter -m qwen/qwen3.8-27b`. Select the
provider explicitly; `auto` can choose a different credential and model.
Follow `aiwg show rule token-security --body`: inject the key from the
environment or a secret-store command at point of use with tracing disabled.
Never put keys in argv, deployed AIWG files, harness config, logs or receipts;
scope the credential to the child and discard it on exit. BYOK runs bill the
user's key; paid runs need explicit operator approval, including verification.

After approval, with the key securely injected into the child environment:

```sh
printf '%s\n' 'Reply with exactly: byok-ok' | hermes chat \
  --query-file - --oneshot --quiet --ignore-user-config --ignore-rules --source tool \
  --provider openrouter -m qwen/qwen3.8-27b
```

Check both the reply and the Hermes harness log/session for the resolved model
`qwen/qwen3.8-27b` under OpenRouter. Record only the harness version, model and
result. A correct reply alone does not verify routing. These manual settings
do not change the AIWG direct-worker environment allowlist or dispatch status.

## Direct-worker contract

The bundled `direct-shell` invocation profile in
`agentic/code/providers/model-capabilities.v1.json` is version-observed
against the installed `hermes 0.21.6+387.gdce1e9b`, per-user install at
`~/.hermes/hermes-agent` (launcher `~/.local/bin/hermes`), re-verified
2026-10-10 on host titan: `hermes chat --help` and the installed
`hermes_cli` source (`H:`/`D:` evidence grades). The root
`/usr/local/lib/hermes-agent` copy is a stale 0.20.6 install and is never
cited. It stays `unqualified` for dispatch until a human qualifier reviews
a live run. The adapter (`tools/ralph-external/lib/hermes-adapter.mjs`)
renders:

```
hermes chat --query-file - --oneshot --quiet --ignore-user-config --ignore-rules --source tool --provider <provider> -m <model> --reasoning <effort>
```

with the brief piped on stdin (never argv), and `<provider>` always
explicit (see "The provider is always explicit" below).

## Why `chat --query-file - --oneshot --quiet`, not the top-level `-z`

Reading the installed source (never running it) rules `-z` out as the
baseline for a restricted task: it is argv-only for the brief
(`hermes_cli/_parser.py:148-153`) and `hermes_cli/oneshot.py` unconditionally
sets `HERMES_YOLO_MODE=1` (module docstring + line 276) with no disabling
flag at all.

`chat --query-file - --oneshot --quiet` reads the brief from stdin to EOF
(`hermes_cli/main.py:1711-1712`) and routes through
`_run_quiet_single_query` (`hermes_cli/cli_single_query.py:199-343`), whose
shared exit mapper `_single_query_exit_code`
(`cli_single_query.py:152-194`) returns 1 whenever
`result.get("failed") or result.get("partial") or result.get("completed")
is False` — a turn that printed partial text before failing still exits 1
(unlike `-z`).

## Exit 0 is still not treated as completion evidence (even though 0.21.6 fixed the specific bug this guarded against)

This profile's `parseWorkerFinal` never trusts exit 0 alone. Historically,
on hermes 0.20.6, a specific case made that necessary: reasoning-budget
exhaustion (then `agent/conversation_loop.py:3902`) returned
`{"final_response": "⚠️ **Thinking Budget Exhausted**...", "completed":
False, "partial": True, "error": "..."}` with **no `"failed"` key**, and
that build's exit mapper (`1 if result.get("failed") else 0`) stayed at
`0` — exit 0, non-empty stdout, genuinely incomplete.

**On hermes 0.21.6 this exact case is fixed upstream.** The same
reasoning-budget-exhaustion result is now built by `partial_result()`
(`agent/turn_truncation.py:164-180`, still `"completed": False, "partial":
True`), and `_single_query_exit_code` (`cli_single_query.py:152-194`) now
checks `partial`/`completed is False` too, so this case correctly exits 1
on 0.21.6. A 2026-10-10 conductor smoke run (`--provider openrouter -m
anthropic/claude-sonnet-4.6 --reasoning low`) confirmed the fixed-exit-code
contract: exit 0, stdout exactly the instructed answer.

`HermesAdapter.parseWorkerFinal` still does not stop at the exit-derived
status, now for a narrower but still-live reason: a genuinely `completed`
turn's `final_response` is the model's own text, and nothing in the CLI
guarantees the model actually emitted the instructed `workerClaims` JSON
document. So the final text must also parse as a strict `workerClaims`
JSON document (#2890, `ProviderAdapter.parseWorkerFinal`/
`parseWorkerOutput`, `format: 'json'`) — a warning message, an error
string, or any other free text fails that parse regardless of exit code.
The repository's test fixture keeps a synthetic `budget-exhausted`
scenario (exit 0 + free text) as a defense-in-depth regression test of
this strict parse, independent of what the CLI's own exit code says.

## Approval policy: not emitted-flag-only, and NOT just `--yolo`

Approval policy is **host config** (`~/.hermes/config.yaml`), not a single
argv flag, and `--yolo` is one of several bypasses, not the only one:

- `approvals.single_query_mode` (`tools/approval_context.py:298-304`
  `_binary_approval_mode()`, used by `_get_single_query_approval_mode()` at
  `tools/approval_context.py:313-315`) accepts `approve/off/allow/yes` as
  config values, treated as auto-approve. The built-in default is `"deny"`
  (`hermes_cli/config_defaults.py:1682`), but a host's `config.yaml` can
  override it to `approve`.
- `approvals.mode` (default `"smart"`, `config_defaults.py:1679`) can be set
  to `"off"` in config.yaml, bypassing approval prompts the same way
  `--yolo` does (`tools/approval.py:967`,
  `approval_context._get_approval_mode() == "off"`).
- `HERMES_YOLO_MODE` is a process env var frozen at Python import
  (`tools/approval.py:46`) — if present in the worker's environment, every
  approval gate auto-approves unconditionally, with no argv involved at all.

This adapter always emits `--ignore-user-config` (verified on `hermes chat
--help`), which makes the session fall back to the **safe built-in
defaults** (`single_query_mode: deny`, `approvals.mode: smart`, never
`off`) regardless of the host's `config.yaml` — session/auth credentials
still resolve via `.env`, so this never blocks dispatch. `HERMES_YOLO_MODE`
(and any other `HERMES_*` override) is defeated structurally, not by a
flag: the bundled profile's `envAllowlist` is `["PATH"]` and the shared shell
renderer clears the child environment (`env -i <allowlist-only>`), so an
ambient `HERMES_YOLO_MODE` in the conductor's own environment can never
reach the child — proven by an explicit assertion
(`hermes-direct.test.ts` HD10). The `approval` control still stays
`unqualified` on the bundled registry: `--ignore-user-config`'s effect is
real and source-evidenced, but it is not live-qualified.

There is no `--usage-file`/JSON-report equivalent for `chat`: that flag is
declared only at the top level (`_parser.py:156-160`) and read only at the
`-z`/`--oneshot PROMPT` dispatch sites (`hermes_cli/oneshot.py:215-324`).
Final-output extraction for this profile is stdout text on exit 0 PLUS the
strict workerClaims parse above, never exit code or stdout non-emptiness
alone.

## Manual smoke run

The conductor runs this once, by hand, after `hermes` is installed, to
record a pass/fail and the observed CLI version on the tracking issue. It is
not part of default CI and performs exactly one live, billable call.

The provider is always explicit. Under `--ignore-user-config`, an omitted
`--provider` falls back to `auto` (`hermes_cli/runtime_provider.py:490-499`,
`resolve_requested_provider`), which picks whatever credentials happen to be
present. The profile refuses a missing or `auto` provider. Put the
provider key in the child process's environment only (for example
`OPENROUTER_API_KEY`, read from the operator's vault at call time), never
on argv or in a file:

```sh
echo 'Reply with exactly: hermes-smoke-ok' | OPENROUTER_API_KEY="$KEY" hermes chat \
  --query-file - --oneshot --quiet --ignore-user-config --ignore-rules --source tool \
  --provider openrouter -m anthropic/claude-sonnet-4.6 --reasoning low ; echo "exit=$?"
```

### Reading the result

- **Exit code**: `echo "exit=$?"` must print `exit=0`. Any non-zero exit is
  a fail, even if some text was printed to stdout. Missing credentials exit 1
  with "No inference provider configured" or "No usable credentials found".
- **stdout**: after any leading Hermes startup diagnostics, it must contain
  exactly `hermes-smoke-ok` and nothing else. The tolerated diagnostics are
  lines rendered by `_cprint` that start with a bare `⚠`. On hermes 0.20.6
  that included "⚠ tirith security scanner enabled but not available" when
  the tirith binary was missing on the host (that build's
  `_ensure_tirith_security`, `cli.py:8805-8822`); on hermes 0.21.6 the
  tirith scanner was removed entirely
  (`hermes_cli/config_migrations.py:686-702`, "the bundled tirith scanner
  left Hermes") and a 2026-10-10 smoke run confirmed the line no longer
  appears. The parser strips only matching leading lines
  (`stripHermesStartupDiagnostics`) regardless of version. A diagnostic
  after the answer, any other preamble, or a model-facing `⚠️` budget
  warning fails. A non-empty but different message is still a fail even
  though it exits 0; see "Exit 0 is still not treated as completion
  evidence" above.

Record the installed `hermes --version` output, the command above (without
the key), and the pass/fail outcome (exit code + stdout text) on the
tracking issue — the result of each run is posted there, not duplicated
into this doc. This manual run is evidence only; it never marks the
registry profile as qualified for automated dispatch.

## Isolation and caps (`hermes chat --help`, v0.21.6)

- `--ignore-rules`: "Skip auto-injection of AGENTS.md, SOUL.md, .cursorrules, memory, and preloaded skills. Combine with --ignore-user-config for a fully isolated run." It is always emitted with `--ignore-user-config`, so a worker never loads repository rules or user memory into its brief.
- `--source tool`: session source tag. Help: "Use 'tool' for third-party integrations". It keeps worker sessions apart from the user's own sessions.
- `--max-turns N`: "Maximum tool-calling iterations per conversation turn (default: 500, or agent.max_turns in config)". This is the evidenced step-cap mapping. The step-cap control stays `unqualified` until it is wired to an invocation-selected limit.
- `--run-budget SECONDS`: an optional wall-clock budget per run. It is complementary to the conductor's own timeout.
