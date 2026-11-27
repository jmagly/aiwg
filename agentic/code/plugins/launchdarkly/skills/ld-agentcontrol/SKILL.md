---
namespace: aiwg
name: ld-agentcontrol
description: Gate completion or agent configuration changes and offer test-only targeting.
platforms: [all]
metadata:
  write-capable: "true"
triggers:
  - "ld-agentcontrol"
  - "Gate completion or agent configuration changes and offer test-only targeting"
  - "manage LaunchDarkly AI configs"
  - "LaunchDarkly AgentControl config"
---

# ld-agentcontrol

## Behavior

1. BEFORE creation disclose the AIWG eval-derived risk assumption: new AgentControl configs serve in production automatically. Offer test-only targeting or a disabled configuration; if the interface cannot guarantee isolation atomically, require approval of production exposure or stop. Do not create first and restrict later.
2. Check Completion vs Agent mode, region, plan and SDK via ld-docs. AgentControl is plan-dependent, unavailable in federal, and does not proxy model calls ([AgentControl](https://launchdarkly.com/docs/home/agentcontrol.md), [quickstart](https://launchdarkly.com/docs/home/agentcontrol/quickstart.md)).
3. Discover available guides instead of assuming a create guide exists ([MCP](https://launchdarkly.com/docs/home/getting-started/mcp.md)). AIWG guidance: show model/prompt/version, targeting, cost/quality metrics and rollback. Approve before create/update, verify production exclusion and test evaluation by read-back, and record sanitized metrics without prompts containing secrets or personal data.

## Evidence and rules

AIWG guidance: apply `ld-change-authorization`, `ld-key-safety`, `ld-docs-currency` and `ld-flag-hygiene`. Never relay keys from any result. Propose writes and obtain human approval of every production diff before execution. Use ld-docs first; discover runtime vendor guides when available, otherwise use dated page documentation. Uncertainty blocks dependent writes.
Resolve `aiwg artifacts path --json --check-write`; save sanitized records beneath artifact_root at logical `.aiwg/launchdarkly/`. Never save raw tool responses. Link the SDLC card and record actual source retrieval dates; offline references were last verified 2026-11-25.

## Examples

Input: “ld-agentcontrol for the selected project and flag card.”
Output: a scoped proposal or read-only report, sanitized evidence, and explicit pending approvals or blockers; only verified results count as complete.

See @$AIWG_ROOT/docs/addons/launchdarkly/user-guide.md.
