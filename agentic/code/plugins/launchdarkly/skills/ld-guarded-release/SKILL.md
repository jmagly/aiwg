---
namespace: aiwg
name: ld-guarded-release
description: Validate native guarded stages, metrics and durable rollout handoff.
platforms: [all]
metadata:
  write-capable: "true"
triggers:
  - "ld-guarded-release"
  - "Validate native guarded stages, metrics and durable rollout handoff"
  - "guarded rollout with LaunchDarkly"
  - "LaunchDarkly guarded release with automatic rollback"
---

# ld-guarded-release

## Behavior

1. Check current plan, region and native eligibility via ld-docs. Guarded rollouts are plan-dependent and exclude migration flags and conflicting rollouts/experiments ([guarded rollouts](https://launchdarkly.com/docs/home/releases/guarded-rollouts.md)). Refuse experiment-linked flags under AIWG policy even if a caller claims safety.
2. Cap each guarded stage at 50%; never silently clamp a requested value. Check stage_durations_seconds parallels percentages; validate positive durations, metric keys and per-metric rollback, randomization_unit (default user). Warehouse-native metrics are excluded ([creating guarded rollouts](https://launchdarkly.com/docs/home/releases/creating-guarded-rollouts.md)).
3. Snapshot targeting, propose the exact native rollout and obtain approval before start. Poll/read back through ld-progressive-rollout. AIWG guidance: return handed-off with a durable rollout_ref for multi-hour work; record monitoring owner, next check and stop/rollback procedure. Missing entitlement offers a separately approved manual ramp; never silently downgrade.

## Evidence and rules

AIWG guidance: apply `ld-change-authorization`, `ld-key-safety`, `ld-docs-currency` and `ld-flag-hygiene`. Never relay keys from any result. Propose writes and obtain human approval of every production diff before execution. Use ld-docs first; discover runtime vendor guides when available, otherwise use dated page documentation. Uncertainty blocks dependent writes.
Resolve `aiwg artifacts path --json --check-write`; save sanitized records beneath artifact_root at logical `.aiwg/launchdarkly/`. Never save raw tool responses. Link the SDLC card and record actual source retrieval dates; offline references were last verified 2026-11-25.

## Examples

Input: “ld-guarded-release for the selected project and flag card.”
Output: a scoped proposal or read-only report, sanitized evidence, and explicit pending approvals or blockers; only verified results count as complete.

See @$AIWG_ROOT/docs/addons/launchdarkly/user-guide.md.
