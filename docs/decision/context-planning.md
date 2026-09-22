# Decision context planning

`src/decision/context-plan.ts` provides an offline, transport-independent preflight for Jev-compatible requests. Call it after authorized state projection and compatible-batch formation, but before credential resolution, provider admission, or network dispatch.

The planner consumes a versioned provider profile and an estimator with an exact identity/version match. It calculates the aggregate `state + all questions + envelope` constraint independently from `state + longest question + envelope`, applies a recorded safety margin to each limit, and splits only on question boundaries. Limits belong in the provider profile; current vendor values such as 64,000 and 32,000 are configuration, not constants in the planner.

Independent questions are canonically ordered by stable ID. Compatibility keys prevent unlike envelopes from sharing a request. Declared dependencies become deterministic execution waves, so partitioning cannot turn a dependent question into speculative same-wave execution. Every partition repeats the same authorized-state digest and subject identity.

Oversized state or single-question inputs raise `ContextPlanError` synchronously. Nothing is truncated, summarized, or dropped. `incompleteContext` remains visible in the plan and forces `automaticActionAllowed: false`.

Before dispatch, call `assertContextPlanCurrent`. Any authorized-input, authorization-digest, estimator, profile-version, limit, margin, or envelope change produces `stale-plan`; replan rather than dispatching stale assumptions. After a provider response, `recordContextActualUsage` creates separate estimate-versus-actual evidence linked to the immutable plan digest.

The shared evaluator accepts an explicit `DecisionContextPolicy` runtime binding. It plans (or verifies a supplied plan) before adapter capability checks, credential lookup, admission, or transport. Question IDs must exactly cover resolved evaluations, and batching subjects must equal the context subject. Native provider calls are constrained to deterministic plan partitions in wave order; questions isolated by a partition degrade to the single-call path rather than being recombined.

The resulting body-free plan and actual-versus-estimated token evidence are attached to each decision result and the ruleset result. Durable invocation receipts therefore preserve the same evidence with their stored results, while batch receipts retain their immutable plan/partition references. Incomplete context converts an otherwise automatic completed/defaulted composition to review and removes its outcome.
