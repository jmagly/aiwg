---
namespace: aiwg
name: ld-approvals
description: Prepare approval requests and scheduled changes with explicit production authorization.
platforms: [all]
metadata:
  write-capable: "true"
triggers:
  - "ld-approvals"
  - "Prepare approval requests and scheduled changes with explicit production authorization"
---

# ld-approvals

## Behavior

1. AIWG guidance: read approval settings privately, redact unsolicited credential fields and discover the current approval-requests guide via MCP ([MCP](https://launchdarkly.com/docs/home/getting-started/mcp.md)). Check entitlement; denied access is not proof of a plan tier.
2. Show the exact sanitized project/environment diff, scheduled time/timezone, rollback and owner. Request approval; pending, rejected or expired approvals block execution. Vendor approval alone does not replace human authorization under ld-change-authorization.
3. Re-read resource version and approval immediately before execution. Drift invalidates approval. Verify the scheduled/requested change by read-back; record decision/reference and actual result, never claim request creation means application.

## Evidence and rules

AIWG guidance: apply `ld-change-authorization`, `ld-key-safety`, `ld-docs-currency` and `ld-flag-hygiene`. Never relay keys from any result. Propose writes and obtain human approval of every production diff before execution. Use ld-docs first; discover runtime vendor guides when available, otherwise use dated page documentation. Uncertainty blocks dependent writes.
Resolve `aiwg artifacts path --json --check-write`; save sanitized records beneath artifact_root at logical `.aiwg/launchdarkly/`. Never save raw tool responses. Link the SDLC card and record actual source retrieval dates; offline references were last verified 2026-11-25.

## Examples

Input: “ld-approvals for the selected project and flag card.”
Output: a scoped proposal or read-only report, sanitized evidence, and explicit pending approvals or blockers; only verified results count as complete.

See @$AIWG_ROOT/docs/addons/launchdarkly/user-guide.md.
