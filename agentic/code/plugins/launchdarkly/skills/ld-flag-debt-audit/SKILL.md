---
namespace: aiwg
name: ld-flag-debt-audit
description: Audit flag debt read-only, including never-evaluated permanent flags.
platforms: [all]
metadata:
  write-capable: "false"
triggers:
  - "ld-flag-debt-audit"
  - "Audit flag debt read-only, including never-evaluated permanent flags"
---

# ld-flag-debt-audit

## Behavior

1. Read-only: enumerate all flags with pagination, owners, temporary/permanent intent, evaluation/lifecycle state, prerequisites, release and code-reference coverage. Do not call mutation tools. Use current lifecycle definitions ([flag status](https://launchdarkly.com/docs/home/flags/flag-status.md)).
2. AIWG eval-derived safeguard: search-stale-flags alone misses never-evaluated permanent flags. Independently enumerate permanent flags and join evaluation evidence; list never-evaluated flags separately from unknown/missing telemetry. Never classify absent telemetry as proven unused.
3. Use scripts/lifecycle.mjs auditFlagDebt on sanitized inventory (evaluationCount=0 only when positively observed; missing coverage stays unknown). Produce flag-debt-report with owner, reason, readiness, coverage, recommended action, blockers and uncertainty. Apply ld-code-refs-ci coverage requirements; zero references from an unonboarded repo are not removal evidence ([code references](https://launchdarkly.com/docs/home/flags/code-references.md)). Route candidates to ld-flag-cleanup-cycle; the audit itself writes no provider state.

## Evidence and rules

AIWG guidance: apply `ld-change-authorization`, `ld-key-safety`, `ld-docs-currency` and `ld-flag-hygiene`. Never relay keys from any result. Propose writes and obtain human approval of every production diff before execution. Use ld-docs first; discover runtime vendor guides when available, otherwise use dated page documentation. Uncertainty blocks dependent writes.
Resolve `aiwg artifacts path --json --check-write`; save sanitized records beneath artifact_root at logical `.aiwg/launchdarkly/`. Never save raw tool responses. Link the SDLC card and record actual source retrieval dates; offline references were last verified 2026-11-25.

## Examples

Input: “ld-flag-debt-audit for the selected project and flag card.”
Output: a scoped proposal or read-only report, sanitized evidence, and explicit pending approvals or blockers; only verified results count as complete.

See @$AIWG_ROOT/docs/addons/launchdarkly/user-guide.md.
