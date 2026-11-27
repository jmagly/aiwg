---
namespace: aiwg
name: ld-sdk-integrate
description: Integrate a stack-specific SDK or OpenFeature provider with bounded startup and shutdown.
platforms: [all]
metadata:
  write-capable: "true"
triggers:
  - "ld-sdk-integrate"
  - "Integrate a stack-specific SDK or OpenFeature provider with bounded startup and shutdown"
---

# ld-sdk-integrate

## Behavior

1. Detect stack/runtime and existing dependencies. Respect the SDLC flag decision; run ld-doctor before any SDK connection. Prefer an existing OpenFeature abstraction when selected by the project ([providers](https://launchdarkly.com/docs/sdk/openfeature.md)).
2. Run ld-docs and discover MCP get-skills/load-skill for the installed sdk-install guide ([MCP](https://launchdarkly.com/docs/home/getting-started/mcp.md)). Do not install packages without the requested project scope.
3. AIWG guidance: initialize one server SDK client with an explicit timeout; on failure use the card's safe fallback. Flush pending events before close, await bounded completion, and close on shutdown. Obtain current language-specific method names through ld-docs; do not guess signatures.
4. Keep server credentials in server secret references; never expose them to frontend builds ([keys](https://launchdarkly.com/docs/home/account/environment/keys.md)). Use ld-contexts for private attributes and ld-testing for forced-off/on tests. Record stack/version, fallback and shutdown checks in the card.

## Evidence and rules

AIWG guidance: apply `ld-change-authorization`, `ld-key-safety`, `ld-docs-currency` and `ld-flag-hygiene`. Never relay keys from any result. Propose writes and obtain human approval of every production diff before execution. Use ld-docs first; discover runtime vendor guides when available, otherwise use dated page documentation. Uncertainty blocks dependent writes.
Resolve `aiwg artifacts path --json --check-write`; save sanitized records beneath artifact_root at logical `.aiwg/launchdarkly/`. Never save raw tool responses. Link the SDLC card and record actual source retrieval dates; offline references were last verified 2026-11-25.

## Examples

Input: “ld-sdk-integrate for the selected project and flag card.”
Output: a scoped proposal or read-only report, sanitized evidence, and explicit pending approvals or blockers; only verified results count as complete.

See @$AIWG_ROOT/docs/addons/launchdarkly/user-guide.md.
