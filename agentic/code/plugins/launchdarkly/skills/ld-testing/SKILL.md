---
namespace: aiwg
name: ld-testing
description: Run revision-bound forced-off and forced-on tests using isolated TestData.
platforms: [all]
metadata:
  write-capable: "true"
triggers:
  - "ld-testing"
  - "Run revision-bound forced-off and forced-on tests using isolated TestData"
---

# ld-testing

## Behavior

1. Consume flag-states-test inputs flags, suite, revision, workspace and optional project/provider_options. project maps to projectKey. Use the same suite and revision for both states; never contact production.
2. Use an installed SDK TestData source; it is test-only and update simulates streaming changes ([TestData](https://launchdarkly.com/docs/sdk/features/test-data-sources.md)). Run the suite forced off and forced on; restore overrides in finally even when a suite fails. Emit off_exit_code, on_exit_code, revision, flags, approval_ref and evidence_path.
3. Test missing-flag fallback separately. Offline mode serves cached or fallback values; it does not prove targeting ([offline mode](https://launchdarkly.com/docs/sdk/features/offline-mode.md)).
4. For local overrides use ldcli dev-server start and add-override after checking installed help. Use the project key as its credential, never a real SDK credential; dev-server does not evaluate targeting rules ([dev-server](https://launchdarkly.com/docs/guides/flags/ldcli-dev-server.md)). AIWG guidance: CI uses fixtures, TestData or dev-server only. Save language/runtime and actual suite exits; never count a stub as an SDK test.

## Evidence and rules

AIWG guidance: apply `ld-change-authorization`, `ld-key-safety`, `ld-docs-currency` and `ld-flag-hygiene`. Never relay keys from any result. Propose writes and obtain human approval of every production diff before execution. Use ld-docs first; discover runtime vendor guides when available, otherwise use dated page documentation. Uncertainty blocks dependent writes.
Resolve `aiwg artifacts path --json --check-write`; save sanitized records beneath artifact_root at logical `.aiwg/launchdarkly/`. Never save raw tool responses. Link the SDLC card and record actual source retrieval dates; offline references were last verified 2026-11-25.

## Examples

Input: “ld-testing for the selected project and flag card.”
Output: a scoped proposal or read-only report, sanitized evidence, and explicit pending approvals or blockers; only verified results count as complete.

See @$AIWG_ROOT/docs/addons/launchdarkly/user-guide.md.
