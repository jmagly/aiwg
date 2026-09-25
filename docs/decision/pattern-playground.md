# Decision pattern playground

The decision package ships an offline-first playground through two installed
surfaces:

- the `decision-playground` skill in the `decision-engine` addon, and
- the `aiwg/decision` library API.

## Entry point

The skill script runs from the installed package and needs no credential,
network access, or feature flag:

```bash
node agentic/code/addons/decision-engine/skills/decision-playground/scripts/decision-playground.mjs list
node agentic/code/addons/decision-engine/skills/decision-playground/scripts/decision-playground.mjs run guardrails --fixture guardrail-noul-midpoint --summary
node agentic/code/addons/decision-engine/skills/decision-playground/scripts/decision-playground.mjs run-all
node agentic/code/addons/decision-engine/skills/decision-playground/scripts/decision-playground.mjs live-plan rag-screen
```

`list` shows each pack's status, primitive, fixtures and live limits. `show`
prints a manifest and its candidate policy. `run` evaluates one fixture, and
`run-all` evaluates every fixture and exits non-zero when a computed route
differs from the fixture's documented expectation. `live-plan` prints the
non-executing readiness plan. The command line never runs a live probe.

The same operations are available from the library:

```js
import { listDecisionPatterns, runOfflineDecisionPattern } from 'aiwg/decision';

console.table(listDecisionPatterns());
console.log(await runOfflineDecisionPattern('tool-risk-preflight', 'tool-deny-conflict'));
```

## Recorded-adapter mode

Offline fixtures run through the production runtime, not a playground-only
decision function:

1. Each pack's governed definitions (one per evaluation alias), ruleset and
   offline binding are passed to `evaluateDecisionRuleset`.
2. The binding targets the production `JevDecisionAdapter`. Its transport is a
   recorded-replay `fetch` that returns the fixture's sanitized recorded Jev
   answers. The adapter still builds each request and validates every answer
   (typed values, distributions, Score legends and means, Noul ranges).
3. Primitive-aware acceptance policies, ruleset composition, native batching
   and durable receipts all execute in the evaluator.
4. Deterministic gates declared in the pack's candidate policy then run on the
   `RulesetResult`. They can only narrow a route: a deterministic `deny`,
   candidate membership, citation provenance and typed function arguments. The
   same-subject gate rejects a multi-subject batch before any dispatch.

The fixture's expected route and reason are checked against the computed
receipt in tests and by `run-all`. They are never used to produce it.

The returned `decision-pattern-receipt/v2` identifies `offline-recorded`
execution and `sanitized-recorded-fixture` evidence. It wraps the full
`RulesetResult`, lists per-evaluation status, value, distribution and
acceptance disposition, and counts evaluator invocations and recorded transport
requests. `actualModel` is null because no model served the fixture. Recorded
evidence is never reported as live, and actions remain `unexecuted`.

Acceptance thresholds are explicit. A Choice needs a selected probability of at
least 0.8, an ordinal Score needs a normalized dispersion of at most 0.2, and a
truth probability (Noul) is accepted only at or above 0.8 or at or below 0.2.
A Noul value of exactly `0.5` therefore abstains and routes to review. It is
never labeled a "medium" severity and never treated as an accept
(`guardrail-noul-midpoint`).

`same-subject-batch` asks heterogeneous questions (ordinal Score, Choice and
Noul) about one subject. The evaluator sends them as one native batch request
with a durable batch receipt: the receipt reports request-level usage once
(`scope: "request"`), and each answer's usage stays null. The multi-subject
anti-example makes zero requests.

The catalog includes routing, RAG screening, citation support, guardrails,
advisory tool-risk preflight, bounded classification, ordinal scoring, function
selection, same-subject batching, durable review, and candidate selection.
Durable review is `experimental` for production use. Its offline fixture resumes
through the production receipt store and proves that the replay makes no second
transport request.

### `dependent-two-stage` status

`dependent-two-stage` stays `unavailable`. The D12 graph runtime has landed,
but it is experimental and excluded from release claims until its G5/G6
qualification gates pass (see [dependent graphs](dependent-graphs.md)). A
dependent pack also needs the graph runner (`decisionGraphToFlow` and the Flow
engine), not the single-ruleset path this playground uses. Shipping it before
that qualification would present an unqualified runtime as a supported
example. The pack stays discoverable with its governed artifacts, has no
fixtures, and `run` refuses it.

The durable-review pack additionally exports
`runOfflineDurableReviewFixture(directory)`. It uses the production
`FileDecisionReviewStore` and `DecisionReviewService`, restarts both service and
store, performs an authorized resume, then repeats resume and proves that the
stored effect receipt is returned without a second executor call. The fixture is
local-only and requires the caller to supply a disposable directory.

## Live variant

Live execution is available only through `runLiveDecisionPattern()`, and only
for explicitly synthetic probes. Call `planLiveDecisionPattern()` first to get a
non-executing readiness plan. A live run requires explicit opt-in, approved
synthetic egress, logical credential resolution, an explicit requested model,
and a caller-supplied Jev transport and per-dispatch estimate.

The live run uses the same governed ruleset and the live binding template
through `evaluateDecisionRuleset`. The pack limits become a scheduler admission
policy, so they are enforced before dispatch:

- calls: admission allows at most `maxCalls` transport calls per probe; the
  call that would exceed the limit is rejected and never started;
- tokens and cost: each dispatch reserves its estimate against `maxTokens` and
  `maxCostUsd`, and a dispatch whose reservation would exceed either is never
  started;
- unknown cost: an estimate with a null cost is never admitted
  (`allowUnknownCost: false`);
- attempts: `maxAttempts` bounds retries per evaluation;
- deadline: `deadlineMs` is the evaluator's total deadline, whose abort signal
  cancels the in-flight transport.

Callers may tighten, never loosen, these limits. Provider-reported usage above a
limit after the fact is recorded in `limitBreaches` and routes to review. The
live playground dispatches each question separately so every call passes
admission; it does not use native batching live. A missing credential is a
skip; the library never substitutes a mock and labels it live.

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
fixtures: sanitized synthetic input + recorded Jev answers + expected route/reason
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
