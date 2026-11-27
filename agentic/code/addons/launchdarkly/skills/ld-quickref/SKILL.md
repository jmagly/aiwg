---
namespace: aiwg
name: ld-quickref
description: Discover LaunchDarkly integration, release, experimentation, cleanup and governance.
platforms: [all]
metadata:
  write-capable: "false"
triggers:
  - "ld-quickref"
  - "Discover LaunchDarkly integration, release, experimentation, cleanup and governance"
  - "what can the LaunchDarkly addon do"
  - "LaunchDarkly quick reference"
---

# ld-quickref

## Behavior

Use aiwg discover with these phrases, then show the selected component and bound rules:

| Prompt | Route |
|---|---|
| set up LaunchDarkly | launchdarkly-concierge / ld-onboarding |
| integrate LaunchDarkly SDK | ld-sdk-integrate / ld-contexts / ld-testing |
| create LaunchDarkly flag | ld-flag-create |
| LaunchDarkly targeting or segments | ld-targeting / ld-segments |
| release LaunchDarkly feature | ld-feature-release / ld-progressive-rollout |
| guarded LaunchDarkly release | ld-guarded-release / ld-approvals |
| migrate with LaunchDarkly | ld-migration / ld-migration-flag |
| run LaunchDarkly experiment | ld-experiment |
| test-only AgentControl | ld-agentcontrol |
| audit LaunchDarkly flag debt | ld-flag-debt-audit |
| clean up LaunchDarkly flags | ld-flag-cleanup-cycle / ld-flag-cleanup |
| LaunchDarkly code references | ld-code-refs-ci |
| govern LaunchDarkly | launchdarkly-governance-auditor / ld-governance-maturity |
| LaunchDarkly Terraform or Relay Proxy | ld-terraform / ld-relay-proxy |

AIWG guidance: feature_flags.provider selects launchdarkly; SDLC owns the card and transition seam. Read the provider contract before capability execution. Vendor guides are discovered at runtime ([MCP](https://launchdarkly.com/docs/home/getting-started/mcp.md)).

## Evidence and rules

AIWG guidance: apply `ld-change-authorization`, `ld-key-safety`, `ld-docs-currency` and `ld-flag-hygiene`. Never relay keys from any result. Propose writes and obtain human approval of every production diff before execution. Use ld-docs first; discover runtime vendor guides when available, otherwise use dated page documentation. Uncertainty blocks dependent writes.
Resolve `aiwg artifacts path --json --check-write`; save sanitized records beneath artifact_root at logical `.aiwg/launchdarkly/`. Never save raw tool responses. Link the SDLC card and record actual source retrieval dates; offline references were last verified 2026-11-25.

## Examples

Input: “ld-quickref for the selected project and flag card.”
Output: a scoped proposal or read-only report, sanitized evidence, and explicit pending approvals or blockers; only verified results count as complete.

See @$AIWG_ROOT/docs/addons/launchdarkly/user-guide.md.
