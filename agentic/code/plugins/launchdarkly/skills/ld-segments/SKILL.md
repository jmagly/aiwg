---
namespace: aiwg
name: ld-segments
description: Manage bounded segment reads and approved targeting changes.
platforms: [all]
metadata:
  write-capable: "true"
triggers:
  - "ld-segments"
  - "Manage bounded segment reads and approved targeting changes"
---

# ld-segments

## Behavior

1. AIWG guidance: discover get-segments at runtime; use limit <= 50 and paginate until complete. Record projectKey, context kind and use by flags before proposing membership changes.
2. Load the vendor targeting guide through MCP or ld-docs ([MCP](https://launchdarkly.com/docs/home/getting-started/mcp.md)). Detect larger/synced segment entitlement through current documentation rather than assuming trial availability ([plans](https://launchdarkly.com/docs/home/account/plans.md)).
3. AIWG guidance: authorize the exact membership/rule diff, apply, read back, then verify representative matching and nonmatching contexts after propagation. Restore the saved version on approved rollback; save no member PII.

## Evidence and rules

AIWG guidance: apply `ld-change-authorization`, `ld-key-safety`, `ld-docs-currency` and `ld-flag-hygiene`. Never relay keys from any result. Propose writes and obtain human approval of every production diff before execution. Use ld-docs first; discover runtime vendor guides when available, otherwise use dated page documentation. Uncertainty blocks dependent writes.
Resolve `aiwg artifacts path --json --check-write`; save sanitized records beneath artifact_root at logical `.aiwg/launchdarkly/`. Never save raw tool responses. Link the SDLC card and record actual source retrieval dates; offline references were last verified 2026-11-25.

## Examples

Input: “ld-segments for the selected project and flag card.”
Output: a scoped proposal or read-only report, sanitized evidence, and explicit pending approvals or blockers; only verified results count as complete.

See @$AIWG_ROOT/docs/addons/launchdarkly/user-guide.md.
