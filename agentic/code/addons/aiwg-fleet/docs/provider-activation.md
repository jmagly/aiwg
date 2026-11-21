# AIWG Fleet Provider Activation

The `aiwg-fleet` addon ships stock quiet-mode behavior bundles for small-plan bot fleets.

## Install

```bash
aiwg use aiwg-fleet --provider openclaw
```

OpenClaw receives native behavior bundles under `~/.openclaw/behaviors/`. Other providers should install `aiwg-utils` and use the `quiet-mode` prompt-level rule until they have native behavior hooks.

## Provider Table

| Provider | Activation Pattern |
|----------|--------------------|
| OpenClaw | Native behaviors: `quiet-bot` and `quiet-business-bot` deploy to `~/.openclaw/behaviors/` |
| Claude Code | Fallback rule via `aiwg use aiwg-utils --provider claude` |
| Warp | Fallback rule via `aiwg use aiwg-utils --provider warp` |
| Copilot | Fallback rule via `aiwg use aiwg-utils --provider copilot` |
| Cursor | Fallback rule via `aiwg use aiwg-utils --provider cursor` |
| Devin Desktop | Fallback rule via `aiwg use aiwg-utils --provider devin` |
| OpenCode | Fallback rule via `aiwg use aiwg-utils --provider opencode` |
| Factory | Fallback rule via `aiwg use aiwg-utils --provider factory` |
| Codex | Fallback rule via `aiwg use aiwg-utils --provider codex` |

## Worked Examples

### Quickbooksbot

Use `quiet-business-bot`.

- DMs: answer only bookkeeping, QuickBooks, invoice, expense, reconciliation, export, and report requests.
- Groups: answer only when mentioned, replied to, or called by a direct command.
- Expensive work: summarize and confirm before tool-heavy analysis or model escalation.

### InfsolClaw

Use `quiet-bot`.

- DMs: answer normal work requests.
- Groups: mention-only participation.
- Multi-bot rooms: yield when another bot is named.
- Long work: summarize the bounded task before using tools or escalation.

## Out of Scope

Telegram client wiring, spam controls, room membership, and gateway-specific mention parsing remain in the chat platform or harness. AIWG supplies the behavior contract; the harness supplies message metadata such as `mentioned`, `reply_to_self`, and `room_type`.
