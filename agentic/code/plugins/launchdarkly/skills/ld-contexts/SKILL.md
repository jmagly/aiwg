---
namespace: aiwg
name: ld-contexts
description: Design context kinds, multi-context evaluation and private attributes.
platforms: [all]
metadata:
  write-capable: "true"
triggers:
  - "ld-contexts"
  - "Design context kinds, multi-context evaluation and private attributes"
  - "design LaunchDarkly contexts"
  - "LaunchDarkly multi-context targeting"
---

# ld-contexts

## Behavior

1. AIWG guidance: inventory the decision boundary, stable opaque identifiers, context kinds and attributes; collect only attributes needed for targeting. Avoid direct personal identifiers in keys. Define how user and organization kinds combine into multi-contexts.
2. Run ld-docs through the [documentation index](https://launchdarkly.com/docs/llms.txt) for the installed SDK's context/private-attribute API. AIWG guidance: mark sensitive attributes private and verify event payloads locally without printing their values. Never assume private attributes hide a context key.
3. Keep server evaluation and server secrets on the server ([keys](https://launchdarkly.com/docs/home/account/environment/keys.md)). Test matching, missing attributes, anonymous contexts and fallback with ld-testing. Save only the sanitized schema and rationale.

## Evidence and rules

AIWG guidance: apply `ld-change-authorization`, `ld-key-safety`, `ld-docs-currency` and `ld-flag-hygiene`. Never relay keys from any result. Propose writes and obtain human approval of every production diff before execution. Use ld-docs first; discover runtime vendor guides when available, otherwise use dated page documentation. Uncertainty blocks dependent writes.
Resolve `aiwg artifacts path --json --check-write`; save sanitized records beneath artifact_root at logical `.aiwg/launchdarkly/`. Never save raw tool responses. Link the SDLC card and record actual source retrieval dates; offline references were last verified 2026-11-25.

## Examples

Input: “ld-contexts for the selected project and flag card.”
Output: a scoped proposal or read-only report, sanitized evidence, and explicit pending approvals or blockers; only verified results count as complete.

See @$AIWG_ROOT/docs/addons/launchdarkly/user-guide.md.
