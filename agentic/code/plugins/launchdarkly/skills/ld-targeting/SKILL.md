---
namespace: aiwg
name: ld-targeting
description: Propose targeting rules and verified individual or expiring targets.
platforms: [all]
metadata:
  write-capable: "true"
triggers:
  - "ld-targeting"
  - "Propose targeting rules and verified individual or expiring targets"
---

# ld-targeting

## Behavior

1. Read current targeting/version and the card. Load the matching vendor flag-targeting guide via MCP ([MCP](https://launchdarkly.com/docs/home/getting-started/mcp.md)). AIWG guidance: show context kind, rule order, fallthrough, before/after diff and rollback; authorize before changing.
2. AIWG eval-derived safeguard: for expiring targets, add the individual target first, verify membership by read-back, then set expiry and verify membership plus absolute expiry timestamp by another read-back. Never infer success from a successful expiry request alone.
3. AIWG guidance: allow 120 seconds for propagation, then poll intended SDK behavior with bounded exponential backoff (10s, multiplier 2, cap 60s, overall timeout 600s). Hold on absent evidence; record sanitized results. Do not infer targeting from dev-server overrides ([dev-server](https://launchdarkly.com/docs/guides/flags/ldcli-dev-server.md)).

## Evidence and rules

AIWG guidance: apply `ld-change-authorization`, `ld-key-safety`, `ld-docs-currency` and `ld-flag-hygiene`. Never relay keys from any result. Propose writes and obtain human approval of every production diff before execution. Use ld-docs first; discover runtime vendor guides when available, otherwise use dated page documentation. Uncertainty blocks dependent writes.
Resolve `aiwg artifacts path --json --check-write`; save sanitized records beneath artifact_root at logical `.aiwg/launchdarkly/`. Never save raw tool responses. Link the SDLC card and record actual source retrieval dates; offline references were last verified 2026-11-25.

## Examples

Input: “ld-targeting for the selected project and flag card.”
Output: a scoped proposal or read-only report, sanitized evidence, and explicit pending approvals or blockers; only verified results count as complete.

See @$AIWG_ROOT/docs/addons/launchdarkly/user-guide.md.
