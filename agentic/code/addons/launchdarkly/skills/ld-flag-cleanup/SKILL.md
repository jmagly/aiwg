---
namespace: aiwg
name: ld-flag-cleanup
description: Prepare a reviewed cleanup PR while preserving dependency and archive-only blockers.
platforms: [all]
metadata:
  write-capable: "true"
triggers:
  - "ld-flag-cleanup"
  - "Prepare a reviewed cleanup PR while preserving dependency and archive-only blockers"
  - "clean up stale LaunchDarkly flags"
  - "remove a LaunchDarkly flag from code"
  - "archive a LaunchDarkly flag"
---

# ld-flag-cleanup

## Behavior

1. Implement flag-cleanup-handoff through provider-implementations.json; consume flags, flag_cards, release_evidence and coderefs_evidence plus optional project/provider_options. Emit criteria_met, ticket_ref, blockers, approval_ref and evidence_path without deleting flags. Read the card, release and complete code-reference evidence; run get-removal-readiness and inspect Ready for code removal / Ready to archive. Lifecycle settings are customizable ([flag status](https://launchdarkly.com/docs/home/flags/flag-status.md)); do not hardcode readiness from age alone.
2. Load the available flag-cleanup guide ([MCP](https://launchdarkly.com/docs/home/getting-started/mcp.md)). AIWG guidance: draft the archive -> remove code -> PR proposal, checking readiness at each phase; do not actually archive while live code still depends on the flag. Preserve the selected variation and tests, then draft the removal PR and verify no references remain before approved archival.
3. AIWG eval-derived dependency order: approvals -> experiments (archive via REST/UI) -> expiring targets -> flag release plan -> environment release plan -> agent configs -> metrics -> flags -> segments. An unresolved approval is a blocker, not permission to delete it. Skip absent resources; stop at unresolved dependencies, never force deletion.
4. Use scripts/lifecycle.mjs prepareCleanupDraft on sanitized card/release/scan/readiness and dependency records to produce a local draft body and ordered dependency plan. Persist it under the resolved artifact root; do not publish automatically. Treat experiment-pinned flags/metrics as archive-only residue even after experiment archive; emit blockers, never promise deletion. Resolve current archive instructions through ld-docs ([API entry](https://launchdarkly.com/docs/api/overview)). Create/reuse an owner-assigned cleanup ticket only when criteria are met; draft PR and evidence remain local unless publishing is explicitly authorized.

## Evidence and rules

AIWG guidance: apply `ld-change-authorization`, `ld-key-safety`, `ld-docs-currency` and `ld-flag-hygiene`. Never relay keys from any result. Propose writes and obtain human approval of every production diff before execution. Use ld-docs first; discover runtime vendor guides when available, otherwise use dated page documentation. Uncertainty blocks dependent writes.
Resolve `aiwg artifacts path --json --check-write`; save sanitized records beneath artifact_root at logical `.aiwg/launchdarkly/`. Never save raw tool responses. Link the SDLC card and record actual source retrieval dates; offline references were last verified 2026-11-25.

## Examples

Input: “ld-flag-cleanup for the selected project and flag card.”
Output: a scoped proposal or read-only report, sanitized evidence, and explicit pending approvals or blockers; only verified results count as complete.

See @$AIWG_ROOT/docs/addons/launchdarkly/user-guide.md.
