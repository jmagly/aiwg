---
namespace: aiwg
name: ld-experiment
description: Gate experiment setup and readout with permanent-residue and targeting safeguards.
platforms: [all]
metadata:
  write-capable: "true"
triggers:
  - "ld-experiment"
  - "Gate experiment setup and readout with permanent-residue and targeting safeguards"
  - "set up a LaunchDarkly experiment"
  - "read out LaunchDarkly experiment results"
---

# ld-experiment

## Behavior

1. BEFORE creating anything, disclose the AIWG eval-derived risk model: experiments are undeletable; even an archived experiment can pin its flag and metric permanently. Prefer a dedicated project, otherwise require operator acceptance of residue. Treat this as a safety assumption pending current documentation verification through ld-docs ([API entry](https://launchdarkly.com/docs/api/overview)).
2. Load the available experiment-setup and metric-create guides via MCP ([MCP](https://launchdarkly.com/docs/home/getting-started/mcp.md)); verify current eligibility and define hypothesis, population, metric, duration, stopping rule and owner. Never substitute rollout health for experiment analysis.
3. BEFORE stop, warn that declaring a winner can rewrite the default rule. Snapshot complete targeting/version and show the proposed winner/default-rule diff plus restoration plan; obtain approval before stop. Verify the default rule afterward and restore only with approval.
4. Write experiment-readout with exposure, results, uncertainty and targeting snapshot reference. Archive via UI or pinned-version REST archiveExperiment when MCP lacks it; never repeatedly attempt deletion. Pass archive-only blockers to cleanup. No create/stop/archive while current behavior is uncertain.

## Evidence and rules

AIWG guidance: apply `ld-change-authorization`, `ld-key-safety`, `ld-docs-currency` and `ld-flag-hygiene`. Never relay keys from any result. Propose writes and obtain human approval of every production diff before execution. Use ld-docs first; discover runtime vendor guides when available, otherwise use dated page documentation. Uncertainty blocks dependent writes.
Resolve `aiwg artifacts path --json --check-write`; save sanitized records beneath artifact_root at logical `.aiwg/launchdarkly/`. Never save raw tool responses. Link the SDLC card and record actual source retrieval dates; offline references were last verified 2026-11-25.

## Examples

Input: “ld-experiment for the selected project and flag card.”
Output: a scoped proposal or read-only report, sanitized evidence, and explicit pending approvals or blockers; only verified results count as complete.

See @$AIWG_ROOT/docs/addons/launchdarkly/user-guide.md.
