# Decision pattern playground

The decision package exports an offline-first, installed-package playground through
`aiwg/decision`. `listDecisionPatterns()` discovers the versioned packs,
`validateDecisionPattern()` checks their governed manifest, and
`runOfflineDecisionPattern()` evaluates sanitized recorded fixtures without a
credential, network request, or tool execution.

```js
import { listDecisionPatterns, runOfflineDecisionPattern } from 'aiwg/decision';

console.table(listDecisionPatterns());
console.log(runOfflineDecisionPattern('tool-risk-preflight', 'tool-deny-conflict'));
```

The returned receipt identifies `offline-recorded` execution and
`sanitized-recorded-fixture` evidence. It reports no actual model, token usage, or
cost because none occurred. Recorded evidence is not live evidence and is never
reported as such. Actions remain `unexecuted`.

The catalog includes routing, RAG screening, citation support, guardrails,
advisory tool-risk preflight, bounded classification, ordinal scoring, function
selection, same-subject batching, durable review, and candidate selection. The
dependent two-stage example is explicitly `unavailable` until the governed DAG
runtime is present. Durable review is `experimental` for production use.

The durable-review pack additionally exports
`runOfflineDurableReviewFixture(directory)`. It uses the production
`FileDecisionReviewStore` and `DecisionReviewService`, restarts both service and
store, performs an authorized resume, then repeats resume and proves that the
stored effect receipt is returned without a second executor call. The fixture is
local-only and requires the caller to supply a disposable directory.

Live execution is deliberately outside the playground runner. Call
`planLiveDecisionPattern()` to obtain a non-executing readiness plan. It requires
explicit opt-in, approved synthetic egress, logical credential resolution, and
the pack's fixed call, token, cost, attempt, and deadline limits. A missing
credential is a skip; the library never substitutes a mock and labels it live.

These examples do not claim deterministic model behavior, universal accuracy or
calibration, zero hallucinations, or autonomous high-stakes safety. Typed output
constrains shape, not truth. Deterministic policy and ordinary authorization own
permissions and actions; model evidence may only narrow or recommend.

## Failure and rollback

Unknown candidates, fabricated locators, incomplete uncertainty, or policy
conflicts deny or route to review. Multi-subject batches are rejected rather than
silently combined. To disable a faulty pack, remove its pinned version from
discovery or restore a prior pin while retaining receipts and incident evidence.

## Authoring a pattern

Start from this manifest checklist:

```text
schema: decision-pattern-pack/v1
id/version/status/primitive
artifacts:
  definitions, inputSchema, outputSchema, candidatePolicy, ruleset
  offlineBinding, optional liveBindingTemplate, expectedReceipt
fixtures: sanitized synthetic input + recorded evidence + expected route/reason
limitations, failurePath, rollback
live: syntheticOnly + logical credential + egress class + hard limits
```

An author must:

1. Define stable subject identity. Batch only heterogeneous questions about that
   same subject; reject or explicitly fan out other subjects.
2. Enumerate capabilities, routes, tools, and functions in deterministic code.
   Evidence cannot install, enable, execute, or add a candidate.
3. Specify primitive-aware acceptance and calibration provenance. Preserve the
   full ordinal legend/distribution, fractional mean, and dispersion; never map a
   truth probability such as `0.5` to a severity label.
4. Declare privacy classification and egress policy. Offline fixtures must be
   synthetic and sanitized; live templates must use logical credentials and
   bounded budgets.
5. Keep policy, evidence, and action separate. A deterministic deny remains deny
   for every model output and distribution, and all playground actions remain
   unexecuted.
6. Test normalized receipts first, then human-readable presentation. Include
   unauthorized-output/property tests, abstention/review, rollback guidance, and
   installed-package imports rather than source-relative paths.

Pattern artifact strings are stable installed-package references, not claims that
a source checkout path exists. They use the `aiwg://decision-patterns/` scheme
and resolve locally through `resolveDecisionPatternArtifact()` from
`aiwg/decision`, without filesystem or network access. Each pack exposes its own
rollback text and limitations through discovery.

## Operational closure

Opt-in live operation is governed by the versioned
[`JEV-22-G6` closure manifest](operations/closure-manifest.v1.json) and its
resolved [incident runbooks](operations/README.md). The offline package smoke
fails when a required runbook ID, drill, or packaged reference is absent.
