---
namespace: aiwg
platforms: [all]
version: 2.0.0
name: test-conformance
description: Audit a codebase's testing regime using a reusable protocol, source/runner reconciliation, sampled oracle review and evidence-backed conformance reports.
---

# Test conformance

Use the `testing-quality` CLI namespace `aiwg test-conformance`. For an undeployed addon, use the installed `use` skill
to deploy `testing-quality`. Read [the workflow](../../docs/conformance-workflow.md) for command contracts and [the
evidence rule](../../rules/test-conformance-evidence.md) before making conformance claims.

1. Read target instructions and existing runner/CI configuration. Initialize a protocol with `init`; review
   platform/system identity, source and test globs, areas, lane argv, result/discovery formats, timeouts, policy and
   research paths using [protocol review](../../templates/protocol-review.md). Existing commands may build or import
   target code, even during discovery.
2. Run `inventory` and reconcile statically found files with each lane. Run `sample` with a saved seed and requested
   quota (default 20 per area); use a census for smaller areas. Explain the area definition before sampling. Unsupported
   syntax remains visible.
3. Run `collect` for authorized lanes. Preserve actual exit status, empty/setup-failed runs, skips, timeouts, raw result
   hashes, versions and coverage denominator. Registration and execution are separate evidence. Do not silently install
   a missing tool during collection.
4. Review cases with `test-oracle-reviewer` using [test review](../../templates/test-review.md). A sample cannot satisfy
   whole-scope `requireReview`; expand review coverage or report it incomplete. Review helper behavior and actual SUT,
   not only assertion tokens.
5. Run `assess`, `validate` and `report`. Validation means an artifact satisfies its contract; substantive assessment
   additionally needs current, sufficient evidence. Use [report template](../../templates/conformance-report.md) to
   expose test types, systems, evidence gaps, findings and scope limits.
6. When cleanup is requested, invoke `test-normalize` with concrete findings. Keep the initial audit evidence intact and
   produce new run artifacts after repair.

Do not present inventory candidates as confirmed defects, passing cases as proof of oracle quality, or optional missing
discovery as proven registration. Use `test-platform-research` for a platform adapter/template or additional tooling
recommendation.

## Output template

Use the conformance report for the assessment; when amending an experiment/protocol or recording its gate decision, use the amendment or gate audit template respectively: @$AIWG_ROOT/${CLAUDE_PLUGIN_ROOT}/templates/conformance-report.md; @$AIWG_ROOT/${CLAUDE_PLUGIN_ROOT}/templates/experiment-amendment.md; @$AIWG_ROOT/${CLAUDE_PLUGIN_ROOT}/templates/gate-audit-record.md. Fill every required section; explain non-applicable fields and unrun checks.
