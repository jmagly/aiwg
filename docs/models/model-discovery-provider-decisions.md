# Provider model discovery decisions

Status: accepted  
Last reviewed: 2026-07-20  
Owner: AIWG maintainers

AIWG enumerates models only through documented, non-interactive provider
interfaces that do not require collecting new credentials or running a model
turn. A provider being installed is necessary but not sufficient: discovery
runs only when `aiwg runtime-info --providers` marks it available.

## Decision matrix

| Provider | Decision | Interface | Scope and rationale |
|---|---|---|---|
| Claude Code | Unsupported | — | The [CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage) documents model selection but no non-interactive list. An Anthropic API key would be a new credential and would not establish Claude Code subscription entitlement. |
| Codex | Native | app-server `model/list` | JSON-RPC returns models for the current Codex account without a model turn. Results are `local-account`, never global claims. |
| GitHub Copilot CLI | Unsupported | — | [Programmatic CLI documentation](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference) publishes selectable strings through help and interactive `/models`, not a machine-readable account list. |
| Cursor | Unsupported | — | The desktop/agent CLI has no documented machine-readable model-list command. |
| Factory Droid | Unsupported | — | Factory model policy and selection are documented, but Droid exposes no stable non-interactive model-list command. |
| Hermes | Unsupported | — | `hermes model` is interactive. Its optional API server has `GET /v1/models`, but that requires a separately running service and describes the façade, not the CLI account. |
| OpenCode | Native | `opencode models --pure` | The [documented models command](https://opencode.ai/docs/cli/#models) emits normalized `provider/model` rows for configured providers. AIWG runs it from an isolated directory so project agents/plugins cannot corrupt discovery. |
| OpenClaw | Native | `openclaw models list --json` | The [documented read-only JSON command](https://docs.openclaw.ai/cli/models#list) reads configured catalog state without provider probes, API calls, or model tokens. Results are `local-runtime`, not entitlement proof. |
| OpenHuman | Unsupported | — | Profiles support semantic `Hint(...)` routing, but there is no standardized model-list command. |
| Warp | Unsupported | — | Model choice is profile-managed; no documented CLI enumeration surface exists. |
| Devin Desktop | Unsupported | — | The desktop CLI exposes editor operations but no machine-readable model list. |

The executable decision contract lives in
`src/models/model-discovery.ts` as `PROVIDER_DISCOVERY_DECISIONS`. Tests fail
if a supported AIWG provider lacks a decision.

## Provenance and failure behavior

Native results record the provider, interface source, runtime version when the
CLI reports one, observation time, scope, normalized identifiers, and any
classified error. Error classes distinguish authentication, rate limiting,
timeouts, invalid output, unsupported interfaces, and other command failures.

Authentication, rate limiting, malformed output, an absent executable, and an
unsupported provider all retain the committed catalog as the deterministic
role-mapping fallback. Native model rows never rewrite canonical agents or the
committed catalog. CI uses injected command runners and recorded outputs; it
does not invoke installed provider CLIs.

## Re-evaluation rule

Revisit an unsupported decision only when the provider publishes a stable
machine-readable interface. Interactive pickers, help-text scraping, private
state-file reverse engineering, and model-turn probes are not acceptable
discovery mechanisms.
