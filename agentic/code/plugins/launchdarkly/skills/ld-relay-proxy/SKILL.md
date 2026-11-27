---
namespace: aiwg
name: ld-relay-proxy
description: Assess Relay Proxy fit and produce a reviewed topology proposal.
platforms: [all]
metadata:
  write-capable: "true"
triggers:
  - "ld-relay-proxy"
  - "Assess Relay Proxy fit and produce a reviewed topology proposal"
---

# ld-relay-proxy

## Behavior

1. AIWG guidance: collect topology, connectivity, availability, SDK versions, regions and cost constraints. Use ld-docs and the [documentation index](https://launchdarkly.com/docs/llms.txt) to find current Relay Proxy guidance; the supplied evidence does not establish a deployment recipe.
2. Produce a topology/operations proposal with connection paths, secret placement, health checks, failure modes, upgrade ownership and fallback. Verify plan costs and view-scoped key support directly; unresolved or conflicting guidance blocks deployment.
3. Never retrieve/relay SDK keys for proxy setup. Show the production diff and rollback, then obtain authorization before any infrastructure write. Test connectivity in an isolated environment and hand off operational ownership; a proposal is not a deployed proxy.

## Evidence and rules

AIWG guidance: apply `ld-change-authorization`, `ld-key-safety`, `ld-docs-currency` and `ld-flag-hygiene`. Never relay keys from any result. Propose writes and obtain human approval of every production diff before execution. Use ld-docs first; discover runtime vendor guides when available, otherwise use dated page documentation. Uncertainty blocks dependent writes.
Resolve `aiwg artifacts path --json --check-write`; save sanitized records beneath artifact_root at logical `.aiwg/launchdarkly/`. Never save raw tool responses. Link the SDLC card and record actual source retrieval dates; offline references were last verified 2026-11-25.

## Examples

Input: “ld-relay-proxy for the selected project and flag card.”
Output: a scoped proposal or read-only report, sanitized evidence, and explicit pending approvals or blockers; only verified results count as complete.

See @$AIWG_ROOT/docs/addons/launchdarkly/user-guide.md.
