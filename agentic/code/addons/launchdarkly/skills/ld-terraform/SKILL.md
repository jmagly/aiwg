---
namespace: aiwg
name: ld-terraform
description: Plan reviewed Terraform governance and drift ownership without guessing authentication.
platforms: [all]
metadata:
  write-capable: "true"
triggers:
  - "ld-terraform"
  - "Plan reviewed Terraform governance and drift ownership without guessing authentication"
---

# ld-terraform

## Behavior

1. Inventory manually managed flags, targeting, roles and lifecycle ownership. LaunchDarkly publishes the launchdarkly/launchdarkly Terraform provider ([integration](https://launchdarkly.com/docs/integrations/terraform.md)).
2. AIWG guidance: fetch the linked registry's installed-version documentation using ld-docs before proposing provider auth/import syntax. The supplied evidence does not verify Terraform authentication; leave it unresolved rather than guessing environment-variable names.
3. Propose explicit resource ownership, import plan and state protection; avoid simultaneous MCP and Terraform writers. Use secret references only. Review a sanitized plan, acquire production approval for the exact diff, and apply only within explicitly authorized scope. Read back state and record drift; unresolved auth or destructive replacements block application.

## Evidence and rules

AIWG guidance: apply `ld-change-authorization`, `ld-key-safety`, `ld-docs-currency` and `ld-flag-hygiene`. Never relay keys from any result. Propose writes and obtain human approval of every production diff before execution. Use ld-docs first; discover runtime vendor guides when available, otherwise use dated page documentation. Uncertainty blocks dependent writes.
Resolve `aiwg artifacts path --json --check-write`; save sanitized records beneath artifact_root at logical `.aiwg/launchdarkly/`. Never save raw tool responses. Link the SDLC card and record actual source retrieval dates; offline references were last verified 2026-11-25.

## Examples

Input: “ld-terraform for the selected project and flag card.”
Output: a scoped proposal or read-only report, sanitized evidence, and explicit pending approvals or blockers; only verified results count as complete.

See @$AIWG_ROOT/docs/addons/launchdarkly/user-guide.md.
