---
namespace: aiwg
name: ld-migration-flag
description: Plan migration stages and rollback checkpoints without guarded rollouts.
platforms: [all]
metadata:
  write-capable: "true"
triggers:
  - "ld-migration-flag"
  - "Plan migration stages and rollback checkpoints without guarded rollouts"
---

# ld-migration-flag

## Behavior

1. Verify region/SDK support. Migration flags support two (off, complete), four (off, shadow, live, complete) or six stages (off, dualwrite, shadow, live, rampdown, complete); they are unavailable in EU/federal ([migrations](https://launchdarkly.com/docs/guides/flags/migrations.md)).
2. AIWG guidance: select the smallest justified stage model; define read/write authority, consistency checks, cohort scope, rollback point and irreversible data changes before the first transition.
3. Refuse guarded rollouts on migration flags ([guarded rollouts](https://launchdarkly.com/docs/home/releases/guarded-rollouts.md)). Use ld-migration; approve each production transition and verify data correctness plus SDK behavior before proceeding. Hold on incomplete evidence; never auto-cross an irreversible migration boundary.

## Evidence and rules

AIWG guidance: apply `ld-change-authorization`, `ld-key-safety`, `ld-docs-currency` and `ld-flag-hygiene`. Never relay keys from any result. Propose writes and obtain human approval of every production diff before execution. Use ld-docs first; discover runtime vendor guides when available, otherwise use dated page documentation. Uncertainty blocks dependent writes.
Resolve `aiwg artifacts path --json --check-write`; save sanitized records beneath artifact_root at logical `.aiwg/launchdarkly/`. Never save raw tool responses. Link the SDLC card and record actual source retrieval dates; offline references were last verified 2026-11-25.

## Examples

Input: “ld-migration-flag for the selected project and flag card.”
Output: a scoped proposal or read-only report, sanitized evidence, and explicit pending approvals or blockers; only verified results count as complete.

See @$AIWG_ROOT/docs/addons/launchdarkly/user-guide.md.
