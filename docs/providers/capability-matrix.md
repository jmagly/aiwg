# Provider Capability Matrix

This page distinguishes provider-native features, AIWG-implemented features,
and external integrations. The machine-readable source is
`agentic/code/providers/capability-matrix.yaml`.

## Bring your own key

> Use my OpenRouter key with Hermes, OpenCode, Factory Droid or Copilot CLI.
> Explain the harness settings and verification before asking to spend.

The existing steward skill answers this request through each provider's `byok`
entry, also shown by `aiwg steward capabilities --provider <harness>`.
AIWG stores no keys. Follow `aiwg show rule token-security --body`: inject
credentials from environment or a secret-store command at point of use,
disable tracing and discard them on child exit. Never put keys on argv, in
deployed AIWG files, harness config, logs or receipts. BYOK runs bill the user's
key; paid runs need explicit operator approval, even for a one-line check.

| Harness | Settings and support | Verification after approval |
|---|---|---|
| [Hermes](./hermes-direct.md#bring-your-own-key) | Verified 2026-11-09: `OPENROUTER_API_KEY`; `--provider openrouter -m qwen/qwen3.8-27b` | Send `Reply with exactly: byok-ok`; check harness log/session for OpenRouter and resolved model |
| [OpenCode](./opencode-direct.md#bring-your-own-key) | Verified 2026-11-09: `OPENROUTER_API_KEY`; `-m openrouter/qwen/qwen3.8-27b` | Same one-line prompt; check session provider and resolved model |
| [Factory Droid](./factory-direct.md#bring-your-own-key) | Verified custom-model BYOK; exact registered `custom:` ID; secure injection must be supported by the installed harness | Same prompt on stdin; inspect resolved model and `reasoning_effort none` (`-r` ignored for custom models) |
| [Copilot CLI](./copilot-direct.md#bring-your-own-key) | Verified 2026-11-09: `COPILOT_PROVIDER_BASE_URL=https://openrouter.ai/api/v1`, `COPILOT_PROVIDER_TYPE=openai`, `COPILOT_MODEL=qwen/qwen3.8-27b`; key via `COPILOT_PROVIDER_API_KEY` or `COPILOT_PROVIDER_API_KEY_COMMAND` | Same prompt; check harness log/session for resolved model and endpoint |
| [Codex](https://github.com/jmagly/aiwg/blob/main/docs/agents/providers/codex.md#wire-protocol) | Documented custom `model_providers` with `base_url`, `env_key`, `wire_api = "responses"`; OpenRouter/model compatibility unverified | Confirm Responses API compatibility first; after approval, same prompt and session resolved-model check |
| [Muse](https://github.com/jmagly/aiwg/blob/main/docs/agents/providers/muse.md) | OpenRouter BYOK unverified; existing notes cover Meta catalog selection only | Confirm supported credential/provider settings first; after approval, same prompt and session resolved-model check |

These are manual harness configuration notes from operator runs, not automated
paid calls or changes to the direct-worker profiles and their environment
allowlists. A correct reply or an accepted model flag alone does not establish
which model ran. Keep only harness version, model and result in a receipt.

## Status meanings

- **Native**: the provider owns the feature and exposes it in the active tool
  surface.
- **AIWG implemented**: the installed AIWG CLI has a registered, tested command
  that owns the feature lifecycle.
- **External**: an operating-system or CI service owns the lifecycle and
  launches a reviewed provider command. AIWG does not emulate that service.
- **Unsupported**: neither the provider nor the installed AIWG CLI offers the
  capability.

## Scheduling

| Provider | Status | Execution surface |
|---|---|---|
| Claude Code agent session | Native | `CronCreate`, `CronList`, `CronDelete` |
| Codex | External | system cron, systemd timer, or CI launches `aiwg job run ... --once`; the runner invokes reviewed `codex exec` work |
| Other providers without native cron tools | Unsupported | use an operator-owned external scheduler only when the provider has a reviewed non-interactive command |

There is no production `aiwg schedule`, `aiwg daemon`, or
`aiwg daemon schedule` command. Steward reports Codex cron as an **external
trigger**, not as AIWG emulation. The external service owns time; AIWG owns only
the reviewed job contract, single-shot execution, claim, and evidence lifecycle
that it actually implements. See [External-trigger jobs](../guides/external-trigger-jobs.md).

## Resident daemon

The repository contains daemon design and development sources, but the
production command registry exposes only `aiwg daemon-init`, which scaffolds a
configuration. It does not expose a resident daemon lifecycle command. All
built-in providers therefore report the daemon feature as unsupported.

Do not infer runtime availability from `daemon-init`, old release notes, or
bundled source files. A future daemon release must register its top-level
command, help, handlers, tests, metadata, and documentation atomically.

## Checking the installed surface

```bash
aiwg help
aiwg steward capabilities --provider codex
aiwg steward capabilities --feature cron
```

`aiwg help` is authoritative for registered top-level commands. Documentation
conformance tests verify operational guides do not advertise an unregistered
top-level AIWG command.
