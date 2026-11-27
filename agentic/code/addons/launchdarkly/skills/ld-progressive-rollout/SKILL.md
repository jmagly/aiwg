---
namespace: aiwg
name: ld-progressive-rollout
description: Implement staged flag exposure with evidence, approval and rollback gates.
platforms: [all]
metadata:
  write-capable: "true"
triggers:
  - "ld-progressive-rollout"
  - "Implement staged flag exposure with evidence, approval and rollback gates"
---

# ld-progressive-rollout

## Behavior

1. Resolve progressive-rollout through provider-implementations.json and scripts/capabilities.mjs. Read @$AIWG_ROOT/agentic/code/addons/launchdarkly/docs/capability-contract.md for all v1 inputs/outputs. project is projectKey; validate provider_options, environment and percentages. Refuse experiment-linked flags; caller assertions cannot override this.
2. Snapshot last known-good targeting. AIWG guidance: every production stage, rollback and stop needs the approved exact operation/diff; show metrics and rollback first. Run ld-guarded-release when guarded mode is selected.
3. AIWG guidance: after each stage allow 120 seconds propagation, then poll health_gate with bounded backoff (10s, x2, cap 60s, timeout 600s). HOLD pauses promotion; absent evidence/timeouts hold for review. A gate_failure_signal (default ROLLBACK) restores and verifies the last known-good snapshot. Never promote on missing evidence.
4. Return completed, rolled-back only with rollback_verified, or handed-off plus rollout_ref for a long native guarded rollout. Later steps inspect that reference; do not label handoff as completion. Guarded constraints come from [guarded rollouts](https://launchdarkly.com/docs/home/releases/guarded-rollouts.md) and [step limits](https://launchdarkly.com/docs/home/releases/creating-guarded-rollouts.md).

## Evidence and rules

AIWG guidance: apply `ld-change-authorization`, `ld-key-safety`, `ld-docs-currency` and `ld-flag-hygiene`. Never relay keys from any result. Propose writes and obtain human approval of every production diff before execution. Use ld-docs first; discover runtime vendor guides when available, otherwise use dated page documentation. Uncertainty blocks dependent writes.
Resolve `aiwg artifacts path --json --check-write`; save sanitized records beneath artifact_root at logical `.aiwg/launchdarkly/`. Never save raw tool responses. Link the SDLC card and record actual source retrieval dates; offline references were last verified 2026-11-25.

## Examples

Input: “ld-progressive-rollout for the selected project and flag card.”
Output: a scoped proposal or read-only report, sanitized evidence, and explicit pending approvals or blockers; only verified results count as complete.

See @$AIWG_ROOT/docs/addons/launchdarkly/user-guide.md.
