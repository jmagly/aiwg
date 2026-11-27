---
namespace: aiwg
name: ld-flag-create
description: Create a governed flag linked to the existing SDLC feature-toggle card.
platforms: [all]
metadata:
  write-capable: "true"
triggers:
  - "ld-flag-create"
  - "Create a governed flag linked to the existing SDLC feature-toggle card"
---

# ld-flag-create

## Behavior

1. Read feature-flag-plan and the existing feature-toggle-card at @$AIWG_ROOT/agentic/code/frameworks/sdlc-complete/templates/deployment/feature-toggle-card.md. Respect opt-out and feature_flags.provider; do not duplicate lifecycle authority.
2. Capture projectKey, environments, immutable key, variations/value type, maintainer, temporary/permanent intent, tags, fallback, rollout/rollback and removal criteria in the launchdarkly-fields template. Keys are permanent and templates are not enforced by LaunchDarkly ([conventions](https://launchdarkly.com/docs/guides/flags/flag-conventions.md)).
3. Load the available flag-create guide via MCP get-skills/load-skill ([MCP](https://launchdarkly.com/docs/home/getting-started/mcp.md)); otherwise use ld-docs. Show the creation diff and satisfy authorization before creating. Run flag-check and post-change verification; keep pending until read-back and SDK evidence agree.

## Evidence and rules

AIWG guidance: apply `ld-change-authorization`, `ld-key-safety`, `ld-docs-currency` and `ld-flag-hygiene`. Never relay keys from any result. Propose writes and obtain human approval of every production diff before execution. Use ld-docs first; discover runtime vendor guides when available, otherwise use dated page documentation. Uncertainty blocks dependent writes.
Resolve `aiwg artifacts path --json --check-write`; save sanitized records beneath artifact_root at logical `.aiwg/launchdarkly/`. Never save raw tool responses. Link the SDLC card and record actual source retrieval dates; offline references were last verified 2026-11-25.

## Examples

Input: “ld-flag-create for the selected project and flag card.”
Output: a scoped proposal or read-only report, sanitized evidence, and explicit pending approvals or blockers; only verified results count as complete.

See @$AIWG_ROOT/docs/addons/launchdarkly/user-guide.md.
