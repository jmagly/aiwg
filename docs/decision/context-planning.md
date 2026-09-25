# Decision context planning

`src/decision/context-plan.ts` provides an offline, transport-independent preflight for Jev-compatible requests. Call it after authorized state projection and compatible-batch formation, but before credential resolution, provider admission, or network dispatch.

The planner consumes a versioned provider profile and an estimator with an exact identity/version match. It calculates the aggregate `state + all questions + envelope` constraint independently from `state + longest question + envelope`, applies a recorded safety margin to each limit, and splits only on question boundaries. Limits belong in the provider profile; current vendor values such as 64,000 and 32,000 are configuration, not constants in the planner.

Independent questions are canonically ordered by stable ID. Compatibility keys prevent unlike envelopes from sharing a request. Declared dependencies become deterministic execution waves, so partitioning cannot turn a dependent question into speculative same-wave execution. Every partition repeats the same authorized-state digest and subject identity.

Oversized state or single-question inputs raise `ContextPlanError` synchronously. Nothing is truncated, summarized, or dropped. `incompleteContext` remains visible in the plan and forces `automaticActionAllowed: false`.

Boundary fixtures cover the documented Jev request maxima: the 255-option Choice and 10-level Score shapes that `JevDecisionAdapter.capabilities()` (`maxOptions`, `maxLevels`) and the `DecisionDefinition` schemas (`maxItems`) enforce. `CTX-MAX` pins those three sources together and rejects 256 options or 11 levels. The `CTX-32K`/`CTX-64K` maximum-shape cases use Unicode, nested entries and `CanonicalJsonByteEstimator`-solved padding to land exactly on, and one token past, each limit. `CTX-DOMINANT` keeps one dominant question whole among many short ones.

Before dispatch, call `assertContextPlanCurrent`. Any authorized-input, authorization-digest, estimator, profile-version, limit, margin, or envelope change produces `stale-plan`; replan rather than dispatching stale assumptions. After a provider response, `recordContextActualUsage` creates separate estimate-versus-actual evidence linked to the immutable plan digest.

The shared evaluator accepts an explicit `DecisionContextPolicy` runtime binding. It plans (or verifies a supplied plan) before adapter capability checks, credential lookup, admission, or transport. Runtime tests assert zero adapter-capability, adapter-evaluate, credential-resolver and fetch calls for oversized state, an oversized question, a stale plan and an unqualified rollout. Question IDs must exactly cover resolved evaluations, and batching subjects must equal the context subject. Native provider calls are constrained to deterministic plan partitions in wave order; questions isolated by a partition degrade to the single-call path rather than being recombined.

The resulting body-free plan and actual-versus-estimated token evidence are attached to each decision result and the ruleset result. `DecisionContextEvidence.v1.schema.json` requires the estimator identity, provider profile identity/digest, documented and effective limits, safety margin, raw estimate and partition estimates, and for each usage record the estimator, profile, estimated and actual tokens and signed estimation error. Every object is closed (`additionalProperties: false`), so the evidence cannot carry state or question bodies; a runtime test asserts that sentinel strings in state and questions never appear in the result or in batch receipts. Durable invocation receipts therefore preserve the same evidence with their stored results, while batch receipts retain their immutable plan/partition references. Incomplete context converts an otherwise automatic completed/defaulted composition to `review` / `insufficient-information` and removes the automatic outcome. The result carries no outcome at all, so nothing downstream can mistake it for an automatic or default action; the v1alpha2 RulesetResult schema accepts exactly this review/insufficient-information pair without an outcome (see [structured-entries.md](structured-entries.md)). Projection evidence with `automaticActionAllowed: false` triggers the same downgrade.

### Preflight failure reasons

A context rejection is an `error` ruleset result with no evaluations and a body-free `spec.contextFailure` diagnostic (`schemaVersion: decision-context-failure/v1`) that carries the `ContextPlanError` reason:

| `contextFailure.reason` | `spec.reason` | Extra fields |
|---|---|---|
| `stale-plan` (supplied plan or batch-receipt plan differs from replanning) | `context-plan-stale` | `plannedDigest`, `currentDigest` |
| `rollout-unqualified` (native batching without a rollout mode, or an enforce qualification that does not match) | `context-unqualified` | none |
| `oversized-state`, `oversized-question`, `dependency-error`, `invalid-input`, `invalid-profile`, `estimator-profile-mismatch` | `invalid-input` | none |

`assertContextQualified` now throws `rollout-unqualified` (previously `invalid-profile`).

## Qualification and rollout (D06 / TV-12)

`compareContextUsage` retains a body-free, sorted comparison for *one complete provider request per case*: profile digest/version, estimator identity/version, original plan digest, estimate, observed request-level input tokens, signed error and conservative rounded-up undercount in basis points. A split plan is not comparable to a single request. Store the returned JSON with the immutable provider usage receipt referenced by `usageRef`; do not claim provider token accuracy from a synthetic value. The `source: synthetic` fixtures in `test/unit/decision/context-qualification.test.ts` exercise the gate only; they are **not** provider observations or TV-12 live evidence. The gate rejects promotion when observed undercount exceeds the configured margin, and always rejects synthetic-only evidence. This is a necessary per-corpus check, not a guarantee across unseen requests, model revisions or new serialization.

Rollout sequence: (1) opt-in `context.rollout: { mode: 'observe-only' }` on approved synthetic state/questions, using individual calls already within *both* configured effective limits; persist the exact profile, estimator configuration, sanitized plan and provider input-usage receipts per request. (2) Review an independent bounded corpus including short-question batches, dominant questions, Unicode, nested criteria and maximum documented Choice/Score shapes. Compare *actual request-level usage* against the *matching request estimate*, record distribution and worst undercount, and select/document a margin above observed undercount with allowance for unobserved workloads. (3) Pin profile limits, tokenizer/estimator implementation and version, margin and envelope; re-run CTX boundary and TV-12 tests for that pin before enabling partitioned native batches using `context.rollout: { mode: 'enforce', qualification }`. The runtime checks the qualification's profile digest, estimator identity, provider-only case types, arithmetic and margin before capability and credential resolution. (4) Canary and monitor actual-versus-estimated deltas; disable batching when an undercount exceeds reserve, while continuing only individually validated calls. Never revert to dispatching without preflight, and never infer that observed usage proves a vendor limit for future model versions. Any model, serialization, tokenization, limit or configuration change invalidates the pin and returns to observe-only pending requalification.

Current qualification status: **not qualified for provider enforcement**. The canonical JSON byte estimator is a deterministic proxy, not a provider tokenizer; the offline tests have no provider usage receipts. The opt-in enforcement gate validates a supplied record but cannot authenticate its caller-declared `source: provider`; production bindings must remain disabled until the provider usage references and deployment approval are independently verified. No live TV-12 token comparisons or D11 release evidence are asserted by these fixtures; the TV12 conformance entry lists the offline CTX tests only as candidate hints.

### Default rollout: fail closed

When `context.rollout` is omitted and native batching is enabled (`batching.enabled` or `batchReceipts`), the evaluator fails closed before capability, credential or transport access with `spec.reason: context-unqualified` and `contextFailure.reason: rollout-unqualified`. With batching disabled, an omitted rollout still runs individually preflighted single calls.

Migration: bindings that combined `context` with native batching and no `rollout` previously ran partitioned native batches without any qualification check. They now return `context-unqualified`. Choose one of:

- `context.rollout: { mode: 'observe-only' }` to keep context evidence and run every question as a single call (step 1 above).
- `context.rollout: { mode: 'enforce', qualification }` with a provider-backed qualification that matches the pinned profile and estimator (step 3 above).
- Disable `batching` for that invocation.

Consumers that switch on `RulesetResult.spec.reason` must accept the new `context-plan-stale` and `context-unqualified` values (v1alpha2 only). A stale plan previously surfaced as `invalid-input`.
