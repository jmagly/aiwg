---
namespace: aiwg
name: ld-code-refs-ci
description: Integrate code-reference scans and report repository coverage honestly.
platforms: [all]
metadata:
  write-capable: "true"
triggers:
  - "ld-code-refs-ci"
  - "Integrate code-reference scans and report repository coverage honestly"
---

# ld-code-refs-ci

## Behavior

1. Consume flag-coderefs-scan inputs repository, revision, flags and optional project/provider_options; project maps to projectKey. Inspect repository onboarding and actual scanned revision before interpreting zero results.
2. Code references use ld-find-code-refs on select plans; Developer/Foundation use the Flag Code References in Pull Request action instead ([code refs](https://launchdarkly.com/docs/home/flags/code-references.md), [GitHub Actions](https://launchdarkly.com/docs/home/flags/code-references/github-actions.md)). Resolve current pinned action revision and least-privilege secret reference through ld-docs; never invent a pin or inline token.
3. AIWG guidance: propose the CI diff for review. Record scan_ref, revision, references, complete, approval_ref, evidence_path. Set complete=false for an unonboarded repo, revision mismatch, missing scan identity or partial results. PR-only coverage is not a complete repository scan. Block cleanup until complete evidence for the requested revision exists.

## Evidence and rules

AIWG guidance: apply `ld-change-authorization`, `ld-key-safety`, `ld-docs-currency` and `ld-flag-hygiene`. Never relay keys from any result. Propose writes and obtain human approval of every production diff before execution. Use ld-docs first; discover runtime vendor guides when available, otherwise use dated page documentation. Uncertainty blocks dependent writes.
Resolve `aiwg artifacts path --json --check-write`; save sanitized records beneath artifact_root at logical `.aiwg/launchdarkly/`. Never save raw tool responses. Link the SDLC card and record actual source retrieval dates; offline references were last verified 2026-11-25.

## Examples

Input: “ld-code-refs-ci for the selected project and flag card.”
Output: a scoped proposal or read-only report, sanitized evidence, and explicit pending approvals or blockers; only verified results count as complete.

See @$AIWG_ROOT/docs/addons/launchdarkly/user-guide.md.
